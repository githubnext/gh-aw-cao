package postgresx

import (
	"fmt"
	"maps"
	"reflect"
	"regexp"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

var targetCoordinate = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)$`)

var projectedFactsLog = logger.New("cao:postgresx:projected_facts")

// projectedFactsRejectionStage identifies which normalization step rejected a
// projected row, so a malformed or conflicting source payload is diagnosable
// without logging the row's coordinate, timestamp, or other field values.
type projectedFactsRejectionStage string

const (
	projectedFactsRejectionStageCampaignSlug   projectedFactsRejectionStage = "campaign-slug"
	projectedFactsRejectionStageCoordinateType projectedFactsRejectionStage = "coordinate-type"
	projectedFactsRejectionStageCoordinateForm projectedFactsRejectionStage = "coordinate-format"
	projectedFactsRejectionStageCoordinateFact projectedFactsRejectionStage = "coordinate-conflict"
	projectedFactsRejectionStageRetainedFact   projectedFactsRejectionStage = "retained-conflict"
)

// targetCoordinateFields selects the source-specific field names used by the
// owner/repository coordinate normalization for $audits, $repositories, and
// $runs. It is a pure lookup extracted from normalizeProjectedFacts so the
// per-source field mapping is independently testable.
func targetCoordinateFields(source string) (field, owner, repository string) {
	switch source {
	case "$repositories":
		return "fullName", "owner", "name"
	case "$runs":
		return "repositoryFullName", "owner", "repository"
	default:
		return "targetRepo", "targetOrganization", "targetRepository"
	}
}

// resolveTargetCoordinateFacts parses row's owner/repository coordinate field
// and reports the owner and repository facts to apply, rejecting a
// non-string or malformed coordinate, or one that conflicts with an already
// present owner or repository fact. It is a pure function extracted from
// normalizeProjectedFacts's coordinate-handling branch so each rejection
// mode is independently testable against a constructed model.Row, without
// exercising the row-mutation bookkeeping shared across all source kinds.
func resolveTargetCoordinateFacts(row model.Row, field, owner, repository string) (map[string]string, projectedFactsRejectionStage, error) {
	value := row[field]
	if value == nil {
		return nil, "", nil
	}
	coordinate, valid := value.(string)
	if !valid {
		return nil, projectedFactsRejectionStageCoordinateType, fmt.Errorf("%s must be an owner/repository coordinate", field)
	}
	parts := targetCoordinate.FindStringSubmatch(coordinate)
	if parts == nil {
		return nil, projectedFactsRejectionStageCoordinateForm, fmt.Errorf("%s must be an owner/repository coordinate", field)
	}
	facts := make(map[string]string, 2)
	for index, retained := range []string{owner, repository} {
		if fact, present := row[retained]; present && fact != parts[index+1] {
			return nil, projectedFactsRejectionStageCoordinateFact, fmt.Errorf("%s conflicts with recomputable %s", retained, field)
		}
		facts[retained] = parts[index+1]
	}
	return facts, "", nil
}

// Preserve the underlying facts before dropping source-shaped recomputable copies.
func normalizeProjectedFacts(source string, input model.Row) (model.Row, error) {
	row := input
	writable := false
	set := func(field string, value any) {
		if !writable {
			row = maps.Clone(row)
			writable = true
		}
		row[field] = value
	}
	retain := func(field, copy string, timestamp bool) error {
		value, present := row[copy]
		if !present {
			return nil
		}
		fact, retained := row[field]
		if !retained {
			set(field, value)
			return nil
		}
		agrees := reflect.DeepEqual(fact, value)
		if !agrees && timestamp {
			agrees = auditSameInstant(fact, value)
		}
		if !agrees {
			return fmt.Errorf("%s conflicts with recomputable %s", field, copy)
		}
		return nil
	}
	switch source {
	case "$workflows":
		if row["campaignId"] == nil && row["campaign"] != nil && row["campaign"] != "" {
			slug, valid := row["campaign"].(string)
			if !valid || strings.TrimSpace(slug) == "" {
				projectedFactsLog.Printf("projected facts rejected source=%s stage=%s", source, projectedFactsRejectionStageCampaignSlug)
				return nil, fmt.Errorf("workflow.campaign must be a nonempty slug")
			}
			set("campaignId", "campaign:dashboard-sources:"+model.EncodeCoordinate(strings.TrimSpace(slug)))
		}
	case "$audits", "$repositories", "$runs":
		field, owner, repository := targetCoordinateFields(source)
		facts, stage, err := resolveTargetCoordinateFacts(row, field, owner, repository)
		if err != nil {
			projectedFactsLog.Printf("projected facts rejected source=%s stage=%s", source, stage)
			return nil, err
		}
		for retained, value := range facts {
			set(retained, value)
		}
	case "$graderObservations", "$evalObservations":
		if err := retain("timestamp", "resultTimestamp", true); err != nil {
			projectedFactsLog.Printf("projected facts rejected source=%s stage=%s", source, projectedFactsRejectionStageRetainedFact)
			return nil, err
		}
		if source == "$evalObservations" {
			if err := retain("evalResult", "answer", false); err != nil {
				projectedFactsLog.Printf("projected facts rejected source=%s stage=%s", source, projectedFactsRejectionStageRetainedFact)
				return nil, err
			}
		}
	}
	return row, nil
}
