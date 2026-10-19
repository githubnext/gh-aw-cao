import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { Linter } from "eslint";
import { parse } from "yaml";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

export function archiveHostContract(directory, contract, modulePath, removeIndex = true) {
  const version = createHash("sha256").update(readFileSync(modulePath)).digest("hex");
  const archive = `${directory}/versions/${contract.workflowId}/${version}`;
  const indexPath = `${directory}/${contract.workflowId}-index.json`;
  const index = existsSync(indexPath) ? readCensusJson(indexPath) : null;
  if (index && (!index.complete || index.contractSha256 !== censusDigest(contract))) {
    throw new Error("Cannot supersede mismatched host evidence");
  }
  const files = [[modulePath, "function.txt"],
    [`${directory}/${contract.workflowId}-sources.json.gz`, "sources.json.gz"]];
  if (index) {
    files.push([indexPath, "index.json"]);
    for (const part of index.partitions) {
      if (!/^[a-z0-9-]+-observations-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe prior host partition");
      const rows = readCensusJson(`${directory}/${part.file}`);
      if (rows.length !== part.count || censusDigest(rows) !== part.sha256) throw new Error("Prior host evidence changed");
      files.push([`${directory}/${part.file}`, part.file]);
    }
  }
  for (const [source, destination] of files) {
    if (existsSync(`${archive}/${destination}`)
      && !readFileSync(`${archive}/${destination}`).equals(readFileSync(source))) {
      throw new Error("Refusing to overwrite frozen host evidence");
    }
  }
  mkdirSync(archive, { recursive: true });
  writeCensusJson(`${archive}/contract.json`, contract);
  for (const [source, destination] of files) copyFileSync(source, `${archive}/${destination}`);
  if (index && removeIndex) unlinkSync(indexPath);
  return archive;
}

export function localCheckerDependencies(source, sourceType = "commonjs") {
  const dependencies = [];
  const linter = new Linter();
  const messages = linter.verify(source, [{ languageOptions: { ecmaVersion: "latest", sourceType },
    plugins: { checker: { rules: { dependencies: { create() {
      const literal = node => {
        if (node.type !== "Literal" || typeof node.value !== "string") throw new Error("Unresolved dynamic checker dependency");
        dependencies.push(node.value);
      };
      return { ImportDeclaration(node) { literal(node.source); },
        ExportNamedDeclaration(node) { if (node.source) literal(node.source); },
        ExportAllDeclaration(node) { literal(node.source); },
        ImportExpression(node) { literal(node.source); },
        CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "require") return;
        if (node.arguments.length !== 1) throw new Error("Invalid checker require");
        literal(node.arguments[0]);
      } };
    } } } } }, rules: { "checker/dependencies": "error" } }], { allowInlineConfig: false });
  if (messages.some(row => row.fatal || row.severity === 2)) {
    throw new Error(`Invalid checker source syntax: ${messages.map(row => `${row.line}:${row.message}`).join("; ")}`);
  }
  return dependencies;
}

export function authorHostAssertionFunctions(cache, extendReviewedRoutingHistory = false, extendReviewedGooseHistory = false,
  extendReviewedSubagentHistory = false) {
  const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8", repository = "github/gh-aw";
  const directory = "docs/operational-value/proof/host-assertions";
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  const show = file => git(["show", `${revision}:${file}`]);
  if (git(["remote", "get-url", "origin"]) !== "https://github.com/github/gh-aw.git") throw new Error("Unexpected host source remote");
  const sha = filename => createHash("sha256").update(readFileSync(filename)).digest("hex");
  const tree = new Set(git(["ls-tree", "-r", "--name-only", revision]).split("\n"));
  const builtins = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, ""), `node:${name.replace(/^node:/, "")}`]));
  const routing = ["actions/setup/js/smoke_model_routing_assertions.cjs"];
  const cases = {
    "daily-max-ai-credits-test": { name: "Daily Max AI Credits Test",
      goal: "Enforce the per-run one-credit inference cap through a genuine proxy rejection.",
      acceptance: "The protected verifier establishes an AWF configuration cap of exactly one and a native firewall rejection event or engine-authenticated proxy 403 at that cap.",
      metricLabel: "Verified per-run credit rejections", unit: "enforcement proofs",
      gates: [{ job: "verify_credit_limit", name: "Verify per-run credit rejection", meaning: "Configured one-credit cap and independently recorded per-run proxy rejection." }],
      checkers: [".github/scripts/check-max-ai-credits.cjs"],
      limitations: ["A workload ending below the cap is not evidence of broken enforcement. Current verifier semantics are a frozen partial historical facet."] },
    "smoke-claude-dynamic": { name: "Smoke Claude Dynamic Workflow",
      goal: "Maintain packaged native Claude dynamic-workflow invocation, trusted hidden fixtures and argument propagation.",
      acceptance: "The protected host checks immutable packaged script/fixture equality, expected result/run ID, a native Workflow invocation and completion notification correlated to that invocation.",
      metricLabel: "Verified dynamic-workflow invocations", unit: "invocation proofs",
      gates: [{ job: "agent", name: "Verify packaged Claude dynamic workflow evidence", meaning: "Trusted packaging and native dynamic invocation with fixture and run-ID propagation." }],
      checkers: ["actions/setup/js/log_parser_shared.cjs", "actions/setup/js/claude_session.cjs"],
      assets: [".claude/workflows/smoke-claude-dynamic.js", ".claude/workflows/references/smoke-claude-dynamic/.context"],
      limitations: ["The protected conjunction is not decomposed into guessed per-feature outcomes. Safe-output publication is outside this invocation facet."] },
    "smoke-claude-routed": { name: "Smoke Claude Routed",
      goal: "Route Claude inference according to the declared allowed-model and endpoint policy.",
      acceptance: "The protected source-defined routing gate requires actual runner/proxy evidence, selected allowed model, classification and real main-agent requests on the declared endpoint.",
      metricLabel: "Verified Claude routing assessments", unit: "routing proofs",
      gates: [{ job: "agent", name: "Assert model-routing evidence", meaning: "The configured Claude main-routing conjunction is independently established." }],
      checkers: routing, runtimeTrees: ["actions", ".github/workflows/shared"],
      limitations: ["This measures routing, not the trivial echo task or its issue report."] },
    "smoke-copilot-routed": { name: "Smoke Copilot Routed",
      goal: "Keep Copilot main routing within allowed models while maintaining independent unrouted threat-detection inference.",
      acceptance: "Both protected gates establish main routing from actual proxy/session evidence and detection completion on its dedicated model, without routing/classification leakage.",
      metricLabel: "Verified Copilot routing assessments", unit: "routing proofs",
      gates: [{ job: "agent", name: "Assert model-routing evidence", meaning: "Allowed main-model routing and actual inference requests." },
        { job: "detection", name: "Assert threat-detection evidence", meaning: "Dedicated-model detection completion, no routing/classification leakage." }],
      checkers: routing, runtimeTrees: ["actions", ".github/workflows/shared"],
      limitations: ["Both source-defined main and detection conjunctions are required; no constituent outcomes are inferred from a failed gate."] },
    "smoke-goose": { name: "Smoke Goose",
      goal: "Maintain the declared pinned Goose runtime and native GitHub MCP/session smoke conjunction.",
      acceptance: "The protected host requires checksum-verified source-declared Goose, a completed structured run, correlated successful native GitHub MCP requests/responses, canonical matched session events, independently merged PR identities and the remaining declared smoke fixtures.",
      metricLabel: "Verified Goose smoke assessments", unit: "smoke proofs",
      gates: [{ job: "agent", name: "Assert Goose smoke evidence",
        meaning: "The complete source-defined Goose host conjunction establishes native runtime/MCP/session capability." }],
      checkers: ["actions/setup/js/parse_goose_log.cjs"], runtimeTrees: ["actions", ".github/workflows/shared"],
      limitations: ["Native assertions are one conjunction, not independently counted feature deliveries. Fixture booleans and file existence alone do not establish compilation correctness; full build behavior, telemetry and exclusive causation remain separate.",
        "A historical pinned-runtime MCP proof does not certify the current Goose version or absence of every parser/session error. Historical parser validity beyond the protected assertions remains separate."] },
    "smoke-copilot-sub-agents": { name: "Smoke Copilot Sub Agents",
      goal: "Actually execute the three declared SDK subagents on their required native models and endpoints.",
      acceptance: "The independent activation-step log identifies inline_strict or delegated_sequential; the exact protected host conjunction then requires all three named invocations, successful completions, matching models and real successful proxy requests. The synthetic no-agent control is not positive capability.",
      metricLabel: "Verified three-agent SDK assessments", unit: "delegation proofs",
      gates: [{ job: "agent", name: "Assert sub-agent model and wire API evidence",
        meaning: "All three native model/endpoint delegations are established in an independently identified positive experiment variant.",
        experiment: { job: "activation", step: "Pick experiment variants", name: "sub_agent_strategy",
          variants: ["inline_strict", "delegated_sequential", "single_agent_control"],
          positiveVariants: ["inline_strict", "delegated_sequential"] } }],
      sourceJobs: ["activation"], conditionOracleSha256: sha("scripts/protected-host-log.mjs"),
      ...(extendReviewedSubagentHistory
        ? { conditionJobOracleSha256: sha("scripts/protected-experiment-job-log.mjs") } : {}),
      checkers: ["actions/setup/js/pick_experiment.cjs"], runtimeTrees: ["actions", ".github/workflows/shared"],
      limitations: ["A successful negative-control verifier establishes no positive delegation. Missing protected selection logs remain unknown; agent-authored issue text or whole-agent stdout cannot identify the accepted variant.",
        "One observed conjunction is not three separately delivered code changes or a statistically powered experiment result."] },
  };
  const additionalRouting = {
    "smoke-copilot-routed-claude": {
      name: "Smoke Copilot Routed Claude", goal: "Route Copilot CLI to the declared Claude main model in auto mode.",
      acceptance: "Runner/proxy evidence establishes claude-sonnet-5 main inference on /chat/completions, actual routing selection and classifier request, and the configured auto-mode/reasoning-effort policy.",
      metricLabel: "Verified Copilot Claude routing", gateName: "Assert model-routing evidence",
    },
    "smoke-copilot-sdk-routed": {
      name: "Smoke Copilot SDK Routed", goal: "Route SDK main inference to GPT and actually delegate the declared cross-family Haiku agent.",
      acceptance: "Actual gpt-5.6-luna main requests on /responses and exactly one successful named haiku-whoami delegation on claude-haiku-4.5 /chat/completions satisfy the protected routing conjunction.",
      metricLabel: "Verified SDK routing and delegation", gateName: "Assert model-routing and sub-agent evidence",
    },
    "smoke-copilot-sdk-routed-claude": {
      name: "Smoke Copilot SDK Routed Claude", goal: "Route SDK main inference to Claude and actually delegate the declared GPT agent.",
      acceptance: "Actual claude-haiku-4.5 main requests on /chat/completions and exactly one successful named mini-whoami delegation on gpt-5.4-mini /responses satisfy the protected routing conjunction.",
      metricLabel: "Verified Claude SDK delegation", gateName: "Assert model-routing and sub-agent evidence",
    },
    "smoke-pi-routed": {
      name: "Smoke Pi Routed", goal: "Route Pi main inference to GPT and actually execute both declared cross-family subagents.",
      acceptance: "Actual allowed gpt-5.6-luna main routing and successful single Haiku /v1/messages and GPT-mini /responses delegations satisfy the exact protected proxy/session conjunction.",
      metricLabel: "Verified Pi routing and delegation", gateName: "Assert model-routing and sub-agent evidence",
    },
    "smoke-pi-routed-claude": {
      name: "Smoke Pi Routed Claude", goal: "Route Pi to the declared Claude main model under robust-mode policy.",
      acceptance: "Actual claude-sonnet-5 main inference on /v1/messages, routing/classification evidence and configured robust-mode/reasoning-effort policy satisfy the protected gate.",
      metricLabel: "Verified Pi Claude routing", gateName: "Assert model-routing evidence",
    },
    "smoke-copilot-routed-steering": {
      name: "Smoke Copilot Routed Steering", goal: "Deliver correlated AI-credit steering and finish routed work below its declared budget.",
      acceptance: "Partial facet: the source-defined host establishes routing, a correlated 80-percent credit notice reaching the main session, valid nonduplicate thresholds and successful below-seven-credit completion.",
      metricLabel: "Verified credit-steering assessments", gateName: "Assert model-routing and steering evidence",
      limitations: ["Correlated notice and below-budget completion do not independently prove the absence of every post-notice task command. The full prompt's immediate-stop behavior remains separate."],
    },
  };
  for (const [id, { gateName, ...intent }] of Object.entries(additionalRouting)) {
    cases[id] = { ...intent, unit: "routing proofs",
      gates: [{ job: "agent", name: gateName, meaning: intent.acceptance }],
      checkers: routing, runtimeTrees: ["actions", ".github/workflows/shared"],
      limitations: intent.limitations ?? ["Issue reports and trivial task answers are not native routing or delegation evidence."] };
  }
  mkdirSync(directory, { recursive: true });
  const contracts = [];
  for (const [workflowId, intent] of Object.entries(cases)) {
    const sourcePath = `.github/workflows/${workflowId}.md`, execution = sourcePath.replace(/\.md$/, ".lock.yml");
    const additions = git(["log", "--first-parent", "--diff-filter=A", "--format=%H", revision, "--", sourcePath]).split("\n");
    if (additions.length !== 1 || !/^[a-f0-9]{40}$/.test(additions[0])) throw new Error("Ambiguous host workflow adoption");
    const commit = additions[0], parent = git(["rev-parse", `${commit}^`]);
    for (const file of [sourcePath, execution]) {
      if (git(["diff-tree", "--no-commit-id", "--name-status", "-r", parent, commit, "--", file]) !== `A\t${file}`) {
        throw new Error("Host workflow adoption is not a true source/lock addition");
      }
    }
    const date = commit => new Date(git(["show", "-s", "--format=%cI", commit])).toISOString().replace(".000Z", "Z");
    const locked = parse(show(execution)), dependencies = new Map();
    const assets = new Set(intent.assets ?? []);
    const pending = [...intent.checkers, ...assets, ...(intent.runtimeTrees ? [".github/aw/engines.json"] : [])];
    let decodedBytes = 0;
    while (pending.length) {
      const file = pending.pop();
      if (dependencies.has(file)) continue;
      if (!tree.has(file) || dependencies.size >= 150) throw new Error("Unresolved or over-budget checker dependency");
      const text = show(file);
      decodedBytes += Buffer.byteLength(text);
      if (decodedBytes > 8 * 1024 * 1024) throw new Error("Checker dependency byte budget exhausted");
      dependencies.set(file, { path: file, gitBlob: git(["rev-parse", `${revision}:${file}`]), text });
      if (assets.has(file) || !/\.(?:c?js)$/.test(file) || intent.runtimeTrees) continue;
      for (const requested of localCheckerDependencies(text, file.endsWith(".cjs") ? "commonjs" : "module")) {
        if (builtins.has(requested)) continue;
        if (!requested.startsWith(".")) throw new Error(`Unpinned external checker dependency: ${requested}`);
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), requested));
        const resolved = [base, `${base}.js`, `${base}.json`, `${base}/index.js`].find(candidate => tree.has(candidate));
        if (!resolved || resolved.startsWith("../")) throw new Error("Unresolved local checker dependency");
        pending.push(resolved);
      }
    }
    const jobs = Object.fromEntries([...new Set([...intent.gates.map(gate => gate.job), ...(intent.sourceJobs ?? [])])].map(id => {
      const job = locked.jobs[id];
      if (!job || job.container || job["continue-on-error"]
        || !["ubuntu-latest", ...(id === "activation" ? ["ubuntu-slim"] : [])].includes(job["runs-on"])
        || !Array.isArray(job.steps)) throw new Error("Untrusted native assertion job");
      for (const gate of intent.gates.filter(gate => gate.job === id)) {
        const steps = job.steps.filter(step => step.name === gate.name);
        if (steps.length !== 1 || steps[0]["continue-on-error"]) throw new Error("No unique fail-closed native gate");
      }
      return [id, { name: job.name ?? id, sha256: censusDigest(job) }];
    }));
    for (const gate of intent.gates.filter(gate => gate.experiment)) {
      const selector = locked.jobs[gate.experiment.job].steps.filter(step => step.name === gate.experiment.step);
      if (selector.length !== 1 || selector[0]["continue-on-error"]
        || censusDigest(JSON.parse(selector[0].env.GH_AW_EXPERIMENT_SPEC)[gate.experiment.name].variants) !== censusDigest(gate.experiment.variants)) {
        throw new Error("Experiment policy is not bound to its protected selector");
      }
      const assertion = locked.jobs[gate.job].steps.find(step => step.name === gate.name);
      if (assertion.env.SMOKE_VARIANT !== `\${{ needs.${gate.experiment.job}.outputs.${gate.experiment.name} }}`) {
        throw new Error("Native assertion does not consume the protected experiment assignment");
      }
    }
    const { checkers: _, runtimeTrees: trees, ...semantics } = intent;
    const contract = { repository, repositoryId: 1036865607, workflowId, sourceRevision: revision,
      until: "2026-10-18T15:00:12Z", sourceGitBlob: git(["rev-parse", `${revision}:${sourcePath}`]),
      interpreterSha256: sha("scripts/native-host-assertion-value.mjs"), ...semantics, jobs,
      adoption: { commit, adoptedAt: date(commit), baselineCommit: parent, baselineAt: date(parent) },
      dependencies: [...dependencies.values()].map(({ path, gitBlob }) => ({ path, gitBlob })),
      ...(trees ? { runtimeTrees: trees.map(file => ({ path: file, gitTree: git(["rev-parse", `${revision}:${file}`]) })) } : {}) };
    const historicalSources = [];
    const gooseHistory = extendReviewedGooseHistory && workflowId === "smoke-goose";
    const subagentHistory = workflowId === "smoke-copilot-sub-agents";
    if (extendReviewedRoutingHistory && intent.checkers === routing || gooseHistory || subagentHistory) {
      const profiles = gooseHistory ? [{
        revision: "e6b87a4f169c7d194aa5f862f9b6e983ad11d3ae",
        review: "The protected smoke conjunction differs only in its declared checksum-verified Goose pin (1.53.0 versus 1.54.0). Raw native GitHub MCP request/response correlation and independent merged-PR reads are identical. The older parser has weaker metadata, tool-exit and error preservation; this receipt does not establish error-free sessions, corrected parser semantics, full compilation correctness or current-version capability.",
      }] : [{
        revision: "463762fe9304d5271356803513f158cf59dc0171",
        review: "Reviewed differences: read-only artifact export paths, Copilot CLI minimum-version configuration, and Pi model-alias/error-reporting integration. The session merger's added model.resolution events do not satisfy routing assertions.",
      }];
      if (subagentHistory) profiles.push({ revision: "8c05fd87e12f5fd7fe5c67cdfedc3ef8441719e1",
        review: "The experiment source, positive/negative-control assertion and protected variant selector are identical. Added model-resolution metadata cannot substitute for actual named invocations, completions and proxy requests; full historical runtime profiles remain pinned." });
      if (subagentHistory && extendReviewedSubagentHistory) profiles.push({
        revision: "be0e33171bcc34182727c2001c624a2850808f2d",
        review: "Workflow intent, variant-selector host step and complete native subagent assertion are identical. The historical picker reads state JSONL directly rather than through the later iterator; its logged assignment schema is unchanged. Historical session merging lacks later model-resolution/job-timing metadata and uses direct JSONL reads. SDK completion and named invocation evidence plus actual successful model/endpoint requests remain required. Copilot 1.0.96, AWF 0.28.57, MCPG 0.4.31 and their complete runtime trees are historical profiles, not certification of current versions or all parser guarantees.",
      });
      if (["smoke-copilot-routed-claude", "smoke-copilot-sdk-routed-claude", "smoke-copilot-routed-steering"].includes(workflowId)) {
        profiles.push({ revision: "8c05fd87e12f5fd7fe5c67cdfedc3ef8441719e1",
          review: "Earlier scheduled runtime uses different AWF, MCP gateway and execution image versions. Native routing assertions and session parser are unchanged; session-payload model metadata does not establish proof. These are observed native predicates at that runtime version, not proof of equivalent overall engine behavior." });
      }
      if (workflowId === "smoke-pi-routed-claude") {
        profiles.push({ revision: "2ba9099602d4b03301f48363aebf902abe2606c0",
          review: "Protected job, checker and session parser are unchanged. Later setup adds work-queue and safe-output delivery/report modules; those modules cannot satisfy the native routing assertion." });
      }
      contract.historicalSourceProfiles = [];
      for (const { revision: historical, review } of profiles) {
        const historicalLock = git(["rev-parse", `${historical}:${execution}`]);
        const history = git(["log", "--first-parent", `--find-object=${historicalLock}`,
          "--format=%H", revision, "--", execution]).split("\n").filter(Boolean);
        if (!history.some(commit => git(["rev-parse", `${commit}:${execution}`]) === historicalLock)
          || date(historical) >= contract.until) throw new Error("Historical routing lock is not from frozen mainline history");
        const historicalSource = git(["show", `${historical}:${sourcePath}`]);
        if (gooseHistory
          ? historicalSource.replace('verified Goose 1.53.0"', 'verified Goose 1.54.0"') !== show(sourcePath)
          : git(["rev-parse", `${historical}:${sourcePath}`]) !== contract.sourceGitBlob) {
          throw new Error("Reviewed native source intent changed");
        }
        const previous = parse(git(["show", `${historical}:${execution}`]));
        for (const gate of contract.gates) {
          const step = workflow => workflow.jobs[gate.job]?.steps?.find(step => step.name === gate.name);
          const historicalStep = structuredClone(step(previous));
          if (gooseHistory) historicalStep.with.script = historicalStep.with.script.replace('verified Goose 1.53.0"', 'verified Goose 1.54.0"');
          if (censusDigest(historicalStep) !== censusDigest(step(locked))) throw new Error("Reviewed native assertion changed");
          if (gate.experiment) {
            const selector = workflow => workflow.jobs[gate.experiment.job]?.steps?.find(step => step.name === gate.experiment.step);
            if (censusDigest(selector(previous)) !== censusDigest(selector(locked))) throw new Error("Reviewed protected experiment selector changed");
          }
        }
        const historicalDependencies = contract.dependencies.map(dependency => {
          const gitBlob = git(["rev-parse", `${historical}:${dependency.path}`]);
          const reviewedOldPicker = subagentHistory && extendReviewedSubagentHistory
            && historical === "be0e33171bcc34182727c2001c624a2850808f2d"
            && dependency.path === "actions/setup/js/pick_experiment.cjs"
            && gitBlob === "2404f5ce2fd9a8a60e18d3e3322c8a07e96a4ebd";
          if (gitBlob !== dependency.gitBlob && !reviewedOldPicker
            && !(gooseHistory && dependency.path === "actions/setup/js/parse_goose_log.cjs"
              && gitBlob === "c265f0be65a88bcd6fef3b3de39c55a61f5ae454")) {
            throw new Error("Reviewed routing predicate or engine catalog changed");
          }
          return { ...dependency, gitBlob };
        });
        contract.historicalSourceProfiles.push({
          sourceRevision: historical,
          jobs: Object.fromEntries(Object.keys(jobs).map(id => [id, {
            name: previous.jobs[id].name ?? id, sha256: censusDigest(previous.jobs[id]),
          }])),
          dependencies: historicalDependencies,
          runtimeTrees: trees.map(file => ({ path: file, gitTree: git(["rev-parse", `${historical}:${file}`]) })),
          review: `${gooseHistory ? "Source intent and native MCP predicates are preserved across the declared runtime pin change." : "Source intent and native predicate steps are identical."} ${review} Historical runtime trees remain pinned as complete profiles, never mixed with current jobs.`,
        });
        historicalSources.push(...[sourcePath, execution, "actions/setup/js/unified_session.cjs",
          ...(subagentHistory && extendReviewedSubagentHistory ? ["actions/setup/js/pick_experiment.cjs"] : []),
          ...(gooseHistory ? ["actions/setup/js/parse_goose_log.cjs", ".github/workflows/shared/goose.md"] : [])].map(file => ({
          revision: historical, path: file, gitBlob: git(["rev-parse", `${historical}:${file}`]),
          text: git(["show", `${historical}:${file}`]),
        })));
      }
    }
    const receipt = { workflowId, revision, adoption: contract.adoption,
      sources: [sourcePath, execution].map(file => ({ path: file, gitBlob: git(["rev-parse", `${revision}:${file}`]), text: show(file) })),
      checkerDependencies: [...dependencies.values()], runtimeTrees: contract.runtimeTrees ?? [],
      ...(historicalSources.length ? { historicalSources } : {}) };
    const target = `docs/operational-value/proof/functions/${workflowId}.mjs`;
    const factory = `hostAssertionModule(${JSON.stringify(contract, null, 2)})`;
    const identities = [];
    if (contract.historicalSourceProfiles) identities.push(
      `sourceProfilesSha256: "${censusDigest([contract.jobs, contract.dependencies, contract.runtimeTrees, contract.historicalSourceProfiles])}"`);
    if (contract.conditionOracleSha256) identities.push(
      `conditionPolicySha256: "${censusDigest([contract.gates, contract.conditionOracleSha256,
        ...(contract.conditionJobOracleSha256 ? [contract.conditionJobOracleSha256] : [])])}"`);
    const declaration = identities.length
      ? `const value = ${factory};\nexport const { collectBatch, scoreMetric } = value;\nexport const definition = { ...value.definition, evidence: { ...value.definition.evidence,\n  ${identities.join(",\n  ")} } };\n`
      : `export const { definition, collectBatch, scoreMetric } = ${factory};\n`;
    const module = `import { hostAssertionModule } from "../../../../scripts/native-host-assertion-value.mjs";\n\n${declaration}`;
    if (existsSync(target) && readFileSync(target, "utf8") !== module) {
      const previous = readCensusJson(`${directory}/contracts.json`).find(row => row.workflowId === workflowId);
      const { historicalSourceProfiles: _, ...unchanged } = contract;
      const { historicalSourceProfiles: priorProfiles = [], ...previousBase } = previous ?? {};
      const sameBase = censusDigest(previousBase) === censusDigest(unchanged);
      const { acceptance: oldAcceptance, limitations: oldLimitations, ...oldScope } = previousBase;
      const { acceptance, limitations, ...scope } = unchanged;
      const reviewedGooseExtension = gooseHistory
        && oldAcceptance?.replace("Goose 1.54.0", "source-declared Goose") === acceptance
        && censusDigest(oldScope) === censusDigest(scope)
        && oldLimitations?.every(limitation => limitations.includes(limitation));
      const { conditionJobOracleSha256: oldJobOracle, ...oldConditionScope } = previousBase;
      const { conditionJobOracleSha256: jobOracle, ...conditionScope } = unchanged;
      const reviewedConditionalExtension = subagentHistory && extendReviewedSubagentHistory
        && oldJobOracle === undefined && jobOracle === sha("scripts/protected-experiment-job-log.mjs")
        && censusDigest(oldConditionScope) === censusDigest(conditionScope);
      if (!(extendReviewedRoutingHistory || gooseHistory || subagentHistory && extendReviewedSubagentHistory)
        || !previous || !(sameBase || reviewedGooseExtension || reviewedConditionalExtension)
        || priorProfiles.some(profile => !contract.historicalSourceProfiles.some(row => censusDigest(row) === censusDigest(profile)))) {
        throw new Error(`Refusing to change frozen host assertion function: ${workflowId}`);
      }
      archiveHostContract(directory, previous, target, censusDigest(previous) !== censusDigest(contract));
    }
    writeCensusJson(`${directory}/${workflowId}-sources.json.gz`, receipt);
    writeFileSync(target, module);
    contracts.push(contract);
  }
  writeCensusJson(`${directory}/contracts.json`, contracts);
  return contracts.map(({ workflowId, dependencies }) => ({ workflowId, dependencies: dependencies.length }));
}

if (process.argv[1] === import.meta.filename) {
  const routingFlag = "--extend-reviewed-routing-history", gooseFlag = "--extend-reviewed-goose-history";
  const subagentFlag = "--extend-reviewed-subagent-history";
  const flags = process.argv.slice(3);
  if (!process.argv[2] || flags.some(flag => ![routingFlag, gooseFlag, subagentFlag].includes(flag)) || new Set(flags).size !== flags.length) {
    throw new Error(`usage: author-host-assertion-functions.mjs BARE_GIT_CACHE [${routingFlag}] [${gooseFlag}] [${subagentFlag}]`);
  }
  console.log(JSON.stringify(authorHostAssertionFunctions(process.argv[2], flags.includes(routingFlag),
    flags.includes(gooseFlag), flags.includes(subagentFlag))));
}
