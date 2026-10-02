import { createTypeSpecLibrary, emitFile, getNamespaceFullName, navigateProgram } from '@typespec/compiler';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const $lib = createTypeSpecLibrary({ name: 'cao-postgres', diagnostics: {} });
export const namespace = 'Cao.Postgres';
const parentKey = Symbol.for('cao-postgres.parent');
const weeklyRunPartitionKey = Symbol.for('cao-postgres.weekly-run-partition');
export function $parent(context, target, entity, required = true) {
  context.program.stateMap(parentKey).set(target, { entity, required });
}
export function $weeklyRunPartition(context, target) {
  context.program.stateMap(weeklyRunPartitionKey).set(target, true);
}

const snake = (field) => field.replace(/-/g, '_').replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const kinds = new Map([
  ['string', ['', 'TEXT']], ['decimal', ['numeric', 'NUMERIC']],
  ['int64', ['numeric', 'BIGINT']], ['boolean', ['boolean', 'BOOLEAN']],
  ['utcDateTime', ['timestamp', 'TIMESTAMPTZ']]
]);
const inputNames = new Map([
  ['securityFindings', '$security-findings'], ['outcomePerformance', '$outcomes'],
  ['transactions', '$transactions'], ['workItems', 'work-items']
]);
const runtimeNames = new Map([
  ['collectionHealth', 'collection-health'], ['githubQuotaUsage', 'github-quota-usage'],
  ['simulationDays', 'simulation-days']
]);

export async function $onEmit(context) {
  const inventoryContract = JSON.parse(readFileSync(new URL('../../dashboard/site/src/data/queries/ingestion.json', import.meta.url)));
  const tables = [];
  const systems = [];
  const parents = new Map();
  navigateProgram(context.program, {
    model(model) {
      const namespace = getNamespaceFullName(model.namespace);
      if (!['Cao.Postgres', 'Cao.Postgres.Inputs', 'Cao.Postgres.Storage', 'Cao.Postgres.Runtime'].includes(namespace)) return;
      const columns = [];
      for (const property of model.properties.values()) {
        const relationship = context.program.stateMap(parentKey).get(property);
        if (relationship) {
          const declared = parents.get(model.name) ?? [];
          declared.push([property.name, relationship.entity, !relationship.required]);
          parents.set(model.name, declared);
        }
        if (property.type.kind === 'Model' && getNamespaceFullName(property.type.namespace) === 'Cao.Postgres.Values') {
          columns.push({ field: property.name, name: `${snake(property.name)}_object`, kind: 'object', sql: 'BOOLEAN' });
          for (const member of property.type.properties.values()) {
            const kind = member.type.kind === 'Scalar' && kinds.get(member.type.name);
            if (!kind) throw new Error(`Unsupported object member ${model.name}.${property.name}.${member.name}`);
            columns.push({ field: `${property.name}.${member.name}`, name: `${snake(property.name)}_${snake(member.name)}`, kind: kind[0], sql: kind[1] });
          }
          continue;
        }
        const kind = property.type.kind === 'Scalar' && kinds.get(property.type.name);
        if (!kind) throw new Error(`Storage requires an explicit native type: ${model.name}.${property.name}`);
        columns.push({ field: property.name, name: snake(property.name), kind: kind[0], sql: kind[1], required: !property.optional });
      }
      const table = { collection: model.name, name: snake(model.name), columns,
        weekly: context.program.stateMap(weeklyRunPartitionKey).has(model) };
      if (namespace === 'Cao.Postgres.Storage') systems.push(table);
      else {
        table.runtime = namespace === 'Cao.Postgres.Runtime' || model.name === 'marketplacePackages';
        table.canonical = namespace === 'Cao.Postgres' && !table.runtime;
        table.source = inputNames.get(model.name) ?? runtimeNames.get(model.name) ?? `$${model.name}`;
        tables.push(table);
      }
    }
  });
  tables.sort((a, b) => a.collection.localeCompare(b.collection));
  const ordered = [];
  const visit = (table) => {
    if (ordered.includes(table)) return;
    for (const [, parent] of parents.get(table.collection) ?? []) {
      visit(tables.find((candidate) => candidate.collection === parent));
    }
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  tables.splice(0, tables.length, ...ordered);
  for (const table of tables.filter((t) => t.weekly)) {
    if (table.runtime || !table.canonical) throw new Error(`Invalid weekly partition ${table.collection}`);
    if (table.collection !== 'runs' && !(parents.get(table.collection) ?? []).some(([, parent]) => {
      return parent === 'runs' || parent === 'sessions' && table.collection === 'events';
    })) throw new Error(`Weekly table ${table.collection} has no run parent`);
  }
  const statements = [
    '-- Generated from server/spec/storage.tsp. Do not edit.',
    '-- Fresh database only. Opaque artifacts remain external.',
    `-- Inventory normalization contract: ${createHash('sha256').update(JSON.stringify(inventoryContract.observations.filter((o) => ['campaign','repository','workflow'].includes(o.kind)))).digest('hex')}`
  ];
  for (const table of systems) {
    const constraints = table.name === 'cao_contract' ? ['PRIMARY KEY (digest)'] : table.name === 'cao_state' ? ['PRIMARY KEY (namespace)'] : [
      'PRIMARY KEY (namespace, collection)',
      'FOREIGN KEY (namespace) REFERENCES cao_state(namespace) ON DELETE CASCADE',
      `CHECK (collection IN (${tables.filter((t) => !t.runtime).map((t) => `'${t.source}'`).join(',')}))`,
      "CHECK (availability IN ('available','empty','unavailable'))",
      "CHECK (completeness IN ('complete','partial','unknown'))",
      "CHECK (freshness IN ('current','stale','unknown'))"
    ];
    statements.push(`CREATE TABLE IF NOT EXISTS ${table.name} (\n${table.columns.map((c) => `  ${c.name} ${c.sql}${c.required ? ' NOT NULL' : ''}`).join(',\n')},\n  ${constraints.join(',\n  ')}\n);`);
  }
  const go = ['// Code generated from server/spec/storage.tsp. DO NOT EDIT.', '', 'package postgresx', '', 'var entityTables = map[string]entityTable{'];
  for (const table of tables) {
    if (!table.runtime) {
      const constraints = [
        `PRIMARY KEY (namespace, id${table.weekly ? ', run_at' : ''})`,
        `UNIQUE (namespace, ordinal${table.weekly ? ', run_at' : ''})`,
        `CHECK (bit_length(present_fields) = ${table.columns.length})`,
        'FOREIGN KEY (namespace) REFERENCES cao_state(namespace) ON DELETE CASCADE'
      ];
      for (const [field, parent, optional] of parents.get(table.collection) ?? []) {
        if (!table.columns.some((c) => c.field === field)) throw new Error(`Missing relationship ${table.collection}.${field}`);
        if (!optional) constraints.push(`CHECK (${snake(field)} IS NOT NULL AND ${snake(field)} <> '')`);
        const partitionedParent = tables.find((t) => t.collection === parent)?.weekly;
        constraints.push(`FOREIGN KEY (namespace, ${snake(field)}${partitionedParent ? ', run_at' : ''}) REFERENCES ${snake(parent)}(namespace, id${partitionedParent ? ', run_at' : ''}) DEFERRABLE INITIALLY DEFERRED`);
      }
      statements.push(`CREATE TABLE IF NOT EXISTS ${table.name} (
  namespace TEXT NOT NULL,
  ordinal BIGINT NOT NULL CHECK (ordinal >= 0),
  present_fields BIT VARYING NOT NULL,
${table.weekly ? '  run_at TIMESTAMPTZ NOT NULL,\n' : ''}
${table.columns.map((c) => `  ${c.name} ${c.sql}${c.field === 'id' ? " NOT NULL CHECK (id <> '')" : ''}`).join(',\n')},
  ${constraints.join(',\n  ')}
)${table.weekly ? ' PARTITION BY RANGE (run_at)' : ''};`);
      if (table.weekly) statements.push(`CREATE TABLE IF NOT EXISTS ${table.name}_default PARTITION OF ${table.name} DEFAULT;`);
      for (const [field] of parents.get(table.collection) ?? []) {
        statements.push(`CREATE INDEX IF NOT EXISTS ${table.name}_${snake(field)} ON ${table.name} (namespace, ${snake(field)}, ordinal);`);
      }
    }
    go.push(`\t"${table.source}": {name: "${table.name}", runtime: ${table.runtime}, canonical: ${table.canonical}, weekly: ${table.weekly}, columns: []entityColumn{`);
    for (const column of table.columns) {
      go.push(`\t\t{field: "${column.field}", name: "${column.name}", kind: "${column.kind}", sql: "${column.sql}"},`);
    }
    go.push('\t}},');
  }
  go.push('}', '');
  const literal = (value) => value === null ? 'nil' : JSON.stringify(value);
  go.push('var inventoryBindings = map[string][]inventoryBinding{');
  for (const [source, kind] of [['campaigns','campaign'],['repositories','repository'],['workflows','workflow']]) {
    const table = tables.find((t) => t.source === `$${source}`);
    const observation = inventoryContract.observations.find((o) => o.kind === kind);
    go.push(`\t"${source}": {`);
    for (const [field, mapping] of Object.entries(observation.data)) {
      if (!table.columns.some((column) => column.field === field)) continue;
      const fields = (mapping.fields ?? [mapping.field]).filter((field) => !field.startsWith('_'));
      if (!fields.length) continue; // Coordinate normalization owns identity fields.
      const options = [`field: ${literal(field)}`, `inputs: []string{${fields.map(literal).join(',')}}`];
      if (Object.hasOwn(mapping,'default')) options.push(`defaultPresent: true, defaultValue: ${literal(mapping.default)}`);
      if (mapping.trim) options.push('trim: true');
      if (mapping.omitEmpty) options.push('omitEmpty: true');
      if (Object.hasOwn(mapping,'equals')) options.push(`equalsPresent: true, equals: ${literal(mapping.equals)}`);
      if (Object.hasOwn(mapping,'notEquals')) options.push(`notEqualsPresent: true, notEquals: ${literal(mapping.notEquals)}`);
      go.push(`\t\t{${options.join(', ')}},`);
    }
    go.push('\t},');
  }
  go.push('}', '');
  await emitFile(context.program, { path: `${context.emitterOutputDir}/schema.sql`, content: `${statements.join('\n\n')}\n` });
  await emitFile(context.program, { path: `${context.emitterOutputDir}/schema.gen.go`, content: go.join('\n') });
}
