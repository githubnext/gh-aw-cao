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
