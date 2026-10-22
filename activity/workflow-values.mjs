#!/usr/bin/env node
// Reviewed local collectors export definition and collectValueEvidence(request).
// request.workspace = { directory, scratch }: durable acquisition proofs and disposable scratch.
// The return value is the original schema-v2 operational_value_evidence envelope.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPolicyFile } from '../.github/workflows/shared/policy.mjs';
import { validateOperationalValueEvidence } from '../dashboard/site/src/data/model/operational-value-evidence.js';
import { assertValueHistory } from './workflow-value-history.mjs';

export { assertValueHistory } from './workflow-value-history.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const DAY = 86400000;
const modulePath = new URL(import.meta.url);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export async function confinedCollector(root, collector) {
  if (typeof collector !== 'string' || !/^[A-Za-z0-9._/-]+\.mjs$/.test(collector)
    || collector.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Collector must be a confined repository-relative .mjs path');
  }
  let current = path.resolve(root);
  for (const part of collector.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Collector symlinks are forbidden');
  }
  if (!(await lstat(current)).isFile()) throw new Error('Collector must be a regular file');
  return current;
}

export function workflowValueRegistrations(document, repositories) {
  const control = document['control-plane'];
  if (!control) throw new Error('Control policy is required');
  const activity = control.campaigns?.activity;
  if (activity?.enabled === false) return [];
  const enrolled = control.activity?.repositories ?? [];
  const scope = control.scope ?? {};
  return (activity?.['workflow-values'] ?? []).filter((entry) =>
    entry.enabled !== false
    && repositories.some((repository) => same(repository, entry.repository))
    && enrolled.some((repository) => same(repository, entry.repository))
    && (!scope['allowed-repositories'] || scope['allowed-repositories'].some((repository) => same(repository, entry.repository)))
    && (!scope['allowed-owners'] || scope['allowed-owners'].some((owner) => same(owner, entry.repository.split('/')[0]))));
}

export async function collectWorkflowValue(request) {
  const filename = await confinedCollector(request.root, request.entry.collector);
  const { definition, collectValueEvidence } = await import(pathToFileURL(filename).href);
  const { repository, workflow } = request.entry;
  const cadence = definition?.evidence?.window?.cadenceDays;
  const adoption = Date.parse(definition?.adoption?.adoptedAt);
  const maturation = definition?.evidence?.window?.maturationDays;
  if (definition?.schemaVersion !== 3 || !same(definition?.repository, repository) || definition?.slug !== workflow
    || definition?.sourcePath !== `.github/workflows/${workflow}.md`
    || !Array.isArray(definition?.evidence?.repositories) || !definition.evidence.repositories.length
    || definition.evidence.repositories.some((target) => !same(target, repository))
    || !Number.isFinite(adoption) || !Number.isSafeInteger(maturation) || maturation < 0
    || !Number.isSafeInteger(cadence) || cadence <= 0 || typeof collectValueEvidence !== 'function') {
    throw new Error('Collector must export an exact frozen definition and collectValueEvidence');
  }
  const previous = request.previous;
  if (previous) {
    validateOperationalValueEvidence(previous);
    const header = previous.facts.find((fact) => fact['fact-kind'] === 'contract');
    if (header['cadence-days'] !== cadence) throw new Error('Frozen cadence changed');
    const dueCutoff = adoption + Math.floor((Date.parse(request.observedAt) - maturation * DAY - adoption) / (cadence * DAY)) * cadence * DAY;
    const complete = previous.facts.some((fact) => fact['fact-kind'] === 'coverage'
      && fact['coverage-status'] === 'complete' && Date.parse(fact.at) <= dueCutoff - cadence * DAY
      && Date.parse(fact['end-at']) >= dueCutoff);
    if (Date.parse(previous.windowEnd) >= dueCutoff && complete) return null;
  }
  await mkdir(request.workspace, { recursive: true });
  if ((await lstat(request.workspace)).isSymbolicLink()) throw new Error('Evidence workspace symlinks are forbidden');
  const scratch = await mkdtemp(path.join(request.workspace, '.scratch-'));
  try {
    const envelope = await collectValueEvidence({
      repository, workflow, observedAt: request.observedAt, database: request.database,
      previous, workspace: { directory: request.workspace, scratch },
    });
    if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_BYTES || envelope?.schema_version !== 2
      || envelope?.kind !== 'operational_value_evidence'
      || Object.keys(envelope).sort().join(',') !== 'kind,operational_value_evidence,schema_version') {
      throw new Error('Collector must return one bounded original evidence envelope');
    }
    const packet = validateOperationalValueEvidence(envelope.operational_value_evidence);
    const contract = packet.facts.find((fact) => fact['fact-kind'] === 'contract');
    if (!same(packet.repository, repository) || packet.workflow !== workflow
      || Date.parse(packet.observedAt) > Date.now()
      || Date.parse(packet.windowEnd) > Date.parse(request.observedAt)
      || contract['cadence-days'] !== cadence) throw new Error('Collector evidence identity or frozen cadence mismatch');
    const coverage = packet.facts.filter((fact) => fact['fact-kind'] === 'coverage');
    if (coverage.some((fact) => fact['coverage-status'] !== 'complete')) throw new Error('Collection incomplete; retaining last accepted evidence');
    assertValueHistory(previous, packet);
    return envelope;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function readPrevious(filename) {
  try {
    return (await readFile(filename, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function executeCollector(request, timeout) {
  return new Promise((resolve) => {
    // Hosted Go owns the encompassing process group; Actions owns this worker's
    // separate group so a timed-out git/gh descendant cannot outlive collection.
    const detached = process.platform !== 'win32' && process.env.CAO_WORKFLOW_VALUE_SHARED_PROCESS_GROUP !== '1';
    const child = spawn(process.execPath, [modulePath.pathname, '--worker'], {
      detached, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
    });
    const chunks = [];
    let bytes = 0, errors = 0, failed = false;
    const terminate = () => {
      try {
        if (child.pid) process.kill(detached ? -child.pid : child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') failed = true;
      }
    };
    const timer = setTimeout(() => { failed = true; terminate(); }, timeout);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { failed = true; terminate(); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk.length;
      if (errors > 16384) { failed = true; terminate(); }
    });
    child.on('error', () => { failed = true; });
    child.on('close', (status) => {
      clearTimeout(timer);
      terminate();
      resolve({ status: failed ? -1 : status, stdout: Buffer.concat(chunks).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

export async function runWorkflowValues(options) {
  const policy = loadPolicyFile(options.policy);
  const entries = workflowValueRegistrations(policy, options.repositories);
  const retained = await readPrevious(options.previous ?? options.output);
  const result = { collected: 0, skipped: 0, warnings: [] };
  const fresh = [];
  let freshBytes = 0;
  for (const entry of entries) {
    const reserve = Number(process.env.CAO_GITHUB_API_MIN_REMAINING
      ?? Math.abs(Number(process.env.REPORT_MAX_GITHUB_API_RATE_LIMIT ?? 0)));
    if (reserve > 0) {
      const budget = spawnSync('gh', ['api', 'rate_limit', '--jq', '.resources.core.remaining'], {
        encoding: 'utf8', timeout: 30000, maxBuffer: 16384, env: process.env,
      });
      const remaining = Number(budget.stdout?.trim());
      if (budget.status !== 0 || !budget.stdout?.trim() || !Number.isSafeInteger(remaining) || remaining <= reserve) {
        result.warnings.push(`${entry.repository}/${entry.workflow}: API budget unavailable or exhausted; previous evidence retained`);
        continue;
      }
    }
    const previous = retained.filter((envelope) => envelope.kind === 'operational_value_evidence'
      && same(envelope.operational_value_evidence?.repository, entry.repository)
      && envelope.operational_value_evidence?.workflow === entry.workflow)
      .map((envelope) => envelope.operational_value_evidence)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    const identity = createHash('sha256').update(`${entry.repository.toLowerCase()}:${entry.workflow}`).digest('hex');
    const request = {
      root: path.resolve(options.root), entry, previous,
      observedAt: options.observedAt ?? new Date().toISOString(), database: options.database,
      workspace: path.resolve(options.workspace, identity),
    };
    const child = await executeCollector(request, options.timeout ?? 600000);
    try {
      for (const entry of await readdir(request.workspace)) {
        if (entry.startsWith('.scratch-')) await rm(path.join(request.workspace, entry), { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (child.status !== 0 || child.error) {
      result.warnings.push(`${entry.repository}/${entry.workflow}: collector failed, incomplete or budget exhausted; previous evidence retained`);
      continue;
    }
    try {
      const envelope = JSON.parse(child.stdout);
      if (envelope) {
        validateOperationalValueEvidence(envelope.operational_value_evidence);
        freshBytes += Buffer.byteLength(child.stdout);
        if (freshBytes > MAX_BATCH_BYTES) {
          result.warnings.push('Workflow Value batch evidence budget exhausted; remaining accepted evidence retained');
          break;
        }
        fresh.push(envelope);
        result.collected++;
      } else result.skipped++;
    } catch {
      result.warnings.push(`${entry.repository}/${entry.workflow}: invalid collector output; previous evidence retained`);
    }
  }
  if (!fresh.length && !options.previous) return result;
  await mkdir(path.dirname(options.output), { recursive: true });
  // Packets are cumulative: compact superseded captures, never accepted facts.
  const latest = new Map();
  for (const envelope of [...retained, ...fresh]) {
    const key = envelope.operational_value_evidence?.id;
    const previous = latest.get(key)?.operational_value_evidence;
    if (!previous || Date.parse(previous.observedAt) <= Date.parse(envelope.operational_value_evidence.observedAt)) latest.set(key, envelope);
  }
  const output = options.previous ? fresh : [...latest.values()];
  const staged = `${options.output}.pending`;
  await writeFile(staged, output.map((value) => JSON.stringify(value)).join('\n') + (output.length ? '\n' : ''), { mode: 0o600 });
  await rename(staged, options.output);
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv[2] === '--worker') {
      let content = '';
      for await (const chunk of process.stdin) {
        content += chunk;
        if (Buffer.byteLength(content) > MAX_BYTES + 64 * 1024) throw new Error('Worker input exceeds budget');
      }
      process.stdout.write(JSON.stringify(await collectWorkflowValue(JSON.parse(content))));
    } else if (process.argv[2] === '--registrations') {
      const document = loadPolicyFile(process.argv[3]);
      const entries = document['control-plane']?.campaigns?.activity?.['workflow-values'] ?? [];
      process.stdout.write(JSON.stringify(workflowValueRegistrations(document, entries.map((entry) => entry.repository))));
    } else {
      const options = { repositories: [] };
      for (let i = 2; i < process.argv.length; i += 2) {
        const key = process.argv[i].slice(2), value = process.argv[i + 1];
        if (!value || !['root', 'policy', 'database', 'output', 'workspace', 'repository', 'previous', 'observedAt'].includes(key)) throw new Error('Invalid workflow-values option');
        if (key === 'repository') options.repositories.push(value);
        else options[key] = value;
      }
      const result = await runWorkflowValues(options);
      for (const warning of result.warnings) process.stderr.write(`::warning::${warning}\n`);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch {
    process.stderr.write('Workflow Value collection failed; existing evidence retained\n');
    process.exitCode = 1;
  }
}
