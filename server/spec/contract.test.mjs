import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const directory = dirname(fileURLToPath(import.meta.url))
const implementation = readFileSync(join(directory, '../internal/server/server.go'), 'utf8')
const openapi = JSON.parse(readFileSync(join(directory, 'generated/openapi.json'), 'utf8'))

test('every registered HTTP route has a TypeSpec operation (except MCP and static assets)', () => {
  const registered = [...implementation.matchAll(/register\("(GET|POST) (\/[^"]+)"/g)]
    .map(([, method, path]) => `${method.toLowerCase()} ${path}`)
    .sort()
  const documented = Object.entries(openapi.paths)
    .flatMap(([path, operations]) => Object.keys(operations)
      .filter(method => ['get', 'post'].includes(method))
      .map(method => `${method} ${path}`))
    .sort()
  assert.deepEqual(documented, registered)
})

test('the generated contract describes the implemented security and wire formats', () => {
  assert.equal(openapi.openapi, '3.1.0')
  const query = openapi.paths['/api/v1/query'].post
  assert.ok(query.security.some(entry => 'BearerAuth' in entry))
  assert.ok(query.security.some(entry => 'ApiKeyAuth' in entry))
  assert.ok(query.responses['422'].content['application/json'])
  assert.ok(query.requestBody.content['application/json'])
  assert.ok(query.parameters.some(parameter => parameter.name === 'X-CSRF-Token'))
  assert.ok(openapi.paths['/api/auth/session'].get.security.some(entry => 'ApiKeyAuth' in entry))
  assert.equal(openapi.paths['/api/health'].get.security, undefined)
  assert.equal(openapi.paths['/api/github/webhook'].post.security, undefined)
  assert.ok(openapi.paths['/api/v1/events'].get.responses['200'].content['text/event-stream'])
  assert.ok(openapi.paths['/api/github/webhook'].post.responses['202'])
  assert.ok(openapi.paths['/api/admin/rebuild'].post.responses['202'])
  assert.ok(openapi.paths['/auth/logout'].post.responses['204'])
  assert.equal(openapi.components.securitySchemes.ApiKeyAuth.name, 'cao_session')
  for (const field of ['pushedDown', 'fallbackOperations']) {
    assert.ok(openapi.components.schemas.QueryMetrics.properties[field].anyOf.some(branch => branch.type === 'null'))
  }
  for (const field of ['redisCommands', 'redisRows']) {
    assert.equal(openapi.components.schemas.QueryMetrics.properties[field], undefined)
  }
  assert.equal(openapi.components.schemas.HealthResponse.properties.generation, undefined)
  assert.equal(openapi.components.schemas.RebuildStatus.properties.generation, undefined)
  assert.deepEqual(
    {
      type: openapi.components.schemas.DataState.properties.evaluatedAt.type,
      format: openapi.components.schemas.DataState.properties.evaluatedAt.format
    },
    { type: 'string', format: 'date-time' }
  )
})

test('structured payload fields stay in sync with Go JSON tags', () => {
  const pairs = [
    ['../internal/server/server.go', 'queryRequest', 'QueryRequest'],
    ['../internal/server/server.go', 'queryResponse', 'QueryResponse'],
    ['../internal/query/types.go', 'Definition', 'QueryDefinition'],
    ['../internal/model/model.go', 'Source', 'QuerySource'],
    ['../internal/model/model.go', 'Metrics', 'QueryMetrics'],
    ['../internal/server/operations.go', 'rebuildStatus', 'RebuildStatus'],
    ['../internal/collect/recovery.go', 'Status', 'CollectionStatus'],
    ['../internal/githubquota/usage.go', 'UsageReport', 'QuotaUsage'],
    ['../internal/repositorymemory/memory.go', 'Campaign', 'MemoryCampaign']
  ]
  for (const [file, name, schema] of pairs) {
    const source = readFileSync(join(directory, file), 'utf8')
    const fields = source.match(new RegExp(`type ${name} struct \\{([\\s\\S]*?)\\n\\}`))?.[1]
    assert.ok(fields, `missing Go struct ${name}`)
    const goFields = [...fields.matchAll(/`json:"([^",]+)(?:,omitempty)?"`/g)]
      .map(([, field]) => field).sort()
    const specFields = Object.keys(openapi.components.schemas[schema].properties).sort()
    assert.deepEqual(specFields, goFields, `${schema} differs from ${file}:${name}`)
  }
})

test('selected JSON Schemas and nullable responses are emitted', () => {
  for (const schema of ['QueryRequest', 'QueryResponse', 'QueryDefinition', 'RevisionEvent', 'WebhookAcknowledgement']) {
    const document = JSON.parse(readFileSync(join(directory, 'generated/schemas', `${schema}.json`), 'utf8'))
    assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema')
    assert.ok(document.properties)
  }
  assert.deepEqual(
    readdirSync(join(directory, 'generated/schemas')).sort(),
    ['QueryDefinition.json', 'QueryRequest.json', 'QueryResponse.json', 'RevisionEvent.json', 'WebhookAcknowledgement.json']
  )
  const campaign = openapi.paths['/api/v1/memory/{campaign}'].get.responses['200'].content['application/json'].schema
  assert.ok(campaign.anyOf.some(branch => branch.type === 'null'))
  for (const [path, response] of [
    ['/api/health', 'HealthResponse'],
    ['/api/v1/health', 'HealthResponse'],
    ['/api/readiness', 'ReadinessResponse']
  ]) {
    const schema = openapi.paths[path].get.responses['503'].content['application/json'].schema
    assert.ok(schema.anyOf.some(branch => branch.$ref === `#/components/schemas/${response}`), path)
    assert.ok(schema.anyOf.some(branch => branch.required?.includes('error')), path)
  }
})
