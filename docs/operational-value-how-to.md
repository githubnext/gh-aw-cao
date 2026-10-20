---
title: Trace workflow goals to measured value
description: A beginner's guide to seeing whether an AI workflow helped, using Daily File Diet as a worked example.
---

**Your workflow ran. Did it help?**

A green check tells you that a run finished successfully. An opened issue tells
you that the agent produced something. Neither tells you whether the problem
got better.

**Operational value means checking whether the outcome you wanted actually
happened.** Start with one goal, follow the work, and measure the result.
You do not need to understand CAO's data model to read this example.

## The idea in one minute

Daily File Diet looks for oversized Go files and suggests breaking them into
smaller files. Follow its work through five steps:

<ol class="cao-value-trail" aria-label="Five steps from a goal to evidence">
<li><svg class="cao-value-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.5a6.5 6.5 0 1 0 6.016 4.035.75.75 0 0 1 1.388-.57 8 8 0 1 1-4.37-4.37.75.75 0 1 1-.569 1.389A6.473 6.473 0 0 0 8 1.5Zm6.28.22a.75.75 0 0 1 0 1.06l-4.063 4.064a2.5 2.5 0 1 1-1.06-1.06L13.22 1.72a.75.75 0 0 1 1.06 0ZM7 8a1 1 0 1 0 2 0 1 1 0 0 0-2 0Z"></path></svg><strong>1. Set a goal</strong><span>Make oversized files smaller without breaking behavior.</span></li>
<li><svg class="cao-value-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"></path></svg><strong>2. Follow the output</strong><span>The workflow opens an issue suggesting a change.</span></li>
<li><svg class="cao-value-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"></path></svg><strong>3. Find the change</strong><span>A person or another agent implements it in a linked pull request.</span></li>
<li><svg class="cao-value-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M1.5 1.75V13.5h13.75a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75V1.75a.75.75 0 0 1 1.5 0Zm14.28 2.53-5.25 5.25a.75.75 0 0 1-1.06 0L7 7.06 4.28 9.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.25-3.25a.75.75 0 0 1 1.06 0L10 7.94l4.72-4.72a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"></path></svg><strong>4. Measure it</strong><span>Compare the actual files before and after the merged change.</span></li>
<li><svg class="cao-value-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.92 6.085h.001a.749.749 0 1 1-1.342-.67c.169-.339.436-.701.849-.977C6.845 4.16 7.369 4 8 4a2.756 2.756 0 0 1 1.637.525c.503.377.863.965.863 1.725 0 .448-.115.83-.329 1.15-.205.307-.47.513-.692.662-.109.072-.22.138-.313.195l-.006.004a6.24 6.24 0 0 0-.26.16.952.952 0 0 0-.276.245.75.75 0 0 1-1.248-.832c.184-.264.42-.489.692-.661.103-.067.207-.132.313-.195l.007-.004c.1-.061.182-.11.258-.161a.969.969 0 0 0 .277-.245C8.96 6.514 9 6.427 9 6.25a.612.612 0 0 0-.262-.525A1.27 1.27 0 0 0 8 5.5c-.369 0-.595.09-.74.187a1.01 1.01 0 0 0-.34.398ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg><strong>5. State the limits</strong><span>Smaller files are proved. Unchanged behavior still needs its own evidence.</span></li>
</ol>

**Do not stop at step 2.** A suggestion is not a delivered improvement.
**Do not overclaim at step 4.** A smaller file is not proof that the program
still works. Both distinctions matter.

## Read the example report

**[Open the Daily File Diet report](https://raw.githack.com/githubnext/gh-aw-cao/refs/heads/mnkiefer-workflow-operational-value/docs/operational-value/gh-aw-workflows/daily-file-diet-pulse.html).**
This is a saved report from October 18, 2026, not today's live result.
No installation is needed to read it.

1. **Look at delivered work.** The report shows **48 net oversized-file
   reductions** across linked merged changes. This is useful structural progress,
   shared with the people and agents who implemented it.
2. **Inspect an event.** Click a dot below the cumulative chart, or focus it with
   the keyboard and press Enter. Follow the origin issue, merged PR and
   before/after Git revisions. You can check the claim yourself.
3. **Check what is happening recently.** The latest 28 days show
   **0 files/week**, compared with **0.5 files/week** in the preceding 28 days.
   Past usefulness does not guarantee current delivery.
4. **Read the limits.** **13 of the 48 reductions** have stronger creation-receipt
   evidence linking them to the workflow. That is a subset, not extra work.
   Full behavior preservation and financial return are not established.

<details>
<summary>A concrete example: one big file becomes five smaller files</summary>

[github/gh-aw#55785](https://github.com/github/gh-aw/pull/55785) links to
[github/gh-aw#55776](https://github.com/github/gh-aw/issues/55776).
`pkg/cli/add_command.go` goes from **1,129 to 248 lines**. Four new files contain
250, 280, 86 and 328 lines. Comparing the actual Git revisions verifies the size
change; the full inventory also checks whether replacement files are oversized.

This demonstrates structural progress. Tests, coverage and public-API checks
are separate evidence needed for the stronger claim of behavior-preserving
refactoring. See the [evidence reference](operational-value-evidence-reference.md#3-verify-the-downstream-native-change)
for the exact revisions and rules.

</details>

## Understand the two numbers that can disagree

| Question | File Diet example | What it means |
|---|---|---|
| **Is the repository getting healthier?** | The oversized-file count grows from 16 to 53. | New problems can arrive faster than old ones are fixed. Count improvement by anyone, not just this workflow. |
| **Did this workflow help deliver useful changes?** | Linked merges produce 48 net reductions over its lifetime. | There is evidence of useful contribution, even while the wider problem grows. |

The first is the **primary measure**: the repository condition you care about.
The second is a **diagnostic**: evidence that helps explain the work and its
handoffs. One is not a substitute for the other.

Think of fixing leaks while new leaks appear. You need to know both how much
repair work was delivered and whether the building now has fewer leaks.

> [!NOTE]
> **Unknown is not zero.** If the evidence is missing, the report should say so.
> And a link to a change is not proof that the change would never have happened
> without the workflow.

## Try it with your own workflow

**Start small: one workflow, one outcome, one way to check it.**

1. **Say what should improve.** For example: "Reduce oversized production files
   without breaking behavior," not "Open more refactoring issues."
2. **Ask the skill to design the measure.** With the skill available, use
   `/add-operational-value OWNER/REPO WORKFLOW`. Agree on what counts as success,
   where the evidence comes from, and which facts may remain unknown.
3. **Keep that rule fixed.** The skill authors a measurement function. New reports
   use that same rule; they do not ask a model to invent a new score each time.
   An existing verified definition should be reused, not silently redesigned.
4. **Collect evidence and read the report.** Creating a definition is not enough:
   the workflow needs an implemented check and real evidence. Look at the result,
   the downstream links and the missing pieces before making a decision.

> [!IMPORTANT]
> **The example uses newer source-branch tooling.** Main has an earlier skill.
> The portable pulse report and File Diet replay described here require the
> pinned `mnkiefer-workflow-operational-value` sources. This guide does not
> install or deploy them. Follow the
> [prerequisites and version boundary](operational-value-evidence-reference.md#prerequisites-and-version-boundary)
> before running the advanced commands.

You do not need a campaign or a dashboard to read or replay the saved example.
Generating a report does not grant write permission, enroll a repository or
start a schedule.

## Go deeper when you need to

**[Replay the saved report](operational-value-evidence-reference.md#replay-the-file-diet-report)**
for exact checkout and offline commands, expected readings and test instructions.

**[Understand value beyond this example](agent-work-value.md)**
for the research: what agent benchmarks, developer-productivity studies and
financial measures each tell you, where CAO fits, and which evidence is still missing.

**[Use the technical reference](operational-value-evidence-reference.md)**
for frozen contracts, output receipts, Git matching, primary/diagnostic roles,
historical comparisons and publication boundaries.
