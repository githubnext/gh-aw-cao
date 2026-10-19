import { createHash } from "node:crypto";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function bodyOf(subject) {
  if (!subject || !Number.isSafeInteger(subject.id) || subject.id <= 0
    || typeof subject.node_id !== "string" || !subject.node_id
    || !Number.isSafeInteger(subject.number) || subject.number <= 0
    || subject.html_url !== `https://github.com/github/gh-aw/issues/${subject.number}`
    || typeof subject.body !== "string" || Buffer.byteLength(subject.body) > 256 * 1024
    || subject.pull_request !== undefined) {
    throw new Error("Unsupported native report subject; expected a bounded GitHub REST issue snapshot");
  }
  return subject.body;
}

// This is a deliberately closed syntax-repair instrument, not a Markdown renderer
// or a readability test. Unsupported syntax must not become a clean report.
function project(body) {
  if (body.includes("\r") || body.includes("\0") || /[\u2028\u2029]/u.test(body)) return null;
  const lines = body.split("\n");
  const headings = [];
  let fence = null;
  let details = false;
  let summaries = 0;
  let badSummaries = 0;
  let links = 0;
  let badLinks = 0;
  const content = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    const delimiter = line.match(/^(`{3,}|~{3,})([^`]*)$/);
    if (fence) {
      content.push(line);
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length
        && !delimiter[2].trim()) fence = null;
      continue;
    }
    if (delimiter) {
      fence = delimiter[1];
      content.push(line);
      continue;
    }
    if (/^ {4}|\t|<!--|!\[|\\[<>`#]|\[[^\]]*\]:|^ {0,3}(?:=+|-+)\s*$/.test(line)) return null;
    if (line === "<details>") {
      if (details || summaries !== 0) return null;
      details = true;
      content.push(line);
      continue;
    }
    if (line === "</details>") {
      if (!details || summaries !== 1) return null;
      details = false;
      summaries = 0;
      content.push(line);
      continue;
    }
    const summary = line.match(/^<summary>(?:<b>([^<>]+)<\/b>|([^<>]+))<\/summary>$/);
    if (summary) {
      if (!details || ++summaries !== 1) return null;
      badSummaries += summary[2] !== undefined ? 1 : 0;
      content.push(`<summary>${summary[1] ?? summary[2]}</summary>`);
      continue;
    }
    if (/<|>/.test(line) || details && summaries !== 1) return null;
    const heading = line.match(/^(#{1,6}) ([^#].*?)(?: +#+)?$/);
    if (heading) {
      headings.push(heading[1].length);
      line = `HEADING ${heading[2]}`;
    } else if (/^ {0,3}#/.test(line)) return null;
    // Only a label for the identical numeric run is normalized. Arbitrary label
    // rewrites and cross-repository links cannot establish content preservation.
    line = line.replace(/\[(§?[1-9]\d*|[Rr]un [1-9]\d*)\]\((https:\/\/github\.com\/github\/gh-aw\/actions\/runs\/([1-9]\d*))\)/g,
      (whole, label, url, id) => {
        if (label.replace(/^§|^[Rr]un /, "") !== id) return whole;
        links += 1;
        badLinks += label !== `§${id}` ? 1 : 0;
        return `RUN ${id} ${url}`;
      });
    if (/actions\/runs\//.test(line.replace(/RUN [1-9]\d* https:\/\/github\.com\/github\/gh-aw\/actions\/runs\/[1-9]\d*/g, ""))) return null;
    content.push(line);
  }
  if (fence || details) return null;
  return {
    content: content.join("\n"),
    headings,
    violations: {
      headingHierarchy: headings.filter(level => level < 3).length,
      boldSummary: badSummaries,
      runReference: badLinks,
    },
    opportunities: { headings: headings.length, runReferences: links },
  };
}

export function inspectReportRepair(before, after) {
  const beforeBody = bodyOf(before);
  const afterBody = bodyOf(after);
  if (before.id !== after.id || before.node_id !== after.node_id || before.number !== after.number) {
    throw new Error("Report repair changed the native subject identity");
  }
  const left = project(beforeBody);
  const right = project(afterBody);
  const identity = { id: before.node_id, number: before.number,
    beforeSha256: sha256(beforeBody), afterSha256: sha256(afterBody) };
  if (!left || !right) return { ...identity, status: "unknown", reason: "unsupported-report-syntax",
    fullAcceptance: null };
  const sameHierarchy = left.headings.length === right.headings.length
    && left.headings.every((level, index) => index === 0
      || level - left.headings[index - 1] === right.headings[index] - right.headings[index - 1]);
  const contentPreserved = left.content === right.content && sameHierarchy;
  const facets = Object.keys(left.violations).filter(key => right.violations[key] < left.violations[key]);
  const regressions = Object.keys(left.violations).filter(key => right.violations[key] > left.violations[key]);
  return {
    ...identity,
    status: contentPreserved && facets.length > 0 && regressions.length === 0 ? "partial-style-repair" : "not-established",
    contentPreserved, facets, regressions, before: left.violations, after: right.violations,
    fullAcceptance: null,
    limitation: "Source-defined syntax conformance only; no evidence of readability, disclosure relevance, actual use or workflow contribution.",
  };
}

export function fixtureIssue(body, number = 1) {
  return { id: number, node_id: `fixture-only-${number}`, number,
    html_url: `https://github.com/github/gh-aw/issues/${number}`, body };
}

export function assessNativeRepairs(records, windowStart, windowEnd) {
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  if (!Array.isArray(records) || records.length > 10000 || !Number.isFinite(start)
    || !Number.isFinite(end) || start >= end) throw new Error("Invalid bounded native repair input");
  const accepted = new Set();
  const seen = new Set();
  const facts = [];
  let unknown = 0;
  for (const record of records) {
    if (!record || typeof record.editedAt !== "string"
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(record.editedAt)
      || !Number.isFinite(Date.parse(record.editedAt))) throw new Error("Missing native body-edit timestamp");
    const fact = inspectReportRepair(record.before, record.after);
    const identity = `${fact.id}:${record.editedAt}`;
    if (seen.has(identity)) throw new Error("Repeated or conflicting native body-edit identity");
    seen.add(identity);
    if (Date.parse(record.editedAt) < start || Date.parse(record.editedAt) >= end) continue;
    facts.push({ ...fact, editedAt: record.editedAt });
    if (fact.status === "partial-style-repair") accepted.add(fact.id);
    if (fact.status === "unknown") unknown += 1;
  }
  return { demonstratedReports: accepted.size, unassessedEdits: unknown, facts, fullAcceptance: null };
}
