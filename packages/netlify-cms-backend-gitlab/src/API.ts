import {
  localForage,
  parseLinkHeader,
  unsentRequest,
  then,
  APIError,
  Cursor,
  ApiRequest,
  Entry,
  AssetProxy,
  PersistOptions,
  readFile,
} from 'netlify-cms-lib-util';
import { Base64 } from 'js-base64';
import { fromJS, Map, Set } from 'immutable';
import { flow, partial, result, trimStart } from 'lodash';
import { CursorStore } from 'netlify-cms-lib-util/src/Cursor';

export interface Config {
  apiRoot?: string;
  token?: string;
  branch?: string;
  repo?: string;
  squashMerges: boolean;
  initialWorkflowStatus: string;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

interface CommitsParams {
  commit_message: string;
  branch: string;
  author_name?: string;
  author_email?: string;
  actions?: {
    action: string;
    file_path: string;
    content: string;
    encoding: string;
  }[];
}

type Formatter = (res: Response) => unknown;

export default class API {
  apiRoot: string;
  token: string | boolean;
  branch: string;
  useOpenAuthoring?: boolean;
  repo: string;
  repoURL: string;
  commitAuthor?: CommitAuthor;
  squashMerges: boolean;
  initialWorkflowStatus: string;

  constructor(config: Config) {
    this.apiRoot = config.apiRoot || 'https://gitlab.com/api/v4';
    this.token = config.token || false;
    this.branch = config.branch || 'master';
    this.repo = config.repo || '';
    this.repoURL = `/projects/${encodeURIComponent(this.repo)}`;
    this.squashMerges = config.squashMerges;
    this.initialWorkflowStatus = config.initialWorkflowStatus;
  }

  withAuthorizationHeaders = (req: ApiRequest) =>
    unsentRequest.withHeaders(this.token ? { Authorization: `Bearer ${this.token}` } : {}, req);

  buildRequest = (req: ApiRequest) =>
    flow([
      unsentRequest.withRoot(this.apiRoot),
      this.withAuthorizationHeaders,
      unsentRequest.withTimestamp,
    ])(req);

  request = async (req: ApiRequest) =>
    flow([
      this.buildRequest,
      unsentRequest.performRequest,
      p => p.catch((err: Error) => Promise.reject(new APIError(err.message, null, 'GitLab'))),
    ])(req);

  catchFormatErrors = (format: string, formatter: Formatter) => (res: Response) => {
    try {
      return formatter(res);
    } catch (err) {
      throw new Error(
        `Response cannot be parsed into the expected format (${format}): ${err.message}`,
      );
    }
  };

  responseFormats = fromJS({
    json: async (res: Response) => {
      const contentType = res.headers.get('Content-Type');
      if (contentType !== 'application/json' && contentType !== 'text/json') {
        throw new Error(`${contentType} is not a valid JSON Content-Type`);
      }
      return res.json();
    },
    text: async (res: Response) => res.text(),
    blob: async (res: Response) => res.blob(),
  }).mapEntries(([format, formatter]: [string, Formatter]) => [
    format,
    this.catchFormatErrors(format, formatter),
  ]);

  parseResponse = async (res: Response, { expectingOk = true, expectingFormat = 'text' }) => {
    let body;
    try {
      const formatter = this.responseFormats.get(expectingFormat, false);
      if (!formatter) {
        throw new Error(`${expectingFormat} is not a supported response format.`);
      }
      body = await formatter(res);
    } catch (err) {
      throw new APIError(err.message, res.status, 'GitLab');
    }
    if (expectingOk && !res.ok) {
      const isJSON = expectingFormat === 'json';
      throw new APIError(isJSON && body.message ? body.message : body, res.status, 'GitLab');
    }
    return body;
  };

  responseToJSON = (res: Response) => this.parseResponse(res, { expectingFormat: 'json' });

  responseToBlob = (res: Response) =>
    this.parseResponse(res, { expectingFormat: 'blob' }) as Promise<Blob>;

  responseToText = (res: Response) =>
    this.parseResponse(res, { expectingFormat: 'text' }) as Promise<string>;

  requestJSON = (req: ApiRequest) => this.request(req).then(this.responseToJSON);
  requestText = (req: ApiRequest) => this.request(req).then(this.responseToText);

  user = () => this.requestJSON('/user');

  WRITE_ACCESS = 30;
  hasWriteAccess = () =>
    this.requestJSON(this.repoURL).then(({ permissions }) => {
      const { project_access: projectAccess, group_access: groupAccess } = permissions;
      if (projectAccess && projectAccess.access_level >= this.WRITE_ACCESS) {
        return true;
      }
      if (groupAccess && groupAccess.access_level >= this.WRITE_ACCESS) {
        return true;
      }
      return false;
    });

  readFile = async (
    path: string,
    sha?: string | null,
    { parseText = true } = {},
  ): Promise<string | Blob> => {
    const fetchContent = async () => {
      const content = await this.request({
        url: `${this.repoURL}/repository/files/${encodeURIComponent(path)}/raw`,
        params: { ref: this.branch },
        cache: 'no-store',
      }).then<Blob | string>(parseText ? this.responseToText : this.responseToBlob);
      return content;
    };

    const content = await readFile(sha, fetchContent, localForage, parseText);
    return content;
  };

  getCursorFromHeaders = (headers: Headers) => {
    // indices and page counts are assumed to be zero-based, but the
    // indices and page counts returned from GitLab are one-based
    const index = parseInt(headers.get('X-Page') as string, 10) - 1;
    const pageCount = parseInt(headers.get('X-Total-Pages') as string, 10) - 1;
    const pageSize = parseInt(headers.get('X-Per-Page') as string, 10);
    const count = parseInt(headers.get('X-Total') as string, 10);
    const links = parseLinkHeader(headers.get('Link') as string);
    const actions = Map(links)
      .keySeq()
      .flatMap(key =>
        (key === 'prev' && index > 0) ||
        (key === 'next' && index < pageCount) ||
        (key === 'first' && index > 0) ||
        (key === 'last' && index < pageCount)
          ? [key]
          : [],
      );
    return Cursor.create({
      actions,
      meta: { index, count, pageSize, pageCount },
      data: { links },
    });
  };

  getCursor = ({ headers }: { headers: Headers }) => this.getCursorFromHeaders(headers);

  // Gets a cursor without retrieving the entries by using a HEAD
  // request
  fetchCursor = (req: ApiRequest) =>
    flow([unsentRequest.withMethod('HEAD'), this.request, then(this.getCursor)])(req);

  fetchCursorAndEntries = (
    req: ApiRequest,
  ): Promise<{
    entries: { id: string; type: string; path: string; name: string }[];
    cursor: Cursor;
  }> =>
    flow([
      unsentRequest.withMethod('GET'),
      this.request,
      p => Promise.all([p.then(this.getCursor), p.then(this.responseToJSON)]),
      then(([cursor, entries]: [Cursor, {}[]]) => ({ cursor, entries })),
    ])(req);

  reversableActions = Map({
    first: 'last',
    last: 'first',
    next: 'prev',
    prev: 'next',
  });

  reverseCursor = (cursor: Cursor) => {
    const pageCount = cursor.meta!.get('pageCount', 0) as number;
    const currentIndex = cursor.meta!.get('index', 0) as number;
    const newIndex = pageCount - currentIndex;

    const links = cursor.data!.get('links', Map()) as Map<string, string>;
    const reversedLinks = links.mapEntries(tuple => {
      const [k, v] = tuple as string[];
      return [this.reversableActions.get(k) || k, v];
    });

    const reversedActions = cursor.actions!.map(
      action => this.reversableActions.get(action as string) || (action as string),
    );

    return cursor.updateStore((store: CursorStore) =>
      store!
        .setIn(['meta', 'index'], newIndex)
        .setIn(['data', 'links'], reversedLinks)
        .set('actions', (reversedActions as unknown) as Set<string>),
    );
  };

  // The exported listFiles and traverseCursor reverse the direction
  // of the cursors, since GitLab's pagination sorts the opposite way
  // we want to sort by default (it sorts by filename _descending_,
  // while the CMS defaults to sorting by filename _ascending_, at
  // least in the current GitHub backend). This should eventually be
  // refactored.
  listFiles = async (path: string, recursive = false) => {
    const firstPageCursor = await this.fetchCursor({
      url: `${this.repoURL}/repository/tree`,
      params: { path, ref: this.branch, recursive },
    });
    const lastPageLink = firstPageCursor.data.getIn(['links', 'last']);
    const { entries, cursor } = await this.fetchCursorAndEntries(lastPageLink);
    return {
      files: entries.filter(({ type }) => type === 'blob').reverse(),
      cursor: this.reverseCursor(cursor),
    };
  };

  traverseCursor = async (cursor: Cursor, action: string) => {
    const link = cursor.data!.getIn(['links', action]);
    const { entries, cursor: newCursor } = await this.fetchCursorAndEntries(link);
    return {
      entries: entries.filter(({ type }) => type === 'blob').reverse(),
      cursor: this.reverseCursor(newCursor),
    };
  };

  listAllFiles = async (path: string, recursive = false) => {
    const entries = [];
    // eslint-disable-next-line prefer-const
    let { cursor, entries: initialEntries } = await this.fetchCursorAndEntries({
      url: `${this.repoURL}/repository/tree`,
      // Get the maximum number of entries per page
      // eslint-disable-next-line @typescript-eslint/camelcase
      params: { path, ref: this.branch, per_page: 100, recursive },
    });
    entries.push(...initialEntries);
    while (cursor && cursor.actions!.has('next')) {
      const link = cursor.data!.getIn(['links', 'next']);
      const { cursor: newCursor, entries: newEntries } = await this.fetchCursorAndEntries(link);
      entries.push(...newEntries);
      cursor = newCursor;
    }
    return entries.filter(({ type }) => type === 'blob');
  };

  toBase64 = (str: string) => Promise.resolve(Base64.encode(str));
  fromBase64 = (str: string) => Base64.decode(str);

  async uploadAndCommit(files: (Entry | AssetProxy)[], { commitMessage = '', updateFile = false }) {
    const action = updateFile ? 'update' : 'create';
    const actions = await Promise.all(
      files.map(item =>
        result(item, 'toBase64', partial(this.toBase64, (item as Entry).raw)).then(content => ({
          action,
          // eslint-disable-next-line @typescript-eslint/camelcase
          file_path: trimStart(item.path, '/'),
          content,
          encoding: 'base64',
        })),
      ),
    );

    const commitParams: CommitsParams = {
      branch: this.branch,
      // eslint-disable-next-line @typescript-eslint/camelcase
      commit_message: commitMessage,
      actions,
    };
    if (this.commitAuthor) {
      const { name, email } = this.commitAuthor;
      // eslint-disable-next-line @typescript-eslint/camelcase
      commitParams.author_name = name;
      // eslint-disable-next-line @typescript-eslint/camelcase
      commitParams.author_email = email;
    }

    await this.requestJSON({
      url: `${this.repoURL}/repository/commits`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commitParams),
    });

    return files;
  }

  persistFiles(files: (Entry | AssetProxy)[], { commitMessage, newEntry }: PersistOptions) {
    return this.uploadAndCommit(files, { commitMessage, updateFile: newEntry === false });
  }

  deleteFile = (path: string, commitMessage: string) => {
    const branch = this.branch;
    // eslint-disable-next-line @typescript-eslint/camelcase
    const commitParams: CommitsParams = { commit_message: commitMessage, branch };
    if (this.commitAuthor) {
      const { name, email } = this.commitAuthor;
      // eslint-disable-next-line @typescript-eslint/camelcase
      commitParams.author_name = name;
      // eslint-disable-next-line @typescript-eslint/camelcase
      commitParams.author_email = email;
    }
    return flow([
      unsentRequest.withMethod('DELETE'),
      // TODO: only send author params if they are defined.
      unsentRequest.withParams(commitParams),
      this.request,
    ])(`${this.repoURL}/repository/files/${encodeURIComponent(path)}`);
  };

  async listUnpublishedBranches() {
    console.log(
      '%c Checking for Unpublished entries',
      'line-height: 30px;text-align: center;font-weight: bold',
    );
    // Get branches with a `name` matching `CMS_BRANCH_PREFIX`.
    // Note that this is a substring match, so we need to check that the `branch.name` was generated by us.
    return this.requestJSON({
      url: `${this.repoURL}/repository/branches`,
      params: { search: CMS_BRANCH_PREFIX },
    })
      .then(branches =>
        branches.filter(branch => this.assertBranchName(branch.name) && !branch.merged),
      )
      .then(branches =>
        filterPromises(branches, branch =>
          // Get MRs with a `source_branch` of `branch.name`.
          // Note that this is *probably* a substring match, so we need to check that
          // the `source_branch` of at least one of the returned objects matches `branch.name`.
          this.requestJSON({
            url: `${this.repoURL}/merge_requests`,
            params: {
              state: 'opened',
              source_branch: branch.name,
              target_branch: this.branch,
            },
          }).then(mrs => mrs.some(mr => mr.source_branch === branch.name)),
        ),
      )
      .catch(error => {
        console.log(
          '%c No Unpublished entries',
          'line-height: 30px;text-align: center;font-weight: bold',
        );
        throw error;
      });
  }

  async readUnpublishedBranchFile(contentKey: string) {
    try {
      const metaData = await this.retrieveMetadata(contentKey).then(data =>
        data.objects.entry.path ? data : Promise.reject(null),
      );
      const repoURL = this.useOpenAuthoring
        ? `/repos/${contentKey
            .split('/')
            .slice(0, 2)
            .join('/')}`
        : this.repoURL;

      const [fileData, isModification] = await Promise.all([
        this.readFile(metaData.objects.entry.path, null, {
          branch: metaData.branch,
          repoURL,
        }) as Promise<string>,
        this.isUnpublishedEntryModification(metaData.objects.entry.path, this.branch),
      ]);

      return {
        metaData,
        fileData,
        isModification,
        slug: this.slugFromContentKey(contentKey, metaData.collection),
      };
    } catch (e) {
      throw new EditorialWorkflowError('content is not under editorial workflow', true);
    }
}