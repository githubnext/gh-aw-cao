import { syncDomProperties } from './dom.js';

/**
 * @typedef {{ nodes: Node[], index: number }} NodeQueue
 */

/**
 * Reconciles a rendered shadow tree into an owned DOM subtree. The algorithm
 * uses the indexed-node and live-cursor approach established by DOM morphers:
 * keyed and compatible unkeyed nodes are consumed in order, then moved into
 * place while only changed attributes, character data, or positions are mutated.
 *
 * @param {Node} currentParent
 * @param {Node} desiredParent
 */
export function reconcileChildren(currentParent, desiredParent) {
  /** @type {Map<string, NodeQueue>} */
  const keyedChildren = new Map();
  /** @type {Map<string, NodeQueue>} */
  const unkeyedChildren = new Map();

  for (const child of currentParent.childNodes) {
    const key = nodeKey(child);
    addToQueue(key === null ? unkeyedChildren : keyedChildren, key ?? nodeTypeKey(child), child);
  }

  let cursor = currentParent.firstChild;
  let desired = desiredParent.firstChild;
  while (desired) {
    const nextDesired = desired.nextSibling;
    const key = nodeKey(desired);
    const current = takeFromQueue(
      key === null ? unkeyedChildren : keyedChildren,
      key ?? nodeTypeKey(desired)
    );

    if (current) {
      const nextCursor = current === cursor ? current.nextSibling : cursor;
      if (current !== cursor) currentParent.insertBefore(current, cursor);
      reconcileNode(current, desired);
      cursor = nextCursor;
    } else {
      currentParent.insertBefore(desired, cursor);
    }

    desired = nextDesired;
  }

  while (cursor) {
    const next = cursor.nextSibling;
    currentParent.removeChild(cursor);
    cursor = next;
  }
}

/**
 * @param {Map<string, NodeQueue>} queues
 * @param {string} key
 * @param {Node} node
 */
function addToQueue(queues, key, node) {
  const queue = queues.get(key);
  if (queue) {
    queue.nodes.push(node);
  } else {
    queues.set(key, { nodes: [node], index: 0 });
  }
}

/**
 * @param {Map<string, NodeQueue>} queues
 * @param {string} key
 * @returns {Node | null}
 */
function takeFromQueue(queues, key) {
  const queue = queues.get(key);
  if (!queue || queue.index >= queue.nodes.length) return null;
  return queue.nodes[queue.index++];
}

/**
 * @param {Node} current
 * @param {Node} desired
 */
function reconcileNode(current, desired) {
  if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
    return;
  }
  if (!(current instanceof Element) || !(desired instanceof Element)) return;

  reconcileAttributes(current, desired);
  syncDomProperties(current, desired);
  reconcileChildren(current, desired);
}

/**
 * @param {Element} current
 * @param {Element} desired
 */
function reconcileAttributes(current, desired) {
  for (let index = current.attributes.length - 1; index >= 0; index -= 1) {
    const attribute = current.attributes[index];
    if (!desired.hasAttributeNS(attribute.namespaceURI, attribute.localName)) {
      current.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    }
  }
  for (let index = 0; index < desired.attributes.length; index += 1) {
    const attribute = desired.attributes[index];
    if (current.getAttributeNS(attribute.namespaceURI, attribute.localName) === attribute.value) continue;
    if (attribute.namespaceURI) {
      current.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    } else {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
}

/**
 * @param {Node} node
 * @returns {string}
 */
function nodeTypeKey(node) {
  return node instanceof Element
    ? `${node.nodeType}:${node.namespaceURI}:${node.localName}`
    : String(node.nodeType);
}

/**
 * Uses the same stable identities recognized by established DOM morphers.
 * @param {Node} node
 * @returns {string | null}
 */
function nodeKey(node) {
  if (!(node instanceof Element)) return null;
  const explicitKey = node.getAttribute('data-key');
  const stableId = node.id && !node.id.startsWith('cao-field-') ? node.id : null;
  const key = explicitKey || stableId;
  return key ? `${node.namespaceURI}:${node.localName}:${key}` : null;
}
