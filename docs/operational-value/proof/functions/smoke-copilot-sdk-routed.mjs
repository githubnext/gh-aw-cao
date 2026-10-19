import { hostAssertionModule } from "../../../../scripts/native-host-assertion-value.mjs";

const value = hostAssertionModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "smoke-copilot-sdk-routed",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "656e302e94558ed728da2fe9102c69f111b99d35",
  "interpreterSha256": "15df6030cce347982f0e5056f0e4bdd98539898a79395e3cdcae597b71fb1403",
  "name": "Smoke Copilot SDK Routed",
  "goal": "Route SDK main inference to GPT and actually delegate the declared cross-family Haiku agent.",
  "acceptance": "Actual gpt-5.6-luna main requests on /responses and exactly one successful named haiku-whoami delegation on claude-haiku-4.5 /chat/completions satisfy the protected routing conjunction.",
  "metricLabel": "Verified SDK routing and delegation",
  "unit": "routing proofs",
  "gates": [
    {
      "job": "agent",
      "name": "Assert model-routing and sub-agent evidence",
      "meaning": "Actual gpt-5.6-luna main requests on /responses and exactly one successful named haiku-whoami delegation on claude-haiku-4.5 /chat/completions satisfy the protected routing conjunction."
    }
  ],
  "limitations": [
    "Issue reports and trivial task answers are not native routing or delegation evidence."
  ],
  "jobs": {
    "agent": {
      "name": "agent",
      "sha256": "280a2d11580619d467895bdb708d135f57dfd4883e684850ad36022bd17d4e8e"
    }
  },
  "adoption": {
    "commit": "feb7220049159029fa73892e84db65971c7a642c",
    "adoptedAt": "2026-10-10T23:48:43Z",
    "baselineCommit": "9ded0021d4384be185b8009aaf1e27fcbda9265a",
    "baselineAt": "2026-10-10T23:48:20Z"
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
          "sha256": "15fa0fce2bf7d59ec1c7552d7975151827739eb0cb5b72affc50a53970115c61"
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
  sourceProfilesSha256: "a9dc98158ae808b0f42da3f08d9ad186c5f6948f304f8bff6f371937ffe5e24f" } };
