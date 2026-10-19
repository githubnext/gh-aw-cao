import { hostAssertionModule } from "../../../../scripts/native-host-assertion-value.mjs";

export const { definition, collectBatch, scoreMetric } = hostAssertionModule({
  "repository": "github/gh-aw",
  "repositoryId": 1036865607,
  "workflowId": "smoke-claude-dynamic",
  "sourceRevision": "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  "until": "2026-10-18T15:00:12Z",
  "sourceGitBlob": "7d3b654096de10e1dcef84aa01404326343b4b4e",
  "interpreterSha256": "15df6030cce347982f0e5056f0e4bdd98539898a79395e3cdcae597b71fb1403",
  "name": "Smoke Claude Dynamic Workflow",
  "goal": "Maintain packaged native Claude dynamic-workflow invocation, trusted hidden fixtures and argument propagation.",
  "acceptance": "The protected host checks immutable packaged script/fixture equality, expected result/run ID, a native Workflow invocation and completion notification correlated to that invocation.",
  "metricLabel": "Verified dynamic-workflow invocations",
  "unit": "invocation proofs",
  "gates": [
    {
      "job": "agent",
      "name": "Verify packaged Claude dynamic workflow evidence",
      "meaning": "Trusted packaging and native dynamic invocation with fixture and run-ID propagation."
    }
  ],
  "assets": [
    ".claude/workflows/smoke-claude-dynamic.js",
    ".claude/workflows/references/smoke-claude-dynamic/.context"
  ],
  "limitations": [
    "The protected conjunction is not decomposed into guessed per-feature outcomes. Safe-output publication is outside this invocation facet."
  ],
  "jobs": {
    "agent": {
      "name": "agent",
      "sha256": "4a55d5144be949c220feeca64f644998dc268876d29278a6adb72bb647bac15c"
    }
  },
  "adoption": {
    "commit": "ea26db6a5beb68ae37d97613f3e9c7923d92d515",
    "adoptedAt": "2026-10-06T16:04:42Z",
    "baselineCommit": "240d76ec4d2bab6ef0b868965af54a4847f58aad",
    "baselineAt": "2026-10-06T15:59:40Z"
  },
  "dependencies": [
    {
      "path": ".claude/workflows/references/smoke-claude-dynamic/.context",
      "gitBlob": "ad13d2cb826ee401808c1ec8f440eaced6f53af2"
    },
    {
      "path": ".claude/workflows/smoke-claude-dynamic.js",
      "gitBlob": "7fd0962bd1442bde9f9c5d68816d013f0e7dd670"
    },
    {
      "path": "actions/setup/js/claude_session.cjs",
      "gitBlob": "a33ad075076f79295256afa8e59d75e101960767"
    },
    {
      "path": "actions/setup/js/dynamic_workflow_session.cjs",
      "gitBlob": "87346a7f2c7d3a30c1dfbc688fe5d31ebf455863"
    },
    {
      "path": "actions/setup/js/provider_refusal.cjs",
      "gitBlob": "9c4c6cfd9cc4f66ee708c2f0fb27463b2ae9edee"
    },
    {
      "path": "actions/setup/js/agent_session.cjs",
      "gitBlob": "6ab4bdea86869d048cb22c571740f11810259d0a"
    },
    {
      "path": "actions/setup/js/log_parser_shared.cjs",
      "gitBlob": "7616c3568175aa9e1d2136221f754a02948b9d5d"
    },
    {
      "path": "actions/setup/js/log_parser_bootstrap.cjs",
      "gitBlob": "532526d863376caa0769bc39bb8bf230ce3358ff"
    },
    {
      "path": "actions/setup/js/unified_session_render.cjs",
      "gitBlob": "df6837b002b1671bece90b7dd8e8d046b4269baf"
    },
    {
      "path": "actions/setup/js/agent_execution.cjs",
      "gitBlob": "aae6dfab1156d3ab7dba48df5eb1088ad484434a"
    },
    {
      "path": "actions/setup/js/parse_deepseek_log.cjs",
      "gitBlob": "2ec6cffe1f61a4c91e5890a35e45c8e64de28c61"
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
      "path": "actions/setup/js/error_codes.cjs",
      "gitBlob": "f18252eb125bbfdf78d5a8e4d138ca385016d471"
    },
    {
      "path": "actions/setup/js/harness_crash_signals.cjs",
      "gitBlob": "b33f811594f7245dc4c62de11f674286f9bec675"
    },
    {
      "path": "actions/setup/js/harness_error_patterns.cjs",
      "gitBlob": "809ef8729722e1fb8003d5e30957d81bbb037cd2"
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
      "path": "actions/setup/js/safe_outputs_tools.json",
      "gitBlob": "60b63c9f0ab9bcf8a7ee4326e0b61cc422fdec5e"
    },
    {
      "path": "actions/setup/js/error_helpers.cjs",
      "gitBlob": "318ff008c8d6bead9a6935b0c09dd4f9fae387b6"
    },
    {
      "path": "actions/setup/js/agent_error_patterns.cjs",
      "gitBlob": "d95fcf0320027ad3745a0a3b1b5f17447c937644"
    },
    {
      "path": "actions/setup/js/copilot_workflow_events.cjs",
      "gitBlob": "2c6b50eb8996d5f2d66ac5dbb667a449381d8843"
    },
    {
      "path": "actions/setup/js/unified_session_payload.cjs",
      "gitBlob": "bd297bbe2545d6e131d35f29cc6cf0ffaeb8f4af"
    },
    {
      "path": "actions/setup/js/mcp_rate_limit.cjs",
      "gitBlob": "163a3834e4e97fd20d3de26ab07797b7c6aadd2b"
    },
    {
      "path": "actions/setup/js/mcp_configuration.cjs",
      "gitBlob": "55796fc8ecff45c0b9938b9b9e7a598ff82b3144"
    },
    {
      "path": "actions/setup/js/symlink_guard.cjs",
      "gitBlob": "71ed5f0b0d57a38f114955f696464000c07e0ca5"
    },
    {
      "path": "actions/setup/js/session_artifact.cjs",
      "gitBlob": "d8e97a8c4eecf0cb6ecde3601f1d783ba869cb3f"
    },
    {
      "path": "actions/setup/js/safe_output_manifest.cjs",
      "gitBlob": "5170d5eaaa05b07dfd1b2b7cfa7ab3e0c8c55f66"
    },
    {
      "path": "actions/setup/js/work_queue_claim_scope.cjs",
      "gitBlob": "e90c706a09f6a7a5698fe364d97a3b5d0031216b"
    },
    {
      "path": "actions/setup/js/work_queue_effect_resource.cjs",
      "gitBlob": "01ac64c0071fdc80521c306b525d1881e1369531"
    },
    {
      "path": "actions/setup/js/work_queue_resource_scope.cjs",
      "gitBlob": "2721b2e141d7159654c0702ba8ffef33a866ba49"
    },
    {
      "path": "actions/setup/js/work_queue_host.cjs",
      "gitBlob": "c58ff804b0cf129997b2003fc54316a73df49607"
    },
    {
      "path": "actions/setup/js/work_queue_codec.cjs",
      "gitBlob": "64c925d871365e1ad06319c1aeec7438d05c7dea"
    },
    {
      "path": "actions/setup/js/finish_work_queue_claim.cjs",
      "gitBlob": "c50ac2a3daed8dddcb095cb20338bbc2948117a8"
    },
    {
      "path": "actions/setup/js/messages_core.cjs",
      "gitBlob": "dd47d0c0cb4a2565e3901e418d410c63e7fdcb23"
    },
    {
      "path": "actions/setup/js/work_queue_delivery.cjs",
      "gitBlob": "e264caf60ac99eb0c3d77524e48be3a17096910a"
    },
    {
      "path": "actions/setup/js/work_queue_native_creation_delivery.cjs",
      "gitBlob": "4113d1a9b8d8b417e32c02e13764b45095cfb7ca"
    },
    {
      "path": "actions/setup/js/work_queue_logging.cjs",
      "gitBlob": "05cd885bfb14aadd1a944fa110eef6a17ae75798"
    },
    {
      "path": "actions/setup/js/mcp_logger.cjs",
      "gitBlob": "e61f6d1b276b346d3d6bcd046ce0b098f1e26fa4"
    },
    {
      "path": "actions/setup/js/work_queue_control_receipts.cjs",
      "gitBlob": "f88c9ba2da7346cc35aa816f694ecbd1911e5589"
    },
    {
      "path": "actions/setup/js/work_queue_dispatch.cjs",
      "gitBlob": "a7d0a47bf9f6389beccb15b0108bc8167147b62d"
    },
    {
      "path": "actions/setup/js/handler_auth.cjs",
      "gitBlob": "061f9a47e9f079ef39ea9493e0b470f01fc7ae66"
    },
    {
      "path": "actions/setup/js/work_queue_deployment_control.cjs",
      "gitBlob": "23e59f124936fef9bd84e3d199f0857e255ae5ff"
    },
    {
      "path": "actions/setup/js/work_queue_provisioning.cjs",
      "gitBlob": "9fcb80b2d9f4bbb5815a4dab721426f141a0af5b"
    },
    {
      "path": "actions/setup/js/work_queue_yaml.cjs",
      "gitBlob": "6c2740c7a7e29d1cb5fcf09f265a889deec471eb"
    },
    {
      "path": "actions/setup/js/work_queue_policy.cjs",
      "gitBlob": "a576251bdd2cf87bf267d536bc1a19b3998a9d51"
    },
    {
      "path": "actions/setup/js/work_queue_scheduler.cjs",
      "gitBlob": "4c1f73014bea43a9a69858360685d9325ee7b41c"
    },
    {
      "path": "actions/setup/js/work_queue_graph.cjs",
      "gitBlob": "139ee8f68c66d0c5b00a202c7c0f3a2a3175e7a0"
    },
    {
      "path": "actions/setup/js/work_queue_deployment.cjs",
      "gitBlob": "676bdf6443fc0ed00069a0901ea9f406bd549bdc"
    },
    {
      "path": "actions/setup/js/work_queue_indexes.cjs",
      "gitBlob": "1d251a8f8a89564a5c332353e82e2797989b7772"
    },
    {
      "path": "actions/setup/js/work_queue_limits.cjs",
      "gitBlob": "3367bdd14c1e2b6ee6ac9b71ba53e2710f9efa25"
    },
    {
      "path": "actions/setup/js/work_queue_binding.cjs",
      "gitBlob": "1d0463eaa870c5a73eb921dbc98f247e99aecd10"
    },
    {
      "path": "actions/setup/js/work_queue_native.cjs",
      "gitBlob": "0821042a2121be61432307a099fb3d14429155d9"
    },
    {
      "path": "actions/setup/js/dispatch_workflow_transport.cjs",
      "gitBlob": "5e8e58ad30b1e2d21fea2b0ba36433f256c3d5c4"
    },
    {
      "path": "actions/setup/js/work_queue_intents.cjs",
      "gitBlob": "472aec6ea31b63212eeceb9c489ec39f3e6d71e1"
    },
    {
      "path": "actions/setup/js/work_queue_replay.cjs",
      "gitBlob": "3a2d55d9e1de5847fca27f7eddc940ea5d7508bd"
    },
    {
      "path": "actions/setup/js/work_queue_issue_contract.cjs",
      "gitBlob": "fef4940a7a7e63e0fc179a42c66f99fbdfb98d52"
    },
    {
      "path": "actions/setup/js/work_queue_policy_config.cjs",
      "gitBlob": "6f7b4fcc515d7de82463dbf1e9dc78fe1abb163e"
    },
    {
      "path": "actions/setup/js/work_queue_store.cjs",
      "gitBlob": "5889a4460e219d9345d9127699023788ad209fc3"
    },
    {
      "path": "actions/setup/js/work_queue_checked_transport.cjs",
      "gitBlob": "43927a0375164a2d22acd6337d7bee2b94cc0363"
    },
    {
      "path": "actions/setup/js/work_queue_git_transport.cjs",
      "gitBlob": "a40d4b7395510fab57042b8f50a6aa3b047c1e13"
    },
    {
      "path": "actions/setup/js/git_auth_env.cjs",
      "gitBlob": "65b2c6ecec709381b0c91392617a186b3ce8b43e"
    },
    {
      "path": "actions/setup/js/work_queue_auth_cache.cjs",
      "gitBlob": "d4c2120e1f17591b615072c3445af967767e3076"
    },
    {
      "path": "actions/setup/js/work_queue_summary_renderer.cjs",
      "gitBlob": "d83871068049fd8aac58a04bea88e4f6b1e1b938"
    },
    {
      "path": "actions/setup/js/work_queue_dispatch_credential.cjs",
      "gitBlob": "1863a9cfa7123bdc7d1dfc19c0d0016085ae8f13"
    },
    {
      "path": "actions/setup/js/aw_context.cjs",
      "gitBlob": "865015b4009f068b0e228d553e8dcf54f0a6b2de"
    },
    {
      "path": "actions/setup/js/experiment_helpers.cjs",
      "gitBlob": "1a7c5cc115f3e7f1a4503b95edc32742e1981855"
    },
    {
      "path": "actions/setup/js/safe_output_helpers.cjs",
      "gitBlob": "353b196a828f2c05eb4201cab75ff60dfe1d29a7"
    },
    {
      "path": "actions/setup/js/invocation_context_helpers.cjs",
      "gitBlob": "9e3d09a9ef2d67122231dfcc25f1af5fb32afe15"
    },
    {
      "path": "actions/setup/js/repo_helpers.cjs",
      "gitBlob": "79a40a80bd73acf9a74fb52850ba917f983b0626"
    },
    {
      "path": "actions/setup/js/glob_pattern_helpers.cjs",
      "gitBlob": "7f8f41db39abc0d1fdecc5a04fda79123fd7f9e1"
    },
    {
      "path": "actions/setup/js/staged_preview.cjs",
      "gitBlob": "d88f7165fb08c7cde29a0ba2566a4a0bdda1f6ab"
    },
    {
      "path": "actions/setup/js/work_queue_mcp_server.cjs",
      "gitBlob": "de01a43bd402b837fc16efb3776de632aed6717d"
    },
    {
      "path": "actions/setup/js/mcp_server_core.cjs",
      "gitBlob": "d516d4991336811c4cf293c9c210207bd6718687"
    },
    {
      "path": "actions/setup/js/mcp_handler_javascript.cjs",
      "gitBlob": "58c765d4f914efed609ce67affa3f642e8e09238"
    },
    {
      "path": "actions/setup/js/mcp_handler_process.cjs",
      "gitBlob": "5f0f6e903ab450cb9c3301f3a75acb3a9111493d"
    },
    {
      "path": "actions/setup/js/mcp_handler_go.cjs",
      "gitBlob": "9bc1cf2b5c1ed7b1a3455af5a92c8e962fcfe63c"
    },
    {
      "path": "actions/setup/js/mcp_handler_python.cjs",
      "gitBlob": "c8ec5054b15520c5967f91a7e9208ad0d0031e03"
    },
    {
      "path": "actions/setup/js/mcp_handler_shell.cjs",
      "gitBlob": "dc870a611778a82dbeea79f482ae1d199619197f"
    },
    {
      "path": "actions/setup/js/mcp_dependencies_manager.cjs",
      "gitBlob": "fa0d2d64a7f85149fd05c645a2995ae849517cd5"
    },
    {
      "path": "actions/setup/js/mcp_enhanced_errors.cjs",
      "gitBlob": "e23091ae9e5bdf70869d504c759799846b1871cd"
    },
    {
      "path": "actions/setup/js/read_buffer.cjs",
      "gitBlob": "982de478e17c3a4624df73d9b6e2e03b2cba2589"
    },
    {
      "path": "actions/setup/js/work_queue_reconciler.cjs",
      "gitBlob": "a614a873aa0870b52a19334e5aa63672c28e8aca"
    },
    {
      "path": "actions/setup/js/work_queue_dependency_resolver.cjs",
      "gitBlob": "27da980372c89bc56386ac4afbaf6d5a2c24b1f6"
    },
    {
      "path": "actions/setup/js/work_queue_claim_adapters.cjs",
      "gitBlob": "e0a1d3d427c89ce83d7b7da457c75289dbb9269d"
    },
    {
      "path": "actions/setup/js/work_queue_declared_verification.cjs",
      "gitBlob": "4009aaee71185e66da3944920ae79eb0158b7cf2"
    },
    {
      "path": "actions/setup/js/work_queue_graphql_adapter.cjs",
      "gitBlob": "1e841665042cd7a36e1e9eb389b7cdafdfe55a0d"
    },
    {
      "path": "actions/setup/js/work_queue_effect_client.cjs",
      "gitBlob": "9303486d7321902e056e072d2450aedf61eaa285"
    },
    {
      "path": "actions/setup/js/work_queue_git_tree_adapter.cjs",
      "gitBlob": "4cfb7cfb4be344101a647f165f31394e0632f8aa"
    },
    {
      "path": "actions/setup/js/work_queue_rest_adapter.cjs",
      "gitBlob": "905e112d63708bbe9d80476d7c9079056a5ad37f"
    },
    {
      "path": "actions/setup/js/constants.cjs",
      "gitBlob": "36cbd92cc1d2cd92137fde121650d529cf23fd30"
    },
    {
      "path": "actions/setup/js/model_costs.cjs",
      "gitBlob": "46730644cb5c83fc42ce6a3f1158672b2413c96a"
    },
    {
      "path": "actions/setup/js/agent_session_render.cjs",
      "gitBlob": "f907f65a05f45705bd1d8e01088e55ca941331a5"
    },
    {
      "path": "actions/setup/js/copilot_session.cjs",
      "gitBlob": "52bc6c9b122b344aaa326c05da210e561ca35f5f"
    },
    {
      "path": "actions/setup/js/codex_log_framing.cjs",
      "gitBlob": "07eae836eed951c8e21797007f8199453eb5a7fa"
    },
    {
      "path": "actions/setup/js/log_parser_step_summary_builder.cjs",
      "gitBlob": "ef7ad3335744dbc6ded7910a749dba84870eb07e"
    },
    {
      "path": "actions/setup/js/log_parser_format.cjs",
      "gitBlob": "b0b425548f3215cd4e40305b59fb7b7a54522110"
    },
    {
      "path": "actions/setup/js/subagent_session_render.cjs",
      "gitBlob": "0f627ef98735ab52ffc2b7b60a98b82c867ec30b"
    },
    {
      "path": "actions/setup/js/markdown_unfencing.cjs",
      "gitBlob": "67738a9f2b6a4fd22c24ea85ce1a3eb88f2babea"
    }
  ]
});
