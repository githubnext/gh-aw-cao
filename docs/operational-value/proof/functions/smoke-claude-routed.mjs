import { hostAssertionModule } from "../../../../scripts/native-host-assertion-value.mjs";

const value = hostAssertionModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "smoke-claude-routed",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "68030a4ac69ca1d0a72a8d6845423ae9f48a7bc7",
  "interpreterSha256": "15df6030cce347982f0e5056f0e4bdd98539898a79395e3cdcae597b71fb1403",
  "name": "Smoke Claude Routed",
  "goal": "Route Claude inference according to the declared allowed-model and endpoint policy.",
  "acceptance": "The protected source-defined routing gate requires actual runner/proxy evidence, selected allowed model, classification and real main-agent requests on the declared endpoint.",
  "metricLabel": "Verified Claude routing assessments",
  "unit": "routing proofs",
  "gates": [
    {
      "job": "agent",
      "name": "Assert model-routing evidence",
      "meaning": "The configured Claude main-routing conjunction is independently established."
    }
  ],
  "limitations": [
    "This measures routing, not the trivial echo task or its issue report."
  ],
  "jobs": {
    "agent": {
      "name": "agent",
      "sha256": "0d8cdafe358f5102ce6bd9637b7fa577e21cac996a83d6a39622f28910de3e6a"
    }
  },
  "adoption": {
    "commit": "30a04c3b85ed45b2cd1bacb62339faf7c681a7b5",
    "adoptedAt": "2026-10-12T15:35:54Z",
    "baselineCommit": "6ec0aa63b1f60dfca390cfd80b7507ff68136edf",
    "baselineAt": "2026-10-12T15:12:53Z"
  },
  "dependencies": [
    {
      "path": ".github/aw/engines.json",
      "gitBlob": "630cb555f8513c3804a26fbe95ca0a6720761803"
    },
    {
      "path": "actions/setup/js/smoke_model_routing_assertions.cjs",
      "gitBlob": "5ad3b388c9d9a5ba7e3495759a447c7fee856f9f"
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
      "sourceRevision": "463762fe9304d5271356803513f158cf59dc0171",
      "jobs": {
        "agent": {
          "name": "agent",
          "sha256": "701947959d126457c41f08447b6b751bb73e488d5f9eef7e4dc01fc832dc1f3d"
        }
      },
      "dependencies": [
        {
          "path": ".github/aw/engines.json",
          "gitBlob": "630cb555f8513c3804a26fbe95ca0a6720761803"
        },
        {
          "path": "actions/setup/js/smoke_model_routing_assertions.cjs",
          "gitBlob": "5ad3b388c9d9a5ba7e3495759a447c7fee856f9f"
        }
      ],
      "runtimeTrees": [
        {
          "path": "actions",
          "gitTree": "8bde65a297d295f5db9d0576b0e486d08bb1585b"
        },
        {
          "path": ".github/workflows/shared",
          "gitTree": "c716ab0399d143fdca8d32b9e6b52553f89df373"
        }
      ],
      "review": "Source intent and native predicate steps are identical. Reviewed differences: read-only artifact export paths, Copilot CLI minimum-version configuration, and Pi model-alias/error-reporting integration. The session merger's added model.resolution events do not satisfy routing assertions. Historical runtime trees remain pinned as complete profiles, never mixed with current jobs."
    }
  ]
});
export const { collectBatch, scoreMetric } = value;
export const definition = { ...value.definition, evidence: { ...value.definition.evidence,
  sourceProfilesSha256: "e17783da134b34dabece5cb1d0801f9d68f3ac9f2b4a9b783e1df064e0c56062" } };
