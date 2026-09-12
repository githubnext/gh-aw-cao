#!/usr/bin/env bash

WORKFLOW_NAME="EU CRA / Supply Chain"
SOURCE_PATH=".github/workflows/eu-cra-compliance-supply-chain-sbom-auditor.md"
TITLE_PREFIX="[eu-cra:supply-chain-sbom] "
DOMAIN="supply-chain-sbom"
OPERATIONAL_VALUE="Establish a durable component, SBOM, dependency, provenance, and release-traceability evidence record with actionable supply-chain gaps."
OPPORTUNITY="A dispatched target repository whose software supply-chain and SBOM evidence can be assessed against applicable CRA requirements."
ACCEPTED="A non-bot human explicitly accepts the report for the frozen target commit after reviewing its component surface, SBOM matrix, release traceability, vulnerability-management, provenance, gap, and human-review record."
METRIC_ID="human-accepted-supply-chain-record"

source "${GITHUB_WORKSPACE:-.}/.github/aw/eu-cra-compliance/eu-cra-report-operational-value-runtime.bash"
