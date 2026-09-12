---
jobs:
  activation:
    pre-steps:
      - name: Restore CAO activity cache
        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: |
            ${{ runner.temp }}/cao-activity/gh-aw-logs.jsonl
            ${{ runner.temp }}/cao-activity/gh-aw-logs.sqlite
            ${{ runner.temp }}/cao-activity/control-settings.json
            ${{ runner.temp }}/cao-activity/inventory-sources.json
            ${{ runner.temp }}/cao-gh-aw-logs/drain3_weights.json
          key: cao-activity-v3-lookup-${{ github.run_id }}-${{ github.run_attempt }}-activation
          restore-keys: |
            cao-activity-v3-

  agent:
    pre-steps:
      - name: Restore CAO activity cache
        uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: |
            ${{ runner.temp }}/cao-activity/gh-aw-logs.jsonl
            ${{ runner.temp }}/cao-activity/gh-aw-logs.sqlite
            ${{ runner.temp }}/cao-activity/control-settings.json
            ${{ runner.temp }}/cao-activity/inventory-sources.json
            ${{ runner.temp }}/cao-gh-aw-logs/drain3_weights.json
          key: cao-activity-v3-lookup-${{ github.run_id }}-${{ github.run_attempt }}-agent
          restore-keys: |
            cao-activity-v3-
---

<!--
Restores the latest CAO activity snapshot for deterministic activation checks and
agent-side reuse. Consumers must treat cache misses and incomplete coverage as
fallback conditions and must never save or publish this shared cache.
-->
