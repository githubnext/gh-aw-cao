import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { parsePromptWizard } from '../src/prompt-wizard.js';

const run = promisify(execFile);
const repository = 'githubnext/gh-aw-wizard';
const revision = process.argv[2] ?? '2e1f1d62adcbfa68fd6abab65eb9372af50a8ba5';
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Supply an immutable 40-character upstream commit SHA.');
const path = new URL('../dashboard-fragments/wizard.json', import.meta.url);
const document = JSON.parse(await readFile(path, 'utf8'));
const wizard = document.pages[0].views[0].config.wizard;
const fields = new Map(wizard.steps.flatMap((step) => step.fields).map((field) => [field.id, field]));
const fetchText = async (file) => {
  const { stdout } = await run('gh', ['api', `repos/${repository}/contents/${file}?ref=${revision}`], { maxBuffer: 2_000_000 });
  const response = JSON.parse(stdout);
  if (response.encoding !== 'base64') throw new Error(`Unsupported upstream encoding: ${file}`);
  return Buffer.from(response.content, 'base64').toString('utf8');
};
const fetchJson = async (file) => JSON.parse(await fetchText(file));
const [manifest, generation, license] = await Promise.all([
  fetchJson('patterns/manifest.json'), fetchJson('patterns/workflow-generation.json'), fetchText('LICENSE')
]);
const patterns = [];
for (let start = 0; start < manifest.archetypes.length; start += 6) {
  patterns.push(...await Promise.all(manifest.archetypes.slice(start, start + 6).map(async (id) => {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid upstream archetype identifier.');
    const pattern = await fetchJson(`patterns/archetypes/${id}.json`);
    if (pattern.id !== id || typeof pattern.label !== 'string' || !Array.isArray(pattern.tips)) {
      throw new Error(`Invalid upstream archetype: ${id}`);
    }
    return {
      value: id, label: pattern.label,
      description: [pattern.description, ...pattern.tips].join('\n'),
      context: { pattern, generation: generation.archetypes?.[id] ?? null }
    };
  })));
}
fields.get('pattern').options = [
  { value: 'custom', label: 'Custom automation', description: 'Start from your own requirements.' }, ...patterns
];
for (const [field, definitions] of [['triggers', generation.triggers], ['outputs', generation.outputs], ['extras', generation.extras]]) {
  fields.get(field).options = Object.entries(definitions).filter(([, definition]) => !definition.alias).map(([value, context]) => ({
    value, label: value.replaceAll('_', ' ').replaceAll('-', ' '),
    description: context.description ?? value, context
  }));
}
wizard.provenance = {
  repository, revision,
  url: `https://github.com/${repository}/tree/${revision}/patterns`,
  'generated-at': manifest.metadata.generated_at,
  'source-repositories': manifest.metadata.source_repos,
  'total-workflows': manifest.metadata.total_workflows,
  notice: 'Patterns are mined historical observations, not recommendations to grant permissions or predictions of success.',
  license
};
parsePromptWizard(wizard);
await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Updated ${patterns.length} wizard patterns from ${repository}@${revision}.`);
