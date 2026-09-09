#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import 'fake-indexeddb/auto'
import { ingestGhAwLogsGeneration } from '../src/data/ingest/coordinator.js'
import { createCanonicalQueries } from '../src/data/queries/index.js'

async function jsonlFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(candidate)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({
          path: path.relative(root, candidate).split(path.sep).join('/'),
          content: await readFile(candidate, 'utf8'),
        })
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

export async function ingestGhAwLogDirectory(contextPath, logDirectory) {
  const context = JSON.parse(await readFile(contextPath, 'utf8'))
  const result = await ingestGhAwLogsGeneration(indexedDB, {
    ...context,
    files: await jsonlFiles(logDirectory),
  })
  const queries = createCanonicalQueries(indexedDB)
  const runs = await queries.runs.list()
  const sessions = (await Promise.all(runs.map((run) => queries.sessions.forRun(String(run.id))))).flat()
  const events = (await Promise.all(sessions.map((session) => queries.events.forSession(String(session.id))))).flat()
  return { result, runs, sessions, events }
}

async function main() {
  const [contextPath, logDirectory] = process.argv.slice(2)
  if (!contextPath || !logDirectory) {
    throw new Error('Usage: ingest-gh-aw-logs.mjs CONTEXT_JSON LOG_DIRECTORY')
  }
  const output = await ingestGhAwLogDirectory(path.resolve(contextPath), path.resolve(logDirectory))
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}
