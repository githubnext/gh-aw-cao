---
name: debug-cao
description: Diagnose a Central Agentic Ops deployment failure and leave bounded, reproducible evidence for the next action.
argument-hint: "Provide the control repository and a run URL, issue URL, failure code, or symptom"
---

# Debug Central Agentic Ops

## Procedure

1. Start read-only. Preserve the failed attempt before rerunning, updating,
   recompiling, rotating credentials, changing policy, or enabling live mode.
2. Record the control repository, run and attempt, event, ref, head SHA,
   `GITHUB_WORKFLOW_SHA`, failing job and step, UTC times, runner image, target,
   effective campaign/worker/mode, and review destination.
3. Record immutable component identities: campaign `resolvedCommit`,
   `.github/workflows/cao.json` version and `gh-aw-version`, `gh aw`, GitHub CLI,
   Node, actions, runtime, and target revisions.
4. Read the run summary and annotations, then the smallest log excerpt containing
   the first causal error and its preceding context.
5. Use the [failure routes](references/failure-routes.md) to inspect the narrowest
   boundary at the failing workflow commit.
6. Classify exactly one primary boundary: installation/version drift,
   policy/admission, authentication/authorization, Copilot inference, gh-aw
   compile/runtime, campaign logic, Activity data, dashboard build/deploy, or
   GitHub Actions/platform.
7. State evidence excluding adjacent categories. Form one falsifiable hypothesis:
   at `<step>`, `<component@revision>` fails because `<condition>`;
   `<observation>` would confirm or reject it.
8. Reproduce only when it stays bounded and review-safe, holding workflow,
   policy, compiler, target, and inputs constant and changing one boundary.
9. Search for an exact existing issue before creating one. Use the
   [diagnostic report](references/diagnostic-report.md); include immutable links,
   redactions, the next bounded observation, and an acceptance condition.
10. Report incomplete diagnosis rather than guessing when required evidence is
    inaccessible.

## Guardrails

- Keep CAO authority separate from gh-aw execution capability. Credentials,
  compiled permissions, and successful API calls do not widen policy.
- Never print, copy, attach, or request secret values, private keys,
  authorization headers, signed URLs, raw prompts, or private target data.
- If the report concerns a vulnerability or exposed credential, stop public
  issue creation and use the repository security policy.
- Inspect `.md` workflow sources at the failing revision. Never edit generated
  `.lock.yml` files.
- Do not infer that a dashboard symptom originated in the dashboard; prove the
  Activity snapshot and handoff first.

## Targeted references

- [Failure routes](references/failure-routes.md): symptom-to-boundary dispatch,
  source locations, and diagnostics.
- [Diagnostic report](references/diagnostic-report.md): issue fields and
  completion checklist.
- [Monitor, Recover, and Maintain](../../docs/operations.md): operational
  recovery.
- [Authentication](../../docs/authentication.md): credential profiles.
- [Execution and Safety](../../docs/execution-and-safety.md): authority and
  worker boundaries.
