package postgresx

import (
	"reflect"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestNormalizeProjectedFacts(t *testing.T) {
	for _, test := range []struct {
		name, source string
		row, facts   model.Row
	}{
		{"target", "$audits", model.Row{"targetRepo": "octo/api"}, model.Row{"targetOrganization": "octo", "targetRepository": "api"}},
		{"repository", "$repositories", model.Row{"fullName": "octo/api"}, model.Row{"owner": "octo", "name": "api"}},
		{"run repository", "$runs", model.Row{"repositoryFullName": "octo/api"}, model.Row{"owner": "octo", "repository": "api"}},
		{"grader facts", "$graders", model.Row{"name": "quality", "sourceGraderId": "quality-v1"}, model.Row{"name": "quality", "sourceGraderId": "quality-v1"}},
		{"eval facts", "$evals", model.Row{"name": "correctness", "sourceEvalId": "correctness-v1"}, model.Row{"name": "correctness", "sourceEvalId": "correctness-v1"}},
		{"grader time", "$graderObservations", model.Row{"resultTimestamp": "2026-10-02T00:00:00Z"}, model.Row{"timestamp": "2026-10-02T00:00:00Z"}},
		{"eval facts", "$evalObservations", model.Row{"resultTimestamp": nil, "answer": "UNKNOWN"}, model.Row{"timestamp": nil, "evalResult": "UNKNOWN"}},
		{"equivalent time", "$evalObservations", model.Row{"timestamp": "2026-10-02T00:00:00.000Z", "resultTimestamp": "2026-10-02T00:00:00Z"}, model.Row{"timestamp": "2026-10-02T00:00:00.000Z"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			original := model.Row{}
			for field, value := range test.row {
				original[field] = value
			}
			row, err := normalizeProjectedFacts(test.source, test.row)
			if err != nil {
				t.Fatal(err)
			}
			for field, value := range test.facts {
				if actual, present := row[field]; !present || !reflect.DeepEqual(actual, value) {
					t.Fatalf("%s = %#v, want %#v", field, actual, value)
				}
			}
			if !reflect.DeepEqual(test.row, original) {
				t.Fatal("source record was mutated")
			}
		})
	}
}

func TestNormalizeProjectedFactsRejectsConflictingEvidence(t *testing.T) {
	for _, test := range []struct {
		source string
		row    model.Row
	}{
		{"$audits", model.Row{"targetRepo": "octo/api", "targetOrganization": "different"}},
		{"$audits", model.Row{"targetRepo": "octo/api", "targetRepository": nil}},
		{"$audits", model.Row{"targetRepo": "invalid"}},
		{"$audits", model.Row{"targetRepo": 42}},
		{"$graderObservations", model.Row{"timestamp": nil, "resultTimestamp": "2026-10-02T00:00:00Z"}},
		{"$evalObservations", model.Row{"evalResult": "YES", "answer": "NO"}},
	} {
		if _, err := normalizeProjectedFacts(test.source, test.row); err == nil {
			t.Fatalf("accepted conflicting %s facts: %#v", test.source, test.row)
		}
	}
}

func TestTargetCoordinateFields(t *testing.T) {
	for _, test := range []struct {
		source, field, owner, repository string
	}{
		{"$audits", "targetRepo", "targetOrganization", "targetRepository"},
		{"$repositories", "fullName", "owner", "name"},
		{"$runs", "repositoryFullName", "owner", "repository"},
	} {
		field, owner, repository := targetCoordinateFields(test.source)
		if field != test.field || owner != test.owner || repository != test.repository {
			t.Fatalf("targetCoordinateFields(%q) = (%q, %q, %q), want (%q, %q, %q)",
				test.source, field, owner, repository, test.field, test.owner, test.repository)
		}
	}
}

func TestResolveTargetCoordinateFacts(t *testing.T) {
	t.Run("absent field is not an error", func(t *testing.T) {
		facts, stage, err := resolveTargetCoordinateFacts(model.Row{}, "targetRepo", "targetOrganization", "targetRepository")
		if err != nil || stage != "" || facts != nil {
			t.Fatalf("got (%#v, %q, %v), want (nil, \"\", nil)", facts, stage, err)
		}
	})
	t.Run("valid coordinate resolves owner and repository", func(t *testing.T) {
		facts, stage, err := resolveTargetCoordinateFacts(
			model.Row{"targetRepo": "octo/api"}, "targetRepo", "targetOrganization", "targetRepository")
		if err != nil {
			t.Fatal(err)
		}
		if stage != "" {
			t.Fatalf("stage = %q, want empty", stage)
		}
		want := map[string]string{"targetOrganization": "octo", "targetRepository": "api"}
		if !reflect.DeepEqual(facts, want) {
			t.Fatalf("facts = %#v, want %#v", facts, want)
		}
	})
	t.Run("non-string coordinate is rejected", func(t *testing.T) {
		_, stage, err := resolveTargetCoordinateFacts(
			model.Row{"targetRepo": 42}, "targetRepo", "targetOrganization", "targetRepository")
		if err == nil || stage != projectedFactsRejectionStageCoordinateType {
			t.Fatalf("got stage=%q err=%v, want stage=%q and an error", stage, err, projectedFactsRejectionStageCoordinateType)
		}
	})
	t.Run("malformed coordinate is rejected", func(t *testing.T) {
		_, stage, err := resolveTargetCoordinateFacts(
			model.Row{"targetRepo": "invalid"}, "targetRepo", "targetOrganization", "targetRepository")
		if err == nil || stage != projectedFactsRejectionStageCoordinateForm {
			t.Fatalf("got stage=%q err=%v, want stage=%q and an error", stage, err, projectedFactsRejectionStageCoordinateForm)
		}
	})
	t.Run("conflicting recomputable fact is rejected", func(t *testing.T) {
		_, stage, err := resolveTargetCoordinateFacts(
			model.Row{"targetRepo": "octo/api", "targetOrganization": "different"},
			"targetRepo", "targetOrganization", "targetRepository")
		if err == nil || stage != projectedFactsRejectionStageCoordinateFact {
			t.Fatalf("got stage=%q err=%v, want stage=%q and an error", stage, err, projectedFactsRejectionStageCoordinateFact)
		}
	})
}
