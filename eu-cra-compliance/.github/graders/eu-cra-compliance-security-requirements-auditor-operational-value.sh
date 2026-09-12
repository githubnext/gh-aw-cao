#!/usr/bin/env bash

WORKFLOW_NAME="EU CRA / Security"
SOURCE_PATH=".github/workflows/eu-cra-compliance-security-requirements-auditor.md"
TITLE_PREFIX="[eu-cra:security-requirements] "
DOMAIN="security-requirements"
OPERATIONAL_VALUE="Establish a durable product-cybersecurity requirement-to-evidence record with actionable implementation gaps."
OPPORTUNITY="A dispatched target repository whose applicable CRA essential product cybersecurity requirements can be mapped to implementation evidence."
ACCEPTED="A non-bot human explicitly accepts the report for the frozen target commit after reviewing its requirement-to-evidence matrix, regulatory provenance, cross-cutting gaps, remediation backlog, and human-review questions."
METRIC_ID="human-accepted-security-requirements-record"

source "${GITHUB_WORKSPACE:-.}/.github/aw/eu-cra-compliance/eu-cra-report-operational-value-runtime.bash"
