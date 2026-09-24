targetScope = 'resourceGroup'

// Experimental Azure Functions deployment baseline for the Go dashboard server.
// Review and validate tenant-specific security, compliance, networking,
// monitoring, cost, rotation, and rollback requirements before live use.

@description('Azure region for all dashboard resources.')
param location string = resourceGroup().location

@description('Globally unique Function App name for the experimental Azure Functions dashboard profile.')
param functionAppName string

@description('Azure App Service plan name for the Function App.')
param hostingPlanName string = '${functionAppName}-plan'

@description('Globally unique storage account name for Azure Functions runtime state.')
param storageAccountName string

@description('Key Vault name used for GitHub OAuth, session, and Redis connection secrets.')
param keyVaultName string

@description('Redis Enterprise cache name. The default database enables RediSearch.')
param redisEnterpriseName string

@allowed([
  'Enterprise_E10'
  'Enterprise_E20'
  'Enterprise_E50'
  'Enterprise_E100'
  'EnterpriseFlash_F300'
  'EnterpriseFlash_F700'
  'EnterpriseFlash_F1500'
])
@description('Redis Enterprise SKU with RediSearch module support. The Go server creates per-generation FT indexes and issues FT.SEARCH/FT.AGGREGATE queries, so Basic/Standard/Premium Azure Cache for Redis are not valid for this dashboard.')
param redisSkuName string = 'Enterprise_E10'

@minValue(2)
@description('Redis Enterprise capacity. Production deployments should size this from retained dashboard data volume.')
param redisCapacity int = 2

@description('Public host names that Azure Front Door/App Service is allowed to forward to the Go dashboard handler.')
param allowedHosts array

@description('GitHub organizations whose active members are authorized.')
param githubAllowedOrganizations array

@description('GitHub teams whose active members are authorized, expressed as org/team-slug.')
param githubAllowedTeams array = []

@description('GitHub OAuth App client ID. Do not use a PAT; the server only supports the OAuth authorization-code flow.')
param githubClientId string

@secure()
@description('GitHub OAuth App client secret. It is written only to Key Vault and consumed by the Function App through a Key Vault reference.')
param githubClientSecret string

@secure()
@minLength(32)
@description('At least 32 characters of random session secret material used to encrypt server-side OAuth sessions.')
param sessionSecret string

@secure()
@description('TLS Redis URL, for example rediss://:<access-key>@cache.region.redisenterprise.cache.azure.net:10000/0. Store a rotated value here rather than outputting Redis keys.')
param redisConnectionString string

@description('Optional Log Analytics workspace resource ID for Application Insights. Leave empty to create classic component-only telemetry.')
param logAnalyticsWorkspaceResourceId string = ''

var tags = {
  workload: 'gh-aw-cao-dashboard'
  hostingMode: 'azure-functions'
}
var githubRedirectUri = 'https://${functionAppName}.azurewebsites.net/auth/callback'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enabledForTemplateDeployment: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
  }
}

resource githubClientSecretValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'github-oauth-client-secret'
  properties: {
    value: githubClientSecret
    contentType: 'GitHub OAuth client secret for CAO dashboard Azure Functions mode'
  }
}

resource sessionSecretValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'cao-session-secret'
  properties: {
    value: sessionSecret
    contentType: 'CAO dashboard session encryption secret'
  }
}

resource redisConnectionStringValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'cao-redis-url'
  properties: {
    value: redisConnectionString
    contentType: 'CAO dashboard Redis Enterprise rediss URL'
  }
}

resource redisEnterprise 'Microsoft.Cache/redisEnterprise@2024-11-01' = {
  name: redisEnterpriseName
  location: location
  tags: tags
  sku: {
    name: redisSkuName
    capacity: redisCapacity
  }
  properties: {
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
  }
}

resource redisDatabase 'Microsoft.Cache/redisEnterprise/databases@2024-11-01' = {
  parent: redisEnterprise
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    clusteringPolicy: 'EnterpriseCluster'
    evictionPolicy: 'NoEviction'
    modules: [
      {
        name: 'RediSearch'
      }
    ]
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: hostingPlanName
  location: location
  tags: tags
  kind: 'elastic'
  sku: {
    name: 'EP1'
    tier: 'ElasticPremium'
  }
  properties: {
    reserved: true
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${functionAppName}-ai'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: empty(logAnalyticsWorkspaceResourceId) ? null : logAnalyticsWorkspaceResourceId
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'custom'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: insights.properties.ConnectionString
        }
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'
        }
        {
          name: 'CAO_DASHBOARD_HOSTING'
          value: 'azure-functions'
        }
        {
          name: 'CAO_AZURE_ALLOWED_HOSTS'
          value: join(allowedHosts, ',')
        }
        {
          name: 'CAO_AZURE_REQUIRE_HTTPS'
          value: 'true'
        }
        {
          name: 'CAO_REDIS_NAMESPACE'
          value: 'azure-dashboard'
        }
        {
          name: 'CAO_REDIS_URL'
          value: '@Microsoft.KeyVault(SecretUri=${redisConnectionStringValue.properties.secretUriWithVersion})'
        }
        {
          name: 'CAO_GITHUB_CLIENT_ID'
          value: githubClientId
        }
        {
          name: 'CAO_GITHUB_CLIENT_SECRET'
          value: '@Microsoft.KeyVault(SecretUri=${githubClientSecretValue.properties.secretUriWithVersion})'
        }
        {
          name: 'CAO_GITHUB_REDIRECT_URL'
          value: githubRedirectUri
        }
        {
          name: 'CAO_GITHUB_ALLOWED_ORGS'
          value: join(githubAllowedOrganizations, ',')
        }
        {
          name: 'CAO_GITHUB_ALLOWED_TEAMS'
          value: join(githubAllowedTeams, ',')
        }
        {
          name: 'CAO_SESSION_SECRET'
          value: '@Microsoft.KeyVault(SecretUri=${sessionSecretValue.properties.secretUriWithVersion})'
        }
      ]
    }
  }
}

resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, functionApp.name, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6c')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output functionHostName string = functionApp.properties.defaultHostName
output githubOAuthRedirectUri string = githubRedirectUri
output redisEnterpriseHostName string = redisEnterprise.properties.hostName
output redisDatabaseName string = redisDatabase.name
output keyVaultUri string = keyVault.properties.vaultUri
