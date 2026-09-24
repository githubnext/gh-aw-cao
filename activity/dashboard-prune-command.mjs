import { readFile, readdir, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pruneDashboardDocument } from './dashboard-prune.mjs';

export async function pruneDashboardFile({ inputPath, outputPath } = {}) {
  let document;
  try {
    document = JSON.parse(await readFile(path.resolve(inputPath), 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${inputPath} contains invalid JSON: ${error.message}`);
    }
    throw error;
  }
  const result = pruneDashboardDocument(document, {
    linkedPageIds: await discoverStaticDashboardPageLinks(path.dirname(path.resolve(inputPath)))
  });
  if (outputPath) await writeJsonAtomically(outputPath, result.document);
  return {
    command: 'prune-dashboard',
    input: inputPath,
    ...(outputPath ? { output: outputPath } : {}),
    ...result.report
  };
}

async function discoverStaticDashboardPageLinks(dashboardDirectory) {
  const sourceDirectory = path.join(dashboardDirectory, 'src');
  const links = new Set();
  const pending = [sourceDirectory];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || (!entry.name.endsWith('.js') && !entry.name.endsWith('.json'))) continue;
      const source = await readFile(entryPath, 'utf8');
      for (const match of source.matchAll(/#page-([a-z0-9-]+)/gi)) links.add(match[1]);
      for (const match of source.matchAll(/\b\w+Tab\(\s*['"]([a-z0-9-]+)['"]/gi)) links.add(match[1]);
      if (entry.name.endsWith('.json')) {
        for (const match of source.matchAll(/"page"\s*:\s*"([a-z0-9-]+)"/gi)) links.add(match[1]);
      }
    }
  }
  return links;
}

async function writeJsonAtomically(filePath, document) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
