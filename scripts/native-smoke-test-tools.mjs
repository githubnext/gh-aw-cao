import { smokeToolsContract as contract } from "./smoke-test-tools-contract.mjs";
import { censusDigest } from "./operational-value-census-io.mjs";

const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function protectedExecutionLineMatches(expected, actual) {
  return expected === actual
    || expected === 'GH_AW_MAX_AI_CREDITS="${{ vars.GH_AW_DEFAULT_MAX_AI_CREDITS || \'1000\' }}"'
      && /^GH_AW_MAX_AI_CREDITS="[0-9]+"$/.test(actual ?? "");
}

export function literalShellWords(text) {
  if (typeof text !== "string" || text.length > 65536) return null;
  const words = [];
  let word = "", state = "bare", present = false;
  for (let position = 0; position < text.length; position++) {
    const char = text[position];
    if (state === "single") {
      if (char === "'") state = "bare"; else word += char;
    } else if (state === "double") {
      if (char === '"') state = "bare";
      else if (char === "\\" && /[$`"\\\n]/.test(text[position + 1] ?? "")) word += text[++position];
      else if (char === "$" || char === "`") return null;
      else word += char;
    } else if (/\s/.test(char)) {
      if (present) { words.push(word); word = ""; present = false; }
    } else {
      present = true;
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "\\") {
        if (position + 1 >= text.length) return null;
        word += text[++position];
      } else if (/[$`;&|<>()]/.test(char)) return null;
      else word += char;
    }
  }
  if (state !== "bare") return null;
  if (present) words.push(word);
  return words;
}

export function unwrapNativeShell(command) {
  const words = literalShellWords(command);
  if (words?.length === 3 && /^(?:\/(?:usr\/)?bin\/)?bash$/.test(words[0]) && ["-lc", "-c"].includes(words[1])) return words[2];
  return command;
}

export function nativeToolCommand(command) {
  if (typeof command !== "string" || command.length > 8192) return null;
  command = unwrapNativeShell(command);
  const parts = command.trim().split(/\s*(?:;|&&|\n)\s*/).filter(Boolean);
  const selected = [];
  for (const part of parts) {
    const normalized = part.replace(/\s+2>&1(?=\s|$)/g, "")
      .replace(/\s*\|\s*head -n ?2\s*\|\s*tail -n ?1\s*$/, "")
      .replace(/\s*\|\s*(?:\/(?:usr\/)?bin\/)?head (?:-n ?[12]|-1)\s*$/, "")
      .replace(/^\/opt\/hostedtoolcache\/node\/[0-9]+\.[0-9]+\.[0-9]+\/(?:x64|arm64)\/bin\/node /, "node ")
      .replace(/^\/(?:usr\/(?:local\/)?)?bin\//, "").trim();
    const tool = contract.tools.find(tool => tool.commands.includes(normalized));
    if (!tool || selected.includes(tool.id)) return null;
    selected.push(tool.id);
  }
  return selected.length ? selected : null;
}

export function toolOutputMatches(toolId, output) {
  const tool = contract.tools.find(tool => tool.id === toolId);
  if (!tool || typeof output !== "string" || output.length > 1024 * 1024) return false;
  return new RegExp(tool.output, "m").test(output);
}

export function reviewedLiteralToolLoop(command, output) {
  if (typeof command !== "string" || typeof output !== "string") return [];
  const match = command.match(/^set \+e\ncount=0\nprintf '%s\\n' '## Agent Container Tool Check'\nprintf '%-8s \| %s \| %s\\n' 'Tool' 'Status' 'Version'\nprintf '%-8s \| %s \| %s\\n' '----' '------' '-------'\nfor spec in \\\n([\s\S]+?); do\n([\s\S]+?)\ndone\n/);
  if (!match) return [];
  const expectedBody = `  IFS='|' read -r name cmd <<< "$spec"
  out=$(eval "$cmd" 2>&1)
  if [ $? -eq 0 ] && [ -n "$out" ]; then
    printf '%-8s | ✅ | %s\\n' "$name" "$out"
    count=$((count + 1))
  else
    printf '%-8s | ❌ | %s\\n' "$name" "$out"
  fi`;
  if (match[2] !== expectedBody) return [];
  const specifications = match[1].split(/ \\\n/).map(line => line.trim());
  const bound = [];
  for (const spec of specifications) {
    const literal = spec.match(/^'([a-z0-9]+)\|([^'\n]+)'$/);
    if (!literal || bound.some(row => row.toolId === literal[1])) return [];
    const tools = nativeToolCommand(literal[2]);
    if (tools?.length === 1 && tools[0] === literal[1]) bound.push({ toolId: literal[1], command: literal[2] });
    else bound.push({ toolId: literal[1], command: null });
  }
  if (bound.length !== contract.tools.length || !contract.tools.every(tool => bound.some(row => row.toolId === tool.id))) return [];
  const lines = output.split(/\r?\n/);
  if (lines[0] !== "## Agent Container Tool Check" || lines[1] !== "Tool     | Status | Version"
    || lines[2] !== "----     | ------ | -------") return [];
  const results = [];
  for (const [position, row] of bound.entries()) {
    const outputRow = lines[position + 3]?.match(/^([a-z0-9]+) +\| (✅|❌) \| (.*)$/);
    if (!outputRow || outputRow[1] !== row.toolId) return [];
    if (row.command && outputRow[2] === "✅" && toolOutputMatches(row.toolId, outputRow[3])) {
      results.push({ toolId: row.toolId, command: row.command, nativeOutput: outputRow[3] });
    }
  }
  return results;
}

function closedExecutableBranches(expression, toolId) {
  if (nativeToolCommand(expression)?.join() === toolId) return [expression];
  let remaining = expression;
  const commands = [];
  for (let position = 0; position < 16; position++) {
    const branch = remaining.match(/^(?:if|elif) \[ -x ([/A-Za-z0-9_.-]+) \]; then (.+?); /);
    if (!branch || !branch[2].startsWith(`${branch[1]} `) || nativeToolCommand(branch[2])?.join() !== toolId) return null;
    commands.push(branch[2]);
    remaining = remaining.slice(branch[0].length);
    if (remaining === "else echo 'MISSING'; fi") return commands;
  }
  return null;
}

export function reviewedMarkedToolBatch(command, output, completed = true) {
  command = unwrapNativeShell(command);
  if (typeof command !== "string" || typeof output !== "string") return [];
  const body = command.replace(/^cd \/workspace && /, "");
  const pieces = body.split(/ && echo '== ([a-z0-9]+) ==' && /);
  const first = pieces[0].match(/^echo '== ([a-z0-9]+) ==' && (.*)$/s);
  if (!first) return [];
  const entries = [{ toolId: first[1], expression: first[2] }];
  for (let position = 1; position < pieces.length; position += 2) entries.push({ toolId: pieces[position], expression: pieces[position + 1] });
  if (entries.length !== 12 || !contract.tools.every(tool => entries.filter(row => row.toolId === tool.id).length === 1)) return [];
  const results = [];
  for (const [position, entry] of entries.entries()) {
    const guarded = entry.expression.match(/^\((.+) \|\| true\)$/s);
    const invocation = guarded?.[1] ?? entry.expression;
    const branches = closedExecutableBranches(invocation, entry.toolId);
    if (!branches) return [];
    const marker = `== ${entry.toolId} ==\n`;
    const expectedOffset = output.indexOf(marker);
    if (expectedOffset < 0) break;
    if (output.indexOf(marker, expectedOffset + marker.length) >= 0) return [];
    const next = position + 1 < entries.length ? output.indexOf(`== ${entries[position + 1].toolId} ==\n`, expectedOffset + marker.length) : -1;
    const end = next < 0 ? output.length : next;
    const nativeOutput = output.slice(expectedOffset + marker.length, end).split(/\r?\n/)
      .find(line => toolOutputMatches(entry.toolId, line));
    if (nativeOutput && (completed || next >= 0 && !guarded)) {
      results.push({ toolId: entry.toolId, command: branches[0], nativeOutput,
        possibleCommands: branches, successProven: completed || next >= 0 });
    }
  }
  return results;
}

// These complete scripts were reviewed as programs, not accepted from their printed status labels.
const reviewedBatchScripts = new Map([
  ["df9f74c5f8958fb5feb7ed1153d40e83d420fac08995f59482a9f92b8ea919cc", "printf-sections"],
  ["96ac3b0e06386fb1a27ce9450082cfb5f121d9f9642b64b9d4b97d296fe591ae", "exit-status-loop"],
  ["f8c774683f74607ff04323a8ffdf199d729a5744ad1c28648ef722c0c8c1e725", "case-captured-output"],
  ["32b593eb6fe45b57df5831689019154ea83016b894c03f1bdaa21b29808f7bf8", "case-version-output"],
]);

export function reviewedNativeBatch(command, output) {
  if (typeof command !== "string") return [];
  const kind = reviewedBatchScripts.get(censusDigest(command));
  if (!kind || typeof output !== "string") return [];
  const text = `\n${output}`;
  const results = [];
  const marker = id => kind === "printf-sections" ? `\n${id}:\n`
    : kind === "exit-status-loop" ? `\n## ${id}\n`
      : kind === "case-captured-output" ? `\n${id}|✅|` : `\n== ${id} ==\n`;
  for (const [position, tool] of contract.tools.entries()) {
    const start = text.indexOf(marker(tool.id));
    if (start < 0 || text.indexOf(marker(tool.id), start + marker(tool.id).length) >= 0) return [];
    const next = position + 1 < contract.tools.length ? text.indexOf(marker(contract.tools[position + 1].id), start + marker(tool.id).length) : text.length;
    if (next < 0) return [];
    const section = text.slice(start + marker(tool.id).length, next);
    if (kind === "exit-status-loop" && !/^STATUS=OK$/m.test(section)) continue;
    const invocation = tool.id === "sh" ? kind === "case-version-output"
      ? "sh --version" : "sh -c 'echo ok'"
      : tool.id === "java" && kind === "case-version-output" ? "java -version" : tool.commands[0];
    const nativeOutput = tool.id === "sh" && kind === "case-captured-output" && section.trim() === "available"
      ? "ok" : section.split(/\r?\n/).find(line => toolOutputMatches(tool.id, line));
    if (nativeOutput && toolOutputMatches(tool.id, nativeOutput)) {
      results.push({ toolId: tool.id, command: invocation, nativeOutput,
        successProven: kind === "exit-status-loop", interpretation: kind });
    }
  }
  return results;
}

const reviewedCodexPrograms = new Map([
  ["d224d4a1d75aef8543807ca7a6c82b26f61b02c331780887775c39a1f74514ae", "literal-argv-check-function"],
  ["8110fc419f8621a081684a8ce58aefc8861a85f45c0d00e0de32af9cd4916324", "literal-absolute-command-function"],
  ["ec6ab20b8125df5e34708a87245dda0a4d8ca3756c37b3ef4bce81ac88488621", "guarded-nested-gh-check"],
]);

export function reviewedHistoricalCodexBatch(command, output) {
  if (typeof command !== "string" || typeof output !== "string") return [];
  const kind = reviewedCodexPrograms.get(censusDigest(command));
  if (!kind) return [];
  const results = [];
  for (const tool of contract.tools) {
    const matches = kind === "guarded-nested-gh-check"
      ? tool.id === "gh" ? [...output.matchAll(/^gh: ✅\n  (gh version [^\n]+)$/gm)] : []
      : [...output.matchAll(new RegExp(`^${tool.id}: ${kind === "literal-argv-check-function" ? "PASS \\|" : "✅"} (.*)$`, "gm"))];
    if (matches.length !== 1 || !toolOutputMatches(tool.id, matches[0][1])) continue;
    const executable = kind === "guarded-nested-gh-check" ? "/bin/gh"
      : tool.id === "bash" && kind === "literal-absolute-command-function" ? "/bin/bash"
        : tool.id === "node" && kind === "literal-argv-check-function" ? "/opt/hostedtoolcache/node/24.19.0/x64/bin/node"
          : `/usr/bin/${tool.id}`;
    const invocation = `${executable} ${tool.id === "sh" ? "-c 'echo ok'" : tool.commands[0].split(" ").slice(1).join(" ")}`;
    if (nativeToolCommand(invocation)?.join() !== tool.id) throw new Error("Unreviewed historical native invocation");
    results.push({ toolId: tool.id, command: invocation, nativeOutput: matches[0][1],
      successProven: kind === "guarded-nested-gh-check", interpretation: kind });
  }
  return results;
}

export function parseNativePiToolLog(text, step) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("Invalid bounded native tool log");
  const start = Date.parse(step?.started_at), end = Date.parse(step?.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Missing protected execution interval");
  const calls = new Map(), results = [], rejected = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (\{.*\})$/);
    if (!match) continue;
    const at = Date.parse(match[1]);
    if (at < start || at > end + 1000) continue;
    let event;
    try { event = JSON.parse(match[2]); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (event.type === "tool_execution_start" && event.toolName === "bash") {
      if (typeof event.toolCallId !== "string" || !event.toolCallId || calls.has(event.toolCallId)) throw new Error("Ambiguous native tool call");
      const tools = nativeToolCommand(event.args?.command);
      calls.set(event.toolCallId, { event, tools, at, nativeLineSha256: censusDigest(line), completed: false });
      if (!tools) rejected.push({ toolCallId: event.toolCallId, reason: "Command needs a separately verified literal wrapper or is outside the closed version/function grammar.",
        commandSha256: censusDigest(event.args?.command ?? null) });
    }
    if (event.type !== "tool_execution_end" || event.toolName !== "bash") continue;
    const call = calls.get(event.toolCallId);
    if (!call) continue;
    if (call.completed || at < call.at) throw new Error("Conflicting or out-of-order native tool completion");
    call.completed = true;
    const result = event.result;
    const exitCodes = [result?.exitCode, result?.details?.exitCode, result?.structuredContent?.exitCode].filter(value => value !== undefined);
    const success = event.isError === false && event.error == null && result?.error == null
      && result?.isError !== true && result?.is_error !== true && !["error", "failed"].includes(result?.status)
      && exitCodes.every(code => code === 0);
    const output = Array.isArray(result?.content)
      ? result.content.filter(row => row.type === "text" && typeof row.text === "string").map(row => row.text).join("\n")
      : typeof result?.output === "string" ? result.output : null;
    const literalLoop = [...(success ? reviewedLiteralToolLoop(call.event.args?.command, output) : []),
      ...reviewedMarkedToolBatch(call.event.args?.command, output, success),
      ...[...reviewedNativeBatch(call.event.args?.command, output),
        ...reviewedHistoricalCodexBatch(call.event.args?.command, output)].filter(row => success || row.successProven)];
    if (!call.tools && !literalLoop.length) continue;
    for (const toolId of call.tools ?? literalLoop.map(row => row.toolId)) {
      const loopRow = literalLoop.find(row => row.toolId === toolId);
      const command = loopRow?.command ?? call.event.args.command;
      const nativeOutput = loopRow?.nativeOutput ?? output;
      const valid = (success || loopRow?.successProven === true) && toolOutputMatches(toolId, nativeOutput);
      results.push({ toolId, toolCallId: event.toolCallId, at: match[1],
        passed: valid ? true : toolId !== "sh" && call.tools?.length === 1
          && event.isError === true && exitCodes.includes(127) ? false : null,
        command, commandSha256: censusDigest(command),
        ...(loopRow ? { wrapperSha256: censusDigest(call.event.args.command), wrapper: "closed-static-twelve-tool-batch-v1",
          possibleCommands: loopRow.possibleCommands ?? [command], enclosingCommandSuccess: success,
          successGuard: success ? "native-completion" : "next-and-chain-marker-executed" } : {}),
        startLineSha256: call.nativeLineSha256, endLineSha256: censusDigest(line),
        outputSha256: censusDigest(output), success: success || loopRow?.successProven === true, exitCodes,
        nativeOutput: valid ? nativeOutput.split(/\r?\n/).filter(line => toolOutputMatches(toolId, line)).slice(0, 1) : [],
        reason: valid ? null : "Native completion did not establish recognizable successful output for this tool." });
    }
  }
  return { results, rejected };
}

export function parseNativeCodexToolLog(text, step) {
  const native = [], originals = new Map(), commands = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (\{.*\})$/);
    if (!match) continue;
    let event;
    try { event = JSON.parse(match[2]); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (!["item.started", "item.completed"].includes(event.type) || event.item?.type !== "command_execution") continue;
    const item = event.item;
    if (typeof item.id !== "string" || typeof item.command !== "string") throw new Error("Invalid native Codex command identity");
    const key = `${item.id}:${event.type}`;
    if (originals.has(key)) throw new Error("Duplicate native Codex command event");
    originals.set(key, censusDigest(line));
    if (event.type === "item.started") commands.set(item.id, item.command);
    else if (commands.get(item.id) !== item.command) throw new Error("Native Codex completion command changed");
    const converted = event.type === "item.started"
      ? { type: "tool_execution_start", toolName: "bash", toolCallId: item.id, args: { command: item.command } }
      : { type: "tool_execution_end", toolName: "bash", toolCallId: item.id,
        isError: item.status !== "completed" || item.exit_code !== 0,
        result: { content: [{ type: "text", text: item.aggregated_output }], details: { exitCode: item.exit_code } } };
    native.push(`${match[1]} ${JSON.stringify(converted)}`);
  }
  const parsed = parseNativePiToolLog(native.join("\n"), step);
  for (const result of parsed.results) {
    result.startLineSha256 = originals.get(`${result.toolCallId}:item.started`);
    result.endLineSha256 = originals.get(`${result.toolCallId}:item.completed`);
  }
  return parsed;
}
export function scoreSmokeTools(id, evidence) {
  if (!["observed-tool-proofs", "complete-tool-proofs"].includes(id) || evidence?.valid !== true
    || !Array.isArray(evidence.assessments) || evidence.assessments.length === 0
    || new Set(evidence.assessments.map(row => row?.id)).size !== evidence.assessments.length
    || evidence.assessments.some(row => typeof row?.id !== "string" || !row.id || ![true, false, null].includes(row.passed))) return null;
  if (id === "complete-tool-proofs" && (evidence.unknownEligibility > 0 || evidence.assessments.some(row => row.passed === null))) return null;
  if (!evidence.assessments.some(row => row.passed !== null)) return null;
  return evidence.assessments.filter(row => row.passed === true).length;
}

export function verifyNativeToolReceipt(receipt) {
  if (!receipt || !positive(receipt.runId) || receipt.at >= contract.until
    || !sha256(receipt.logsSha256) || !sha256(receipt.hostStepSha256)
    || !sha256(receipt.sourceProfileSha256) || receipt.sourceBound !== true
    || !Array.isArray(receipt.results)) throw new Error("Unbound native container receipt");
  for (const row of receipt.results) {
    const tools = nativeToolCommand(row.command);
    if (!tools?.includes(row.toolId) || row.commandSha256 !== censusDigest(row.command)
      || ![true, false, null].includes(row.passed) || !sha256(row.startLineSha256) || !sha256(row.endLineSha256)
      || !sha256(row.outputSha256) || !Array.isArray(row.nativeOutput)
      || row.passed === true && (!row.success || !row.nativeOutput.some(output => toolOutputMatches(row.toolId, output)))) {
      throw new Error("Malformed native container tool result");
    }
  }
  return receipt;
}
