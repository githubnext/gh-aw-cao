# Local Azure Functions simulation

This Linux-only harness runs the CAO Azure Functions hosting boundary against
Azurite and a real PostgreSQL container. It uses no Azure subscription, Azure login,
Azure credentials, or production secrets. It does not
emulate managed identity, Key Vault, deployed networking, Azure edge behavior,
or managed PostgreSQL TLS; those remain real-Azure smoke-test concerns.

## Prerequisites

- Linux with Bash, Docker, Go, Node.js, Python 3, curl, `flock`, unzip, and
  `setsid`
- A running Docker daemon

Azure Functions Core Tools 4.15.1 is downloaded on first use from its official
GitHub release and verified by SHA-256. PostgreSQL 16 and Azurite 3.37.0 images
are pinned by tag or digest.

Run the complete suite:

```bash
./scripts/azure-local/azure-local.sh run
```

The dispatcher also supports iterative use:

```bash
./scripts/azure-local/azure-local.sh start
./scripts/azure-local/azure-local.sh wait
./scripts/azure-local/azure-local.sh test
./scripts/azure-local/azure-local.sh logs
./scripts/azure-local/azure-local.sh stop
```

`run` always stops its services, including after a test failure or interruption.
`stop` is idempotent. It removes generated settings and transient state while
logs remain under `.tmp/azure-local/<run>/logs/`. Set
`AZURE_LOCAL_STATE_DIR` to use an explicit isolated state directory or run
several stacks in parallel. Set `AZURE_LOCAL_WAIT_TIMEOUT` to change the
120-second readiness deadline.

## Process model

Each run owns a state directory, a uniquely named PostgreSQL container, a uniquely
named Azurite container, a Functions Core Tools process group, generated
Functions metadata, dynamically published loopback ports, and unique canonical
and operational namespaces. The state records exact process/container identities; teardown never
uses global process discovery. Fixed internal container ports are published to
dynamic host ports to avoid collisions.

Readiness polling verifies PostgreSQL readiness, an Azurite Blob endpoint response, and
the CAO `/api/readiness` endpoint through Functions Core Tools. Timeouts print
all available service logs and fail.

Build, canonical and operational database bootstrap, and fixture ingestion
failures print the failed stage, exit status, and captured output before teardown.
Their log files remain available alongside the service logs. Fixture ingestion
verifies the checked-in `server/testdata/deployed-subset/payload-hashes.json`
manifest; a mismatch fails startup rather than skipping or weakening integrity
checks.

## Repository audit checklist

Before changing this harness:

- inspect `server/internal/server/azure.go` and the `cao-functions` custom
  handler entrypoint;
- inspect hosted environment validation and retain production PostgreSQL TLS
  and HTTPS requirements;
- inspect the PostgreSQL operational namespace, rate-limit, ingestion, and integration tests;
- inspect `server/azure/main.bicep` and its contract tests without changing the
  production deployment contract for local convenience;
- inspect existing dashboard build, server test fixtures, Docker, and GitHub
  Actions conventions;
- confirm all local settings are synthetic and no workflow secret or Azure
  credential is required.

## First end-to-end contract

The integration test enters through the real Functions HTTP surface. It proves
that Core Tools registers and forwards the CAO routes, health/readiness reach
shared server logic and PostgreSQL, and PostgreSQL-backed pre-authentication
rate-limit state survives separate HTTP requests. Missing reviewed host policy
still makes the custom handler fail predictably. Azurite is exercised only as
Functions runtime storage.
