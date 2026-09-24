import { parseAllDocuments } from 'yaml';
import {
  ADDITIVE_MEASURE_FIELDS,
  AGGREGATE_VALUES,
  BUILT_IN_PAGE_KEYS,
  BUILT_IN_PAGE_VALUES,
  CARD_TEMPLATE_ACTION_KEYS,
  CARD_DETAIL_LABEL_VALUES,
  CARD_STATUS_KEYS,
  CARD_TEMPLATE_KEYS,
  CARD_TIMING_FIELD_KEYS,
  CUSTOM_PAGE_KEYS,
  DASHBOARD_KEYS,
  DASHBOARD_HORIZON_KEYS,
  DASHBOARD_QUERY_LIMITS,
  COMPUTE_FUNCTION_ARITY,
  NUMERIC_COMPUTE_FUNCTIONS,
  QUERY_AGGREGATE_FILTER_PREDICATE_KEYS,
  QUERY_AGGREGATE_KEYS,
  QUERY_AGGREGATE_VALUE_KEYS,
  QUERY_COMPUTE_ARGUMENT_KEYS,
  QUERY_COMPUTE_KEYS,
  QUERY_TEMPORAL_SERIES_KEYS,
  QUERY_TEMPORAL_SERIES_MAP_KEYS,
  QUERY_TEMPORAL_SERIES_MEASURE_KEYS,
  QUERY_FILTER_KEYS,
  QUERY_JOIN_FIELD_KEYS,
  QUERY_JOIN_KEYS,
  QUERY_JOIN_ON_KEYS,
  QUERY_JOIN_TYPE_VALUES,
  QUERY_KEYS,
  QUERY_MAX_JOINS,
  QUERY_PREDICATE_KEYS,
  QUERY_PREDICT_KEYS,
  QUERY_REDUCER_VALUES,
  QUERY_NUMERIC_REDUCER_VALUES,
  QUERY_SELECT_KEYS,
  PREDICTION_METHODS,
  INFERRED_FIELD_NAMES,
  DATASET_AVAILABILITY_VALUES,
  DATASET_COMPLETENESS_VALUES,
  DATASET_FRESHNESS_VALUES,
  DATASET_METADATA_KEYS,
  DISPATCH_STATUS_VALUES,
  BUILT_IN_PAGE_DATA_STATE_KEYS,
  BUILT_IN_PAGE_DEFINITION_KEYS,
  DEFAULTS_KEYS,
  CALLOUT_KEYS,
  CLI_ACTION_KEYS,
  CLI_ACTION_ARGUMENT_KEYS,
  CLI_ACTION_ARGUMENT_TYPE_VALUES,
  CLI_ACTION_PLACEMENT_VALUES,
  ERROR_CODES,
  LINK_FIELD_NAMES,
  LINK_OBJECT_KEYS,
  LINK_RELATION_VALUES,
  EVAL_RESULT_VALUES,
  FIELD_DEFINITION_KEYS,
  FIELD_DISPLAY_VALUES,
  FIELD_FORMAT_VALUES,
  FIELD_TYPE_VALUES,
  FACTORY_FLOOR_STATION_VALUES,
  FACTORY_HEADER_SOURCE_ROLES,
  FACTORY_FLOOR_SOURCE_ROLES,
  FILTER_DIMENSION_VALUES,
  DETECTION_STATE_VALUES,
  FINDING_SEVERITY_VALUES,
  FINDING_STATUS_VALUES,
  GRADER_STATUS_VALUES,
  GRAPHICAL_LAYOUT_EXEMPT_PAGE_IDS,
  IDENTIFIER_PATTERN,
  LANGUAGE_VERSION,
  MAX_ESSENTIAL_VIEWS_PER_PAGE,
  MAX_CLI_ACTIONS,
  MAX_CLI_ACTION_ARGUMENTS,
  MAX_CLI_ACTION_COMMAND_LENGTH,
  NAVIGATION_SECTION_KEYS,
  NON_ADDITIVE_MEASURE_FIELDS,
  ORDER_BY_KEYS,
  ORDER_DIRECTION_VALUES,
  OUTCOME_STATE_VALUES,
  PAGE_ROUTE_KEYS,
  PAGE_ROUTE_TITLE_FORMAT_VALUES,
  PAGE_ROUTE_TAB_KEYS,
  MAX_PAGE_ROUTE_TABS,
  PAGE_ICON_VALUES,
  PAGE_KIND_VALUES,
  PAGE_SECTION_KEYS,
  PAGE_SECTION_LAYOUT_VALUES,
  ROOT_KEYS,
  ROLLOUT_MODE_VALUES,
  RUN_CONCLUSION_VALUES,
  RUN_STATUS_VALUES,
  SCOPE_KEYS,
  SITE_CALLOUT_KEYS,
  SITE_CALLOUT_VISIBILITY_KEYS,
  SOURCE_ENTITY_IDENTIFIER_FIELDS,
  TABLE_FIELDS,
  TABLE_VALUES,
  TABLE_ACTION_KEYS,
  TABLE_ACTION_PRESENTATION_VALUES,
  TABLE_ACTION_WHEN_KEYS,
  TREE_TABLE_KEYS,
  TEMPORAL_FIELD_NAMES,
  TIME_KEYS,
  TOOLTIP_KEYS,
  UNIT_DEFINITION_KEYS,
  UNIT_FORMAT_VALUES,
  BUILT_IN_PAGE_REQUIRED_SOURCES,
  BUILT_IN_PAGE_REQUIRED_FIELDS,
  TIME_UNIT_VALUES,
  VIEW_DATA_KEYS,
  VIEW_DATA_ARGUMENT_KEYS,
  VIEW_CHART_VALUES,
  VIEW_CONTROL_VALUES,
  VIEW_LIST_DRILL_ARGUMENT_KEYS,
  VIEW_LIST_DRILL_KEYS,
  VIEW_LIST_DRILL_TYPE_VALUES,
  VIEW_LIST_LAYOUT_VALUES,
  VIEW_LIST_APPEARANCE_VALUES,
  VIEW_LIST_VIEW_ALL_KEYS,
  VIEW_DISCLOSURE_VALUES,
  VIEW_ENCODING_KEYS,
  VIEW_ELEMENT_CONFIG_KEYS,
  VIEW_ELEMENT_ANIMATION_VALUES,
  VIEW_ELEMENT_VALUES,
  PLURAL_LABEL_ELEMENTS,
  PLURAL_TEXT_KEYS,
  VIEW_KEYS,
  VIEW_LAYOUT_VALUES,
  VIEW_LIST_KEYS,
  VIEW_LIST_STYLE_VALUES,
  VIEW_MARK_VALUES,
  VIEW_METRIC_KEYS,
  VIEW_METRIC_ANIMATION_VALUES,
  VIEW_METRIC_STYLE_VALUES,
  VIEW_METRIC_TONE_VALUES,
  VIEW_TITLE_LINK_KEYS,
  WORKFLOW_ACTIVE_VALUES,
  WORKFLOW_ROLE_VALUES
} from './specification.js';
import {
  OUTCOME_DETAIL_SECTION_BODY_VALUES,
  CAMPAIGN_ROUTE_BODY_VALUES,
  WORKFLOW_ROUTE_BODY_VALUES
} from './components/route-body-specification.js';
import { cliActionTemplateFields } from './cli-action-template.js';
import { compileDashboardQueryTypes } from './query-type-checker.js';
import { findDeadDashboardQueries } from './query-usage.js';

/**
 * @param {string} command
 * @returns {string[] | null}
 */
function parseCliActionTokens(command) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaping = false;
  let tokenStarted = false;
  for (const character of command) {
    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
    } else if (character === '\\' && quote !== "'") {
      escaping = true;
      tokenStarted = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
      tokenStarted = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (escaping || quote) return null;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function validWorkflowDispatchArguments(args) {
  if (!args[0] || args[0].startsWith('-')) return false;
  const repositoryPattern =
    /^(?:[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+|\{\{[a-z][a-z0-9-]*\}\})$/;
  const inputPattern = /^[A-Za-z_][A-Za-z0-9_-]*=.*$/s;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--repo' || argument === '-R') {
      if (!repositoryPattern.test(args[index + 1] ?? '')) return false;
      index += 1;
    } else if (argument.startsWith('--repo=')) {
      if (!repositoryPattern.test(argument.slice('--repo='.length))) return false;
    } else if (argument === '--ref') {
      if (!args[index + 1] || args[index + 1].startsWith('-')) return false;
      index += 1;
    } else if (argument.startsWith('--ref=')) {
      if (argument.length === '--ref='.length) return false;
    } else if (argument === '--raw-field' || argument === '-f') {
      if (!inputPattern.test(args[index + 1] ?? '')) return false;
      index += 1;
    } else if (argument.startsWith('--raw-field=')) {
      if (!inputPattern.test(argument.slice('--raw-field='.length))) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * @typedef {{ code: string, message: string, path: string }} ValidationError
 */

/**
 * @typedef {{ ok: true, value: DashboardDocument, errors: [] } | { ok: false, errors: ValidationError[] }} ValidationResult
 */

/**
 * @typedef {{ languageVersion: string, dashboard: DashboardConfig }} DashboardDocument
 */

/**
 * @typedef {{ id: string, title: string, description?: string, defaults?: DashboardDefaults, units?: Record<string, UnitDefinition>, callouts?: SiteCallout[], pages: Array<BuiltInPage | CustomPage> }} DashboardConfig
 */

/**
 * @typedef {{ id: string, title: string, description: string, icon?: string, ['visible-when']?: { source: string, field: string, equals: unknown } }} SiteCallout
 */

/**
 * @typedef {{ name: string, symbol: string, significant: number, format?: string }} UnitDefinition
 */

/**
 * @typedef {{ scope?: Record<string, unknown>, time?: Record<string, unknown>, filters?: Record<string, unknown> }} DashboardDefaults
 */

/**
 * @typedef {{ id: string, kind: 'built-in', page: string, title?: string, description?: string }} BuiltInPage
 */

/**
 * @typedef {{ id: string, title?: string, description?: string, layout: 'full'|'wide'|'narrow', views: string[] }} PageSection
 */

/**
 * @typedef {{ id: string, kind: 'custom', title?: string, description?: string, route?: { 'hash-query-parameter': string }, views: unknown[], sections?: PageSection[] }} CustomPage
 */

/**
 * Output field schemas of the queries declared by the dashboard currently
 * being validated, keyed by query name in declaration order. Validation is
 * synchronous and non-reentrant, so this is reset for every document.
 * @type {Map<string, string[] | undefined>}
 */
let declaredQueries = new Map();
/** @type {Set<string>} */
let declaredCardTemplates = new Set();
/** @type {Map<string, Record<string, unknown>>} */
let declaredViews = new Map();

/** @type {Map<string, Set<string>>} */
let declaredQueryTables = new Map();
/** @type {Map<string, Record<string, unknown>>} */
let declaredCliActions = new Map();

/**
 * @param {string} source
 * @returns {ValidationResult}
 */
export function validateDashboardDocument(source) {
  /** @type {ValidationError[]} */
  const errors = [];

  const documents = parseDocuments(source, errors);
  if (!documents) {
    return { ok: false, errors };
  }

  const [document] = documents;
  if (!document) {
    return { ok: false, errors };
  }

  const root = document.toJS({ mapAsMap: false });
  if (!isPlainObject(root)) {
    errors.push(createError(
      ERROR_CODES.invalidDocumentShape,
      'Dashboard document must contain exactly one YAML document whose root is a mapping.',
      '$'
    ));
    return { ok: false, errors };
  }

  validateObjectKeys(document.contents, ROOT_KEYS, '$', errors);

  validateLanguageVersion(root['language-version'], errors);
  const dashboard = root.dashboard;
  if (!isPlainObject(dashboard)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'dashboard must be a mapping.',
      '$.dashboard'
    ));
    return { ok: false, errors };
  }

  try {
    validateDashboard(dashboard, getValueNodeByKey(document.contents, 'dashboard'), errors);
  } finally {
    declaredQueries = new Map();
    declaredCardTemplates = new Set();
    declaredQueryTables = new Map();
    declaredCliActions = new Map();
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      languageVersion: /** @type {string} */ (root['language-version']),
      dashboard: /** @type {DashboardConfig} */ (dashboard)
    },
    errors: []
  };
}

/**
 * Validate runtime logical-source relationships that cannot be expressed in the dashboard document.
 *
 * @param {Record<string, { rows?: unknown[] } | undefined>} sources
 * @returns {{ ok: true, errors: [] } | { ok: false, errors: ValidationError[] }}
 */
export function validateLogicalSources(sources) {
  /** @type {ValidationError[]} */
  const errors = [];
  const workflowRows = sources.workflows?.rows;
  if (workflowRows === undefined) return { ok: true, errors: [] };
  if (!Array.isArray(workflowRows)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'workflows.rows must be a sequence.',
      '$.sources.workflows.rows'
    ));
    return { ok: false, errors };
  }

  /** @type {Map<string, Array<{ row: Record<string, unknown>, index: number }>>} */
  const campaignRows = new Map();
  for (const [index, candidate] of workflowRows.entries()) {
    const path = `$.sources.workflows.rows[${index}]`;
    if (!isPlainObject(candidate)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'Each workflows row must be a mapping.',
        path
      ));
      continue;
    }

    const role = candidate['workflow-role'];
    if (typeof role !== 'string' || !WORKFLOW_ROLE_VALUES.includes(role)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'workflow-role must use orchestrator, worker, or standalone.',
        `${path}.workflow-role`
      ));
    }
    const campaignId = candidate.campaign;
    const hasCampaign = typeof campaignId === 'string' && campaignId.length > 0;
    if ((role === 'orchestrator' || role === 'worker') && !hasCampaign) {
      errors.push(createError(
        ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
        'An orchestrator or worker workflow must identify its campaign.',
        `${path}.campaign`
      ));
    }
    if (role === 'standalone' && campaignId != null) {
      errors.push(createError(
        ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
        'A standalone workflow must not identify a campaign.',
        `${path}.campaign`
      ));
    }

    const campaignIcon = candidate['campaign-icon'];
    if (campaignIcon !== undefined && (typeof campaignIcon !== 'string' || !PAGE_ICON_VALUES.includes(campaignIcon))) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'campaign-icon must name a canonical Octicon.',
        `${path}.campaign-icon`
      ));
    }

    validateNonNegativeSourceMeasure(candidate['max-ai-credits'], `${path}.max-ai-credits`, errors);
    validateNonNegativeSourceMeasure(candidate['campaign-aic-allowance'], `${path}.campaign-aic-allowance`, errors);

    if (hasCampaign && (role === 'orchestrator' || role === 'worker')) {
      const key = sourceEntityKey(candidate, 'campaign');
      const rows = campaignRows.get(key) ?? [];
      rows.push({ row: candidate, index });
      campaignRows.set(key, rows);
    }
  }

  for (const rows of campaignRows.values()) {
    const workflowAllowances = new Map(rows
      .filter(({ row }) => typeof row.workflow === 'string' && isNonNegativeFiniteNumber(row['max-ai-credits']))
      .map(({ row }) => [sourceEntityKey(row, 'workflow'), /** @type {number} */ (row['max-ai-credits'])]));
    const expectedAllowance = [...workflowAllowances.values()].reduce((total, value) => total + value, 0);
    for (const { row, index } of rows) {
      const allowance = row['campaign-aic-allowance'];
      if (isNonNegativeFiniteNumber(allowance) && !numbersEqual(allowance, expectedAllowance)) {
        errors.push(createError(
          ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
          'campaign-aic-allowance must equal the sum of available per-run workflow limits.',
          `$.sources.workflows.rows[${index}].campaign-aic-allowance`
        ));
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [] };
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateNonNegativeSourceMeasure(value, path, errors) {
  if (value == null) return;
  if (!isNonNegativeFiniteNumber(value)) {
    errors.push(createError(
      ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
      'Configured AI Credit limits must be finite non-negative numbers.',
      path
    ));
  }
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonNegativeFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} field
 * @returns {string}
 */
function sourceEntityKey(row, field) {
  return JSON.stringify([
    String(row.organization ?? ''),
    String(row.repository ?? ''),
    String(row[field] ?? '')
  ]);
}

/**
 * @param {number} left
 * @param {number} right
 * @returns {boolean}
 */
function numbersEqual(left, right) {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

/**
 * @param {string} source
 * @param {ValidationError[]} errors
 * @returns {import('yaml').Document.Parsed[] | null}
 */
function parseDocuments(source, errors) {
  try {
    const documents = parseAllDocuments(source, {
      uniqueKeys: false,
      merge: false
    });
    if (documents.some((document) => document.errors.length > 0)) {
      errors.push(createError(
        ERROR_CODES.invalidYamlSyntax,
        'Dashboard document must be valid YAML 1.2.',
        '$'
      ));
      return null;
    }

    if (documents.length !== 1) {
      errors.push(createError(
        ERROR_CODES.invalidDocumentShape,
        'Dashboard document must contain exactly one YAML document.',
        '$'
      ));
      return null;
    }

    return documents;
  } catch {
    errors.push(createError(
      ERROR_CODES.invalidYamlSyntax,
      'Dashboard document must be valid YAML 1.2.',
      '$'
    ));
    return null;
  }
}

/**
 * @param {unknown} value
 * @param {ValidationError[]} errors
 */
function validateLanguageVersion(value, errors) {
  if (typeof value !== 'string') {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'language-version must be the quoted string "0.1.0".',
      '$.language-version'
    ));
    return;
  }

  if (value !== LANGUAGE_VERSION) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'language-version must use the exact canonical value "0.1.0".',
      '$.language-version'
    ));
  }
}

/**
 * @param {unknown} templates
 * @param {unknown} templatesNode
 * @param {ValidationError[]} errors
 */
function validateCardTemplates(templates, templatesNode, errors) {
  const ids = new Set();
  if (templates === undefined) return ids;
  if (!Array.isArray(templates) || templates.length === 0) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card-templates must be a non-empty sequence.', '$.dashboard.card-templates'));
    return ids;
  }

  /**
   * @param {unknown} actions
   * @param {unknown} actionsNode
   * @param {string} path
   * @param {ValidationError[]} errors
   */
  function validateCardTemplateActions(actions, actionsNode, path, errors) {
    if (actions === undefined) return;
    if (!Array.isArray(actions) || actions.length === 0) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card template actions must be a non-empty sequence.', path));
      return;
    }
    actions.forEach((action, index) => {
      const actionPath = `${path}[${index}]`;
      const actionNode = getSequenceItemNode(actionsNode, index);
      if (!isPlainObject(action)) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card template action must be a mapping.', actionPath));
        return;
      }
      validateObjectKeys(actionNode, CARD_TEMPLATE_ACTION_KEYS, actionPath, errors);
      validateRequiredIdentifier(action.action, `${actionPath}.action`, 'card template CLI action reference', errors);
      const declaredAction = typeof action.action === 'string' ? declaredCliActions.get(action.action) : undefined;
      if (typeof action.action === 'string' && !declaredAction) {
        errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'card template action must reference a declared dashboard CLI action.', `${actionPath}.action`));
      } else if (declaredAction?.placement !== 'row') {
        errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'card template action must reference a row-placed dashboard CLI action.', `${actionPath}.action`));
      }
      const context = action.context;
      if (!Array.isArray(context) || context.length === 0) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card template action context must be a non-empty sequence of source fields.', `${actionPath}.context`));
      } else {
        context.forEach((field, fieldIndex) => validateRequiredIdentifier(
          field,
          `${actionPath}.context[${fieldIndex}]`,
          'card template action context field',
          errors
        ));
        const command = declaredAction?.command;
        const templateFields = typeof command === 'string' ? cliActionTemplateFields(command) : [];
        if (templateFields.some((field) => !context.includes(field))) {
          errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'card template action context must include every command template field.', `${actionPath}.context`));
        }
      }
      if (action.when === undefined) return;
      if (!isPlainObject(action.when)) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card template action when must be a mapping.', `${actionPath}.when`));
        return;
      }
      validateObjectKeys(getValueNodeByKey(actionNode, 'when'), TABLE_ACTION_WHEN_KEYS, `${actionPath}.when`, errors);
      validateRequiredIdentifier(action.when.field, `${actionPath}.when.field`, 'card template action when field', errors);
      if (!Object.hasOwn(action.when, 'equals') || ['object', 'function', 'symbol'].includes(typeof action.when.equals)) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card template action when equals must be a scalar.', `${actionPath}.when.equals`));
      }
    });
  }
  templates.forEach((template, index) => {
    const path = `$.dashboard.card-templates[${index}]`;
    const templateNode = getSequenceItemNode(templatesNode, index);
    if (!isPlainObject(template)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card template must be a mapping.', path));
      return;
    }
    validateObjectKeys(templateNode, CARD_TEMPLATE_KEYS, path, errors);
    validateRequiredIdentifier(template.id, `${path}.id`, 'card template id', errors);
    validateStringField(template.icon, `${path}.icon`, true, errors);
    if (typeof template.icon === 'string' && !PAGE_ICON_VALUES.includes(template.icon)) {
      errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'card template icon must use one canonical Octicon name.', `${path}.icon`));
    }
    if (template['icon-field'] !== undefined) {
      validateRequiredIdentifier(template['icon-field'], `${path}.icon-field`, 'card template icon field', errors);
    }
    if (typeof template.id === 'string') {
      if (ids.has(template.id)) errors.push(createError(ERROR_CODES.unknownOrDuplicateKey, 'card template id must be unique.', `${path}.id`));
      ids.add(template.id);
    }
    validateCardTemplateField(template.title, getValueNodeByKey(templateNode, 'title'), `${path}.title`, errors);
    if (template.subtitle !== undefined) {
      validateCardTemplateField(template.subtitle, getValueNodeByKey(templateNode, 'subtitle'), `${path}.subtitle`, errors);
    }
    if (template['detail-labels'] !== undefined && !CARD_DETAIL_LABEL_VALUES.includes(String(template['detail-labels']))) {
      errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'card template detail-labels must be hidden or visible.', `${path}.detail-labels`));
    }
    validateCardTemplateStatus(template.status, getValueNodeByKey(templateNode, 'status'), `${path}.status`, errors);
    validateCardTemplateTiming(template.timing, getValueNodeByKey(templateNode, 'timing'), `${path}.timing`, errors);
    validateCardTemplateActions(template.actions, getValueNodeByKey(templateNode, 'actions'), `${path}.actions`, errors);
    validateListDrill(template.drill, getValueNodeByKey(templateNode, 'drill'), path, 'entity-cards', errors);
    for (const key of ['labels', 'details']) {
      const fields = template[key];
      if (!Array.isArray(fields) || (key === 'details' && fields.length === 0)) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, `card template ${key} must be ${key === 'details' ? 'a non-empty' : 'an'} sequence.`, `${path}.${key}`));
        continue;
      }
      fields.forEach((field, fieldIndex) => validateCardTemplateField(
        field,
        getSequenceItemNode(getValueNodeByKey(templateNode, key), fieldIndex),
        `${path}.${key}[${fieldIndex}]`,
        errors
      ));
    }
  });
  return ids;
}

/**
 * A card template status declaration names the field whose observed value
 * selects the card's status icon and tone, with an optional fallback field for
 * entities whose terminal value is not yet observed.
 * @param {unknown} status
 * @param {unknown} statusNode
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateCardTemplateStatus(status, statusNode, path, errors) {
  if (status === undefined) return;
  if (!isPlainObject(status)) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card template status must be a mapping.', path));
    return;
  }
  validateObjectKeys(statusNode, CARD_STATUS_KEYS, path, errors);
  validateRequiredIdentifier(status.field, `${path}.field`, 'card template status field', errors);
  if (status['fallback-field'] !== undefined) {
    validateRequiredIdentifier(status['fallback-field'], `${path}.fallback-field`, 'card template status fallback field', errors);
  }
  validateOptionalStringField(status.title, `${path}.title`, errors);
}

/**
 * A card template timing declaration is an ordered sequence of icon-labeled
 * field definitions presented beside the card, such as the start time and the
 * elapsed duration of a run.
 * @param {unknown} timing
 * @param {unknown} timingNode
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateCardTemplateTiming(timing, timingNode, path, errors) {
  if (timing === undefined) return;
  if (!Array.isArray(timing) || timing.length === 0) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card template timing must be a non-empty sequence.', path));
    return;
  }
  timing.forEach((field, index) => {
    const fieldPath = `${path}[${index}]`;
    const fieldNode = getSequenceItemNode(timingNode, index);
    validateCardTemplateField(field, fieldNode, fieldPath, errors, CARD_TIMING_FIELD_KEYS);
    if (!isPlainObject(field)) return;
    validateStringField(field.icon, `${fieldPath}.icon`, true, errors);
    if (typeof field.icon === 'string' && !PAGE_ICON_VALUES.includes(field.icon)) {
      errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'card template timing icon must use one canonical Octicon name.', `${fieldPath}.icon`));
    }
  });
}

/**
 * @param {unknown} field
 * @param {unknown} fieldNode
 * @param {string} path
 * @param {ValidationError[]} errors
 * @param {string[]} [allowedKeys]
 */
function validateCardTemplateField(field, fieldNode, path, errors, allowedKeys = FIELD_DEFINITION_KEYS) {
  if (!isPlainObject(field)) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'card template field must be a mapping.', path));
    return;
  }

  validateObjectKeys(fieldNode, allowedKeys, path, errors);
  validateRequiredIdentifier(field.field, `${path}.field`, 'card template field', errors);
  validateOptionalStringField(field.title, `${path}.title`, errors);
  if (field.display !== undefined && (typeof field.display !== 'string' || !FIELD_DISPLAY_VALUES.includes(field.display))) {
    errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'card template field display must use one canonical display value.', `${path}.display`));
  }

  if (field.format !== undefined && (typeof field.format !== 'string' || !FIELD_FORMAT_VALUES.includes(field.format))) {
    errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'card template field format must use one canonical format value.', `${path}.format`));
  }
}

/**
 * @param {unknown} views
 * @param {unknown} viewsNode
 * @param {ValidationError[]} errors
 */
function validateReusableViews(views, viewsNode, errors) {
  const definitions = new Map();
  if (views === undefined) return definitions;
  if (!Array.isArray(views) || views.length === 0) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'views must be a non-empty sequence.', '$.dashboard.views'));
    return definitions;
  }
  const ids = new Set();
  views.forEach((view, index) => {
    const path = `$.dashboard.views[${index}]`;
    validateView(view, getSequenceItemNode(viewsNode, index), path, ids, errors);
    if (isPlainObject(view) && typeof view.id === 'string' && !definitions.has(view.id)) {
      definitions.set(view.id, view);
    }
  });
  return definitions;
}

/** @param {unknown} page */
function resolveReusablePageViews(page) {
  if (!isPlainObject(page)) return page;
  const definition = page.kind === 'built-in' && isPlainObject(page.definition)
    ? page.definition
    : null;
  const views = definition?.views ?? page.views;
  if (!Array.isArray(views)) return page;
  const resolvedViews = views.map((view) => typeof view === 'string' ? declaredViews.get(view) ?? view : view);
  return definition
    ? { ...page, definition: { ...definition, views: resolvedViews } }
    : { ...page, views: resolvedViews };
}

/**
 * @param {Record<string, unknown>} dashboard
 * @param {unknown} dashboardNode
 * @param {ValidationError[]} errors
 */
function validateDashboard(dashboard, dashboardNode, errors) {
  validateObjectKeys(dashboardNode, DASHBOARD_KEYS, '$.dashboard', errors);

  validateRequiredIdentifier(dashboard.id, '$.dashboard.id', 'dashboard id', errors);
  validateStringField(dashboard.title, '$.dashboard.title', true, errors);
  validateOptionalStringField(dashboard.description, '$.dashboard.description', errors);

  if (dashboard.horizon !== undefined) {
    if (!isPlainObject(dashboard.horizon)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'horizon must be a mapping.',
        '$.dashboard.horizon'
      ));
    } else {
      validateObjectKeys(
        getValueNodeByKey(dashboardNode, 'horizon'),
        DASHBOARD_HORIZON_KEYS,
        '$.dashboard.horizon',
        errors
      );
      validateStringField(dashboard.horizon.label, '$.dashboard.horizon.label', true, errors);
      validateTooltip(
        dashboard.horizon.tooltip,
        getValueNodeByKey(getValueNodeByKey(dashboardNode, 'horizon'), 'tooltip'),
        '$.dashboard.horizon.tooltip',
        errors
      );
    }

  }

  if (dashboard['github-url-base'] !== undefined && !isSafeGithubUrlBase(dashboard['github-url-base'])) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'github-url-base must be an absolute HTTPS URL without credentials, query, or fragment.',
      '$.dashboard.github-url-base'
    ));
  }

  if (dashboard.repository !== undefined && !isSafeRepositorySlug(dashboard.repository)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'repository must be a non-empty owner/repo slug identifying the GitHub repository hosting the dashboard.',
      '$.dashboard.repository'
    ));
  }

  if (dashboard.defaults !== undefined) {
    if (!isPlainObject(dashboard.defaults)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'defaults must be a mapping.',
        '$.dashboard.defaults'
      ));
    } else {
      const defaultsNode = getValueNodeByKey(dashboardNode, 'defaults');
      validateObjectKeys(
        defaultsNode,
        DEFAULTS_KEYS,
        '$.dashboard.defaults',
        errors
      );
      validateContext(defaultsNode, dashboard.defaults, '$.dashboard.defaults', errors);
    }
  }

  declaredQueries = validateQueries(dashboard.queries, getValueNodeByKey(dashboardNode, 'queries'), errors);
  const queryTypes = compileDashboardQueryTypes(dashboard.queries);
  for (const queryError of queryTypes.errors) {
    const existingIndex = errors.findIndex((candidate) => (
      candidate.code === queryError.code && candidate.path === queryError.path
    ));
    if (existingIndex === -1) {
      errors.push(queryError);
    } else {
      errors[existingIndex] = queryError;
    }
  }
  declaredQueries = queryTypes.queryFields;
  declaredQueryTables = queryTypes.queryTables;
  for (const query of findDeadDashboardQueries(dashboard)) {
    errors.push(createError(
      ERROR_CODES.unusedQuery,
      `query "${query.name}" is not used by a view, callout, or another retained query.`,
      query.path
    ));
  }
  validateCliActions(dashboard['cli-actions'], getValueNodeByKey(dashboardNode, 'cli-actions'), errors);
  declaredCardTemplates = validateCardTemplates(
    dashboard['card-templates'],
    getValueNodeByKey(dashboardNode, 'card-templates'),
    errors
  );
  declaredViews = validateReusableViews(
    dashboard.views,
    getValueNodeByKey(dashboardNode, 'views'),
    errors
  );
  const unitIds = validateUnits(dashboard.units, getValueNodeByKey(dashboardNode, 'units'), errors);
  validateSiteCallouts(dashboard.callouts, getValueNodeByKey(dashboardNode, 'callouts'), errors);

  if (!Array.isArray(dashboard.pages) || dashboard.pages.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'pages must be a non-empty sequence.',
      '$.dashboard.pages'
    ));
    return;
  }

  /**
   * @param {unknown} actions
   * @param {unknown} actionsNode
   * @param {ValidationError[]} errors
   */
  function validateCliActions(actions, actionsNode, errors) {
    if (actions === undefined) return;
    if (!Array.isArray(actions) || actions.length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'cli-actions must be a non-empty sequence.',
        '$.dashboard.cli-actions'
      ));
      return;
    }
    if (actions.length > MAX_CLI_ACTIONS) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `cli-actions is limited to ${MAX_CLI_ACTIONS} actions.`,
        '$.dashboard.cli-actions'
      ));
    }

    const ids = new Set();
    actions.forEach((action, index) => {
      const path = `$.dashboard.cli-actions[${index}]`;
      const actionNode = getSequenceItemNode(actionsNode, index);
      if (!isPlainObject(action)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'CLI action must be a mapping.',
          path
        ));
        return;
      }
      validateObjectKeys(actionNode, CLI_ACTION_KEYS, path, errors);
      validateRequiredIdentifier(action.id, `${path}.id`, 'CLI action id', errors);
      if (typeof action.id === 'string') {
        if (ids.has(action.id)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action id must be unique within dashboard.cli-actions.',
            `${path}.id`
          ));
        }
        ids.add(action.id);
        declaredCliActions.set(action.id, action);
      }
      validateStringField(action.label, `${path}.label`, true, errors);
      validateOptionalStringField(action.description, `${path}.description`, errors);
      validateStringField(action.icon, `${path}.icon`, true, errors);
      if (typeof action.icon === 'string' && !PAGE_ICON_VALUES.includes(action.icon)) {
        errors.push(createError(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          'CLI action icon must use one canonical icon value.',
          `${path}.icon`
        ));
      }
      if (action.placement !== undefined) {
        validateStringField(action.placement, `${path}.placement`, true, errors);
        if (typeof action.placement === 'string' && !CLI_ACTION_PLACEMENT_VALUES.includes(action.placement)) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            'CLI action placement must use toolbar, settings, view, or row.',
            `${path}.placement`
          ));
        }
      }
      validateStringField(action.command, `${path}.command`, true, errors);
      if (typeof action.command === 'string') {
        if (action.command.length > MAX_CLI_ACTION_COMMAND_LENGTH) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            `CLI action command is limited to ${MAX_CLI_ACTION_COMMAND_LENGTH} characters.`,
            `${path}.command`
          ));
        }
        const commandTokens = parseCliActionTokens(action.command);
        const isGhAwCommand =
          commandTokens?.[0] === 'gh' && commandTokens[1] === 'aw' && commandTokens.length >= 3;
        const isCaoCommand =
          commandTokens?.[0] === './cao.sh' && commandTokens.length >= 2;
        const isWorkflowDispatchCommand =
          commandTokens?.[0] === 'gh'
          && commandTokens[1] === 'workflow'
          && commandTokens[2] === 'run';
        if (!isCaoCommand && !isGhAwCommand && !isWorkflowDispatchCommand) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action command must start with "./cao.sh", "gh aw", or "gh workflow run".',
            `${path}.command`
          ));
        }
        if (
          isWorkflowDispatchCommand
          && !validWorkflowDispatchArguments(commandTokens.slice(3))
        ) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action workflow dispatch command has an invalid workflow or option.',
            `${path}.command`
          ));
        }
        if (
          isWorkflowDispatchCommand
          && Array.isArray(action.arguments)
          && action.arguments.length > 0
        ) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action workflow dispatch commands do not support boolean arguments.',
            `${path}.arguments`
          ));
        }
        if (/[\r\n]/.test(action.command) || action.command.includes('\0')) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action command must be a single line without null characters.',
            `${path}.command`
          ));
        }
        if (/[!;&|`$<>]/.test(action.command)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action command must not contain shell control operators.',
            `${path}.command`
          ));
        }
        const withoutTemplates = action.command.replace(/\{\{[a-z][a-z0-9]*(?:-[a-z0-9]+)*\}\}/g, '');
        if (/[{}]/.test(withoutTemplates)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action command contains an invalid template token.',
            `${path}.command`
          ));
        }
      }
      validateCliActionArguments(
        action.arguments,
        getValueNodeByKey(actionNode, 'arguments'),
        `${path}.arguments`,
        errors
      );
    });
  }

  /**
   * @param {unknown} actionArguments
   * @param {unknown} argumentsNode
   * @param {string} path
   * @param {ValidationError[]} errors
   */
  function validateCliActionArguments(actionArguments, argumentsNode, path, errors) {
    if (actionArguments === undefined) return;
    if (!Array.isArray(actionArguments) || actionArguments.length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'CLI action arguments must be a non-empty sequence.',
        path
      ));
      return;
    }
    if (actionArguments.length > MAX_CLI_ACTION_ARGUMENTS) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `CLI action arguments are limited to ${MAX_CLI_ACTION_ARGUMENTS} controls.`,
        path
      ));
    }
    const ids = new Set();
    const flags = new Set();
    actionArguments.forEach((argument, index) => {
      const argumentPath = `${path}[${index}]`;
      const argumentNode = getSequenceItemNode(argumentsNode, index);
      if (!isPlainObject(argument)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'CLI action argument must be a mapping.',
          argumentPath
        ));
        return;
      }
      validateObjectKeys(argumentNode, CLI_ACTION_ARGUMENT_KEYS, argumentPath, errors);
      validateRequiredIdentifier(argument.id, `${argumentPath}.id`, 'CLI action argument id', errors);
      if (typeof argument.id === 'string') {
        if (ids.has(argument.id)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action argument id must be unique within the action.',
            `${argumentPath}.id`
          ));
        }
        ids.add(argument.id);
      }
      validateStringField(argument.label, `${argumentPath}.label`, true, errors);
      validateOptionalStringField(argument.description, `${argumentPath}.description`, errors);
      validateStringField(argument.type, `${argumentPath}.type`, true, errors);
      if (typeof argument.type === 'string' && !CLI_ACTION_ARGUMENT_TYPE_VALUES.includes(argument.type)) {
        errors.push(createError(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          'CLI action argument type must be boolean.',
          `${argumentPath}.type`
        ));
      }
      validateStringField(argument.flag, `${argumentPath}.flag`, true, errors);
      if (typeof argument.flag === 'string') {
        if (!/^--[a-z0-9]+(?:-[a-z0-9]+)*$/.test(argument.flag)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action argument flag must be a canonical long option.',
            `${argumentPath}.flag`
          ));
        }
        if (flags.has(argument.flag)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'CLI action argument flag must be unique within the action.',
            `${argumentPath}.flag`
          ));
        }
        flags.add(argument.flag);
      }
      if (argument.default !== undefined && typeof argument.default !== 'boolean') {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'Boolean CLI action argument default must be a boolean.',
          `${argumentPath}.default`
        ));
      }
    });
  }

  /** @type {Set<string>} */
  const pageIds = new Set();
  dashboard.pages.forEach((page, index) => {
    if (isPlainObject(page)) {
      const configuredViews = page.kind === 'built-in' && isPlainObject(page.definition)
        ? page.definition.views
        : page.views;
      if (Array.isArray(configuredViews)) {
        configuredViews.forEach((view, viewIndex) => {
          if (typeof view === 'string' && !declaredViews.has(view)) {
            errors.push(createError(
              ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
              'page view must reference a declared reusable dashboard view.',
              `$.dashboard.pages[${index}]${page.kind === 'built-in' ? '.definition' : ''}.views[${viewIndex}]`
            ));
          }
        });
      }
    }
    validatePage(resolveReusablePageViews(page), getSequenceItemNode(getValueNodeByKey(dashboardNode, 'pages'), index), `$.dashboard.pages[${index}]`, pageIds, errors);
  });
  (Array.isArray(dashboard['card-templates']) ? dashboard['card-templates'] : []).forEach((template, index) => {
    if (!isPlainObject(template) || !isPlainObject(template.drill)) return;
    const fields = [
      template.title,
      template.subtitle,
      template.status,
      ...(Array.isArray(template.labels) ? template.labels : []),
      ...(Array.isArray(template.details) ? template.details : []),
      ...(Array.isArray(template.timing) ? template.timing : [])
    ].flatMap((field) => (
      isPlainObject(field) && typeof field.field === 'string' ? [field.field] : []
    ));
    validateQueryDrillReferences(
      template.drill,
      `$.dashboard.card-templates[${index}].drill`,
      dashboard,
      pageIds,
      declaredQueries,
      fields,
      errors
    );
  });
  dashboard.pages.forEach((page, index) => {
    page = resolveReusablePageViews(page);
    if (!isPlainObject(page)) return;
    if (isPlainObject(page.route) && typeof page.route['navigation-page'] === 'string') {
      const navigationPage = page.route['navigation-page'];
      if (IDENTIFIER_PATTERN.test(navigationPage)) {
        if (navigationPage === page.id) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'route navigation-page must reference a different dashboard page.',
            `$.dashboard.pages[${index}].route.navigation-page`
          ));
        } else if (!pageIds.has(navigationPage)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'route navigation-page must reference a declared dashboard page id.',
            `$.dashboard.pages[${index}].route.navigation-page`
          ));
        }
      }
    }
    if (isPlainObject(page.route) && Array.isArray(page.route.tabs)) {
      page.route.tabs.forEach((tab, tabIndex) => {
        if (!isPlainObject(tab) || typeof tab.page !== 'string' || !IDENTIFIER_PATTERN.test(tab.page)) return;
        if (!pageIds.has(tab.page)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'route tab page must reference a declared dashboard page id.',
            `$.dashboard.pages[${index}].route.tabs[${tabIndex}].page`
          ));
        }
      });
    }
    const views = page.kind === 'built-in' && isPlainObject(page.definition)
      ? page.definition.views
      : page.views;
    if (Array.isArray(views)) {
      views.forEach((view, viewIndex) => {
        const viewPath = page.kind === 'built-in'
          ? `$.dashboard.pages[${index}].definition.views[${viewIndex}]`
          : `$.dashboard.pages[${index}].views[${viewIndex}]`;
        const navigationPage = isPlainObject(view) && isPlainObject(view.metric)
          ? view.metric['navigation-page']
          : undefined;
        if (typeof navigationPage === 'string' && IDENTIFIER_PATTERN.test(navigationPage) && !pageIds.has(navigationPage)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'metric navigation-page must reference a declared dashboard page id.',
            `${viewPath}.metric.navigation-page`
          ));
        }
        const viewAllPage = isPlainObject(view) && isPlainObject(view.list) && isPlainObject(view.list['view-all'])
          ? view.list['view-all'].page
          : undefined;
        if (typeof viewAllPage === 'string' && IDENTIFIER_PATTERN.test(viewAllPage) && !pageIds.has(viewAllPage)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'list view-all page must reference a declared dashboard page id.',
            `${viewPath}.list.view-all.page`
          ));
        }
        const drill = isPlainObject(view) && isPlainObject(view['card-drill'])
          ? view['card-drill']
          : isPlainObject(view) && isPlainObject(view.list) && isPlainObject(view.list.drill)
            ? view.list.drill
          : null;
        const drillPath = isPlainObject(view) && isPlainObject(view['card-drill'])
          ? `${viewPath}.card-drill`
          : `${viewPath}.list.drill`;
        if (drill?.type === 'query') {
          const sourceName = isPlainObject(view.data) && typeof view.data.source === 'string'
            ? view.data.source
            : null;
          const fields = sourceName ? sourceFieldNames(sourceName) : null;
          validateQueryDrillReferences(drill, drillPath, dashboard, pageIds, declaredQueries, fields, errors);
        }
      });
    }
  });
  if (Array.isArray(dashboard.callouts)) {
    dashboard.callouts.forEach((callout, index) => {
      if (!isPlainObject(callout) || typeof callout['navigation-page'] !== 'string') return;
      if (IDENTIFIER_PATTERN.test(callout['navigation-page']) && !pageIds.has(callout['navigation-page'])) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'callout navigation-page must reference a declared dashboard page id.',
          `$.dashboard.callouts[${index}].navigation-page`
        ));
      }
    });
  }
  validateUnitReferences(dashboard.pages, unitIds, errors);

  if (dashboard.navigation !== undefined) {
    validateNavigation(dashboard.navigation, getValueNodeByKey(dashboardNode, 'navigation'), pageIds, errors);
  }

  /**
   * @param {unknown} callouts
   * @param {unknown} calloutsNode
   * @param {ValidationError[]} errors
   */
  function validateSiteCallouts(callouts, calloutsNode, errors) {
    if (callouts === undefined) return;
    if (!Array.isArray(callouts) || callouts.length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'callouts must be a non-empty sequence.',
        '$.dashboard.callouts'
      ));
      return;
    }
    const calloutIds = new Set();
    callouts.forEach((callout, index) => {
      const path = `$.dashboard.callouts[${index}]`;
      const calloutNode = getSequenceItemNode(calloutsNode, index);
      if (!isPlainObject(callout)) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'callout must be a mapping.', path));
        return;
      }
      validateObjectKeys(calloutNode, SITE_CALLOUT_KEYS, path, errors);
      validateRequiredIdentifier(callout.id, `${path}.id`, 'callout id', errors);
      if (typeof callout.id === 'string' && calloutIds.has(callout.id)) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'callout id must be unique within dashboard.callouts.', `${path}.id`));
      } else if (typeof callout.id === 'string') {
        calloutIds.add(callout.id);
      }
      validateStringField(callout.title, `${path}.title`, true, errors);
      validateStringField(callout.description, `${path}.description`, true, errors);
      validateOptionalStringField(callout.icon, `${path}.icon`, errors);
      if (callout['navigation-page'] !== undefined) {
        validateRequiredIdentifier(callout['navigation-page'], `${path}.navigation-page`, 'navigation-page', errors);
      }
      if (typeof callout.icon === 'string' && !PAGE_ICON_VALUES.includes(callout.icon)) {
        errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'callout icon must use one canonical icon value.', `${path}.icon`));
      }
      validateSiteCalloutVisibility(callout['visible-when'], getValueNodeByKey(calloutNode, 'visible-when'), `${path}.visible-when`, errors);
    });
  }

  /**
   * @param {unknown} visibility
   * @param {unknown} visibilityNode
   * @param {string} path
   * @param {ValidationError[]} errors
   */
  function validateSiteCalloutVisibility(visibility, visibilityNode, path, errors) {
    if (visibility === undefined) return;
    if (!isPlainObject(visibility)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'visible-when must be a mapping.', path));
      return;
    }
    validateObjectKeys(visibilityNode, SITE_CALLOUT_VISIBILITY_KEYS, path, errors);
    validateSource(visibility.source, `${path}.source`, errors);
    validateStringField(visibility.field, `${path}.field`, true, errors);
    if (
      typeof visibility.source === 'string'
      && (TABLE_VALUES.includes(visibility.source) || declaredQueries.has(visibility.source))
      && typeof visibility.field === 'string'
      && !sourceFieldNames(visibility.source)?.includes(visibility.field)
    ) {
      errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'visible-when field must be declared by visible-when source.', `${path}.field`));
    }
    if (!Object.hasOwn(visibility, 'equals') || ['object', 'function', 'symbol'].includes(typeof visibility.equals)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'visible-when equals must be a scalar.', `${path}.equals`));
    }
  }

  /**
   * @param {unknown} units
   * @param {unknown} unitsNode
   * @param {ValidationError[]} errors
   * @returns {Set<string>}
   */
  function validateUnits(units, unitsNode, errors) {
    const unitIds = new Set();
    if (units === undefined) return unitIds;
    if (!isPlainObject(units) || Object.keys(units).length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'units must be a non-empty mapping of unit identifiers to definitions.',
        '$.dashboard.units'
      ));
      return unitIds;
    }

    for (const [unitId, definition] of Object.entries(units)) {
      const path = `$.dashboard.units.${unitId}`;
      if (!IDENTIFIER_PATTERN.test(unitId)) {
        errors.push(createError(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          'unit identifiers must use canonical kebab-case.',
          path
        ));
      } else {
        unitIds.add(unitId);
      }
      if (!isPlainObject(definition)) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'unit definitions must be mappings.', path));
        continue;
      }

      validateObjectKeys(getValueNodeByKey(unitsNode, unitId), UNIT_DEFINITION_KEYS, path, errors);
      validateStringField(definition.name, `${path}.name`, true, errors);
      validateStringField(definition.symbol, `${path}.symbol`, true, errors);
      if (typeof definition.significant !== 'number' || !Number.isFinite(definition.significant) || definition.significant <= 0) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'unit significant must be a finite positive number.',
          `${path}.significant`
        ));
      }
      if (definition.format !== undefined) {
        validateStringField(definition.format, `${path}.format`, true, errors);
        if (typeof definition.format === 'string' && !UNIT_FORMAT_VALUES.includes(definition.format)) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            'unit format must use one canonical unit format value.',
            `${path}.format`
          ));
        }
        if (definition.format === 'duration' && (definition.symbol !== 's' || definition.significant !== 1)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'duration units must use symbol "s" and significant 1.',
            path
          ));
        }
        if (definition.format === 'usd' && (definition.symbol !== 'USD' || definition.significant !== 0.001)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'USD units must use symbol "USD" and significant 0.001.',
            path
          ));
        }
        if (definition.format === 'aicc' && (definition.name !== 'AICc($)' || definition.significant !== 2)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'AIC cost units must use name "AICc($)" and significant 2.',
            path
          ));
        }
      }
    }
    return unitIds;
  }

  /**
   * @param {unknown[]} pages
   * @param {Set<string>} unitIds
   * @param {ValidationError[]} errors
   */
  function validateUnitReferences(pages, unitIds, errors) {
    pages.forEach((page, pageIndex) => {
      if (!isPlainObject(page)) return;
      const views = page.kind === 'built-in' && isPlainObject(page.definition)
        ? page.definition.views
        : page.views;
      if (!Array.isArray(views)) return;
      const viewsPath = page.kind === 'built-in'
        ? `$.dashboard.pages[${pageIndex}].definition.views`
        : `$.dashboard.pages[${pageIndex}].views`;
      views.forEach((view, viewIndex) => {
        if (!isPlainObject(view) || !isPlainObject(view.encoding)) return;
        for (const [channel, value] of Object.entries(view.encoding)) {
          const definitions = channel === 'columns' && Array.isArray(value) ? value : [value];
          definitions.forEach((definition, definitionIndex) => {
            if (!isPlainObject(definition) || definition.unit === undefined) return;
            const path = `${viewsPath}[${viewIndex}].encoding.${channel}${channel === 'columns' ? `[${definitionIndex}]` : ''}.unit`;
            if (typeof definition.unit === 'string' && !unitIds.has(definition.unit)) {
              errors.push(createError(
                ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
                'unit must reference a unit declared by dashboard.units.',
                path
              ));
            }
          });
        }
      });
    });
  }
}

/**
 * @param {unknown} tooltip
 * @param {unknown} tooltipNode
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateTooltip(tooltip, tooltipNode, path, errors) {
  if (!isPlainObject(tooltip)) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'tooltip must be a mapping.', path));
    return;
  }
  validateObjectKeys(tooltipNode, TOOLTIP_KEYS, path, errors);
  validateStringField(tooltip.label, `${path}.label`, true, errors);
  validateStringField(tooltip.description, `${path}.description`, true, errors);
  validateOptionalStringField(tooltip.icon, `${path}.icon`, errors);
  if (typeof tooltip.icon === 'string' && !PAGE_ICON_VALUES.includes(tooltip.icon)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'tooltip icon must use one canonical icon value.',
      `${path}.icon`
    ));
  }
}

/**
 * @param {unknown} navigation
 * @param {unknown} navigationNode
 * @param {Set<string>} pageIds
 * @param {ValidationError[]} errors
 */
function validateNavigation(navigation, navigationNode, pageIds, errors) {
  const path = '$.dashboard.navigation';
  if (!Array.isArray(navigation) || navigation.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'navigation must be a non-empty sequence of sidebar sections.',
      path
    ));
    return;
  }

  /** @type {Set<string>} */
  const referencedPageIds = new Set();
  navigation.forEach((section, index) => {
    const sectionPath = `${path}[${index}]`;
    const sectionNode = getSequenceItemNode(navigationNode, index);
    if (!isPlainObject(section)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'navigation section must be a mapping.', sectionPath));
      return;
    }

    validateObjectKeys(sectionNode, NAVIGATION_SECTION_KEYS, sectionPath, errors);
    validateOptionalStringField(section.label, `${sectionPath}.label`, errors);
    if (section.label === '') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'navigation section label must be a non-empty string when present.',
        `${sectionPath}.label`
      ));
    }
    if (section.experimental !== undefined && typeof section.experimental !== 'boolean') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'navigation section experimental must be a boolean.',
        `${sectionPath}.experimental`
      ));
    }
    if (section.placement !== undefined && section.placement !== 'bottom') {
      const found = typeof section.placement === 'string'
        ? `"${section.placement}"`
        : JSON.stringify(section.placement);
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        `navigation section placement must be "bottom" when present; found ${found}.`,
        `${sectionPath}.placement`
      ));
    }
    if (section.placement === 'bottom' && typeof section.label !== 'string') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'navigation section placement requires a non-empty label.',
        `${sectionPath}.label`
      ));
    }

    if (!Array.isArray(section.pages) || section.pages.length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'navigation section pages must reference at least one declared page id.',
        `${sectionPath}.pages`
      ));
      return;
    }

    section.pages.forEach((pageId, pageIndex) => {
      const pageIdPath = `${sectionPath}.pages[${pageIndex}]`;
      if (typeof pageId !== 'string' || !pageIds.has(pageId)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'navigation section page must reference a declared dashboard page id.',
          pageIdPath
        ));
        return;
      }
      if (referencedPageIds.has(pageId)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'each dashboard page may appear in only one navigation section.',
          pageIdPath
        ));
      }
      referencedPageIds.add(pageId);
    });
  });

}

/**
 * @param {unknown} page
 * @param {unknown} pageNode
 * @param {string} path
 * @param {Set<string>} pageIds
 * @param {ValidationError[]} errors
 */
function validatePage(page, pageNode, path, pageIds, errors) {
  if (!isPlainObject(page)) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'page must be a mapping.', path));
    return;
  }

  validateStringField(page.kind, `${path}.kind`, true, errors);
  if (typeof page.kind === 'string' && !PAGE_KIND_VALUES.includes(page.kind)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'kind must be exactly "built-in" or "custom".',
      `${path}.kind`
    ));
  }

  validateRequiredIdentifier(page.id, `${path}.id`, 'page id', errors);
  if (typeof page.id === 'string') {
    if (pageIds.has(page.id)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'page id must be unique within dashboard.pages.',
        `${path}.id`
      ));
    }
    pageIds.add(page.id);
  }

  validateOptionalStringField(page.title, `${path}.title`, errors);
  validateOptionalStringField(page['navigation-label'], `${path}.navigation-label`, errors);
  validateOptionalStringField(page.description, `${path}.description`, errors);
  if (page['class-name'] !== undefined) {
    validateRequiredIdentifier(page['class-name'], `${path}.class-name`, 'page class name', errors);
  }
  if (page['filter-bar'] !== undefined && typeof page['filter-bar'] !== 'boolean') {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'filter-bar must be a Boolean when present.',
      `${path}.filter-bar`
    ));
  }
  if (page.icon !== undefined) {
    validateStringField(page.icon, `${path}.icon`, true, errors);
    if (typeof page.icon === 'string' && !PAGE_ICON_VALUES.includes(page.icon)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'icon must use one canonical page icon value.',
        `${path}.icon`
      ));
    }
  }
  if (page.kind === 'built-in') {
    validateObjectKeys(pageNode, BUILT_IN_PAGE_KEYS, path, errors);
    validateBuiltInPage(page, path, errors);
    return;
  }

  if (page.kind === 'custom') {
    validateObjectKeys(pageNode, CUSTOM_PAGE_KEYS, path, errors);
    validateCustomPage(page, pageNode, path, errors);
    return;
  }

  validateObjectKeys(pageNode, [...BUILT_IN_PAGE_KEYS, ...CUSTOM_PAGE_KEYS], path, errors);
}


/**
 * @param {Record<string, unknown>} page
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateBuiltInPage(page, path, errors) {
  validateStringField(page.page, `${path}.page`, true, errors);
  if (typeof page.page === 'string' && !BUILT_IN_PAGE_VALUES.includes(page.page)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'page must use one of the canonical built-in page names.',
      `${path}.page`
    ));
    return;
  }

  if (typeof page.page !== 'string') {
    return;
  }

  if (page.title === '') {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'built-in page title must be a non-empty string when present.',
      `${path}.title`
    ));
  }

  if (errors.some((error) => error.path.startsWith(path))) {
    return;
  }

  validateBuiltInPageContent(
    /** @type {keyof typeof BUILT_IN_PAGE_REQUIRED_SOURCES} */ (page.page),
    page,
    path,
    errors
  );
}

/**
 * @param {keyof typeof BUILT_IN_PAGE_REQUIRED_SOURCES} pageName
 * @param {Record<string, unknown>} page
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateBuiltInPageContent(pageName, page, path, errors) {
  const requiredSources = BUILT_IN_PAGE_REQUIRED_SOURCES[pageName];
  if (!requiredSources) {
    return;
  }

  const definition = page.definition;
  if (!isPlainObject(definition)) {
    for (const sourceName of requiredSources) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `built-in page "${pageName}" requires declarative definitions for source "${sourceName}".`,
        `${path}.definition`
      ));
    }
    return;
  }

  validateBuiltInPageDefinition(pageName, definition, path, errors);
}

/**
 * @param {keyof typeof BUILT_IN_PAGE_REQUIRED_SOURCES} pageName
 * @param {Record<string, unknown>} definition
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateBuiltInPageDefinition(pageName, definition, path, errors) {
  validateBuiltInPageDefinitionKeys(definition, path, errors);
  validateBuiltInPageDataState(definition['data-state'], path, errors);

  if (!Array.isArray(definition.views) || definition.views.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'built-in page definition must contain a non-empty views sequence.',
      `${path}.definition.views`
    ));
    return;
  }

  validatePageSections(
    definition.sections,
    definition.views,
    `${path}.definition.sections`,
    'built-in page definition',
    'definition view',
    errors
  );
  validateProgressiveDisclosure(definition.views, `${path}.definition.views`, errors);
  validateGraphicalLayout(
    definition.views,
    `${path}.definition.views`,
    errors,
    pageName
  );

  /** @type {Map<string, Set<string>>} */
  const sourceFieldCoverage = new Map();
  for (const [index, view] of definition.views.entries()) {
    if (!isPlainObject(view)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'built-in page definition view must be a mapping.',
        `${path}.definition.views[${index}]`
      ));
      continue;
    }

    const data = view.data;
    if (!isPlainObject(data)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'built-in page definition view must contain a data mapping.',
        `${path}.definition.views[${index}].data`
      ));
      continue;
    }

    const viewPath = `${path}.definition.views[${index}]`;
    if (isPlainObject(view.list) && view.list.style === 'entity-cards') {
      if (typeof view.list.card !== 'string' || !declaredCardTemplates.has(view.list.card)) {
        errors.push(createError(
          ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
          'list.card must reference a declared dashboard card template.',
          `${viewPath}.list.card`
        ));
      }
      validateListDrill(view.list.drill, undefined, `${viewPath}.list`, view.list.style, errors);
    }
    if (view.element !== undefined && view.mark !== 'element') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'element is allowed only when mark is "element".',
        `${viewPath}.element`
      ));
    }
    if (view.mark === 'element') {
      if (typeof view.element !== 'string' || !VIEW_ELEMENT_VALUES.includes(view.element)) {
        errors.push(createError(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          'element must use one canonical UI element value.',
          `${viewPath}.element`
        ));
      }
      if (!Array.isArray(data.sources) || data.sources.length === 0) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'element views must declare a non-empty data.sources sequence.',
          `${viewPath}.data.sources`
        ));
        continue;
      }
      if (data.source !== undefined) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'element views must use data.sources instead of data.source.',
          `${viewPath}.data.source`
        ));
      }
      if (view.encoding !== undefined) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'element views must not declare encoding.',
          `${viewPath}.encoding`
        ));
      }
      const seenSources = new Set();
      for (const sourceName of data.sources) {
        if (typeof sourceName !== 'string' || (!TABLE_VALUES.includes(sourceName) && !declaredQueries.has(sourceName))) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            'source must name one Section 5.1 database table or one declared query.',
            `${viewPath}.data.sources`
          ));
          continue;
        }
        if (seenSources.has(sourceName)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'sources must not contain duplicate source names.',
            `${viewPath}.data.sources`
          ));
        }
        seenSources.add(sourceName);
        const coverageSources = new Set([sourceName, ...(declaredQueryTables.get(sourceName) ?? [])]);
        for (const coverageSource of coverageSources) {
          sourceFieldCoverage.set(coverageSource, new Set(getBuiltInRequiredFields(pageName, coverageSource)));
        }
      }
      continue;
    }

    if (typeof data.source !== 'string') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'built-in page definition view must contain one canonical data.source.',
        `${path}.definition.views[${index}].data.source`
      ));
      continue;
    }
    validateViewDataArguments(data.arguments, undefined, `${viewPath}.data.arguments`, data.source, errors);

    const coverageSources = new Set([data.source, ...(declaredQueryTables.get(data.source) ?? [])]);
    for (const coverageSource of coverageSources) {
      if (!sourceFieldCoverage.has(coverageSource)) {
        sourceFieldCoverage.set(coverageSource, new Set());
      }
      collectBuiltInDefinitionFieldCoverage(view.encoding, sourceFieldCoverage.get(coverageSource));
    }

    validateTableActions(
      view.encoding,
      undefined,
      view.mark,
      data.source,
      `${viewPath}.encoding.actions`,
      errors
    );
  }

  for (const sourceName of BUILT_IN_PAGE_REQUIRED_SOURCES[pageName]) {
    if (!sourceFieldCoverage.has(sourceName)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `built-in page "${pageName}" definition must include at least one view for source "${sourceName}".`,
        `${path}.definition.views`
      ));
      continue;
    }

    const requiredFields = getBuiltInRequiredFields(pageName, sourceName);
    const coveredFields = sourceFieldCoverage.get(sourceName) ?? new Set();
    for (const fieldName of requiredFields) {
      if (!coveredFields.has(fieldName)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          `built-in page "${pageName}" definition must expose field "${fieldName}" for source "${sourceName}".`,
          `${path}.definition.views`
        ));
      }
    }
  }
}

/**
 * @param {unknown} sections
 * @param {unknown[]} views
 * @param {string} sectionsPath
 * @param {string} ownerLabel
 * @param {string} viewLabel
 * @param {ValidationError[]} errors
 */
function validatePageSections(sections, views, sectionsPath, ownerLabel, viewLabel, errors) {
  if (sections === undefined) return;
  if (!Array.isArray(sections) || sections.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      `${ownerLabel} sections must be a non-empty sequence.`,
      sectionsPath
    ));
    return;
  }

  const declaredViewIds = views
    .filter(isPlainObject)
    .map((view) => view.id)
    .filter((id) => typeof id === 'string');
  /** @type {string[]} */
  const referencedViewIds = [];
  const referencedViewIdSet = new Set();
  const sectionIds = new Set();

  sections.forEach((section, index) => {
    const sectionPath = `${sectionsPath}[${index}]`;
    if (!isPlainObject(section)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'built-in page layout section must be a mapping.',
        sectionPath
      ));
      return;
    }
    for (const key of Object.keys(section)) {
      if (!PAGE_SECTION_KEYS.includes(key)) {
        errors.push(createError(
          ERROR_CODES.unknownOrDuplicateKey,
          `Unknown key "${key}" is not allowed at ${sectionPath}.`,
          `${sectionPath}.${key}`
        ));
      }
    }
    validateRequiredIdentifier(section.id, `${sectionPath}.id`, 'layout section id', errors);
    if (typeof section.id === 'string') {
      if (sectionIds.has(section.id)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'layout section id must be unique within definition.sections.',
          `${sectionPath}.id`
        ));
      }
      sectionIds.add(section.id);
    }
    validateOptionalStringField(section.title, `${sectionPath}.title`, errors);
    validateOptionalStringField(section.description, `${sectionPath}.description`, errors);
    if (section['count-source'] !== undefined || section['count-sources'] !== undefined
        || section['count-field'] !== undefined || section['count-label'] !== undefined) {
      if (section['count-source'] !== undefined) {
        validateSource(section['count-source'], `${sectionPath}.count-source`, errors);
      }
      if (section['count-sources'] !== undefined) {
        validateSourceSequence(section['count-sources'], `${sectionPath}.count-sources`, errors);
      }
      if ((section['count-source'] === undefined) === (section['count-sources'] === undefined)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'layout section count summary must declare exactly one of count-source or count-sources.',
          sectionPath
        ));
      }
      if (section['count-sources'] !== undefined && section['count-field'] === undefined) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'count-field is required when count-sources is declared.',
          `${sectionPath}.count-field`
        ));
      }
      if (section['count-field'] !== undefined) {
        const countField = section['count-field'];
        validateRequiredIdentifier(countField, `${sectionPath}.count-field`, 'section count field', errors);
        for (const source of Array.isArray(section['count-sources']) ? section['count-sources'] : []) {
          const fields = typeof source === 'string' ? sourceFieldNames(source) : undefined;
          if (typeof countField === 'string' && fields && !fields.includes(countField)) {
            errors.push(createError(
              ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
              'count-field must be declared by every count-sources entry.',
              `${sectionPath}.count-field`
            ));
            break;
          }
        }
      }
      validateStringField(section['count-label'], `${sectionPath}.count-label`, true, errors);
    }
    if (typeof section.layout !== 'string' || !PAGE_SECTION_LAYOUT_VALUES.includes(section.layout)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'layout section must use one canonical full, wide, narrow, or horizontal layout value.',
        `${sectionPath}.layout`
      ));
    }
    if (!Array.isArray(section.views) || section.views.length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'layout section must reference at least one view.',
        `${sectionPath}.views`
      ));
      return;
    }
    section.views.forEach((viewId, viewIndex) => {
      const viewPath = `${sectionPath}.views[${viewIndex}]`;
      if (typeof viewId !== 'string' || !declaredViewIds.includes(viewId)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          `layout section view must reference a declared ${viewLabel} id.`,
          viewPath
        ));
        return;
      }
      if (referencedViewIdSet.has(viewId)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          `each ${viewLabel} may appear in only one layout section.`,
          viewPath
        ));
      }
      referencedViewIds.push(viewId);
      referencedViewIdSet.add(viewId);
    });
  });

  if (declaredViewIds.join('\0') !== referencedViewIds.join('\0')) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      `layout sections must reference every ${viewLabel} exactly once and preserve view order.`,
      sectionsPath
    ));
  }
}

/**
 * @param {keyof typeof BUILT_IN_PAGE_REQUIRED_FIELDS} pageName
 * @param {string} sourceName
 * @returns {string[]}
 */
function getBuiltInRequiredFields(pageName, sourceName) {
  const pageFields = BUILT_IN_PAGE_REQUIRED_FIELDS[pageName];
  if (!pageFields || !Object.hasOwn(pageFields, sourceName)) {
    return [];
  }

  return /** @type {string[]} */ (pageFields[/** @type {keyof typeof pageFields} */ (sourceName)]);
}

/**
 * @param {Record<string, unknown>} definition
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateBuiltInPageDefinitionKeys(definition, path, errors) {
  for (const key of Object.keys(definition)) {
    if (!BUILT_IN_PAGE_DEFINITION_KEYS.includes(key)) {
      errors.push(createError(
        ERROR_CODES.unknownOrDuplicateKey,
        `Unknown key "${key}" is not allowed at ${path}.definition.`,
        `${path}.definition.${key}`
      ));
    }
  }
}

/**
 * @param {unknown} dataState
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateBuiltInPageDataState(dataState, path, errors) {
  const dataStatePath = `${path}.definition.data-state`;
  if (!isPlainObject(dataState)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'built-in page definition must expose availability state.',
      dataStatePath
    ));
    return;
  }

  for (const key of Object.keys(dataState)) {
    if (!BUILT_IN_PAGE_DATA_STATE_KEYS.includes(key)) {
      errors.push(createError(
        ERROR_CODES.unknownOrDuplicateKey,
        `Unknown key "${key}" is not allowed at ${dataStatePath}.`,
        `${dataStatePath}.${key}`
      ));
    }
  }

  for (const key of BUILT_IN_PAGE_DATA_STATE_KEYS) {
    if (dataState[key] !== true) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `built-in page definition must expose ${key} state with canonical boolean true.`,
        `${dataStatePath}.${key}`
      ));
    }
  }
}

/**
 * @param {unknown} encoding
 * @param {Set<string> | undefined} coveredFields
 */
function collectBuiltInDefinitionFieldCoverage(encoding, coveredFields) {
  if (!isPlainObject(encoding) || !coveredFields) {
    return;
  }

  for (const channel of ['value', 'x', 'y', 'color', 'href']) {
    collectFieldDefinitionCoverage(encoding[channel], coveredFields);
  }

  if (Array.isArray(encoding.columns)) {
    for (const column of encoding.columns) {
      collectFieldDefinitionCoverage(column, coveredFields);
    }
  }
}

/**
 * @param {unknown} fieldDefinition
 * @param {Set<string>} coveredFields
 */
function collectFieldDefinitionCoverage(fieldDefinition, coveredFields) {
  if (!isPlainObject(fieldDefinition) || typeof fieldDefinition.field !== 'string') {
    return;
  }

  coveredFields.add(fieldDefinition.field);
}

/**
 * Validates the optional tab set of a routed custom page.
 * @param {Record<string, unknown>} route
 * @param {string} routePath
 * @param {ValidationError[]} errors
 */
function validateRouteTabs(route, routePath, errors) {
  if (route.tabs === undefined) {
    if (route.tab !== undefined) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'route tab requires a route tabs sequence.',
        `${routePath}.tab`
      ));
    }
    return;
  }
  if (route['hash-query-parameter'] === undefined) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'route tabs require hash-query-parameter.',
      `${routePath}.tabs`
    ));
  }
  if (!Array.isArray(route.tabs) || route.tabs.length === 0 || route.tabs.length > MAX_PAGE_ROUTE_TABS) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      `route tabs must be a sequence of 1 to ${MAX_PAGE_ROUTE_TABS} tabs.`,
      `${routePath}.tabs`
    ));
    return;
  }
  const identifiers = new Set();
  for (const [index, tab] of route.tabs.entries()) {
    const tabPath = `${routePath}.tabs[${index}]`;
    if (!isPlainObject(tab)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'route tab must be a mapping.', tabPath));
      continue;
    }
    for (const key of Object.keys(tab)) {
      if (!PAGE_ROUTE_TAB_KEYS.includes(key)) {
        errors.push(createError(ERROR_CODES.unknownOrDuplicateKey, `Unknown key "${key}" is not allowed at ${tabPath}.`, `${tabPath}.${key}`));
      }
    }
    validateRequiredIdentifier(tab.id, `${tabPath}.id`, 'route tab id', errors);
    validateRequiredIdentifier(tab.page, `${tabPath}.page`, 'route tab page', errors);
    validateStringField(tab.label, `${tabPath}.label`, true, errors);
    validateStringField(tab.icon, `${tabPath}.icon`, true, errors);
    if (typeof tab.icon === 'string' && !PAGE_ICON_VALUES.includes(tab.icon)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'route tab icon must use one canonical Octicon name.',
        `${tabPath}.icon`
      ));
    }
    if (typeof tab.id === 'string') {
      if (identifiers.has(tab.id)) {
        errors.push(createError(ERROR_CODES.unknownOrDuplicateKey, 'route tab ids must be unique.', `${tabPath}.id`));
      }
      identifiers.add(tab.id);
    }
  }
  if (route.tab !== undefined && (typeof route.tab !== 'string' || !identifiers.has(route.tab))) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'route tab must name one declared route tab id.',
      `${routePath}.tab`
    ));
  }
}

/**
 * @param {Record<string, unknown>} page
 * @param {unknown} pageNode
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateCustomPage(page, pageNode, path, errors) {
  if (page.title === undefined && typeof page.id === 'string' && !IDENTIFIER_PATTERN.test(page.id)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'custom page title default requires a canonical page id.',
      `${path}.id`
    ));
  }

  if (page.route !== undefined) {
    const routePath = `${path}.route`;
    if (!isPlainObject(page.route)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'route must be a mapping.',
        routePath
      ));
    } else {
      validateObjectKeys(getValueNodeByKey(pageNode, 'route'), PAGE_ROUTE_KEYS, routePath, errors);
      if (page.route['hash-query-parameter'] === undefined && page.route['navigation-page'] === undefined) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'route must declare hash-query-parameter or navigation-page.',
          routePath
        ));
      }
      if (page.route['hash-query-parameter'] !== undefined) {
        validateRequiredIdentifier(
          page.route['hash-query-parameter'],
          `${routePath}.hash-query-parameter`,
          'route hash query parameter',
          errors
        );
      }
      if (page.route['navigation-page'] !== undefined) {
        validateRequiredIdentifier(
          page.route['navigation-page'],
          `${routePath}.navigation-page`,
          'route navigation page',
          errors
        );
      }
      const routeTitleFormat = page.route['title-format'];
      if (routeTitleFormat !== undefined
          && (typeof routeTitleFormat !== 'string'
            || !PAGE_ROUTE_TITLE_FORMAT_VALUES.includes(routeTitleFormat))) {
        errors.push(createError(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          `route title-format must be one of: ${PAGE_ROUTE_TITLE_FORMAT_VALUES.join(', ')}.`,
          `${routePath}.title-format`
        ));
      }
      if (page.route['tabs-class-name'] !== undefined) {
        validateRequiredIdentifier(
          page.route['tabs-class-name'],
          `${routePath}.tabs-class-name`,
          'route tabs class name',
          errors
        );
      }
      validateRouteTabs(page.route, routePath, errors);
    }
  }

  if (!Array.isArray(page.views) || page.views.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'custom pages must contain a non-empty views sequence.',
      `${path}.views`
    ));
    return;
  }

  /** @type {Set<string>} */
  const viewIds = new Set();
  const viewsNode = getValueNodeByKey(pageNode, 'views');
  page.views.forEach((view, index) => {
    validateView(
      view,
      getSequenceItemNode(viewsNode, index),
      `${path}.views[${index}]`,
      viewIds,
      errors
    );
  });
  validateProgressiveDisclosure(page.views, `${path}.views`, errors);
  validatePageSections(page.sections, page.views, `${path}.sections`, 'custom page', 'page view', errors);
  validateGraphicalLayout(
    page.views,
    `${path}.views`,
    errors,
    typeof page.id === 'string' ? page.id : undefined
  );
}

/**
 * @param {unknown} labels
 * @param {unknown} labelsNode
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validatePluralLabels(labels, labelsNode, path, errors) {
  if (!isPlainObject(labels) || Object.keys(labels).length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'config.labels must be a non-empty mapping of plural text variables.',
      path
    ));
    return;
  }
  for (const [labelId, text] of Object.entries(labels)) {
    const labelPath = `${path}.${labelId}`;
    if (!IDENTIFIER_PATTERN.test(labelId)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'plural text identifiers must use canonical kebab-case.',
        labelPath
      ));
    }
    if (!isPlainObject(text)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'a plural text variable must be a mapping with singular and plural text.',
        labelPath
      ));
      continue;
    }
    validateObjectKeys(getValueNodeByKey(labelsNode, labelId), PLURAL_TEXT_KEYS, labelPath, errors);
    for (const key of Object.keys(text)) {
      if (!PLURAL_TEXT_KEYS.includes(key) && getMappingItems(labelsNode) === undefined) {
        errors.push(createError(
          ERROR_CODES.unknownOrDuplicateKey,
          `Unknown key "${key}" is not allowed.`,
          `${labelPath}.${key}`
        ));
      }
    }
    for (const key of PLURAL_TEXT_KEYS) {
      validateStringField(text[key], `${labelPath}.${key}`, true, errors);
    }
  }
}

/**
 * @param {unknown} view
 * @param {unknown} viewNode
 * @param {string} path
 * @param {Set<string>} viewIds
 * @param {ValidationError[]} errors
 */
function validateView(view, viewNode, path, viewIds, errors) {
  if (!isPlainObject(view)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'view must be a mapping.',
      path
    ));
    return;
  }

  if (view.title === undefined && typeof view.id === 'string' && !IDENTIFIER_PATTERN.test(view.id)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'view title default requires a canonical view id.',
      `${path}.id`
    ));
  }

  validateObjectKeys(viewNode, view.mark === 'chart' ? VIEW_KEYS : [...VIEW_KEYS, 'views'], path, errors);
  validateRequiredIdentifier(view.id, `${path}.id`, 'view id', errors);
  if (typeof view.id === 'string') {
    if (viewIds.has(view.id)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'view id must be unique within page.views.',
        `${path}.id`
      ));
    }
    viewIds.add(view.id);
  }

  validateOptionalStringField(view.title, `${path}.title`, errors);
  validateStringField(view['disclosure-label'], `${path}.disclosure-label`, false, errors);
  if (
    view['disclosure-label'] !== undefined
    && view.disclosure !== 'supplemental'
  ) {
    errors.push(createError(
      ERROR_CODES.invalidProgressiveDisclosureConfiguration,
      'disclosure-label is allowed only on supplemental views.',
      `${path}.disclosure-label`
    ));
  }
  validateOptionalStringField(view.description, `${path}.description`, errors);
  if (view.locked !== undefined && typeof view.locked !== 'boolean') {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'locked must be a boolean.',
      `${path}.locked`
    ));
  }
  if (view.intent !== undefined) {
    validateStringField(view.intent, `${path}.intent`, true, errors);
    if (view.mark !== 'element') {
      errors.push(createError(
        ERROR_CODES.incompatibleMarkChannelTypeOrTimeUnit,
        'intent is allowed only when mark is "element".',
        `${path}.intent`
      ));
    }
  }
  validateCallout(
    view.callout,
    getValueNodeByKey(viewNode, 'callout'),
    view.mark,
    view.title,
    view.description,
    `${path}.callout`,
    errors
  );
  if (view['empty-message'] !== undefined) {
    validateStringField(view['empty-message'], `${path}.empty-message`, true, errors);
  }

  if (view.controls !== undefined) {
    validateStringField(view.controls, `${path}.controls`, true, errors);
    if (typeof view.controls === 'string' && !VIEW_CONTROL_VALUES.includes(view.controls)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'controls must use one canonical interactive or static value.',
        `${path}.controls`
      ));
    }
    if (view.mark !== 'table') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'controls is allowed only when mark is "table".',
        `${path}.controls`
      ));
    }
  }

  if (view['lazy-list'] !== undefined) {
    if (typeof view['lazy-list'] !== 'boolean') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'lazy-list must be a boolean.',
        `${path}.lazy-list`
      ));
    }
    if (view.mark !== 'table' || (view['lazy-list'] === true && view.controls === 'static')) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'lazy-list is allowed only on interactive table views.',
        `${path}.lazy-list`
      ));
    }
  }

  if (view['column-summaries'] !== undefined) {
    if (typeof view['column-summaries'] !== 'boolean') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'column-summaries must be a boolean.',
        `${path}.column-summaries`
      ));
    }
    if (view.mark !== 'table') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'column-summaries is allowed only when mark is "table".',
        `${path}.column-summaries`
      ));
    }
  }

  if (view.tree !== undefined) {
    const treePath = `${path}.tree`;
    if (!isPlainObject(view.tree)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'tree must be a mapping.',
        treePath
      ));
    } else {
      validateObjectKeys(getValueNodeByKey(viewNode, 'tree'), TREE_TABLE_KEYS, treePath, errors);
      validateRequiredIdentifier(view.tree['id-field'], `${treePath}.id-field`, 'tree id field', errors);
      validateRequiredIdentifier(view.tree['parent-field'], `${treePath}.parent-field`, 'tree parent field', errors);
      const treeSource = isPlainObject(view.data) && typeof view.data.source === 'string'
        ? view.data.source
        : null;
      const sourceFields = treeSource
        ? sourceFieldNames(treeSource)
        : null;
      for (const field of [view.tree['id-field'], view.tree['parent-field']]) {
        if (typeof field === 'string' && sourceFields && !sourceFields.includes(field)) {
          errors.push(createError(
            ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
            'tree fields must be declared by data.source.',
            treePath
          ));
        }
      }
      if (view.tree['id-field'] === view.tree['parent-field']) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'tree id-field and parent-field must be different.',
          treePath
        ));
      }
    }
    if (view.mark !== 'table') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'tree is allowed only when mark is "table".',
        treePath
      ));
    }
    if (view.controls !== 'static') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'tree tables must use static controls to preserve hierarchy.',
        `${path}.controls`
      ));
    }
  }

  if (view['empty-message'] !== undefined && !['chart', 'list', 'table'].includes(String(view.mark))) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'empty-message is allowed only when mark is "chart", "list", or "table".',
      `${path}.empty-message`
    ));
  }

  validateTitleLink(
    view['title-link'],
    getValueNodeByKey(viewNode, 'title-link'),
    view.mark,
    view.data,
    `${path}.title-link`,
    errors
  );

  validateStringField(view.mark, `${path}.mark`, true, errors);
  if (typeof view.mark === 'string' && !VIEW_MARK_VALUES.includes(view.mark)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'mark must use one canonical custom-view mark value.',
      `${path}.mark`
    ));
  }

  if (view.element !== undefined) {
    validateStringField(view.element, `${path}.element`, true, errors);
    if (typeof view.element === 'string' && !VIEW_ELEMENT_VALUES.includes(view.element)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'element must use one canonical UI element value.',
        `${path}.element`
      ));
    }
    if (view.mark !== 'element') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'element is allowed only when mark is "element".',
        `${path}.element`
      ));
    }
  } else if (view.mark === 'element') {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'element views must name one canonical UI element.',
      `${path}.element`
    ));
  }

  if (view.config !== undefined) {
    if (!isPlainObject(view.config)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'config must be a mapping.',
        `${path}.config`
      ));
    } else if (view.mark !== 'element') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'config is allowed only when mark is "element".',
        `${path}.config`
      ));
    } else {
      const configNode = getValueNodeByKey(viewNode, 'config');
      validateObjectKeys(configNode, VIEW_ELEMENT_CONFIG_KEYS, `${path}.config`, errors);
      if ((view.element === 'workflow-route-page' || view.element === 'campaign-route' || view.element === 'outcome-detail-section') && view.config.body !== undefined) {
        validateStringField(view.config.body, `${path}.config.body`, true, errors);
       const allowedBodies = view.element === 'workflow-route-page'
         ? WORKFLOW_ROUTE_BODY_VALUES
         : view.element === 'campaign-route'
           ? CAMPAIGN_ROUTE_BODY_VALUES
           : OUTCOME_DETAIL_SECTION_BODY_VALUES;
       if (typeof view.config.body === 'string' && !allowedBodies.includes(view.config.body)) {
         errors.push(createError(
           ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
           `${view.element} config.body must use one canonical route body value.`,
           `${path}.config.body`
         ));
       }
      } else if (view.config.body !== undefined) {
       errors.push(createError(
         ERROR_CODES.missingOrInvalidRequiredField,
         'config.body is supported only for the workflow-route-page, campaign-route, and outcome-detail-section elements.',
         `${path}.config.body`
       ));
      }
      if (view.config['view-all-page'] !== undefined) {
        validateStringField(view.config['view-all-page'], `${path}.config.view-all-page`, true, errors);
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'config.view-all-page is not supported by a registered element.',
          `${path}.config.view-all-page`
        ));
      }
      if (view.config['view-all-label'] !== undefined) {
        validateStringField(view.config['view-all-label'], `${path}.config.view-all-label`, true, errors);
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'config.view-all-label is not supported by a registered element.',
          `${path}.config.view-all-label`
        ));
      }
      if (view.config.sections !== undefined) {
       errors.push(createError(
         ERROR_CODES.missingOrInvalidRequiredField,
         'config.sections is not supported by a registered element.',
         `${path}.config.sections`
       ));
      }
      if (view.config.stations !== undefined) {
        if (view.element !== 'factory-floor') {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'config.stations is supported only for the factory-floor element.',
            `${path}.config.stations`
          ));
        } else if (!Array.isArray(view.config.stations) || view.config.stations.length === 0) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'factory-floor config.stations must be a non-empty list.',
            `${path}.config.stations`
          ));
        } else {
          const seenStations = new Set();
          for (let index = 0; index < view.config.stations.length; index += 1) {
            const station = view.config.stations[index];
            validateStringField(station, `${path}.config.stations[${index}]`, true, errors);
            if (seenStations.has(station)) {
              errors.push(createError(
                ERROR_CODES.unknownOrDuplicateKey,
                'factory-floor config.stations values must be unique.',
                `${path}.config.stations[${index}]`
              ));
            }
            seenStations.add(station);
            if (typeof station === 'string' && !FACTORY_FLOOR_STATION_VALUES.includes(station)) {
              errors.push(createError(
                ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
                'factory-floor config.stations must use canonical station values.',
                `${path}.config.stations[${index}]`
              ));
            }
          }
        }
      }
      if (view.config.labels !== undefined) {
        if (!PLURAL_LABEL_ELEMENTS.includes(String(view.element))) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            `config.labels is supported only for the ${PLURAL_LABEL_ELEMENTS.join(', ')} element.`,
            `${path}.config.labels`
          ));
        } else {
          validatePluralLabels(view.config.labels, getValueNodeByKey(getValueNodeByKey(viewNode, 'config'), 'labels'), `${path}.config.labels`, errors);
        }
      }
      if (view.config.animate !== undefined) {
        if (view.element !== 'factory-floor') {
          errors.push(createError(
            ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
            'config.animate is supported only for the factory-floor element.',
            `${path}.config.animate`
          ));
        }
        validateStringField(view.config.animate, `${path}.config.animate`, false, errors);
        if (typeof view.config.animate === 'string' && !VIEW_ELEMENT_ANIMATION_VALUES.includes(view.config.animate)) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            'config.animate must use one canonical element animation value.',
            `${path}.config.animate`
          ));
        }
      }
      if (view.config.sources !== undefined) {
        if (view.element !== 'factory-header' && view.element !== 'factory-floor') {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'config.sources is supported only for the factory-header and factory-floor elements.',
            `${path}.config.sources`
          ));
        } else if (!isPlainObject(view.config.sources) || Object.keys(view.config.sources).length === 0) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            `${view.element} config.sources must be a non-empty mapping of metric roles to source names.`,
            `${path}.config.sources`
          ));
        } else {
          const allowedRoles = view.element === 'factory-header' ? FACTORY_HEADER_SOURCE_ROLES : FACTORY_FLOOR_SOURCE_ROLES;
          const sourcesNode = getValueNodeByKey(getValueNodeByKey(viewNode, 'config'), 'sources');
          validateObjectKeys(sourcesNode, allowedRoles, `${path}.config.sources`, errors);
          for (const [role, sourceName] of Object.entries(view.config.sources)) {
            validateStringField(sourceName, `${path}.config.sources.${role}`, true, errors);
          }
        }
      }
      const linkButtonConfigKeys = ['label-field', 'link-field', 'icon-field', 'fallback-icon', 'empty-message'];
      for (const key of linkButtonConfigKeys) {
        if (view.config[key] === undefined) continue;
        validateStringField(view.config[key], `${path}.config.${key}`, true, errors);
        if (view.element !== 'link-button-list') {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            `config.${key} is supported only for the link-button-list element.`,
            `${path}.config.${key}`
          ));
        }
      }
      if (view.element === 'link-button-list') {
        for (const key of ['label-field', 'link-field', 'fallback-icon']) {
          if (view.config[key] === undefined) {
            errors.push(createError(
              ERROR_CODES.missingOrInvalidRequiredField,
              `link-button-list config.${key} is required.`,
              `${path}.config.${key}`
            ));
          }
        }
      }
    }
  } else if (view.element === 'link-button-list') {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'link-button-list requires config.',
      `${path}.config`
    ));
  }

  if (view.list !== undefined) {
    const listPath = `${path}.list`;
    if (!isPlainObject(view.list)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'list must be a list widget mapping.', listPath));
    } else {
      validateObjectKeys(getValueNodeByKey(viewNode, 'list'), VIEW_LIST_KEYS, listPath, errors);
      validateStringField(view.list.style, `${listPath}.style`, true, errors);
      if (typeof view.list.style === 'string' && !VIEW_LIST_STYLE_VALUES.includes(view.list.style)) {
        errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, `list.style must be one of ${VIEW_LIST_STYLE_VALUES.join(', ')}.`, `${listPath}.style`));
      }
      if (view.list.layout !== undefined) {
        validateStringField(view.list.layout, `${listPath}.layout`, true, errors);
        if (typeof view.list.layout === 'string' && !VIEW_LIST_LAYOUT_VALUES.includes(view.list.layout)) {
          errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, `list.layout must be one of ${VIEW_LIST_LAYOUT_VALUES.join(', ')}.`, `${listPath}.layout`));
        }
      }
      if (view.list.appearance !== undefined) {
        validateStringField(view.list.appearance, `${listPath}.appearance`, true, errors);
        if (view.list.style !== 'entity-cards') {
          errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'list.appearance is supported only for entity-cards lists.', `${listPath}.appearance`));
        } else if (typeof view.list.appearance === 'string' && !VIEW_LIST_APPEARANCE_VALUES.includes(view.list.appearance)) {
          errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, `list.appearance must be one of ${VIEW_LIST_APPEARANCE_VALUES.join(', ')}.`, `${listPath}.appearance`));
        }
      }
      validateStringField(view.list.icon, `${listPath}.icon`, true, errors);
      if (typeof view.list.icon === 'string' && !PAGE_ICON_VALUES.includes(view.list.icon)) {
        errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'list icon must use one canonical Octicon name.', `${listPath}.icon`));
      }
      if (view.list.action !== undefined) {
        validateRequiredIdentifier(view.list.action, `${listPath}.action`, 'list action reference', errors);
        const declaredAction = typeof view.list.action === 'string'
          ? declaredCliActions.get(view.list.action)
          : undefined;
        if (typeof view.list.action === 'string' && !declaredAction) {
          errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'list action must reference a declared dashboard CLI action.', `${listPath}.action`));
        } else if (declaredAction?.placement !== 'view') {
          errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'list.action must reference a view-placed dashboard CLI action.', `${listPath}.action`));
        }
      }
      if (view.list.card !== undefined) {
        validateStringField(view.list.card, `${listPath}.card`, true, errors);
        if (typeof view.list.card === 'string' && !declaredCardTemplates.has(view.list.card)) {
          errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'list.card must reference a declared dashboard card template.', `${listPath}.card`));
        }
      }
      if (view.list.style === 'entity-cards' && view.list.card === undefined) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'entity-cards lists must declare a reusable card definition.', `${listPath}.card`));
      } else if (view.list.style !== 'entity-cards' && view.list.card !== undefined) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'list.card is supported only for entity-cards lists.', `${listPath}.card`));
      }
      validateListDrill(view.list.drill, getValueNodeByKey(getValueNodeByKey(viewNode, 'list'), 'drill'), listPath, view.list.style, errors);
      validateListViewAll(view.list['view-all'], getValueNodeByKey(getValueNodeByKey(viewNode, 'list'), 'view-all'), listPath, view.list.style, errors);
    }
    if (view.mark !== 'list') {
      errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'list is allowed only when mark is "list".', listPath));
    }

  } else if (view.mark === 'list') {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'list views must declare a list widget mapping.', `${path}.list`));
  }

  if (view['card-drill'] !== undefined) {
    const drillPath = `${path}.card-drill`;
    validateListDrill(view['card-drill'], getValueNodeByKey(viewNode, 'card-drill'), path, 'entity-cards', errors);
    if (view.mark !== 'table' || view['lazy-list'] !== true) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'card-drill is allowed only on lazy table views.',
        drillPath
      ));
    }
  }

  if (view.chart !== undefined) {
    validateStringField(view.chart, `${path}.chart`, true, errors);
    if (typeof view.chart === 'string' && !VIEW_CHART_VALUES.includes(view.chart)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'chart must use one canonical chart widget value.',
        `${path}.chart`
      ));
    }
    if (view.mark !== 'chart') {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'chart is allowed only when mark is "chart".',
        `${path}.chart`
      ));
    }
  }

  if (view.metric !== undefined) {
      const metricPath = `${path}.metric`;
      if (!isPlainObject(view.metric)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'metric must be a metric widget mapping.',
          metricPath
        ));
      } else {
        validateObjectKeys(getValueNodeByKey(viewNode, 'metric'), VIEW_METRIC_KEYS, metricPath, errors);
        validateStringField(view.metric.style, `${metricPath}.style`, true, errors);
        if (typeof view.metric.style === 'string' && !VIEW_METRIC_STYLE_VALUES.includes(view.metric.style)) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            'metric style must use one canonical metric widget value.',
            `${metricPath}.style`
          ));
        }
        validateStringField(view.metric.animate, `${metricPath}.animate`, false, errors);
        if (typeof view.metric.animate === 'string' && !VIEW_METRIC_ANIMATION_VALUES.includes(view.metric.animate)) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            'metric animate must use one canonical metric animation value.',
            `${metricPath}.animate`
          ));
        }
        if (view.metric.animate !== undefined && view.metric.style !== 'card') {
          errors.push(createError(
            ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
            'metric animate is supported only for card metric widgets.',
            `${metricPath}.animate`
          ));
        }
        validateStringField(view.metric.icon, `${metricPath}.icon`, true, errors);
        if (typeof view.metric.icon === 'string' && !PAGE_ICON_VALUES.includes(view.metric.icon)) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            'metric icon must use one canonical Octicon name.',
            `${metricPath}.icon`
          ));
        }
        validateStringField(view.metric.tone, `${metricPath}.tone`, true, errors);
        if (typeof view.metric.tone === 'string' && !VIEW_METRIC_TONE_VALUES.includes(view.metric.tone)) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            'metric tone must use one canonical metric tone value.',
            `${metricPath}.tone`
          ));
        }
        validateRequiredIdentifier(
          view.metric['navigation-page'],
          `${metricPath}.navigation-page`,
          'metric navigation page',
          errors
        );
      }

      if (view.mark !== 'metric') {
        errors.push(createError(
          ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
          'metric is allowed only when mark is "metric".',
          metricPath
        ));
      }
  }

  if (view.layout !== undefined) {
    validateStringField(view.layout, `${path}.layout`, true, errors);
    if (typeof view.layout === 'string' && !VIEW_LAYOUT_VALUES.includes(view.layout)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'layout must use one canonical structural layout hint.',
        `${path}.layout`
      ));
    }
  }

  /** @type {string | null} */
  let sourceName = null;
  if (view.mark === 'callout') {
    if (view.data !== undefined) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'callout views must not declare data.',
        `${path}.data`
      ));
    }
  } else if (!isPlainObject(view.data)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'data must be a mapping.',
      `${path}.data`
    ));
  } else {
    const dataNode = getValueNodeByKey(viewNode, 'data');
    validateObjectKeys(dataNode, VIEW_DATA_KEYS, `${path}.data`, errors);
    if (view.mark === 'element') {
      validateSourceSequence(view.data.sources, `${path}.data.sources`, errors);
      if (view.data.source !== undefined) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'element views must use data.sources instead of data.source.',
          `${path}.data.source`
        ));
      }
      for (const key of ['limit', 'order-by', 'source-metadata', 'route-field']) {
        if (view.data[key] !== undefined) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            `element views must not declare data.${key}.`,
            `${path}.data.${key}`
          ));
        }
      }
      validateViewDataArguments(
        view.data.arguments,
        getValueNodeByKey(dataNode, 'arguments'),
        `${path}.data.arguments`,
        Array.isArray(view.data.sources) ? view.data.sources.filter((name) => typeof name === 'string') : null,
        errors
      );
    } else {
      validateSource(view.data.source, `${path}.data.source`, errors);
      if (typeof view.data.source === 'string'
          && (TABLE_VALUES.includes(view.data.source) || declaredQueries.has(view.data.source))) {
        sourceName = view.data.source;
      }
      if (view.data.sources !== undefined) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'metric, table, list, and chart views must use data.source instead of data.sources.',
          `${path}.data.sources`
        ));
      }
      if (view.data['route-field'] !== undefined) {
        validateStringField(view.data['route-field'], `${path}.data.route-field`, true, errors);
        if (
          sourceName
          && typeof view.data['route-field'] === 'string'
          && !sourceFieldNames(sourceName)?.includes(view.data['route-field'])
        ) {
          errors.push(createError(
            ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
            'route-field must name a field declared by data.source.',
            `${path}.data.route-field`
          ));
        }
      }
      validateViewDataArguments(
        view.data.arguments,
        getValueNodeByKey(dataNode, 'arguments'),
        `${path}.data.arguments`,
        sourceName,
        errors
      );
    }
    validateContext(dataNode, view.data, `${path}.data`, errors);
  }

  validateSemanticFieldLiterals(view.data, `${path}.data`, errors);
  validateDatasetMetadata(getValueNodeByKey(viewNode, 'data'), view.data, `${path}.data`, errors);
  if (
    ['heatmap', 'horizontal-bar'].includes(String(view.chart))
    && (!isPlainObject(view.data) || !Number.isInteger(view.data.limit) || Number(view.data.limit) > 100)
  ) {
    const chartName = view.chart === 'horizontal-bar' ? 'horizontal-bar' : 'heatmap';
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      `${chartName} charts must declare data.limit no greater than 100.`,
      `${path}.data.limit`
    ));
  }
  validateEncoding(getValueNodeByKey(viewNode, 'encoding'), view.encoding, view.mark, view.chart, sourceName, view.data, path, errors);
  validateTableActions(
    view.encoding,
    getValueNodeByKey(viewNode, 'encoding'),
    view.mark,
    sourceName,
    `${path}.encoding.actions`,
    errors
  );
}

/**
 * @param {unknown} args
 * @param {unknown} argsNode
 * @param {string} path
 * @param {string | string[] | null} sourceName
 * @param {ValidationError[]} errors
 */
function validateViewDataArguments(args, argsNode, path, sourceName, errors) {
  if (args === undefined) return;
  if (!Array.isArray(args) || args.length === 0) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'data.arguments must be a non-empty sequence.', path));
    return;
  }
  const names = new Set();
  const sourceNames = Array.isArray(sourceName) ? sourceName : sourceName ? [sourceName] : [];
  const sourceFields = sourceNames.map((name) => sourceFieldNames(name));
  const fields = sourceFields.length > 0 && sourceFields.every(Array.isArray)
    ? sourceFields.reduce((shared, candidate) => shared.filter((field) => candidate.includes(field)), [...sourceFields[0]])
    : null;
  for (const [index, argument] of args.entries()) {
    const argumentPath = `${path}[${index}]`;
    if (!isPlainObject(argument)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'data argument must be a mapping.', argumentPath));
      continue;
    }
    validateObjectKeys(getSequenceItemNode(argsNode, index), VIEW_DATA_ARGUMENT_KEYS, argumentPath, errors);
    validateRequiredIdentifier(argument.name, `${argumentPath}.name`, 'data argument name', errors);
    validateRequiredIdentifier(argument.field, `${argumentPath}.field`, 'data argument field', errors);
    if (typeof argument.name === 'string' && names.has(argument.name)) {
      errors.push(createError(ERROR_CODES.unknownOrDuplicateKey, 'data argument names must be unique.', `${argumentPath}.name`));
    }
    names.add(argument.name);
    if (fields && typeof argument.field === 'string' && !fields.includes(argument.field)) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        `data argument field must be declared by ${sourceNames.length > 1 ? 'every data.sources entry' : 'data.source'}.`,
        `${argumentPath}.field`
      ));
    }
  }
}

/**
 * @param {unknown} entries
 * @param {unknown} entriesNode
 * @param {string} path
 * @param {string[]} allowedKeys
 * @param {string[]} fieldKeys
 * @param {(field: unknown, path: string) => void} requireField
 * @param {ValidationError[]} errors
 */
function validateTemporalSeriesEntries(entries, entriesNode, path, allowedKeys, fieldKeys, requireField, errors) {
  if (entries === undefined) return;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 64) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'temporal-series entries must contain 1 to 64 definitions.', path));
    return;
  }
  for (const [index, entry] of entries.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'temporal-series entry must be a mapping.', entryPath));
      continue;
    }
    validateObjectKeys(getSequenceItemNode(entriesNode, index), allowedKeys, entryPath, errors);
    for (const key of fieldKeys) {
      if (key !== 'field' && entry[key] === undefined) continue;
      validateStringField(entry[key], `${entryPath}.${key}`, true, errors);
      requireField(entry[key], `${entryPath}.${key}`);
    }
    validateRequiredIdentifier(entry.kind, `${entryPath}.kind`, 'temporal-series kind', errors);
  }
}

/**
 * @param {unknown} drill
 * @param {unknown} drillNode
 * @param {string} listPath
 * @param {unknown} style
 * @param {ValidationError[]} errors
 */
function validateListDrill(drill, drillNode, listPath, style, errors) {
  const path = `${listPath}.drill`;
  if (drill === undefined) return;
  if (style !== 'entity-cards') {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'list.drill is supported only for entity-cards lists.', path));
    return;
  }
  if (!isPlainObject(drill)) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'list.drill must be a mapping.', path));
    return;
  }
  validateObjectKeys(drillNode, VIEW_LIST_DRILL_KEYS, path, errors);
  validateStringField(drill.type, `${path}.type`, true, errors);
  if (typeof drill.type === 'string' && !VIEW_LIST_DRILL_TYPE_VALUES.includes(drill.type)) {
    errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, `list.drill.type must be one of ${VIEW_LIST_DRILL_TYPE_VALUES.join(', ')}.`, `${path}.type`));
  }
  if (drill.type === 'external') {
    validateRequiredIdentifier(drill.field, `${path}.field`, 'external drill field', errors);
    if (drill.page !== undefined || drill.query !== undefined || drill['title-field'] !== undefined || drill.arguments !== undefined) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'external drill behavior supports only field.', path));
    }
    return;
  }
  if (drill.type !== 'query') return;
  validateRequiredIdentifier(drill.page, `${path}.page`, 'query drill page', errors);
  validateRequiredIdentifier(drill.query, `${path}.query`, 'query drill query', errors);
  validateRequiredIdentifier(drill['title-field'], `${path}.title-field`, 'query drill title field', errors);
  if (!Array.isArray(drill.arguments) || drill.arguments.length === 0) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'query drill behavior requires non-empty arguments.', `${path}.arguments`));
    return;
  }
  const names = new Set();
  const argumentsNode = getValueNodeByKey(drillNode, 'arguments');
  for (const [index, argument] of drill.arguments.entries()) {
    const argumentPath = `${path}.arguments[${index}]`;
    if (!isPlainObject(argument)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'query drill argument must be a mapping.', argumentPath));
      continue;
    }
    validateObjectKeys(getSequenceItemNode(argumentsNode, index), VIEW_LIST_DRILL_ARGUMENT_KEYS, argumentPath, errors);
    validateRequiredIdentifier(argument.name, `${argumentPath}.name`, 'query drill argument name', errors);
    validateRequiredIdentifier(argument.field, `${argumentPath}.field`, 'query drill argument field', errors);
    if (typeof argument.name === 'string' && names.has(argument.name)) {
      errors.push(createError(ERROR_CODES.unknownOrDuplicateKey, 'query drill argument names must be unique.', `${argumentPath}.name`));
    }
    names.add(argument.name);
  }
}

/**
 * @param {Record<string, any>} drill
 * @param {string} drillPath
 * @param {Record<string, any>} dashboard
 * @param {Set<string>} pageIds
 * @param {Map<string, string[] | undefined>} declaredQueries
 * @param {string[] | null | undefined} fields
 * @param {ValidationError[]} errors
 */
function validateQueryDrillReferences(drill, drillPath, dashboard, pageIds, declaredQueries, fields, errors) {
  if (drill.type !== 'query') return;
  if (typeof drill.page === 'string' && IDENTIFIER_PATTERN.test(drill.page) && !pageIds.has(drill.page)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'query drill page must reference a declared dashboard page id.',
      `${drillPath}.page`
    ));
  }
  if (typeof drill.query === 'string' && IDENTIFIER_PATTERN.test(drill.query) && !declaredQueries.has(drill.query)) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'query drill query must reference a declared dashboard query.',
      `${drillPath}.query`
    ));
  }
  for (const [field, fieldPath] of [
    [drill['title-field'], `${drillPath}.title-field`],
    ...(Array.isArray(drill.arguments)
      ? drill.arguments.map((argument, argumentIndex) => [
          isPlainObject(argument) ? argument.field : undefined,
          `${drillPath}.arguments[${argumentIndex}].field`
        ])
      : [])
  ]) {
    if (fields && typeof field === 'string' && !fields.includes(field)) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'query drill field must be declared by the current card or view data source.',
        String(fieldPath)
      ));
    }
  }
  const targetPage = resolveReusablePageViews(/** @type {unknown[]} */ (dashboard.pages)
    .find((candidate) => isPlainObject(candidate) && candidate.id === drill.page));
  const targetViews = isPlainObject(targetPage)
    ? targetPage.kind === 'built-in' && isPlainObject(targetPage.definition)
      ? targetPage.definition.views
      : targetPage.views
    : undefined;
  const argumentNames = new Set(Array.isArray(drill.arguments)
    ? drill.arguments.flatMap((argument) => (
        isPlainObject(argument) && typeof argument.name === 'string' ? [argument.name] : []
      ))
    : []);
  const destinationBindsQuery = Array.isArray(targetViews) && targetViews.some((targetView) => {
    if (!isPlainObject(targetView) || !isPlainObject(targetView.data)) return false;
    const bindsQuery = targetView.data.source === drill.query
      || (Array.isArray(targetView.data.sources) && targetView.data.sources.includes(drill.query));
    if (!bindsQuery) return false;
    const boundNames = new Set(Array.isArray(targetView.data.arguments)
      ? targetView.data.arguments.flatMap((argument) => (
          isPlainObject(argument) && typeof argument.name === 'string' ? [argument.name] : []
        ))
      : []);
    return [...argumentNames].every((name) => boundNames.has(name));
  });
  if (
    typeof drill.page === 'string'
    && pageIds.has(drill.page)
    && typeof drill.query === 'string'
    && declaredQueries.has(drill.query)
    && !destinationBindsQuery
  ) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'query drill destination must bind the declared query and every drill argument.',
      drillPath
    ));
  }
}

/**
 * @param {unknown} viewAll
 * @param {unknown} viewAllNode
 * @param {string} listPath
 * @param {unknown} style
 * @param {ValidationError[]} errors
 */
function validateListViewAll(viewAll, viewAllNode, listPath, style, errors) {
  const path = `${listPath}.view-all`;
  if (viewAll === undefined) return;
  if (style !== 'entity-cards') {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'list.view-all is supported only for entity-cards lists.', path));
    return;
  }
  if (!isPlainObject(viewAll)) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'list.view-all must be a mapping.', path));
    return;
  }
  validateObjectKeys(viewAllNode, VIEW_LIST_VIEW_ALL_KEYS, path, errors);
  validateRequiredIdentifier(viewAll.page, `${path}.page`, 'list view-all page', errors);
  if (viewAll.label !== undefined) {
    validateStringField(viewAll.label, `${path}.label`, true, errors);
  }
}

/**
 * @param {unknown} encoding
 * @param {unknown} encodingNode
 * @param {unknown} mark
 * @param {string | null} sourceName
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateTableActions(encoding, encodingNode, mark, sourceName, path, errors) {
  if (!isPlainObject(encoding) || encoding.actions === undefined) return;
  if (!['list', 'table'].includes(String(mark))) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'actions is allowed only when mark is "list" or "table".', path));
    return;
  }
  if (!Array.isArray(encoding.actions) || encoding.actions.length === 0) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'actions must be a non-empty sequence.', path));
    return;
  }
  encoding.actions.forEach((action, index) => {
    const actionPath = `${path}[${index}]`;
    const actionNode = getSequenceItemNode(getValueNodeByKey(encodingNode, 'actions'), index);
    if (!isPlainObject(action)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'action must be a mapping.', actionPath));
      return;
    }
    validateObjectKeys(actionNode, TABLE_ACTION_KEYS, actionPath, errors);
    validateStringField(action.presentation, `${actionPath}.presentation`, true, errors);
    if (typeof action.presentation === 'string' && !TABLE_ACTION_PRESENTATION_VALUES.includes(action.presentation)) {
      errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'action presentation must be copy-prompt, cli-action, or external-link.', `${actionPath}.presentation`));
    }
    if (action.presentation === 'cli-action') {
      validateRequiredIdentifier(action.action, `${actionPath}.action`, 'CLI action reference', errors);
      const declaredAction = typeof action.action === 'string'
        ? declaredCliActions.get(action.action)
        : undefined;
      if (typeof action.action === 'string' && !declaredAction) {
        errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'cli-action must reference a declared dashboard CLI action.', `${actionPath}.action`));
      } else if (declaredAction?.placement !== 'row') {
        errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'cli-action must reference a row-placed dashboard CLI action.', `${actionPath}.action`));
      }
      if (action.intent !== undefined) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'cli-action table actions must not declare intent.', `${actionPath}.intent`));
      }
    } else {
      validateStringField(action.intent, `${actionPath}.intent`, true, errors);
      if (action.action !== undefined) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'copy-prompt table actions must not declare action.', `${actionPath}.action`));
      }
    }
    if (action.presentation === 'external-link' && (
      !Array.isArray(action.context)
      || action.context.length !== 1
    )) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'external-link action context must contain exactly one link field.',
        `${actionPath}.context`
      ));
    }
    validateStringField(action.icon, `${actionPath}.icon`, true, errors);
    if (typeof action.icon === 'string' && !PAGE_ICON_VALUES.includes(action.icon)) {
      errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'action icon must use one canonical icon value.', `${actionPath}.icon`));
    }
    validateStringField(action.label, `${actionPath}.label`, true, errors);
    if (!Array.isArray(action.context) || action.context.length === 0) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'action context must be a non-empty sequence of source fields.', `${actionPath}.context`));
    } else {
      const contextFields = new Set();
      action.context.forEach((field, fieldIndex) => {
        const fieldPath = `${actionPath}.context[${fieldIndex}]`;
        validateStringField(field, fieldPath, true, errors);
        if (typeof field !== 'string') return;
        if (contextFields.has(field)) {
          errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'action context fields must be unique.', fieldPath));
        }
        contextFields.add(field);
        if (sourceName && !sourceFieldNames(sourceName)?.includes(field)) {
          errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'action context field must be declared by data.source.', fieldPath));
        }
        if (action.presentation === 'external-link' && !LINK_FIELD_NAMES.includes(field)) {
          errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'external-link action context must reference a link field.', fieldPath));
        }
      });
      if (action.presentation === 'cli-action' && typeof action.action === 'string') {
        const command = declaredCliActions.get(action.action)?.command;
        const templateFields = typeof command === 'string' ? cliActionTemplateFields(command) : [];
        const contextFieldNames = action.context.filter((field) => typeof field === 'string');
        if (templateFields.length === 0 || templateFields.some((field) => !contextFieldNames.includes(field))) {
          errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'cli-action context must include every command template field.', `${actionPath}.context`));
        }
      }
    }
    if (action.when === undefined) return;
    if (!isPlainObject(action.when)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'action when must be a mapping.', `${actionPath}.when`));
      return;
    }
    validateObjectKeys(getValueNodeByKey(actionNode, 'when'), TABLE_ACTION_WHEN_KEYS, `${actionPath}.when`, errors);
    validateStringField(action.when.field, `${actionPath}.when.field`, true, errors);
    if (typeof action.when.field === 'string' && sourceName && !sourceFieldNames(sourceName)?.includes(action.when.field)) {
      errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'action when field must be declared by data.source.', `${actionPath}.when.field`));
    }
    if (!Object.hasOwn(action.when, 'equals') || ['object', 'function', 'symbol'].includes(typeof action.when.equals)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'action when equals must be a scalar.', `${actionPath}.when.equals`));
    }
  });
}

/**
 * @param {unknown} callout
 * @param {unknown} calloutNode
 * @param {unknown} mark
 * @param {unknown} title
 * @param {unknown} description
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateCallout(callout, calloutNode, mark, title, description, path, errors) {
  if (mark !== 'callout') {
    if (callout !== undefined) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'callout is allowed only when mark is "callout".',
        path
      ));
    }
    return;
  }
  if (!isPlainObject(callout)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'callout views must contain a callout mapping.',
      path
    ));
    return;
  }
  validateObjectKeys(calloutNode, CALLOUT_KEYS, path, errors);
  validateStringField(callout.label, `${path}.label`, true, errors);
  validateStringField(callout.icon, `${path}.icon`, true, errors);
  if (typeof callout.icon === 'string' && !PAGE_ICON_VALUES.includes(callout.icon)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'callout icon must use one canonical icon value.',
      `${path}.icon`
    ));
  }
  validateStringField(title, path.replace(/\.callout$/, '.title'), true, errors);
  validateStringField(description, path.replace(/\.callout$/, '.description'), true, errors);
}

/**
 * @param {unknown} titleLink
 * @param {unknown} titleLinkNode
 * @param {unknown} mark
 * @param {unknown} data
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateTitleLink(titleLink, titleLinkNode, mark, data, path, errors) {
  if (titleLink === undefined) return;
  if (!isPlainObject(titleLink)) {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'title-link must be a mapping.', path));
    return;
  }
  validateObjectKeys(titleLinkNode, VIEW_TITLE_LINK_KEYS, path, errors);
  validateStringField(titleLink['href-field'], `${path}.href-field`, true, errors);
  validateStringField(titleLink['identifier-field'], `${path}.identifier-field`, true, errors);
  if (mark !== 'element') {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'title-link is allowed only when mark is "element".',
      path
    ));
    return;
  }
  if (!isPlainObject(data) || !Array.isArray(data.sources)) return;
  const hrefField = titleLink['href-field'];
  const identifierField = titleLink['identifier-field'];
  if (typeof hrefField === 'string' && !LINK_FIELD_NAMES.includes(hrefField)) {
    errors.push(createError(
      ERROR_CODES.invalidLinkReference,
      'title-link href-field must name a relation-specific link field.',
      `${path}.href-field`
    ));
  }
  if (typeof identifierField === 'string' && LINK_FIELD_NAMES.includes(identifierField)) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'title-link identifier-field must name a scalar source field.',
      `${path}.identifier-field`
    ));
  }
  if (typeof hrefField !== 'string' || typeof identifierField !== 'string') return;
  const hasCompatibleSource = data.sources.some((sourceName) => (
    typeof sourceName === 'string'
    && sourceFieldNames(sourceName)?.includes(hrefField)
    && sourceFieldNames(sourceName)?.includes(identifierField)
  ));
  if (!hasCompatibleSource) {
    errors.push(createError(
      ERROR_CODES.invalidLinkReference,
      'title-link fields must be declared by the same selected source.',
      path
    ));
  }
}

/**
 * @param {unknown[]} views
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateProgressiveDisclosure(views, path, errors) {
  const validViews = views.filter(isPlainObject);
  for (const [index, view] of views.entries()) {
    if (isPlainObject(view)) {
      validateDisclosureValue(view.disclosure, `${path}[${index}].disclosure`, errors);
      if (
        view.disclosure === 'supplemental'
        && view.mark === 'table'
        && Object.hasOwn(view, 'title')
      ) {
        errors.push(createError(
          ERROR_CODES.invalidProgressiveDisclosureConfiguration,
          'A supplemental table uses its derived view name as the disclosure label and must not declare a title.',
          `${path}[${index}].title`
        ));
      }
    }
  }

  if (!validViews.some((view) => Object.hasOwn(view, 'disclosure'))) {
    return;
  }

  const essentialCount = validViews.filter((view) => (
    view.disclosure === undefined || view.disclosure === 'essential'
  )).length;
  if (essentialCount < 1 || essentialCount > MAX_ESSENTIAL_VIEWS_PER_PAGE) {
    errors.push(createError(
      ERROR_CODES.invalidProgressiveDisclosureConfiguration,
      `A page must expose between 1 and ${MAX_ESSENTIAL_VIEWS_PER_PAGE} essential views initially; found ${essentialCount}. Mark non-essential views as "supplemental".`,
      path
    ));
  }
}

/**
 * @param {unknown[]} views
 * @param {string} viewsPath
 * @param {ValidationError[]} errors
 * @param {string | undefined} pageId
 */
function validateGraphicalLayout(views, viewsPath, errors, pageId) {
  if (pageId !== undefined && GRAPHICAL_LAYOUT_EXEMPT_PAGE_IDS.has(pageId)) return;
  const validViews = views.filter(isPlainObject);
  const defaultOpenTables = validViews.filter((view) => (
    view.locked !== true && view.mark === 'table' && view.disclosure !== 'supplemental'
  ));
  for (const table of defaultOpenTables.slice(1)) {
    const index = views.indexOf(table);
    errors.push(createError(
      ERROR_CODES.invalidProgressiveDisclosureConfiguration,
      'Only one table may be open by default on a page. Mark additional tables as "supplemental".',
      `${viewsPath}[${index}].disclosure`
    ));
  }

  for (const [index, view] of views.entries()) {
    if (!isPlainObject(view) || view.locked === true || view.mark === 'chart' || !Object.hasOwn(view, 'views')) continue;
    errors.push(createError(
      ERROR_CODES.invalidGraphicalNesting,
      'Views are top-level boxes and must not contain nested views.',
      `${viewsPath}[${index}].views`
    ));
  }
}

/**
 * @param {unknown} disclosure
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateDisclosureValue(disclosure, path, errors) {
  if (disclosure === undefined) {
    return;
  }
  if (typeof disclosure !== 'string' || !VIEW_DISCLOSURE_VALUES.includes(disclosure)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'disclosure must be exactly "essential" or "supplemental".',
      path
    ));
  }
}

/**
 * Validates declarative query definitions and derives each query's static
 * output field schema so view encodings, filters, and order-by references can
 * be checked before execution.
 *
 * @param {unknown} queries
 * @param {unknown} queriesNode
 * @param {ValidationError[]} errors
 * @returns {Map<string, string[] | undefined>}
 */
function validateQueries(queries, queriesNode, errors) {
  /** @type {Map<string, string[] | undefined>} */
  const declared = new Map();
  if (queries === undefined) return declared;
  if (!Array.isArray(queries) || queries.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'queries must be a non-empty sequence of query definitions.',
      '$.dashboard.queries'
    ));
    return declared;
  }

  for (const [index, query] of queries.entries()) {
    const path = `$.dashboard.queries[${index}]`;
    const queryNode = getSequenceItemNode(queriesNode, index);
    if (!isPlainObject(query)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'query must be a mapping.', path));
      continue;
    }
    validateObjectKeys(queryNode, QUERY_KEYS, path, errors);
    validateRequiredIdentifier(query.name, `${path}.name`, 'query name', errors);
    validateStringField(query.intent, `${path}.intent`, true, errors);
    validateOptionalStringField(query.description, `${path}.description`, errors);
    if (query.time !== undefined) {
      validateTime(getValueNodeByKey(queryNode, 'time'), query.time, `${path}.time`, errors);
    }
    const name = typeof query.name === 'string' ? query.name : null;
    if (name && (TABLE_VALUES.includes(name) || declared.has(name))) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'query name must be unique and must not shadow a database table name.',
        `${path}.name`
      ));
    }
    const fields = validateQueryClauses(query, queryNode, path, declared, errors);
    if (name) {
      declared.set(name, fields);
      const inputs = [
        query.from,
        ...(Array.isArray(query.union) ? query.union : []),
        ...(Array.isArray(query.joins) ? query.joins.map((join) => join?.source) : [])
      ];
      const tables = new Set();
      for (const input of inputs) {
        if (typeof input !== 'string') continue;
        if (TABLE_VALUES.includes(input)) tables.add(input);
        for (const table of declaredQueryTables.get(input) ?? []) tables.add(table);
      }
      declaredQueryTables.set(name, tables);
    }
  }
  return declared;
}

/**
 * @param {Record<string, unknown>} query
 * @param {unknown} queryNode
 * @param {string} path
 * @param {Map<string, string[] | undefined>} declared
 * @param {ValidationError[]} errors
 * @returns {string[] | undefined}
 */
function validateQueryClauses(query, queryNode, path, declared, errors) {
  /** @param {unknown} source @param {string} sourcePath */
  const inputFields = (source, sourcePath) => {
    validateStringField(source, sourcePath, true, errors);
    if (typeof source !== 'string') return undefined;
    if (!TABLE_VALUES.includes(source) && !declared.has(source)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'query inputs must name one database table or one previously declared query.',
        sourcePath
      ));
      return undefined;
    }
    return TABLE_FIELDS[/** @type {keyof typeof TABLE_FIELDS} */ (source)] ?? declared.get(source);
  };

  const fromFields = inputFields(query.from, `${path}.from`);
  /** @type {Array<string[] | undefined>} */
  const unionFields = [];
  if (query.union !== undefined) {
    if (!Array.isArray(query.union) || query.union.length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'query union must be a non-empty sequence of source names.',
        `${path}.union`
      ));
    } else {
      query.union.forEach((source, index) => {
        unionFields.push(inputFields(source, `${path}.union[${index}]`));
      });
    }
  }
  /** @type {string[] | undefined} */
  let fields = fromFields
    ? [...new Set([...fromFields, ...unionFields.flatMap((candidate) => candidate ?? [])])]
    : undefined;
  /** @param {unknown} field @param {string} fieldPath */
  const requireField = (field, fieldPath) => {
    if (typeof field === 'string' && fields && !fields.includes(field)) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'query field references must name a field produced by the preceding clause.',
        fieldPath
      ));
    }
  };
  /** @param {unknown} alias @param {string} aliasPath */
  const declareField = (alias, aliasPath) => {
    if (typeof alias !== 'string' || !fields) return;
    if (fields.includes(alias)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'query output names must be unique across joined sources and computed fields.',
        aliasPath
      ));
      return;
    }
    fields.push(alias);
  };
  /**
   * Rejects field references that the canonical schema cannot satisfy: fields
   * materialized only after query execution, structured link fields used as
   * scalars, and temporal fields used as numeric measures.
   *
   * @param {unknown} field
   * @param {string} fieldPath
   * @param {'read' | 'scalar' | 'numeric'} use
   */
  const requireSchemaType = (field, fieldPath, use) => {
    if (typeof field !== 'string') return;
    if (INFERRED_FIELD_NAMES.includes(field)) {
      errors.push(createError(
        ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
        `query fields must exist in the canonical schema; "${field}" is derived after query execution.`,
        fieldPath
      ));
      return;
    }
    if (use !== 'read' && LINK_FIELD_NAMES.includes(field)) {
      errors.push(createError(
        ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
        `query operators require a scalar field; "${field}" is a structured link field.`,
        fieldPath
      ));
      return;
    }
    if (use === 'numeric' && TEMPORAL_FIELD_NAMES.includes(field)) {
      errors.push(createError(
        ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
        `numeric query operators require a numeric field; "${field}" is a timestamp field.`,
        fieldPath
      ));
    }
  };

  if (query.joins !== undefined) {
    const joinsNode = getValueNodeByKey(queryNode, 'joins');
    if (!Array.isArray(query.joins) || query.joins.length === 0 || query.joins.length > QUERY_MAX_JOINS) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `joins must be a sequence of 1 to ${QUERY_MAX_JOINS} join definitions.`,
        `${path}.joins`
      ));
    } else {
      for (const [index, join] of query.joins.entries()) {
        const joinPath = `${path}.joins[${index}]`;
        if (!isPlainObject(join)) {
          errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'join must be a mapping.', joinPath));
          continue;
        }
        validateObjectKeys(getSequenceItemNode(joinsNode, index), QUERY_JOIN_KEYS, joinPath, errors);
        const joinedFields = inputFields(join.source, `${joinPath}.source`);
        if (join.type !== undefined && (typeof join.type !== 'string' || !QUERY_JOIN_TYPE_VALUES.includes(join.type))) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            `join type must be one of ${QUERY_JOIN_TYPE_VALUES.join(', ')}.`,
            `${joinPath}.type`
          ));
        }
        if (!Array.isArray(join.on) || join.on.length === 0) {
          errors.push(createError(
            ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
            'join on must declare at least one equality key pair.',
            `${joinPath}.on`
          ));
        } else {
          for (const [pairIndex, pair] of join.on.entries()) {
            const pairPath = `${joinPath}.on[${pairIndex}]`;
            if (!isPlainObject(pair)) {
              errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'join key must be a mapping.', pairPath));
              continue;
            }
            validateObjectKeys(
              getSequenceItemNode(getValueNodeByKey(getSequenceItemNode(joinsNode, index), 'on'), pairIndex),
              QUERY_JOIN_ON_KEYS,
              pairPath,
              errors
            );
            validateStringField(pair.left, `${pairPath}.left`, true, errors);
            validateStringField(pair.right, `${pairPath}.right`, true, errors);
            requireField(pair.left, `${pairPath}.left`);
            requireSchemaType(pair.left, `${pairPath}.left`, 'scalar');
            requireSchemaType(pair.right, `${pairPath}.right`, 'scalar');
            if (typeof pair.right === 'string' && joinedFields && !joinedFields.includes(pair.right)) {
              errors.push(createError(
                ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
                'join key must name a field declared by the joined source.',
                `${pairPath}.right`
              ));
            }
          }
        }
        if (!Array.isArray(join.fields) || join.fields.length === 0) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'join fields must declare the aliased fields imported from the joined source.',
            `${joinPath}.fields`
          ));
          continue;
        }
        for (const [fieldIndex, field] of join.fields.entries()) {
          const fieldPath = `${joinPath}.fields[${fieldIndex}]`;
          if (!isPlainObject(field)) {
            errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'join field must be a mapping.', fieldPath));
            continue;
          }
          validateObjectKeys(
            getSequenceItemNode(getValueNodeByKey(getSequenceItemNode(joinsNode, index), 'fields'), fieldIndex),
            QUERY_JOIN_FIELD_KEYS,
            fieldPath,
            errors
          );
          validateStringField(field.field, `${fieldPath}.field`, true, errors);
          validateStringField(field.as, `${fieldPath}.as`, true, errors);
          if (typeof field.field === 'string' && joinedFields && !joinedFields.includes(field.field)) {
            errors.push(createError(
              ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
              'join field must name a field declared by the joined source.',
              `${fieldPath}.field`
            ));
          }
          requireSchemaType(field.field, `${fieldPath}.field`, 'read');
          declareField(field.as, `${fieldPath}.as`);
        }
      }
    }
  }

  if (query.filter !== undefined) {
    const filterPath = `${path}.filter`;
    if (!isPlainObject(query.filter)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'filter must be a mapping.', filterPath));
    } else {
      validateObjectKeys(getValueNodeByKey(queryNode, 'filter'), QUERY_FILTER_KEYS, filterPath, errors);
      if (!Array.isArray(query.filter.predicates) || query.filter.predicates.length === 0) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'filter predicates must be a non-empty sequence.',
          `${filterPath}.predicates`
        ));
      } else {
        for (const [index, predicate] of query.filter.predicates.entries()) {
          const predicatePath = `${filterPath}.predicates[${index}]`;
          if (!isPlainObject(predicate)) {
            errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'predicate must be a mapping.', predicatePath));
            continue;
          }
          validateObjectKeys(
            getSequenceItemNode(getValueNodeByKey(getValueNodeByKey(queryNode, 'filter'), 'predicates'), index),
            QUERY_PREDICATE_KEYS,
            predicatePath,
            errors
          );
          validateStringField(predicate.field, `${predicatePath}.field`, true, errors);
          requireField(predicate.field, `${predicatePath}.field`);
          requireSchemaType(predicate.field, `${predicatePath}.field`, 'scalar');
          if (predicate.equals === undefined && predicate.in === undefined && predicate.includes === undefined) {
            errors.push(createError(
              ERROR_CODES.missingOrInvalidRequiredField,
              'predicate must declare exactly one of equals, in, or includes.',
              predicatePath
            ));
          }
        }
      }
    }
  }

  if (query.compute !== undefined) {
    const computeNode = getValueNodeByKey(queryNode, 'compute');
    if (!Array.isArray(query.compute) || query.compute.length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'compute must be a non-empty sequence of computed-field definitions.',
        `${path}.compute`
      ));
    } else {
      for (const [index, computed] of query.compute.entries()) {
        const computePath = `${path}.compute[${index}]`;
        if (!isPlainObject(computed)) {
          errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'computed field must be a mapping.', computePath));
          continue;
        }
        validateObjectKeys(getSequenceItemNode(computeNode, index), QUERY_COMPUTE_KEYS, computePath, errors);
        validateStringField(computed.as, `${computePath}.as`, true, errors);
        const arity = typeof computed.function === 'string'
          ? COMPUTE_FUNCTION_ARITY[/** @type {keyof typeof COMPUTE_FUNCTION_ARITY} */ (computed.function)]
          : undefined;
        if (!arity) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            `computed field function must be one of ${Object.keys(COMPUTE_FUNCTION_ARITY).join(', ')}.`,
            `${computePath}.function`
          ));
        }
        if (!Array.isArray(computed.args) || (arity && (computed.args.length < arity[0] || computed.args.length > arity[1]))) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            arity
              ? `computed field "${String(computed.function)}" accepts between ${arity[0]} and ${arity[1]} arguments.`
              : 'computed field args must be a sequence.',
            `${computePath}.args`
          ));
        } else {
          for (const [argIndex, argument] of computed.args.entries()) {
            const argumentPath = `${computePath}.args[${argIndex}]`;
            if (!isPlainObject(argument)) {
              errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'computed argument must be a mapping.', argumentPath));
              continue;
            }
            validateObjectKeys(
              getSequenceItemNode(getValueNodeByKey(getSequenceItemNode(computeNode, index), 'args'), argIndex),
              QUERY_COMPUTE_ARGUMENT_KEYS,
              argumentPath,
              errors
            );
            const hasField = argument.field !== undefined;
            const hasValue = argument.value !== undefined;
            const hasContext = argument.context !== undefined;
            if (Number(hasField) + Number(hasValue) + Number(hasContext) !== 1) {
              errors.push(createError(
                ERROR_CODES.missingOrInvalidRequiredField,
                'computed argument must declare exactly one of field, value, or context.',
                argumentPath
              ));
              continue;
            }
            if (hasField) {
              validateStringField(argument.field, `${argumentPath}.field`, true, errors);
              requireField(argument.field, `${argumentPath}.field`);
              requireSchemaType(
                argument.field,
                `${argumentPath}.field`,
                typeof computed.function !== 'string' ? 'read'
                  : NUMERIC_COMPUTE_FUNCTIONS.includes(computed.function) ? 'numeric'
                    : ['coalesce', 'dashboard-link', 'link-href'].includes(computed.function) ? 'read' : 'scalar'
              );
            } else if (hasContext && argument.context !== 'time-end') {
              errors.push(createError(
                ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
                'computed argument context must be time-end.',
                `${argumentPath}.context`
              ));
            } else if (hasValue && !['string', 'number', 'boolean'].includes(typeof argument.value)) {
              errors.push(createError(
                ERROR_CODES.missingOrInvalidRequiredField,
                'computed argument value must be a string, number, or boolean literal.',
                `${argumentPath}.value`
              ));
            }
          }
        }
        declareField(computed.as, `${computePath}.as`);
      }
    }
  }

  if (query['temporal-series'] !== undefined) {
    const seriesPath = `${path}.temporal-series`;
    const seriesNode = getValueNodeByKey(queryNode, 'temporal-series');
    const definition = query['temporal-series'];
    if (!isPlainObject(definition)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'temporal-series must be a mapping.', seriesPath));
    } else {
      validateObjectKeys(seriesNode, QUERY_TEMPORAL_SERIES_KEYS, seriesPath, errors);
      for (const key of ['time', 'series']) {
        validateStringField(definition[key], `${seriesPath}.${key}`, true, errors);
        requireField(definition[key], `${seriesPath}.${key}`);
      }
      const shape = definition.shape;
      if (shape !== undefined
          && (typeof shape !== 'string' || (shape !== 'tidy' && shape !== 'groups'))) {
        errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'temporal-series shape must be tidy or groups.', `${seriesPath}.shape`));
      }
      const carry = definition.carry;
      if (carry !== undefined && (!Array.isArray(carry) || carry.length === 0 || carry.length > 16)) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'temporal-series carry must contain 1 to 16 fields.', `${seriesPath}.carry`));
      } else if (Array.isArray(carry)) {
        carry.forEach((field, index) => {
          validateStringField(field, `${seriesPath}.carry[${index}]`, true, errors);
          requireField(field, `${seriesPath}.carry[${index}]`);
        });
      }
      const measures = definition.measures;
      const maps = definition.maps;
      if ((!Array.isArray(measures) || measures.length === 0) && (!Array.isArray(maps) || maps.length === 0)) {
        errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'temporal-series must declare at least one measure or map.', seriesPath));
      }
      validateTemporalSeriesEntries(measures, getValueNodeByKey(seriesNode, 'measures'), `${seriesPath}.measures`, QUERY_TEMPORAL_SERIES_MEASURE_KEYS, ['field', 'key'], requireField, errors);
      validateTemporalSeriesEntries(maps, getValueNodeByKey(seriesNode, 'maps'), `${seriesPath}.maps`, QUERY_TEMPORAL_SERIES_MAP_KEYS, ['field', 'definitions', 'group'], requireField, errors);
      fields = fields
        ? definition.shape === 'groups'
          ? [...(Array.isArray(carry) ? carry.filter((field) => typeof field === 'string') : []), 'metric', 'metric-key', 'metric-name', 'metric-kind', 'metric-group', 'points']
          : [...(Array.isArray(carry) ? carry.filter((field) => typeof field === 'string') : []), 'time', 'series', 'metric', 'metric-key', 'metric-name', 'metric-kind', 'metric-group', 'value']
        : undefined;
    }
  }

  if (query.aggregate !== undefined) {
    const aggregatePath = `${path}.aggregate`;
    const aggregateNode = getValueNodeByKey(queryNode, 'aggregate');
    if (!isPlainObject(query.aggregate)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'aggregate must be a mapping.', aggregatePath));
    } else {
      validateObjectKeys(aggregateNode, QUERY_AGGREGATE_KEYS, aggregatePath, errors);
      /** @type {string[]} */
      const grouped = [];
      if (query.aggregate.by !== undefined) {
        if (!Array.isArray(query.aggregate.by)) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'aggregate by must be a sequence of grouping fields.',
            `${aggregatePath}.by`
          ));
        } else {
          for (const [index, field] of query.aggregate.by.entries()) {
            validateStringField(field, `${aggregatePath}.by[${index}]`, true, errors);
            requireField(field, `${aggregatePath}.by[${index}]`);
            requireSchemaType(field, `${aggregatePath}.by[${index}]`, 'scalar');
            if (typeof field === 'string') grouped.push(field);
          }
        }
      }
      if (!Array.isArray(query.aggregate.values)
          || query.aggregate.values.length === 0
          || query.aggregate.values.length > DASHBOARD_QUERY_LIMITS['max-aggregate-values']) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          `aggregate values must be a sequence of 1 to ${DASHBOARD_QUERY_LIMITS['max-aggregate-values']} definitions.`,
          `${aggregatePath}.values`
        ));
      } else {
        for (const [index, value] of query.aggregate.values.entries()) {
          const valuePath = `${aggregatePath}.values[${index}]`;
          if (!isPlainObject(value)) {
            errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'aggregate value must be a mapping.', valuePath));
            continue;
          }
          validateObjectKeys(
            getSequenceItemNode(getValueNodeByKey(aggregateNode, 'values'), index),
            QUERY_AGGREGATE_VALUE_KEYS,
            valuePath,
            errors
          );
          validateStringField(value.field, `${valuePath}.field`, true, errors);
          validateStringField(value.as, `${valuePath}.as`, true, errors);
          requireField(value.field, `${valuePath}.field`);
          requireSchemaType(
            value.field,
            `${valuePath}.field`,
            typeof value.reducer === 'string' && QUERY_NUMERIC_REDUCER_VALUES.includes(value.reducer)
              ? 'numeric'
              : 'scalar'
          );
          if (typeof value.reducer !== 'string' || !QUERY_REDUCER_VALUES.includes(value.reducer)) {
            errors.push(createError(
              ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
              `aggregate reducer must be one of ${QUERY_REDUCER_VALUES.join(', ')}.`,
              `${valuePath}.reducer`
            ));
          }
          if (value.filter !== undefined) {
            const filterPath = `${valuePath}.filter`;
            const filterNode = getValueNodeByKey(
              getSequenceItemNode(getValueNodeByKey(aggregateNode, 'values'), index),
              'filter'
            );
            if (!isPlainObject(value.filter)) {
              errors.push(createError(
                ERROR_CODES.missingOrInvalidRequiredField,
                'aggregate filter must be a mapping.',
                filterPath
              ));
            } else {
              validateObjectKeys(filterNode, QUERY_FILTER_KEYS, filterPath, errors);
              const predicates = value.filter.predicates;
              if (!Array.isArray(predicates)
                  || predicates.length === 0
                  || predicates.length > DASHBOARD_QUERY_LIMITS['max-aggregate-filter-predicates']) {
                errors.push(createError(
                  ERROR_CODES.missingOrInvalidRequiredField,
                  `aggregate filter predicates must be a sequence of 1 to ${DASHBOARD_QUERY_LIMITS['max-aggregate-filter-predicates']} definitions.`,
                  `${filterPath}.predicates`
                ));
              } else {
                for (const [predicateIndex, predicate] of predicates.entries()) {
                  const predicatePath = `${filterPath}.predicates[${predicateIndex}]`;
                  if (!isPlainObject(predicate)) {
                    errors.push(createError(
                      ERROR_CODES.missingOrInvalidRequiredField,
                      'aggregate filter predicate must be a mapping.',
                      predicatePath
                    ));
                    continue;
                  }
                  validateObjectKeys(
                    getSequenceItemNode(getValueNodeByKey(filterNode, 'predicates'), predicateIndex),
                    QUERY_AGGREGATE_FILTER_PREDICATE_KEYS,
                    predicatePath,
                    errors
                  );
                  validateStringField(predicate.field, `${predicatePath}.field`, true, errors);
                  requireField(predicate.field, `${predicatePath}.field`);
                  requireSchemaType(predicate.field, `${predicatePath}.field`, 'scalar');
                  const hasEquals = Object.hasOwn(predicate, 'equals');
                  const hasIn = Object.hasOwn(predicate, 'in');
                  if (Number(hasEquals) + Number(hasIn) !== 1) {
                    errors.push(createError(
                      ERROR_CODES.missingOrInvalidRequiredField,
                      'aggregate filter predicate must declare exactly one of equals or in.',
                      predicatePath
                    ));
                  } else if (hasEquals && !isAggregateFilterLiteral(predicate.equals)) {
                    errors.push(createError(
                      ERROR_CODES.missingOrInvalidRequiredField,
                      'aggregate filter equals must be a string, number, or boolean literal.',
                      `${predicatePath}.equals`
                    ));
                  } else if (hasIn && (
                    !Array.isArray(predicate.in)
                    || predicate.in.length === 0
                    || predicate.in.length > DASHBOARD_QUERY_LIMITS['max-predicate-alternatives']
                    || predicate.in.some((candidate) => !isAggregateFilterLiteral(candidate))
                  )) {
                    errors.push(createError(
                      ERROR_CODES.missingOrInvalidRequiredField,
                      `aggregate filter in must contain 1 to ${DASHBOARD_QUERY_LIMITS['max-predicate-alternatives']} string, number, or boolean literals.`,
                      `${predicatePath}.in`
                    ));
                  }
                }
              }
            }
          }
          if (typeof value.as === 'string' && grouped.includes(value.as)) {
            errors.push(createError(
              ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
              'query output names must be unique across joined sources and computed fields.',
              `${valuePath}.as`
            ));
          }

          if (typeof value.as === 'string') grouped.push(value.as);
        }
      }
      fields = fields ? grouped : undefined;
    }
  }

  if (query.predict !== undefined) {
    const predictNode = getValueNodeByKey(queryNode, 'predict');
    if (!Array.isArray(query.predict) || query.predict.length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'predict must be a non-empty sequence of prediction definitions.',
        `${path}.predict`
      ));
    } else {
      for (const [index, prediction] of query.predict.entries()) {
        const predictionPath = `${path}.predict[${index}]`;
        if (!isPlainObject(prediction)) {
          errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'prediction must be a mapping.', predictionPath));
          continue;
        }
        validateObjectKeys(getSequenceItemNode(predictNode, index), QUERY_PREDICT_KEYS, predictionPath, errors);
        validateStringField(prediction.field, `${predictionPath}.field`, true, errors);
        validateStringField(prediction.as, `${predictionPath}.as`, true, errors);
        requireField(prediction.field, `${predictionPath}.field`);
        requireSchemaType(prediction.field, `${predictionPath}.field`, 'numeric');

        const predictors = typeof prediction.on === 'string'
          ? [prediction.on]
          : Array.isArray(prediction.on) ? prediction.on : [];
        if (predictors.length === 0 || predictors.length > 8) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'prediction on must be one field or a sequence of 1 to 8 predictor fields.',
            `${predictionPath}.on`
          ));
        }
        for (const [predictorIndex, predictor] of predictors.entries()) {
          const predictorPath = Array.isArray(prediction.on)
            ? `${predictionPath}.on[${predictorIndex}]`
            : `${predictionPath}.on`;
          validateStringField(predictor, predictorPath, true, errors);
          requireField(predictor, predictorPath);
          requireSchemaType(predictor, predictorPath, 'numeric');
        }
        if (new Set(predictors).size !== predictors.length) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            'prediction on must not contain duplicate predictor fields.',
            `${predictionPath}.on`
          ));
        }

        const method = prediction.method ?? 'linear';
        if (typeof method !== 'string' || !PREDICTION_METHODS.includes(method)) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            `prediction method must be one of ${PREDICTION_METHODS.join(', ')}.`,
            `${predictionPath}.method`
          ));
        } else if (method !== 'linear' && predictors.length !== 1) {
          errors.push(createError(
            ERROR_CODES.missingOrInvalidRequiredField,
            `prediction method ${method} requires exactly one predictor field.`,
            `${predictionPath}.on`
          ));
        }
        if (prediction.order !== undefined) {
          if (method !== 'poly' || !Number.isSafeInteger(prediction.order)
              || Number(prediction.order) < 1 || Number(prediction.order) > 10) {
            errors.push(createError(
              ERROR_CODES.missingOrInvalidRequiredField,
              'prediction order is allowed only for poly and must be an integer from 1 to 10.',
              `${predictionPath}.order`
            ));
          }
        }

        if (prediction.groupby !== undefined) {
          if (!Array.isArray(prediction.groupby) || prediction.groupby.length === 0) {
            errors.push(createError(
              ERROR_CODES.missingOrInvalidRequiredField,
              'prediction groupby must be a non-empty sequence of grouping fields.',
              `${predictionPath}.groupby`
            ));
          } else {
            for (const [groupIndex, groupField] of prediction.groupby.entries()) {
              const groupPath = `${predictionPath}.groupby[${groupIndex}]`;
              validateStringField(groupField, groupPath, true, errors);
              requireField(groupField, groupPath);
              requireSchemaType(groupField, groupPath, 'scalar');
            }
          }
        }
        declareField(prediction.as, `${predictionPath}.as`);
      }
    }
  }

  if (query.select !== undefined) {
    const selectNode = getValueNodeByKey(queryNode, 'select');
    if (!Array.isArray(query.select) || query.select.length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'select must be a non-empty sequence of projected fields.',
        `${path}.select`
      ));
    } else {
      /** @type {string[]} */
      const projected = [];
      for (const [index, field] of query.select.entries()) {
        const selectPath = `${path}.select[${index}]`;
        if (!isPlainObject(field)) {
          errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'select entry must be a mapping.', selectPath));
          continue;
        }
        validateObjectKeys(getSequenceItemNode(selectNode, index), QUERY_SELECT_KEYS, selectPath, errors);
        validateStringField(field.field, `${selectPath}.field`, true, errors);
        validateOptionalStringField(field.as, `${selectPath}.as`, errors);
        requireField(field.field, `${selectPath}.field`);
        requireSchemaType(field.field, `${selectPath}.field`, 'read');
        const alias = typeof field.as === 'string' ? field.as : field.field;
        if (typeof alias === 'string') {
          if (projected.includes(alias)) {
            errors.push(createError(
              ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
              'select output names must be unique.',
              `${selectPath}.as`
            ));
          } else {
            projected.push(alias);
          }
        }
      }
      fields = fields ? projected : undefined;
    }
  }

  if (query['order-by'] !== undefined) {
    if (!Array.isArray(query['order-by']) || query['order-by'].length === 0) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'order-by must be a non-empty sequence of ordering clauses.',
        `${path}.order-by`
      ));
    } else {
      for (const [index, clause] of query['order-by'].entries()) {
        const clausePath = `${path}.order-by[${index}]`;
        if (!isPlainObject(clause)) {
          errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'order-by clause must be a mapping.', clausePath));
          continue;
        }
        validateObjectKeys(
          getSequenceItemNode(getValueNodeByKey(queryNode, 'order-by'), index),
          ORDER_BY_KEYS,
          clausePath,
          errors
        );
        validateStringField(clause.field, `${clausePath}.field`, true, errors);
        requireField(clause.field, `${clausePath}.field`);
        requireSchemaType(clause.field, `${clausePath}.field`, 'scalar');
        if (clause.direction !== undefined
            && (typeof clause.direction !== 'string' || !ORDER_DIRECTION_VALUES.includes(clause.direction))) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            `order-by direction must be one of ${ORDER_DIRECTION_VALUES.join(', ')}.`,
            `${clausePath}.direction`
          ));
        }
      }
    }
  }

  if (query.limit !== undefined
      && (!Number.isSafeInteger(query.limit) || Number(query.limit) <= 0
        || Number(query.limit) > DASHBOARD_QUERY_LIMITS['max-output-rows'])) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      `limit must be a positive integer no greater than ${DASHBOARD_QUERY_LIMITS['max-output-rows']}.`,
      `${path}.limit`
    ));
  }

  return fields;
}

/**
 * @param {unknown} source
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateSource(source, path, errors) {
  validateStringField(source, path, true, errors);
  if (typeof source === 'string' && !TABLE_VALUES.includes(source) && !declaredQueries.has(source)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'source must name one Section 5.1 database table or one declared query.',
      path
    ));
  }
}

/**
 * Resolves the declared field schema of a database table or of a derived
 * query. Returns `undefined` when the schema cannot be derived statically, in
 * which case field references are not checked.
 * @param {string} sourceName
 * @returns {string[] | undefined}
 */
function sourceFieldNames(sourceName) {
  return TABLE_FIELDS[/** @type {keyof typeof TABLE_FIELDS} */ (sourceName)]
    ?? declaredQueries.get(sourceName)
    ?? undefined;
}

/**
 * @param {unknown} sources
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateSourceSequence(sources, path, errors) {
  if (!Array.isArray(sources) || sources.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'sources must be a non-empty sequence of database table or query names.',
      path
    ));
    return;
  }
  const seen = new Set();
  for (const [index, source] of sources.entries()) {
    validateSource(source, `${path}[${index}]`, errors);
    if (typeof source === 'string') {
      if (seen.has(source)) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'sources must not contain duplicate source names.',
          `${path}[${index}]`
        ));
      }
      seen.add(source);
    }
  }
}

/**
 * @param {unknown} data
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateSemanticFieldLiterals(data, path, errors) {
  if (!isPlainObject(data)) {
    return;
  }

  validateFilterLiteralSet(data.filters, `${path}.filters`, errors);
}

/**
 * @param {unknown} contextNode
 * @param {Record<string, unknown>} context
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateContext(contextNode, context, path, errors) {
  validateScope(getValueNodeByKey(contextNode, 'scope'), context.scope, `${path}.scope`, errors);
  validateTime(getValueNodeByKey(contextNode, 'time'), context.time, `${path}.time`, errors);
  validateFilters(getValueNodeByKey(contextNode, 'filters'), context.filters, `${path}.filters`, errors);
  validateLimit(context.limit, `${path}.limit`, errors);
  validateOrderBy(getValueNodeByKey(contextNode, 'order-by'), context['order-by'], `${path}.order-by`, errors);
}

/**
 * @param {unknown} scopeNode
 * @param {unknown} scope
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateScope(scopeNode, scope, path, errors) {
  if (scope === undefined) {
    return;
  }

  if (!isPlainObject(scope)) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'scope must be a mapping.',
      path
    ));
    return;
  }

  validateObjectKeys(scopeNode, SCOPE_KEYS, path, errors);
  for (const key of SCOPE_KEYS) {
    const value = scope[key];
    if (value !== undefined) {
      validateNonEmptyStringSequence(value, `${path}.${key}`, `${key} must be a non-empty sequence of non-empty strings.`, errors);
    }
  }
}

/**
 * @param {unknown} timeNode
 * @param {unknown} time
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateTime(timeNode, time, path, errors) {
  if (time === undefined) {
    return;
  }

  if (!isPlainObject(time)) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'time must be a mapping.',
      path
    ));
    return;
  }

  validateObjectKeys(timeNode, TIME_KEYS, path, errors);

  const range = time.range;
  const start = time.start;
  const end = time.end;

  if (range !== undefined) {
    if (typeof range !== 'string' || !/^[1-9][0-9]*(h|d|w)$/.test(range)) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'time.range must match ^[1-9][0-9]*(h|d|w)$.',
        `${path}.range`
      ));
    }

    if (start !== undefined || end !== undefined) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'time.range must not appear with time.start or time.end.',
        path
      ));
    }
    return;
  }

  if (start !== undefined && !isRfc3339Timestamp(start)) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'time.start must be an RFC 3339 timestamp.',
      `${path}.start`
    ));
  }

  if (end !== undefined && !isRfc3339Timestamp(end)) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'time.end must be an RFC 3339 timestamp.',
      `${path}.end`
    ));
  }

  if (typeof start === 'string' && typeof end === 'string' && isRfc3339Timestamp(start) && isRfc3339Timestamp(end)) {
    if (Date.parse(start) >= Date.parse(end)) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'time.start must precede time.end.',
        path
      ));
    }
  }
}

/**
 * @param {unknown} filtersNode
 * @param {unknown} filters
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateFilters(filtersNode, filters, path, errors) {
  if (filters === undefined) {
    return;
  }

  if (!isPlainObject(filters)) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'filters must be a mapping.',
      path
    ));
    return;
  }

  validateObjectKeys(filtersNode, FILTER_DIMENSION_VALUES, path, errors);
  for (const [key, value] of Object.entries(filters)) {
    validateFilterValue(value, `${path}.${key}`, errors);
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateFilterValue(value, path, errors) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'filter sequences must be non-empty.',
        path
      ));
      return;
    }

    for (const [index, item] of value.entries()) {
      if (typeof item !== 'string' || item.length === 0) {
        errors.push(createError(
          ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
          'filter values must be non-empty strings or non-empty sequences of non-empty strings.',
          `${path}[${index}]`
        ));
      }
    }
    return;
  }

  if (typeof value !== 'string' || value.length === 0) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'filter values must be non-empty strings or non-empty sequences of non-empty strings.',
      path
    ));
  }
}

/**
 * @param {unknown} limit
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateLimit(limit, path, errors) {
  if (limit === undefined) {
    return;
  }

  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'limit must be a positive integer.',
      path
    ));
  }
}

/**
 * @param {unknown} orderByNode
 * @param {unknown} orderBy
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateOrderBy(orderByNode, orderBy, path, errors) {
  if (orderBy === undefined) {
    return;
  }

  if (!Array.isArray(orderBy) || orderBy.length === 0) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'order-by must be a non-empty sequence.',
      path
    ));
    return;
  }

  for (const [index, clause] of orderBy.entries()) {
    const clausePath = `${path}[${index}]`;
    const clauseNode = getSequenceItemNode(orderByNode, index);
    if (!isPlainObject(clause)) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'order-by entries must be mappings.',
        clausePath
      ));
      continue;
    }

    validateObjectKeys(clauseNode, ORDER_BY_KEYS, clausePath, errors);
    validateStringField(clause.field, `${clausePath}.field`, true, errors);
    validateStringField(clause.direction, `${clausePath}.direction`, true, errors);
    if (typeof clause.direction === 'string' && !ORDER_DIRECTION_VALUES.includes(clause.direction)) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'order-by.direction must be exactly "asc" or "desc".',
        `${clausePath}.direction`
      ));
    }
  }
}

/**
 * @param {unknown} filters
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateFilterLiteralSet(filters, path, errors) {
  if (!isPlainObject(filters)) {
    return;
  }

  for (const [field, allowedValues] of Object.entries(SEMANTIC_FILTER_VALUE_SETS)) {
    const value = filters[field];
    if (value !== undefined) {
      validateEnumeratedFilterValue(value, allowedValues, `${path}.${field}`, errors);
    }
  }
}

/**
 * @param {unknown} dataNode
 * @param {unknown} data
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateDatasetMetadata(dataNode, data, path, errors) {
  if (!isPlainObject(data)) {
    return;
  }

  const metadata = data['source-metadata'];
  if (metadata === undefined) {
    return;
  }

  const metadataPath = `${path}.source-metadata`;
  if (!isPlainObject(metadata)) {
    errors.push(createError(
      ERROR_CODES.missingRequiredProvenanceOrDataStateMetadata,
      'source-metadata must be a mapping when provided.',
      metadataPath
    ));
    return;
  }

  rejectSensitiveStringsInObject(metadata, metadataPath, errors);

  const metadataNode = getValueNodeByKey(dataNode, 'source-metadata');
  validateObjectKeys(metadataNode, DATASET_METADATA_KEYS, metadataPath, errors);

  for (const key of ['source-id', 'source-kind', 'as-of', 'retrieved-at', 'completeness', 'freshness']) {
    validateStringField(metadata[key], `${metadataPath}.${key}`, true, errors);
  }

  for (const key of ['coverage-start', 'coverage-end']) {
    if (metadata[key] !== undefined && !isRfc3339Timestamp(metadata[key])) {
      errors.push(createError(
        ERROR_CODES.missingRequiredProvenanceOrDataStateMetadata,
        `${key} must be an RFC 3339 timestamp when provided.`,
        `${metadataPath}.${key}`
      ));
    }
  }

  for (const key of ['as-of', 'retrieved-at']) {
    if (metadata[key] !== undefined && !isRfc3339Timestamp(metadata[key])) {
      errors.push(createError(
        ERROR_CODES.missingRequiredProvenanceOrDataStateMetadata,
        `${key} must be an RFC 3339 timestamp.`,
        `${metadataPath}.${key}`
      ));
    }
  }

  if (
    typeof metadata['coverage-start'] === 'string' &&
    typeof metadata['coverage-end'] === 'string' &&
    isRfc3339Timestamp(metadata['coverage-start']) &&
    isRfc3339Timestamp(metadata['coverage-end']) &&
    Date.parse(metadata['coverage-start']) >= Date.parse(metadata['coverage-end'])
  ) {
    errors.push(createError(
      ERROR_CODES.missingRequiredProvenanceOrDataStateMetadata,
      'coverage-start must precede coverage-end.',
      metadataPath
    ));
  }

  validateEnumeratedMetadataValue(
    metadata.completeness,
    DATASET_COMPLETENESS_VALUES,
    `${metadataPath}.completeness`,
    'completeness',
    errors
  );
  validateEnumeratedMetadataValue(
    metadata.freshness,
    DATASET_FRESHNESS_VALUES,
    `${metadataPath}.freshness`,
    'freshness',
    errors
  );

  if (metadata['provenance-link'] !== undefined) {
    validateLinkObject(metadata['provenance-link'], `${metadataPath}.provenance-link`, 'provenance-link', errors, {
      code: ERROR_CODES.missingRequiredProvenanceOrDataStateMetadata
    });
  }

  if (metadata.availability !== undefined) {
    validateEnumeratedMetadataValue(
      metadata.availability,
      DATASET_AVAILABILITY_VALUES,
      `${metadataPath}.availability`,
      'availability',
      errors
    );
  }
}

/**
 * @param {unknown} encodingNode
 * @param {unknown} encoding
 * @param {unknown} mark
 * @param {unknown} chart
 * @param {string | null} sourceName
 * @param {unknown} data
 * @param {string} viewPath
 * @param {ValidationError[]} errors
 */
function validateEncoding(encodingNode, encoding, mark, chart, sourceName, data, viewPath, errors) {
  if (mark === 'element' || mark === 'callout') {
    if (encoding !== undefined) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `${mark} views must not declare encoding.`,
        `${viewPath}.encoding`
      ));
    }
    return;
  }

  if (!isPlainObject(encoding)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'encoding must be a mapping.',
      `${viewPath}.encoding`
    ));
    return;
  }

  validateObjectKeys(encodingNode, VIEW_ENCODING_KEYS, `${viewPath}.encoding`, errors);

  /** @type {Map<string, string>} */
  const aggregateOutputIds = new Map();
  const markValue = typeof mark === 'string' ? mark : null;
  if (markValue !== 'chart' && encoding.weight !== undefined) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'weight encoding is supported only by chart views.',
      `${viewPath}.encoding.weight`
    ));
  }
  const displayForbiddenChannels = ['list', 'table'].includes(markValue ?? '')
    ? ['href']
    : ['value', 'x', 'y', 'color', 'weight', 'reference', 'href'];
  for (const channel of displayForbiddenChannels) {
    if (isPlainObject(encoding[channel]) && encoding[channel].display !== undefined) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'display is allowed only on table column field definitions.',
        `${viewPath}.encoding.${channel}.display`
      ));
    }
  }
  const filterForbiddenChannels = ['list', 'table'].includes(markValue ?? '')
    ? ['href']
    : ['value', 'x', 'y', 'color', 'weight', 'reference', 'href'];
  for (const channel of filterForbiddenChannels) {
    if (isPlainObject(encoding[channel]) && encoding[channel].filter !== undefined) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'filter is allowed only on table column field definitions.',
        `${viewPath}.encoding.${channel}.filter`
      ));
    }
  }

  if (markValue === 'metric') {
    validateMetricEncoding(encodingNode, encoding, sourceName, `${viewPath}.encoding`, aggregateOutputIds, errors);
  } else if (markValue === 'table') {
    validateTableEncoding(encodingNode, encoding, sourceName, `${viewPath}.encoding`, aggregateOutputIds, errors, 'table');
  } else if (markValue === 'list') {
    validateTableEncoding(encodingNode, encoding, sourceName, `${viewPath}.encoding`, aggregateOutputIds, errors, 'list');
  } else if (markValue === 'chart') {
    validateChartEncoding(encodingNode, encoding, chart, sourceName, `${viewPath}.encoding`, aggregateOutputIds, errors);
    validateChartWidget(encoding, chart, viewPath, errors);
  }

  validateOrderByReferences(data, encoding, aggregateOutputIds, sourceName, viewPath, errors);
}

/**
 * @param {Record<string, unknown>} encoding
 * @param {unknown} chart
 * @param {string} viewPath
 * @param {ValidationError[]} errors
 */
function validateChartWidget(encoding, chart, viewPath, errors) {
  if (chart === undefined) {
    return;
  }
  if (Array.isArray(encoding.y)) {
    if (chart !== 'line') {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'multiple y fields are supported only by line charts.',
        `${viewPath}.encoding.y`
      ));
    }
    if (encoding.y.length < 2 || encoding.y.length > 8) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'multiple-measure line charts must encode between two and eight y fields.',
        `${viewPath}.encoding.y`
      ));
    }
    if (encoding.color !== undefined) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'multiple-measure line charts must not also encode color.',
        `${viewPath}.encoding.color`
      ));
    }
  }
  if (['dot', 'line', 'scatter'].includes(String(chart)) && isPlainObject(encoding.x) && encoding.x.type !== undefined && encoding.x.type !== 'temporal') {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      `${chart} chart x encoding must be temporal when explicitly typed.`,
      `${viewPath}.encoding.x.type`
    ));
  }
  if (
    chart === 'area'
    && isPlainObject(encoding.x)
    && encoding.x.type !== undefined
    && !['ordinal', 'temporal'].includes(String(encoding.x.type))
  ) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'area chart x encoding must be ordinal or temporal when explicitly typed.',
      `${viewPath}.encoding.x.type`
    ));
  }
  if (chart !== 'dot' && encoding.reference !== undefined) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'reference encoding is supported only by dot charts.',
      `${viewPath}.encoding.reference`
    ));
  }
  if (chart === 'pie' && isPlainObject(encoding.x) && encoding.x.type !== undefined && !['nominal', 'ordinal'].includes(String(encoding.x.type))) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'pie chart x encoding must be nominal or ordinal when explicitly typed.',
      `${viewPath}.encoding.x.type`
    ));
  }
  if (chart === 'histogram' && isPlainObject(encoding.x) && encoding.x.type !== undefined && !['nominal', 'ordinal'].includes(String(encoding.x.type))) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'histogram chart x encoding must be nominal or ordinal when explicitly typed.',
      `${viewPath}.encoding.x.type`
    ));
  }
  if (chart === 'horizontal-bar' && isPlainObject(encoding.x)) {
    const xField = typeof encoding.x.field === 'string' ? encoding.x.field : null;
    const xType = encoding.x.type;
    const hasNonCategoricalIntrinsicType = xField !== null && (
      TEMPORAL_FIELD_NAMES.includes(xField)
      || ADDITIVE_MEASURE_FIELDS.includes(xField)
      || NON_ADDITIVE_MEASURE_FIELDS.includes(xField)
    );
    if (
      (xType !== undefined && !['nominal', 'ordinal'].includes(String(xType)))
      || (xType === undefined && hasNonCategoricalIntrinsicType)
    ) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'horizontal-bar chart x encoding must be nominal or ordinal.',
        `${viewPath}.encoding.x.type`
      ));
    }
  }
  if (chart === 'histogram') {
    for (const channel of ['color', 'href']) {
      if (encoding[channel] !== undefined) {
        errors.push(createError(
          ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
          `histogram charts must not encode ${channel}.`,
          `${viewPath}.encoding.${channel}`
        ));
      }
    }
  }
  if (chart === 'heatmap') {
    for (const channel of ['x', 'y']) {
      if (
        isPlainObject(encoding[channel])
        && encoding[channel].type !== undefined
        && !['nominal', 'ordinal'].includes(String(encoding[channel].type))
      ) {
        errors.push(createError(
          ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
          `heatmap chart ${channel} encoding must be nominal or ordinal when explicitly typed.`,
          `${viewPath}.encoding.${channel}.type`
        ));
      }
    }
    if (!isPlainObject(encoding.color)) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'heatmap charts must encode quantitative color.',
        `${viewPath}.encoding.color`
      ));
    } else {
      if (encoding.color.type !== undefined && encoding.color.type !== 'quantitative') {
        errors.push(createError(
          ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
          'heatmap chart color encoding must be quantitative when explicitly typed.',
          `${viewPath}.encoding.color.type`
        ));
      }
      if (encoding.color.aggregate === undefined || encoding.color.aggregate === 'none') {
        errors.push(createError(
          ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
          'heatmap chart color encoding must aggregate each discrete cell.',
          `${viewPath}.encoding.color.aggregate`
        ));
      }
    }
  }
  if (chart === 'swimlane') {
    if (isPlainObject(encoding.x) && encoding.x.type !== undefined && encoding.x.type !== 'temporal') {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'swimlane chart x encoding must be temporal when explicitly typed.',
        `${viewPath}.encoding.x.type`
      ));
    }
    if (isPlainObject(encoding.x) && encoding.x['time-unit'] !== undefined) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'swimlane chart x encoding must preserve individual timestamps and must not declare time-unit.',
        `${viewPath}.encoding.x.time-unit`
      ));
    }
    if (isPlainObject(encoding.y) && encoding.y.aggregate !== undefined && encoding.y.aggregate !== 'none') {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'swimlane chart y encoding must preserve individual observations and must not aggregate.',
        `${viewPath}.encoding.y.aggregate`
      ));
    }
  }
}

/**
 * @param {unknown} encodingNode
 * @param {Record<string, unknown>} encoding
 * @param {string | null} sourceName
 * @param {string} path
 * @param {Map<string, string>} aggregateOutputIds
 * @param {ValidationError[]} errors
 */
function validateMetricEncoding(encodingNode, encoding, sourceName, path, aggregateOutputIds, errors) {
  validateRequiredFieldDefinition(getValueNodeByKey(encodingNode, 'value'), encoding.value, sourceName, `${path}.value`, aggregateOutputIds, errors);

  const valueFieldDefinition = isPlainObject(encoding.value) ? encoding.value : null;
  if (valueFieldDefinition && valueFieldDefinition['time-unit'] !== undefined) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'metric value encoding must not declare time-unit.',
      `${path}.value.time-unit`
    ));
  }

  if (valueFieldDefinition && valueFieldDefinition.type !== undefined && valueFieldDefinition.type !== 'quantitative') {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'metric value encoding must be quantitative when explicitly typed.',
      `${path}.value.type`
    ));
  }

  for (const forbiddenChannel of ['columns', 'x', 'y', 'color']) {
    if (encoding[forbiddenChannel] !== undefined) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `metric views must not encode ${forbiddenChannel}.`,
        `${path}.${forbiddenChannel}`
      ));
    }
  }

  if (encoding.href !== undefined) {
    validateHrefFieldDefinition(getValueNodeByKey(encodingNode, 'href'), encoding.href, sourceName, `${path}.href`, aggregateOutputIds, errors);
  }
}

/**
 * @param {unknown} encodingNode
 * @param {Record<string, unknown>} encoding
 * @param {string | null} sourceName
 * @param {string} path
 * @param {Map<string, string>} aggregateOutputIds
 * @param {ValidationError[]} errors
 * @param {'list'|'table'} viewKind
 */
function validateTableEncoding(encodingNode, encoding, sourceName, path, aggregateOutputIds, errors, viewKind) {
  if (!Array.isArray(encoding.columns) || encoding.columns.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      `${viewKind} views must encode a non-empty columns sequence.`,
      `${path}.columns`
    ));
  } else {
    const columnsNode = getValueNodeByKey(encodingNode, 'columns');
    for (const [index, column] of encoding.columns.entries()) {
      validateFieldDefinition(
        getSequenceItemNode(columnsNode, index),
        column,
        sourceName,
        `${path}.columns[${index}]`,
        aggregateOutputIds,
        errors
      );
    }
  }

  for (const forbiddenChannel of ['value', 'x', 'y', 'color']) {
    if (encoding[forbiddenChannel] !== undefined) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `${viewKind} views must not encode ${forbiddenChannel}.`,
        `${path}.${forbiddenChannel}`
      ));
    }
  }

  if (encoding.href !== undefined) {
    validateHrefFieldDefinition(getValueNodeByKey(encodingNode, 'href'), encoding.href, sourceName, `${path}.href`, aggregateOutputIds, errors);
  }
}

/**
 * @param {unknown} encodingNode
 * @param {Record<string, unknown>} encoding
 * @param {unknown} chart
 * @param {string | null} sourceName
 * @param {string} path
 * @param {Map<string, string>} aggregateOutputIds
 * @param {ValidationError[]} errors
 */
function validateChartEncoding(encodingNode, encoding, chart, sourceName, path, aggregateOutputIds, errors) {
  validateRequiredFieldDefinition(getValueNodeByKey(encodingNode, 'x'), encoding.x, sourceName, `${path}.x`, aggregateOutputIds, errors);
  const yNode = getValueNodeByKey(encodingNode, 'y');
  const yDefinitions = Array.isArray(encoding.y) ? encoding.y : [encoding.y];
  for (const [index, definition] of yDefinitions.entries()) {
    const definitionPath = Array.isArray(encoding.y) ? `${path}.y[${index}]` : `${path}.y`;
    validateRequiredFieldDefinition(
      Array.isArray(encoding.y) ? getSequenceItemNode(yNode, index) : yNode,
      definition,
      sourceName,
      definitionPath,
      aggregateOutputIds,
      errors
    );
  }

  if (isPlainObject(encoding.x) && encoding.x.type !== undefined && !['nominal', 'ordinal', 'temporal'].includes(String(encoding.x.type))) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'chart x encoding must use a nominal, ordinal, or temporal type when explicitly typed.',
      `${path}.x.type`
    ));
  }

  if (isPlainObject(encoding.x) && encoding.x['time-unit'] !== undefined) {
    const xFieldName = typeof encoding.x.field === 'string' ? encoding.x.field : null;
    const xType = typeof encoding.x.type === 'string' ? encoding.x.type : null;
    if (xType !== 'temporal' && (!xFieldName || !TEMPORAL_FIELD_NAMES.includes(xFieldName))) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'chart x time-unit requires a temporal field.',
        `${path}.x.time-unit`
      ));
    }
  }

  if (encoding.value !== undefined) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'chart views must not encode value.',
      `${path}.value`
    ));
  }

  if (encoding.columns !== undefined) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'chart views must not encode columns.',
      `${path}.columns`
    ));
  }

  if (encoding.color !== undefined) {
    validateFieldDefinition(getValueNodeByKey(encodingNode, 'color'), encoding.color, sourceName, `${path}.color`, aggregateOutputIds, errors);
  }

  if (encoding.weight !== undefined) {
    validateFieldDefinition(getValueNodeByKey(encodingNode, 'weight'), encoding.weight, sourceName, `${path}.weight`, aggregateOutputIds, errors);
    if (chart !== 'swimlane') {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'weight encoding is supported only by swimlane charts.',
        `${path}.weight`
      ));
    }
    if (isPlainObject(encoding.weight) && encoding.weight.type !== undefined && encoding.weight.type !== 'quantitative') {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'swimlane weight encoding must be quantitative when explicitly typed.',
        `${path}.weight.type`
      ));
    }
  }

  if (encoding.reference !== undefined) {
    validateFieldDefinition(getValueNodeByKey(encodingNode, 'reference'), encoding.reference, sourceName, `${path}.reference`, aggregateOutputIds, errors);
    if (isPlainObject(encoding.reference) && encoding.reference.type !== undefined && encoding.reference.type !== 'quantitative') {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'chart reference encoding must be quantitative when explicitly typed.',
        `${path}.reference.type`
      ));
    }
    if (isPlainObject(encoding.reference) && encoding.reference.aggregate !== undefined) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'chart reference encoding must not declare an aggregate.',
        `${path}.reference.aggregate`
      ));
    }
  }

  if (encoding.href !== undefined) {
    validateHrefFieldDefinition(getValueNodeByKey(encodingNode, 'href'), encoding.href, sourceName, `${path}.href`, aggregateOutputIds, errors);
  }

  if (isPlainObject(encoding.x) && encoding.x.aggregate !== undefined) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'chart x encoding must not declare an aggregate.',
      `${path}.x.aggregate`
    ));
  }

  for (const [index, definition] of yDefinitions.entries()) {
    if (
      isPlainObject(definition)
      && definition.type !== undefined
      && (['heatmap', 'swimlane'].includes(String(chart))
        ? !['nominal', 'ordinal'].includes(String(definition.type))
        : definition.type !== 'quantitative')
    ) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        ['heatmap', 'swimlane'].includes(String(chart))
          ? `${chart} chart y encoding must be nominal or ordinal when explicitly typed.`
          : 'chart y encoding must be quantitative when explicitly typed.',
        Array.isArray(encoding.y) ? `${path}.y[${index}].type` : `${path}.y.type`
      ));
    }
  }

  const xType = isPlainObject(encoding.x) && typeof encoding.x.type === 'string' ? encoding.x.type : null;
  const xFieldName = isPlainObject(encoding.x) && typeof encoding.x.field === 'string' ? encoding.x.field : null;
  const xIsTemporal = xType === 'temporal' || (xType === null && xFieldName !== null && TEMPORAL_FIELD_NAMES.includes(xFieldName));
  const xHasTimeUnit = isPlainObject(encoding.x) && encoding.x['time-unit'] !== undefined;
  const expectedDefault = xIsTemporal ? 'line' : 'bar';

  if (
    expectedDefault === 'line'
    && !['dot', 'scatter', 'swimlane'].includes(String(chart))
    && !xHasTimeUnit
    && !Array.isArray(encoding.y)
  ) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'chart views with temporal x must declare a temporal bucket to realize the line time-series default conservatively.',
      `${path}.x`
    ));
  }
}

/**
 * @param {unknown} fieldNode
 * @param {unknown} fieldDefinition
 * @param {string | null} sourceName
 * @param {string} path
 * @param {Map<string, string>} aggregateOutputIds
 * @param {ValidationError[]} errors
 */
function validateRequiredFieldDefinition(fieldNode, fieldDefinition, sourceName, path, aggregateOutputIds, errors) {
  if (fieldDefinition === undefined) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      `${path.split('.').at(-1)} is required.`,
      path
    ));
    return;
  }

  validateFieldDefinition(fieldNode, fieldDefinition, sourceName, path, aggregateOutputIds, errors);
}

/**
 * @param {unknown} fieldNode
 * @param {unknown} fieldDefinition
 * @param {string | null} sourceName
 * @param {string} path
 * @param {Map<string, string>} aggregateOutputIds
 * @param {ValidationError[]} errors
 */
function validateFieldDefinition(fieldNode, fieldDefinition, sourceName, path, aggregateOutputIds, errors) {
  if (!isPlainObject(fieldDefinition)) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'field definitions must be mappings.',
      path
    ));
    return;
  }

  validateObjectKeys(fieldNode, FIELD_DEFINITION_KEYS, path, errors);
  validateStringField(fieldDefinition.field, `${path}.field`, true, errors);
  validateOptionalStringField(fieldDefinition.title, `${path}.title`, errors);
  if (fieldDefinition.unit !== undefined) {
    validateStringField(fieldDefinition.unit, `${path}.unit`, true, errors);
  }
  if (fieldDefinition.filter !== undefined && typeof fieldDefinition.filter !== 'boolean') {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'filter must be a boolean.',
      `${path}.filter`
    ));
  }

  const aggregate = fieldDefinition.aggregate ?? 'none';
  if (fieldDefinition.aggregate !== undefined) {
    validateStringField(fieldDefinition.aggregate, `${path}.aggregate`, true, errors);
    if (typeof fieldDefinition.aggregate === 'string' && !AGGREGATE_VALUES.includes(fieldDefinition.aggregate)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'aggregate must use one canonical aggregate value.',
        `${path}.aggregate`
      ));
    }
  }

  if (fieldDefinition.type !== undefined) {
    validateStringField(fieldDefinition.type, `${path}.type`, true, errors);
    if (typeof fieldDefinition.type === 'string' && !FIELD_TYPE_VALUES.includes(fieldDefinition.type)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'type must use one canonical field type.',
        `${path}.type`
      ));
    }
  }

  if (fieldDefinition.display !== undefined) {
    validateStringField(fieldDefinition.display, `${path}.display`, true, errors);
    if (typeof fieldDefinition.display === 'string' && !FIELD_DISPLAY_VALUES.includes(fieldDefinition.display)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'display must use one canonical field display value.',
        `${path}.display`
      ));
    }
  }

  if (fieldDefinition.format !== undefined) {
    validateStringField(fieldDefinition.format, `${path}.format`, true, errors);
    const format = typeof fieldDefinition.format === 'string' ? fieldDefinition.format : null;
    if (format !== null && !FIELD_FORMAT_VALUES.includes(format)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'format must use one canonical field format value.',
        `${path}.format`
      ));
    }
    const fieldName = typeof fieldDefinition.field === 'string' ? fieldDefinition.field : null;
    const intrinsicallyNominalOrOrdinal = fieldName !== null
      && !LINK_FIELD_NAMES.includes(fieldName)
      && !TEMPORAL_FIELD_NAMES.includes(fieldName)
      && !ADDITIVE_MEASURE_FIELDS.includes(fieldName)
      && !NON_ADDITIVE_MEASURE_FIELDS.includes(fieldName)
      && aggregate === 'none';
    const intrinsicallyTemporal = fieldName !== null
      && TEMPORAL_FIELD_NAMES.includes(fieldName)
      && aggregate === 'none';
    if (
      format !== null
      && FIELD_FORMAT_VALUES.includes(format)
      && (
        (
          format === 'human-friendly-timestamp'
          && (
            (typeof fieldDefinition.type === 'string' && fieldDefinition.type !== 'temporal')
            || (fieldDefinition.type === undefined && !intrinsicallyTemporal)
          )
        )
        || (
          format !== 'human-friendly-timestamp'
          && (
            (typeof fieldDefinition.type === 'string' && !['nominal', 'ordinal'].includes(fieldDefinition.type))
            || (fieldDefinition.type === undefined && !intrinsicallyNominalOrOrdinal)
          )
        )
      )
    ) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        format === 'human-friendly-timestamp'
          ? 'human-friendly-timestamp format requires a temporal field.'
          : `${format} format requires a nominal or ordinal field.`,
        `${path}.format`
      ));
    }
    if (['workflow-run-url', 'shortened-url'].includes(format ?? '') && !path.includes('.columns[')) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        `${format} format may be used only on table columns.`,
        `${path}.format`
      ));
    }
  }

  if (fieldDefinition['time-unit'] !== undefined) {
    validateStringField(fieldDefinition['time-unit'], `${path}.time-unit`, true, errors);
    if (typeof fieldDefinition['time-unit'] === 'string' && !TIME_UNIT_VALUES.includes(fieldDefinition['time-unit'])) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'time-unit must use one canonical time unit.',
        `${path}.time-unit`
      ));
    }
  }

  if (fieldDefinition.as !== undefined) {
    validateStringField(fieldDefinition.as, `${path}.as`, true, errors);
    if (aggregate === 'none') {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'field definitions with aggregate none must not include as.',
        `${path}.as`
      ));
    }
  }

  if (fieldDefinition['time-unit'] !== undefined) {
    const fieldName = typeof fieldDefinition.field === 'string' ? fieldDefinition.field : null;
    if (!fieldName || !TEMPORAL_FIELD_NAMES.includes(fieldName)) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'time-unit may be used only with a temporal field.',
        `${path}.time-unit`
      ));
    }
  }

  const fieldName = typeof fieldDefinition.field === 'string' ? fieldDefinition.field : null;
  if (fieldName && sourceName) {
    const sourceFields = sourceFieldNames(sourceName);
    if (sourceFields && !sourceFields.includes(fieldName)) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'field must exist in the selected source.',
        `${path}.field`
      ));
    }
  }

  if (fieldName && typeof aggregate === 'string' && AGGREGATE_VALUES.includes(aggregate)) {
    validateAggregateCompatibility(fieldName, aggregate, path, errors);
    if (aggregate !== 'none') {
      const outputId = typeof fieldDefinition.as === 'string' ? fieldDefinition.as : `${aggregate}-${fieldName}`;
      const existingPath = aggregateOutputIds.get(outputId);
      if (existingPath) {
        errors.push(createError(
          ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
          'aggregate output identifiers must be unique within a view.',
          path
        ));
      } else {
        aggregateOutputIds.set(outputId, path);
      }
    }
  }
}

/**
 * @param {unknown} fieldNode
 * @param {unknown} fieldDefinition
 * @param {string | null} sourceName
 * @param {string} path
 * @param {Map<string, string>} aggregateOutputIds
 * @param {ValidationError[]} errors
 */
function validateHrefFieldDefinition(fieldNode, fieldDefinition, sourceName, path, aggregateOutputIds, errors) {
  validateFieldDefinition(fieldNode, fieldDefinition, sourceName, path, aggregateOutputIds, errors);

  if (!isPlainObject(fieldDefinition)) {
    return;
  }

  const fieldName = typeof fieldDefinition.field === 'string' ? fieldDefinition.field : null;
  if (!fieldName) {
    return;
  }

  if (!LINK_FIELD_NAMES.includes(fieldName)) {
    errors.push(createError(
      ERROR_CODES.invalidLinkReference,
      'href.field must reference exactly one relation-specific link field.',
      `${path}.field`
    ));
  }
}

/**
 * @param {string} fieldName
 * @param {string} aggregate
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateAggregateCompatibility(fieldName, aggregate, path, errors) {
  if (aggregate === 'sum' && !ADDITIVE_MEASURE_FIELDS.includes(fieldName)) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'sum is allowed only for raw-token measures and aic.',
      `${path}.aggregate`
    ));
  }

  if (NON_ADDITIVE_MEASURE_FIELDS.includes(fieldName) && !['none', 'mean', 'min', 'max'].includes(aggregate)) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'value and operational-value support only none, mean, min, or max.',
      `${path}.aggregate`
    ));
  }
}

/**
 * @param {unknown} data
 * @param {unknown} encoding
 * @param {Map<string, string>} aggregateOutputIds
 * @param {string | null} sourceName
 * @param {string} viewPath
 * @param {ValidationError[]} errors
 */
function validateOrderByReferences(data, encoding, aggregateOutputIds, sourceName, viewPath, errors) {
  if (!isPlainObject(data) || !Array.isArray(data['order-by']) || !sourceName) {
    return;
  }

  const declaredFields = sourceFieldNames(sourceName);
  if (!declaredFields) {
    return;
  }
  const sourceFieldSet = new Set(declaredFields);
  const entityIdSet = new Set(SOURCE_ENTITY_IDENTIFIER_FIELDS[/** @type {keyof typeof SOURCE_ENTITY_IDENTIFIER_FIELDS} */ (sourceName)] ?? []);
  const unaggregatedOutputFields = new Set();
  if (isPlainObject(encoding)) {
    const definitions = [
      encoding.x,
      ...(Array.isArray(encoding.y) ? encoding.y : [encoding.y]),
      encoding.color,
      ...(Array.isArray(encoding.columns) ? encoding.columns : []),
    ];
    for (const definition of definitions) {
      if (
        isPlainObject(definition)
        && typeof definition.field === 'string'
        && (definition.aggregate === undefined || definition.aggregate === 'none')
      ) {
        unaggregatedOutputFields.add(definition.field);
      }
    }
  }

  for (const [index, clause] of data['order-by'].entries()) {
    if (!isPlainObject(clause) || typeof clause.field !== 'string') {
      continue;
    }

    const fieldPath = `${viewPath}.data.order-by[${index}].field`;
    const fieldName = clause.field;
    const matchesAggregateOutput = aggregateOutputIds.has(fieldName);
    const matchesSourceField = sourceFieldSet.has(fieldName);

    if (matchesAggregateOutput && matchesSourceField) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'order-by.field must resolve to exactly one output field at the post-aggregation grain.',
        fieldPath
      ));
      continue;
    }

    if (matchesAggregateOutput) {
      continue;
    }

    if (!matchesSourceField || (!unaggregatedOutputFields.has(fieldName) && !entityIdSet.has(fieldName))) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        'order-by.field must reference one unique aggregate output identifier or one source field valid at the output grain.',
        fieldPath
      ));
    }
  }
}

/**
 * @param {unknown} value
 * @param {string[]} allowedValues
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateEnumeratedFilterValue(value, allowedValues, path, errors) {
  if (typeof value === 'string') {
    if (!allowedValues.includes(value)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        `Value at ${path} must use one of the canonical values: ${allowedValues.join(', ')}.`,
        path
      ));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (typeof item !== 'string' || !allowedValues.includes(item)) {
        errors.push(createError(
          ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
          `Value at ${path}[${index}] must use one of the canonical values: ${allowedValues.join(', ')}.`,
          `${path}[${index}]`
        ));
      }
    }
  }
}

/**
 * @param {unknown} value
 * @param {string[]} allowedValues
 * @param {string} path
 * @param {string} label
 * @param {ValidationError[]} errors
 */
function validateEnumeratedMetadataValue(value, allowedValues, path, label, errors) {
  if (typeof value !== 'string') {
    return;
  }

  if (!allowedValues.includes(value)) {
    errors.push(createError(
      ERROR_CODES.missingRequiredProvenanceOrDataStateMetadata,
      `${label} must use one of the canonical values: ${allowedValues.join(', ')}.`,
      path
    ));
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string} fieldLabel
 * @param {ValidationError[]} errors
 * @param {{ relation?: string, code?: string }} [options]
 */
function validateLinkObject(value, path, fieldLabel, errors, options = {}) {
  const code = options.code ?? ERROR_CODES.invalidLinkReference;
  if (!isPlainObject(value)) {
    errors.push(createError(
      code,
      `${fieldLabel} must be a Section 9.1 link object.`,
      path
    ));
    return;
  }

  validateObjectKeys(value, LINK_OBJECT_KEYS, path, errors);
  validateStringField(value.relation, `${path}.relation`, true, errors);
  validateStringField(value.href, `${path}.href`, true, errors);
  validateStringField(value.label, `${path}.label`, true, errors);

  if (typeof value.relation === 'string' && !LINK_RELATION_VALUES.includes(value.relation)) {
    errors.push(createError(
      code,
      'link relation must use one canonical Section 9.1 relation value.',
      `${path}.relation`
    ));
  }

  if (options.relation && typeof value.relation === 'string' && value.relation != options.relation) {
    errors.push(createError(
      code,
      `${fieldLabel} relation must be exactly "${options.relation}".`,
      `${path}.relation`
    ));
  }

  if (typeof value.href === 'string' && !isSafeHttpsUrl(value.href)) {
    errors.push(createError(
      code,
      'link href must be an absolute HTTPS URL without embedded credentials.',
      `${path}.href`
    ));
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isSafeHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isSafeGithubUrlBase(value) {
  if (!isSafeHttpsUrl(value)) {
    return false;
  }

  const url = new URL(/** @type {string} */ (value));
  return url.search === '' && url.hash === '';
}

const REPOSITORY_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isSafeRepositorySlug(value) {
  if (typeof value !== 'string' || looksSensitive(value)) {
    return false;
  }

  const segments = value.split('/');
  if (segments.length !== 2) {
    return false;
  }

  const [owner, name] = segments;
  return (
    REPOSITORY_OWNER_PATTERN.test(owner) &&
    REPOSITORY_NAME_PATTERN.test(name) &&
    !name.includes('..')
  );
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function rejectSensitiveStringsInObject(value, path, errors) {
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate !== 'string') {
      continue;
    }
    if (!looksSensitive(candidate)) {
      continue;
    }
    errors.push(createError(
      ERROR_CODES.missingRequiredProvenanceOrDataStateMetadata,
      `${key} must not contain authentication credentials, secret tokens, or private keys.`,
      `${path}.${key}`
    ));
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksSensitive(value) {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return false;
  }

  return normalized.includes('-----BEGIN')
    || /^gh[pousr]_[A-Za-z0-9_]+$/i.test(normalized)
    || /^github_pat_[A-Za-z0-9_]+$/i.test(normalized)
    || /^sk-[A-Za-z0-9]+$/i.test(normalized)
    || /^AKIA[A-Z0-9]{16}$/.test(normalized)
    || /^AIza[0-9A-Za-z\-_]{20,}$/.test(normalized)
    || /^xox[baprs]-[A-Za-z0-9-]+$/.test(normalized);
}

/** @type {Record<string, string[]>} */
const SEMANTIC_FILTER_VALUE_SETS = {
  'rollout-mode': ROLLOUT_MODE_VALUES,
  'detection-state': DETECTION_STATE_VALUES,
  'workflow-active': WORKFLOW_ACTIVE_VALUES,
  'workflow-role': WORKFLOW_ROLE_VALUES,
  'run-status': RUN_STATUS_VALUES,
  'run-conclusion': RUN_CONCLUSION_VALUES,
  status: [...GRADER_STATUS_VALUES, ...DISPATCH_STATUS_VALUES],
  'eval-result': EVAL_RESULT_VALUES,
  'outcome-state': OUTCOME_STATE_VALUES,
  'finding-status': FINDING_STATUS_VALUES,
  'finding-severity': FINDING_SEVERITY_VALUES
};

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string} label
 * @param {ValidationError[]} errors
 */
function validateRequiredIdentifier(value, path, label, errors) {
  validateStringField(value, path, true, errors);
  if (typeof value === 'string' && !IDENTIFIER_PATTERN.test(value)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      `${label} must match ^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$.`,
      path
    ));
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {boolean} required
 * @param {ValidationError[]} errors
 */
function validateStringField(value, path, required, errors) {
  if (value === undefined) {
    if (required) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        `${path.split('.').at(-1)} is required and must be a non-empty string.`,
        path
      ));
    }
    return;
  }

  if (typeof value !== 'string' || value.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      `${path.split('.').at(-1)} must be a non-empty string.`,
      path
    ));
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateOptionalStringField(value, path, errors) {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'string') {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      `${path.split('.').at(-1)} must be a string.`,
      path
    ));
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {string} message
 * @param {ValidationError[]} errors
 */
function validateNonEmptyStringSequence(value, path, message, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      message,
      path
    ));
    return;
  }

  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.length === 0) {
      errors.push(createError(
        ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
        message,
        `${path}[${index}]`
      ));
    }
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isRfc3339Timestamp(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339Pattern.test(value)) {
    return false;
  }

  return !Number.isNaN(Date.parse(value));
}

/**
 * @param {unknown} node
 * @param {string[]} allowedKeys
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateObjectKeys(node, allowedKeys, path, errors) {
  const items = getMappingItems(node);
  if (!items) {
    return;
  }

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const item of items) {
    const key = getPairKey(item);
    if (typeof key !== 'string') {
      continue;
    }

    const keyPath = `${path}.${key}`;
    if (seen.has(key)) {
      errors.push(createError(
        ERROR_CODES.unknownOrDuplicateKey,
        `Duplicate key "${key}" is not allowed.`,
        keyPath
      ));
      continue;
    }
    seen.set(key, 1);

    if (!allowedKeys.includes(key)) {
      errors.push(createError(
        ERROR_CODES.unknownOrDuplicateKey,
        `Unknown key "${key}" is not allowed at ${path}.`,
        keyPath
      ));
    }
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {string} path
 * @returns {ValidationError}
 */
function createError(code, message, path) {
  return { code, message, path };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isAggregateFilterLiteral(value) {
  return ['string', 'number', 'boolean'].includes(typeof value)
    && (typeof value !== 'number' || Number.isFinite(value));
}

/**
 * @param {unknown} node
 * @returns {unknown[] | null}
 */
function getMappingItems(node) {
  if (!node || typeof node !== 'object' || !('items' in node)) {
    return null;
  }

  const items = /** @type {{ items?: unknown[] }} */ (node).items;
  return Array.isArray(items) ? items : null;
}

/**
 * @param {unknown} pair
 * @returns {string | undefined}
 */
function getPairKey(pair) {
  if (!pair || typeof pair !== 'object' || !('key' in pair)) {
    return undefined;
  }

  const keyNode = /** @type {{ key?: { value?: unknown } }} */ (pair).key;
  return typeof keyNode?.value === 'string' ? keyNode.value : undefined;
}

/**
 * @param {unknown} mappingNode
 * @param {string} key
 * @returns {unknown}
 */
function getValueNodeByKey(mappingNode, key) {
  const items = getMappingItems(mappingNode);
  if (!items) {
    return undefined;
  }

  for (const item of items) {
    if (getPairKey(item) === key) {
      return /** @type {{ value?: unknown }} */ (item).value;
    }
  }

  return undefined;
}

/**
 * @param {unknown} sequenceNode
 * @param {number} index
 * @returns {unknown}
 */
function getSequenceItemNode(sequenceNode, index) {
  if (!sequenceNode || typeof sequenceNode !== 'object' || !('items' in sequenceNode)) {
    return undefined;
  }

  const items = /** @type {{ items?: unknown[] }} */ (sequenceNode).items;
  return Array.isArray(items) ? items[index] : undefined;
}
