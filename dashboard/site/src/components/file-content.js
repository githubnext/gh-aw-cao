import { h } from '../dom.js';

/** @param {string} content */
export function renderFileContent(content) {
  return h('pre', null, h('code', null, content));
}
