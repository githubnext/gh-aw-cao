import { hostAssertionModule } from "../../../../scripts/native-host-assertion-value.mjs";

export const { definition, collectBatch, scoreMetric } = hostAssertionModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "daily-max-ai-credits-test",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "73a26ec771084e54d980c10a2e48696ce60763ca",
  "interpreterSha256": "15df6030cce347982f0e5056f0e4bdd98539898a79395e3cdcae597b71fb1403",
  "name": "Daily Max AI Credits Test",
  "goal": "Enforce the per-run one-credit inference cap through a genuine proxy rejection.",
  "acceptance": "The protected verifier establishes an AWF configuration cap of exactly one and a native firewall rejection event or engine-authenticated proxy 403 at that cap.",
  "metricLabel": "Verified per-run credit rejections",
  "unit": "enforcement proofs",
  "gates": [
    {
      "job": "verify_credit_limit",
      "name": "Verify per-run credit rejection",
      "meaning": "Configured one-credit cap and independently recorded per-run proxy rejection."
    }
  ],
  "limitations": [
    "A workload ending below the cap is not evidence of broken enforcement. Current verifier semantics are a frozen partial historical facet."
  ],
  "jobs": {
    "verify_credit_limit": {
      "name": "verify_credit_limit",
      "sha256": "b96d970502fcdfbd8a23aef001be29f309109fb22df3a5d7cec63f9ed76525fa"
    }
  },
  "adoption": {
    "commit": "5761d45c4883d2b40efcee29017de7b7ed96f9b1",
    "adoptedAt": "2026-06-07T19:53:22Z",
    "baselineCommit": "1935b625d059436500bdc5dd8507e9a89279eabf",
    "baselineAt": "2026-06-07T19:50:54Z"
  },
  "dependencies": [
    {
      "path": ".github/scripts/check-max-ai-credits.cjs",
      "gitBlob": "8bfbc612efa473cb55461c4223aa3caef053da3b"
    },
    {
      "path": "actions/setup/js/harness_error_patterns.cjs",
      "gitBlob": "809ef8729722e1fb8003d5e30957d81bbb037cd2"
    },
    {
      "path": "actions/setup/js/add_mask_redaction.cjs",
      "gitBlob": "ab3348a85191d9f9fd996c396696613a175c6681"
    },
    {
      "path": "actions/setup/js/json_string_scanner.cjs",
      "gitBlob": "9421f5a8c50a2a88c4104040ea41631bf7e4d532"
    },
    {
      "path": "actions/setup/js/mask_value_matcher.cjs",
      "gitBlob": "07bc69421067db6f06710832ff7ce7d70ea492d1"
    },
    {
      "path": "actions/setup/js/jsonl_helpers.cjs",
      "gitBlob": "94516ced21f68d227e36cbe74240928d526346a7"
    },
    {
      "path": "actions/setup/js/json_schema_validation.cjs",
      "gitBlob": "423cdb9b6016dc03d58a49cf01276899ddaa2666"
    },
    {
      "path": "actions/setup/js/memory_schema_contract.cjs",
      "gitBlob": "f40351df7c2a914ca8f0ca99d1e7c65f65e6dcaa"
    },
    {
      "path": "actions/setup/js/schema-validation.cjs",
      "gitBlob": "a3e854b82572410ac1c57b9a6f74e3aae8fbd243"
    },
    {
      "path": "actions/setup/js/redact_secrets.cjs",
      "gitBlob": "44a2b7d0123f7305e066e7d3f6154f1fc43940b4"
    },
    {
      "path": "actions/setup/js/safe_outputs_config_redact.cjs",
      "gitBlob": "e132f659686a7fd4ce2fabffaa1f8e34e6ce5a39"
    },
    {
      "path": "actions/setup/js/otlp_header_helpers.cjs",
      "gitBlob": "b48677a4910f16170c3fbf63f63e9eb196bac0d8"
    },
    {
      "path": "actions/setup/js/pi_session_redaction.cjs",
      "gitBlob": "8a31bd028155574e306558427d399518113b976a"
    },
    {
      "path": "actions/setup/js/safe_output_redaction.cjs",
      "gitBlob": "550184f0f84a76b8290ad106dabe2c1b3b3dd7aa"
    },
    {
      "path": "actions/setup/js/error_codes.cjs",
      "gitBlob": "f18252eb125bbfdf78d5a8e4d138ca385016d471"
    },
    {
      "path": "actions/setup/js/safe_outputs_tools.json",
      "gitBlob": "60b63c9f0ab9bcf8a7ee4326e0b61cc422fdec5e"
    },
    {
      "path": "actions/setup/js/error_helpers.cjs",
      "gitBlob": "318ff008c8d6bead9a6935b0c09dd4f9fae387b6"
    }
  ]
});
