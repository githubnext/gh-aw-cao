import assert from 'node:assert/strict';

export function hostedMCPVersionInformation(discovered) {
  // SEP-2575 discovery identifies the server in result metadata, not serverInfo.
  return {
    serverInfo: discovered?._meta?.['io.modelcontextprotocol/serverInfo'],
    supportedVersions: discovered?.supportedVersions
  };
}

export function assertHostedMCPVersionInformation({ serverInfo, supportedVersions }, protocolVersion) {
  assert.ok(serverInfo && typeof serverInfo === 'object' && !Array.isArray(serverInfo),
    'Hosted MCP discovery must include server identity metadata');
  assert.equal(serverInfo.name, 'cao', 'Hosted MCP must identify itself as cao');
  assert.equal(typeof serverInfo.version, 'string', 'Hosted MCP must report a string server version');
  assert.ok(serverInfo.version.trim().length > 0, 'Hosted MCP must report its server version');
  assert.ok(Array.isArray(supportedVersions) && supportedVersions.every((version) => typeof version === 'string'),
    'Hosted MCP discovery must report supportedVersions as an array of strings');
  assert.ok(supportedVersions.includes(protocolVersion), 'Hosted MCP must support the requested protocol version');
}
