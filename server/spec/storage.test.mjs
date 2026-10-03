import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile, getNamespaceFullName, navigateProgram, NodeHost } from '@typespec/compiler';
import { PRUNED_CANONICAL_FIELDS } from '../../dashboard/site/src/data/model/fields.js';

const program = await compile(NodeHost, new URL('storage.tsp', import.meta.url).pathname, { noEmit: true });
assert.deepEqual(program.diagnostics, []);
const tables = new Map();
navigateProgram(program, {
  model(model) {
    if (getNamespaceFullName(model.namespace) === 'Cao.Postgres') {
      for (const property of model.properties.values()) {
        assert.notEqual(property.type.name, 'unknown', `${model.name}.${property.name} must be a typed field`);
      }
      tables.set(`$${model.name}`, new Set(model.properties.keys()));
    }
  }
});
const definitions = JSON.parse(readFileSync(new URL('../../dashboard/site/src/data/queries/database.json', import.meta.url)));
const records = ['$domains', '$tools', '$skills', '$friction', '$audits', '$issues'];

function inputFields(definition) {
  const derived = new Set();
  const required = new Set();
  const use = (field) => { if (field && !derived.has(field)) required.add(field); };
  for (const join of definition.joins ?? []) {
    for (const key of join.on) use(key.left);
    for (const field of join.fields) derived.add(field.as ?? field.field);
  }
  for (const computed of definition.compute ?? []) {
    for (const argument of computed.args ?? []) use(argument.field);
    derived.add(computed.as);
  }
  for (const field of definition.select ?? []) use(field.field);
  for (const predicate of definition.filter?.predicates ?? []) use(predicate.field);
  return required;
}

test('TypeSpec declares exactly one root table per canonical dashboard collection', () => {
  assert.deepEqual([...tables.keys()].sort(), [
    '$campaigns', '$repositories', '$workflows', '$runs', ...records, '$operationalValues',
    '$marketplacePackages', '$experiments', '$experimentAssignments',
    '$graders', '$graderObservations', '$evals', '$evalObservations', '$jobs', '$sessions', '$events'
  ].sort());
});

test('native table fields cover database projections and joins without speculative columns', () => {
  const defects = [];
  const required = new Map([...tables.keys()].map((source) => [source, new Set(['id'])]));
  required.get('$runs').add('repositoryId'); // Cross-parent canonical integrity.
  for (const definition of definitions) {
    const sources = definition.from === '$records' ? records : [definition.from];
    const fields = inputFields(definition);
    if (definition.from === '$records') {
      for (const field of fields) {
        if (!records.some((source) => tables.get(source).has(field))) defects.push(`missing record field ${field}`);
      }
    } else if (tables.has(definition.from)) {
      for (const field of fields) {
        if (!tables.get(definition.from).has(field)) defects.push(`missing ${definition.from}.${field}`);
      }
    }
    for (const source of sources) {
      if (!required.has(source)) continue;
      for (const field of fields) required.get(source).add(field);
    }
    for (const join of definition.joins ?? []) {
      if (!tables.has(join.source)) continue;
      for (const field of [...join.on.map((key) => key.right), ...join.fields.map((field) => field.field)]) {
        if (!tables.get(join.source).has(field)) defects.push(`missing joined ${join.source}.${field}`);
        required.get(join.source).add(field);
      }
    }
  }
  for (const [source, fields] of tables) {
    if (['$jobs', '$sessions', '$events'].includes(source)) continue; // Canonical HTTP lookup contracts.
    for (const field of fields) {
      if (!required.get(source).has(field)) defects.push(`unused native column ${source}.${field}`);
    }
  }
  assert.deepEqual(defects, []);
});

test('TypeSpec excludes pruned payload copies and lifecycle aliases', () => {
  for (const [collection, fields] of Object.entries(PRUNED_CANONICAL_FIELDS)) {
    const table = tables.get(`$${collection}`);
    assert.ok(table, `missing native collection ${collection}`);
    for (const field of fields) {
      assert.equal(table.has(field), false, `${collection}.${field} must not be stored`);
    }
  }
});

test('generated SQL contains no JSON or serialized document columns', () => {
  const sql = readFileSync(new URL('../internal/postgresx/schema.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\bJSONB?\b|\b(?:payload|record_json|document)\s+(?:TEXT|BYTEA)\b/i);
  assert.match(sql, /present_fields BIT VARYING NOT NULL/);
  assert.match(sql, /REFERENCES runs\(namespace, id\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP)\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\b(?:cao_sources|cao_source_rows|cao_values|ChildValue)\b|CREATE TABLE[^\n]*(?:campaigns|runs|audits|friction)_values\b/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cao_quality/);
  assert.doesNotMatch(sql, /\bis_skill\b/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS (?:collection_health|github_quota_usage|simulation_days|marketplace_packages)\b/);
});

test('generated Postgres contract persists Campaign as a namespace-scoped entity table', () => {
  const sql = readFileSync(new URL('../internal/postgresx/schema.sql', import.meta.url), 'utf8');
  const campaignTable = sql.match(/CREATE TABLE IF NOT EXISTS campaigns \(\n([\s\S]*?)\n\);/);
  assert.ok(campaignTable, 'Campaign must have a physical Postgres table');
  assert.match(campaignTable[1], /id TEXT NOT NULL CHECK \(id <> ''\)/);
  assert.match(campaignTable[1], /slug TEXT/);
  assert.match(campaignTable[1], /enabled BOOLEAN/);
  assert.match(campaignTable[1], /PRIMARY KEY \(namespace, id\)/);
  assert.match(campaignTable[1], /FOREIGN KEY \(namespace\) REFERENCES cao_state\(namespace\) ON DELETE CASCADE/);
  const bindings = readFileSync(new URL('../internal/postgresx/schema.gen.go', import.meta.url), 'utf8');
  assert.match(bindings, /"\$campaigns": \{name: "campaigns", runtime: false, canonical: true/);
  assert.match(bindings, /"campaigns": \{[\s\S]*?field: "version", inputs: \[\]string\{"campaign-version"(?:,|\})/);
});
