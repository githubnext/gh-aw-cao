package postgresx

import (
	"fmt"
	"maps"
	"reflect"
	"regexp"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

var targetCoordinate = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)$`)

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
				return nil, fmt.Errorf("workflow.campaign must be a nonempty slug")
			}
			set("campaignId", "campaign:dashboard-sources:"+model.EncodeCoordinate(strings.TrimSpace(slug)))
		}
	case "$audits", "$repositories", "$runs":
		field, owner, repository := "targetRepo", "targetOrganization", "targetRepository"
		switch source {
		case "$repositories":
			field, owner, repository = "fullName", "owner", "name"
		case "$runs":
			field, owner, repository = "repositoryFullName", "owner", "repository"
		}
		value := row[field]
		if value == nil {
			break
		}
		coordinate, valid := value.(string)
		if !valid {
			return nil, fmt.Errorf("%s must be an owner/repository coordinate", field)
		}
		parts := targetCoordinate.FindStringSubmatch(coordinate)
		if parts == nil {
			return nil, fmt.Errorf("%s must be an owner/repository coordinate", field)
		}
		for index, retained := range []string{owner, repository} {
			if fact, present := row[retained]; present && fact != parts[index+1] {
				return nil, fmt.Errorf("%s conflicts with recomputable %s", retained, field)
			}
			set(retained, parts[index+1])
		}
	case "$graderObservations", "$evalObservations":
		if err := retain("timestamp", "resultTimestamp", true); err != nil {
			return nil, err
		}
		if source == "$evalObservations" {
			if err := retain("evalResult", "answer", false); err != nil {
				return nil, err
			}
		}
	}
	return row, nil
}
