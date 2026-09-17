import {
  ADDITIVE_MEASURE_FIELDS,
  ERROR_CODES,
  INFERRED_FIELD_NAMES,
  LINK_FIELD_NAMES,
  NON_ADDITIVE_MEASURE_FIELDS,
  NUMERIC_COMPUTE_FUNCTIONS,
  QUERY_NUMERIC_REDUCER_VALUES,
  SOURCE_FIELDS,
  SOURCE_VALUES,
  TEMPORAL_FIELD_NAMES
} from './specification.js';

/**
 * @typedef {'scalar'|'numeric'|'temporal'|'link'|'unknown'} FieldType
 * @typedef {{ code: string, message: string, path: string }} ValidationError
 * @typedef {{ fields: Map<string, FieldType>, sources: Set<string> }} QueryType
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
 *   querySources: Map<string, Set<string>>
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
    if (SOURCE_VALUES.includes(value.name) || symbols.has(value.name)) {
      errors.push(error(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'query name must be unique and must not shadow a canonical source name.',
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
      if (SOURCE_VALUES.includes(reference.name)) continue;
      const target = symbols.get(reference.name);
      if (!target) {
        errors.push(error(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          'query sources must name one canonical source or one declared query.',
          reference.path
        ));
      } else if (target.index >= symbol.index) {
        errors.push(error(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          reference.name === name
            ? 'query must not read itself.'
            : 'query dependencies must be declared before the consuming query.',
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
      'query dependency graph must not contain cycles.',
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
    queryFields: new Map([...symbols.keys()].map((name) => [
      name,
      compiled.get(name) ? [.../** @type {QueryType} */ (compiled.get(name)).fields.keys()] : undefined
    ])),
    querySources: new Map([...symbols.keys()].map((name) => [
      name,
      new Set(compiled.get(name)?.sources ?? [])
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
  const input = resolveSource(query.from, symbols, compiled);
  /** @type {Map<string, FieldType> | undefined} */
  let fields = input?.fields ? new Map(input.fields) : undefined;
  const sources = new Set(input?.sources ?? []);

  /** @param {unknown} field @param {string} fieldPath @param {'read'|'scalar'|'numeric'} [usage] */
  const requireField = (field, fieldPath, usage = 'read') => {
    if (typeof field !== 'string') return;
    const type = fields?.get(field);
    if (fields && type === undefined) {
      errors.push(error(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'query field references must name a field produced by the preceding clause.',
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
        'query output names must be unique across joined sources and computed fields.',
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
      const joined = resolveSource(value.source, symbols, compiled);
      for (const source of joined?.sources ?? []) sources.add(source);
      if (Array.isArray(value.on)) {
        for (const [pairIndex, pair] of value.on.entries()) {
          if (!isRecord(pair)) continue;
          requireField(pair.left, `${joinPath}.on[${pairIndex}].left`, 'scalar');
          requireSourceField(joined?.fields, pair.right, `${joinPath}.on[${pairIndex}].right`, 'scalar', errors);
        }
      }
      if (Array.isArray(value.fields)) {
        for (const [fieldIndex, selected] of value.fields.entries()) {
          if (!isRecord(selected)) continue;
          const fieldPath = `${joinPath}.fields[${fieldIndex}]`;
          const type = requireSourceField(joined?.fields, selected.field, `${fieldPath}.field`, 'read', errors);
          declareField(selected.as, type, `${fieldPath}.as`);
        }
      }
    }
  }

  if (isRecord(query.filter) && Array.isArray(query.filter.predicates)) {
    query.filter.predicates.forEach((predicate, predicateIndex) => {
      if (isRecord(predicate)) requireField(predicate.field, `${path}.filter.predicates[${predicateIndex}].field`, 'scalar');
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
            typeof computed.function === 'string' && NUMERIC_COMPUTE_FUNCTIONS.includes(computed.function)
              ? 'numeric'
              : ['coalesce', 'dashboard-link'].includes(String(computed.function)) ? 'read' : 'scalar'
          );
        }
      }
      declareField(
        computed.as,
        computed.function === 'dashboard-link'
          ? 'link'
          : typeof computed.function === 'string' && NUMERIC_COMPUTE_FUNCTIONS.includes(computed.function)
            ? 'numeric'
            : 'unknown',
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
        if (typeof field === 'string' && fields?.has(field)) outputs.set(field, /** @type {FieldType} */ (fields.get(field)));
      });
    }
    if (Array.isArray(query.aggregate.values)) {
      for (const [valueIndex, value] of query.aggregate.values.entries()) {
        if (!isRecord(value)) continue;
        const valuePath = `${aggregatePath}.values[${valueIndex}]`;
        requireField(
          value.field,
          `${valuePath}.field`,
          typeof value.reducer === 'string' && QUERY_NUMERIC_REDUCER_VALUES.includes(value.reducer) ? 'numeric' : 'scalar'
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

  return fields ? { fields, sources } : undefined;
}

/**
 * @param {unknown} source
 * @param {Map<string, { query: Record<string, unknown>, index: number }>} symbols
 * @param {Map<string, QueryType | undefined>} compiled
 * @returns {QueryType | undefined}
 */
function resolveSource(source, symbols, compiled) {
  if (typeof source !== 'string') return undefined;
  if (SOURCE_VALUES.includes(source)) {
    const names = SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (source)];
    return {
      fields: new Map((names ?? []).map((name) => [name, intrinsicType(name)])),
      sources: new Set([source])
    };
  }
  if (!symbols.has(source)) return undefined;
  return compiled.get(source);
}

/**
 * @param {Map<string, FieldType> | undefined} fields
 * @param {unknown} field
 * @param {string} path
 * @param {'read'|'scalar'|'numeric'} usage
 * @param {ValidationError[]} errors
 * @returns {FieldType}
 */
function requireSourceField(fields, field, path, usage, errors) {
  if (typeof field !== 'string') return 'unknown';
  const type = fields?.get(field);
  if (fields && type === undefined) {
    errors.push(error(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'field must be declared by the referenced query or database table.',
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
 * @param {'read'|'scalar'|'numeric'} usage
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateUsage(field, type, usage, path, errors) {
  if (INFERRED_FIELD_NAMES.includes(field)) {
    errors.push(error(
      ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
      `query fields must exist in the canonical schema; "${field}" is derived after query execution.`,
      path
    ));
  } else if (usage !== 'read' && type === 'link') {
    errors.push(error(
      ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
      `query operators require a scalar field; "${field}" is a structured link field.`,
      path
    ));
  } else if (usage === 'numeric' && type === 'temporal') {
    errors.push(error(
      ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
      `numeric query operators require a numeric field; "${field}" is a timestamp field.`,
      path
    ));
  }
}

/** @param {unknown} reducer @param {unknown} field @param {Map<string, FieldType> | undefined} fields @returns {FieldType} */
function aggregateType(reducer, field, fields) {
  if (typeof reducer === 'string' && ['count', 'distinct-count', ...QUERY_NUMERIC_REDUCER_VALUES].includes(reducer)) {
    return 'numeric';
  }
  return typeof field === 'string' ? fields?.get(field) ?? intrinsicType(field) : 'unknown';
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
