// Optional collection workers for the server ingestion profile.
//
// This module deploys nothing unless a collector image is supplied, so the
// default deployment stays exactly as it is: a Function App serving the
// dashboard from snapshots published by the Activity workflow.
//
// The workers run the same binary as the server in the `collect` role and
// scale on the Redis stream backlog, so collection capacity follows event
// volume instead of being provisioned for the peak.

@description('Location for the collection workers.')
param location string

@description('Resource tags.')
param tags object

@minLength(3)
@description('Name prefix for the collection resources.')
param namePrefix string

@description('Container image running the collection role.')
param collectorImage string

@description('Key Vault URI holding the collection secrets.')
param keyVaultUri string

@description('Key Vault resource name, used to grant the workers secret access.')
param keyVaultName string

@description('Size of the evidence lake file share, in gibibytes.')
@minValue(100)
param lakeQuotaGigabytes int = 1024

@description('Redis host the KEDA scaler polls for stream backlog.')
param redisHost string

@description('Redis port the KEDA scaler polls.')
param redisPort int = 10000

@description('Redis key namespace shared with the server.')
param redisNamespace string

@description('Control repository used for logical source discovery.')
param controlRepository string

@description('GitHub App identifier whose installations define ingestion scope.')
param githubAppId string

@description('Minimum number of collection workers. Zero scales to nothing when idle.')
@minValue(0)
param minimumWorkers int = 0

@description('Maximum number of collection workers.')
@minValue(1)
param maximumWorkers int = 20

@description('Stream backlog per worker before another worker is added.')
@minValue(1)
param backlogPerWorker int = 25

var lakeStorageAccountName = '${toLower(take(replace(namePrefix, '-', ''), 7))}lake${uniqueString(resourceGroup().id, namePrefix)}'
var streamKey = '${redisNamespace}:collect:tasks'
var consumerGroup = 'collectors'

resource collectorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-collector-identity'
  location: location
  tags: tags
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource collectorSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, collectorIdentity.id, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-collectors'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
  }
}

// The evidence lake is retained collected evidence, not a cache: cold start
// replays it without contacting GitHub. It is shared by every worker and by
// the projector, so it lives on a file share rather than in container storage.
resource lakeAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: lakeStorageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource lakeFileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: lakeAccount
  name: 'default'
}

resource lakeShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: lakeFileService
  name: 'evidence-lake'
  properties: {
    shareQuota: lakeQuotaGigabytes
    enabledProtocols: 'SMB'
  }
}

resource lakeStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'evidence-lake'
  properties: {
    azureFile: {
      accountName: lakeAccount.name
      shareName: lakeShare.name
      accessMode: 'ReadWrite'
      accountKey: lakeAccount.listKeys().keys[0].value
    }
  }
}

var collectionEnvironment = [
  {
    name: 'CAO_REDIS_URL'
    secretRef: 'cao-redis-url'
  }
  {
    name: 'CAO_REDIS_NAMESPACE'
    value: redisNamespace
  }
  {
    name: 'CAO_COLLECT_APP_ID'
    value: githubAppId
  }
  {
    name: 'CAO_COLLECT_PRIVATE_KEY'
    secretRef: 'cao-collect-private-key'
  }
  {
    name: 'CAO_COLLECT_LAKE_DIRECTORY'
    value: '/evidence'
  }
  {
    name: 'CAO_COLLECT_CATALOG_ROOT'
    value: '/app'
  }
  {
    name: 'CAO_COLLECT_CONTROL_REPOSITORY'
    value: controlRepository
  }
]

var collectionSecrets = [
  {
    name: 'cao-redis-url'
    keyVaultUrl: '${keyVaultUri}secrets/cao-redis-url'
    identity: collectorIdentity.id
  }
  {
    name: 'cao-collect-private-key'
    keyVaultUrl: '${keyVaultUri}secrets/cao-collect-private-key'
    identity: collectorIdentity.id
  }
  {
    name: 'cao-redis-password'
    keyVaultUrl: '${keyVaultUri}secrets/cao-redis-password'
    identity: collectorIdentity.id
  }
]

resource collectors 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-collector'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${collectorIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: collectionSecrets
    }
    template: {
      containers: [
        {
          name: 'collector'
          image: collectorImage
          command: ['/app/cao-dashboard']
          args: ['collect']
          env: collectionEnvironment
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          volumeMounts: [
            {
              volumeName: 'evidence'
              mountPath: '/evidence'
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'evidence'
          storageType: 'AzureFile'
          storageName: lakeStorage.name
        }
      ]
      scale: {
        minReplicas: minimumWorkers
        maxReplicas: maximumWorkers
        rules: [
          {
            // Scaling on stream backlog, not on request rate: webhooks are
            // admitted by the server in constant time, and the backlog is the
            // only signal that reflects outstanding collection work.
            name: 'collection-backlog'
            custom: {
              type: 'redis-streams'
              metadata: {
                address: '${redisHost}:${redisPort}'
                stream: streamKey
                consumerGroup: consumerGroup
                pendingEntriesCount: string(backlogPerWorker)
                enableTLS: 'true'
              }
              auth: [
                {
                  // The scaler authenticates with the Redis access key alone.
                  // The full connection URL stays a worker secret so the
                  // scaler is not given more than it needs to read backlog.
                  secretRef: 'cao-redis-password'
                  triggerParameter: 'password'
                }
              ]
            }
          }
        ]
      }
    }
  }
}

// Cold start runs as a job rather than as part of a worker, so repopulating a
// database is an explicit, observable operation that can be re-run safely.
resource backfill 'Microsoft.App/jobs@2024-03-01' = {
  name: '${namePrefix}-backfill'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${collectorIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 7200
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: collectionSecrets
    }
    template: {
      containers: [
        {
          name: 'backfill'
          image: collectorImage
          command: ['/app/cao-dashboard']
          args: ['backfill']
          env: collectionEnvironment
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          volumeMounts: [
            {
              volumeName: 'evidence'
              mountPath: '/evidence'
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'evidence'
          storageType: 'AzureFile'
          storageName: lakeStorage.name
        }
      ]
    }
  }
}

output collectorIdentityPrincipalId string = collectorIdentity.properties.principalId
output collectorAppName string = collectors.name
output backfillJobName string = backfill.name
output taskStreamKey string = streamKey
