package query

import (
	"errors"
	"reflect"
	"testing"
)

func TestWalkPlanResolvesAllRootsBeforeDependents(t *testing.T) {
	definitions := []Definition{
		{Name: "selected", From: "$runs", Union: []string{"$more"},
			Joins: []Join{{Source: "$workflows", Type: "left", On: []JoinKey{{Left: "workflowId", Right: "id"}}}}},
		{Name: "summary", From: "selected"},
	}
	var steps []string
	err := WalkPlan(definitions, []string{"summary", "$repositories"}, func(name string) error {
		steps = append(steps, "load:"+name)
		return nil
	}, func(definition Definition) error {
		steps = append(steps, "visit:"+definition.Name)
		return nil
	})
	want := []string{"load:$runs", "load:$more", "load:$workflows", "visit:selected", "visit:summary", "load:$repositories"}
	if err != nil || !reflect.DeepEqual(steps, want) {
		t.Fatalf("steps=%v error=%v", steps, err)
	}
}

func TestWalkPlanDoesNotHideOptionalSourceErrors(t *testing.T) {
	failure := errors.New("source unavailable")
	for _, definition := range []Definition{
		{Name: "result", From: "$runs", Union: []string{"$missing"}},
		{Name: "result", From: "$runs", Joins: []Join{{Source: "$missing", Type: "left", On: []JoinKey{{Left: "id", Right: "id"}}}}},
	} {
		err := WalkPlan([]Definition{definition}, []string{"result"}, func(name string) error {
			if name == "$missing" {
				return failure
			}
			return nil
		}, func(Definition) error {
			t.Fatal("visited a definition with an unresolved source")
			return nil
		})
		if !errors.Is(err, failure) {
			t.Fatalf("optional input error was hidden: %v", err)
		}
	}
}

func TestWalkPlanRejectsInvalidDefinitionsBeforeLoading(t *testing.T) {
	err := WalkPlan([]Definition{{Name: "invalid"}}, []string{"invalid"}, func(string) error {
		t.Fatal("loaded a source for an invalid plan")
		return nil
	}, func(Definition) error {
		t.Fatal("visited an invalid definition")
		return nil
	})
	if err == nil {
		t.Fatal("invalid definition accepted")
	}
}
