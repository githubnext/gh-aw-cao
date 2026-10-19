import { hostAssertionModule } from "../../../../scripts/native-host-assertion-value.mjs";

const value = hostAssertionModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "smoke-goose",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "1a509b6c1c8c4985734eeade222eb9bba3192286",
  "interpreterSha256": "15df6030cce347982f0e5056f0e4bdd98539898a79395e3cdcae597b71fb1403",
  "name": "Smoke Goose",
  "goal": "Maintain the declared pinned Goose runtime and native GitHub MCP/session smoke conjunction.",
  "acceptance": "The protected host requires checksum-verified source-declared Goose, a completed structured run, correlated successful native GitHub MCP requests/responses, canonical matched session events, independently merged PR identities and the remaining declared smoke fixtures.",
  "metricLabel": "Verified Goose smoke assessments",
  "unit": "smoke proofs",
  "gates": [
    {
      "job": "agent",
      "name": "Assert Goose smoke evidence",
      "meaning": "The complete source-defined Goose host conjunction establishes native runtime/MCP/session capability."
    }
  ],
  "limitations": [
    "Native assertions are one conjunction, not independently counted feature deliveries. Fixture booleans and file existence alone do not establish compilation correctness; full build behavior, telemetry and exclusive causation remain separate.",
    "A historical pinned-runtime MCP proof does not certify the current Goose version or absence of every parser/session error. Historical parser validity beyond the protected assertions remains separate."
  ],
  "jobs": {
    "agent": {
      "name": "agent",
      "sha256": "8513f50be14106cee7574b9131503c4863bc977c926b0ed5b31824c08b0b4d56"
    }
  },
  "adoption": {
    "commit": "57b002417b2f0be0cd5b86325af2d6121c53d314",
    "adoptedAt": "2026-08-04T05:10:51Z",
    "baselineCommit": "cd85bff63f8535f58de6887345dec11fd0e70ec5",
    "baselineAt": "2026-08-04T05:07:32Z"
  },
  "dependencies": [
    {
      "path": ".github/aw/engines.json",
      "gitBlob": "630cb555f8513c3804a26fbe95ca0a6720761803"
    },
    {
      "path": "actions/setup/js/parse_goose_log.cjs",
      "gitBlob": "07be6874f2771f27a99a379032d7b434d617e65d"
    }
  ],
  "runtimeTrees": [
    {
      "path": "actions",
      "gitTree": "ba2d5737336b9a68bb5d493cb5da012b3ff329c0"
    },
    {
      "path": ".github/workflows/shared",
      "gitTree": "99472ca203e6cdbfd7ab8b1a2fa18db9d5959835"
    }
  ],
  "historicalSourceProfiles": [
    {
      "sourceRevision": "e6b87a4f169c7d194aa5f862f9b6e983ad11d3ae",
      "jobs": {
        "agent": {
          "name": "agent",
          "sha256": "b51d1596e496645e52f48b12d355a506380406c0df861eb09c2e7a3893ef34d0"
        }
      },
      "dependencies": [
        {
          "path": ".github/aw/engines.json",
          "gitBlob": "630cb555f8513c3804a26fbe95ca0a6720761803"
        },
        {
          "path": "actions/setup/js/parse_goose_log.cjs",
          "gitBlob": "c265f0be65a88bcd6fef3b3de39c55a61f5ae454"
        }
      ],
      "runtimeTrees": [
        {
          "path": "actions",
          "gitTree": "67d3cfccbaa9ec2ef96e2f1256797932c134b6ee"
        },
        {
          "path": ".github/workflows/shared",
          "gitTree": "084985a9d859789ddd639132f155fb4791765971"
        }
      ],
      "review": "Source intent and native MCP predicates are preserved across the declared runtime pin change. The protected smoke conjunction differs only in its declared checksum-verified Goose pin (1.53.0 versus 1.54.0). Raw native GitHub MCP request/response correlation and independent merged-PR reads are identical. The older parser has weaker metadata, tool-exit and error preservation; this receipt does not establish error-free sessions, corrected parser semantics, full compilation correctness or current-version capability. Historical runtime trees remain pinned as complete profiles, never mixed with current jobs."
    }
  ]
});
export const { collectBatch, scoreMetric } = value;
export const definition = { ...value.definition, evidence: { ...value.definition.evidence,
  sourceProfilesSha256: "227aac5c819d778fe3319e6f72a57369ae0aa1df08885028de2847addd2b65d0" } };
