const present = value => typeof value === "string" && value.length > 0;
const records = (input, label) => {
  if (typeof input !== "string") throw new Error(`${label} must be JSONL text`);
  return input.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let row;
    try {
      row = JSON.parse(line);
    } catch (cause) {
      throw new Error(`${label} has invalid JSON on line ${index + 1}`, { cause });
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${label} has a non-object record on line ${index + 1}`);
    }
    return [row];
  });
};

// This inspects the pinned raw schema; it does not score or infer a binding.
export function inspectNativeBindingSchema(sessionText, proxyText) {
  const session = records(sessionText, "Native session");
  const proxy = records(proxyText, "Proxy usage");
  const scopes = new Set();
  const starts = [];
  const childIdentities = new Set();
  const requestIds = new Set();
  const sessionRequestIds = new Set();
  let aggregateSnapshots = 0, classifierRequests = 0;
  for (const row of session) {
    if (!present(row.type)) throw new Error("Native session record has no type");
    if (row.type === "session.start" || row.type === "session.init") {
      if (!present(row.data?.sessionId) || !present(row.provenance?.path)) {
        throw new Error("Native session has an unscoped initialization");
      }
      scopes.add(JSON.stringify([row.provenance.path, row.data.sessionId]));
    }
    if (row.type === "subagent.started") {
      const data = row.data;
      if (!present(row.agentId) || !present(data?.toolCallId) || !present(data.agentName)
        || row.provenance?.component !== "agent" || row.provenance.phase !== "agent"
        || !present(row.provenance.path)) throw new Error("Native child start lacks structured identity");
      const identity = JSON.stringify([row.provenance.path, row.agentId, data.toolCallId]);
      if (childIdentities.has(identity)) throw new Error("Duplicate native child start");
      childIdentities.add(identity);
      starts.push({ agentId: row.agentId, toolCallId: data.toolCallId, agentName: data.agentName });
    }
    if (row.data?.agentMetrics && ["session.shutdown", "session.result"].includes(row.type)) {
      aggregateSnapshots++;
    }
    for (const field of ["apiCallId", "requestId"]) {
      if (present(row.data?.[field])) sessionRequestIds.add(row.data[field]);
    }
  }
  if (scopes.size !== 1) throw new Error("Pinned decoder requires one explicit native session/source scope");
  const sourcePath = JSON.parse([...scopes][0])[0];
  if (session.some(row => row.type === "subagent.started" && row.provenance.path !== sourcePath)) {
    throw new Error("Child start belongs to a different native source");
  }
  for (const row of proxy) {
    if (row._schema !== "token-usage/v0.28.50" || row.event !== "token_usage") {
      throw new Error("Unreviewed proxy schema/event");
    }
    if (!present(row.request_id) || requestIds.has(row.request_id) || !present(row.model)) {
      throw new Error("Missing or duplicate proxy request identity");
    }
    if (["agentId", "agent_id", "sessionId", "session_id", "toolCallId", "tool_call_id"]
      .some(field => Object.hasOwn(row, field))) {
      throw new Error("Unreviewed proxy child-identity extension must not become accepted evidence");
    }
    requestIds.add(row.request_id);
    if (row.purpose === "routing_classification") classifierRequests++;
  }
  return {
    schemaVersion: 1,
    status: "unsupported-independent-binding",
    reviewedProxySchema: "token-usage/v0.28.50",
    sessionRecords: session.length,
    nativeChildStarts: starts.length,
    proxyRequests: proxy.length,
    routingClassifierRequests: classifierRequests,
    sessionPerRequestIds: sessionRequestIds.size,
    sharedRequestIds: [...sessionRequestIds].filter(id => requestIds.has(id)).length,
    aggregateSnapshotEvents: aggregateSnapshots,
    exactBindingsSupported: false,
    nativeResolutionValue: null,
    sourceDeclaredModelsAvailable: false,
    reason: "Proxy rows expose request_id but no child/session/tool-call identity; this reviewed format has no independently validated bridge to child lifecycle IDs. Agent metrics are aggregate snapshots, not proxy request receipts. Runtime configured models are not immutable workflow declarations.",
    rejectedJoins: ["same model", "overlapping timestamps", "aggregate token or request totals", "x_initiator=agent", "agent-reported configuredModelMatchesActual"],
  };
}
