---
import-schema:
  workflow:
    type: string
    required: true
  read_repository:
    type: string
    required: true
  read_contents:
    type: string
    default: ""
  read_issues:
    type: string
    default: ""
imports:
  - uses: control.md
    with:
      role: direct
      workflow: ${{ github.aw.import-inputs.workflow }}
      read_repository: ${{ github.aw.import-inputs.read_repository }}
      read_contents: ${{ github.aw.import-inputs.read_contents }}
      read_issues: ${{ github.aw.import-inputs.read_issues }}
---

<!-- A direct-operation adapter over the common gh-aw execution integration.
The importing workflow must retain its CAO pre-activation output and activation
condition, declare read-only tools and safe outputs, and be enrolled under
control-plane.operations. Inputs request authority; they do not grant it. -->
