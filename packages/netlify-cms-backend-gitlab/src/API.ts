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
  CMS_BRANCH_PREFIX,
  generateContentKey,
  isCMSLabel,
  EditorialWorkflowError,
  labelToStatus,
  statusToLabel,
  DEFAULT_PR_BODY,
  MERGE_COMMIT_MESSAGE,
} from 'netlify-cms-lib-util';
import { Base64 } from 'js-base64';
import { fromJS, Map, Set } from 'immutable';
import { flow, partial, result, trimStart } from 'lodash';
import { CursorStore } from 'netlify-cms-lib-util/src/Cursor';

export const API_NAME = 'GitLab';

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

enum CommitAction {
  CREATE = 'create',
  DELETE = 'delete',
  MOVE = 'move',
  UPDATE = 'update',
}

type CommitItem = {
  base64Content?: string;
  path: string;
  action: CommitAction;
};

interface CommitsParams {
  commit_message: string;
  branch: string;
  author_name?: string;
  author_email?: string;
  actions?: {
    action: string;
    file_path: string;
    content?: string;
    encoding?: string;
  }[];
}

type GitLabCommitDiff = {
  diff: string;
  new_path: string;
  old_path: string;
};

type GitLabCommitStatus = {
  status: 'pending' | 'running' | 'success' | 'failed' | 'canceled';
  name: string;
  author: {
    username: string;
    name: string;
  };
  description: null;
  sha: string;
  ref: string;
  target_url: string;
};

type GitLabMergeRebase = {
  rebase_in_progress: boolean;
  merge_error: string;
};

type GitLabMergeRequest = {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  merged_by: {
    name: string;
    username: string;
  };
  merged_at: string;
  created_at: string;
  updated_at: string;
  target_branch: string;
  source_branch: string;
  author: {
    name: string;
    username: string;
  };
  labels: string[];
  sha: string;
};

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

  request = async (req: ApiRequest): Promise<Response> =>
    flow([
      this.buildRequest,
      unsentRequest.performRequest,
      p => p.catch((err: Error) => Promise.reject(new APIError(err.message, null, API_NAME))),
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
      throw new APIError(err.message, res.status, API_NAME);
    }
    if (expectingOk && !res.ok) {
      const isJSON = expectingFormat === 'json';
      throw new APIError(isJSON && body.message ? body.message : body, res.status, API_NAME);
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
    { parseText = true, branch = this.branch } = {},
  ): Promise<string | Blob> => {
    const fetchContent = async () => {
      const content = await this.request({
        url: `${this.repoURL}/repository/files/${encodeURIComponent(path)}/raw`,
        params: { ref: branch },
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

  uploadAndCommit(
    items: CommitItem[],
    { commitMessage = '', branch = this.branch, newBranch = false },
  ) {
    const actions = items.map(item => ({
      action: item.action,
      // eslint-disable-next-line @typescript-eslint/camelcase
      file_path: item.path,
      ...(item.base64Content ? { content: item.base64Content, encoding: 'base64' } : {}),
    }));

    const commitParams: CommitsParams = {
      branch,
      // eslint-disable-next-line @typescript-eslint/camelcase
      commit_message: commitMessage,
      actions,
      // eslint-disable-next-line @typescript-eslint/camelcase
      ...(newBranch ? { start_branch: this.branch } : {}),
    };
    if (this.commitAuthor) {
      const { name, email } = this.commitAuthor;
      // eslint-disable-next-line @typescript-eslint/camelcase
      commitParams.author_name = name;
      // eslint-disable-next-line @typescript-eslint/camelcase
      commitParams.author_email = email;
    }

    return this.requestJSON({
      url: `${this.repoURL}/repository/commits`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(commitParams),
    });
  }

  async getCommitItems(files: (Entry | AssetProxy)[], branch: string) {
    const items = await Promise.all(
      files.map(async file => {
        const [base64Content, fileExists] = await Promise.all([
          result(file, 'toBase64', partial(this.toBase64, (file as Entry).raw)),
          this.isFileExists(file.path, branch),
        ]);
        return {
          action: fileExists ? CommitAction.UPDATE : CommitAction.CREATE,
          base64Content,
          path: trimStart(file.path, '/'),
        };
      }),
    );
    return items as CommitItem[];
  }

  async persistFiles(entry: Entry | null, mediaFiles: AssetProxy[], options: PersistOptions) {
    const files = entry ? [entry, ...mediaFiles] : mediaFiles;
    if (options.useWorkflow) {
      return this.editorialWorkflowGit(files, entry as Entry, options);
    } else {
      const items = await this.getCommitItems(files, this.branch);
      return this.uploadAndCommit(items, {
        commitMessage: options.commitMessage,
      });
    }
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

  generateContentKey(collectionName: string, slug: string) {
    return generateContentKey(collectionName, slug);
  }

  contentKeyFromBranch(branch: string) {
    return branch.substring(`${CMS_BRANCH_PREFIX}/`.length);
  }

  branchFromContentKey(contentKey: string) {
    return `${CMS_BRANCH_PREFIX}/${contentKey}`;
  }

  async getMergeRequests(sourceBranch?: string) {
    const mergeRequests: GitLabMergeRequest[] = await this.requestJSON({
      url: `${this.repoURL}/merge_requests`,
      params: {
        state: 'opened',
        labels: 'Any',
        // eslint-disable-next-line @typescript-eslint/camelcase
        target_branch: this.branch,
        // eslint-disable-next-line @typescript-eslint/camelcase
        ...(sourceBranch ? { source_branch: sourceBranch } : {}),
      },
    });

    return mergeRequests.filter(
      mr => mr.source_branch.startsWith(CMS_BRANCH_PREFIX) && mr.labels.some(isCMSLabel),
    );
  }

  async listUnpublishedBranches() {
    console.log(
      '%c Checking for Unpublished entries',
      'line-height: 30px;text-align: center;font-weight: bold',
    );

    const mergeRequests = await this.getMergeRequests();
    const branches = mergeRequests.map(mr => mr.source_branch);

    return branches;
  }

  async isFileExists(path: string, branch: string) {
    const fileExists = await this.requestText({
      method: 'HEAD',
      url: `${this.repoURL}/repository/files/${encodeURIComponent(path)}`,
      params: { ref: branch },
      cache: 'no-store',
    })
      .then(() => true)
      .catch(error => {
        if (error instanceof APIError && error.status === 404) {
          return false;
        }
        throw error;
      });

    return fileExists;
  }

  async getBranchMergeRequest(branch: string) {
    const mergeRequests = await this.getMergeRequests(branch);
    if (mergeRequests.length <= 0) {
      throw new EditorialWorkflowError('content is not under editorial workflow', true);
    }

    return mergeRequests[0];
  }

  async getDifferences(to: string) {
    const result: { diffs: GitLabCommitDiff[] } = await this.requestJSON({
      url: `${this.repoURL}/repository/compare`,
      params: {
        from: this.branch,
        to,
      },
    });

    return result.diffs;
  }

  async retrieveMetadata(contentKey: string) {
    const [collection, slug] = contentKey.split('/');
    const branch = this.branchFromContentKey(contentKey);
    const mergeRequest = await this.getBranchMergeRequest(branch);
    const diff = await this.getDifferences(mergeRequest.sha);
    const path = diff.find(d => d.old_path.includes(slug))?.old_path as string;
    // TODO: get real file id
    const mediaFiles = await Promise.all(
      diff.filter(d => d.old_path !== path).map(d => ({ path: d.new_path, id: null })),
    );
    const label = mergeRequest.labels.find(isCMSLabel) as string;
    const status = labelToStatus(label);
    return { branch, collection, slug, path, status, mediaFiles };
  }

  async readUnpublishedBranchFile(contentKey: string) {
    const { branch, collection, slug, path, status, mediaFiles } = await this.retrieveMetadata(
      contentKey,
    );

    const [fileData, isModification] = await Promise.all([
      this.readFile(path, null, { branch }) as Promise<string>,
      this.isFileExists(path, this.branch),
    ]);

    return {
      slug,
      metaData: { branch, collection, objects: { entry: { path, mediaFiles } }, status },
      fileData,
      isModification,
    };
  }

  async rebaseMergeRequest(mergeRequest: GitLabMergeRequest) {
    let rebase: GitLabMergeRebase = await this.requestJSON({
      method: 'PUT',
      url: `${this.repoURL}/merge_requests/${mergeRequest.iid}/rebase`,
    });

    let i = 1;
    while (rebase.rebase_in_progress) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      rebase = await this.requestJSON({
        url: `${this.repoURL}/merge_requests/${mergeRequest.iid}`,
        params: {
          // eslint-disable-next-line @typescript-eslint/camelcase
          include_rebase_in_progress: true,
        },
      });
      if (!rebase.rebase_in_progress || i > 10) {
        break;
      }
      i++;
    }

    if (rebase.rebase_in_progress) {
      throw new APIError('Timed out rebasing merge request', null, API_NAME);
    } else if (rebase.merge_error) {
      throw new APIError(`Rebase error: ${rebase.merge_error}`, null, API_NAME);
    }
  }

  async createMergeRequest(branch: string, commitMessage: string, status: string) {
    await this.requestJSON({
      method: 'POST',
      url: `${this.repoURL}/merge_requests`,
      params: {
        // eslint-disable-next-line @typescript-eslint/camelcase
        source_branch: branch,
        // eslint-disable-next-line @typescript-eslint/camelcase
        target_branch: this.branch,
        title: commitMessage,
        description: DEFAULT_PR_BODY,
        labels: statusToLabel(status),
        // eslint-disable-next-line @typescript-eslint/camelcase
        remove_source_branch: true,
        squash: this.squashMerges,
      },
    });
  }

  async editorialWorkflowGit(files: (Entry | AssetProxy)[], entry: Entry, options: PersistOptions) {
    const contentKey = this.generateContentKey(options.collectionName as string, entry.slug);
    const branch = this.branchFromContentKey(contentKey);
    const unpublished = options.unpublished || false;
    if (!unpublished) {
      const items = await this.getCommitItems(files, this.branch);
      await this.uploadAndCommit(items, {
        commitMessage: options.commitMessage,
        branch,
        newBranch: true,
      });
      await this.createMergeRequest(
        branch,
        options.commitMessage,
        options.status || this.initialWorkflowStatus,
      );
    } else {
      const mergeRequest = await this.getBranchMergeRequest(branch);
      await this.rebaseMergeRequest(mergeRequest);
      const [items, diffs] = await Promise.all([
        this.getCommitItems(files, branch),
        this.getDifferences(branch),
      ]);

      // mark files for deletion
      for (const diff of diffs) {
        if (!items.some(item => item.path === diff.new_path)) {
          items.push({ action: CommitAction.DELETE, path: diff.new_path });
        }
      }

      await this.uploadAndCommit(items, {
        commitMessage: options.commitMessage,
        branch,
      });
    }
  }

  async updateMergeRequestLabels(mergeRequest: GitLabMergeRequest, labels: string[]) {
    await this.requestJSON({
      method: 'PUT',
      url: `${this.repoURL}/merge_requests/${mergeRequest.iid}`,
      params: {
        labels: labels.join(','),
      },
    });
  }

  async updateUnpublishedEntryStatus(collection: string, slug: string, newStatus: string) {
    const contentKey = this.generateContentKey(collection, slug);
    const branch = this.branchFromContentKey(contentKey);
    const mergeRequest = await this.getBranchMergeRequest(branch);

    const labels = [
      ...mergeRequest.labels.filter(label => !isCMSLabel(label)),
      statusToLabel(newStatus),
    ];
    await this.updateMergeRequestLabels(mergeRequest, labels);
  }

  async mergeMergeRequest(mergeRequest: GitLabMergeRequest) {
    await this.requestJSON({
      method: 'PUT',
      url: `${this.repoURL}/merge_requests/${mergeRequest.iid}/merge`,
      params: {
        // eslint-disable-next-line @typescript-eslint/camelcase
        merge_commit_message: MERGE_COMMIT_MESSAGE,
        // eslint-disable-next-line @typescript-eslint/camelcase
        squash_commit_message: MERGE_COMMIT_MESSAGE,
        squash: this.squashMerges,
        // eslint-disable-next-line @typescript-eslint/camelcase
        should_remove_source_branch: true,
      },
    });
  }

  async publishUnpublishedEntry(collectionName: string, slug: string) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const branch = this.branchFromContentKey(contentKey);
    const mergeRequest = await this.getBranchMergeRequest(branch);
    await this.mergeMergeRequest(mergeRequest);
  }

  async closeMergeRequest(mergeRequest: GitLabMergeRequest) {
    await this.requestJSON({
      method: 'PUT',
      url: `${this.repoURL}/merge_requests/${mergeRequest.iid}`,
      params: {
        // eslint-disable-next-line @typescript-eslint/camelcase
        state_event: 'close',
      },
    });
  }

  async deleteBranch(branch: string) {
    await this.request({
      method: 'DELETE',
      url: `${this.repoURL}/repository/branches/${encodeURIComponent(branch)}`,
    });
  }

  async deleteUnpublishedEntry(collectionName: string, slug: string) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const branch = this.branchFromContentKey(contentKey);
    const mergeRequest = await this.getBranchMergeRequest(branch);
    await this.closeMergeRequest(mergeRequest);
    await this.deleteBranch(branch);
  }

  async getStatuses(collectionName: string, slug: string) {
    const contentKey = this.generateContentKey(collectionName, slug);
    const branch = this.branchFromContentKey(contentKey);
    const mergeRequest = await this.getBranchMergeRequest(branch);
    const statuses: GitLabCommitStatus[] = await this.requestJSON({
      url: `${this.repoURL}/repository/commits/${mergeRequest.sha}/statuses`,
      params: {
        ref: branch,
      },
    });
    return statuses;
  }
}
