import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { findLink } from './link-content.js';

/** @param {{ packageId: string, packageName: string, workflows: Array<Record<string, unknown>> }} args */
export function renderPackageReadme({ packageId, packageName, workflows }) {
  const primary = workflows.find((workflow) => workflow['workflow-role'] === 'orchestrator') ?? workflows[0] ?? {};
  const description = value(primary['package-description']) || `Operational workflows in the ${packageName} package.`;
  const markdown = value(primary['package-readme']);
  const repositoryUrl = ownerUrl(primary);
  const readmeUrl = repositoryFileUrl(primary, value(primary['package-readme-path']));
  const mode = value(primary['rollout-mode']);
  return h(
    'section',
    { className: 'package-marketplace-detail', 'data-package': packageId },
    h('header', { className: 'package-marketplace-header' },
      h('div', { className: 'package-marketplace-identity' },
        h('span', { className: 'package-marketplace-icon', 'aria-hidden': 'true' }, octicon(value(primary['package-icon']) || 'package')),
        h('div', null,
          h('div', { className: 'package-marketplace-title' }, h('h2', null, packageName), h('span', null, 'Package')),
          h('p', null, description))),
      h('div', { className: 'package-marketplace-actions' },
        readmeUrl ? resourceLink(readmeUrl, 'Read README', 'book') : null,
        repositoryUrl ? resourceLink(repositoryUrl, 'View source', 'mark-github') : null)),
    h('div', { className: 'package-readme-layout' },
      h('article', { className: 'package-readme markdown-body', 'aria-label': `${packageName} README` },
        ...(markdown ? renderMarkdownBlocks(markdown, primary) : [
          h('h1', null, packageName),
          h('p', null, description),
          h('p', { className: 'value-details-unavailable' }, 'Package README content is unavailable in this inventory.')
        ])),
      h('aside', { className: 'package-readme-about', 'aria-label': `${packageName} package information` },
        h('section', null,
          h('h2', null, 'About'),
          h('p', null, description),
          h('dl', null,
            h('div', null, h('dt', null, 'Workflows'), h('dd', null, String(workflows.length))),
            h('div', null, h('dt', null, 'Owner'), h('dd', null, owner(primary))),
            mode ? h('div', null, h('dt', null, 'Rollout'), h('dd', { className: `package-rollout package-rollout-${mode}` }, mode)) : null)),
        h('details', { className: 'package-readme-resources' },
          h('summary', null,
            h('span', null, 'Resources'),
            h('span', { className: 'package-readme-resources-hint' }, 'Show details')),
          h('ul', null,
            readmeUrl ? h('li', null, resourceLink(readmeUrl, 'README', 'book')) : null,
            repositoryUrl ? h('li', null, resourceLink(repositoryUrl, 'Source repository', 'repo')) : null))))
  );
}

/** @param {string} href @param {string} label @param {string} icon */
function resourceLink(href, label, icon) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, octicon(icon), h('span', null, label));
}

/** @param {string} markdown @param {Record<string, unknown>} source */
function renderMarkdownBlocks(markdown, source) {
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
      nodes.push(h(`h${heading[1].length}`, null, ...renderInline(heading[2], source)));
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
        h('thead', null, h('tr', null, ...headers.map((cell) => h('th', { scope: 'col' }, ...renderInline(cell, source))))),
        h('tbody', null, ...rows.map((row) => h('tr', null, ...row.map((cell) => h('td', null, ...renderInline(cell, source))))))));
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
        items.push(h('li', null, ...renderInline(item[1], source)));
        index += 1;
      }
      nodes.push(h(ordered ? 'ol' : 'ul', null, ...items));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      nodes.push(h('blockquote', null, h('p', null, ...renderInline(quote.join(' '), source))));
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++].trim());
    nodes.push(h('p', null, ...renderInline(paragraph.join(' '), source)));
  }
  return nodes;
}

/** @param {string} text @param {Record<string, unknown>} source */
function renderInline(text, source) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return parts.map((part) => {
    if (part.startsWith('`') && part.endsWith('`')) return h('code', null, part.slice(1, -1));
    if (part.startsWith('**') && part.endsWith('**')) return h('strong', null, part.slice(2, -2));
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (!link) return document.createTextNode(part);
    const href = readmeHref(link[2], source);
    return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, link[1]) : document.createTextNode(link[1]);
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

/** @param {string} href @param {Record<string, unknown>} source */
function readmeHref(href, source) {
  if (/^https:\/\//i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return '';
  const repositoryUrl = ownerUrl(source);
  const readmePath = value(source['package-readme-path']);
  if (!repositoryUrl || !readmePath) return '';
  const directory = readmePath.includes('/') ? readmePath.slice(0, readmePath.lastIndexOf('/') + 1) : '';
  try {
    const base = new URL(`${repositoryUrl}/blob/HEAD/${directory}`);
    const resolved = new URL(href, base);
    return resolved.origin === base.origin && resolved.pathname.startsWith(`${new URL(repositoryUrl).pathname}/`)
      ? resolved.href
      : '';
  } catch {
    return '';
  }
}

/** @param {Record<string, unknown>} source */
function ownerUrl(source) {
  const link = findLink(source, 'repository-link');
  return link?.externalHref ?? link?.href ?? '';
}

/** @param {Record<string, unknown>} source @param {string} filePath */
function repositoryFileUrl(source, filePath) {
  const repositoryUrl = ownerUrl(source);
  if (!repositoryUrl || !filePath || filePath.startsWith('/') || filePath.includes('..')) return '';
  return `${repositoryUrl}/blob/HEAD/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** @param {Record<string, unknown>} source */
function owner(source) {
  return [value(source.organization), value(source.repository)].filter(Boolean).join('/') || 'Unknown';
}

/** @param {unknown} input */
function value(input) {
  return typeof input === 'string' ? input.trim() : '';
}
