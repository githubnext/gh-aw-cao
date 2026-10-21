package cli

import (
	"strings"
	"testing"
)

func TestNativeOperationsPolicy(t *testing.T) {
	for _, tt := range []struct {
		name   string
		fields map[string]any
		valid  bool
	}{
		{"minimal", map[string]any{}, true},
		{"bounded", map[string]any{"mode": "live", "max-mode": "review", "max-repositories": 2}, true},
		{"execution authority", map[string]any{"permissions": "write"}, false},
		{"fleet topology", map[string]any{"rollout-percent": 50}, false},
		{"outside target", map[string]any{"targets": map[string]any{"outside/repo": map[string]any{"mode": "live"}}}, false},
		{"excessive cap", map[string]any{"max-repositories": 1001}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			policy := map[string]any{
				"version": 1, "gh-aw-version": "v0.92.6",
				"control-plane": map[string]any{
					"scope":      map[string]any{"allowed-owners": []string{"acme"}},
					"operations": map[string]any{"audit": tt.fields},
				},
			}
			if err := nativeValidatePolicy(policy); (err == nil) != tt.valid {
				t.Fatalf("valid=%v, error=%v", tt.valid, err)
			}
		})
	}
}

func TestNativeOperationWorkflowConflict(t *testing.T) {
	policy := map[string]any{
		"version": 1, "gh-aw-version": "v0.92.6",
		"control-plane": map[string]any{
			"operations": map[string]any{"audit": map[string]any{}},
			"campaigns": map[string]any{"maintenance": map[string]any{
				"workers": map[string]any{"check": map[string]any{"workflow": "audit"}},
			}},
		},
	}
	if err := nativeValidatePolicy(policy); err == nil || !strings.Contains(err.Error(), "conflicts") {
		t.Fatalf("expected workflow identity conflict, got %v", err)
	}
}
