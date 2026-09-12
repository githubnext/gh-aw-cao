#!/usr/bin/env bash

WORKFLOW_NAME="EU CRA / Conformity"
SOURCE_PATH=".github/workflows/eu-cra-compliance-conformity-release-evidence.md"
TITLE_PREFIX="[eu-cra:conformity-release] "
DOMAIN="conformity-release"
OPERATIONAL_VALUE="Establish a durable release-version evidence record for human technical-documentation, conformity, declaration, and market-release gates."
OPPORTUNITY="A dispatched target repository whose release-version technical documentation and conformity-gate evidence can be assessed."
ACCEPTED="A non-bot human explicitly accepts the report for the frozen target commit after reviewing its release-version traceability, documentation matrix, conformity register, release-gate evidence, gaps, and named decisions."
METRIC_ID="human-accepted-conformity-release-record"

source "${GITHUB_WORKSPACE:-.}/.github/aw/eu-cra-compliance/eu-cra-report-operational-value-runtime.bash"
