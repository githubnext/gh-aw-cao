import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const directory = dirname(fileURLToPath(import.meta.url))
const implementation = readFileSync(join(directory, '../internal/server/server.go'), 'utf8')
const openapi = JSON.parse(readFileSync(join(directory, 'generated/openapi.json'), 'utf8'))

test('every registered HTTP route has a TypeSpec operation (except static assets)', () => {
  const registered = [
    ...[...implementation.matchAll(/register\("(GET|POST) (\/[^"]+)"/g)]
      .map(([, method, path]) => `${method.toLowerCase()} ${path}`),
    ...[...implementation.matchAll(/mux\.Handle\("(GET|POST) (\/[^"]+)"/g)]
      .map(([, method, path]) => `${method.toLowerCase()} ${path}`)
  ].sort()
  const documented = Object.entries(openapi.paths)
    .flatMap(([path, operations]) => Object.keys(operations)
      .filter(method => ['get', 'post'].includes(method))
      .map(method => `${method} ${path}`))
    .sort()
  assert.deepEqual(documented, registered)
})

test('agent discovery describes public GET and body-free HEAD responses', () => {
  const operations = openapi.paths['/llms.txt']
  assert.ok(operations)
  for (const method of ['get', 'head']) {
    const operation = operations[method]
    assert.ok(operation, `${method} /llms.txt is documented`)
    assert.equal(operation.security, undefined, `${method} /llms.txt is public`)
    assert.deepEqual(operation.responses['200'].headers['Cache-Control'].schema.enum, ['no-store'])
    for (const status of ['429', '503']) {
      assert.ok(operation.responses[status], `${method} /llms.txt describes ${status}`)
    }
  }
  assert.equal(operations.get.responses['200'].content['text/plain; charset=utf-8'].schema.$ref, '#/components/schemas/AgentGuideText')
  assert.equal(openapi.components.schemas.AgentGuideText.type, 'string')
  assert.deepEqual(openapi.components.schemas.AgentGuideText.examples, [
    '# Central Agentic Ops dashboard server\n\nServer commit SHA: unknown\n'
  ])
  assert.deepEqual(operations.head.responses['200'].headers['content-type'].schema.enum, ['text/plain; charset=utf-8'])
  for (const status of ['429', '503']) {
    assert.ok(operations.get.responses[status].content['application/json'])
  }
  for (const response of Object.values(operations.head.responses)) {
    assert.equal(response.content, undefined, 'HEAD responses must not declare a body')
  }
})

test('the generated contract describes the implemented security and wire formats', () => {
  assert.equal(openapi.openapi, '3.1.0')
  assert.equal(openapi.info.version, '2.0.0')
  for (const path of ['/api/runs/{id}/jobs', '/api/runs/{id}/sessions', '/api/sessions/{id}/events']) {
    assert.equal(openapi.paths[path], undefined)
  }
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
  const mcp = openapi.paths['/mcp'].post
  assert.ok(mcp.security.some(entry => 'BearerAuth' in entry))
  assert.ok(mcp.parameters.some(parameter => parameter.name === 'X-GitHub-Actor'))
  assert.ok(mcp.parameters.some(parameter => parameter.name === 'X-GitHub-OIDC-Token'))
  assert.ok(mcp.requestBody.content['application/json'])
  assert.ok(mcp.responses['200'].content['application/json'])
  assert.ok(mcp.responses['202'])
  assert.ok(mcp.responses['404'])
  assert.ok(openapi.paths['/api/admin/rebuild'].post.responses['202'])
  const logs = openapi.paths['/api/admin/logs'].get
  assert.ok(logs.security.some(entry => 'BearerAuth' in entry))
  assert.ok(logs.security.some(entry => 'ApiKeyAuth' in entry))
  assert.equal(logs.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/ServerLogSnapshot')
  assert.ok(logs.parameters.some(parameter => parameter.name === 'X-GitHub-Actor'))
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
    ['../internal/server/logs.go', 'serverLogSnapshot', 'ServerLogSnapshot'],
    ['../internal/server/logs.go', 'serverLogRedis', 'ServerLogRedis'],
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

test('server log records preserve reserved wire names and date-time examples', () => {
  const record = openapi.components.schemas.ServerLogRecord
  assert.deepEqual(record.required, ['timestamp', 'namespace', 'message'])
  assert.deepEqual(record.properties, {
    timestamp: { type: 'string', format: 'date-time' },
    namespace: { type: 'string' },
    message: { type: 'string' }
  })
  assert.deepEqual(record.examples, [{
    timestamp: '2026-10-02T19:00:00Z',
    namespace: 'cao:server',
    message: 'listener ready'
  }])
  assert.equal(
    openapi.components.schemas.ServerLogSnapshot.properties.logs.items.$ref,
    '#/components/schemas/ServerLogRecord'
  )
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
    assert.ok(openapi.paths[path].get.responses['429'].content['application/json'], path)
  }
})
