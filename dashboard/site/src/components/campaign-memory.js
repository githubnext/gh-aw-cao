import { h } from '../dom.js';
import { listRepositoryMemory, listRepositoryMemoryCampaigns, readRepositoryMemoryFile } from '../data-processor.js';
import { createDebug } from '../debug.js';
import { octicon } from '../octicons.js';
import { effect, onCleanup, render, state } from '../reactive.js';
import { bindFactorySources, createFactoryScope } from './factory-elements.js';
import { errorMessage } from './count-formatters.js';
import { renderEmptyMessage, renderLoadingMessage } from './ui-primitives.js';

const debugCampaignMemory = createDebug('campaign-memory');
const MOBILE_MEMORY_HISTORY_KEY = 'caoMemoryViewer';

/** @typedef {{ campaign: string, campaignName: string }} Campaign */
/** @typedef {{ path: string, oid: string, sha256?: string, size: number }} MemoryFile */
/** @typedef {{ directories: Map<string, MemoryTreeNode>, files: { name: string, entry: MemoryFile }[] }} MemoryTreeNode */
/** @typedef {{ fileLimit: number, fileSize: number, totalSize: number, extension: number, nesting: number, unsafePath: number, invalidContent: number, unsupportedType: number }} OmittedFiles */
/** @typedef {{ branch: string, commit: string, files: MemoryFile[], omitted: OmittedFiles }} CampaignMemory */
/** @typedef {{ status: string, branch: string, commit: string, files: MemoryFile[], omitted: OmittedFiles, error: string }} ManifestState */
/** @typedef {{ status: string, content: string, error: string }} MemoryFileState */

/**
 * @param {{ campaignId: string, campaignName: string }} options
 */
export function renderCampaignMemory({ campaignId, campaignName }) {
  const scope = createFactoryScope();
  const root = h('section', {
    className: 'campaign-memory-browser',
    'aria-label': `${campaignName} repository memory`,
  });
  const manifestState = state(/** @type {ManifestState} */ ({
    status: 'loading', branch: '', commit: '', files: [], omitted: emptyOmissions(), error: ''
  }));
  const selectedPath = state('');
  const fileState = state(/** @type {MemoryFileState} */ ({ status: 'idle', content: '', error: '' }));
  const mobileView = state('browser');
  const mobileNavigation = createMobileMemoryNavigation(
    root,
    `campaign:${campaignId}`,
    'campaigns',
    () => mobileView.set('file'),
    (restoreFocus = true) => {
      mobileView.set('browser');
      if (restoreFocus) {
        afterRender(() => /** @type {HTMLElement | null} */ (
          root.querySelector('.campaign-memory-file[aria-current="true"]')
        )?.focus());
      }
    },
    scope.signal
  );
  const afterRender = (/** @type {() => void} */ callback) => {
    const frame = root.ownerDocument.defaultView?.requestAnimationFrame;
    if (frame) frame.call(root.ownerDocument.defaultView, callback);
    else queueMicrotask(callback);
  };
  const focusFilePane = () => afterRender(() => {
    const pane = /** @type {HTMLElement | null} */ (root.querySelector('.campaign-memory-content'));
    if (pane && !pane.contains(document.activeElement)) pane.focus();
  });

  render(root, () => memoryView({
    campaignName,
    manifest: manifestState.get(),
    selectedPath: selectedPath.get(),
    file: fileState.get(),
    mobileView: mobileView.get(),
    select: (filePath) => {
      selectedPath.set(filePath);
      mobileView.set('file');
      mobileNavigation.open();
      focusFilePane();
    },
  }), { signal: scope.signal });

  listRepositoryMemory(campaignId, scope.signal).then((campaign) => {
    debugCampaignMemory({
      operation: 'list-manifest',
      status: campaign ? 'ready' : 'empty',
      fileCount: campaign?.files.length ?? 0
    });
    if (!campaign) {
      manifestState.set({
        status: 'empty', branch: '', commit: '', files: [], omitted: emptyOmissions(), error: ''
      });
      return;
    }
    manifestState.set({ status: 'ready', ...campaign, error: '' });
    selectedPath.set(campaign.files[0]?.path ?? '');
  }).catch((error) => {
    if (error?.name !== 'AbortError') {
      manifestState.set({
        status: 'error',
        branch: '',
        commit: '',
        files: [],
        omitted: emptyOmissions(),
        error: errorMessage(error),
      });
    }
  });

  effect(() => {
    const filePath = selectedPath.get();
    if (!filePath) {
      fileState.set({ status: 'idle', content: '', error: '' });
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    scope.signal.addEventListener('abort', abort, { once: true });
    onCleanup(() => {
      controller.abort();
      scope.signal.removeEventListener('abort', abort);
    });
    fileState.set({ status: 'loading', content: '', error: '' });
    readRepositoryMemoryFile(campaignId, filePath, controller.signal).then((result) => {
      const content = result.content;
      if (!controller.signal.aborted) {
        debugCampaignMemory({ operation: 'read-file', status: 'ready', contentLength: content.length });
        fileState.set({ status: 'ready', content, error: '' });
      }
    }).catch((error) => {
      if (error?.name !== 'AbortError') {
        debugCampaignMemory({ operation: 'read-file', status: 'error', errorName: error?.name ?? 'Error' });
        fileState.set({
          status: 'error',
          content: '',
          error: errorMessage(error),
        });
      }
    });
  }, { signal: scope.signal });

  scope.bind(root);
  return root;
}

/**
 * Renders all registered campaign memory without leaving the Memory page.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderAllCampaignMemory(context) {
  const sourceName = context.sourceNames[0] ?? '';
  const source = bindFactorySources(context.sources, [sourceName], context)[sourceName];
  const scope = createFactoryScope();
  const root = h('section', { className: 'cao-memory-browser', 'aria-label': 'CAO repository memory' });
  let renderedCampaigns = '';
  let browserController = new AbortController();

  effect(() => {
    if (source.pending()) {
      if (renderedCampaigns) return;
      root.replaceChildren(renderLoadingMessage('Loading campaign memory...'));
      root.setAttribute('aria-busy', 'true');
      return;
    }
    root.removeAttribute('aria-busy');
    if (source.unavailable()) {
      browserController.abort();
      root.replaceChildren(renderEmptyMessage('Campaign memory is unavailable.', { role: 'alert' }));
      return;
    }
    const campaigns = source.rows()
      .map((row) => ({
        campaign: typeof row.campaign === 'string' ? row.campaign : '',
        campaignName: typeof row['campaign-name'] === 'string' ? row['campaign-name'] : '',
      }))
      .filter((campaign) => campaign.campaign && campaign.campaignName);
    const campaignSignature = JSON.stringify(campaigns);
    if (campaignSignature === renderedCampaigns) return;
    renderedCampaigns = campaignSignature;
    browserController.abort();
    browserController = new AbortController();
    if (campaigns.length === 0) {
      browserController.abort();
      root.replaceChildren(renderEmptyMessage('No campaigns are registered.'));
      return;
    }
    root.replaceChildren(renderCampaignTree(campaigns, browserController.signal));
  }, { signal: scope.signal });

  scope.signal.addEventListener('abort', () => browserController.abort(), { once: true });
  scope.bind(root);
  return root;
}

/**
 * @param {Campaign[]} campaigns
 * @param {AbortSignal} signal
 */
function renderCampaignTree(campaigns, signal) {
  /** @type {HTMLButtonElement | null} */
  let selectedButton = null;
  /** @type {HTMLDivElement} */
  let layout;
  const showFiles = () => {
    layout.dataset.memoryView = 'browser';
    selectedButton?.focus();
  };
  const content = h(
    'article',
    { className: 'cao-memory-file-content', 'aria-live': 'polite', tabindex: '-1' },
    renderEmptyMessage('Select a memory file to view it.')
  );
  /** @type {AbortController | null} */
  let fileController = null;
  /** @type {Array<(manifest: CampaignMemory | null) => void>} */
  const showManifests = [];
  /** @type {Array<(error: unknown) => void>} */
  const showErrors = [];
  const branches = campaigns.map((campaign) => {
    const files = h('div', { className: 'cao-memory-tree-status', role: 'status' }, renderLoadingMessage('Loading repository memory...'));
    const details = /** @type {HTMLDetailsElement} */ (h(
      'details',
      { className: 'cao-memory-campaign-branch' },
      h('summary', { className: 'cao-memory-campaign' },
        octicon('file-directory-fill'),
        h('span', null, campaign.campaignName)
      ),
      files
    ));
    const disabledRow = () => h('div', {
      className: 'cao-memory-campaign cao-memory-campaign-disabled',
      'aria-disabled': 'true',
      title: 'No repository memory files are available for this campaign',
    }, octicon('file-directory-fill'), h('span', null, campaign.campaignName));

    showManifests.push((manifest) => {
      if (signal.aborted) return;
      if (!manifest || manifest.files.length === 0) {
        details.replaceWith(disabledRow());
        return;
      }
      const warning = renderOmissionWarning(manifest.omitted);
      /** @param {MemoryFile} entry @param {HTMLButtonElement} button */
      const select = (entry, button) => {
        selectedButton = button;
        layout.dataset.memoryView = 'file';
        mobileNavigation.open();
        content.focus();
        fileController?.abort();
        fileController = new AbortController();
        const abort = () => fileController?.abort();
        signal.addEventListener('abort', abort, { once: true });
        for (const selected of details.closest('.cao-memory-browser')?.querySelectorAll(
          '.campaign-memory-file[aria-current="true"]'
        ) ?? []) selected.removeAttribute('aria-current');
        button.setAttribute('aria-current', 'true');
        const fileBody = h(
          'div',
          { className: 'memory-file-body' },
          renderLoadingMessage('Loading file...')
        );
        content.replaceChildren(
          renderMemoryFileHeader(entry.path),
          fileBody
        );
        const activeController = fileController;
        readRepositoryMemoryFile(campaign.campaign, entry.path, activeController.signal).then((result) => {
          if (!activeController.signal.aborted) {
            fileBody.replaceChildren(h('pre', null, h('code', null, result.content)));
          }
        }).catch((error) => {
          if (error?.name !== 'AbortError') {
            fileBody.replaceChildren(renderEmptyMessage(
              `Unable to load this memory file. ${errorMessage(error)}`,
              { role: 'alert' }
            ));
          }
        }).finally(() => signal.removeEventListener('abort', abort));
      };
      const tree = renderFileTree(manifest.files, select);
      files.replaceChildren(
        h('p', { className: 'campaign-memory-branch' },
          h('strong', null, manifest.branch),
          ` at ${manifest.commit.slice(0, 7)}`
        ),
        ...(warning ? [warning] : []),
        tree
      );
    });
    showErrors.push((error) => {
      files.replaceChildren(renderEmptyMessage(
        `Repository memory is unavailable. ${errorMessage(error)}`,
        { role: 'alert' }
      ));
    });
    return h('li', null, details);
  });

  layout = /** @type {HTMLDivElement} */ (h(
    'div',
    { className: 'cao-memory-layout', dataset: { memoryView: 'browser' } },
    h(
      'nav',
      { className: 'cao-memory-tree', 'aria-label': 'Campaign memory files' },
      h('h2', null, 'Files'),
      h('ul', null, ...branches)
    ),
    content
  ));
  const mobileNavigation = createMobileMemoryNavigation(
    layout,
    'all-campaigns',
    '',
    () => {
      layout.dataset.memoryView = 'file';
      content.focus();
    },
    showFiles,
    signal,
    false
  );
  listRepositoryMemoryCampaigns(campaigns.map(({ campaign }) => campaign), signal).then((manifests) => {
    if (!signal.aborted) manifests.forEach((manifest, index) => {
      if (manifest && 'error' in manifest) showErrors[index](manifest.error);
      else showManifests[index](manifest);
    });
  }).catch((error) => {
    if (!signal.aborted && error?.name !== 'AbortError') showErrors.forEach((showError) => showError(error));
  });
  return layout;
}

/**
 * @param {MemoryFile[]} entries
 * @param {(entry: MemoryFile, button: HTMLButtonElement) => void} select
 */
function renderFileTree(entries, select) {
  const root = /** @type {MemoryTreeNode} */ ({ directories: new Map(), files: [] });
  for (const entry of entries) {
    const segments = entry.path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), files: [] };
        node.directories.set(segment, child);
      }
      node = child;
    }
    node.files.push({ name: segments.at(-1) ?? entry.path, entry });
  }

  /** @param {MemoryTreeNode} node @returns {HTMLElement} */
  const renderNode = (node) => h(
    'ul',
    null,
    ...[...node.directories].map(([name, child]) => h(
      'li',
      null,
      h(
        'details',
        { className: 'campaign-memory-directory', open: true },
        h('summary', null, octicon('file-directory'), h('span', null, name)),
        renderNode(child)
      )
    )),
    ...node.files.map(({ name, entry }) => {
      /** @type {HTMLButtonElement} */
      let button;
      button = renderMemoryFileButton(name, entry.size, { title: entry.path }, () => select(entry, button));
      return h('li', null, button);
    })
  );
  return renderNode(root);
}

/**
 * @param {{
 *   campaignName: string,
 *   manifest: ManifestState,
 *   selectedPath: string,
 *   file: MemoryFileState,
 *   mobileView: string,
 *   select: (filePath: string) => void,
 * }} options
 */
function memoryView({ campaignName, manifest, selectedPath, file, mobileView, select }) {
  if (manifest.status === 'loading') {
    return renderLoadingMessage('Loading repository memory...');
  }
  if (manifest.status === 'error') {
    return renderEmptyMessage(`Repository memory is unavailable. ${manifest.error}`, { role: 'alert' });
  }
  if (manifest.status === 'empty') {
    return renderEmptyMessage('No repository-memory branch has been published for this campaign.');
  }
  const warning = renderOmissionWarning(manifest.omitted);
  if (manifest.files.length === 0) return h(
    'div',
    null,
    warning,
    renderEmptyMessage('The repository-memory branch contains no supported files.')
  );
  const selected = manifest.files.find((entry) => entry.path === selectedPath);
  return h(
    'div',
    null,
    warning,
    h(
      'div',
      { className: 'campaign-memory-layout', dataset: { memoryView: mobileView } },
      h(
        'aside',
        { className: 'campaign-memory-files', 'aria-label': `${campaignName} memory files` },
        h('p', { className: 'campaign-memory-branch' },
          h('strong', null, manifest.branch),
          ` at ${manifest.commit.slice(0, 7)}`
        ),
        h('ul', null, ...manifest.files.map((entry) => h(
          'li',
          null,
          renderMemoryFileButton(
            entry.path,
            entry.size,
            { 'aria-current': entry.path === selectedPath ? 'true' : null },
            () => select(entry.path)
          )
        )))
      ),
      h(
        'article',
        { className: 'campaign-memory-content', 'aria-live': 'polite', tabindex: '-1' },
        selected ? renderMemoryFileHeader(selected.path) : null,
        file.status === 'loading'
          ? renderLoadingMessage('Loading file...')
          : file.status === 'error'
            ? renderEmptyMessage(`Unable to load this memory file. ${file.error}`, { role: 'alert' })
            : file.status === 'ready'
              ? h('pre', null, h('code', null, file.content))
              : null
      )
    )
  );
}

/**
 * @param {string} path
 */
function renderMemoryFileHeader(path) {
  return h(
    'header',
    { className: 'memory-file-header' },
    h('h2', null, path)
  );
}

/**
 * Uses one browser-history entry for the mobile file pane so the app chrome is
 * the only back control.
 * @param {HTMLElement} root
 * @param {string} scopeKey
 * @param {string} parentPage
 * @param {() => void} showFile
 * @param {(restoreFocus?: boolean) => void} showFiles
 * @param {AbortSignal} signal
 * @param {boolean} [restoreFile]
 */
function createMobileMemoryNavigation(root, scopeKey, parentPage, showFile, showFiles, signal, restoreFile = true) {
  const view = root.ownerDocument.defaultView;
  let active = view?.history.state?.[MOBILE_MEMORY_HISTORY_KEY] === scopeKey;
  if (view && active && !restoreFile) {
    const rest = { ...view.history.state };
    delete rest[MOBILE_MEMORY_HISTORY_KEY];
    view.history.replaceState(rest, '', view.location.href);
    active = false;
  }
  /** @param {string} navigationPage */
  const setParent = (navigationPage) => queueMicrotask(() => {
    if (!root.isConnected) return;
    root.dispatchEvent(new CustomEvent('dashboard-route-parent-change', {
      bubbles: true,
      detail: { navigationPage }
    }));
  });
  /** @param {PopStateEvent} event */
  const onPopState = (event) => {
    active = event.state?.[MOBILE_MEMORY_HISTORY_KEY] === scopeKey;
    if (active) showFile();
    else showFiles();
    setParent(active ? '' : parentPage);
  };
  const onHistoryChange = () => {
    const current = view?.history.state?.[MOBILE_MEMORY_HISTORY_KEY] === scopeKey;
    if (current === active) return;
    active = current;
    if (active) showFile();
    else showFiles(false);
    setParent(active ? '' : parentPage);
  };
  view?.addEventListener('popstate', onPopState, { signal });
  view?.addEventListener('dashboard-history-change', onHistoryChange, { signal });
  if (active) {
    showFile();
    setParent('');
  }
  return {
    open() {
      if (!view?.matchMedia?.('(max-width: 700px)').matches) return;
      if (!active) {
        const currentState = view.history.state && typeof view.history.state === 'object'
          ? view.history.state
          : {};
        const handled = !root.dispatchEvent(new CustomEvent('dashboard-history-push', {
          bubbles: true,
          cancelable: true,
          detail: { state: { [MOBILE_MEMORY_HISTORY_KEY]: scopeKey } }
        }));
        if (!handled) {
          view.history.pushState(
            { ...currentState, [MOBILE_MEMORY_HISTORY_KEY]: scopeKey },
            '',
            view.location.href
          );
          view.dispatchEvent(new CustomEvent('dashboard-history-change'));
        }
      }
      active = true;
      setParent('');
    }
  };
}

function emptyOmissions() {
  return { fileLimit: 0, fileSize: 0, totalSize: 0, extension: 0, nesting: 0, unsafePath: 0, invalidContent: 0, unsupportedType: 0 };
}

/** @param {OmittedFiles} omitted */
function renderOmissionWarning(omitted) {
  const reasons = [
    ['fileLimit', 'the file-count limit'],
    ['fileSize', 'the file-size limit'],
    ['totalSize', 'the total-size limit'],
    ['extension', 'unsupported file extensions'],
    ['nesting', 'the nesting limit'],
    ['unsafePath', 'unsafe paths'],
    ['invalidContent', 'invalid text content'],
    ['unsupportedType', 'unsupported file types'],
  ].flatMap(([key, label]) => omitted[/** @type {keyof OmittedFiles} */ (key)] > 0
    ? [`${omitted[/** @type {keyof OmittedFiles} */ (key)]} excluded by ${label}`]
    : []);
  return reasons.length > 0
    ? h('p', { className: 'campaign-memory-warning', role: 'status' },
      `This view does not represent the entire memory branch: ${reasons.join(', ')}.`)
    : null;
}

/** @param {number} bytes */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

/**
 * Renders the shared `campaign-memory-file` `<button>` markup (file icon,
 * name label, and formatted file size) used by both the multi-campaign file
 * tree and the single-campaign flat file list, which otherwise duplicated
 * the same button structure with only the label, extra attributes, and
 * click handler differing.
 * @param {string} label
 * @param {number} size
 * @param {Record<string, unknown>} attributes
 * @param {() => void} onclick
 * @returns {HTMLButtonElement}
 */
function renderMemoryFileButton(label, size, attributes, onclick) {
  return /** @type {HTMLButtonElement} */ (h(
    'button',
    { type: 'button', className: 'campaign-memory-file', ...attributes, onclick },
    octicon('file'),
    h('span', { className: 'memory-file-name' }, label),
    h('small', null, formatFileSize(size))
  ));
}
