---
name: agentic-workflows
description: Route gh-aw design, creation, diagnosis, patching, active debugging, and upgrade requests through the current canonical GitHub Agentic Workflows guidance.
---

# Agentic Workflows Router

Load and follow the current canonical
[Agentic Workflows skill](https://github.com/github/gh-aw/blob/main/.github/skills/agentic-workflows/SKILL.md)
from `github/gh-aw` before handling the request. Do not copy or reconstruct its
routing table locally. If the canonical skill cannot be loaded, report that
failure instead of silently using stale remembered guidance.

Then apply this repository's overlay:

- If `.github/aw/instructions.md` exists, load it after the canonical skill.
- Repository overlay instructions take precedence when they conflict with
  upstream defaults.
- Use upstream `main` only to obtain the current routing skill. Version-sensitive
  workflow syntax and command behavior must match the control repository's
  policy-pinned `gh aw` version and pass that CLI's compilation and validation.

## Deterministic boundary

- Use `gh aw` for workflow creation, compilation, validation, upgrades, runs,
  and logs. Do not reproduce command behavior with ad hoc file or API logic.
- Use `cao` and repository-provided package managers, linters, and tests for
  CAO policy operations, mechanical edits, and validation.
- Keep intent classification, architecture selection, safety tradeoffs, and
  diagnosis agentic. Keep parsing, mutation, compilation, and verification
  deterministic.
