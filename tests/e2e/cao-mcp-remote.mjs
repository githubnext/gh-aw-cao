import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertHostedMCPVersionInformation,
  hostedMCPVersionInformation
} from '../unit/cao-mcp-remote.helpers.mjs';

const endpoint = 'https://cao.githubnext.com/mcp';
const audience = 'https://cao.githubnext.com';
const protocolVersion = '2026-07-28';

test('hosted MCP lists tools, inspects the catalog, and executes a named query', async (t) => {
  const actionsToken = process.env.GITHUB_TOKEN;
  const requestURL = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  assert.ok(actionsToken && requestURL && requestToken, 'GitHub Actions token and OIDC request credentials are required');

  const oidcResponse = await fetch(`${requestURL}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: 'Bearer ' + requestToken },
    signal: AbortSignal.timeout(10_000)
  });
  assert.equal(oidcResponse.status, 200, 'GitHub Actions must mint an OIDC token');
  const { value: oidcToken } = await oidcResponse.json();
  assert.ok(oidcToken, 'OIDC token must be present');

  let sessionID;
  let nextID = 0;
  async function call(method, params = {}) {
    const id = ++nextID;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + actionsToken,
        'X-GitHub-OIDC-Token': oidcToken,
        'MCP-Protocol-Version': protocolVersion,
        'Mcp-Method': method,
        ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}),
        ...(sessionID ? { 'Mcp-Session-Id': sessionID } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': protocolVersion,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'cao-remote-integration', version: '1' }
          }
        }
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (response.status === 401) {
      const refusal = await response.json().catch(() => ({}));
      const codes = new Set(['credentials_missing', 'oidc_invalid', 'repository_unavailable', 'provenance_mismatch', 'permissions_denied', 'authentication_failed']);
      const code = codes.has(refusal.code) ? refusal.code : 'unknown';
      const trace = response.headers.get('x-trace-id');
      const traceId = /^[0-9a-f]{32}$/.test(trace ?? '') ? trace : 'unavailable';
      assert.fail(`${method} must succeed (HTTP 401; code=${code}; traceId=${traceId})`);
    }
    assert.equal(response.status, 200, `${method} must succeed (HTTP ${response.status})`);
    sessionID = response.headers.get('mcp-session-id') ?? sessionID;
    const payload = await response.json();
    assert.equal(payload.id, id);
    assert.equal(payload.jsonrpc, '2.0');
    assert.equal(payload.error, undefined, `${method} must not return a JSON-RPC error`);
    if (payload.result?.isError === true) {
      const trace = response.headers.get('x-trace-id');
      const traceId = /^[0-9a-f]{32}$/.test(trace ?? '') ? trace : 'unavailable';
      assert.fail(`${method} ${params.name} returned a tool error (traceId=${traceId}): ${JSON.stringify(payload.result, null, 2)}`);
    }
    return payload.result;
  }

  await t.test('prints MCP server version information', async () => {
    const discovered = await call('server/discover');
    const versionInformation = hostedMCPVersionInformation(discovered);
    console.log('Hosted MCP server version information:', JSON.stringify(versionInformation, null, 2));
    assertHostedMCPVersionInformation(versionInformation, protocolVersion);
  });

  const listed = await call('tools/list');
  const toolNames = listed.tools.map(({ name }) => name);
  const logsEnabled = toolNames.includes('cao_logs');
  assert.deepEqual(toolNames, logsEnabled
    ? ['cao_catalog', 'cao_logs', 'cao_query']
    : ['cao_catalog', 'cao_query']);
  assert.ok(listed.tools.every(({ annotations }) => annotations?.readOnlyHint === true));

  await t.test('reads enabled server logs with the Actions identity', { skip: !logsEnabled }, async () => {
    const logs = await call('tools/call', { name: 'cao_logs', arguments: {} });
    assert.ok(Array.isArray(logs.structuredContent?.logs), 'Server logs must return a record array');
    assert.ok(['ok', 'unavailable', 'not-configured'].includes(logs.structuredContent?.redis?.status),
      'Server logs must report Redis availability');
    assert.deepEqual(Object.keys(logs.structuredContent).sort(), ['logs', 'redis']);
  });

  const catalog = await call('tools/call', { name: 'cao_catalog', arguments: { kind: 'queries' } });
  assert.notEqual(catalog.isError, true);
  console.log('Hosted MCP query catalog:', JSON.stringify(catalog.structuredContent, null, 2));
  assert.ok(Array.isArray(catalog.structuredContent?.queries), 'Hosted MCP must return a query catalog');
  assert.ok(catalog.structuredContent.queries.length > 0, 'Hosted MCP query catalog must not be empty');
  assert.ok(catalog.structuredContent.queries.some(({ id }) => id === 'database-campaign-count'),
    'Hosted MCP query catalog must contain database-campaign-count');

  const query = await call('tools/call', { name: 'cao_query', arguments: { id: 'database-campaign-count', limit: 1 } });
  assert.equal(query.structuredContent?.query, 'database-campaign-count');
  assert.ok(Array.isArray(query.structuredContent.rows));
  assert.ok(query.structuredContent.metadata?.availability);
  assert.notEqual(query.structuredContent.metadata.availability, 'unavailable');
});
