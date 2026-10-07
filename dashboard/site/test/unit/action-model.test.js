import { describe, expect, it } from 'vitest';
import { ACTION_LEVELS, actionIcon, actionPresentation, constrainPrompt, normalizeAction, normalizeViewAction } from '../../src/action-model.js';
import { semanticViewPrompt } from '../../src/semantic-view-prompt.js';
import { validateDashboardDocument } from '../../src/validator.js';
import { authoritativeDashboardSource } from '../authoritative-dashboard.js';

describe('declarative action levels', () => {
  it.each(ACTION_LEVELS)('accepts %s on dashboard CLI actions regardless of executor', (level) => {
    const document = JSON.parse(authoritativeDashboardSource);
    document.dashboard['cli-actions'][0].level = level;
    if (level === 'explore') {
      document.dashboard['cli-actions'][0].command = 'gh aw status';
      delete document.dashboard['cli-actions'][0].arguments;
    }
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
    expect(normalizeAction(document.dashboard['cli-actions'][0], { id: 'test', type: 'cli' }).level).toBe(level);
  });

  it('rejects mutating CLI commands declared as read-only exploration', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    document.dashboard['cli-actions'][0].level = 'explore';
    const result = validateDashboardDocument(JSON.stringify(document));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Explore CLI actions must use a supported read-only command.' })
    ]));
    /** @param {any} node @returns {any} */
    const findRowCli = (node) => {
      if (!node || typeof node !== 'object') return null;
      if (node.presentation === 'cli-action') return node;
      for (const child of Object.values(node)) {
        const found = findRowCli(child);
        if (found) return found;
      }
      return null;
    };
    const rowAction = findRowCli(document);
    rowAction.level = 'explore';
    expect(validateDashboardDocument(JSON.stringify(document)).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Explore CLI actions must use a supported read-only command.' })
    ]));
  });

  it('rejects invalid CLI and generated view levels', () => {
    const document = JSON.parse(authoritativeDashboardSource);
    document.dashboard['cli-actions'][0].level = 'dangerous';
    const page = document.dashboard.pages.find((/** @type {{ views?: unknown[] }} */ candidate) => candidate.views?.length);
    page.views[0]['prompt-level'] = 'dangerous';
    const result = validateDashboardDocument(JSON.stringify(document));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.path.endsWith('.level'))).toBe(true);
    expect(result.errors.some((error) => error.path.endsWith('.prompt-level'))).toBe(true);
  });

  it.each(['explore', 'propose', 'operate'])('validates a declared row prompt at %s', (level) => {
    const document = JSON.parse(authoritativeDashboardSource);
    /** @param {any} node @returns {any} */
    const visit = (node) => {
      if (!node || typeof node !== 'object') return null;
      if (node.presentation === 'copy-prompt') return node;
      for (const child of Object.values(node)) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    const prompt = visit(document);
    expect(prompt).toBeTruthy();
    prompt.level = level;
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
    if (level === 'propose') {
      delete prompt.label;
      delete prompt.level;
      expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(true);
    }
    prompt.level = 'invalid';
    expect(validateDashboardDocument(JSON.stringify(document)).ok).toBe(false);
  });

  it('normalizes explicit prompt, CLI and generated view actions without coupling level to type', () => {
    for (const type of /** @type {const} */ (['prompt', 'cli'])) {
      for (const level of ACTION_LEVELS) {
        expect(normalizeAction({ level }, { id: 'test', type })).toMatchObject({
          id: 'test', level, type, source: 'explicit'
        });
      }
    }
    const view = normalizeViewAction({ id: 'cost' }, { subject: 'Cost', objective: 'Reduce cost', acceptance: 'Evidence' });
    expect(view).toMatchObject({ id: 'cost-prompt', source: 'view', type: 'prompt', level: 'propose',
      subject: 'Cost', objective: 'Reduce cost', acceptance: 'Evidence' });
    expect(normalizeViewAction({ 'prompt-level': 'explore' }, { subject: '', objective: '', acceptance: '' }).level).toBe('explore');
    expect(normalizeAction({}, { id: 'old', type: 'cli' }).level).toBe('operate');
    expect(normalizeAction({}, { id: 'old', type: 'prompt' }).level).toBe('propose');
    expect(normalizeAction({}, { id: 'old', type: 'link' }).level).toBe('explore');
  });

  it('keeps read-only investigation separate from proposals in generated prompts', () => {
    const context = { semantics: { queryIds: [], subject: 'Cost', objective: 'Explain spike', acceptance: 'Cite runs' },
      queryParameters: {}, filters: {}, scope: {}, sources: {} };
    const explore = semanticViewPrompt({ ...context, level: 'explore' });
    expect(explore).toContain('Read-only investigation only');
    expect(explore).not.toContain('Create a PR with the changes.');
    expect(constrainPrompt('Investigate failure', 'explore')).toContain('Do not modify repositories');
    expect(semanticViewPrompt({ ...context, level: 'propose' })).toContain('Create a PR with the changes.');
  });

  it('resolves semantic icons and concrete verbs with deterministic fallback and visible labels', () => {
    expect(ACTION_LEVELS.map((level) => actionIcon(level))).toEqual(['search', 'git-pull-request', 'zap']);
    expect(actionIcon('operate', 'refresh')).toBe('sync');
    expect(actionIcon('operate', 'delete')).toBe('trash');
    expect(actionIcon('operate', 'retry')).toBe('play');
    expect(actionIcon('operate', 'unknown')).toBe('zap');
    expect(actionPresentation(normalizeAction({ level: 'explore' }, { id: 'test', type: 'prompt' })).label).toBe('Investigate');
    expect(actionPresentation(normalizeAction({ level: 'propose' }, { id: 'test', type: 'cli' })).label).toBe('Propose fix');
    expect(actionPresentation(normalizeAction({ level: 'operate', label: 'Refresh data' }, { id: 'test', type: 'cli' })))
      .toMatchObject({ label: 'Refresh data', confirmation: true });
  });
});
