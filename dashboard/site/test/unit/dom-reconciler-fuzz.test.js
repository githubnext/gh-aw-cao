// @vitest-environment jsdom
import { it } from 'vitest';
import { reconcileChildren } from '../../src/dom-reconciler.js';

const CASE_COUNT = 10_000;
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ELEMENT_NAMES = ['div', 'span', 'button', 'label', 'p'];
const SVG_NAMES = ['g', 'circle', 'text'];

it('reconciles many shallow ill-shaped trees', () => {
  for (let seed = 1; seed <= CASE_COUNT; seed += 1) {
    const random = createRandom(seed);
    const currentLayout = createChildren(random, 0);
    const desiredLayout = createChildren(random, 0);
    const current = document.createElement('main');
    const desired = document.createDocumentFragment();

    current.append(...materialize(currentLayout));
    desired.append(...materialize(desiredLayout));
    const expected = JSON.stringify(snapshot(desired.childNodes));

    try {
      reconcileChildren(current, desired);
      if (JSON.stringify(snapshot(current.childNodes)) !== expected) {
        throw new Error('The reconciled tree does not match the desired tree.');
      }
    } catch (error) {
      throw new Error(
        `DOM reconciliation failed for this reconstructable layout:\n${JSON.stringify({
          seed,
          current: currentLayout,
          desired: desiredLayout
        }, null, 2)}`,
        { cause: error }
      );
    }
  }
}, 10_000);

/**
 * @param {number} seed
 * @returns {(limit: number) => number}
 */
function createRandom(seed) {
  let state = seed;
  /** @param {number} limit */
  return (limit) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
}

/**
 * @param {(limit: number) => number} random
 * @param {number} depth
 * @returns {Layout[]}
 */
function createChildren(random, depth) {
  const count = random(depth === 0 ? 9 : 6);
  return Array.from({ length: count }, () => createNode(random, depth));
}

/**
 * @param {(limit: number) => number} random
 * @param {number} depth
 * @returns {Layout}
 */
function createNode(random, depth) {
  const kind = depth < 2 ? random(5) : random(2);
  if (kind === 0) return { type: 'text', value: `text-${random(8)}` };
  if (kind === 1) return { type: 'comment', value: `comment-${random(5)}` };

  const svg = random(5) === 0;
  const names = svg ? SVG_NAMES : ELEMENT_NAMES;
  /** @type {Record<string, string>} */
  const attributes = {};
  if (random(3) === 0) attributes['data-key'] = `key-${random(7)}`;
  if (random(5) === 0) attributes.id = `id-${random(7)}`;
  if (random(2) === 0) attributes.title = `title-${random(6)}`;
  if (random(3) === 0) attributes.class = `class-${random(4)}`;

  return {
    type: 'element',
    namespace: svg ? SVG_NAMESPACE : HTML_NAMESPACE,
    name: names[random(names.length)],
    attributes,
    children: createChildren(random, depth + 1)
  };
}

/**
 * @param {Layout[]} layouts
 * @returns {Node[]}
 */
function materialize(layouts) {
  return layouts.map((layout) => {
    if (layout.type === 'text') return document.createTextNode(layout.value);
    if (layout.type === 'comment') return document.createComment(layout.value);

    const element = document.createElementNS(layout.namespace, layout.name);
    for (const [name, value] of Object.entries(layout.attributes)) {
      element.setAttribute(name, value);
    }
    element.append(...materialize(layout.children));
    return element;
  });
}

/**
 * @param {NodeListOf<ChildNode>} nodes
 * @returns {unknown[]}
 */
function snapshot(nodes) {
  return [...nodes].map((node) => {
    if (node.nodeType === Node.TEXT_NODE) return { type: 'text', value: node.nodeValue };
    if (node.nodeType === Node.COMMENT_NODE) return { type: 'comment', value: node.nodeValue };
    const element = /** @type {Element} */ (node);
    return {
      type: 'element',
      namespace: element.namespaceURI,
      name: element.localName,
      attributes: [...element.attributes]
        .map((attribute) => [attribute.name, attribute.value])
        .sort(([left], [right]) => left.localeCompare(right)),
      children: snapshot(element.childNodes)
    };
  });
}

/**
 * @typedef {{ type: 'text', value: string } | { type: 'comment', value: string } | {
 *   type: 'element',
 *   namespace: string,
 *   name: string,
 *   attributes: Record<string, string>,
 *   children: Layout[]
 * }} Layout
 */
