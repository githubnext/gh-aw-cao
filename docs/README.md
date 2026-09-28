---
title: Central Agentic Ops (CAO)
description: Coordinate multiple GitHub Agentic Workflow campaigns and their repositories from one governed control plane.
template: splash
editUrl: false
prev: false
next: false
agent:
  type: overview
  prominent: true
hero:
  title: Hyperscale Agentic Campaigns.<br />Centralized Control Planes.
  tagline: CAO coordinates Agentic Campaigns, each across its explicitly enrolled repositories—shared policy, staged rollout, bounded execution, cross-campaign evidence, and human decisions about what scales next.
  actions:
    - text: Explore CAO
      link: /gh-aw-cao/architecture-at-a-glance/
      icon: right-arrow
    - text: Get started
      link: /gh-aw-cao/setup-quickstarts/
      variant: secondary
      icon: right-arrow
    - text: Dashboard
      link: https://githubnext.github.io/gh-aw-cao/cao
      variant: secondary
      icon: right-arrow
---

## Documentation for coding agents

Use [`llms.txt`](/gh-aw-cao/llms.txt) to find high-value documentation,
[`llms-small.txt`](/gh-aw-cao/llms-small.txt) for compact context, and
[`llms-full.txt`](/gh-aw-cao/llms-full.txt) for the broad documentation corpus.
The [scoped agent resource index](/gh-aw-cao/agent/llms.txt) links important
HTML pages to their compact JSON metadata, provenance, integrity, operational
bindings, and related resources. The generated
[`agent/resources.json`](/gh-aw-cao/agent/resources.json) index lists every
resource without duplicating page bodies.
Maintainers can read the
[agent-readable documentation convention](/gh-aw-cao/agent-resources/) when
adding or enriching a route.
Agents setting up, debugging, installing, creating, analyzing, or operating CAO
should use the corresponding
[`setup-cao`](https://github.com/githubnext/gh-aw-cao/blob/main/skills/setup-cao/SKILL.md),
[`debug-cao`](https://github.com/githubnext/gh-aw-cao/blob/main/skills/debug-cao/SKILL.md),
[`add-cao-campaign`](https://github.com/githubnext/gh-aw-cao/blob/main/skills/add-cao-campaign/SKILL.md),
[`create-cao-campaign`](https://github.com/githubnext/gh-aw-cao/blob/main/skills/create-cao-campaign/SKILL.md),
[`analyze-cao`](https://github.com/githubnext/gh-aw-cao/blob/main/skills/analyze-cao/SKILL.md),
or [`cao-cli`](https://github.com/githubnext/gh-aw-cao/blob/main/skills/cao-cli/SKILL.md)
skill.

Markdown and Starlight pages are authoritative. The `llms*.txt` resources are
generated during every documentation build; do not edit or commit them. The
documentation auditor evaluates routing quality but does not define product
behavior. Update the authoritative architecture and specification sources when
their contracts change.
