import { h } from '../dom.js';
import { effect, onCleanup, render, state } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';
import { renderEmptyMessage } from './ui-primitives.js';

const CAMPAIGN_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/;
const ALLOWED_EXTENSIONS = new Set(['.json', '.jsonl', '.md', '.txt', '.yaml', '.yml']);
const MAX_FILE_COUNT = 400;
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_NESTING = 10;

/** @typedef {{ path: string, oid: string, sha256?: string, size: number }} MemoryFile */
/** @typedef {{ fileLimit: number, fileSize: number, extension: number, nesting: number, unsafePath: number, unsupportedType: number }} OmittedFiles */
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

  loadCampaignMemory(campaignId, scope.signal).then((campaign) => {
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
      || typeof campaign.commit !== 'string'
      || !/^[0-9a-f]{40,64}$/i.test(campaign.commit)
      || !Array.isArray(campaign.files)
      || campaign.files.length > MAX_FILE_COUNT) {
    throw new Error('Campaign repository-memory entry is invalid.');
  }
  const files = /** @type {unknown[]} */ (campaign.files).map((entry) => {
    const file = /** @type {Record<string, unknown>} */ (entry);
    return {
      path: safeMemoryPath(file.path),
      size: Number(file.size),
      oid: String(file.oid ?? ''),
      sha256: file.sha256 === undefined ? undefined : String(file.sha256),
    };
  });
  if (files.some((entry) => !entry.path
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || entry.size > MAX_FILE_SIZE
      || !/^[0-9a-f]{40,64}$/i.test(entry.oid)
      || (entry.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(entry.sha256)))) {
    throw new Error('Campaign repository-memory file metadata is invalid.');
  }
  const omitted = parseOmissions(campaign.omitted);
  return { branch: String(campaign.branch), commit: String(campaign.commit), files, omitted };
}

function emptyOmissions() {
  return { fileLimit: 0, fileSize: 0, extension: 0, nesting: 0, unsafePath: 0, unsupportedType: 0 };
}

/** @param {unknown} value */
function parseOmissions(value) {
  const source = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
  const omitted = emptyOmissions();
  for (const key of Object.keys(omitted)) {
    const count = source[key] ?? 0;
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      throw new Error('Campaign repository-memory omission metadata is invalid.');
    }
    omitted[/** @type {keyof OmittedFiles} */ (key)] = Number(count);
  }
  return omitted;
}

/** @param {OmittedFiles} omitted */
function renderOmissionWarning(omitted) {
  const reasons = [
    ['fileLimit', 'the file-count limit'],
    ['fileSize', 'the file-size limit'],
    ['extension', 'unsupported file extensions'],
    ['nesting', 'the nesting limit'],
    ['unsafePath', 'unsafe paths'],
    ['unsupportedType', 'unsupported file types'],
  ].flatMap(([key, label]) => omitted[/** @type {keyof OmittedFiles} */ (key)] > 0
    ? [`${omitted[/** @type {keyof OmittedFiles} */ (key)]} excluded by ${label}`]
    : []);
  return reasons.length > 0
    ? h('p', { className: 'campaign-memory-warning', role: 'status' },
      `This view does not represent the entire memory branch: ${reasons.join(', ')}.`)
    : null;
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
  return readBoundedText(response, MAX_FILE_SIZE);
}

/** @param {unknown} value */
function safeMemoryPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')) return '';
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return '';
  if (segments.length - 1 > MAX_NESTING) return '';
  const extensionIndex = segments.at(-1)?.lastIndexOf('.') ?? -1;
  const extension = extensionIndex >= 0 ? segments.at(-1)?.slice(extensionIndex).toLowerCase() : '';
  return extension && ALLOWED_EXTENSIONS.has(extension) ? value : '';
}

/** @param {Response} response @param {number} maximumBytes */
async function readBoundedText(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('Memory file exceeds the published size limit.');
  }
  if (!response.body) {
    const content = await response.arrayBuffer();
    if (content.byteLength > maximumBytes) throw new Error('Memory file exceeds the published size limit.');
    return new TextDecoder().decode(content);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let content = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error('Memory file exceeds the published size limit.');
      content += decoder.decode(value, { stream: true });
    }
    return content + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** @param {number} bytes */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
