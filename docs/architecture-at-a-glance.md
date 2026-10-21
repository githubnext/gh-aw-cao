---
title: What is Central Agentic Ops?
description: Monitor and govern GitHub Agentic Workflows across repositories, with shared evidence and policy-controlled execution.
next:
  link: /gh-cao/how-cao-works/
  label: How does CAO work?
---

**Central Agentic Ops (CAO)** is a system for monitoring and governing GitHub
Agentic Workflows across repositories. It brings collected activity, cost, and
outcome evidence into a shared dashboard and supports policy-governed execution
and rollout of participating shared workflows.

<span id="what-is-central-agentic-ops"></span>

## What is CAO?

Agentic work might begin with a single task, then grow across repositories.
[GitHub Agentic Workflows (AWs)](https://github.github.com/gh-aw/introduction/overview/)
run those tasks in GitHub Actions, using Markdown instructions and configured
tools and permissions. These AWs form the building blocks of CAO as we scale.

CAO helps you operate these building blocks together:

<span id="what-you-can-do-today"></span>

- **Observe activity**: See collected runs across configured repositories and
  follow them back to GitHub.
- **Evaluate results**: Inspect available costs, outputs, and outcome evidence,
  not just whether a workflow ran.
- **Govern shared work**: Decide whether and where participating workflows may
  run, then roll them out within explicit policy.

## Agentic workflows, operated across repositories

You can start with workflows that already run in their own repositories.
Monitoring them does not move them or change their permissions. When you choose
to govern shared automation, CAO supports standalone workflows and campaigns;
campaigns are one way to package and scale work, not a prerequisite.

### A simple example

An issue-triage workflow runs in one repository while another investigates
failures elsewhere. CAO shows their collected runs and available outputs in one
place, with links back to GitHub. A successful run is not automatically a
successful outcome. The evidence helps you investigate what the work produced.

<span id="see-the-product"></span>

<figure>
<img src="https://github.com/user-attachments/assets/1c408552-1a2d-45cc-967e-b46d8811798d" alt="CAO Repositories chart view showing retained runs and issue outputs across repositories." width="1200" height="766" loading="lazy" decoding="async">
<figcaption>Public sample, 19 October 2026. Collected evidence, not a live feed.</figcaption>
</figure>

[Explore the public Repositories view](https://githubnext.github.io/gh-cao/cao/#page-repositories).

<span id="essential-safety-boundaries"></span>
<span id="how-evidence-reaches-the-dashboard"></span>
<span id="operating-workflows-across-repositories"></span>

CAO governs explicitly integrated workflows, not every observed AW or ordinary
Actions job. Shared execution starts in `review`: proposals go to a review
destination; live output requires explicit authorization.

<span id="get-started"></span>

- [How does CAO work?](how-cao-works.md)
- [Architecture](architecture.md)
- [Set up CAO and monitor your workflows](setup-quickstarts.md)
- [Browse campaigns](catalog.md)
