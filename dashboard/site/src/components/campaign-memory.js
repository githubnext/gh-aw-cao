import { h } from '../dom.js';
import { listRepositoryMemory, readRepositoryMemoryFile } from '../data-processor.js';
import { createDebug } from '../debug.js';
import { effect, onCleanup, render, state } from '../reactive.js';
import { bindFactorySources, createFactoryScope } from './factory-elements.js';
import { renderEmptyMessage } from './ui-primitives.js';

const debugCampaignMemory = createDebug('campaign-memory');

/** @typedef {{ campaign: string, campaignName: string }} Campaign */
/** @typedef {{ path: string, oid: string, sha256?: string, size: number }} MemoryFile */
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
  let selectedCampaign = '';

  effect(() => {
    if (source.pending()) {
      root.replaceChildren(renderEmptyMessage('Loading campaign memory...', { role: 'status', 'aria-busy': 'true' }));
      root.setAttribute('aria-busy', 'true');
      return;
    }
    root.removeAttribute('aria-busy');
    if (source.unavailable()) {
      root.replaceChildren(renderEmptyMessage('Campaign memory is unavailable.', { role: 'alert' }));
      return;
    }
    const campaigns = source.rows()
      .map((row) => ({
        campaign: typeof row.campaign === 'string' ? row.campaign : '',
        campaignName: typeof row['campaign-name'] === 'string' ? row['campaign-name'] : '',
      }))
      .filter((campaign) => campaign.campaign && campaign.campaignName);
    if (campaigns.length === 0) {
      root.replaceChildren(renderEmptyMessage('No campaigns are registered.'));
      return;
    }

    const selected = campaigns.find((campaign) => campaign.campaign === selectedCampaign) ?? campaigns[0];
    selectedCampaign = selected.campaign;
    const content = h('div', { className: 'cao-memory-content' });
    const buttons = campaigns.map((campaign) => /** @type {HTMLButtonElement} */ (h(
      'button',
      {
        type: 'button',
        className: 'cao-memory-campaign',
        'aria-current': campaign.campaign === selectedCampaign ? 'true' : null,
      },
      campaign.campaignName
    )));
    /** @param {Campaign} campaign @param {HTMLButtonElement} button */
    const select = (campaign, button) => {
      selectedCampaign = campaign.campaign;
      for (const candidate of buttons) candidate.removeAttribute('aria-current');
      button.setAttribute('aria-current', 'true');
      content.replaceChildren(renderCampaignMemory({
        campaignId: campaign.campaign,
        campaignName: campaign.campaignName,
      }));
    };
    campaigns.forEach((campaign, index) => {
      buttons[index].addEventListener('click', () => select(campaign, buttons[index]));
    });
    select(selected, buttons[campaigns.indexOf(selected)]);

    root.replaceChildren(
      h(
        'aside',
        { className: 'cao-memory-campaigns', 'aria-label': 'Campaigns' },
        h('h2', null, 'Campaigns'),
        h('ul', null, ...buttons.map((button) => h('li', null, button)))
      ),
      content
    );
  }, { signal: scope.signal });

  scope.bind(root);
  return root;
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
