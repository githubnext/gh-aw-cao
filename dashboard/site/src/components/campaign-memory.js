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
 * @typedef {{ campaign: string, entry: MemoryFile, button: HTMLButtonElement }} SelectedMemoryFile
 */

/**
 * @param {Campaign[]} campaigns
 * @param {AbortSignal} signal
 */
function renderCampaignTree(campaigns, signal) {
  /** @type {HTMLDivElement} */
  let layout;
  const selectedFile = state(/** @type {SelectedMemoryFile | null} */ (null));
  const showFiles = () => {
    layout.dataset.memoryView = 'browser';
    selectedFile.get()?.button.focus();
  };
  const content = h(
    'article',
    { className: 'cao-memory-file-content', 'aria-live': 'polite', tabindex: '-1' }
  );
  /** @type {Array<(manifest: CampaignMemory | null) => void>} */
  const showManifests = [];
  /** @type {Array<(error: unknown) => void>} */
  const showErrors = [];
  const branches = campaigns.map((campaign) => {
    const files = h('div', { className: 'cao-memory-tree-status', role: 'status' }, renderLoadingMessage('Loading repository memory...'));
    const details = /** @type {HTMLDetailsElement} */ (h(
      'details',
      { className: 'cao-memory-campaign-branch' },
      h('summary', { className: 'cao-memory-campaign', role: 'treeitem', 'aria-expanded': 'false', tabindex: '-1' },
        octicon('file-directory-fill'),
        h('span', null, campaign.campaignName)
      ),
      files
    ));
    const disabledRow = () => h('div', {
      className: 'cao-memory-campaign cao-memory-campaign-disabled',
      role: 'treeitem',
      'aria-disabled': 'true',
      title: 'No repository memory files are available for this campaign',
    }, octicon('file-directory-fill'), h('span', null, campaign.campaignName));

    showManifests.push((manifest) => {
      if (signal.aborted) return;
      if (!manifest || manifest.files.length === 0) {
        const hadFocus = details.contains(details.ownerDocument.activeElement);
        details.replaceWith(disabledRow());
        if (hadFocus) treeNavigation.refresh(true);
        else treeNavigation.refresh();
        return;
      }
      const warning = renderOmissionWarning(manifest.omitted);
      /** @param {MemoryFile} entry @param {HTMLButtonElement} button */
      const select = (entry, button) => {
        selectedFile.set({ campaign: campaign.campaign, entry, button });
        mobileNavigation.open();
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
      treeNavigation.refresh();
    });
    showErrors.push((error) => {
      files.replaceChildren(renderEmptyMessage(
        `Repository memory is unavailable. ${errorMessage(error)}`,
        { role: 'alert' }
      ));
    });
    return h('li', { role: 'none' }, details);
  });

  const tree = h('ul', { role: 'tree', 'aria-label': 'Campaign memory files' }, ...branches);
  const treeNavigation = enableMemoryTreeNavigation(tree, signal);
  layout = /** @type {HTMLDivElement} */ (h(
    'div',
    { className: 'cao-memory-layout', dataset: { memoryView: 'browser' } },
    h(
      'nav',
      { className: 'cao-memory-tree', 'aria-label': 'Campaign memory files' },
      h('h2', null, 'Files'),
      tree
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

  // Owns the selected file's aria-current marker, focus, header, and
  // abort-scoped content fetch as one reactive sink: re-running on a new
  // selection cleans up the previous button's marker and in-flight fetch
  // before applying the next one, replacing the manual controller/DOM
  // bookkeeping the imperative version repeated at every selection site.
  /** @type {HTMLButtonElement | null} */
  let markedButton = null;
  effect(() => {
    const selected = selectedFile.get();
    markedButton?.removeAttribute('aria-current');
    markedButton = selected?.button ?? null;
    if (!selected) {
      content.replaceChildren(renderEmptyMessage('Select a memory file to view it.'));
      return;
    }
    selected.button.setAttribute('aria-current', 'true');
    layout.dataset.memoryView = 'file';
    content.focus();
    const fileBody = h('div', { className: 'memory-file-body' }, renderLoadingMessage('Loading file...'));
    content.replaceChildren(renderMemoryFileHeader(selected.entry.path), fileBody);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    onCleanup(() => {
      controller.abort();
      signal.removeEventListener('abort', abort);
    });
    readRepositoryMemoryFile(selected.campaign, selected.entry.path, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        fileBody.replaceChildren(h('pre', null, h('code', null, formatMemoryFileContent(selected.entry.path, result.content))));
      }
    }).catch((error) => {
      if (error?.name !== 'AbortError') {
        fileBody.replaceChildren(renderEmptyMessage(
          `Unable to load this memory file. ${errorMessage(error)}`,
          { role: 'alert' }
        ));
      }
    });
  }, { signal });

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
    { role: 'group' },
    ...[...node.directories].map(([name, child]) => h(
      'li',
      { role: 'none' },
      h(
        'details',
        { className: 'campaign-memory-directory', open: true },
        h('summary', { role: 'treeitem', 'aria-expanded': 'true', tabindex: '-1' },
          octicon('file-directory'), h('span', null, name)),
        renderNode(child)
      )
    )),
    ...node.files.map(({ name, entry }) => {
      /** @type {HTMLButtonElement} */
      let button;
      button = renderMemoryFileButton(name, entry.size,
        { title: entry.path, role: 'treeitem', tabindex: '-1' }, () => select(entry, button));
      return h('li', { role: 'none' }, button);
    })
  );
  return renderNode(root);
}

/**
 * Keeps one tab stop in the file tree while arrow keys traverse only expanded
 * branches. Native details and buttons retain their Enter/Space behavior.
 * @param {HTMLElement} tree
 * @param {AbortSignal} signal
 */
function enableMemoryTreeNavigation(tree, signal) {
  /** @returns {HTMLElement[]} */
  const visibleItems = () => [...tree.querySelectorAll('[role="treeitem"]:not([aria-disabled="true"])')]
    .map((item) => /** @type {HTMLElement} */ (item))
    .filter((item) => {
      for (let details = item.closest('details'); details; details = details.parentElement?.closest('details') ?? null) {
        if (!details.open && details.firstElementChild !== item) return false;
      }
      return true;
    });
  /** @param {HTMLElement} item */
  const focusItem = (item) => {
    tree.querySelectorAll('[role="treeitem"][tabindex="0"]').forEach((previous) => {
      previous.setAttribute('tabindex', '-1');
    });
    item.setAttribute('tabindex', '0');
    item.focus();
  };
  const refresh = (restoreFocus = false) => {
    const items = visibleItems();
    const current = tree.querySelector('[role="treeitem"][tabindex="0"]');
    if (current && items.includes(/** @type {HTMLElement} */ (current))) return;
    tree.querySelectorAll('[role="treeitem"][tabindex="0"]').forEach((item) => item.setAttribute('tabindex', '-1'));
    if (items[0]) {
      items[0].setAttribute('tabindex', '0');
      if (restoreFocus) items[0].focus();
    }
  };
  /** @param {Event} event */
  const onFocus = (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('[role="treeitem"]')) focusItem(target);
  };
  /** @param {Event} event */
  const onToggle = (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;
    const summary = details.firstElementChild;
    summary?.setAttribute('aria-expanded', String(details.open));
    if (!details.open && details.contains(tree.ownerDocument.activeElement)) {
      focusItem(/** @type {HTMLElement} */ (summary));
    }
    refresh();
  };
  /** @param {KeyboardEvent} event */
  const onKeyDown = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.matches('[role="treeitem"]')) return;
    const items = visibleItems();
    const index = items.indexOf(target);
    if (index < 0) return;
    const details = target.parentElement instanceof HTMLDetailsElement ? target.parentElement : null;
    const parent = (details ? details.parentElement : target)?.closest('details');
    /** @type {HTMLElement | undefined | null} */
    let next;
    switch (event.key) {
      case 'ArrowDown': next = items[index + 1]; break;
      case 'ArrowUp': next = items[index - 1]; break;
      case 'Home': next = items[0]; break;
      case 'End': next = items.at(-1); break;
      case 'ArrowRight':
        if (details && !details.open) {
          details.open = true;
          target.setAttribute('aria-expanded', 'true');
        }
        else if (details && items[index + 1] && details.contains(items[index + 1])) next = items[index + 1];
        break;
      case 'ArrowLeft':
        if (details?.open) {
          details.open = false;
          target.setAttribute('aria-expanded', 'false');
        }
        else next = /** @type {HTMLElement | null} */ (parent?.firstElementChild);
        break;
      default: return;
    }
    event.preventDefault();
    if (next) focusItem(next);
  };
  tree.addEventListener('focusin', onFocus, { signal });
  tree.addEventListener('keydown', onKeyDown, { signal });
  tree.addEventListener('toggle', onToggle, { capture: true, signal });
  refresh();
  return { refresh };
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
            : file.status === 'ready' && selected
              ? h('pre', null, h('code', null, formatMemoryFileContent(selected.path, file.content)))
              : null
      )
    )
  );
}

/**
 * Pretty-prints JSON and each valid JSONL record for display without changing
 * the underlying memory file.
 * @param {string} path
 * @param {string} content
 */
export function formatMemoryFileContent(path, content) {
  /** @param {string} text */
  const prettyPrint = (text) => {
    const trailingWhitespace = text.match(/\s*$/u)?.[0] ?? '';
    const json = text.slice(0, text.length - trailingWhitespace.length);
    try {
      return `${JSON.stringify(JSON.parse(json), null, 2) ?? text}${trailingWhitespace}`;
    } catch {
      return text;
    }
  };
  if (/\.json$/i.test(path)) return prettyPrint(content);
  if (!/\.jsonl$/i.test(path)) return content;
  return content.split(/(\r\n|\n|\r)/).map((part, index) => {
    if (index % 2 === 1 || part.trim() === '') return part;
    return prettyPrint(part);
  }).join('');
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
