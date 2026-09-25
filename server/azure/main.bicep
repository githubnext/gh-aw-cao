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

@description('Azure Managed Redis cache name.')
param redisEnterpriseName string

@allowed([
  'Balanced_B0'
  'Balanced_B1'
  'Balanced_B3'
  'Balanced_B5'
  'Balanced_B10'
  'MemoryOptimized_M10'
])
@description('Redis SKU. The server uses only core key-value commands (HSET/HGET/SMEMBERS/EVAL) and no Redis modules, so the smallest SKU that holds the retained generations is sufficient. Size this from retained dashboard data volume, not from feature requirements.')
param redisSkuName string = 'Balanced_B0'

@minValue(1)
@description('Redis capacity. The module-free default uses the smallest capacity; increase only when retained generations need more memory or throughput.')
param redisCapacity int = 1

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
@description('Optional previous session secret retained during controlled key rotation until active sessions and pending revocations are drained.')
param previousSessionSecret string = ''

@secure()
@description('TLS Redis URL, for example rediss://:<access-key>@cache.region.redisenterprise.cache.azure.net:10000/0. Store a rotated value here rather than outputting Redis keys.')
param redisConnectionString string

@description('Optional Log Analytics workspace resource ID for Application Insights. Leave empty to create classic component-only telemetry.')
param logAnalyticsWorkspaceResourceId string = ''

// Optional server collection profile.
//
// Leaving collectorImage empty deploys the default profile unchanged: the
// dashboard serves snapshots published by the Activity workflow and the server
// collects nothing. Supplying an image selects the alternative profile, in
// which this deployment collects evidence itself. The two profiles are
// alternatives, never layers.

@description('Optional container image running the collection role. Empty deploys no collection.')
param collectorImage string = ''

@description('GitHub App identifier whose installations define ingestion scope. Required with collectorImage.')
param collectorGithubAppId string = ''

@secure()
@description('GitHub App private key in PEM form. Required with collectorImage.')
param collectorPrivateKey string = ''

@secure()
@description('Shared secret verifying GitHub webhook deliveries. Required with collectorImage.')
param githubWebhookSecret string = ''

@secure()
@description('Redis access key used only by the collection autoscaler to read stream backlog. Required with collectorImage.')
param collectorRedisPassword string = ''

@description('GitHub logins permitted to run administrative operations.')
param githubAdminUsers array = []

@description('Control repository used for logical source discovery, in OWNER/REPOSITORY form.')
param collectorControlRepository string = ''

@description('Maximum number of collection workers.')
param collectorMaximumWorkers int = 20

@description('Evidence lake file share tier. Premium is provisioned SSD; Standard is IOPS-throttled by share size.')
@allowed([
  'Premium_LRS'
  'Premium_ZRS'
  'Standard_LRS'
  'Standard_ZRS'
])
param collectorLakeStorageSku string = 'Premium_LRS'

var collectionEnabled = !empty(collectorImage)

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
    enabledForTemplateDeployment: false
    enableSoftDelete: true
    enablePurgeProtection: true
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

resource previousSessionSecretValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(previousSessionSecret)) {
  parent: keyVault
  name: 'cao-session-secret-previous'
  properties: {
    value: previousSessionSecret
    contentType: 'Previous CAO dashboard session encryption secret retained during rotation'
  }
}

resource redisConnectionStringValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'cao-redis-url'
  properties: {
    value: redisConnectionString
    contentType: 'CAO dashboard Redis rediss URL'
  }
}

resource collectorPrivateKeyValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (collectionEnabled) {
  parent: keyVault
  name: 'cao-collect-private-key'
  properties: {
    value: collectorPrivateKey
    contentType: 'GitHub App private key for the collection profile'
  }
}

resource collectorRedisPasswordValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (collectionEnabled) {
  parent: keyVault
  name: 'cao-redis-password'
  properties: {
    value: collectorRedisPassword
    contentType: 'Redis access key for the collection autoscaler'
  }
}

resource githubWebhookSecretValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (collectionEnabled) {
  parent: keyVault
  name: 'cao-github-webhook-secret'
  properties: {
    value: githubWebhookSecret
    contentType: 'GitHub webhook shared secret'
  }
}

resource functionsStorageConnectionStringValue 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-webjobs-storage'
  properties: {
    value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'
    contentType: 'Azure Functions runtime storage connection'
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
      minimumElasticInstanceCount: 1
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: concat([
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
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/azure-webjobs-storage)'
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
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/cao-redis-url)'
        }
        {
          name: 'CAO_GITHUB_CLIENT_ID'
          value: githubClientId
        }
        {
          name: 'CAO_GITHUB_CLIENT_SECRET'
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/github-oauth-client-secret)'
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
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/cao-session-secret)'
        }
      ], empty(previousSessionSecret) ? [] : [
        {
          name: 'CAO_SESSION_SECRET_PREVIOUS'
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/cao-session-secret-previous)'
        }
      ], !collectionEnabled ? [] : [
        // With collection configured the Function App admits webhook
        // deliveries into the collection queue. It performs no collection of
        // its own, so its per-request work stays constant.
        {
          name: 'CAO_GITHUB_WEBHOOK_SECRET'
          value: '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/cao-github-webhook-secret)'
        }
        {
          name: 'CAO_GITHUB_ADMIN_USERS'
          value: join(githubAdminUsers, ',')
        }
        {
          name: 'CAO_COLLECT_APP_ID'
          value: collectorGithubAppId
        }
        {
          // The Function App verifies deliveries and enqueues work. It never
          // calls GitHub and never projects, so it is given no App private key
          // and no evidence lake: the internet-facing front end holds no
          // credential it cannot use.
          name: 'CAO_COLLECT_ADMIT_ONLY'
          value: 'true'
        }
        {
          name: 'CAO_COLLECT_CONTROL_REPOSITORY'
          value: collectorControlRepository
        }
      ])
    }
  }
  dependsOn: [
    functionsStorageConnectionStringValue
    githubClientSecretValue
    redisConnectionStringValue
    sessionSecretValue
    previousSessionSecretValue
  ]
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

module collection 'collector.bicep' = if (collectionEnabled) {
  name: 'collection-workers'
  params: {
    location: location
    tags: tags
    namePrefix: functionAppName
    collectorImage: collectorImage
    keyVaultUri: keyVault.properties.vaultUri
    keyVaultName: keyVault.name
    redisHost: redisEnterprise.properties.hostName
    redisNamespace: 'azure-dashboard'
    controlRepository: collectorControlRepository
    githubAppId: collectorGithubAppId
    maximumWorkers: collectorMaximumWorkers
    lakeStorageSku: collectorLakeStorageSku
    applicationInsightsConnectionString: insights.properties.ConnectionString
    logAnalyticsWorkspaceResourceId: logAnalyticsWorkspaceResourceId
  }
  dependsOn: [
    collectorPrivateKeyValue
    collectorRedisPasswordValue
    redisConnectionStringValue
  ]
}

output collectionEnabled bool = collectionEnabled
output functionHostName string = functionApp.properties.defaultHostName
output githubOAuthRedirectUri string = githubRedirectUri
output redisEnterpriseHostName string = redisEnterprise.properties.hostName
output redisDatabaseName string = redisDatabase.name
output keyVaultUri string = keyVault.properties.vaultUri
