#!/usr/bin/env bash

WORKFLOW_NAME="EU CRA / Scope"
SOURCE_PATH=".github/workflows/eu-cra-compliance-scope-classifier.md"
TITLE_PREFIX="[eu-cra:scope] "
DOMAIN="scope-classification"
OPERATIONAL_VALUE="Establish a durable, evidence-backed CRA scope and product-classification record that exposes the decisions requiring human review."
OPPORTUNITY="A dispatched target repository for which CRA scope, economic-operator role, distribution, FOSS treatment, or product classification evidence can be assessed."
ACCEPTED="A non-bot human explicitly accepts the report for the frozen target commit after reviewing its scope, role, FOSS-treatment, distribution, classification, provenance, gap, and human-decision record."
METRIC_ID="human-accepted-scope-record"

source "${GITHUB_WORKSPACE:-.}/.github/aw/eu-cra-compliance/eu-cra-report-operational-value-runtime.bash"
