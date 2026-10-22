---
name: Simulator sample
on:
  workflow_dispatch:
  repository_dispatch:
    types: [gh-aw-webhook-9f86d081884c7d659a2feaa0]
permissions:
  contents: read
engine: copilot
features:
  samples: true
network:
  allowed: [defaults]
safe-outputs:
  threat-detection: false
  create-issue:
    max: 1
    samples:
      - title: "Simulator deterministic report"
        body: "Sample replay reached the dry-run safe-output boundary."
---

Create the deterministic sample report. This fixture is compiled with
`--use-samples --dry-run` and never invokes an inference engine.
