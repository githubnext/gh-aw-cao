const QUERY_METADATA_KEYS = new Set(['name', 'intent', 'description']);
const CHAIN_PREFIX_KEYS = ['union', 'time', 'joins', 'filter'];
const QUERY_STAGE_WEIGHTS = {
  from: 20,
  union: 5,
  time: 10,
  joins: 15,
  filter: 20,
  compute: 15,
  'temporal-series': 5,
  aggregate: 10,
  predict: 5,
  select: 10,
  'order-by': 5,
  limit: 5
};
const FIELD_REFERENCE_KEYS = new Set(['field', 'left', 'right', 'as']);

/**
 * Prunes unreachable dashboard pages and reusable views, consolidates compatible
 * queries, rewrites their references, and removes queries no retained content uses.
 *
 * @param {unknown} document
 */
export function pruneDashboardDocument(document) {
  if (!isRecord(document) || !isRecord(document.dashboard)) {
    throw new Error('Dashboard document must contain a dashboard object');
  }

  const optimized = structuredClone(document);
  const dashboard = optimized.dashboard;
  const queries = Array.isArray(dashboard.queries) ? dashboard.queries : [];
  const similarQueries = analyzeDashboardQueries(queries);
  const pages = Array.isArray(dashboard.pages) ? dashboard.pages : [];
  const reusableViews = Array.isArray(dashboard.views) ? dashboard.views : [];
  const referencedViewIds = referencedReusableViewIds(pages, reusableViews);
  const removedViews = reusableViews
    .filter((view) => isRecord(view) && typeof view.id === 'string' && !referencedViewIds.has(view.id))
    .map((view) => view.id);
  const retainedViews = reusableViews.filter((view) => (
    !isRecord(view) || typeof view.id !== 'string' || referencedViewIds.has(view.id)
  ));
  if (retainedViews.length > 0) dashboard.views = retainedViews;
  else delete dashboard.views;

  const { queries: consolidatedQueries, aliases, groups } = consolidateQueries(queries);
  dashboard.queries = consolidatedQueries;
  rewriteDashboardQueryReferences(dashboard, aliases);
  const chains = chainCommonQueryPrefixes(dashboard.queries);

  const liveQueryNames = findLiveQueryNames(dashboard);
  const removedQueries = dashboard.queries
    .filter((query) => isRecord(query) && typeof query.name === 'string' && !liveQueryNames.has(query.name))
    .map((query) => query.name);
  dashboard.queries = dashboard.queries.filter((query) => (
    !isRecord(query) || typeof query.name !== 'string' || liveQueryNames.has(query.name)
  ));
  const finalAnalysis = buildDashboardQueryAnalysis(dashboard, similarQueries);

  return {
    document: optimized,
    report: {
      queries: {
        before: queries.length,
        after: dashboard.queries.length,
        consolidated: groups,
        chains,
        similar: similarQueries,
        stats: {
          before: summarizeQueryGraph(queries),
          after: finalAnalysis.stats,
          similarity: summarizeSimilarities(queries.length, similarQueries)
        },
        inventory: finalAnalysis.inventory,
        removed: removedQueries
      },
      views: {
        before: reusableViews.length,
        after: retainedViews.length,
        removed: removedViews
      },
      pages: {
        before: pages.length,
        after: pages.length,
        removed: []
      }
    }
  };
}

/**
 * Scores query pairs using weighted stage similarity. Exact stages receive full
 * credit, stages with the same structure modulo field names receive 85%, and
 * partial structural overlap receives up to 60%.
 *
 * @param {unknown[]} queries
 */
export function analyzeDashboardQueries(queries) {
  const definitions = queries.filter((query) => isRecord(query) && typeof query.name === 'string');
  const suggestions = [];
  for (let rightIndex = 1; rightIndex < definitions.length; rightIndex += 1) {
    const right = definitions[rightIndex];
    const candidates = [];
    for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1) {
      const left = definitions[leftIndex];
      const comparison = scoreDashboardQuerySimilarity(left, right);
      if (comparison.score < 0.65) continue;
      candidates.push({
        query: right.name,
        candidate: left.name,
        ...comparison
      });
    }
    candidates.sort((left, rightCandidate) => (
      rightCandidate.score - left.score || left.candidate.localeCompare(rightCandidate.candidate)
    ));
    suggestions.push(...candidates);
  }
  return suggestions;
}

/**
 * @param {Record<string, any>} dashboard
 * @param {Array<Record<string, any>>} similarities
 */
function buildDashboardQueryAnalysis(dashboard, similarities) {
  const queries = Array.isArray(dashboard.queries) ? dashboard.queries : [];
  const definitions = queries.filter((query) => isRecord(query) && typeof query.name === 'string');
  const index = new Map(definitions.map((query) => [query.name, query]));
  const consumers = new Map(definitions.map((query) => [query.name, new Set()]));
  const dependents = new Map(definitions.map((query) => [query.name, new Set()]));
  const similarityByQuery = new Map(definitions.map((query) => [query.name, []]));

  for (const query of definitions) {
    for (const dependency of queryInputNames(query)) {
      if (!index.has(dependency)) continue;
      dependents.get(dependency)?.add(query.name);
      consumers.get(dependency)?.add(`query:${query.name}`);
    }
  }
  for (const view of Array.isArray(dashboard.views) ? dashboard.views : []) {
    if (!isRecord(view)) continue;
    addViewConsumers(view, `view:${typeof view.id === 'string' ? view.id : 'anonymous'}`, consumers);
  }
  for (const [pageIndex, page] of (Array.isArray(dashboard.pages) ? dashboard.pages : []).entries()) {
    if (!isRecord(page)) continue;
    const pageId = typeof page.id === 'string' ? page.id : String(pageIndex);
    for (const [viewIndex, view] of pageViews(page).entries()) {
      if (isRecord(view)) {
        addViewConsumers(
          view,
          `page:${pageId}/view:${typeof view.id === 'string' ? view.id : viewIndex}`,
          consumers
        );
      } else if (typeof view === 'string') {
        const reusable = Array.isArray(dashboard.views)
          ? dashboard.views.find((candidate) => isRecord(candidate) && candidate.id === view)
          : undefined;
        if (isRecord(reusable)) addViewConsumers(reusable, `page:${pageId}/view:${view}`, consumers);
      }
    }
    const definition = page.kind === 'built-in' && isRecord(page.definition) ? page.definition : page;
    for (const [sectionIndex, section] of (Array.isArray(definition.sections) ? definition.sections : []).entries()) {
      if (!isRecord(section)) continue;
      for (const name of [
        section['count-source'],
        ...(Array.isArray(section['count-sources']) ? section['count-sources'] : [])
      ]) {
        if (typeof name === 'string' && consumers.has(name)) {
          consumers.get(name)?.add(`page:${pageId}/section:${sectionIndex}`);
        }
      }
    }
  }
  for (const [index_, callout] of (Array.isArray(dashboard.callouts) ? dashboard.callouts : []).entries()) {
    const source = isRecord(callout) && isRecord(callout['visible-when']) ? callout['visible-when'].source : undefined;
    if (typeof source === 'string' && consumers.has(source)) consumers.get(source)?.add(`callout:${index_}`);
  }
  for (const similarity of similarities) {
    if (typeof similarity.query !== 'string' || typeof similarity.candidate !== 'string') continue;
    const forward = {
      query: similarity.candidate,
      score: similarity.score,
      relation: similarity.relation,
      'exact-stages': similarity['exact-stages'],
      'mapped-stages': similarity['mapped-stages'],
      'field-mapping': similarity['field-mapping'],
      'chainable-prefix': similarity['chainable-prefix']
    };
    const reverse = {
      ...forward,
      query: similarity.query,
      'field-mapping': Object.fromEntries(
        Object.entries(similarity['field-mapping'] ?? {}).map(([from, to]) => [to, from])
      )
    };
    similarityByQuery.get(similarity.query)?.push(forward);
    similarityByQuery.get(similarity.candidate)?.push(reverse);
  }

  const depths = queryDepths(index);
  const inventory = definitions.map((query, index_) => {
    const dependencies = queryInputNames(query).filter((name) => index.has(name));
    return {
      name: query.name,
      index: index_,
      from: query.from,
      stages: queryStages(query),
      dependencies,
      dependents: [...(dependents.get(query.name) ?? [])].toSorted(),
      consumers: [...(consumers.get(query.name) ?? [])].toSorted(),
      depth: depths.get(query.name) ?? 0,
      'fan-in': dependencies.length,
      'fan-out': dependents.get(query.name)?.size ?? 0,
      similarities: (similarityByQuery.get(query.name) ?? [])
        .toSorted((left, right) => right.score - left.score || left.query.localeCompare(right.query))
    };
  });
  return { inventory, stats: summarizeQueryGraph(definitions) };
}

/** @param {Record<string, any>} view @param {string} label @param {Map<string, Set<string>>} consumers */
function addViewConsumers(view, label, consumers) {
  for (const name of viewQueryNames(view)) {
    if (consumers.has(name)) consumers.get(name)?.add(label);
  }
}

/**
 * @param {unknown[]} queries
 */
function summarizeQueryGraph(queries) {
  const definitions = queries.filter((query) => isRecord(query) && typeof query.name === 'string');
  const index = new Map(definitions.map((query) => [query.name, query]));
  const depths = queryDepths(index);
  const stageCounts = Object.fromEntries(Object.keys(QUERY_STAGE_WEIGHTS).map((stage) => [stage, 0]));
  let dependencyEdges = 0;
  for (const query of definitions) {
    for (const stage of queryStages(query)) stageCounts[stage] += 1;
    dependencyEdges += queryInputNames(query).filter((name) => index.has(name)).length;
  }
  const depthValues = [...depths.values()];
  return {
    queries: definitions.length,
    'dependency-edges': dependencyEdges,
    'root-queries': depthValues.filter((depth) => depth === 0).length,
    'nested-queries': depthValues.filter((depth) => depth > 0).length,
    'max-depth': depthValues.length > 0 ? Math.max(...depthValues) : 0,
    'average-depth': depthValues.length > 0
      ? Math.round((depthValues.reduce((total, depth) => total + depth, 0) / depthValues.length) * 100) / 100
      : 0,
    'stage-counts': stageCounts
  };
}

/** @param {number} queryCount @param {Array<Record<string, any>>} similarities */
function summarizeSimilarities(queryCount, similarities) {
  const buckets = { '0.65-0.74': 0, '0.75-0.84': 0, '0.85-0.94': 0, '0.95-1.00': 0 };
  for (const similarity of similarities) {
    const score = Number(similarity.score);
    if (score >= 0.95) buckets['0.95-1.00'] += 1;
    else if (score >= 0.85) buckets['0.85-0.94'] += 1;
    else if (score >= 0.75) buckets['0.75-0.84'] += 1;
    else buckets['0.65-0.74'] += 1;
  }
  return {
    threshold: 0.65,
    'pairs-compared': queryCount * (queryCount - 1) / 2,
    'matches-reported': similarities.length,
    duplicates: similarities.filter((similarity) => similarity.relation === 'duplicate').length,
    'field-mapped': similarities.filter((similarity) => similarity.relation === 'same-shape-with-field-mapping').length,
    similar: similarities.filter((similarity) => similarity.relation === 'similar').length,
    buckets
  };
}

/** @param {Map<string, Record<string, any>>} index */
function queryDepths(index) {
  const cache = new Map();
  const depth = (name, visiting = new Set()) => {
    if (cache.has(name)) return cache.get(name);
    if (visiting.has(name)) return 0;
    const query = index.get(name);
    if (!query) return 0;
    const next = new Set(visiting).add(name);
    const dependencies = queryInputNames(query).filter((dependency) => index.has(dependency));
    const value = dependencies.length === 0
      ? 0
      : 1 + Math.max(...dependencies.map((dependency) => depth(dependency, next)));
    cache.set(name, value);
    return value;
  };
  for (const name of index.keys()) depth(name);
  return cache;
}

/** @param {Record<string, any>} query */
function queryStages(query) {
  return Object.keys(QUERY_STAGE_WEIGHTS).filter((stage) => query[stage] !== undefined);
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
export function scoreDashboardQuerySimilarity(left, right) {
  let earned = 0;
  let possible = 0;
  const exactStages = [];
  const mappedStages = [];
  const fieldMapping = new Map();

  for (const [stage, weight] of Object.entries(QUERY_STAGE_WEIGHTS)) {
    const leftValue = left[stage];
    const rightValue = right[stage];
    if (leftValue === undefined && rightValue === undefined) continue;
    possible += weight;
    if (stableStringify(normalizeQueryValue(stage, leftValue)) === stableStringify(normalizeQueryValue(stage, rightValue))) {
      earned += weight;
      exactStages.push(stage);
      continue;
    }
    const mapping = new Map();
    if (sameShapeModuloFields(leftValue, rightValue, undefined, mapping)) {
      earned += weight * 0.85;
      mappedStages.push(stage);
      for (const [from, to] of mapping) fieldMapping.set(from, to);
      continue;
    }
    earned += weight * 0.6 * structuralJaccard(leftValue, rightValue);
  }

  const score = possible === 0 ? 0 : Math.round((earned / possible) * 100) / 100;
  return {
    score,
    relation: mappedStages.length > 0
      ? 'same-shape-with-field-mapping'
      : score === 1
        ? 'duplicate'
        : 'similar',
    'exact-stages': exactStages,
    'mapped-stages': mappedStages,
    'field-mapping': Object.fromEntries(fieldMapping),
    'chainable-prefix': chainablePrefix(left, right)
  };
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @param {string | undefined} key
 * @param {Map<string, string>} mapping
 */
function sameShapeModuloFields(left, right, key, mapping) {
  if (FIELD_REFERENCE_KEYS.has(key) && typeof left === 'string' && typeof right === 'string') {
    const existing = mapping.get(left);
    if (existing !== undefined && existing !== right) return false;
    for (const [source, target] of mapping) {
      if (source !== left && target === right) return false;
    }
    mapping.set(left, right);
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameShapeModuloFields(value, right[index], key, mapping));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).toSorted();
    const rightKeys = Object.keys(right).toSorted();
    if (stableStringify(leftKeys) !== stableStringify(rightKeys)) return false;
    return leftKeys.every((childKey) => sameShapeModuloFields(left[childKey], right[childKey], childKey, mapping));
  }
  return Object.is(left, right);
}

/** @param {unknown} left @param {unknown} right */
function structuralJaccard(left, right) {
  const leftTokens = structuralTokens(left);
  const rightTokens = structuralTokens(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

/** @param {unknown} value @param {string} path */
function structuralTokens(value, path = '$') {
  const tokens = new Set();
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      for (const token of structuralTokens(item, `${path}[]`)) tokens.add(token);
    });
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      for (const token of structuralTokens(child, `${path}.${key}`)) tokens.add(token);
    }
  } else {
    const leaf = FIELD_REFERENCE_KEYS.has(path.split('.').at(-1))
      ? '<field>'
      : stableStringify(value);
    tokens.add(`${path}=${leaf}`);
  }
  return tokens;
}

/** @param {Record<string, any>} left @param {Record<string, any>} right */
function chainablePrefix(left, right) {
  if (left.from !== right.from) return [];
  const stages = ['from'];
  for (const key of CHAIN_PREFIX_KEYS) {
    if (stableStringify(normalizeQueryValue(key, left[key])) !== stableStringify(normalizeQueryValue(key, right[key]))) {
      break;
    }
    if (left[key] !== undefined) stages.push(key);
  }
  return stages.length > 1 ? stages : [];
}

/** @param {unknown[]} pages @param {unknown[]} reusableViews */
function referencedReusableViewIds(pages, reusableViews) {
  const ids = new Set();
  for (const page of pages) {
    if (!isRecord(page)) continue;
    for (const view of pageViews(page)) {
      if (typeof view === 'string') ids.add(view);
    }
  }
  for (const view of reusableViews) {
    if (!isRecord(view) || typeof view.id !== 'string') continue;
    if ((isRecord(view.list) && (isRecord(view.list.drill) || isRecord(view.list['view-all'])))
        || (isRecord(view.metric) && typeof view.metric['navigation-page'] === 'string')
        || (isRecord(view.config) && typeof view.config['view-all-page'] === 'string')) {
      ids.add(view.id);
    }
  }
  return ids;
}

/** @param {Record<string, any>} page */
function pageViews(page) {
  const definition = page.kind === 'built-in' && isRecord(page.definition) ? page.definition : page;
  return Array.isArray(definition.views) ? definition.views : [];
}

/** @param {unknown[]} queries */
function consolidateQueries(queries) {
  const retained = [];
  const groupsByCore = new Map();
  const aliases = new Map();
  const groups = [];

  for (const candidate of queries) {
    if (!isRecord(candidate) || typeof candidate.name !== 'string') {
      retained.push(candidate);
      continue;
    }
    const coreKey = stableStringify(queryCore(candidate));
    const candidates = groupsByCore.get(coreKey) ?? [];
    const compatible = candidates.find((entry) => mergeSelections(entry.query, candidate) !== null);
    if (!compatible) {
      const entry = { query: structuredClone(candidate), names: [candidate.name] };
      candidates.push(entry);
      groupsByCore.set(coreKey, candidates);
      retained.push(entry.query);
      continue;
    }

    const select = mergeSelections(compatible.query, candidate);
    if (select === undefined) delete compatible.query.select;
    else compatible.query.select = select;
    aliases.set(candidate.name, compatible.query.name);
    compatible.names.push(candidate.name);
  }

  for (const entries of groupsByCore.values()) {
    for (const entry of entries) {
      if (entry.names.length > 1) {
        groups.push({
          retained: entry.query.name,
          replaced: entry.names.slice(1)
        });
      }
    }
  }
  return { queries: retained, aliases, groups };
}

/**
 * Extracts shared source/time/join/filter prefixes into a base query and makes
 * each original query read from that base. This keeps the public query names
 * stable while declaring expensive shared work once.
 *
 * @param {unknown[]} queries
 */
function chainCommonQueryPrefixes(queries) {
  const groups = new Map();
  for (const [index, query] of queries.entries()) {
    if (!isRecord(query) || typeof query.name !== 'string' || typeof query.from !== 'string') continue;
    const prefix = queryChainPrefix(query);
    if (Object.keys(prefix).length <= 1) continue;
    const key = stableStringify(prefix);
    const group = groups.get(key) ?? { prefix, entries: [] };
    group.entries.push({ index, query });
    groups.set(key, group);
  }

  const chainGroups = [...groups.values()]
    .filter((group) => group.entries.length > 1)
    .sort((left, right) => left.entries[0].index - right.entries[0].index);
  if (chainGroups.length === 0) return [];

  const names = new Set(queries.flatMap((query) => (
    isRecord(query) && typeof query.name === 'string' ? [query.name] : []
  )));
  const insertions = [];
  const report = [];
  for (const group of chainGroups) {
    const baseName = uniqueBaseQueryName(
      group.entries.map(({ query }) => query.name),
      group.prefix,
      names
    );
    names.add(baseName);
    const reusedBy = group.entries.map(({ query }) => query.name);
    const base = {
      name: baseName,
      intent: `Reuse shared query stages for ${reusedBy.join(', ')}`,
      ...group.prefix
    };
    insertions.push({ index: group.entries[0].index, query: base });
    for (const { query } of group.entries) {
      query.from = baseName;
      for (const key of CHAIN_PREFIX_KEYS) delete query[key];
    }
    report.push({
      base: baseName,
      reusedBy,
      stages: Object.keys(group.prefix)
    });
  }

  for (const insertion of insertions.toSorted((left, right) => right.index - left.index)) {
    queries.splice(insertion.index, 0, insertion.query);
  }
  return report;
}

/** @param {Record<string, any>} query */
function queryChainPrefix(query) {
  const prefix = { from: query.from };
  for (const key of CHAIN_PREFIX_KEYS) {
    if (query[key] !== undefined) prefix[key] = structuredClone(query[key]);
  }
  return prefix;
}

/**
 * @param {string[]} queryNames
 * @param {Record<string, any>} prefix
 * @param {Set<string>} names
 */
function uniqueBaseQueryName(queryNames, prefix, names) {
  const tokenLists = queryNames.map((name) => name.split('-').map(normalizeQueryNameToken));
  const shared = [...new Set(tokenLists[0])].filter((token) => (
    tokenLists.slice(1).every((tokens) => tokens.includes(token))
  ));
  const stage = CHAIN_PREFIX_KEYS.find((key) => prefix[key] !== undefined);
  const fallback = [
    typeof prefix.from === 'string' ? prefix.from.split('-').map(normalizeQueryNameToken).join('-') : 'query',
    stage
  ].filter(Boolean);
  const stem = (shared.length > 0 ? shared : fallback).join('-');
  let candidate = `${stem}-base`;
  let suffix = 2;
  while (names.has(candidate)) {
    candidate = `${stem}-base-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** @param {string} token */
function normalizeQueryNameToken(token) {
  if (/^fail(?:ed|ing|ure|ures)?$/.test(token)) return 'failure';
  const singular = {
    events: 'event',
    runs: 'run',
    records: 'record',
    repositories: 'repository',
    workflows: 'workflow',
    issues: 'issue',
    audits: 'audit',
    tools: 'tool',
    domains: 'domain'
  };
  return singular[token] ?? token;
}

/** @param {Record<string, any>} query */
function queryCore(query) {
  const core = {};
  for (const [key, value] of Object.entries(query)) {
    if (!QUERY_METADATA_KEYS.has(key) && key !== 'select') core[key] = normalizeQueryValue(key, value);
  }
  return core;
}

/** @param {string} key @param {unknown} value */
function normalizeQueryValue(key, value) {
  if (key === 'filter' && isRecord(value) && Array.isArray(value.predicates)) {
    return {
      ...value,
      predicates: value.predicates.map((predicate) => normalizePredicate(predicate))
        .toSorted((left, right) => stableStringify(left).localeCompare(stableStringify(right)))
    };
  }
  return value;
}

/** @param {unknown} predicate */
function normalizePredicate(predicate) {
  if (!isRecord(predicate) || !Array.isArray(predicate.in)) return predicate;
  return { ...predicate, in: [...predicate.in].toSorted(compareJsonValues) };
}

/** @param {unknown} left @param {unknown} right */
function compareJsonValues(left, right) {
  return stableStringify(left).localeCompare(stableStringify(right));
}

/**
 * Returns undefined when either query already selects every field, a merged select
 * list when projections are compatible, and null when output aliases conflict.
 *
 * @param {Record<string, any>} left
 * @param {Record<string, any>} right
 */
function mergeSelections(left, right) {
  if (!Array.isArray(left.select) || !Array.isArray(right.select)) return undefined;
  const outputs = new Map();
  const merged = [];
  for (const selection of [...left.select, ...right.select]) {
    const output = isRecord(selection) && typeof selection.as === 'string'
      ? selection.as
      : isRecord(selection) && typeof selection.field === 'string'
        ? selection.field
        : stableStringify(selection);
    const encoded = stableStringify(selection);
    const existing = outputs.get(output);
    if (existing !== undefined && existing !== encoded) return null;
    if (existing === undefined) {
      outputs.set(output, encoded);
      merged.push(selection);
    }
  }
  return merged;
}

/** @param {Record<string, any>} dashboard @param {Map<string, string>} aliases */
function rewriteDashboardQueryReferences(dashboard, aliases) {
  if (aliases.size === 0) return;
  const resolve = (name) => {
    let resolved = name;
    while (typeof resolved === 'string' && aliases.has(resolved)) resolved = aliases.get(resolved);
    return resolved;
  };

  for (const query of Array.isArray(dashboard.queries) ? dashboard.queries : []) {
    if (!isRecord(query)) continue;
    if (typeof query.from === 'string') query.from = resolve(query.from);
    if (Array.isArray(query.union)) query.union = query.union.map((name) => resolve(name));
    if (Array.isArray(query.joins)) {
      for (const join of query.joins) {
        if (isRecord(join) && typeof join.source === 'string') join.source = resolve(join.source);
      }
    }
  }
  forEachDashboardView(dashboard, (view) => rewriteViewQueryReferences(view, resolve));
  for (const page of Array.isArray(dashboard.pages) ? dashboard.pages : []) {
    if (!isRecord(page)) continue;
    const definition = page.kind === 'built-in' && isRecord(page.definition) ? page.definition : page;
    for (const section of Array.isArray(definition.sections) ? definition.sections : []) {
      if (!isRecord(section)) continue;
      if (typeof section['count-source'] === 'string') section['count-source'] = resolve(section['count-source']);
      if (Array.isArray(section['count-sources'])) {
        section['count-sources'] = section['count-sources'].map((name) => resolve(name));
      }
    }
  }
  for (const callout of Array.isArray(dashboard.callouts) ? dashboard.callouts : []) {
    if (isRecord(callout) && isRecord(callout['visible-when']) && typeof callout['visible-when'].source === 'string') {
      callout['visible-when'].source = resolve(callout['visible-when'].source);
    }
  }
}

/** @param {Record<string, any>} view @param {(name: string) => string} resolve */
function rewriteViewQueryReferences(view, resolve) {
  if (isRecord(view.data)) {
    if (typeof view.data.source === 'string') view.data.source = resolve(view.data.source);
    if (Array.isArray(view.data.sources)) view.data.sources = view.data.sources.map((name) => resolve(name));
  }
  if (isRecord(view.list) && isRecord(view.list.drill) && typeof view.list.drill.query === 'string') {
    view.list.drill.query = resolve(view.list.drill.query);
  }
}

/** @param {Record<string, any>} dashboard */
function findLiveQueryNames(dashboard) {
  const queries = Array.isArray(dashboard.queries) ? dashboard.queries : [];
  const queryByName = new Map(queries.flatMap((query) => (
    isRecord(query) && typeof query.name === 'string' ? [[query.name, query]] : []
  )));
  const live = new Set();

  forEachDashboardView(dashboard, (view) => {
    for (const name of viewQueryNames(view)) {
      if (queryByName.has(name)) live.add(name);
    }
  });
  for (const page of Array.isArray(dashboard.pages) ? dashboard.pages : []) {
    if (!isRecord(page)) continue;
    const definition = page.kind === 'built-in' && isRecord(page.definition) ? page.definition : page;
    for (const section of Array.isArray(definition.sections) ? definition.sections : []) {
      if (!isRecord(section)) continue;
      for (const name of [section['count-source'], ...(Array.isArray(section['count-sources']) ? section['count-sources'] : [])]) {
        if (typeof name === 'string' && queryByName.has(name)) live.add(name);
      }
    }
  }
  for (const callout of Array.isArray(dashboard.callouts) ? dashboard.callouts : []) {
    const source = isRecord(callout) && isRecord(callout['visible-when']) ? callout['visible-when'].source : undefined;
    if (typeof source === 'string' && queryByName.has(source)) live.add(source);
  }

  const pending = [...live];
  while (pending.length > 0) {
    const name = pending.pop();
    const query = queryByName.get(name);
    if (!query) continue;
    for (const dependency of queryInputNames(query)) {
      if (!queryByName.has(dependency) || live.has(dependency)) continue;
      live.add(dependency);
      pending.push(dependency);
    }
  }
  return live;
}

/** @param {Record<string, any>} dashboard @param {(view: Record<string, any>) => void} visit */
function forEachDashboardView(dashboard, visit) {
  for (const view of Array.isArray(dashboard.views) ? dashboard.views : []) {
    if (isRecord(view)) visit(view);
  }
  for (const page of Array.isArray(dashboard.pages) ? dashboard.pages : []) {
    if (!isRecord(page)) continue;
    for (const view of pageViews(page)) {
      if (isRecord(view)) visit(view);
    }
  }
}

/** @param {Record<string, any>} view */
function viewQueryNames(view) {
  const names = [];
  if (isRecord(view.data)) {
    if (typeof view.data.source === 'string') names.push(view.data.source);
    if (Array.isArray(view.data.sources)) names.push(...view.data.sources.filter((name) => typeof name === 'string'));
  }
  if (isRecord(view.list) && isRecord(view.list.drill) && typeof view.list.drill.query === 'string') {
    names.push(view.list.drill.query);
  }
  return names;
}

/** @param {Record<string, any>} query */
function queryInputNames(query) {
  return [
    query.from,
    ...(Array.isArray(query.union) ? query.union : []),
    ...(Array.isArray(query.joins)
      ? query.joins.flatMap((join) => isRecord(join) ? [join.source] : [])
      : [])
  ].filter((name) => typeof name === 'string');
}

/** @param {unknown} value */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
