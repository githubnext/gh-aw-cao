import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile, getNamespaceFullName, navigateProgram, NodeHost } from '@typespec/compiler';

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

test('generated SQL contains no JSON or serialized document columns', () => {
  const sql = readFileSync(new URL('../internal/postgresx/schema.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\bJSONB?\b|\b(?:payload|record_json|document)\s+(?:TEXT|BYTEA)\b/i);
  assert.match(sql, /present_fields BIT VARYING NOT NULL/);
  assert.match(sql, /REFERENCES runs\(namespace, id, run_at\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS runs \([\s\S]*?\) PARTITION BY RANGE \(run_at\);/);
  assert.match(sql, /REFERENCES sessions\(namespace, id, run_at\) DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP)\s+TABLE\b/i);
  assert.doesNotMatch(sql, /\b(?:cao_sources|cao_source_rows|cao_values|ChildValue)\b|CREATE TABLE[^\n]*(?:campaigns|runs|audits|friction)_values\b/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cao_quality/);
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS (?:collection_health|github_quota_usage|simulation_days|marketplace_packages)\b/);
});
