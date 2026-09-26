import { h } from '../dom.js';
import { listRepositoryMemory, readRepositoryMemoryFile } from '../data-processor.js';
import { createDebug } from '../debug.js';
import { effect, onCleanup, render, state } from '../reactive.js';
import { bindFactorySources, createFactoryScope } from './factory-elements.js';
import { renderEmptyMessage } from './ui-primitives.js';

const debugCampaignMemory = createDebug('campaign-memory');

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

  render(root, () => memoryView({
    campaignName,
    manifest: manifestState.get(),
    selectedPath: selectedPath.get(),
    file: fileState.get(),
    select: (filePath) => selectedPath.set(filePath),
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
        error: error instanceof Error ? error.message : String(error),
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
          error: error instanceof Error ? error.message : String(error),
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
      root.replaceChildren(renderEmptyMessage('Loading campaign memory...', { role: 'status', 'aria-busy': 'true' }));
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
  const content = h(
    'article',
    { className: 'cao-memory-file-content', 'aria-live': 'polite' },
    renderEmptyMessage('Select a memory file to view it.')
  );
  /** @type {AbortController | null} */
  let fileController = null;
  const branches = campaigns.map((campaign, index) => {
    const files = h('div', { className: 'cao-memory-tree-status', role: 'status' }, 'Expand to load files.');
    const details = /** @type {HTMLDetailsElement} */ (h(
      'details',
      { className: 'cao-memory-campaign-branch', open: index === 0 },
      h('summary', { className: 'cao-memory-campaign' }, campaign.campaignName),
      files
    ));
    let loaded = false;

    const load = () => {
      if (loaded || !details.open) return;
      loaded = true;
      files.replaceChildren(renderEmptyMessage('Loading repository memory...', { role: 'status', 'aria-busy': 'true' }));
      listRepositoryMemory(campaign.campaign, signal).then((manifest) => {
        if (signal.aborted) return;
        if (!manifest) {
          files.replaceChildren(renderEmptyMessage('No repository-memory branch has been published for this campaign.'));
          return;
        }
        const warning = renderOmissionWarning(manifest.omitted);
        if (manifest.files.length === 0) {
          files.replaceChildren(
            ...(warning ? [warning] : []),
            renderEmptyMessage('The repository-memory branch contains no supported files.')
          );
          return;
        }
        /** @param {MemoryFile} entry @param {HTMLButtonElement} button */
        const select = (entry, button) => {
          fileController?.abort();
          fileController = new AbortController();
          const abort = () => fileController?.abort();
          signal.addEventListener('abort', abort, { once: true });
          for (const selected of details.closest('.cao-memory-browser')?.querySelectorAll(
            '.campaign-memory-file[aria-current="true"]'
          ) ?? []) selected.removeAttribute('aria-current');
          button.setAttribute('aria-current', 'true');
          content.replaceChildren(
            h('h2', null, entry.path),
            renderEmptyMessage('Loading file...', { role: 'status', 'aria-busy': 'true' })
          );
          const activeController = fileController;
          readRepositoryMemoryFile(campaign.campaign, entry.path, activeController.signal).then((result) => {
            if (!activeController.signal.aborted) {
              content.replaceChildren(
                h('h2', null, entry.path),
                h('pre', null, h('code', null, result.content))
              );
            }
          }).catch((error) => {
            if (error?.name !== 'AbortError') {
              content.replaceChildren(
                h('h2', null, entry.path),
                renderEmptyMessage(
                  `Unable to load this memory file. ${error instanceof Error ? error.message : String(error)}`,
                  { role: 'alert' }
                )
              );
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
        if (index === 0) {
          /** @type {HTMLButtonElement | null} */ (tree.querySelector('.campaign-memory-file'))?.click();
        }
      }).catch((error) => {
        if (error?.name !== 'AbortError') {
          files.replaceChildren(renderEmptyMessage(
            `Repository memory is unavailable. ${error instanceof Error ? error.message : String(error)}`,
            { role: 'alert' }
          ));
        }
      });
    };
    details.addEventListener('toggle', load);
    if (details.open) queueMicrotask(load);
    return h('li', null, details);
  });

  return h(
    'div',
    { className: 'cao-memory-layout' },
    h(
      'nav',
      { className: 'cao-memory-tree', 'aria-label': 'Campaign memory files' },
      h('h2', null, 'Files'),
      h('ul', null, ...branches)
    ),
    content
  );
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
        h('summary', null, name),
        renderNode(child)
      )
    )),
    ...node.files.map(({ name, entry }) => {
      const button = /** @type {HTMLButtonElement} */ (h(
        'button',
        {
          type: 'button',
          className: 'campaign-memory-file',
          title: entry.path,
          onclick: () => select(entry, button),
        },
        h('span', null, name),
        h('small', null, formatFileSize(entry.size))
      ));
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
 *   select: (filePath: string) => void
 * }} options
 */
function memoryView({ campaignName, manifest, selectedPath, file, select }) {
  if (manifest.status === 'loading') {
    return renderEmptyMessage('Loading repository memory...', { role: 'status', 'aria-busy': 'true' });
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
      { className: 'campaign-memory-layout' },
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
          h('button', {
            type: 'button',
            className: 'campaign-memory-file',
            'aria-current': entry.path === selectedPath ? 'true' : null,
            onclick: () => select(entry.path),
          }, h('span', null, entry.path), h('small', null, formatFileSize(entry.size)))
        )))
      ),
      h(
        'article',
        { className: 'campaign-memory-content', 'aria-live': 'polite' },
        selected ? h('h2', null, selected.path) : null,
        file.status === 'loading'
          ? renderEmptyMessage('Loading file...', { role: 'status', 'aria-busy': 'true' })
          : file.status === 'error'
            ? renderEmptyMessage(`Unable to load this memory file. ${file.error}`, { role: 'alert' })
            : file.status === 'ready'
              ? h('pre', null, h('code', null, file.content))
              : null
      )
    )
  );
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
