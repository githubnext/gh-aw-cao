#!/usr/bin/env bash

WORKFLOW_NAME="Dev Practices / NIST SSDF"
SOURCE_PATH=".github/workflows/software-development-practices-nist-ssdf.md"
TITLE_PREFIX="[nist-ssdf] "
FRAMEWORK="nist-ssdf"
OPERATIONAL_VALUE="Establish a human-accepted, evidence-backed record of prioritized secure-development improvements under the current final NIST Secure Software Development Framework."
OPPORTUNITY="A dispatched target repository that ships or supports software with repository-observable secure-development lifecycle evidence that can be reviewed against the current final NIST SSDF."
ACCEPTED="A non-bot human explicitly accepts the guidance for the frozen target commit after reviewing its final-publication provenance, practice-to-evidence matrix, prioritized backlog, limitations, and human-review questions."
METRIC_ID="human-accepted-nist-ssdf-guidance"

source "${BASH_SOURCE[0]%/*}/../software-development-guidance-operational-value-runtime.bash"
