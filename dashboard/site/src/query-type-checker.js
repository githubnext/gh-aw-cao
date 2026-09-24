import {
  ADDITIVE_MEASURE_FIELDS,
  ERROR_CODES,
  INFERRED_FIELD_NAMES,
  LINK_FIELD_NAMES,
  NON_ADDITIVE_MEASURE_FIELDS,
  NUMERIC_COMPUTE_FUNCTIONS,
  QUERY_NUMERIC_REDUCER_VALUES,
  TABLE_FIELDS,
  TABLE_VALUES,
  TEMPORAL_FIELD_NAMES,
  TEXT_COMPUTE_FUNCTIONS
} from './specification.js';

/**
 * @typedef {'scalar'|'text'|'boolean'|'numeric'|'temporal'|'link'|'unknown'} FieldType
 * @typedef {{ code: string, message: string, path: string }} ValidationError
 * @typedef {{ fields: Map<string, FieldType> | undefined, tables: Set<string>, rowTables: Set<string> }} QueryType
 */

/**
 * Compiles the query declarations into symbol and type tables.
 *
 * The passes deliberately mirror a programming-language compiler: collect
 * declarations, resolve the dependency graph, then type-check each query in
 * clause execution order. This lets every reference be checked without
 * executing a query or depending on incidental traversal state.
 *
 * @param {unknown} definitions
 * @returns {{
 *   errors: ValidationError[],
 *   queryFields: Map<string, string[] | undefined>,
 *   queryTables: Map<string, Set<string>>
 * }}
 */
export function compileDashboardQueryTypes(definitions) {
  const errors = [];
  const queries = Array.isArray(definitions) ? definitions : [];
  /** @type {Map<string, { query: Record<string, unknown>, index: number }>} */
  const symbols = new Map();

  // Declaration pass.
  for (const [index, value] of queries.entries()) {
    if (!isRecord(value) || typeof value.name !== 'string') continue;
    if (TABLE_VALUES.includes(value.name) || symbols.has(value.name)) {
      errors.push(error(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        TABLE_VALUES.includes(value.name)
          ? `query name "${value.name}" conflicts with a database table name.`
          : `query name "${value.name}" is declared more than once.`,
        `$.dashboard.queries[${index}].name`
      ));
      continue;
    }
    symbols.set(value.name, { query: value, index });
  }

  // Reference and dependency pass.
  /** @type {Map<string, Array<{ name: string, path: string }>>} */
  const dependencies = new Map();
  for (const [name, symbol] of symbols) {
    const refs = queryInputs(symbol.query, symbol.index);
    dependencies.set(name, refs);
    for (const reference of refs) {
      if (TABLE_VALUES.includes(reference.name)) continue;
      const target = symbols.get(reference.name);
      if (!target) {
        errors.push(error(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          `query input "${reference.name}" is not a database table or previously declared query.`,
          reference.path
        ));
      } else if (target.index >= symbol.index) {
        errors.push(error(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          reference.name === name
            ? `query "${name}" cannot read itself.`
            : `query "${name}" cannot read "${reference.name}" before it is declared.`,
          reference.path
        ));
      }
    }
  }

  // Graph pass. A color-marked DFS detects every strongly recursive edge in
  // linear time and gives the checker a safe order for schema inference.
  /** @type {Map<string, 1|2>} */
  const colors = new Map();
  const cyclic = new Set();
  /** @type {string[]} */
  const stack = [];
  /** @type {string[]} */
  const order = [];
  /** @param {string} name */
  const visit = (name) => {
    if (colors.get(name) === 2) return;
    if (colors.get(name) === 1) {
      const start = stack.lastIndexOf(name);
      for (const member of stack.slice(start)) cyclic.add(member);
      cyclic.add(name);
      return;
    }
    colors.set(name, 1);
    stack.push(name);
    for (const dependency of dependencies.get(name) ?? []) {
      if (symbols.has(dependency.name)) visit(dependency.name);
    }
    stack.pop();
    colors.set(name, 2);
    order.push(name);
  };
  for (const name of symbols.keys()) visit(name);
  for (const name of cyclic) {
    const symbol = symbols.get(name);
    if (!symbol) continue;
    const reference = (dependencies.get(name) ?? []).find((candidate) => cyclic.has(candidate.name));
    errors.push(error(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      `query dependency cycle includes "${name}" and "${reference?.name ?? name}".`,
      reference?.path ?? `$.dashboard.queries[${symbol.index}].from`
    ));
  }

  // Type-check pass.
  /** @type {Map<string, QueryType | undefined>} */
  const compiled = new Map();
  for (const name of order) {
    const symbol = symbols.get(name);
    if (!symbol || cyclic.has(name)) {
      compiled.set(name, undefined);
      continue;
    }
    compiled.set(name, compileQuery(symbol.query, symbol.index, symbols, compiled, errors));
  }

  return {
    queryFields: new Map([...symbols.keys()].map((name) => {
      const fields = compiled.get(name)?.fields;
      return [name, fields ? [...fields.keys()] : undefined];
    })),
    queryTables: new Map([...symbols.keys()].map((name) => [
      name,
      new Set(compiled.get(name)?.tables ?? [])
    ])),
    errors
  };
}

/**
 * @param {Record<string, unknown>} query
 * @param {number} index
 * @param {Map<string, { query: Record<string, unknown>, index: number }>} symbols
 * @param {Map<string, QueryType | undefined>} compiled
 * @param {ValidationError[]} errors
 * @returns {QueryType | undefined}
 */
function compileQuery(query, index, symbols, compiled, errors) {
  const path = `$.dashboard.queries[${index}]`;
  const input = resolveInput(query.from, symbols, compiled);
  /** @type {Map<string, FieldType> | undefined} */
  let fields = input?.fields ? new Map(input.fields) : undefined;
  const tables = new Set(input?.tables ?? []);
  const rowTables = new Set(input?.rowTables ?? []);
  for (const inputName of Array.isArray(query.union) ? query.union : []) {
    const unionInput = resolveInput(inputName, symbols, compiled);
    for (const table of unionInput?.tables ?? []) tables.add(table);
    for (const table of unionInput?.rowTables ?? []) rowTables.add(table);
    if (fields && unionInput?.fields) {
      for (const [field, type] of unionInput.fields) {
        if (!fields.has(field)) fields.set(field, type);
      }
    } else {
      fields = undefined;
    }
  }
  const rowInputTables = new Set(rowTables);

  /** @param {unknown} field @param {string} fieldPath @param {'read'|'scalar'|'numeric'|'aggregate-numeric'} [usage] */
  const requireField = (field, fieldPath, usage = 'read') => {
    if (typeof field !== 'string') return;
    const type = fields?.get(field);
    if (fields && type === undefined) {
      errors.push(error(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        unavailableFieldMessage(field, fields, 'the preceding query clause'),
        fieldPath
      ));
      return;
    }
    validateUsage(field, type ?? intrinsicType(field), usage, fieldPath, errors);
  };
  /** @param {unknown} name @param {FieldType} type @param {string} fieldPath */
  const declareField = (name, type, fieldPath) => {
    if (typeof name !== 'string' || !fields) return;
    if (fields.has(name)) {
      errors.push(error(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'query output names must be unique across joined inputs and computed fields.',
        fieldPath
      ));
      return;
    }
    fields.set(name, type);
  };

  if (Array.isArray(query.joins)) {
    for (const [joinIndex, value] of query.joins.entries()) {
      if (!isRecord(value)) continue;
      const joinPath = `${path}.joins[${joinIndex}]`;
      const joined = resolveInput(value.source, symbols, compiled);
      for (const table of joined?.tables ?? []) tables.add(table);
      if (Array.isArray(value.on)) {
        for (const [pairIndex, pair] of value.on.entries()) {
          if (!isRecord(pair)) continue;
          requireField(pair.left, `${joinPath}.on[${pairIndex}].left`, 'scalar');
          requireInputField(
            joined?.fields,
            pair.right,
            `${joinPath}.on[${pairIndex}].right`,
            'scalar',
            errors,
            typeof value.source === 'string' ? `input "${value.source}"` : 'the joined input'
          );
        }
      }
      if (Array.isArray(value.fields)) {
        for (const [fieldIndex, selected] of value.fields.entries()) {
          if (!isRecord(selected)) continue;
          const fieldPath = `${joinPath}.fields[${fieldIndex}]`;
          const type = requireInputField(
            joined?.fields,
            selected.field,
            `${fieldPath}.field`,
            'read',
            errors,
            typeof value.source === 'string' ? `input "${value.source}"` : 'the joined input'
          );
          declareField(selected.as, type, `${fieldPath}.as`);
        }
      }
    }
  }

  if (isRecord(query.filter) && Array.isArray(query.filter.predicates)) {
    query.filter.predicates.forEach((predicate, predicateIndex) => {
      if (!isRecord(predicate)) return;
      const fieldPath = `${path}.filter.predicates[${predicateIndex}].field`;
      requireField(predicate.field, fieldPath, 'scalar');
      validateBranchSpecificFilter(predicate.field, rowInputTables, fieldPath, errors);
    });
  }

  if (Array.isArray(query.compute)) {
    for (const [computeIndex, computed] of query.compute.entries()) {
      if (!isRecord(computed)) continue;
      const computePath = `${path}.compute[${computeIndex}]`;
      if (Array.isArray(computed.args)) {
        for (const [argumentIndex, argument] of computed.args.entries()) {
          if (!isRecord(argument) || argument.field === undefined) continue;
          requireField(
            argument.field,
            `${computePath}.args[${argumentIndex}].field`,
            computeArgumentUsage(computed.function, argumentIndex)
          );
        }
      }
      declareField(
        computed.as,
        inferComputeType(computed, fields),
        `${computePath}.as`
      );
    }
  }

  if (isRecord(query.aggregate)) {
    const aggregatePath = `${path}.aggregate`;
    /** @type {Map<string, FieldType>} */
    const outputs = new Map();
    if (Array.isArray(query.aggregate.by)) {
      query.aggregate.by.forEach((field, fieldIndex) => {
        requireField(field, `${aggregatePath}.by[${fieldIndex}]`, 'scalar');
        if (typeof field === 'string' && !outputs.has(field)) {
          outputs.set(field, fields?.get(field) ?? intrinsicType(field));
        }
      });
    }
    if (Array.isArray(query.aggregate.values)) {
      for (const [valueIndex, value] of query.aggregate.values.entries()) {
        if (!isRecord(value)) continue;
        const valuePath = `${aggregatePath}.values[${valueIndex}]`;
        requireField(
          value.field,
          `${valuePath}.field`,
          typeof value.reducer === 'string' && QUERY_NUMERIC_REDUCER_VALUES.includes(value.reducer) ? 'aggregate-numeric' : 'scalar'
        );
        if (isRecord(value.filter) && Array.isArray(value.filter.predicates)) {
          value.filter.predicates.forEach((predicate, predicateIndex) => {
            if (isRecord(predicate)) requireField(predicate.field, `${valuePath}.filter.predicates[${predicateIndex}].field`, 'scalar');
          });
        }
        if (typeof value.as === 'string') {
          if (outputs.has(value.as)) {
            errors.push(error(
              ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
              'query output names must be unique across grouped and aggregate fields.',
              `${valuePath}.as`
            ));
          } else {
            outputs.set(value.as, aggregateType(value.reducer, value.field, fields));
          }
        }
      }
    }
    fields = fields ? outputs : undefined;
  }

  if (Array.isArray(query.predict)) {
    for (const [predictionIndex, prediction] of query.predict.entries()) {
      if (!isRecord(prediction)) continue;
      const predictionPath = `${path}.predict[${predictionIndex}]`;
      requireField(prediction.field, `${predictionPath}.field`, 'numeric');
      const predictors = typeof prediction.on === 'string'
        ? [prediction.on]
        : Array.isArray(prediction.on) ? prediction.on : [];
      predictors.forEach((field, fieldIndex) => requireField(
        field,
        Array.isArray(prediction.on) ? `${predictionPath}.on[${fieldIndex}]` : `${predictionPath}.on`,
        'numeric'
      ));
      if (Array.isArray(prediction.groupby)) {
        prediction.groupby.forEach((field, fieldIndex) => requireField(field, `${predictionPath}.groupby[${fieldIndex}]`, 'scalar'));
      }
      declareField(prediction.as, 'numeric', `${predictionPath}.as`);
    }
  }

  if (Array.isArray(query.select)) {
    /** @type {Map<string, FieldType>} */
    const selectedFields = new Map();
    for (const [selectIndex, selected] of query.select.entries()) {
      if (!isRecord(selected)) continue;
      const selectPath = `${path}.select[${selectIndex}]`;
      requireField(selected.field, `${selectPath}.field`);
      if (typeof selected.field !== 'string') continue;
      const alias = typeof selected.as === 'string' ? selected.as : selected.field;
      if (selectedFields.has(alias)) {
        errors.push(error(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          'select output names must be unique.',
          `${selectPath}.as`
        ));
      } else {
        selectedFields.set(alias, fields?.get(selected.field) ?? intrinsicType(selected.field));
      }
    }
    fields = fields ? selectedFields : undefined;
  }

  if (Array.isArray(query['order-by'])) {
    query['order-by'].forEach((clause, clauseIndex) => {
      if (isRecord(clause)) requireField(clause.field, `${path}.order-by[${clauseIndex}].field`, 'scalar');
    });
  }

  return { fields, tables, rowTables };
}

/**
 * @param {unknown} input
 * @param {Map<string, { query: Record<string, unknown>, index: number }>} symbols
 * @param {Map<string, QueryType | undefined>} compiled
 * @returns {QueryType | undefined}
 */
function resolveInput(input, symbols, compiled) {
  if (typeof input !== 'string') return undefined;
  if (TABLE_VALUES.includes(input)) {
    const names = TABLE_FIELDS[/** @type {keyof typeof TABLE_FIELDS} */ (input)];
    return {
      fields: names ? new Map(names.map((name) => [name, intrinsicType(name)])) : undefined,
      tables: new Set([input]),
      rowTables: new Set([input])
    };
  }
  if (!symbols.has(input)) return undefined;
  return compiled.get(input);
}

/**
 * @param {Map<string, FieldType> | undefined} fields
 * @param {unknown} field
 * @param {string} path
 * @param {'read'|'scalar'|'numeric'|'aggregate-numeric'} usage
 * @param {ValidationError[]} errors
 * @param {string} [inputLabel]
 * @returns {FieldType}
 */
function requireInputField(fields, field, path, usage, errors, inputLabel = 'the referenced input') {
  if (typeof field !== 'string') return 'unknown';
  const type = fields?.get(field);
  if (fields && type === undefined) {
    errors.push(error(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      unavailableFieldMessage(field, fields, inputLabel),
      path
    ));
    return 'unknown';
  }
  const resolved = type ?? intrinsicType(field);
  validateUsage(field, resolved, usage, path, errors);
  return resolved;
}

/**
 * @param {string} field
 * @param {FieldType} type
 * @param {'read'|'scalar'|'numeric'|'aggregate-numeric'} usage
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateUsage(field, type, usage, path, errors) {
  if (INFERRED_FIELD_NAMES.includes(field)) {
    errors.push(error(
      ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
      `query fields must exist in a database table or earlier query; "${field}" is derived after query execution.`,
      path
    ));
  } else if (usage !== 'read' && type === 'link') {
    errors.push(error(
      ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
      `query operators require a scalar field; "${field}" is a structured link field.`,
      path
    ));
  } else if (
    ['numeric', 'aggregate-numeric'].includes(usage)
    && ['text', 'temporal', ...(usage === 'numeric' ? ['boolean'] : [])].includes(type)
  ) {
    errors.push(error(
      ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
      `numeric query operator cannot use field "${field}" because its inferred type is ${type}.`,
      path
    ));
  }
}

/**
 * A required filter over a multi-table row projection must be satisfiable from
 * every branch. Otherwise one unavailable branch can make the whole projection
 * unavailable even though that branch could never match the predicate.
 *
 * @param {unknown} field
 * @param {Set<string>} rowInputTables
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateBranchSpecificFilter(field, rowInputTables, path, errors) {
  if (typeof field !== 'string' || rowInputTables.size <= 1) return;
  let present = 0;
  let known = 0;
  for (const table of rowInputTables) {
    const fields = TABLE_FIELDS[/** @type {keyof typeof TABLE_FIELDS} */ (table)];
    if (!Array.isArray(fields)) continue;
    known += 1;
    if (fields.includes(field)) present += 1;
  }
  if (known <= 1 || present === 0 || present === known) return;
  const missing = [...rowInputTables].filter((table) => {
    const fields = TABLE_FIELDS[/** @type {keyof typeof TABLE_FIELDS} */ (table)];
    return Array.isArray(fields) && !fields.includes(field);
  }).sort();
  errors.push(error(
    ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
    `filter field "${field}" is only available from some row input tables; query that table directly before filtering. Missing from: ${missing.join(', ')}.`,
    path
  ));
}

/** @param {unknown} reducer @param {unknown} field @param {Map<string, FieldType> | undefined} fields @returns {FieldType} */
function aggregateType(reducer, field, fields) {
  if (typeof reducer === 'string' && ['count', 'distinct-count', 'latest-failure-streak', ...QUERY_NUMERIC_REDUCER_VALUES].includes(reducer)) {
    return 'numeric';
  }
  if (reducer === 'distinct-list') return 'text';
  if (reducer === 'distinct-values' || reducer === 'calendar-week-rhythm') return 'unknown';
  return typeof field === 'string' ? fields?.get(field) ?? intrinsicType(field) : 'unknown';
}

/**
 * @param {unknown} functionName
 * @param {number} argumentIndex
 * @returns {'read'|'scalar'|'numeric'}
 */
function computeArgumentUsage(functionName, argumentIndex) {
  if (
    typeof functionName === 'string'
    && (
      NUMERIC_COMPUTE_FUNCTIONS.includes(functionName)
      || ['greater-than', 'format-count', 'format-percent'].includes(functionName)
    )
  ) return 'numeric';
  if (
    functionName === 'coalesce'
    || (functionName === 'if' && argumentIndex > 0)
    || (functionName === 'dashboard-link' && argumentIndex === 0)
  ) return 'read';
  return 'scalar';
}

/**
 * @param {Record<string, unknown>} computed
 * @param {Map<string, FieldType> | undefined} fields
 * @returns {FieldType}
 */
function inferComputeType(computed, fields) {
  const functionName = computed.function;
  if (functionName === 'dashboard-link') return 'link';
  if (typeof functionName === 'string' && NUMERIC_COMPUTE_FUNCTIONS.includes(functionName)) return 'numeric';
  if (typeof functionName === 'string' && TEXT_COMPUTE_FUNCTIONS.includes(functionName)) return 'text';
  if (functionName === 'equals-any' || functionName === 'greater-than') return 'boolean';
  if (!Array.isArray(computed.args)) return 'unknown';
  if (functionName === 'coalesce') return commonType(computed.args, fields);
  if (functionName === 'if') return commonType(computed.args.slice(1), fields);
  return 'unknown';
}

/**
 * @param {unknown[]} args
 * @param {Map<string, FieldType> | undefined} fields
 * @returns {FieldType}
 */
function commonType(args, fields) {
  const types = args.map((argument) => argumentType(argument, fields)).filter((type) => type !== 'unknown');
  return types.length > 0 && types.every((type) => type === types[0]) ? types[0] : 'unknown';
}

/**
 * @param {unknown} argument
 * @param {Map<string, FieldType> | undefined} fields
 * @returns {FieldType}
 */
function argumentType(argument, fields) {
  if (!isRecord(argument)) return 'unknown';
  if (typeof argument.field === 'string') return fields?.get(argument.field) ?? intrinsicType(argument.field);
  if (!Object.hasOwn(argument, 'value') || argument.value === null) return 'unknown';
  if (typeof argument.value === 'number') return 'numeric';
  if (typeof argument.value === 'boolean') return 'boolean';
  if (typeof argument.value === 'string') return 'text';
  return 'unknown';
}

/**
 * @param {string} field
 * @param {Map<string, FieldType>} fields
 * @param {string} inputLabel
 */
function unavailableFieldMessage(field, fields, inputLabel) {
  const available = [...fields.keys()].sort();
  const displayed = available.slice(0, 8);
  const suffix = available.length > displayed.length ? `, and ${available.length - displayed.length} more` : '';
  return `field "${field}" is not available from ${inputLabel}; available fields: ${displayed.join(', ') || '(none)'}${suffix}.`;
}

/** @param {string} field @returns {FieldType} */
function intrinsicType(field) {
  if (LINK_FIELD_NAMES.includes(field)) return 'link';
  if (TEMPORAL_FIELD_NAMES.includes(field)) return 'temporal';
  if (ADDITIVE_MEASURE_FIELDS.includes(field) || NON_ADDITIVE_MEASURE_FIELDS.includes(field)) return 'numeric';
  return 'scalar';
}

/** @param {Record<string, unknown>} query @param {number} index */
function queryInputs(query, index) {
  const inputs = [{ name: query.from, path: `$.dashboard.queries[${index}].from` }];
  if (Array.isArray(query.union)) {
    query.union.forEach((input, inputIndex) => {
      inputs.push({ name: input, path: `$.dashboard.queries[${index}].union[${inputIndex}]` });
    });
  }
  if (Array.isArray(query.joins)) {
    query.joins.forEach((join, joinIndex) => {
      inputs.push({
        name: isRecord(join) ? join.source : undefined,
        path: `$.dashboard.queries[${index}].joins[${joinIndex}].source`
      });
    });
  }
  return inputs.filter((input) => typeof input.name === 'string')
    .map((input) => ({ name: /** @type {string} */ (input.name), path: input.path }));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} code @param {string} message @param {string} path @returns {ValidationError} */
function error(code, message, path) {
  return { code, message, path };
}
