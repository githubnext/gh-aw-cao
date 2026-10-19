import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = new URL("../", import.meta.url);
const directory = "docs/operational-value/proof/constraint-potd/";
export const hash = value => createHash("sha256").update(value).digest("hex");
const bytes = name => readFileSync(new URL(name, root));
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const permutation = (values, n) => Array.isArray(values) && values.length === n
  && values.every(value => Number.isInteger(value) && value >= 1 && value <= n) && new Set(values).size === n;

export function verifyInstance(kind, instance, witness) {
  if (kind === "n-queens") {
    const n = instance?.size;
    return Number.isInteger(n) && n >= 1 && n <= 32 && permutation(witness, n)
      && new Set(witness.map((column, row) => column + row)).size === n
      && new Set(witness.map((column, row) => column - row)).size === n;
  }
  if (kind === "latin-square" || kind === "sudoku") {
    const n = instance?.size;
    if (!Number.isInteger(n) || n < 1 || n > 32 || !Array.isArray(witness) || witness.length !== n
      || !witness.every(row => permutation(row, n))
      || !witness.every((_, column) => permutation(witness.map(row => row[column]), n))) return false;
    if (instance.givens !== undefined && (!Array.isArray(instance.givens) || instance.givens.length !== n
      || !instance.givens.every((row, r) => Array.isArray(row) && row.length === n
        && row.every((value, c) => Number.isInteger(value) && value >= 0 && value <= n
          && (!value || value === witness[r][c]))))) return false;
    if (kind === "sudoku") {
      const side = Math.sqrt(n);
      if (!Number.isInteger(side)) return false;
      for (let r = 0; r < n; r += side) for (let c = 0; c < n; c += side) {
        if (!permutation(witness.slice(r, r + side).flatMap(row => row.slice(c, c + side)), n)) return false;
      }
    }
    return true;
  }
  if (kind === "graph-coloring") {
    const { vertices, edges, colors } = instance ?? {};
    if (!Array.isArray(vertices) || !vertices.length || vertices.length > 128
      || !vertices.every(v => typeof v === "string" && /^[A-Za-z0-9_]+$/.test(v))
      || new Set(vertices).size !== vertices.length || !Number.isInteger(colors) || colors < 1
      || !Array.isArray(edges) || !witness || typeof witness !== "object" || Array.isArray(witness)
      || !isDeepStrictEqual(Object.keys(witness).sort(), [...vertices].sort())
      || !vertices.every(v => Number.isInteger(witness[v]) && witness[v] >= 1 && witness[v] <= colors)) return false;
    return edges.every(edge => Array.isArray(edge) && edge.length === 2
      && edge.every(v => vertices.includes(v)) && witness[edge[0]] !== witness[edge[1]]);
  }
  return false;
}

export function inspectLesson(kind, body) {
  if (typeof body !== "string") throw new Error("Missing original lesson body");
  const missing = reason => ({ kind, status: "missing", reason, instance: null, witness: null });
  let instance, witness, quote;
  if (kind === "n-queens") {
    const matches = [...body.matchAll(/For a (\d+)×\1 board, one valid solution is:\s*```[^\n]*\n([\s\S]*?)```/g)];
    if (matches.length !== 1) return missing("No unambiguous explicit N-Queens board/witness in the supported source syntax.");
    const match = matches[0], size = Number(match[1]);
    const rows = match[2].trim().split("\n").map(row => row.trim().split(/\s+/));
    instance = { size };
    witness = rows.length === size && rows.every(row => row.length === size
      && row.every(cell => cell === "." || cell === "Q") && row.filter(cell => cell === "Q").length === 1)
      ? rows.map(row => row.indexOf("Q") + 1) : [];
    quote = match[0];
  } else if (kind === "latin-square") {
    const matches = [...body.matchAll(/\*\*Small instance \(n = (\d+)\):\*\*\s*```\n([\s\S]*?)```/g)];
    if (matches.length !== 1) return missing("No unambiguous explicit Latin-square order and filled instance.");
    instance = { size: Number(matches[0][1]) };
    witness = matches[0][2].trim().split("\n").map(row => row.trim().split(/\s+/).map(Number));
    quote = matches[0][0];
  } else if (kind === "graph-coloring") {
    const matches = [...body.matchAll(/Vertices: \{([A-Za-z0-9_, ]+)\}\nEdges: \{((?:\([A-Za-z0-9_]+,[A-Za-z0-9_]+\)(?:, )?)+)\}/g)];
    const bound = [...body.matchAll(/A valid (\d+)-coloring assigns:/g)];
    if (matches.length !== 1 || bound.length !== 1) return missing("No unambiguous explicit graph and proposed coloring.");
    const groups = body.slice(bound[0].index + bound[0][0].length).split(/\n\s*\n/)[0];
    const colors = [...groups.matchAll(/^- Color (\d+): \{([A-Za-z0-9_, ]+)\}$/gm)];
    if (!colors.length) return missing("No explicit complete vertex-to-color witness.");
    instance = { vertices: matches[0][1].split(",").map(v => v.trim()),
      edges: [...matches[0][2].matchAll(/\(([A-Za-z0-9_]+),([A-Za-z0-9_]+)\)/g)].map(row => row.slice(1)),
      colors: Number(bound[0][1]) };
    const entries = colors.flatMap(row => row[2].split(",").map(v => [v.trim(), Number(row[1])]));
    witness = Object.fromEntries(entries);
    if (new Set(entries.map(row => row[0])).size !== entries.length) witness = {};
    quote = [matches[0][0], `${bound[0][0]}${groups}`];
  } else if (kind === "sudoku") {
    const grids = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(match => ({
      quote: match[0], prefix: body.slice(Math.max(0, match.index - 150), match.index),
      rows: match[1].trim().split("\n").filter(row => !/^[+\-|\s]+$/.test(row))
        .map(row => row.replaceAll("|", " ").trim().split(/\s+/)),
    })).filter(grid => grid.rows.length === 9 && grid.rows.every(row => row.length === 9
      && row.every(cell => /^[1-9.0]$/.test(cell))));
    const givens = grids.filter(grid => grid.rows.flat().some(cell => cell === "." || cell === "0"));
    const solutions = grids.filter(grid => grid.rows.flat().every(cell => /^[1-9]$/.test(cell))
      && /\bsolution\b|\bcompleted grid\b/i.test(grid.prefix));
    if (givens.length !== 1 || solutions.length !== 1) {
      return missing("An explicit partial Sudoku input survives, but no unambiguous complete solution witness is supplied.");
    }
    instance = { size: 9, givens: givens[0].rows.map(row => row.map(cell => cell === "." ? 0 : Number(cell))) };
    witness = solutions[0].rows.map(row => row.map(Number));
    quote = [givens[0].quote, solutions[0].quote];
  } else return missing("Unsupported mathematical problem class; no compatibility acceptance.");
  const accepted = verifyInstance(kind, instance, witness);
  return { kind, status: accepted ? "verified" : "rejected", reason: accepted
    ? "Every defining constraint of the explicitly bound finite witness holds."
    : "The explicitly proposed witness violates the bound finite instance constraints.",
  instance, witness, quotes: Array.isArray(quote) ? quote : [quote] };
}

export function constraintModule(pins) {
  for (const [name, expected] of Object.entries(pins)) {
    if (hash(bytes(name)) !== expected) throw new Error(`Constraint instrument dependency changed: ${name}`);
  }
  const index = readJsonArchive(fileURLToPath(new URL(`${directory}index.json`, root)));
  const original = label => {
    const entry = index.receipts[label];
    if (!entry || !/^originals\/[\w.-]+\.json\.gz$/.test(entry.file)) throw new Error("Unsafe constraint original");
    const file = `${directory}${entry.file}`;
    if (hash(bytes(file)) !== entry.archiveSha256) throw new Error("Original archive changed");
    const packet = readJsonArchive(fileURLToPath(new URL(file, root)));
    if (hash(packet.body) !== packet.sha256 || packet.sha256 !== entry.bodySha256
      || !iso(packet.observedAt)) throw new Error("Original response changed");
    return { packet, value: JSON.parse(packet.body) };
  };
  const metadata = original("repository").value;
  if (metadata.id !== 1036865607 || metadata.full_name !== "github/gh-aw" || metadata.private !== false
    || index.repositoryId !== metadata.id || index.repository !== metadata.full_name
    || index.revision !== "c86377ec47b38f0b5af463277ee55d1d03d08da8"
    || index.cutoff !== "2026-10-18T15:00:12Z") throw new Error("Constraint public source scope changed");
  const source = (label, revision, suffix) => {
    const { packet, value } = original(label), name = `.github/workflows/constraint-solving-potd.${suffix}`;
    const content = Buffer.from(value.content.replace(/\s/g, ""), "base64");
    if (packet.endpoint !== `repos/github/gh-aw/contents/${name}?ref=${revision}`
      || value.path !== name || createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex") !== value.sha) {
      throw new Error("Immutable constraint source identity changed");
    }
    return { text: content.toString("utf8"), blob: value.sha };
  };
  const frozen = source("frozen-md", index.revision, "md");
  source("frozen-lock-yml", index.revision, "lock.yml");
  const adoption = original("adoption").value;
  if (adoption.sha !== "dc1d7031d3db32579ac3467eaf40fc0f35e828a5"
    || !adoption.files.some(row => row.filename === ".github/workflows/constraint-solving-potd.md" && row.status === "added")) {
    throw new Error("Constraint adoption changed");
  }
  const records = index.records.map(record => {
    const run = original(`run-${record.runId}`).value;
    const { packet, value } = original(`discussion-${record.number}`);
    const lesson = value.data?.repository?.discussion;
    if (value.errors?.length || value.data?.repository?.databaseId !== 1036865607
      || lesson?.number !== record.number || typeof lesson.id !== "string"
      || lesson.url !== `https://github.com/github/gh-aw/discussions/${record.number}`
      || !iso(lesson.createdAt) || !iso(lesson.updatedAt) || lesson.createdAt >= index.cutoff
      || run.id !== record.runId || run.repository?.id !== metadata.id || run.head_sha !== record.head
      || run.path !== ".github/workflows/constraint-solving-potd.lock.yml") throw new Error("Lesson/source identity changed");
    const editable = source(`source-${record.number}-md`, record.head, "md");
    source(`source-${record.number}-lock-yml`, record.head, "lock.yml");
    if (!editable.text.includes("A small concrete instance") || (!editable.text.includes("be **precise**")
      && !editable.text.includes("Be **precise**")) || !editable.text.includes("solution-provided")) {
      throw new Error("Native worked-example predicate does not apply to this goal era");
    }
    return { number: record.number, id: lesson.id, createdAt: lesson.createdAt,
      bodySha256: hash(lesson.body), observedAt: packet.observedAt, updatedAt: lesson.updatedAt,
      sourceBlob: editable.blob, head: record.head, runId: record.runId,
      inspection: inspectLesson(record.kind, lesson.body) };
  });
  const validEvidence = evidence => {
    if (evidence?.valid !== true || !Array.isArray(evidence.records)) return false;
    const ids = new Set();
    return evidence.records.every(record => {
      if (!record || typeof record.id !== "string" || ids.has(record.id)) return false;
      ids.add(record.id);
      return records.some(expected => isDeepStrictEqual(record, expected));
    });
  };
  const scoreMetric = (id, evidence) => {
    if (id !== "verified-worked-instances" || !validEvidence(evidence)) return null;
    const assessed = evidence.records.filter(row => row.inspection.status !== "missing");
    if (!assessed.length) return null;
    return assessed.filter(row => row.inspection.status === "verified").length;
  };
  const verified = records.filter(row => row.inspection.status === "verified");
  const definition = {
    schemaVersion: 3, slug: "constraint-solving-potd", repository: "github/gh-aw",
    workflowName: "Constraint-solving lessons: mathematically correct explicit worked instances",
    sourcePath: ".github/workflows/constraint-solving-potd.md", contractVersion: "1.0.0",
    intent: { goal: "Deliver correct concrete constraint-solving worked examples.",
      acceptance: "Independently verify every defining finite-instance constraint against an explicitly published complete witness.",
      temporalAnchor: "workflow-adoption" },
    adoption: { commit: adoption.sha, adoptedAt: adoption.commit.committer.date, baselineCommit: null, baselineAt: null },
    evaluation: { mode: "attainment-only", reason: "Selected surviving lesson versions, not a complete historical outcome census." },
    oracleDependencies: Object.entries(pins).map(([name, sha256]) => ({ path: name, sha256 })),
    frozenSource: { revision: index.revision, sourceBlob: frozen.blob, cutoff: index.cutoff },
    evidence: { key: "constraint-solving-potd/native-worked-instance/v1", repositories: ["github/gh-aw"],
      opportunity: "A published explicit complete finite worked instance and proposed witness.",
      filters: ["Exact public repository, source-era and surviving Discussion identities.",
        "Explicit complete finite witness verified against every defining mathematical constraint.",
        "Disjoint original-creation cohorts; surviving body accuracy is not publication-time accuracy."],
      collection: "Original Discussion bytes, immutable source custody and offline mathematical constraint verification.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Source-defined useful partial; broader educational quality remains unmeasured.",
      recommendation: "Not rated: no agreed native keep bar or matching costs.",
      presentation: { label: "Correct explicit worked examples", betterLabel: "More independently correct worked examples" } },
    summary: { nativeLabel: "correct explicit worked instances" },
    metrics: [
      { id: "verified-worked-instances", name: "Correct explicit worked instances", role: "primary",
        formula: "Distinct surviving explicit worked instances whose complete witnesses satisfy every defining constraint.",
        direction: "increase", unit: "worked instances",
        presentation: { name: "Correct worked examples", legendLabel: "Correct examples", transform: "identity" } },
    ],
    limitations: [index.selection, index.bodyVersion, index.contribution,
      "Feasibility is not optimality, general model correctness, reference quality or full educational acceptance.",
      "Unsupported syntax, missing witnesses and all other periods remain unknown, never exhaustive zeros.",
      "Full safeguards, nonrepetition, contribution, matching costs and native keep bar remain unknown."],
    validationExamples: {
      targetAttained: { valid: true, records: verified },
      targetMissed: { valid: true, records: verified.slice(0, 1) },
      missing: { valid: false },
      malformed: { valid: true, records: [{ id: "invented-worked-example" }] },
    },
  };
  async function collectBatch(requests, context = {}) {
    if (Object.keys(context).some(key => key !== "database")) throw new Error("Unverified worked-instance evidence authority");
    if (!Array.isArray(requests) || requests.length > 1000) throw new Error("Invalid bounded constraint period batch");
    return requests.map(request => {
      if (!request || ![request.windowStart, request.windowEnd, request.observedAt].every(iso)
        || request.windowStart >= request.windowEnd || request.observedAt < request.windowEnd
        || request.repository && request.repository !== "github/gh-aw") throw new Error("Invalid constraint period");
      const eligible = request.windowStart >= definition.adoption.adoptedAt && request.windowEnd <= index.cutoff;
      const selected = records.filter(row => row.createdAt >= request.windowStart && row.createdAt < request.windowEnd);
      return { evidence: { valid: eligible, records: selected, fullAcceptance: null, contribution: null, costs: null,
        missingReason: !eligible ? "Outside verified post-adoption/cutoff scope."
          : !selected.length ? "No selected surviving lesson in this period; absence is not zero."
            : selected.every(row => row.inspection.status === "missing") ? "No explicit complete supported witness."
              : "Bounded mathematical partial; all other lesson requirements remain unmeasured." },
      provenance: [{ repository: "github/gh-aw", kind: "original-surviving-lesson-mathematical-replay",
        ref: pins[`${directory}index.json`] }],
      commit: index.revision };
    });
  }
  return { definition, collectBatch, scoreMetric };
}
