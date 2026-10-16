/** Historical CAO aliases accepted at ingestion, never emitted as event types. */
const LEGACY_TYPES = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  agent_turn: 'user.message',
  assistant_message: 'assistant.message',
  reasoning: 'assistant.reasoning',
  agent_tool_start: 'tool.execution_start',
  agent_tool_done: 'tool.execution_complete',
  tool_call: 'mcp.tool_call',
  'tool.call': 'mcp.tool_call',
  'tool.result': 'tool.execution_complete',
  'tool.error': 'tool.execution_complete',
  difc_filtered: 'mcp.difc.filtered',
  guard_blocked: 'mcp.guard.blocked',
  net_allowed: 'firewall.http_access',
  net_blocked: 'firewall.http_access',
  'firewall.request.allowed': 'firewall.http_access',
  'firewall.request.blocked': 'firewall.http_access',
  'audit.skill_activation': 'skill.invoked',
  workflow_run_grader: 'grader.result',
  workflow_run_eval: 'eval.result',
  'safe_output.created': 'safe_output.result',
  'audit.gateway_steering': 'firewall.steering'
}));

/** @param {string} type */
export function unifiedSessionEventType(type) {
  return Object.hasOwn(LEGACY_TYPES, type) ? LEGACY_TYPES[type] : type;
}

/**
 * Preserve native event identifiers; old split outcome types become metadata.
 * @param {Record<string, unknown>} record
 */
export function alignSessionEventRecord(record) {
  if (typeof record.type !== 'string') return record;
  const type = unifiedSessionEventType(record.type);
  if (type === record.type) return record;
  return {
    ...record, type,
    ...(record.status === undefined && record.type === 'tool.error' ? { status: 'error' } : {}),
    ...(record.decision === undefined && ['net_allowed', 'firewall.request.allowed'].includes(record.type)
      ? { decision: 'allowed' } : {}),
    ...(record.decision === undefined && ['net_blocked', 'firewall.request.blocked'].includes(record.type)
      ? { decision: 'denied' } : {})
  };
}
