import { readFile, readdir } from 'node:fs/promises';
import octiconNames from '../src/octicon-names.json' with { type: 'json' };
import { OCTICON_SPRITE } from '../src/octicon-sprite.js';

const inlineNames = new Set(
  [...OCTICON_SPRITE.matchAll(/<symbol id="octicon-([^"]+)"/g)].map((match) => match[1])
);
const supportedNames = new Set(octiconNames);
const errors = [];

for (const name of supportedNames) {
  if (!inlineNames.has(name)) errors.push(`Octicon "${name}" is not inlined in JavaScript.`);
}
for (const name of inlineNames) {
  if (!supportedNames.has(name)) errors.push(`Inlined Octicon "${name}" is not a supported Octicon.`);
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...await sourceFiles(url));
    else if (entry.name.endsWith('.js')) files.push(url);
  }
  return files;
}

for (const sourceFile of await sourceFiles(new URL('../src/', import.meta.url))) {
  const source = await readFile(sourceFile, 'utf8');
  for (const match of source.matchAll(/\bocticon\(\s*['"]([^'"]+)['"]/g)) {
    const name = match[1];
    if (name !== 'issue' && !inlineNames.has(name)) {
      errors.push(`${sourceFile.pathname} references Octicon "${name}" without an inline glyph.`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Validated ${inlineNames.size} JavaScript-inlined Octicons.`);
}
