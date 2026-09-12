// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderCliActions, renderRowCliAction, setDeclaredCliActions } from '../../src/components/cli-actions.js';

afterEach(() => {
  vi.unstubAllGlobals();
  setDeclaredCliActions([]);
});

describe('CLI actions', () => {
  it('renders update actions with repository and pull-request creation', () => {
    const rendered = renderCliActions([{
      id: 'update-repository',
      label: 'Update repository',
      icon: 'sync',
      command: 'gh aw update --repo {{repository}}',
      arguments: [{
        id: 'create-pull-request',
        label: 'Create pull request',
        type: 'boolean',
        flag: '--create-pull-request',
        default: true
      }]
    }], {
      presentation: 'settings',
      templateValues: { repository: 'octo/example' }
    });
    rendered?.querySelector('.cli-action-trigger')?.dispatchEvent(new MouseEvent('click'));
    expect(rendered?.querySelector('.cli-action-command')?.textContent)
      .toBe('gh aw update --repo octo/example --create-pull-request');
  });

  it('renders settings actions as settings-menu buttons', () => {
    const rendered = renderCliActions([{
      id: 'upgrade-repository',
      label: 'Upgrade repository',
      icon: 'download',
      command: 'gh aw upgrade --repo {{repository}}',
      arguments: [{
        id: 'create-pull-request',
        label: 'Create pull request',
        type: 'boolean',
        flag: '--create-pull-request',
        default: true
      }]
    }], {
      presentation: 'settings',
      templateValues: { repository: 'octo/example' }
    });

    it('copies commands instead of executing them outside canvas', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText }
      });
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const rendered = renderCliActions([{
        id: 'compile-workflows',
        label: 'Compile workflows',
        icon: 'play',
        command: 'gh aw compile --strict',
        arguments: [{
          id: 'pre-releases',
          label: 'Include pre-releases',
          type: 'boolean',
          flag: '--pre-releases',
          default: true
        }]
      }], { canExecute: false });
      document.body.append(/** @type {HTMLElement} */ (rendered));

      rendered?.querySelector('.cli-action-trigger')?.dispatchEvent(new MouseEvent('click'));
      expect(rendered?.querySelector('.cli-action-dialog-body p')?.textContent)
        .toBe('Copy this command and run it in your terminal.');
      expect(rendered?.querySelector('.cli-action-output')).toBeNull();
      rendered?.querySelector('.cli-action-confirm')?.dispatchEvent(new MouseEvent('click'));

      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('gh aw compile --strict --pre-releases'));
      expect(fetch).not.toHaveBeenCalled();
      expect(rendered?.querySelector('.cli-action-status')?.textContent).toBe('Command copied.');
    });
    expect(rendered?.classList.contains('cli-actions-settings')).toBe(true);
    expect(rendered?.querySelector('.cli-action-trigger')?.classList.contains('account-menu-action')).toBe(true);
    rendered?.querySelector('button')?.click();
    const checkbox = /** @type {HTMLInputElement} */ (
      rendered?.querySelector('.cli-action-argument input')
    );
    expect(checkbox.checked).toBe(true);
    expect(rendered?.querySelector('.cli-action-command')?.textContent)
      .toBe('gh aw upgrade --repo octo/example --create-pull-request');
  });

  it('requires a fresh confirmation before every execution', async () => {
    const streamingBody = () => {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"output","stream":"stdout","data":"comp"}\n'));
          controller.enqueue(encoder.encode('{"type":"output","stream":"stdout","data":"iled\\n"}\n'));
          controller.enqueue(encoder.encode('{"type":"complete","result":{"ok":true,"exitCode":0,"stdout":"","stderr":""}}\n'));
          controller.close();
        }
      });
    };
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: streamingBody()
    });
    vi.stubGlobal('fetch', fetch);
    const rendered = renderCliActions([{
      id: 'compile-workflows',
      label: 'Compile workflows',
      description: 'Validate workflows.',
      icon: 'play',
      command: 'gh aw compile --strict',
      arguments: [{
        id: 'pre-releases',
        label: 'Include pre-releases',
        type: 'boolean',
        flag: '--pre-releases',
        default: false
      }]
    }]);
    expect(rendered).not.toBeNull();
    const root = /** @type {HTMLElement} */ (rendered);
    document.body.append(root);
    const trigger = /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-trigger'));
    const confirm = /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-confirm'));
    const cancel = /** @type {HTMLButtonElement} */ (root.querySelector('.cli-action-cancel'));

    trigger.click();
    expect(fetch).not.toHaveBeenCalled();
    expect(root.querySelector('.cli-action-dialog')?.hasAttribute('open')).toBe(true);
    expect(root.querySelector('.cli-action-command')?.textContent).toBe('gh aw compile --strict');
    const checkbox = /** @type {HTMLInputElement} */ (root.querySelector('.cli-action-argument input'));
    checkbox.click();
    expect(root.querySelector('.cli-action-command')?.textContent)
      .toBe('gh aw compile --strict --pre-releases');

    confirm.click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      id: 'compile-workflows',
      arguments: { 'pre-releases': true }
    });
    await vi.waitFor(() => expect(root.querySelector('.cli-action-output')?.textContent).toBe('compiled\n'));

    cancel.click();
    trigger.click();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(checkbox.checked).toBe(false);
    expect(root.querySelector('.cli-action-command')?.textContent).toBe('gh aw compile --strict');
    fetch.mockResolvedValueOnce({ ok: true, body: streamingBody() });
    confirm.click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it('renders a row action command with repository context', () => {
    setDeclaredCliActions([{
      id: 'update-target-repository',
      label: 'Update repository',
      icon: 'sync',
      command: 'gh aw update --repo {{repository}}'
    }]);
    const rendered = renderRowCliAction('update-target-repository', { repository: 'octo/example' });
    expect(rendered).not.toBeNull();
    if (!rendered) return;
    document.body.append(rendered);

    rendered.querySelector('button')?.click();

    expect(rendered.querySelector('.cli-action-command')?.textContent)
      .toBe('gh aw update --repo octo/example');
    expect(rendered.querySelector('.table-cli-action-button .octicon-sync')).not.toBeNull();
  });
});
