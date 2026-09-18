---
private: true
name: Close Issues by Label
description: Closes every open issue with a label supplied to the /close-issues command.
intent: Let maintainers remove labeled preview issues without repetitive manual cleanup.
on:
  slash_command:
    strategy: centralized
    name: close-issues
    events: [issue_comment]
  reaction: none
permissions:
  contents: read
  issues: read
  copilot-requests: write
strict: true
tools:
  github:
    mode: gh-proxy
    min-integrity: approved
    toolsets: [issues]
  bash: [gh]
safe-outputs:
  close-issue:
    target: "*"
    max: 100
    state-reason: completed
  noop:
    report-as-issue: false
---

# Close Issues by Label

Close every open issue in this repository that has the label supplied after the `/close-issues` command.

1. Parse the command text as `/close-issues <label>`. Treat all remaining text after the command as the exact label name, including spaces.
2. If the label argument is missing, the label does not exist, or more than 100 open issues have the label, call `noop` with a concise explanation and make no changes.
3. Use bounded, paginated GitHub reads to find open issues with the exact label. Exclude pull requests.
4. Call `close_issue` once for each matching issue number. Do not add a closing comment.
5. If no open issues have the label, call `noop` with the label name.

Never target another repository. Never use raw GitHub writes; all closures must use the declared safe output.
