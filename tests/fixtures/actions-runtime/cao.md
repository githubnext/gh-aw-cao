---
name: Simulator CAO
on:
  workflow_dispatch:
  repository_dispatch:
    types: [gh-aw-webhook-9f86d081884c7d659a2feaa0]
permissions:
  contents: read
  actions: read
engine: copilot
features:
  samples: true
jobs:
  pre-activation:
    outputs:
      cao_authorized: ${{ steps.cao_admission.outputs.authorized == 'true' && steps.cao_precompute.outputs.authorized != 'false' }}
if: needs.pre_activation.outputs.cao_authorized == 'true'
imports:
  - uses: shared/control.md
    with:
      role: standalone
      workflow: cao
      github_tools: false
      read_repository: ${{ github.repository }}
      read_contents: read
network:
  allowed: [defaults]
safe-outputs:
  threat-detection: false
  create-issue:
    max: 1
    samples:
      - title: "Simulator CAO review report"
        body: "The real CAO admission and precompute authorized this review-only sample."
---

Use the CAO precompute evidence to produce the deterministic review report.
