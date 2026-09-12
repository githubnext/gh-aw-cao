---
name: Docs Diagrams
description: Finds one documentation concept or ASCII diagram, creates a polished light/dark SVG pair, and opens a draft PR with theme-aware markup.
on:
  schedule: weekly
  workflow_dispatch:
    inputs:
      focus:
        description: "Optional documentation path or concept hint"
        required: false
        type: string
  skip-if-match: "is:pr is:open label:diagram-generator"
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
strict: true
max-ai-credits: 500
max-daily-ai-credits: -1
timeout-minutes: 30
concurrency:
  group: "${{ github.workflow }}-${{ github.ref }}"
  cancel-in-progress: true
  job-discriminator: "${{ github.run_id }}"
network:
  allowed:
    - defaults
    - github
    - local
    - playwright
tools:
  github:
    mode: gh-proxy
    toolsets: [default]
  bash: true
  playwright:
    version: "0.1.13"
skills:
  - github/gh-aw-workshop/.github/skills/github-brand@56127b6381f0f1d976231bb924dadcbae18858de
safe-outputs:
  create-pull-request:
    title-prefix: "[docs-diagrams] "
    labels: [documentation, ai-generated, diagram-generator]
    draft: true
    allowed-files:
      - "docs/*.md"
      - "docs/**/*.md"
      - "public/assets/*-light.svg"
      - "public/assets/*-dark.svg"
    if-no-changes: warn
    expires: 1d
  noop:
    report-as-issue: false
steps:
  - name: Gather documentation diagram state
    shell: bash
    env:
      FOCUS: "${{ inputs.focus }}"
    run: |
      set -euo pipefail
      mkdir -p /tmp/gh-aw/data

      python3 <<'PY'
      import json
      import os
      import pathlib
      import re

      docs_dir = pathlib.Path("docs")
      text_diagram_re = re.compile(
          r"```text\s*\n(?P<body>[\s\S]*?)```",
          re.MULTILINE,
      )
      diagram_signal_re = re.compile(
          r"(?:-->|\+--|\|\s*$|\bv\s*$|\breview\s*\|\s*live\b)",
          re.MULTILINE,
      )
      picture_re = re.compile(r"<picture\b[\s\S]*?</picture>", re.IGNORECASE)

      files = []
      for path in sorted(docs_dir.glob("*.md")):
          text = path.read_text()
          candidates = []
          for match in text_diagram_re.finditer(text):
              body = match.group("body").strip()
              if diagram_signal_re.search(body):
                  candidates.append(
                      {
                          "line": text[:match.start()].count("\n") + 1,
                          "text": body,
                      }
                  )
          files.append(
              {
                  "path": str(path),
                  "text_diagrams": candidates,
                  "theme_aware_pictures": sum(
                      "(prefers-color-scheme: light)" in block
                      and "(prefers-color-scheme: dark)" in block
                      for block in picture_re.findall(text)
                  ),
              }
          )

      pathlib.Path("/tmp/gh-aw/data/diagram-state.json").write_text(
          json.dumps(
              {
                  "focus": os.environ.get("FOCUS", ""),
                  "files": files,
                  "existing_diagrams": sorted(
                      str(path) for path in pathlib.Path("public/assets").glob("*.svg")
                  ),
              },
              indent=2,
          )
      )
      PY

      cat /tmp/gh-aw/data/diagram-state.json
---

# Documentation Explanatory Diagram Generator

Create at most one coherent explanatory diagram change for the Central Agentic Ops documentation.

Before selecting, generating, or reviewing a visual, invoke `/github-brand` and apply its complex-visual guidance. Treat the repository architecture and security claims as authoritative; do not invent product behavior.

## Select One Candidate

1. Read `/tmp/gh-aw/data/diagram-state.json` completely.
2. When `focus` is non-empty, use it as a strong path or concept hint.
3. Otherwise, select the first `text_diagrams` candidate in path and line order.
4. If no ASCII candidate exists, select one foundational architecture or operational concept currently explained only in prose and not already explained by a nearby image.
5. Prefer flows, trust boundaries, decision paths, lifecycle sequences, and mental models that fit in 3-6 nodes.
6. Call `noop` when there is no strong candidate or the best candidate already has an adequate visual.

Do not convert command output, configuration examples, or code samples. Never remove text that contains details the diagram would not preserve.

## Create One Theme-Aware Pair

Generate exactly one light/dark SVG pair under `public/assets/`:

- `<concept>-light.svg`
- `<concept>-dark.svg`

Both files must:

- use `width="1200"`, an appropriate positive height, and `viewBox="0 0 1200 <height>"`;
- keep geometry, labels, and content identical across themes;
- use `role="img"`, a complete accessible name, `data-visual-kind="diagram"`, a stable `data-visual-id`, and `data-node` on every semantic node;
- use flat colors only, with no gradients, shadows, glows, textures, or decorative illustration;
- use labels of at least 16px, connectors of at least 2px, visible arrowheads, and a non-color reading direction;
- keep labels short, preserve at least 12px node padding, and avoid connector crossings;
- use Mona Sans and Mona Sans Mono when available, followed by system fallbacks.

Use this palette:

| Role | Light | Dark |
| --- | --- | --- |
| Background | `#f2f5f3` | `#101411` |
| Panel | `#ffffff` | `#0a241b` |
| Border | `#b6bfb8` | `#909692` |
| Primary text | `#101411` | `#f2f5f3` |
| Muted text | `#232925` | `#b6bfb8` |
| Structural accent | `#08872b` | `#5fed83` |
| Flow accent | `#0969da` | `#58a6ff` |

When a node represents a GitHub entity, use the corresponding unmodified, MIT-licensed Primer Octicon path and preserve the license attribution in an SVG comment. Do not approximate icons or use Unicode symbols as icons. Apply Primer semantic state colors and `data-state` when a shape represents a state.

## Update Markdown Minimally

Replace exactly one ASCII diagram or add exactly one image reference near the selected concept. Use this base-aware pattern because Astro serves public assets under the repository base path:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="/gh-aw-cao/assets/<concept>-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="/gh-aw-cao/assets/<concept>-light.svg">
  <img alt="Concise description of the complete relationship" src="/gh-aw-cao/assets/<concept>-light.svg">
</picture>
```

Keep alt text only on the fallback `<img>`. Do not reformat surrounding prose or change unrelated files.

## Validate Before Opening a PR

1. Run `SVG_FILES="<light path> <dark path>" node scripts/check-svg-visual-language.mjs` and fix every violation.
2. Run `npm run docs:build` and verify both SVG files exist under `dist/assets/`.
3. Start `python3 -m http.server 4321 --bind 0.0.0.0 --directory dist`.
4. In one Playwright session, open the changed page with `colorScheme: "light"`, then `colorScheme: "dark"`.
5. In each theme, verify the `<picture>` element's `currentSrc` ends with the expected theme suffix, the image has nonzero rendered dimensions, and the SVG is nonblank.
6. Inspect screenshots and DOM bounds. Fix all contrast failures, clipped or overflowing text, label overlap, connector overlap, and unintended horizontal page overflow.
7. Repeat the checks after every correction.

## Pull Request

Call `create-pull-request` exactly once with:

- title `Add theme-aware explanatory diagram for <concept>`;
- a body naming the documentation page and both SVGs, explaining whether an ASCII diagram was migrated or a prose concept was illustrated, and stating which checks passed.

Do not modify files outside the safe-output allowlist. Never claim validation passed when a command failed, a theme was not rendered, or an asset was blank.