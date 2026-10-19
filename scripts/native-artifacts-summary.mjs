import { createHash } from "node:crypto";

const repository = "github/gh-aw";
const repositoryId = 1036865607;
const prefix = `repos/${repository}`;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
const time = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const digest = value => createHash("sha256").update(value).digest("hex");
export class NativeEvidenceError extends Error {}
const assert = (condition, message) => { if (!condition) throw new NativeEvidenceError(message); };

export function decodeResponse(response) {
  assert(response && response.status === 200 && time(response.acquiredAt)
    && typeof response.endpoint === "string" && typeof response.bodyBase64 === "string",
  "Missing successful original API response bytes");
  const bytes = Buffer.from(response.bodyBase64, "base64");
  assert(bytes.toString("base64") === response.bodyBase64 && bytes.length <= 16 * 1024 * 1024,
    "Invalid or oversized original API bytes");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new NativeEvidenceError(`Malformed original API JSON: ${error.message}`);
  }
  assert(value && typeof value === "object" && !Array.isArray(value), "Invalid native response object");
  return { value, sha256: digest(bytes) };
}

export function reportWindow(reportDate) {
  assert(typeof reportDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)
    && new Date(`${reportDate}T00:00:00Z`).toISOString().startsWith(reportDate), "Invalid assigned report date");
  const end = Date.parse(`${reportDate}T00:00:00Z`) + 86400000;
  return { start: end - 30 * 86400000, end };
}

export function nativePages(responses, endpoint, field) {
  if (!Array.isArray(responses) || !responses.length) return { complete: false, rows: [], reason: "No native pages" };
  const rows = [], seen = new Set(), fingerprints = [];
  let total;
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index];
    const expected = new URL(`https://api.github.com/${endpoint}`);
    expected.searchParams.set("per_page", "100");
    expected.searchParams.set("page", String(index + 1));
    const actual = new URL(`https://api.github.com/${response.endpoint}`);
    assert(actual.origin === expected.origin && actual.pathname === expected.pathname
      && [...actual.searchParams].length === [...expected.searchParams].length
      && [...expected.searchParams].every(([key, value]) => actual.searchParams.get(key) === value),
    "Native pagination endpoint or page mismatch");
    const { value, sha256 } = decodeResponse(response);
    assert(integer(value.total_count) && Array.isArray(value[field]) && value[field].length <= 100,
      "Malformed native total or population");
    total ??= value.total_count;
    assert(total === value.total_count, "Native population changed during pagination");
    for (const row of value[field]) {
      assert(positive(row.id) && !seen.has(row.id), "Duplicate or malformed native identity");
      seen.add(row.id);
      rows.push(row);
    }
    fingerprints.push(sha256);
    const needsNext = rows.length < total;
    if (index < responses.length - 1) assert(needsNext && value[field].length === 100,
      "Extra or short intermediate native page");
    assert(rows.length <= total, "Native count exceeds population");
  }
  return { complete: rows.length === total, rows, total, fingerprints,
    reason: rows.length === total ? null : "Native pagination incomplete" };
}

export function parseReportTable(body) {
  assert(typeof body === "string", "Missing original report body");
  const lines = body.split(/\r?\n/);
  const header = lines.findIndex(line =>
    /^\s*\|/.test(line) && /Workflow Name/i.test(line) && /Artifacts Count|Total Artifacts Count/i.test(line));
  if (header < 0) return null;
  assert(/^\s*\|(?:\s*:?-+:?\s*\|){6}\s*$/.test(lines[header + 1] ?? ""), "Malformed inventory table separator");
  const columns = line => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
  const headings = columns(lines[header]);
  assert(headings.length === 6 && /Workflow Name/i.test(headings[0])
    && /Artifacts Count/i.test(headings[1]) && /Total Size/i.test(headings[2])
    && /Avg Size|Average Size/i.test(headings[3]) && /Latest Run/i.test(headings[4])
    && /Status/i.test(headings[5]), "Unsupported inventory table columns");
  const rows = [], names = new Set();
  for (let i = header + 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
    const cells = columns(lines[i]);
    assert(cells.length === 6 && cells.every(Boolean) && /^\d+$/.test(cells[1]),
      "Malformed inventory report row");
    assert(!names.has(cells[0]), "Ambiguous repeated workflow report name");
    names.add(cells[0]);
    rows.push({ name: cells[0], count: Number(cells[1]), total: cells[2],
      average: cells[3], latest: cells[4], status: cells[5] });
  }
  return rows;
}

function matchesSize(cell, bytes, base) {
  const match = cell.match(/^(\d+(?:\.\d+)?)\s*(MB|GB)$/);
  if (!match) return false;
  const places = match[1].split(".")[1]?.length ?? 0;
  if (places > 12) return false;
  const divisor = base ** (match[2] === "MB" ? 2 : 3);
  return (bytes / divisor).toFixed(places) === Number(match[1]).toFixed(places);
}

function publishedReport(response, reportDate) {
  if (!response) return null;
  const { value, sha256 } = decodeResponse(response);
  let report;
  if (response.endpoint === "graphql") {
    assert(!value.errors?.length && value.data?.repository?.databaseId === repositoryId
      && value.data.repository.nameWithOwner === repository, "Foreign or failed Discussion readback");
    const item = value.data.repository.discussion;
    assert(item && positive(item.number) && typeof item.id === "string"
      && item.url === `https://github.com/${repository}/discussions/${item.number}`, "Invalid Discussion identity");
    report = { id: item.id, body: item.body, createdAt: item.createdAt, updatedAt: item.updatedAt, title: item.title,
      originalContentKnown: Object.hasOwn(item, "lastEditedAt") && item.lastEditedAt === null };
  } else {
    assert(new RegExp(`^${prefix}/issues/[1-9]\\d*$`).test(response.endpoint)
      && response.endpoint === `${prefix}/issues/${value.number}`
      && value.html_url === `https://github.com/${repository}/issues/${value.number}`
      && typeof value.node_id === "string" && !value.pull_request, "Invalid published report identity");
    report = { id: value.node_id, body: value.body, createdAt: value.created_at,
      updatedAt: value.updated_at, title: value.title, originalContentKnown: value.created_at === value.updated_at };
  }
  assert(typeof report.body === "string" && time(report.createdAt) && time(report.updatedAt)
    && Date.parse(report.createdAt) <= Date.parse(report.updatedAt)
    && Date.parse(report.updatedAt) <= Date.parse(response.acquiredAt)
    && report.title === `Artifacts Usage Report - ${reportDate}`, "Invalid publication date, title or body");
  return { ...report, sha256, bodySha256: digest(report.body), observedAt: response.acquiredAt };
}

export function reconcileInventory(packet) {
  assert(packet && typeof packet === "object", "Invalid native inventory packet");
  const window = reportWindow(packet.reportDate);
  const workflowPages = nativePages(packet.workflowPages, `${prefix}/actions/workflows`, "workflows");
  const report = publishedReport(packet.report, packet.reportDate);
  const inventoryResponses = [
    ...(packet.workflowPages ?? []),
    ...Object.values(packet.runPages ?? {}).flat(),
    ...Object.values(packet.artifactPages ?? {}).flat(),
  ];
  for (const response of inventoryResponses) {
    assert(time(response.acquiredAt) && (!report
      || Date.parse(response.acquiredAt) <= Date.parse(report.observedAt)),
    "Inventory response acquired after report observation");
  }
  const table = report ? parseReportTable(report.body) : null;
  const facts = [], missing = [], artifactIds = new Set(), runIds = new Set();
  if (!workflowPages.complete) missing.push("Workflow inventory incomplete");
  if (!report || !table) missing.push("Original published inventory table unavailable");
  const workflowNames = new Set();
  for (const workflow of workflowPages.rows) {
    assert(typeof workflow.name === "string" && workflow.name.length > 0
      && typeof workflow.path === "string", "Malformed native workflow");
    assert(!workflowNames.has(workflow.name), "Ambiguous native workflow names");
    workflowNames.add(workflow.name);
    const endpoint = `${prefix}/actions/workflows/${workflow.id}/runs?created=${encodeURIComponent(
      `${new Date(window.start).toISOString().replace(".000Z", "Z")}..${new Date(window.end).toISOString().replace(".000Z", "Z")}`)}`;
    const runs = nativePages(packet.runPages?.[workflow.id], endpoint, "workflow_runs");
    let complete = runs.complete && runs.total <= 1000;
    let count = 0, bytes = 0, latest = null;
    for (const run of runs.rows) {
      assert(positive(run.id) && !runIds.has(run.id) && run.workflow_id === workflow.id
        && run.repository?.id === repositoryId && run.repository.full_name === repository
        && time(run.created_at), "Invalid native run binding");
      runIds.add(run.id);
      if (Date.parse(run.created_at) < window.start || Date.parse(run.created_at) >= window.end
        || run.conclusion === "cancelled") continue;
      assert(typeof run.conclusion === "string" || run.conclusion === null, "Malformed native run conclusion");
      if (latest === null || Date.parse(run.created_at) > Date.parse(latest)) latest = run.created_at;
      const artifacts = nativePages(packet.artifactPages?.[run.id], `${prefix}/actions/runs/${run.id}/artifacts`, "artifacts");
      complete &&= artifacts.complete;
      for (const artifact of artifacts.rows) {
        assert(!artifactIds.has(artifact.id) && artifact.workflow_run?.id === run.id
          && artifact.workflow_run.repository_id === repositoryId && integer(artifact.size_in_bytes)
          && typeof artifact.expired === "boolean", "Invalid native artifact size, identity or run binding");
        artifactIds.add(artifact.id);
        count++;
        bytes += artifact.size_in_bytes;
        assert(integer(bytes), "Artifact byte total exceeds exact integer range");
      }
    }
    if (!complete) missing.push(`Workflow ${workflow.id}: run/artifact coverage incomplete`);
    facts.push({ workflowId: workflow.id, name: workflow.name, count, bytes, latest, complete });
  }
  const expected = facts.filter(row => row.count > 0);
  const checks = [1000, 1024].map(base => {
    const checked = facts.map(fact => {
      if (!fact.complete || !table) return { ...fact, reconciled: null };
      const row = table.find(item => item.name === fact.name);
      const reconciled = !fact.count ? row === undefined
        : !!row && row.count === fact.count && matchesSize(row.total, fact.bytes, base)
          && matchesSize(row.average, fact.bytes / fact.count, base)
          && (row.latest === fact.latest || row.latest === fact.latest?.slice(0, 10))
          && row.status === "Active";
      return { ...fact, reconciled };
    });
    return { base, checked, valid: checked.every(row => row.reconciled === true)
      && table?.length === expected.length };
  });
  const validChecks = checks.filter(check => check.valid);
  // Row-level evidence survives unknown global coverage. Full acceptance still
  // requires one consistent size interpretation for the entire table.
  const selected = validChecks[0] ?? { base: null, valid: false, checked: checks[0].checked.map((row, index) => ({
    ...row, reconciled: row.reconciled === null ? null
      : row.reconciled || checks[1].checked[index].reconciled,
  })) };
  const verified = selected.checked.filter(row => row.count > 0 && row.reconciled === true);
  const observed = table !== null && workflowPages.rows.length > 0
    && selected.checked.some(row => row.reconciled !== null);
  const contemporaneousInventory = !!report && Date.parse(report.createdAt) >= window.end
    && inventoryResponses.length > 0 && inventoryResponses.every(response =>
    Date.parse(response.acquiredAt) >= window.end
      && Date.parse(response.acquiredAt) <= Date.parse(report.createdAt));
  if (!contemporaneousInventory) missing.push("Independent inventory was not preserved before original publication after the completed report date");
  const verifiedBytes = verified.reduce((sum, row) => sum + row.bytes, 0);
  return {
    reportDate: packet.reportDate, analysisWindow: {
      startAt: new Date(window.start).toISOString(), endAt: new Date(window.end).toISOString(),
    },
    report: report ? { id: report.id, createdAt: report.createdAt, updatedAt: report.updatedAt,
      originalContentKnown: report.originalContentKnown,
      observedAt: report.observedAt, sha256: report.sha256, bodySha256: report.bodySha256 } : null,
    inventoryComplete: workflowPages.complete && facts.every(fact => fact.complete),
    contemporaneousInventory,
    accuracy: !table || !workflowPages.complete || facts.some(fact => !fact.complete)
      ? "unknown" : selected.valid ? "accurate" : "incorrect",
    verifiedWorkflows: observed ? verified.length : null,
    verifiedStorageBytes: observed && integer(verifiedBytes) ? verifiedBytes : null,
    nativeFacts: facts, unitBase: selected.valid ? selected.base : null, missing,
    safeguards: { insights: "unknown", retentionInterpretation: "unknown", optimizationBenefit: "unknown" },
    costs: "unmeasured",
  };
}
