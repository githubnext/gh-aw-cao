package queryengine

import (
	"context"
	"errors"
	"testing"
)

func TestSessionSharesOperationBudget(t *testing.T) {
	session := NewSession(context.Background(), Options{MaxOperations: 3})
	input := func(string) ([]map[string]any, error) {
		return []map[string]any{{"id": 1}, {"id": 2}}, nil
	}
	if _, err := session.Execute(map[string]any{"from": "input"}, input); err != nil {
		t.Fatal(err)
	}
	_, err := session.Execute(map[string]any{"from": "input"}, input)
	var cancelled *NativeQueryCancelledError
	if !errors.As(err, &cancelled) || cancelled.Kind != "budget" || session.Operations() != 4 {
		t.Fatalf("shared session budget: operations=%d error=%v", session.Operations(), err)
	}
}

func TestSessionStageResourceChecks(t *testing.T) {
	boundary := errors.New("caller working-set boundary")
	session := NewSession(context.Background(), Options{Observe: func(stage string, rows []map[string]any) error {
		if stage == "select" {
			return boundary
		}
		return nil
	}})
	_, err := session.Execute(map[string]any{
		"from": "input", "select": []any{map[string]any{"field": "id"}},
	}, func(string) ([]map[string]any, error) { return []map[string]any{{"id": 1}}, nil })
	if !errors.Is(err, boundary) {
		t.Fatalf("stage boundary was ignored: %v", err)
	}
}
