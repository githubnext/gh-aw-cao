/**
 * Debug-only DOM provenance mapping. Annotates every rendered dashboard
 * element with the Dashboard Language JSON path (and, where applicable, the
 * JavaScript view name) that produced it, so Playwright-based analysis can
 * trace excessive node creation back to its declarative source.
 *
 * This module is lazy-loaded only when `?debug=1` is present in the page
 * URL; it must never be imported eagerly from the presenter so that regular
 * dashboard loads pay no cost for provenance bookkeeping.
 */

/**
 * Maps every rendered element to the most specific dashboard JSON node that
 * owns it. Only the initial render performs the full structural walk;
 * subsequent DOM mutations (lazy pages, interactive re-renders) are handled
 * incrementally so the observer never re-annotates the whole dashboard.
 * @param {HTMLElement} root
 * @param {import('./presenter.js').PresentationDocument} document
 * @param {(page: import('./presenter.js').PresentableBuiltInPage) => import('./presenter.js').PresentableCustomPage} getBuiltInPagePayload
 */
export function enableDashboardDomProvenance(root, document, getBuiltInPagePayload) {
  annotateDashboardDom(root, document, getBuiltInPagePayload)
  const pagesById = new Map(document.dashboard.pages.map((page, pageIndex) => [page.id, { page, pageIndex }]))
  const observer = new MutationObserver((mutations) => {
    const pagesToAnnotate = new Set()
    const provenanceRoots = []
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        const element = /** @type {Element} */ (node)
        if (!queueAffectedPageDom(element, pagesToAnnotate)) {
          provenanceRoots.push(element)
        }
      }
    }
    for (const renderedPage of pagesToAnnotate) {
      annotateRenderedPageDom(renderedPage, pagesById, getBuiltInPagePayload)
    }
    for (const node of provenanceRoots) {
      if (!isInsideElementSet(node, pagesToAnnotate)) {
        propagateDashboardDomProvenance(node)
      }
    }
  })
  observer.observe(root, { childList: true, subtree: true })
}

/**
 * @param {Element} element
 * @param {Set<Element>} pagesToAnnotate
 * @returns {boolean}
 */
function queueAffectedPageDom(element, pagesToAnnotate) {
  if (!hasProvenanceBoundary(element)) return false
  const page = element.closest('[data-page-id]')
  if (page) {
    pagesToAnnotate.add(page)
    return true
  }
  const pages = [...element.querySelectorAll('[data-page-id]')]
  for (const renderedPage of pages) {
    if (hasProvenanceBoundary(renderedPage)) pagesToAnnotate.add(renderedPage)
  }
  return pages.length > 0
}

/**
 * @param {Element} element
 * @returns {boolean}
 */
function hasProvenanceBoundary(element) {
  return (
    element.matches('[data-view-id], [data-section-id], [data-page-id]') || element.querySelector('[data-view-id], [data-section-id], [data-page-id]') !== null
  )
}

/**
 * @param {Element} renderedPage
 * @param {Map<string, { page: import('./presenter.js').PresentableBuiltInPage | import('./presenter.js').PresentableCustomPage, pageIndex: number }>} pagesById
 * @param {(page: import('./presenter.js').PresentableBuiltInPage) => import('./presenter.js').PresentableCustomPage} getBuiltInPagePayload
 */
function annotateRenderedPageDom(renderedPage, pagesById, getBuiltInPagePayload) {
  const pageId = renderedPage.getAttribute('data-page-id')
  if (!pageId) return
  const entry = pagesById.get(pageId)
  if (!entry) return
  annotatePageDom(renderedPage, entry.page, entry.pageIndex, getBuiltInPagePayload)
}

/**
 * @param {Element} element
 * @param {Set<Element>} elements
 * @returns {boolean}
 */
function isInsideElementSet(element, elements) {
  for (const candidate of elements) {
    if (candidate.contains(element)) return true
  }
  return false
}

/**
 * Propagates already-known JSON provenance onto a newly inserted element
 * subtree without re-walking the whole dashboard. Subtrees that already
 * carry `data-json-path` (for example, pages rendered and annotated ahead of
 * lazy activation) are left untouched, since they were already annotated
 * precisely before insertion.
 * @param {Element} node
 */
function propagateDashboardDomProvenance(node) {
  if (node.hasAttribute('data-json-path')) return
  const owner = node.parentElement?.closest('[data-json-path]')
  if (!owner) return
  annotateDomTree(node, /** @type {string} */ (owner.getAttribute('data-json-path')), owner.getAttribute('data-js-view') ?? undefined)
}

/**
 * @param {HTMLElement} root
 * @param {import('./presenter.js').PresentationDocument} document
 * @param {(page: import('./presenter.js').PresentableBuiltInPage) => import('./presenter.js').PresentableCustomPage} getBuiltInPagePayload
 */
function annotateDashboardDom(root, document, getBuiltInPagePayload) {
  annotateDomTree(root, '$.dashboard')

  const callouts = Array.isArray(document.dashboard.callouts) ? document.dashboard.callouts : []
  for (const element of root.querySelectorAll('[data-site-callout]')) {
    const index = callouts.findIndex((callout) => callout.id === element.getAttribute('data-site-callout'))
    if (index >= 0) annotateDomTree(element, `$.dashboard.callouts[${index}]`)
  }

  const navLinks = [...root.querySelectorAll('[data-nav-page-id], [data-mobile-nav-page-id]')]
  const pageElements = [...root.querySelectorAll('[data-page-id]')]
  document.dashboard.pages.forEach((page, pageIndex) => {
    const pagePath = `$.dashboard.pages[${pageIndex}]`
    for (const element of navLinks) {
      if (element.getAttribute('data-nav-page-id') === page.id || element.getAttribute('data-mobile-nav-page-id') === page.id) {
        annotateDomTree(element, pagePath)
      }
    }

    const renderedPage = pageElements.find((element) => element.getAttribute('data-page-id') === page.id)
    if (!renderedPage) return
    annotatePageDom(renderedPage, page, pageIndex, getBuiltInPagePayload)
  })
}

/**
 * @param {Element} renderedPage
 * @param {import('./presenter.js').PresentableBuiltInPage | import('./presenter.js').PresentableCustomPage} page
 * @param {number} pageIndex
 * @param {(page: import('./presenter.js').PresentableBuiltInPage) => import('./presenter.js').PresentableCustomPage} getBuiltInPagePayload
 */
export function annotatePageDom(renderedPage, page, pageIndex, getBuiltInPagePayload) {
  const pagePath = `$.dashboard.pages[${pageIndex}]`
  annotateDomTree(renderedPage, pagePath)

  const payload = page.kind === 'built-in' ? getBuiltInPagePayload(page) : page
  const definitionPath = page.kind === 'built-in' ? `${pagePath}.definition` : pagePath
  const sections = Array.isArray(payload.sections) ? payload.sections : []
  const sectionElements = [...renderedPage.querySelectorAll('[data-section-id]')]
  sections.forEach((section, sectionIndex) => {
    for (const element of sectionElements) {
      if (element.getAttribute('data-section-id') === section.id) {
        annotateDomTree(element, `${definitionPath}.sections[${sectionIndex}]`)
      }
    }
  })

  const views = Array.isArray(payload.views) ? payload.views : []
  const viewElements = [...renderedPage.querySelectorAll('[data-view-id]')]
  views.forEach((view, viewIndex) => {
    if (!isPlainObject(view)) return
    const viewId = typeof view.id === 'string' ? view.id : `view-${viewIndex + 1}`
    for (const element of viewElements) {
      if (element.getAttribute('data-view-id') !== viewId) continue
      const viewRoot = element.closest('.custom-view') ?? element
      annotateDomTree(viewRoot, `${definitionPath}.views[${viewIndex}]`, typeof view.element === 'string' ? view.element : undefined)
    }
  })
}

/**
 * @param {Element} root
 * @param {string} jsonPath
 * @param {string} [javascriptView]
 */
function annotateDomTree(root, jsonPath, javascriptView) {
  for (const element of [root, ...root.querySelectorAll('*')]) {
    element.setAttribute('data-json-path', jsonPath)
    if (javascriptView) {
      element.setAttribute('data-js-view', javascriptView)
    } else {
      element.removeAttribute('data-js-view')
    }
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
