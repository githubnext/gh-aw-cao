import { parseAllDocuments } from 'yaml';
import {
  ADDITIVE_MEASURE_FIELDS,
  AGGREGATE_VALUES,
  BUILT_IN_PAGE_KEYS,
  BUILT_IN_PAGE_VALUES,
  CUSTOM_PAGE_KEYS,
  DASHBOARD_KEYS,
  DASHBOARD_HORIZON_KEYS,
  DATASET_AVAILABILITY_VALUES,
  DATASET_COMPLETENESS_VALUES,
  DATASET_FRESHNESS_VALUES,
  DATASET_METADATA_KEYS,
  DISPATCH_STATUS_VALUES,
  BUILT_IN_PAGE_DATA_STATE_KEYS,
  BUILT_IN_PAGE_DEFINITION_KEYS,
  DEFAULTS_KEYS,
  CALLOUT_KEYS,
  ERROR_CODES,
  LINK_FIELD_NAMES,
  LINK_OBJECT_KEYS,
  LINK_RELATION_VALUES,
  EVAL_RESULT_VALUES,
  FIELD_DEFINITION_KEYS,
  FIELD_DISPLAY_VALUES,
  FIELD_TYPE_VALUES,
  FILTER_DIMENSION_VALUES,
  DETECTION_STATE_VALUES,
  FINDING_SEVERITY_VALUES,
  FINDING_STATUS_VALUES,
  GRADER_STATUS_VALUES,
  IDENTIFIER_PATTERN,
  LANGUAGE_VERSION,
  MAX_ESSENTIAL_VIEWS_PER_PAGE,
  NAVIGATION_SECTION_KEYS,
  NON_ADDITIVE_MEASURE_FIELDS,
  ORDER_BY_KEYS,
  ORDER_DIRECTION_VALUES,
  OUTCOME_STATE_VALUES,
  PAGE_ROUTE_KEYS,
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
  SOURCE_FIELDS,
  SOURCE_VALUES,
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
  VIEW_CHART_VALUES,
  VIEW_CONTROL_VALUES,
  VIEW_DISCLOSURE_VALUES,
  VIEW_ENCODING_KEYS,
  VIEW_ELEMENT_CONFIG_KEYS,
  VIEW_ELEMENT_VALUES,
  VIEW_KEYS,
  VIEW_LAYOUT_VALUES,
  VIEW_MARK_VALUES,
  VIEW_TITLE_LINK_KEYS,
  WORKFLOW_ACTIVE_VALUES,
  WORKFLOW_ROLE_VALUES
} from './specification.js';
import {
  OUTCOME_DETAIL_SECTION_BODY_VALUES,
  EXPERIMENTS_VIEW_BODY_VALUES,
  PACKAGE_ROUTE_BODY_VALUES,
  WORKFLOW_ROUTE_BODY_VALUES
} from './components/route-body-specification.js';

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

  validateDashboard(dashboard, getValueNodeByKey(document.contents, 'dashboard'), errors);

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
  const packageRows = new Map();
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

    const packageId = candidate.package;
    const hasPackage = typeof packageId === 'string' && packageId.length > 0;
    if ((role === 'orchestrator' || role === 'worker') && !hasPackage) {
      errors.push(createError(
        ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
        'An orchestrator or worker workflow must identify its package.',
        `${path}.package`
      ));
    }
    if (role === 'standalone' && packageId != null) {
      errors.push(createError(
        ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
        'A standalone workflow must not identify a package.',
        `${path}.package`
      ));
    }

    const packageIcon = candidate['package-icon'];
    if (packageIcon !== undefined && (typeof packageIcon !== 'string' || !PAGE_ICON_VALUES.includes(packageIcon))) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'package-icon must name a canonical Octicon.',
        `${path}.package-icon`
      ));
    }

    validateNonNegativeSourceMeasure(candidate['max-ai-credits'], `${path}.max-ai-credits`, errors);
    validateNonNegativeSourceMeasure(candidate['package-aic-allowance'], `${path}.package-aic-allowance`, errors);

    if (hasPackage && (role === 'orchestrator' || role === 'worker')) {
      const key = sourceEntityKey(candidate, 'package');
      const rows = packageRows.get(key) ?? [];
      rows.push({ row: candidate, index });
      packageRows.set(key, rows);
    }
  }

  for (const rows of packageRows.values()) {
    const workflowAllowances = new Map(rows
      .filter(({ row }) => typeof row.workflow === 'string' && isNonNegativeFiniteNumber(row['max-ai-credits']))
      .map(({ row }) => [sourceEntityKey(row, 'workflow'), /** @type {number} */ (row['max-ai-credits'])]));
    const expectedAllowance = [...workflowAllowances.values()].reduce((total, value) => total + value, 0);
    for (const { row, index } of rows) {
      const allowance = row['package-aic-allowance'];
      if (isNonNegativeFiniteNumber(allowance) && !numbersEqual(allowance, expectedAllowance)) {
        errors.push(createError(
          ERROR_CODES.invalidEntityRelationshipOrSourceGrain,
          'package-aic-allowance must equal the sum of available per-run workflow limits.',
          `$.sources.workflows.rows[${index}].package-aic-allowance`
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

  /** @type {Set<string>} */
  const pageIds = new Set();
  dashboard.pages.forEach((page, index) => {
    validatePage(page, getSequenceItemNode(getValueNodeByKey(dashboardNode, 'pages'), index), `$.dashboard.pages[${index}]`, pageIds, errors);
  });
  dashboard.pages.forEach((page, index) => {
    if (!isPlainObject(page) || !isPlainObject(page.route) || typeof page.route['navigation-page'] !== 'string') return;
    const navigationPage = page.route['navigation-page'];
    if (!IDENTIFIER_PATTERN.test(navigationPage)) return;
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
  });
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
    validateStringField(visibility.source, `${path}.source`, true, errors);
    if (typeof visibility.source === 'string' && !SOURCE_VALUES.includes(visibility.source)) {
      errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'visible-when source must use one canonical source name.', `${path}.source`));
    }
    validateStringField(visibility.field, `${path}.field`, true, errors);
    if (
      typeof visibility.source === 'string'
      && SOURCE_VALUES.includes(visibility.source)
      && typeof visibility.field === 'string'
      && !SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (visibility.source)]?.includes(visibility.field)
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
    validateStringField(section.label, `${sectionPath}.label`, true, errors);

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

  const expectedTitle = defaultBuiltInPageTitle(page.page);
  if (page.title !== undefined && page.title !== expectedTitle) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      `built-in page title must match the canonical title default "${expectedTitle}".`,
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
        if (typeof sourceName !== 'string' || !SOURCE_VALUES.includes(sourceName)) {
          errors.push(createError(
            ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
            'source must use one canonical Section 5.1 source name.',
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
        sourceFieldCoverage.set(sourceName, new Set(getBuiltInRequiredFields(pageName, sourceName)));
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

    if (!sourceFieldCoverage.has(data.source)) {
      sourceFieldCoverage.set(data.source, new Set());
    }

    collectBuiltInDefinitionFieldCoverage(view.encoding, sourceFieldCoverage.get(data.source));
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
    if (section['count-source'] !== undefined || section['count-label'] !== undefined) {
      validateSource(section['count-source'], `${sectionPath}.count-source`, errors);
      validateStringField(section['count-label'], `${sectionPath}.count-label`, true, errors);
    }
    if (typeof section.layout !== 'string' || !PAGE_SECTION_LAYOUT_VALUES.includes(section.layout)) {
      errors.push(createError(
        ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
        'layout section must use one canonical full, wide, or narrow layout value.',
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
      'built-in page definition must expose independent availability, completeness, and freshness state.',
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
        `built-in page definition must expose independent ${key} state with canonical boolean true.`,
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

  validateObjectKeys(viewNode, VIEW_KEYS, path, errors);
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

  if (view.table !== undefined) {
    if (typeof view.table !== 'boolean') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'table must be a boolean.',
        `${path}.table`
      ));
    } else if (view.mark !== 'chart') {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'table is allowed only when mark is "chart".',
        `${path}.table`
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
        ? SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (treeSource)]
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

  if (view['empty-message'] !== undefined && !['chart', 'table'].includes(String(view.mark))) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'empty-message is allowed only when mark is "chart" or "table".',
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
      if ((view.element === 'workflow-route' || view.element === 'package-route' || view.element === 'outcome-detail-section' || view.element === 'experiments-evaluation') && view.config.body !== undefined) {
        validateStringField(view.config.body, `${path}.config.body`, true, errors);
       const allowedBodies = view.element === 'workflow-route'
         ? WORKFLOW_ROUTE_BODY_VALUES
         : view.element === 'package-route'
           ? PACKAGE_ROUTE_BODY_VALUES
           : view.element === 'experiments-evaluation'
             ? EXPERIMENTS_VIEW_BODY_VALUES
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
         'config.body is supported only for the workflow-route, package-route, outcome-detail-section, and experiments-evaluation elements.',
         `${path}.config.body`
       ));
      }
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
    } else {
      validateSource(view.data.source, `${path}.data.source`, errors);
      if (typeof view.data.source === 'string' && SOURCE_VALUES.includes(view.data.source)) {
        sourceName = view.data.source;
      }
      if (view.data.sources !== undefined) {
        errors.push(createError(
          ERROR_CODES.missingOrInvalidRequiredField,
          'metric, table, and chart views must use data.source instead of data.sources.',
          `${path}.data.sources`
        ));
      }
      if (view.data['route-field'] !== undefined) {
        validateStringField(view.data['route-field'], `${path}.data.route-field`, true, errors);
        if (
          sourceName
          && typeof view.data['route-field'] === 'string'
          && !SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (sourceName)]?.includes(view.data['route-field'])
        ) {
          errors.push(createError(
            ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
            'route-field must name a field declared by data.source.',
            `${path}.data.route-field`
          ));
        }
      }
    }
    validateContext(dataNode, view.data, `${path}.data`, errors);
  }

  validateSemanticFieldLiterals(view.data, `${path}.data`, errors);
  validateDatasetMetadata(getValueNodeByKey(viewNode, 'data'), view.data, `${path}.data`, errors);
  if (
    view.chart === 'heatmap'
    && (!isPlainObject(view.data) || !Number.isInteger(view.data.limit) || Number(view.data.limit) > 100)
  ) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      'heatmap charts must declare data.limit no greater than 100.',
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
 * @param {unknown} encoding
 * @param {unknown} encodingNode
 * @param {unknown} mark
 * @param {string | null} sourceName
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateTableActions(encoding, encodingNode, mark, sourceName, path, errors) {
  if (!isPlainObject(encoding) || encoding.actions === undefined) return;
  if (mark !== 'table') {
    errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'actions is allowed only when mark is "table".', path));
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
    validateStringField(action.intent, `${actionPath}.intent`, true, errors);
    validateStringField(action.presentation, `${actionPath}.presentation`, true, errors);
    if (typeof action.presentation === 'string' && !TABLE_ACTION_PRESENTATION_VALUES.includes(action.presentation)) {
      errors.push(createError(ERROR_CODES.nonCanonicalVocabularyOrIdentifier, 'action presentation must be copy-prompt.', `${actionPath}.presentation`));
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
        if (sourceName && !SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (sourceName)]?.includes(field)) {
          errors.push(createError(ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference, 'action context field must be declared by data.source.', fieldPath));
        }
      });
    }
    if (action.when === undefined) return;
    if (!isPlainObject(action.when)) {
      errors.push(createError(ERROR_CODES.missingOrInvalidRequiredField, 'action when must be a mapping.', `${actionPath}.when`));
      return;
    }
    validateObjectKeys(getValueNodeByKey(actionNode, 'when'), TABLE_ACTION_WHEN_KEYS, `${actionPath}.when`, errors);
    validateStringField(action.when.field, `${actionPath}.when.field`, true, errors);
    if (typeof action.when.field === 'string' && sourceName && !SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (sourceName)]?.includes(action.when.field)) {
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
    && SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (sourceName)]?.includes(hrefField)
    && SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (sourceName)]?.includes(identifierField)
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
 * @param {unknown} source
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateSource(source, path, errors) {
  validateStringField(source, path, true, errors);
  if (typeof source === 'string' && !SOURCE_VALUES.includes(source)) {
    errors.push(createError(
      ERROR_CODES.nonCanonicalVocabularyOrIdentifier,
      'source must use one canonical Section 5.1 source name.',
      path
    ));
  }
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
      'sources must be a non-empty sequence of canonical source names.',
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
  const displayForbiddenChannels = markValue === 'table'
    ? ['href']
    : ['value', 'x', 'y', 'color', 'reference', 'href'];
  for (const channel of displayForbiddenChannels) {
    if (isPlainObject(encoding[channel]) && encoding[channel].display !== undefined) {
      errors.push(createError(
        ERROR_CODES.missingOrInvalidRequiredField,
        'display is allowed only on table column field definitions.',
        `${viewPath}.encoding.${channel}.display`
      ));
    }
  }

  if (markValue === 'metric') {
    validateMetricEncoding(encodingNode, encoding, sourceName, `${viewPath}.encoding`, aggregateOutputIds, errors);
  } else if (markValue === 'table') {
    validateTableEncoding(encodingNode, encoding, sourceName, `${viewPath}.encoding`, aggregateOutputIds, errors);
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
  if (['dot', 'line', 'scatter'].includes(String(chart)) && isPlainObject(encoding.x) && encoding.x.type !== undefined && encoding.x.type !== 'temporal') {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      `${chart} chart x encoding must be temporal when explicitly typed.`,
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
 */
function validateTableEncoding(encodingNode, encoding, sourceName, path, aggregateOutputIds, errors) {
  if (!Array.isArray(encoding.columns) || encoding.columns.length === 0) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      'table views must encode a non-empty columns sequence.',
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
        `table views must not encode ${forbiddenChannel}.`,
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
  validateRequiredFieldDefinition(getValueNodeByKey(encodingNode, 'y'), encoding.y, sourceName, `${path}.y`, aggregateOutputIds, errors);

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

  if (
    isPlainObject(encoding.y)
    && encoding.y.type !== undefined
    && (['heatmap', 'swimlane'].includes(String(chart))
      ? !['nominal', 'ordinal'].includes(String(encoding.y.type))
      : encoding.y.type !== 'quantitative')
  ) {
    errors.push(createError(
      ERROR_CODES.invalidScopeFilterTimeAggregationOrOrderReference,
      ['heatmap', 'swimlane'].includes(String(chart))
        ? `${chart} chart y encoding must be nominal or ordinal when explicitly typed.`
        : 'chart y encoding must be quantitative when explicitly typed.',
      `${path}.y.type`
    ));
  }

  const xType = isPlainObject(encoding.x) && typeof encoding.x.type === 'string' ? encoding.x.type : null;
  const xFieldName = isPlainObject(encoding.x) && typeof encoding.x.field === 'string' ? encoding.x.field : null;
  const xIsTemporal = xType === 'temporal' || (xType === null && xFieldName !== null && TEMPORAL_FIELD_NAMES.includes(xFieldName));
  const xHasTimeUnit = isPlainObject(encoding.x) && encoding.x['time-unit'] !== undefined;
  const expectedDefault = xIsTemporal ? 'line' : 'bar';

  if (expectedDefault === 'line' && !['dot', 'scatter', 'swimlane'].includes(String(chart)) && !xHasTimeUnit) {
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
    const sourceFields = SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (sourceName)];
    if (!sourceFields.includes(fieldName)) {
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

  const sourceFieldSet = new Set(SOURCE_FIELDS[/** @type {keyof typeof SOURCE_FIELDS} */ (sourceName)]);
  const entityIdSet = new Set(SOURCE_ENTITY_IDENTIFIER_FIELDS[/** @type {keyof typeof SOURCE_ENTITY_IDENTIFIER_FIELDS} */ (sourceName)] ?? []);
  const unaggregatedOutputFields = new Set();
  if (isPlainObject(encoding)) {
    const definitions = [
      encoding.x,
      encoding.y,
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
 * @param {string} pageName
 * @returns {string}
 */
function defaultBuiltInPageTitle(pageName) {
  if (pageName === 'experiments') return 'Experiments & Evaluation';
  return pageName
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
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
