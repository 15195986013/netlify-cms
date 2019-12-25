import trimStart from 'lodash/trimStart';
import semaphore, { Semaphore } from 'semaphore';
import { trim } from 'lodash';
import { stripIndent } from 'common-tags';
import {
  CURSOR_COMPATIBILITY_SYMBOL,
  basename,
  getCollectionDepth,
  Map,
  Entry,
  AssetProxy,
  PersistOptions,
  CursorType,
  Implementation,
  DisplayURL,
  ImplementationEntry,
  DisplayURLObject,
  EditorialWorkflowError,
  Collection,
} from 'netlify-cms-lib-util';
import AuthenticationPage from './AuthenticationPage';
import API from './API';
import { getBlobSHA } from 'netlify-cms-lib-util/src';

const MAX_CONCURRENT_DOWNLOADS = 10;

export default class GitLab implements Implementation {
  config: Map;
  api: API | null;
  options: {
    proxied: boolean;
    API: API | null;
    useWorkflow?: boolean;
  };
  repo: string;
  branch: string;
  apiRoot: string;
  token: string | null;

  _mediaDisplayURLSem?: Semaphore;

  constructor(config: Map, options = {}) {
    this.config = config;
    this.options = {
      proxied: false,
      API: null,
      ...options,
    };

    if (!this.options.proxied && config.getIn(['backend', 'repo']) == null) {
      throw new Error('The GitLab backend needs a "repo" in the backend configuration.');
    }

    this.api = this.options.API || null;

    this.repo = config.getIn(['backend', 'repo'], '');
    this.branch = config.getIn(['backend', 'branch'], 'master');
    this.apiRoot = config.getIn(['backend', 'api_root'], 'https://gitlab.com/api/v4');
    this.token = '';
  }

  authComponent() {
    return AuthenticationPage;
  }

  restoreUser(user: { token: string }) {
    return this.authenticate(user);
  }

  async authenticate(state: { token: string }) {
    this.token = state.token;
    this.api = new API({
      token: this.token,
      branch: this.branch,
      repo: this.repo,
      apiRoot: this.apiRoot,
    });
    const user = await this.api.user();
    const isCollab = await this.api.hasWriteAccess().catch((error: Error) => {
      error.message = stripIndent`
        Repo "${this.repo}" not found.

        Please ensure the repo information is spelled correctly.

        If the repo is private, make sure you're logged into a GitLab account with access.
      `;
      throw error;
    });

    // Unauthorized user
    if (!isCollab) {
      throw new Error('Your GitLab user account does not have access to this repo.');
    }

    // Authorized user
    return { ...user, login: user.username, token: state.token };
  }

  async logout() {
    this.token = null;
    return;
  }

  getToken() {
    return Promise.resolve(this.token);
  }

  filterFile(
    folder: string,
    file: { path: string; name: string },
    extension: string,
    depth: number,
  ) {
    // gitlab paths include the root folder
    const fileFolder = trim(file.path.split(folder)[1] || '/', '/');
    return file.name.endsWith('.' + extension) && fileFolder.split('/').length <= depth;
  }

  entriesByFolder(collection: Collection, extension: string) {
    const depth = getCollectionDepth(collection);
    const folder = collection.get('folder') as string;
    return this.api!.listFiles(folder, depth > 1).then(({ files, cursor }) =>
      this.fetchFiles(files.filter(file => this.filterFile(folder, file, extension, depth))).then(
        fetchedFiles => {
          const returnedFiles = fetchedFiles;
          // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
          // @ts-ignore
          returnedFiles[CURSOR_COMPATIBILITY_SYMBOL] = cursor;
          return returnedFiles;
        },
      ),
    );
  }

  allEntriesByFolder(collection: Collection, extension: string) {
    const depth = getCollectionDepth(collection);
    const folder = collection.get('folder') as string;
    return this.api!.listAllFiles(folder, depth > 1).then(files =>
      this.fetchFiles(files.filter(file => this.filterFile(folder, file, extension, depth))),
    );
  }

  entriesByFiles(collection: Collection) {
    const files = collection
      .get('files')!
      .map(collectionFile => ({
        path: collectionFile!.get('file'),
        label: collectionFile!.get('label'),
      }))
      .toArray();

    return this.fetchFiles(files).then(fetchedFiles => {
      const returnedFiles = fetchedFiles;
      return returnedFiles;
    });
  }

  fetchFiles = (files: { path: string; id?: string }[]) => {
    const sem = semaphore(MAX_CONCURRENT_DOWNLOADS);
    const promises = [] as Promise<ImplementationEntry | { error: Error }>[];
    files.forEach(file => {
      promises.push(
        new Promise(resolve =>
          sem.take(() =>
            this.api!.readFile(file.path, file.id)
              .then(data => {
                resolve({ file, data: data as string });
                sem.leave();
              })
              .catch((error = true) => {
                sem.leave();
                console.error(`failed to load file from GitLab: ${file.path}`);
                resolve({ error });
              }),
          ),
        ),
      );
    });
    return Promise.all(promises).then(loadedEntries =>
      loadedEntries.filter(loadedEntry => !((loadedEntry as unknown) as { error: boolean }).error),
    ) as Promise<ImplementationEntry[]>;
  };

  // Fetches a single entry.
  getEntry(collection: Collection, slug: string, path: string) {
    return this.api!.readFile(path).then(data => ({
      file: { path },
      data: data as string,
    }));
  }

  getMedia(mediaFolder = this.config.get<string>('media_folder')) {
    return this.api!.listAllFiles(mediaFolder).then(files =>
      files.map(({ id, name, path }) => {
        return { id, name, path, displayURL: { id, name, path } };
      }),
    );
  }

  async getMediaAsBlob(path: string, id: string | null) {
    let blob = (await this.api!.readFile(path, id, { parseText: false })) as Blob;
    // svgs are returned with mimetype "text/plain" by gitlab
    if (blob.type === 'text/plain' && path.match(/\.svg$/i)) {
      blob = new window.Blob([blob], { type: 'image/svg+xml' });
    }

    return blob;
  }

  getMediaDisplayURL(displayURL: DisplayURL) {
    this._mediaDisplayURLSem = this._mediaDisplayURLSem || semaphore(MAX_CONCURRENT_DOWNLOADS);
    const { id, path } = displayURL as DisplayURLObject;
    return new Promise<string>((resolve, reject) =>
      this._mediaDisplayURLSem!.take(() =>
        this.getMediaAsBlob(path, id)
          .then(blob => URL.createObjectURL(blob))
          .then(resolve, reject)
          .finally(() => this._mediaDisplayURLSem!.leave()),
      ),
    );
  }

  async getMediaFile(path: string) {
    const name = basename(path);
    const blob = await this.getMediaAsBlob(path, null);
    const fileObj = new File([blob], name);
    const url = URL.createObjectURL(fileObj);
    const id = await getBlobSHA(blob);

    return {
      id,
      displayURL: url,
      path,
      name,
      size: fileObj.size,
      file: fileObj,
      url,
    };
  }

  async persistEntry(entry: Entry, mediaFiles: AssetProxy[], options: PersistOptions) {
    await this.api!.persistFiles([entry, ...mediaFiles], options);
  }

  async persistMedia(mediaFile: AssetProxy, options: PersistOptions) {
    const fileObj = mediaFile.fileObj as File;

    const [id] = await Promise.all([
      getBlobSHA(fileObj),
      this.api!.persistFiles([mediaFile], options),
    ]);

    const { path } = mediaFile;
    const url = URL.createObjectURL(fileObj);

    return {
      displayURL: url,
      path: trimStart(path, '/'),
      name: fileObj!.name,
      size: fileObj!.size,
      file: fileObj,
      url,
      id,
    };
  }

  deleteFile(path: string, commitMessage: string) {
    return this.api!.deleteFile(path, commitMessage);
  }

  traverseCursor(cursor: CursorType, action: string) {
    return this.api!.traverseCursor(cursor, action).then(
      async ({ entries, cursor: newCursor }) => ({
        entries: await Promise.all(
          entries.map(file =>
            this.api!.readFile(file.path, file.id).then(data => ({ file, data: data as string })),
          ),
        ),
        cursor: newCursor,
      }),
    );
  }

  async unpublishedEntries() {
    return [];
  }

  async unpublishedEntry(collection: Collection, slug: string) {
    if (collection) {
      throw new EditorialWorkflowError('content is not under editorial workflow', true);
    }
    return { data: '', file: { path: '' } };
  }

  async updateUnpublishedEntryStatus(collection: string, slug: string, newStatus: string) {
    return;
  }

  async publishUnpublishedEntry(collection: string, slug: string) {
    return;
  }

  async deleteUnpublishedEntry(collection: string, slug: string) {
    return;
  }

  async getDeployPreview(collectionName: string, slug: string) {
    return null;
  }
}
