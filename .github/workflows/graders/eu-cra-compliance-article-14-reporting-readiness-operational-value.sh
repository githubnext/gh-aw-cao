#!/usr/bin/env bash

WORKFLOW_NAME="EU CRA / Article 14"
SOURCE_PATH=".github/workflows/eu-cra-compliance-article-14-reporting-readiness.md"
TITLE_PREFIX="[eu-cra:article-14-readiness] "
DOMAIN="article-14-readiness"
OPERATIONAL_VALUE="Establish a durable Article 14 readiness record covering awareness, escalation, notification clocks, evidence preservation, and human reportability decisions."
OPPORTUNITY="A dispatched target repository with shipped or supported product responsibilities whose Article 14 operational reporting readiness can be assessed."
ACCEPTED="A non-bot human explicitly accepts the report for the frozen target commit after reviewing its awareness, escalation, separate event timelines, timestamp controls, evidence preservation, critical gaps, and reportability decisions."
METRIC_ID="human-accepted-article-14-readiness-record"

source "${BASH_SOURCE[0]%/*}/../../aw/eu-cra-compliance/eu-cra-report-operational-value-runtime.bash"
