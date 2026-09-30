import assert from 'node:assert/strict';
import test from 'node:test';

const endpoint = 'https://cao.githubnext.com/mcp';
const audience = 'https://cao.githubnext.com';
const protocolVersion = '2026-07-28';

test('hosted MCP lists tools, inspects the catalog, and executes a named query', async () => {
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
    assert.equal(response.status, 200, `${method} must succeed (HTTP ${response.status})`);
    sessionID = response.headers.get('mcp-session-id') ?? sessionID;
    const payload = await response.json();
    assert.equal(payload.id, id);
    assert.equal(payload.jsonrpc, '2.0');
    assert.equal(payload.error, undefined, `${method} must not return a JSON-RPC error`);
    return payload.result;
  }

  const initialized = await call('initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'cao-remote-integration', version: '1' }
  });
  assert.equal(initialized.protocolVersion, protocolVersion);

  const listed = await call('tools/list');
  assert.deepEqual(listed.tools.map(({ name }) => name), ['cao_catalog', 'cao_query']);
  assert.ok(listed.tools.every(({ annotations }) => annotations?.readOnlyHint === true));

  const catalog = await call('tools/call', { name: 'cao_catalog', arguments: { kind: 'queries' } });
  assert.notEqual(catalog.isError, true);
  assert.ok(Array.isArray(catalog.structuredContent?.queries));
  assert.ok(catalog.structuredContent.queries.some(({ id }) => id === 'campaign-runs'));

  const query = await call('tools/call', { name: 'cao_query', arguments: { id: 'campaign-runs', limit: 1 } });
  assert.notEqual(query.isError, true);
  assert.equal(query.structuredContent?.query, 'campaign-runs');
  assert.ok(Array.isArray(query.structuredContent.rows));
  assert.ok(query.structuredContent.metadata?.availability);
});
