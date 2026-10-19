import { createHash } from "node:crypto";

export const repository = "github/gh-aw";
export const repositoryId = 1036865607;
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const workflow = "smoke-service-ports";
export const sourcePath = ".github/workflows/smoke-service-ports.md";
export const sourceBlob = "ca493fccc2f54978d810cf6d93bbdf42dfa89313";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const jsonHash = value => hash(JSON.stringify(value));

export const acceptance = {
  repository, repositoryId, revision, sourcePath, sourceBlob,
  goal: "Verify sandbox host-service-port access to Redis end-to-end.",
  population: "Independent service/client observations of a Redis test session, regardless of actor.",
  endpoint: { host: "host.docker.internal", port: 6379 },
  cases: {
    ping: "Redis PING receives PONG.",
    roundTrip: 'SET smoke_test "service-ports-ok" succeeds and a later GET smoke_test returns exactly service-ports-ok in the same service lifetime.',
    info: "INFO server returns Redis server information.",
  },
  fullAcceptance: "All three cases in one session, with independently observed sandbox-to-host endpoint binding.",
  partialValue: "Each independently demonstrated source-defined case counts once per session, even without full host-bound integration acceptance.",
  persistence: "SET/GET within one service lifetime; no restart, disk durability or cross-run persistence requirement.",
  safeguards: "Keep runtime configuration, service startup, TCP access, protocol facts, boundary proof, telemetry and session artifacts separate.",
  attribution: "A protected run/head/attempt/client/service receipt may link contribution; editable issue markers and agent prose cannot.",
  grain: "Session plus case; one completed operation event, not a persistent-state snapshot.",
  window: { durationDays: 2, cadenceDays: 2, maturationDays: 0 },
  keepPolicy: null,
  costs: "Not measured without matching period-bound usage evidence.",
};

export function verifyBlob(bytes, expected) {
  const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (actual !== expected) throw new Error("Git blob identity mismatch");
  return bytes;
}

export function decodeBase64(value) {
  if (typeof value !== "string" || value.length > 4 * 1024 * 1024) throw new Error("Invalid bounded native bytes");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Noncanonical native base64");
  return bytes;
}

// RESP is byte-framed. Splitting on newlines would accept truncated bulk strings.
export function parseResp(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) throw new Error("Invalid RESP input");
  let at = 0, nodes = 0;
  const line = () => {
    const end = bytes.indexOf("\r\n", at);
    if (end < 0) throw new Error("Truncated RESP line");
    const value = bytes.subarray(at, end).toString("utf8");
    at = end + 2;
    return value;
  };
  const integer = () => {
    const text = line();
    if (!/^-?(?:0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("Invalid RESP integer");
    return Number(text);
  };
  const value = depth => {
    if (++nodes > 4096 || depth > 8 || at >= bytes.length) throw new Error("Invalid RESP structure");
    const kind = String.fromCharCode(bytes[at++]);
    if (kind === "+" || kind === "-") return { kind, value: line() };
    if (kind === ":") return { kind, value: integer() };
    if (kind === "$") {
      const length = integer();
      if (length === -1) return { kind, value: null };
      if (length < 0 || at + length + 2 > bytes.length
        || bytes[at + length] !== 13 || bytes[at + length + 1] !== 10) throw new Error("Invalid RESP bulk length");
      const result = { kind, value: bytes.subarray(at, at + length).toString("utf8") };
      at += length + 2;
      return result;
    }
    if (kind === "*") {
      const count = integer();
      if (count < 0 || count > 1024) throw new Error("Unsupported RESP array");
      return { kind, value: Array.from({ length: count }, () => value(depth + 1)) };
    }
    throw new Error("Unsupported RESP type");
  };
  const result = value(0);
  if (at !== bytes.length) throw new Error("Trailing RESP bytes");
  return result;
}

export function parseExchange(requestBytes, responseBytes) {
  const request = parseResp(requestBytes), response = parseResp(responseBytes);
  if (request.kind !== "*" || request.value.some(x => x.kind !== "$" || x.value === null)) {
    throw new Error("Redis request must be a bulk-string argument array");
  }
  const args = request.value.map(x => x.value);
  const command = args[0]?.toUpperCase();
  const scalar = ["+", "$"].includes(response.kind) ? response.value : null;
  if (command === "PING" && args.length === 1) {
    return { case: "ping", passed: scalar === "PONG", responseType: response.kind };
  }
  if (command === "SET" && args.length === 3 && args[1] === "smoke_test" && args[2] === "service-ports-ok") {
    return { case: "set", passed: response.kind === "+" && scalar === "OK", responseType: response.kind };
  }
  if (command === "GET" && args.length === 2 && args[1] === "smoke_test") {
    return { case: "get", passed: response.kind === "$" && scalar === "service-ports-ok", responseType: response.kind };
  }
  if (command === "INFO" && args.length === 2 && args[1].toLowerCase() === "server") {
    return { case: "info", passed: response.kind === "$" && typeof scalar === "string"
      && /^# Server\r?$/m.test(scalar) && /^redis_version:\d+\.\d+\.\d+[^\r\n]*\r?$/m.test(scalar),
    responseType: response.kind };
  }
  throw new Error("Request is outside the frozen Redis cases");
}

export function parseCliOperation(args, stdout, exitCode) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")
    || !Buffer.isBuffer(stdout) || stdout.length > 1024 * 1024
    || !Number.isSafeInteger(exitCode)) throw new Error("Invalid raw Redis CLI observation");
  const [executable, hostFlag, host, portFlag, port, ...command] = args;
  if (executable !== "redis-cli" || hostFlag !== "-h" || host !== "host.docker.internal"
    || portFlag !== "-p" || port !== "6379") throw new Error("CLI request outside source endpoint");
  const text = stdout.toString("utf8").replace(/\r?\n$/, "");
  const verb = command[0]?.toUpperCase();
  const noError = exitCode === 0;
  if (verb === "PING" && command.length === 1) return { case: "ping", passed: noError && text === "PONG" };
  if (verb === "SET" && command.length === 3 && command[1] === "smoke_test" && command[2] === "service-ports-ok") {
    return { case: "set", passed: noError && text === "OK" };
  }
  if (verb === "GET" && command.length === 2 && command[1] === "smoke_test") {
    return { case: "get", passed: noError && text === "service-ports-ok" };
  }
  if (verb === "INFO" && command.length === 2 && command[1].toLowerCase() === "server") {
    return { case: "info", passed: noError && /^# Server\r?$/m.test(text)
      && /^redis_version:\d+\.\d+\.\d+[^\r\n]*\r?$/m.test(text) };
  }
  throw new Error("CLI command outside frozen Redis cases");
}

const wireRequests = {
  PING: "*1\\r\\n$4\\r\\nPING\\r\\n",
  SET: "*3\\r\\n$3\\r\\nSET\\r\\n$10\\r\\nsmoke_test\\r\\n$16\\r\\nservice-ports-ok\\r\\n",
  GET: "*2\\r\\n$3\\r\\nGET\\r\\n$10\\r\\nsmoke_test\\r\\n",
  INFO: "*2\\r\\n$4\\r\\nINFO\\r\\n$6\\r\\nserver\\r\\n",
};
export const ncBatchCommand = `set +e\n${Object.entries(wireRequests).map(([name, request]) =>
  `${name}_OUT=$(printf '${request}' | nc -w 3 host.docker.internal 6379 2>&1)\n${name}_CODE=$?\n`).join("")}`
  + `printf 'PING_CODE=%s\\nPING_OUT=%s\\n' "$PING_CODE" "$PING_OUT"\n`
  + `printf 'SET_CODE=%s\\nSET_OUT=%s\\n' "$SET_CODE" "$SET_OUT"\n`
  + `printf 'GET_CODE=%s\\nGET_OUT=%s\\n' "$GET_CODE" "$GET_OUT"\n`
  + `printf 'INFO_CODE=%s\\nINFO_OUT_HEAD=%s\\n' "$INFO_CODE" "$(echo "$INFO_OUT" | head -5)"\n`;

export function parseNcBatch(command, output) {
  if (command !== ncBatchCommand || typeof output !== "string" || Buffer.byteLength(output) > 1024 * 1024) {
    throw new Error("Unsupported native Redis request script; never execute or infer its meaning");
  }
  const match = output.match(/^PING_CODE=(\d+)\nPING_OUT=([\s\S]*?)SET_CODE=(\d+)\nSET_OUT=([\s\S]*?)GET_CODE=(\d+)\nGET_OUT=([\s\S]*?)INFO_CODE=(\d+)\nINFO_OUT_HEAD=([\s\S]*)$/);
  if (!match) throw new Error("Malformed native Redis output envelope");
  const parsed = ["PING", "SET", "GET"].map((name, i) => {
    const request = Buffer.from(wireRequests[name].replaceAll("\\r", "\r").replaceAll("\\n", "\n"));
    const response = Buffer.from(match[i * 2 + 2]);
    const result = parseExchange(request, response);
    return { ...result, passed: match[i * 2 + 1] === "0" && result.passed,
      request: request.toString("base64"), response: response.toString("base64") };
  });
  const infoPrefix = match[8];
  const infoFrame = infoPrefix.match(/^\$([1-9]\d*)\r\n/);
  const info = /^\$([1-9]\d*)\r\n# Server\r\nredis_version:\d+\.\d+\.\d+[^\r\n]*\r\n/.test(infoPrefix)
    && Number.isSafeInteger(Number(infoFrame[1]))
    && Number(infoFrame[1]) >= Buffer.byteLength(infoPrefix.slice(infoFrame[0].length))
    && infoPrefix.split("\n").filter(Boolean).length <= 5;
  return {
    claimedEndpoint: acceptance.endpoint,
    cases: { ping: parsed[0].passed, roundTrip: parsed[1].passed && parsed[2].passed,
      info: match[7] === "0" && info },
    exchanges: parsed,
    info: { passed: match[7] === "0" && info, prefix: Buffer.from(infoPrefix).toString("base64"),
      projection: "Source requires INFO server | head -5; this is a prefix, not a reconstructed complete RESP bulk string." },
  };
}

export function parsePiTranscript(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Invalid bounded native transcript");
  const starts = new Map(), completed = new Set(), observations = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.startsWith("{")) continue;
    const row = JSON.parse(line);
    if (row.type === "tool_execution_start" && row.toolName === "bash") {
      if (starts.has(row.toolCallId)) throw new Error("Repeated native tool start");
      starts.set(row.toolCallId, { row, index });
    }
    if (row.type !== "tool_execution_end" || row.toolName !== "bash") continue;
    const start = starts.get(row.toolCallId);
    if (!start || start.row.args?.command !== ncBatchCommand) continue;
    if (completed.has(row.toolCallId)) throw new Error("Repeated native tool completion");
    completed.add(row.toolCallId);
    const structured = row.result?.structuredContent;
    if (row.isError !== false || structured?.truncated !== false || structured.exit_code !== 0
      || !Array.isArray(row.result.content) || row.result.content.length !== 1
      || row.result.content[0].type !== "text" || structured.output !== row.result.content[0].text) {
      throw new Error("Incomplete or conflicting native tool result");
    }
    observations.push({
      toolCallId: row.toolCallId, startLine: start.index + 1, endLine: index + 1,
      commandSha256: hash(start.row.args.command), outputSha256: hash(structured.output),
      native: parseNcBatch(start.row.args.command, structured.output),
      rawStart: lineAt(text, start.index), rawEnd: line,
      authentication: "Protocol facts parsed; independent protected producer corroboration must be established separately.",
    });
  }
  return observations;
}

function lineAt(text, index) {
  return text.split("\n")[index];
}

export function verifyProtectedRedis(candidate, protectedInputs) {
  const content = member => {
    const bytes = decodeBase64(member.content);
    if (bytes.length !== member.bytes || hash(bytes) !== member.sha256) throw new Error("Retained ZIP member changed");
    return bytes.toString("utf8");
  };
  const inputJson = (inputs, endpoint) => {
    const matches = inputs.filter(row => row.receipt.endpoint === endpoint);
    if (matches.length !== 1) throw new Error("Missing or ambiguous original provider response");
    const input = matches[0], bytes = decodeBase64(input.content);
    if (hash(bytes) !== (input.receipt.sha256 ?? input.receipt.bodySha256)) throw new Error("Original provider response changed");
    return JSON.parse(bytes);
  };
  const run = inputJson(candidate.inputs, "repos/github/gh-aw/actions/runs/38987730359");
  const inventory = inputJson(candidate.inputs, "repos/github/gh-aw/actions/runs/38987730359/artifacts?per_page=100");
  const jobs = inputJson(protectedInputs.inputs, "repos/github/gh-aw/actions/runs/38987730359/attempts/1/jobs?per_page=100");
  if (run.id !== 38987730359 || run.run_attempt !== 1 || run.repository.id !== repositoryId
    || run.head_sha !== "7597eb9ca2da8362f551d4bc74cb9113835b16f8"
    || run.path !== ".github/workflows/smoke-service-ports.lock.yml"
    || jobs.total_count !== jobs.jobs.length || inventory.total_count !== inventory.artifacts.length) {
    throw new Error("Run/head/attempt/provider population mismatch");
  }
  const job = jobs.jobs.find(row => row.id === 117263197566 && row.name === "agent");
  const step = job?.steps.find(row => row.name === "Execute Pi CLI");
  if (!job || job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha
    || !step || step.status !== "completed") throw new Error("Protected client execution identity unavailable");
  const artifact = inventory.artifacts.find(row => row.id === 12084001298 && row.name === "agent");
  const artifactZip = candidate.inputs.find(row => row.receipt.endpoint === "repos/github/gh-aw/actions/artifacts/12084001298/zip");
  if (!artifact || artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha
    || artifact.digest !== `sha256:${hash(decodeBase64(artifactZip.content))}`) throw new Error("Native artifact provider binding mismatch");
  const source = protectedInputs.sourceBytes ? decodeBase64(protectedInputs.sourceBytes) : null;
  if (source) verifyBlob(source, "47ce50ac9931c8d9960f2fae8b88dae6e00c2ecf");
  const text = source?.toString("utf8") ?? "";
  const agentBlock = text.slice(text.indexOf("\n  agent:\n"), text.indexOf("\n  check_token_telemetry:\n"));
  const compiledBoundary = agentBlock.includes("image: redis:7") && agentBlock.includes("- 6379:6379")
    && agentBlock.includes('--allow-host-service-ports "${{ job.services[\'redis\'].ports[\'6379\'] }}"')
    && agentBlock.includes("--legacy-security --enable-host-access") && agentBlock.includes('name: Execute Pi CLI');
  const log = content(protectedInputs.logMembers.find(row => row.file === "4_agent.txt"));
  const system = content(protectedInputs.logMembers.find(row => row.file === "agent/system.txt"));
  if (!system.includes(`Job defined at: github/gh-aw/${run.path}@refs/heads/main`)
    || !system.includes(job.runner_name)
    || !log.includes(`Artifact agent successfully finalized. Artifact ID ${artifact.id}`)
    || !log.includes(`SHA256 digest of uploaded artifact is ${artifact.digest.slice(7)}`)) {
    throw new Error("Independent protected upload/job receipt mismatch");
  }
  const lines = log.split("\n").flatMap((line, index) => {
    const match = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) (.*)$/);
    return match ? [{ timestamp: match[1], text: match[2], line: index + 1 }] : [];
  });
  const inStep = row => Date.parse(row.timestamp) >= Date.parse(step.started_at)
    && Date.parse(row.timestamp) < Date.parse(step.completed_at) + 1000;
  const events = lines.filter(row => inStep(row) && row.text.startsWith("{"));
  const protectedObservations = parsePiTranscript(events.map(row => row.text).join("\n"));
  const artifactObservations = parsePiTranscript(content(candidate.members.find(row => row.file === "pi-streaming.jsonl")));
  const service = lines.find(row => row.text === "redis service is healthy.");
  const hostAllowance = lines.find(row => inStep(row) && row.text === "[INFO] Host service ports allowed (host gateway only): 6379");
  const hostRoute = lines.find(row => inStep(row)
    && /^\[INFO\] Host access enabled: allowing traffic to gateway IPs [0-9., ]+ on ports [0-9, ]*6379$/.test(row.text));
  const sandbox = lines.find(row => inStep(row) && /Container awf-agent\s+Started$/.test(row.text));
  const result = [];
  for (const observation of protectedObservations) {
    const counterpart = artifactObservations.find(row => row.toolCallId === observation.toolCallId);
    if (!counterpart || counterpart.commandSha256 !== observation.commandSha256
      || counterpart.outputSha256 !== observation.outputSha256) throw new Error("Independent host/client observations conflict");
    const start = events[observation.startLine - 1], end = events[observation.endLine - 1];
    if (!start || !end || Date.parse(start.timestamp) >= Date.parse(end.timestamp)) throw new Error("Native operation order is not established");
    const before = row => row && Date.parse(row.timestamp) < Date.parse(start.timestamp);
    const boundary = compiledBoundary && [service, hostAllowance, hostRoute, sandbox].every(before) ? true : null;
    result.push({
      id: `${run.id}:${run.run_attempt}:${job.id}:${hash(observation.toolCallId)}`,
      sessionId: `${run.id}:${run.run_attempt}:${job.id}:redis`,
      completedAt: end.timestamp, runId: run.id, attempt: run.run_attempt, head: run.head_sha, jobId: job.id,
      cases: observation.native.cases, fullIntegration: Object.values(observation.native.cases).every(Boolean) ? boundary : false,
      hostBoundary: boundary, workflowContribution: true,
      tcpReachability: observation.native.exchanges.length ? true : null,
      serviceStartup: before(service) ? true : null,
      protectedLines: { request: start.line, response: end.line, service: service?.line ?? null,
        allowance: hostAllowance?.line ?? null, route: hostRoute?.line ?? null, sandbox: sandbox?.line ?? null },
      evidence: {
        artifactId: artifact.id, artifactDigest: artifact.digest,
        compiledBlob: source ? "47ce50ac9931c8d9960f2fae8b88dae6e00c2ecf" : null,
        commandSha256: observation.commandSha256, outputSha256: observation.outputSha256,
      },
      limitation: "Protected client execution proves these three operations and this sandbox boundary, not sole authorship, restart durability or complete repository-period coverage.",
    });
  }
  if (!result.length) throw new Error("No source-defined native Redis operations independently corroborated");
  return disjointNativeEvents(result);
}

export function disjointNativeEvents(observations) {
  const seenCases = new Set(), seenIntegration = new Set(), seenSessions = new Set(), result = [];
  for (const observation of [...observations].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))) {
    const deliveredCases = Object.fromEntries(Object.entries(observation.cases).map(([name, passed]) => {
      const key = `${observation.sessionId}:${name}`, newlyProven = passed === true && !seenCases.has(key);
      if (passed === true) seenCases.add(key);
      return [name, newlyProven];
    }));
    const integrationDelivered = observation.fullIntegration === null ? null
      : observation.fullIntegration && !seenIntegration.has(observation.sessionId);
    if (observation.fullIntegration) seenIntegration.add(observation.sessionId);
    if (!seenSessions.has(observation.sessionId) || Object.values(deliveredCases).some(Boolean) || integrationDelivered) {
      result.push({ ...observation, deliveredCases, integrationDelivered });
    }
    seenSessions.add(observation.sessionId);
  }
  return result;
}

export function parseSession(session) {
  if (!session || typeof session.id !== "string" || !session.id || !Array.isArray(session.exchanges)) {
    throw new Error("Invalid Redis session");
  }
  const facts = { ping: null, roundTrip: null, info: null };
  let set = null, last = -1;
  const ids = new Set();
  for (const exchange of session.exchanges) {
    if (typeof exchange.id !== "string" || ids.has(exchange.id) || !Number.isSafeInteger(exchange.sequence)
      || exchange.sequence <= last) throw new Error("Repeated or unordered Redis operation");
    ids.add(exchange.id);
    last = exchange.sequence;
    const parsed = exchange.format === "redis-cli"
      ? parseCliOperation(exchange.args, decodeBase64(exchange.stdout), exchange.exitCode)
      : parseExchange(decodeBase64(exchange.request), decodeBase64(exchange.response));
    if (parsed.case === "set") set = parsed.passed;
    else if (parsed.case === "get") {
      // GET alone may read old state. An observed SET in this lifetime is required.
      if (set !== null) facts.roundTrip = set && parsed.passed;
    } else facts[parsed.case] = parsed.passed;
  }
  return {
    id: session.id, cases: facts,
    protocolCases: Object.values(facts).filter(x => x === true).length,
    assessedCases: Object.values(facts).filter(x => x !== null).length,
    allProtocolCases: Object.values(facts).every(x => x === true),
  };
}

export function discoveryClosure(entities) {
  const direct = entities.filter(row => row.workflowReference?.workflowId === workflow || row.unverifiedWorkflowId === workflow);
  const selected = new Set(direct.map(row => row.number));
  const byNumber = new Map(entities.map(row => [row.number, row]));
  const neighbours = new Map();
  for (const row of entities) {
    for (const target of row.relatedCandidates) {
      if (!neighbours.has(row.number)) neighbours.set(row.number, new Set());
      if (!neighbours.has(target)) neighbours.set(target, new Set());
      neighbours.get(row.number).add(target);
      neighbours.get(target).add(row.number);
    }
  }
  const queue = [...selected];
  for (let i = 0; i < queue.length; i++) {
    for (const target of neighbours.get(queue[i]) ?? []) {
      if (!selected.has(target)) { selected.add(target); queue.push(target); }
    }
  }
  return {
    direct: direct.map(row => row.number).sort((a, b) => a - b),
    entities: [...selected].filter(n => byNumber.has(n)).sort((a, b) => a - b).map(n => byNumber.get(n)),
    absentReferences: [...selected].filter(n => !byNumber.has(n)).sort((a, b) => a - b),
    status: "Discovery only: body edits, issue closure and job success do not prove Redis operations.",
  };
}
