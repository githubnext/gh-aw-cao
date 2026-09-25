import { h } from '../dom.js';
import { effect, onCleanup, render, state } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';
import { renderEmptyMessage } from './ui-primitives.js';

const CAMPAIGN_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/;

/** @typedef {{ path: string, oid: string, size: number }} MemoryFile */
/** @typedef {{ branch: string, commit: string, files: MemoryFile[] }} CampaignMemory */
/** @typedef {{ status: string, branch: string, commit: string, files: MemoryFile[], error: string }} ManifestState */
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
    status: 'loading', branch: '', commit: '', files: [], error: ''
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

  loadCampaignMemory(campaignId, scope.signal).then((campaign) => {
    if (!campaign) {
      manifestState.set({ status: 'empty', branch: '', commit: '', files: [], error: '' });
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
    loadMemoryFile(campaignId, filePath, controller.signal).then((content) => {
      if (!controller.signal.aborted) fileState.set({ status: 'ready', content, error: '' });
    }).catch((error) => {
      if (error?.name !== 'AbortError') {
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
  if (manifest.status === 'empty' || manifest.files.length === 0) {
    return renderEmptyMessage('No repository memory has been published for this campaign.');
  }
  const selected = manifest.files.find((entry) => entry.path === selectedPath);
  return h(
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
  );
}

/**
 * @param {string} campaignId
 * @param {AbortSignal} signal
 * @returns {Promise<CampaignMemory | null>}
 */
async function loadCampaignMemory(campaignId, signal) {
  if (!CAMPAIGN_PATTERN.test(campaignId)) return null;
  const response = await fetch(new URL('./memory/manifest.json', document.baseURI), {
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(`Manifest request returned ${response.status}.`);
  const manifest = /** @type {{ version?: unknown, campaigns?: unknown }} */ (await response.json());
  if (manifest?.version !== 1 || !Array.isArray(manifest.campaigns)) {
    throw new Error('Repository-memory manifest is invalid.');
  }
  const campaigns = /** @type {Array<Record<string, unknown>>} */ (manifest.campaigns);
  const campaign = campaigns.find((entry) => entry?.campaign === campaignId);
  if (!campaign) return null;
  if (campaign.branch !== `memory/${campaignId}`
      || !/^[0-9a-f]{40,64}$/i.test(campaign.commit)
      || !Array.isArray(campaign.files)) {
    throw new Error('Campaign repository-memory entry is invalid.');
  }
  const files = /** @type {unknown[]} */ (campaign.files).map((entry) => {
    const file = /** @type {Record<string, unknown>} */ (entry);
    return {
      path: safeMemoryPath(file.path),
      size: Number(file.size),
      oid: String(file.oid ?? ''),
    };
  });
  if (files.some((entry) => !entry.path
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || !/^[0-9a-f]{40,64}$/i.test(entry.oid))) {
    throw new Error('Campaign repository-memory file metadata is invalid.');
  }
  return { branch: String(campaign.branch), commit: String(campaign.commit), files };
}

/** @param {string} campaignId @param {string} filePath @param {AbortSignal} signal */
async function loadMemoryFile(campaignId, filePath, signal) {
  const safePath = safeMemoryPath(filePath);
  if (!CAMPAIGN_PATTERN.test(campaignId) || !safePath) throw new Error('Memory file path is invalid.');
  const memoryRoot = new URL('./memory/', document.baseURI);
  const campaignRoot = new URL(`${encodeURIComponent(campaignId)}/`, memoryRoot);
  const fileUrl = new URL(safePath.split('/').map(encodeURIComponent).join('/'), campaignRoot);
  if (fileUrl.origin !== memoryRoot.origin || !fileUrl.href.startsWith(campaignRoot.href)) {
    throw new Error('Memory file path is invalid.');
  }
  const response = await fetch(fileUrl, { cache: 'no-store', credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`File request returned ${response.status}.`);
  return response.text();
}

/** @param {unknown} value */
function safeMemoryPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) return '';
  const segments = value.split('/');
  return segments.some((segment) => !segment || segment === '.' || segment === '..') ? '' : value;
}

/** @param {number} bytes */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
