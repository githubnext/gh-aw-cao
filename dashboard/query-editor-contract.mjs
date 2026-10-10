// @ts-check

import { MAX_SEMANTIC_METADATA_CHARACTERS, semanticMetadataLength } from "./site/src/semantic-metadata.js";

export const maximumQueryEditorRequestBytes = 160 * 1024;
export const maximumQueryEditorDocumentCharacters = 131072;
export const queryEditorFieldLimits = Object.freeze({ intent: 8000, subject: 2000, objective: 4000, acceptance: 4000 });

/**
 * @typedef {{ intent: string, subject: string, objective?: string, acceptance: string, document?: string, feedback?: string }} QueryEditorIntent
 */

/** @param {unknown} value @returns {asserts value is QueryEditorIntent} */
export function assertQueryEditorIntent(value) {
  if (!isMapping(value)) {
    throw new Error("Query designer intent must be a mapping.");
  }
  const limits = {
    ...queryEditorFieldLimits,
    document: maximumQueryEditorDocumentCharacters, feedback: 8000,
  };
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(limits, key)) throw new Error(`Unknown query designer field: ${key}.`);
  }
  for (const [key, limit] of Object.entries(limits)) {
    const field = value[key];
    if (["intent", "subject", "acceptance"].includes(key) && (typeof field !== "string" || !field.trim())) {
      throw new Error(`Query designer ${key} is required.`);
    }
    if (field !== undefined && (typeof field !== "string" || field.length > limit)) {
      throw new Error(`Query designer ${key} must be text of at most ${limit} characters.`);
    }
  }
  assertSemanticMetadataLimit(value);
}

/**
 * @typedef {Partial<Record<keyof typeof queryEditorFieldLimits, string>>} QueryEditorEnhancement
 * @typedef {Record<keyof typeof queryEditorFieldLimits, string>} QueryEditorAuthoring
 */

/** @param {unknown} value @returns {asserts value is QueryEditorEnhancement} */
export function assertQueryEditorEnhancement(value) {
  if (!isMapping(value)) {
    throw new Error("Authoring improvement must be a mapping.");
  }
  for (const [key, text] of Object.entries(value)) {
    if (!isAuthoringField(key) || typeof text !== "string" || text.length > queryEditorFieldLimits[key]) {
      throw new Error("Invalid query designer enhancement context.");
    }
  }

  if (!Object.values(value).some((text) => typeof text === "string" && text.trim())) {
    throw new Error("Enter some authoring intent before improving all fields.");
  }
}

/** @param {unknown} value @returns {asserts value is QueryEditorAuthoring} */
export function assertQueryEditorAuthoring(value) {
  assertQueryEditorEnhancement(value);
  if (Object.keys(value).length !== 4 || Object.values(value).some((text) => typeof text !== "string" || !text.trim())) {
    throw new Error("Copilot must improve all four authoring fields together.");
  }
  assertSemanticMetadataLimit(value);
}

/** @param {{ subject?: unknown, objective?: unknown, acceptance?: unknown }} value */
function assertSemanticMetadataLimit(value) {
  const length = semanticMetadataLength(value);
  if (length > MAX_SEMANTIC_METADATA_CHARACTERS) {
    throw new Error(`Combined subject, objective, and acceptance must be at most ${MAX_SEMANTIC_METADATA_CHARACTERS} characters (found ${length}). Shorten them or move details into intent.`);
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} key @returns {key is keyof typeof queryEditorFieldLimits} */
function isAuthoringField(key) {
  return Object.hasOwn(queryEditorFieldLimits, key);
}
