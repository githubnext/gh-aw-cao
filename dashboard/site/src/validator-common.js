import { DISPATCH_STATUS_VALUES, ERROR_CODES, LINK_OBJECT_KEYS, LINK_RELATION_VALUES, EVAL_RESULT_VALUES, DETECTION_STATE_VALUES, FINDING_SEVERITY_VALUES, FINDING_STATUS_VALUES, GRADER_STATUS_VALUES, IDENTIFIER_PATTERN, OUTCOME_STATE_VALUES, ROLLOUT_MODE_VALUES, RUN_CONCLUSION_VALUES, RUN_STATUS_VALUES, WORKFLOW_ACTIVE_VALUES, WORKFLOW_ROLE_VALUES } from './specification.js';
import { createDebug } from './debug.js';
import { MAX_SEMANTIC_METADATA_CHARACTERS, SEMANTIC_METADATA_FIELDS, semanticMetadataLength } from './semantic-metadata.js';

const debugValidatorCommon = createDebug('validator-common');

/** @typedef {import('./validator.js').ValidationError} ValidationError */


/**
 * @param {unknown} value
 * @param {string[]} allowedValues
 * @param {string} path
 * @param {ValidationError[]} errors
 */
export function validateEnumeratedFilterValue(value, allowedValues, path, errors) {
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
export function validateEnumeratedMetadataValue(value, allowedValues, path, label, errors) {
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
export function validateLinkObject(value, path, fieldLabel, errors, options = {}) {
  const code = options.code ?? ERROR_CODES.invalidLinkReference;
  const errorCountBeforeValidation = errors.length;
  if (!isPlainObject(value)) {
    errors.push(createError(
      code,
      `${fieldLabel} must be a Section 9.1 link object.`,
      path
    ));
  } else {
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

  debugValidatorCommon({ operation: 'validate-link-object', status: errors.length === errorCountBeforeValidation ? 'ok' : 'invalid' });
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
export function isSafeGithubUrlBase(value) {
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
export function isSafeRepositorySlug(value) {
  const segments = typeof value === 'string' && !looksSensitive(value) ? value.split('/') : [];
  const [owner, name] = segments;
  const safe = segments.length === 2
    && REPOSITORY_OWNER_PATTERN.test(owner)
    && REPOSITORY_NAME_PATTERN.test(name)
    && !name.includes('..');
  debugValidatorCommon({ operation: 'validate-repository-slug', status: safe ? 'accepted' : 'rejected' });
  return safe;
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} path
 * @param {ValidationError[]} errors
 */
export function rejectSensitiveStringsInObject(value, path, errors) {
  let rejectedCount = 0;
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate !== 'string') {
      continue;
    }
    if (!looksSensitive(candidate)) {
      continue;
    }
    rejectedCount += 1;
    errors.push(createError(
      ERROR_CODES.missingRequiredProvenanceOrDataStateMetadata,
      `${key} must not contain authentication credentials, secret tokens, or private keys.`,
      `${path}.${key}`
    ));
  }
  debugValidatorCommon({ operation: 'reject-sensitive-strings', status: rejectedCount > 0 ? 'rejected' : 'ok', rejectedCount });
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
export const SEMANTIC_FILTER_VALUE_SETS = {
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
export function validateRequiredIdentifier(value, path, label, errors) {
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
export function validateStringField(value, path, required, errors) {
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
 * @param {Record<string, unknown>} definition
 * @param {string} path
 * @param {ValidationError[]} errors
 */
export function validateSemanticMetadataLength(definition, path, errors) {
  if (SEMANTIC_METADATA_FIELDS.some((field) => definition[field] !== undefined && typeof definition[field] !== 'string')) return;
  const length = semanticMetadataLength(definition);
  if (length > MAX_SEMANTIC_METADATA_CHARACTERS) {
    errors.push(createError(
      ERROR_CODES.missingOrInvalidRequiredField,
      `Combined subject, objective, and acceptance must be at most ${MAX_SEMANTIC_METADATA_CHARACTERS} characters (found ${length}); shorten them or offload details to a separate Markdown file in the repository.`,
      path
    ));
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {ValidationError[]} errors
 */
export function validateOptionalStringField(value, path, errors) {
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
export function validateNonEmptyStringSequence(value, path, message, errors) {
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
export function isRfc3339Timestamp(value) {
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
export function validateObjectKeys(node, allowedKeys, path, errors) {
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
export function createError(code, message, path) {
  return { code, message, path };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
export function isAggregateFilterLiteral(value) {
  return ['string', 'number', 'boolean'].includes(typeof value)
    && (typeof value !== 'number' || Number.isFinite(value));
}

/**
 * @param {unknown} node
 * @returns {unknown[] | null}
 */
export function getMappingItems(node) {
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
export function getValueNodeByKey(mappingNode, key) {
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
export function getSequenceItemNode(sequenceNode, index) {
  if (!sequenceNode || typeof sequenceNode !== 'object' || !('items' in sequenceNode)) {
    return undefined;
  }

  const items = /** @type {{ items?: unknown[] }} */ (sequenceNode).items;
  return Array.isArray(items) ? items[index] : undefined;
}
