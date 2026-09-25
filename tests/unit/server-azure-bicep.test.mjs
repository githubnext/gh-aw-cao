import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bicep = await readFile(new URL('../../server/azure/main.bicep', import.meta.url), 'utf8');

test('Azure dashboard Bicep uses a module-free Redis cache and TLS app settings', () => {
  assert.match(bicep, /Experimental Azure Functions deployment baseline/);
  assert.match(bicep, /Review and validate tenant-specific security, compliance, networking/);
  assert.match(bicep, /Microsoft\.Cache\/redisEnterprise@/);
  // The server issues only core key-value commands, so no Redis module is
  // provisioned and the SKU floor is not forced by feature requirements.
  assert.doesNotMatch(bicep, /RediSearch/);
  assert.doesNotMatch(bicep, /modules:/);
  assert.match(bicep, /param redisSkuName string = 'Balanced_B0'/);
  assert.match(bicep, /clientProtocol:\s*'Encrypted'/);
  assert.match(bicep, /publicNetworkAccess:\s*'Disabled'/);
  assert.match(bicep, /CAO_REDIS_URL/);
  assert.match(bicep, /@Microsoft\.KeyVault\(SecretUri=/);
  assert.match(bicep, /CAO_DASHBOARD_HOSTING[\s\S]*azure-functions/);
});

test('Azure dashboard Bicep does not output secrets or PAT-based configuration', () => {
  const outputLines = bicep.split('\n').filter((line) => line.trim().startsWith('output '));
  assert.ok(outputLines.length > 0, 'expected deterministic non-secret outputs');
  for (const line of outputLines) {
    const [, name] = line.trim().split(/\s+/);
    assert.doesNotMatch(name, /secret|token|connection|redis_url|accessKey|primaryKey/i);
  }
  assert.doesNotMatch(bicep, /CAO_GITHUB_PAT|GITHUB_PAT|PERSONAL_ACCESS_TOKEN/i);
  assert.match(bicep, /OAuth authorization-code flow/);
});

test('Azure dashboard Bicep keeps secret-bearing settings in Key Vault', () => {
  assert.match(bicep, /resource keyVault 'Microsoft\.KeyVault\/vaults@/);
  assert.match(bicep, /enableRbacAuthorization:\s*true/);
  assert.match(bicep, /enableSoftDelete:\s*true/);
  assert.match(bicep, /enablePurgeProtection:\s*true/);
  assert.match(bicep, /enabledForTemplateDeployment:\s*false/);
  assert.match(bicep, /param previousSessionSecret string = ''/);
  assert.match(bicep, /name:\s*'cao-session-secret-previous'/);
  assert.match(bicep, /identity:\s*{\s*type:\s*'SystemAssigned'/);
  assert.match(bicep, /Key Vault Secrets User/);

  for (const setting of ['AzureWebJobsStorage', 'CAO_REDIS_URL', 'CAO_GITHUB_CLIENT_SECRET', 'CAO_SESSION_SECRET']) {
    const pattern = new RegExp(`name:\\s*'${setting}'[\\s\\S]*?value:\\s*'@Microsoft\\.KeyVault\\(SecretUri=`);
    assert.match(bicep, pattern, `${setting} must use a Key Vault reference`);
  }
  assert.doesNotMatch(bicep, /secretUriWithVersion/, 'Key Vault references must follow the current secret version for rotation');

  assert.match(bicep, /httpsOnly:\s*true/);
  assert.match(bicep, /alwaysOn:\s*true/);
  assert.match(bicep, /minimumElasticInstanceCount:\s*1/);
  assert.match(bicep, /ftpsState:\s*'Disabled'/);
  assert.match(bicep, /allowBlobPublicAccess:\s*false/);
  assert.match(bicep, /supportsHttpsTrafficOnly:\s*true/);
});
