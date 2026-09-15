import { syncDomProperties } from './dom.js';

/**
 * Reconciles a rendered shadow tree into an owned DOM subtree. The algorithm
 * follows the in-place tree-morphing approach used by established DOM morphers:
 * keyed nodes are matched first, compatible unkeyed nodes are reused in order,
 * and only changed attributes, character data, or child positions are mutated.
 *
 * @param {Node} currentParent
 * @param {Node} desiredParent
 */
export function reconcileChildren(currentParent, desiredParent) {
  const desiredChildren = [...desiredParent.childNodes];
  const keyedChildren = new Map();
  const retained = new Set();

  for (const child of currentParent.childNodes) {
    const key = nodeKey(child);
    if (key !== null && !keyedChildren.has(key)) keyedChildren.set(key, child);
  }

  let cursor = currentParent.firstChild;
  for (const desired of desiredChildren) {
    const key = nodeKey(desired);
    let current = key === null ? null : keyedChildren.get(key) ?? null;
    if (current && (!compatibleNodes(current, desired) || retained.has(current))) current = null;

    if (!current && key === null) {
      current = findCompatibleUnkeyedNode(cursor, desired, retained);
    }

    if (current) {
      if (current !== cursor) currentParent.insertBefore(current, cursor);
      reconcileNode(current, desired);
      retained.add(current);
      cursor = current.nextSibling;
      continue;
    }

    currentParent.insertBefore(desired, cursor);
    retained.add(desired);
    cursor = desired.nextSibling;
  }

  for (const child of [...currentParent.childNodes]) {
    if (!retained.has(child)) currentParent.removeChild(child);
  }
}

/**
 * @param {Node | null} start
 * @param {Node} desired
 * @param {Set<Node>} retained
 * @returns {Node | null}
 */
function findCompatibleUnkeyedNode(start, desired, retained) {
  let candidate = start;
  while (candidate) {
    if (!retained.has(candidate) && nodeKey(candidate) === null && compatibleNodes(candidate, desired)) {
      return candidate;
    }
    candidate = candidate.nextSibling;
  }
  return null;
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
  for (const attribute of [...current.attributes]) {
    if (!desired.hasAttributeNS(attribute.namespaceURI, attribute.localName)) {
      current.removeAttributeNS(attribute.namespaceURI, attribute.localName);
    }
  }
  for (const attribute of [...desired.attributes]) {
    if (current.getAttributeNS(attribute.namespaceURI, attribute.localName) === attribute.value) continue;
    if (attribute.namespaceURI) {
      current.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
    } else {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
}

/**
 * @param {Node} current
 * @param {Node} desired
 */
function compatibleNodes(current, desired) {
  return current.nodeType === desired.nodeType
    && (!(current instanceof Element)
      || (desired instanceof Element
        && current.localName === desired.localName
        && current.namespaceURI === desired.namespaceURI));
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
