import base64
import hashlib
import importlib.util
import unittest

spec = importlib.util.spec_from_file_location("oracle", "scripts/native-lockfile-stats.py")
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


def entry(name, text):
    raw = text.encode()
    return {"path": f".github/workflows/{name}.lock.yml",
            "gitBlob": hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest(),
            "content": base64.b64encode(raw).decode()}


class NativeLockfileStats(unittest.TestCase):
    def test_native_population_engine_permissions_and_deduplication(self):
        first = entry("a", """# gh-aw-metadata: {"agent_id":"claude","engine_versions":{"claude":"1"}}
# gh-aw-manifest: {"mcp_servers":[{"name":"github","tools":["read","read"]}]}
on:
  workflow_dispatch:
  schedule:
    - cron: "0 0 * * *"
permissions: {}
jobs:
  agent:
    permissions:
      contents: read
    timeout-minutes: 15
    steps:
      - env:
          GH_AW_SAFE_OUTPUTS_CONFIG: '{"create_discussion":{}}'
          GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG: '{"create_discussion":{}}'
        run: echo hi
  safe_outputs:
    permissions:
      discussions: write
    steps: []
""")
        second = entry("b", """# gh-aw-metadata: {"engine_versions":{"codex":"1"}}
on: workflow_dispatch
jobs:
  agent:
    permissions: read-all
    steps:
      - run: echo hi
""")
        result = oracle.census([first, second])
        facts = result["facts"]
        self.assertEqual(facts["lockfile_count"], 2)
        self.assertEqual(facts["safe_output_types"], {"create_discussion": 1})
        self.assertEqual(facts["discussion_categories"], {"default": 1})
        self.assertEqual(facts["engine_distribution"], {"claude": 1, "codex": 1})
        self.assertEqual(facts["permissions_by_scope"]["contents"]["read"], 1)
        self.assertEqual(facts["permissions_by_scope"]["*"]["read"], 1)
        self.assertEqual(facts["union_write_scope_counts"]["discussions"], 1)
        self.assertEqual(facts["mcp_server_usage"], {"github": 1})
        self.assertEqual(facts["mcp_tool_usage"], {"github:read": 1})
        self.assertEqual(facts["workflow_dispatch_count"], 2)
        self.assertEqual(facts["job_counts"], {"total_jobs": 3, "max_jobs": 2})
        self.assertEqual(facts["script_step_counts"], {"total": 2, "max": 1})

    def test_wrong_blob_and_duplicate_population_fail_closed(self):
        value = entry("a", "jobs: {agent: {steps: []}}")
        with self.assertRaises(ValueError):
            oracle.census([value, value])
        with self.assertRaises(ValueError):
            oracle.census([{**value, "gitBlob": "a" * 40}])

    def test_invalid_yaml_is_a_visible_skipped_file_not_clean_empty_statistics(self):
        value = entry("bad", "jobs: [}")
        result = oracle.census([value])
        self.assertEqual(result["facts"]["skipped_count"], 1)
        self.assertEqual(result["population"][0]["status"], "malformed")
        self.assertEqual(result["facts"]["lockfile_count"], 1)


if __name__ == "__main__":
    unittest.main()
