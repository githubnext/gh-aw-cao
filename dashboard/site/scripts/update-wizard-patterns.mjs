import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { parsePromptWizard } from '../src/prompt-wizard.js';
import octiconNames from '../src/octicon-names.json' with { type: 'json' };

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
const outputIds = new Set([
  ...Object.entries(generation.outputs).filter(([, definition]) => !definition.alias).map(([id]) => id),
  ...fields.get('outputs').options.filter((option) => !Object.hasOwn(generation.outputs, option.value)).map((option) => option.value)
]);
const patterns = [];
for (let start = 0; start < manifest.archetypes.length; start += 6) {
  patterns.push(...await Promise.all(manifest.archetypes.slice(start, start + 6).map(async (id) => {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid upstream archetype identifier.');
    const pattern = await fetchJson(`patterns/archetypes/${id}.json`);
    if (pattern.id !== id || typeof pattern.label !== 'string' || !Array.isArray(pattern.tips)
      || !Array.isArray(pattern.recommended_tools) || pattern.recommended_tools.some((tool) => typeof tool !== 'string')) {
      throw new Error(`Invalid upstream archetype: ${id}`);
    }
    const unsupported = pattern.recommended_tools.filter((tool) => !outputIds.has(tool));
    if (unsupported.length) throw new Error(`Declare safe-output choices for ${id}: ${unsupported.join(', ')}`);
    return {
      value: id, label: pattern.label,
      defaults: { outputs: [...new Set(pattern.recommended_tools)] },
      summary: pattern.description,
      icon: octiconNames.includes(generation.archetypes?.[id]?.icon) ? generation.archetypes[id].icon : 'workflow',
      description: [pattern.description, ...pattern.tips].join('\n'),
      context: { pattern, generation: generation.archetypes?.[id] ?? null }
    };
  })));
}
fields.get('pattern').options = [
  { value: 'custom', label: 'Custom automation', summary: 'Design an automation from your own requirements.', icon: 'sparkle', description: 'Start from your own requirements.', defaults: { outputs: [] } }, ...patterns
];
for (const [field, definitions] of [['triggers', generation.triggers], ['outputs', generation.outputs], ['extras', generation.extras]]) {
  const authored = new Map((field === 'extras' ? fields.get(field).options : []).map((option) => [option.value, option]));
  const extensions = field === 'outputs' ? fields.get(field).options.filter((option) => !Object.hasOwn(definitions, option.value)) : [];
  fields.get(field).options = [...Object.entries(definitions).filter(([, definition]) => !definition.alias).map(([value, context]) => ({
    value, label: authored.get(value)?.label ?? value.replaceAll('_', ' ').replaceAll('-', ' '),
    description: authored.get(value)?.description ?? context.description ?? context.requirement ?? value,
    ...(field === 'extras' ? { instructions: context.requirement }
      : field === 'outputs' ? { instructions: `Use the \`${context.safe_output ?? value}\` safe output to ${context.description}.` } : {}),
    context
  })), ...extensions];
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
