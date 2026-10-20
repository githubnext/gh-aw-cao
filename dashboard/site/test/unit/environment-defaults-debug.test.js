// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const queue = vi.hoisted(() => ({ enqueue: vi.fn(), attach: vi.fn() }));

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

/** @param {string} search */
async function mount(search) {
  const debugFn = vi.fn();
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
  vi.doMock('../../src/data-processor.js', () => ({
    cliQueueAvailable: () => true,
    enqueueCliCommand: queue.enqueue, attachCliCommand: queue.attach, subscribeCanonicalDashboardView: vi.fn()
  }));
  vi.doMock('../../src/notification-service.js', () => ({ publishNotification: vi.fn() }));
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (await vi.importActual('../../src/debug.js'));
    return { ...actual, createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output }) };
  });
  vi.resetModules();
  vi.stubGlobal('__CLI_QUEUE__', true);
  vi.stubGlobal('__LOCAL_CLI_QUEUE__', true);
  const { authoritativeDashboard } = await import('../authoritative-dashboard.js');
  const contract = (await import('../fixtures/governance-contract.json', { with: { type: 'json' } })).default;
  const { setDeclaredCliActions } = await import('../../src/components/cli-actions.js');
  setDeclaredCliActions(authoritativeDashboard.dashboard['cli-actions']);
  const { renderEnvironmentDefaults } = await import('../../src/components/environment-defaults.js');
  const root = renderEnvironmentDefaults({
    pageId: contract.page, title: 'Compiler defaults', sourceNames: [], sources: {}, contextDetails: [],
    elementConfig: { actions: contract.actions }, headingTag: /** @type {const} */ ('h2')
  });
  document.body.append(root);
  return { root, debugFn };
}

/** @param {HTMLElement} root @param {string} name @param {string} value */
function input(root, name, value) {
  const element = /** @type {HTMLInputElement} */ (root.querySelector(`[aria-label="${name}"]`));
  element.value = value;
  element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

/** @param {HTMLElement} root */
async function load(root) {
  input(root, 'Variable scope', 'org');
  input(root, 'Target', 'secret-org-name');
  const button = [...root.querySelectorAll('button')].find((item) => item.textContent === 'Load defaults');
  button?.click();
  await vi.waitFor(() => expect(root.getAttribute('aria-busy')).toBe('false'));
}

describe('environment-defaults debug logging', () => {
  it('is silent without a matching debug query', async () => {
    queue.enqueue.mockReset().mockImplementation(async (/** @type {{ id: string }} */ payload) => ({ id: payload.id }));
    queue.attach.mockReset().mockResolvedValue({ command: { status: 'completed' }, result: { ok: true } });
    const { root, debugFn } = await mount('');
    await load(root);
    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs failure metadata under its predictable category without target or output text', async () => {
    queue.enqueue.mockReset().mockImplementation(async (/** @type {{ id: string }} */ payload) => ({ id: payload.id }));
    queue.attach.mockReset().mockImplementation(async (/** @type {string} */ _id, /** @type {Function} */ out) => {
      out({ stream: 'stdout', data: 'SECRET-OUTPUT' });
      return { command: { status: 'failed' }, result: { ok: false, error: 'SECRET-ERROR' } };
    });
    const { root, debugFn } = await mount('?debug=components:environment-defaults');
    await load(root);
    expect(debugFn).toHaveBeenCalledWith('[cao:components:environment-defaults]', {
      event: 'execute-started', operation: 'get', scope: 'org', dryRun: null
    });
    expect(debugFn).toHaveBeenCalledWith('[cao:components:environment-defaults]', expect.objectContaining({
      event: 'execute-failed', operation: 'get', errorName: 'Error'
    }));
    expect(JSON.stringify(debugFn.mock.calls)).not.toMatch(/SECRET/);
  });
});
