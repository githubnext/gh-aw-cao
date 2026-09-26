---
title: Control Policy
description: Understand where Central Agentic Ops policy is defined and which layer owns each decision.
sidebar:
  order: 1361
---

# Control Policy

`.github/workflows/cao.json` is the sole persistent non-secret CAO policy authority: CAO governs rollout and target authority, while gh-aw governs engine limits, generated job topology, authentication, and safe-output execution. For the normative architecture, requirements, and compliance tests, see the [Central Agentic Ops Control Architecture Specification](https://github.com/githubnext/gh-aw-cao/blob/main/specs/control-architecture.md).

The optional `control-plane.web.host` section also records non-secret dashboard
host capabilities and Redis environment-variable references. Keep connection
URLs, passwords, and CA certificate contents in the deployment secret manager.
See [Managed Redis in one minute](deployment-managed-redis.md).