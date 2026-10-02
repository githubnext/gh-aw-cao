import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertHostedMCPVersionInformation,
  hostedMCPVersionInformation
} from './cao-mcp-remote.helpers.mjs';

const protocolVersion = '2026-07-28';
const serverInfoKey = 'io.modelcontextprotocol/serverInfo';
const serverInfo = { name: 'cao', title: 'Central Agentic Ops', version: 'v1.2.3' };

function discovery(info = serverInfo, supportedVersions = [protocolVersion]) {
  return { _meta: { [serverInfoKey]: info }, supportedVersions };
}

function validate(discovered) {
  assertHostedMCPVersionInformation(hostedMCPVersionInformation(discovered), protocolVersion);
}

test('hosted MCP discovery reads SEP-2575 server metadata for version diagnostics', () => {
  const discovered = discovery();
  assert.equal(discovered.serverInfo, undefined);
  assert.deepEqual(hostedMCPVersionInformation(discovered), {
    serverInfo,
    supportedVersions: [protocolVersion]
  });
  validate(discovered);
  validate({ ...discovered, serverInfo: { name: 'not-cao', version: '' } });
});

test('hosted MCP discovery rejects missing or malformed server metadata without a legacy fallback', async (t) => {
  for (const [name, discovered] of [
    ['missing result', undefined],
    ['null result', null],
    ['missing metadata', { supportedVersions: [protocolVersion] }],
    ['legacy top-level identity only', { serverInfo, supportedVersions: [protocolVersion] }],
    ['null metadata', { _meta: null, supportedVersions: [protocolVersion] }],
    ['string metadata', { _meta: 'cao', supportedVersions: [protocolVersion] }],
    ['missing identity key', { _meta: {}, supportedVersions: [protocolVersion] }],
    ['wrong identity key', { _meta: { serverInfo }, supportedVersions: [protocolVersion] }],
    ['null identity', discovery(null)],
    ['string identity', discovery('cao')],
    ['array identity', discovery([])],
    ['number identity', discovery(1)],
    ['malformed metadata despite legacy identity', { ...discovery(null), serverInfo }]
  ]) {
    await t.test(name, () => {
      assert.throws(() => validate(discovered), {
        name: 'AssertionError',
        message: /must include server identity metadata/
      });
    });
  }
});

test('hosted MCP discovery requires the correct identity and a nonempty string implementation version', async (t) => {
  for (const [name, info, message] of [
    ['missing name', { version: '1' }, /must identify itself as cao/],
    ['wrong name', { ...serverInfo, name: 'other' }, /must identify itself as cao/],
    ['missing version', { name: 'cao' }, /must report a string server version/],
    ['null version', { ...serverInfo, version: null }, /must report a string server version/],
    ['numeric version', { ...serverInfo, version: 1 }, /must report a string server version/],
    ['empty version', { ...serverInfo, version: '' }, /must report its server version/],
    ['whitespace version', { ...serverInfo, version: ' \n' }, /must report its server version/]
  ]) {
    await t.test(name, () => {
      assert.throws(() => validate(discovery(info)), { name: 'AssertionError', message });
    });
  }
});

test('hosted MCP discovery requires an exact advertised protocol version in a string array', async (t) => {
  for (const [name, supportedVersions] of [
    ['missing versions', undefined],
    ['null versions', null],
    ['string versions', protocolVersion],
    ['object versions', { [protocolVersion]: true }],
    ['non-string member', [protocolVersion, 1]]
  ]) {
    await t.test(name, () => {
      assert.throws(() => validate({ ...discovery(), supportedVersions }), {
        name: 'AssertionError',
        message: /supportedVersions as an array of strings/
      });
    });
  }
  for (const supportedVersions of [[], ['2025-11-25'], [`${protocolVersion}-other`]]) {
    assert.throws(() => validate(discovery(serverInfo, supportedVersions)), {
      name: 'AssertionError',
      message: /must support the requested protocol version/
    });
  }
  validate(discovery(serverInfo, ['2025-11-25', protocolVersion]));
});
