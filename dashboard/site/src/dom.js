/**
 * @typedef {{ __keyedList: true, items: Array<unknown>, renderItem: (item: unknown, index: number) => Node, key: (item: unknown, index: number) => string, render: () => void, _attach: (parent: Node) => void }} KeyedListDescriptor
 */

/**
 * @param {Array<unknown>} items
 * @param {(item: unknown, index: number) => Node} renderItem
 * @param {(item: unknown, index: number) => string} key
 * @returns {KeyedListDescriptor}
 */
export function keyed(items, renderItem, key) {
  /** @type {Comment | null} */
  let start = null
  /** @type {Comment | null} */
  let end = null
  /** @type {Node | null} */
  let parent = null
  /** @type {Map<string, Node>} */
  const nodeByKey = new Map()

  /** @type {KeyedListDescriptor} */
  const descriptor = {
    __keyedList: true,
    items,
    renderItem,
    key,
    render() {
      if (!start || !end || !parent) {
        return
      }

      const nextKeys = new Set()
      /** @type {Node[]} */
      const nextNodes = []

      descriptor.items.forEach((item, index) => {
        const itemKey = descriptor.key(item, index)
        nextKeys.add(itemKey)
        let node = nodeByKey.get(itemKey)
        if (!node) {
          node = descriptor.renderItem(item, index)
          nodeByKey.set(itemKey, node)
        }
        nextNodes.push(node)
      })

      for (const [itemKey, node] of [...nodeByKey.entries()]) {
        if (!nextKeys.has(itemKey)) {
          if (node.parentNode) {
            node.parentNode.removeChild(node)
          }
          nodeByKey.delete(itemKey)
        }
      }

      let anchor = start.nextSibling
      for (const node of nextNodes) {
        if (node !== anchor) {
          parent.insertBefore(node, anchor ?? end)
        } else {
          anchor = anchor?.nextSibling ?? end
        }
        anchor = node.nextSibling
      }
    },
    _attach(nextParent) {
      parent = nextParent
      start = document.createComment('keyed-start')
      end = document.createComment('keyed-end')
      appendNode(parent, start)
      appendNode(parent, end)
      descriptor.render()
    },
  }

  return descriptor
}

const SVG_TAGS = new Set([
  'svg',
  'path',
  'symbol',
  'use',
  'g',
  'defs',
  'line',
  'circle',
  'rect',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
])

const FORM_CONTROL_TAGS = new Set(['input', 'select', 'textarea'])
let generatedFormControlId = 0

/**
 * @param {string} name
 * @param {Record<string, unknown> | null | undefined} [props]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function h(name, props, ...children) {
  const element = SVG_TAGS.has(name)
    ? /** @type {HTMLElement} */ (
        /** @type {unknown} */ (
          document.createElementNS('http://www.w3.org/2000/svg', name)
        )
      )
    : document.createElement(name)
  applyProps(element, props ?? {})
  if (
    FORM_CONTROL_TAGS.has(name) &&
    !element.hasAttribute('id') &&
    !element.hasAttribute('name')
  ) {
    element.id = `cao-field-${++generatedFormControlId}`
  }
  appendChildren(element, flattenChildren(children))
  return element
}

/**
 * @param {Element} element
 * @param {Record<string, unknown>} props
 */
function applyProps(element, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value == null) {
      continue
    }
    if (key === 'className') {
      element.setAttribute('class', String(value))
      continue
    }
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(
        key.slice(2).toLowerCase(),
        /** @type {EventListener} */ (value),
      )
      continue
    }
    if (key === 'dataset' && typeof value === 'object' && value !== null) {
      for (const [dataKey, dataValue] of Object.entries(
        /** @type {Record<string, unknown>} */ (value),
      )) {
        element.setAttribute(`data-${toKebabCase(dataKey)}`, String(dataValue))
      }
      continue
    }
    if (key in element) {
      try {
        // @ts-expect-error dynamic DOM property assignment
        element[key] = value
        continue
      } catch {
        // fall through to attribute
      }
    }
    element.setAttribute(key, String(value))
  }
}

/**
 * @param {Node} parent
 * @param {unknown[]} children
 */
function appendChildren(parent, children) {
  for (const child of children) {
    if (child == null || child === false) {
      continue
    }
    if (isKeyedListDescriptor(child)) {
      child._attach(parent)
      continue
    }
    appendNode(parent, normalizeChild(child))
  }
}

/**
 * @param {Node} parent
 * @param {Node | string} child
 */
function appendNode(parent, child) {
  parent.appendChild(
    typeof child === 'string' ? document.createTextNode(child) : child,
  )
}

/**
 * @param {unknown} child
 * @returns {child is KeyedListDescriptor}
 */
function isKeyedListDescriptor(child) {
  return typeof child === 'object' && child !== null && '__keyedList' in child
}

/**
 * @param {unknown} child
 * @returns {Node | string}
 */
function normalizeChild(child) {
  if (child instanceof Node) {
    return child
  }
  return String(child)
}

/**
 * @param {unknown[]} children
 * @returns {unknown[]}
 */
function flattenChildren(children) {
  return children.flatMap((child) =>
    Array.isArray(child) ? flattenChildren(child) : [child],
  )
}

/**
 * @param {string} value
 * @returns {string}
 */
function toKebabCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}
