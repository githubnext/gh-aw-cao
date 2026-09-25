import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { findLink } from './link-content.js';
import { rowsFor as rowsForSource } from './source-rows.js';
import { renderEmptyMessage } from './ui-primitives.js';

/** @type {Record<string, { label: string, icon: string }>} */
const GFM_ALERTS = {
  note: { label: 'Note', icon: 'info' },
  tip: { label: 'Tip', icon: 'light-bulb' },
  important: { label: 'Important', icon: 'report' },
  warning: { label: 'Warning', icon: 'alert' },
  caution: { label: 'Caution', icon: 'stop' }
};

/**
 * Renders Markdown retained in the first declared source without attaching the
 * presentation to a domain-specific page or entity.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderMarkdownElement(context) {
  const config = context.elementConfig ?? {};
  const contentField = value(config['content-field']);
  const pathField = value(config['path-field']);
  const baseLinkField = value(config['base-link-field']);
  const rows = rowsForSource(context.sources, context.sourceNames[0] ?? '');
  const source = rows.find((row) => value(row[contentField])) ?? rows[0];
  const markdown = source ? value(source[contentField]) : '';
  if (!markdown) {
    return renderEmptyMessage(value(config['empty-message']) || 'Markdown content is unavailable.');
  }
  return h(
    'article',
    { className: 'dashboard-markdown markdown-body', 'aria-label': context.title },
    ...renderMarkdownBlocks(markdown, source, { pathField, baseLinkField })
  );
}

/**
 * @param {string} markdown
 * @param {Record<string, unknown>} source
 * @param {{ pathField: string, baseLinkField: string }} links
 */
function renderMarkdownBlocks(markdown, source, links) {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  /** @type {HTMLElement[]} */
  const nodes = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*```([^\s`]*)\s*$/);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index += 1;
      nodes.push(h('pre', null, h('code', { className: fence[1] ? `language-${fence[1]}` : '' }, body.join('\n'))));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      nodes.push(h(`h${heading[1].length}`, null, ...renderInline(heading[2], source, links)));
      index += 1;
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      nodes.push(h('hr'));
      index += 1;
      continue;
    }
    if (isTableHeader(lines, index)) {
      const headers = tableCells(lines[index]);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
      nodes.push(h('table', null,
        h('thead', null, h('tr', null, ...headers.map((cell) => h('th', { scope: 'col' }, ...renderInline(cell, source, links))))),
        h('tbody', null, ...rows.map((row) => h('tr', null, ...row.map((cell) => h('td', null, ...renderInline(cell, source, links))))))));
      continue;
    }
    const list = line.match(/^\s*(?:[-*+] |\d+\. )/);
    if (list) {
      const ordered = /^\s*\d+\. /.test(line);
      const items = [];
      const pattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const item = lines[index].match(pattern);
        if (!item) break;
        items.push(h('li', null, ...renderInline(item[1], source, links)));
        index += 1;
      }
      nodes.push(h(ordered ? 'ol' : 'ul', null, ...items));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      const alertType = quote[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i)?.[1].toLowerCase();
      const alert = alertType ? GFM_ALERTS[alertType] : undefined;
      nodes.push(alert
        ? h(
            'blockquote',
            { className: `markdown-alert markdown-alert-${alertType}` },
            h('p', { className: 'markdown-alert-title' }, octicon(alert.icon), alert.label),
            ...renderMarkdownBlocks(quote.slice(1).join('\n'), source, links)
          )
        : h('blockquote', null, h('p', null, ...renderInline(quote.join(' '), source, links))));
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++].trim());
    nodes.push(h('p', null, ...renderInline(paragraph.join(' '), source, links)));
  }
  return nodes;
}

/**
 * @param {string} text
 * @param {Record<string, unknown>} source
 * @param {{ pathField: string, baseLinkField: string }} links
 */
function renderInline(text, source, links) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((part) => {
    if (part.startsWith('`') && part.endsWith('`')) return h('code', null, part.slice(1, -1));
    if (part.startsWith('**') && part.endsWith('**')) return h('strong', null, part.slice(2, -2));
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (!link) return document.createTextNode(part);
    const href = markdownHref(link[2], source, links);
    return href
      ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${link[1]} (opens in a new tab)` }, link[1])
      : document.createTextNode(link[1]);
  });
}

/** @param {string[]} lines @param {number} index */
function startsBlock(lines, index) {
  const line = lines[index];
  return /^\s*(?:```|#{1,6}\s|>|[-*+] |\d+\. )/.test(line)
    || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)
    || isTableHeader(lines, index);
}

/** @param {string[]} lines @param {number} index */
function isTableHeader(lines, index) {
  return lines[index]?.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? '');
}

/** @param {string} line */
function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

/**
 * @param {string} href
 * @param {Record<string, unknown>} source
 * @param {{ pathField: string, baseLinkField: string }} links
 */
function markdownHref(href, source, links) {
  if (/^https:\/\//i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return '';
  const baseLink = links.baseLinkField ? findLink(source, links.baseLinkField) : null;
  const repositoryUrl = baseLink?.externalHref ?? baseLink?.href ?? '';
  const sourcePath = links.pathField ? value(source[links.pathField]) : '';
  if (!repositoryUrl || !sourcePath) return '';
  const directory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : '';
  try {
    const repository = new URL(repositoryUrl);
    if (repository.protocol !== 'https:') return '';
    const base = new URL(`${repositoryUrl.replace(/\/$/, '')}/blob/HEAD/${directory}`);
    const resolved = new URL(href, base);
    return resolved.origin === repository.origin && resolved.pathname.startsWith(`${repository.pathname.replace(/\/$/, '')}/`)
      ? resolved.href
      : '';
  } catch {
    return '';
  }
}

/** @param {unknown} input */
function value(input) {
  return typeof input === 'string' ? input.trim() : '';
}
