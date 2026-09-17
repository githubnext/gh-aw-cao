# Activity cache compression analysis

On 2026-09-17, the deployed `cao-activity-index` snapshot was downloaded and
queried with the `cao` CLI. The snapshot was healthy, covered six repositories,
and contained 23,566 runs, 17,214 jobs, 3,203 sessions, and 117,707 events after
the CLI's 30-day repair pass.

## Stored data

The artifact expanded to 2.65 GB:

| Component | Files | Bytes |
| --- | ---: | ---: |
| Source JSONL shards | 510 | 1,018,050,345 |
| Run-information shards | 512 | 830,439,845 |
| Event shards | 512 | 596,008,119 |
| SQLite projection | 1 | 201,728,000 |
| Compressed Actions artifact | 1 | 202,156,751 |

The source directory held 85 generations for each of six repository prefixes.
Its 82,436 JSONL envelopes comprised:

| Kind | Records | Bytes | Share |
| --- | ---: | ---: | ---: |
| `run` | 41,028 | 736,545,018 | 72.3% |
| `workflow_runs` | 5,722 | 273,168,443 | 26.8% |
| `safe_output_item` | 35,176 | 8,222,126 | 0.8% |
| `github_api_rate_limit` | 510 | 114,758 | <0.1% |

Within `run` envelopes, audit payloads accounted for 536,575,181 bytes. MCP
tool usage (43,168,562 bytes), job details (30,802,140 bytes), graders
(15,465,518 bytes), and token summaries (15,300,106 bytes) were the next
largest fields. These fields are useful: they supply the event timeline and the
run-level operational, usage, firewall, and tool aggregates.

## Event use

The most frequent canonical events were:

| Type | Events | Serialized bytes |
| --- | ---: | ---: |
| `tool.call` | 23,267 | 16,060,892 |
| `tool.error` | 23,267 | 16,200,500 |
| `audit.observability` | 18,455 | 12,015,112 |
| `audit.finding` | 7,065 | 4,470,959 |
| `net_allowed` | 6,028 | 4,250,565 |
| `safe_output.created` | 4,214 | 3,012,552 |
| `workflow_run_grader` | 4,207 | 3,822,192 |
| `audit.recommendation` | 4,092 | 2,792,014 |

The paired MCP events are required by the dashboard mapping contract: each
aggregate tool-call item emits a start and terminal result/error event. The
largest repeated canonical fields were provenance (18.2 MB), IDs (12.1 MB),
session IDs (9.8 MB), and run IDs (4.9 MB). They are join and traceability
keys, so removing them would trade correctness for size.

## Bloat

The dominant avoidable cost was retaining every refresh generation:

- 62,769 of 82,436 source lines were exact duplicates.
- Exact duplicate lines occupied 403,315,306 bytes, or 39.6% of source JSONL.
- All 3,203 enriched run identities appeared more than once, with 41,028 run
  observations in total.
- Per-shard normalization repeated canonical entities. The 510 source shards
  independently produced 563,779 runs and 807,693 events before stable IDs
  collapsed them to 23,566 runs and 117,707 events in SQLite.
- Two zero-byte JSONL files were present. They contain no evidence but prevented
  an unmodified `cao download` from completing because downloads reject empty
  payloads.

Removing fields from run or event records offers smaller savings and risks
breaking provenance, joins, or the documented event lifecycle. Compressing
files with gzip would reduce transfer but would not reduce normalization work,
duplicate IndexedDB writes, or uncompressed cache size.

## Fix and measured effect

The collector now consolidates each repository prefix after a successful
`gh aw logs` call. It removes byte-identical JSONL lines, retains their last
occurrence to preserve precedence, writes atomically, and leaves the previous
cache untouched when collection fails.

Replaying the deployed snapshot through this compaction reduced:

| Measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Source JSONL | 1,018,050,345 B | 614,736,164 B | 39.6% |
| Run-information shards | 830,439,845 B | 38,411,654 B | 95.4% |
| Event shards | 596,008,119 B | 89,245,428 B | 85.0% |
| Combined source and phased data | 2,444,498,309 B | 742,393,246 B | 69.6% |
| Representative ZIP including SQLite | 202,156,751 B | 86,051,814 B | 57.4% |

The larger phased-shard reduction comes from normalizing one consolidated
source per repository: stable canonical IDs are then deduplicated across
refresh generations before the transport shard is serialized.
