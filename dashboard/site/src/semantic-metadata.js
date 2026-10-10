/** @type {readonly ('subject' | 'objective' | 'acceptance')[]} */
export const SEMANTIC_METADATA_FIELDS = Object.freeze(['subject', 'objective', 'acceptance']);
export const MAX_SEMANTIC_METADATA_CHARACTERS = 512;

/** @param {{ subject?: unknown, objective?: unknown, acceptance?: unknown }} definition */
export function semanticMetadataLength(definition) {
  return SEMANTIC_METADATA_FIELDS.reduce((total, field) => {
    const value = definition[field];
    return total + (typeof value === 'string' ? [...value].length : 0);
  }, 0);
}
