#!/usr/bin/env bash

WORKFLOW_NAME="Dev Practices / Well-Architected"
SOURCE_PATH=".github/workflows/software-development-practices-github-well-architected.md"
TITLE_PREFIX="[well-architected] "
FRAMEWORK="github-well-architected"
OPERATIONAL_VALUE="Establish a human-accepted, evidence-backed record of prioritized repository improvements under current official GitHub Well-Architected guidance."
OPPORTUNITY="A dispatched target repository with repository-observable collaboration, workflow, GitHub configuration, or architecture evidence that can be reviewed against current official GitHub Well-Architected guidance."
ACCEPTED="A non-bot human explicitly accepts the guidance for the frozen target commit after reviewing its official source revision, pillar-to-evidence matrix, prioritized backlog, limitations, and human-review questions."
METRIC_ID="human-accepted-well-architected-guidance"

source "${BASH_SOURCE[0]%/*}/../software-development-guidance-operational-value-runtime.bash"
