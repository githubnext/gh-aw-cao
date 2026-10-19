import path from "node:path";

function destination(file, value) {
  if (!value || /[:?#\\\s${}<>]/.test(value) || !/\.(?:md|mdx)$/.test(value)) return null;
  if (value.startsWith("/")) return null;
  const target = value.startsWith(".github/") || value.startsWith("docs/")
    ? value : path.posix.normalize(path.posix.join(path.posix.dirname(file), value));
  if (target.startsWith("../") || target.split("/").includes("..")) return null;
  return target;
}

export function references(file, text) {
  const out = [];
  let fenced = false;
  for (const [line, content] of text.split("\n").entries()) {
    if (/^\s*(```|~~~)/.test(content)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const patterns = [/\[[^\]\n]*\]\(([^()\s]+)\)/g, /`((?:\.github|docs)\/[^`\n]+)`/g];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        const target = destination(file, match[1]);
        if (!target) continue;
        const localOffset = match[0].indexOf(match[1]);
        const start = match.index + localOffset, end = start + match[1].length;
        out.push({ line: line + 1, target, context: content.slice(0, start) + "{TARGET}" + content.slice(end) });
      }
    }
  }
  return out;
}

export function referenceRepairs(file, before, after, beforeExists, afterExists) {
  const oldRefs = references(file, before), newRefs = references(file, after);
  const repairs = [], assessed = [];
  for (const old of oldRefs) {
    if (beforeExists(old.target)) continue;
    const candidates = newRefs.filter(next => next.context === old.context);
    if (oldRefs.filter(item => item.context === old.context).length !== 1 || candidates.length !== 1) continue;
    const next = candidates[0];
    const repaired = afterExists(next.target);
    assessed.push({ file, before: old, after: next, repaired });
    if (repaired) repairs.push({ file, oldTarget: old.target, newTarget: next.target,
      beforeLine: old.line, afterLine: next.line });
  }
  return { repairs, assessed };
}

export function applicable(slug, text) {
  if (typeof text !== "string") return false;
  if (slug === "designer-drift-audit") return /workflow designer/i.test(text) && /stale references/i.test(text);
  if (slug === "daily-doc-healer") return /DDUw/.test(text) && /missed/i.test(text) && /documentation gaps/i.test(text);
  return /documentation/i.test(text) && /recent code changes/i.test(text);
}
