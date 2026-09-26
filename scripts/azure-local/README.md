# Local Azure Functions simulation

This Linux-only harness runs the CAO Azure Functions hosting boundary against
Azurite and a real Redis container. It uses no Azure subscription, Azure login,
Azure credentials, production secrets, or Coolify configuration. It does not
emulate managed identity, Key Vault, deployed networking, Azure edge behavior,
or Azure Managed Redis TLS; those remain real-Azure smoke-test concerns.

## Prerequisites

- Linux with Bash, Docker, Go, Node.js, npm, Python 3, curl, unzip, and `setsid`
- A running Docker daemon

Azure Functions Core Tools 4.15.1 is downloaded on first use from its official
GitHub release and verified by SHA-256. Redis 7.4.7 and Azurite 3.37.0 container
tags are pinned. Dashboard npm dependencies are installed automatically when
missing.

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
`stop` is idempotent. Logs remain under `.tmp/azure-local/<run>/logs/`; generated
settings and transient state remain outside version control. Set
`AZURE_LOCAL_STATE_DIR` to use an explicit isolated state directory or run
several stacks in parallel. Set `AZURE_LOCAL_WAIT_TIMEOUT` to change the
120-second readiness deadline.

## Process model

Each run owns a state directory, a uniquely named Redis container, a uniquely
named Azurite container, a Functions Core Tools process group, generated
Functions metadata, dynamically published loopback ports, and a unique Redis
namespace. The state records exact process/container identities; teardown never
uses global process discovery. Fixed internal container ports are published to
dynamic host ports to avoid collisions.

Readiness polling verifies Redis `PING`, an Azurite Blob endpoint response, and
the CAO `/api/readiness` endpoint through Functions Core Tools. Timeouts print
all available service logs and fail.

## Repository audit checklist

Before changing this harness:

- inspect `server/internal/server/azure.go` and the `cao-functions` custom
  handler entrypoint;
- inspect hosted environment validation and retain production `rediss://` and
  HTTPS requirements;
- inspect the Redis namespace, rate-limit, ingestion, and integration tests;
- inspect `server/azure/main.bicep` and its contract tests without changing the
  production deployment contract for local convenience;
- inspect existing dashboard build, server test fixtures, Docker, and GitHub
  Actions conventions;
- confirm all local settings are synthetic and no workflow secret or Azure
  credential is required.

## First end-to-end contract

The integration test enters through the real Functions HTTP surface. It proves
that Core Tools registers and forwards the CAO routes, health/readiness reach
shared server logic and Redis, Redis-backed pre-authentication rate-limit state
survives separate HTTP requests, a second namespace remains isolated, and a
missing local Redis setting makes the custom handler fail predictably. Azurite
is exercised only as Functions runtime storage.
