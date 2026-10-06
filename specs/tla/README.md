# Operational server mode model

`ServerOperationalStorage.tla` is the bounded TLA+ companion to
[`../server-operational-storage.md`](../server-operational-storage.md).
It checks the local browser preview and both explicit Go operational backends
against one immutable resolved policy.

## Bounds and assumptions

Both TLC configurations use two distinct jobs, one pending-work slot, and one
application-process restart. Initial states enumerate all three requested modes
and nine topology records: a valid hosted topology and independent violations
of OAuth, HTTPS, process-owned listener, one process, one replica, volatile
acknowledgement, co-location, or positive collection worker count. Collection
is enabled in this model. Redis may use separately owned workers and does not
require memory's one-process acknowledgements.

The Redis configuration assumes a restart-persistent operational namespace
survives an **application** restart. It does not prove Redis-server crash
durability or apply that assumption to a process-isolated provider profile.
The memory configuration intentionally clears operational state on close.
Evidence remains durable in both configurations, outside operational storage.
Session identities are abstracted to their issuing process epoch; GitHub-issued
credentials are outside the model and are not claimed to expire on restart.

Jobs represent currently authorized work under the immutable resolved policy.
Redis startup assumes usable authorized enrollment has been restored from its
restart-persistent namespace; it does not impose memory's new bootstrap gate.
`Bootstrap` abstracts memory's complete fresh authorized enumeration. Partial enumeration
cannot take that action. Bootstrap progress assumes such enumeration eventually
succeeds and is weakly fairly scheduled. Shutdown progress assumes worker join
and store close are weakly fairly scheduled. Completion and restarts are not
assumed fair, so the model does **not** claim every accepted job eventually
completes, particularly across a memory restart.

Terminal browser, rejected, and closed states intentionally have no required
transition. TLC deadlock reporting is therefore disabled; explicit bootstrap
and shutdown temporal properties check the required progress instead.

## Checked properties and implementation correspondence

| Property | Implementation boundary |
| --- | --- |
| Policy authority; browser isolation | Local CLI mode parser, `serve-hosted --operational-store`, production composed policy loader |
| Memory topology and security | Host-policy resolution, operational factory, centralized capability validation |
| Bootstrap/admission gates | Volatile recovery and collection HTTP admission |
| Pending-work capacity; atomic delivery/task identity | Shared operational adapter admission contracts and conformance tests |
| Backfill checkpoint after admission | Collection/backfill checkpoint transitions |
| Owner-checked work | Lease ownership and completion transitions |
| Memory session epochs and explicit loss | Fresh login/session state and bounded volatile adapter |
| Join before close; eventual shutdown | Go application/worker lifecycle and launcher child-close handling |
| Retained evidence; Redis restart state | Evidence lake outside adapters; restart-persistent Redis namespace |

The model abstracts away clock-driven TTLs, encryption, refresh CAS, remote
revocation, signature verification, GitHub scope identities and shard collisions,
database ingestion/query correctness, allocator memory, and network failures.
It is a checked specification of these transitions, not a proof that the Go,
JavaScript, Redis scripts, or external systems implement them. Adapter, HTTP,
startup/recovery, policy-parity, and launcher tests remain required.

## Running TLC

Use Java 21 and the official
[`tla2tools.jar` v1.7.4](https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar).
Keep downloaded tools and TLC state outside tracked source files. From the
repository root, set `TLA2TOOLS_JAR` to that local jar and run:

```bash
java -Xmx512m -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers 1 \
  -metadir test-results/tla/redis \
  -config specs/tla/ServerOperationalStorage.redis.cfg \
  specs/tla/ServerOperationalStorage.tla
java -Xmx512m -cp "$TLA2TOOLS_JAR" tlc2.TLC -workers 1 \
  -metadir test-results/tla/memory \
  -config specs/tla/ServerOperationalStorage.memory.cfg \
  specs/tla/ServerOperationalStorage.tla
```

A successful run must report no invariant or temporal-property violations.
Both configurations are required: memory intentionally weakens restart
durability, not admission atomicity, authorization, capacity, or ownership.
