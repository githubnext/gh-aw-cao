import { ledgerProjectionModule } from "../../../../scripts/native-ledger-projection-value.mjs";

export const { definition, collectBatch, scoreMetric } = ledgerProjectionModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "smoke-repo-memory-ledger",
  "ledgerName": "smoke",
  "name": "Smoke Repo-Memory Ledger",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "sourceGitBlob": "6cc01307b7fd5c69e1d8230bd5b499363159911d",
  "until": "2026-10-18T15:00:12Z",
  "config": {
    "name": "smoke",
    "max_segment_kb": 100,
    "type": "table",
    "key": "workflow_run_id",
    "schema": {
      "type": "object",
      "required": [
        "record_type",
        "workflow_run_id",
        "result"
      ],
      "properties": {
        "record_type": {
          "enum": [
            "repo_memory_ledger_smoke"
          ]
        },
        "workflow_run_id": {
          "type": "string"
        },
        "result": {
          "enum": [
            "passed"
          ]
        }
      },
      "additionalProperties": false
    },
    "max-record-kb": 4,
    "max-patch-kb": 10
  },
  "goal": "Preserve source-defined run fixtures as correctly replayable durable ledger state.",
  "acceptance": "The pinned production canonical reconstruction, built-in reducer and SQLite materializer restore the independent expected fixture rows exactly in a read-only database.",
  "limitation": "Partial durable table-upsert round-trip facet; actual historical agent inspection and unrelated ledger diagnostics are not established.",
  "nativeSources": [
    {
      "file": "ledger_replay.cjs",
      "path": "actions/setup/js/ledger_replay.cjs",
      "gitBlob": "f03410953f0716321944df48f0ac324f81f6de48",
      "sha256": "b11b13b62e9ff65f7049af3f006f2a869298a10d9515f0564e9f5d948ed0b4ed"
    },
    {
      "file": "ledger_builtin.cjs",
      "path": "actions/setup/js/ledger_builtin.cjs",
      "gitBlob": "823dc360e0342ba4d55133e127080ca221120dad",
      "sha256": "0b27d55f3b387f9942b730facf5ea0ddeec9a900c0400246e7322dbdbb6814a4"
    },
    {
      "file": "schema-validation.cjs",
      "path": "actions/setup/js/schema-validation.cjs",
      "gitBlob": "a3e854b82572410ac1c57b9a6f74e3aae8fbd243",
      "sha256": "ccfd4ac03e48b224802896130f50f10fda61699369c60fdf05933656a52c09ac"
    },
    {
      "file": "ledger_store.cjs",
      "path": "actions/setup/js/ledger_store.cjs",
      "gitBlob": "09bb9c5d0c40844985f2bc61b96d504153f25b12",
      "sha256": "687a434b29c7dd2a6e40b6af783aad69cf70ac1ccc710d25a9a5fe02bd2d5dce"
    },
    {
      "file": "memory_schema_contract.cjs",
      "path": "actions/setup/js/memory_schema_contract.cjs",
      "gitBlob": "f40351df7c2a914ca8f0ca99d1e7c65f65e6dcaa",
      "sha256": "82512ebedf3b8477b99a34a5d4265dbda4faf1fb7e382fc8802eae03e24b6eda"
    },
    {
      "file": "jsonl_helpers.cjs",
      "path": "actions/setup/js/jsonl_helpers.cjs",
      "gitBlob": "94516ced21f68d227e36cbe74240928d526346a7",
      "sha256": "22b15b6b37f85b31463f8a0843467368b6bf156ccec30e9ae80273b57d449aab"
    },
    {
      "file": "json_schema_validation.cjs",
      "path": "actions/setup/js/json_schema_validation.cjs",
      "gitBlob": "423cdb9b6016dc03d58a49cf01276899ddaa2666",
      "sha256": "2fd2c075d0eeadcb8de8b75f1b9adcc8e22e30493d3687105d186c05143a7d93"
    }
  ],
  "interpreterSha256": "3867cf101cd12bf2423f259339cbdb784912faf06ba0bfaec15f0107e243bd91",
  "oracleSha256": "3ca2054e813988a292e3645097d34a60676be5447d9f9e1a3f8e71073a2f870c",
  "adoption": {
    "commit": "f94c97ff9e5bdbf0b6fd8c8b2efe645372c0bbcc",
    "adoptedAt": "2026-09-29T20:11:09Z",
    "baselineCommit": "7f70ca078f5b728b75f055e3cf6cbf0b3bcc1f61",
    "baselineAt": "2026-09-29T19:45:24Z"
  }
});
