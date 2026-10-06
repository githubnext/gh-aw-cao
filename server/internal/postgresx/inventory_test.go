package postgresx

import (
	"reflect"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
)

func TestResolveInventoryFieldPicksFirstPresentInput(t *testing.T) {
	binding := inventoryBinding{field: "name", inputs: []string{"campaign-name", "package-name"}}
	value, present := resolveInventoryField(binding, model.Row{"package-name": "fallback", "campaign-name": "primary"})
	if !present || value != "primary" {
		t.Fatalf("expected primary input to win: value=%v present=%t", value, present)
	}
}

func TestResolveInventoryFieldFallsBackWhenFirstInputMissing(t *testing.T) {
	binding := inventoryBinding{field: "name", inputs: []string{"campaign-name", "package-name"}}
	value, present := resolveInventoryField(binding, model.Row{"package-name": "fallback"})
	if !present || value != "fallback" {
		t.Fatalf("expected fallback input: value=%v present=%t", value, present)
	}
}

func TestResolveInventoryFieldAppliesDefaultWhenAbsent(t *testing.T) {
	binding := inventoryBinding{field: "icon", inputs: []string{"campaign-icon"}, defaultPresent: true, defaultValue: "goal"}
	value, present := resolveInventoryField(binding, model.Row{})
	if !present || value != "goal" {
		t.Fatalf("expected default value: value=%v present=%t", value, present)
	}
}

func TestResolveInventoryFieldTrimsAndFallsBackToDefaultOnEmpty(t *testing.T) {
	binding := inventoryBinding{field: "name", inputs: []string{"workflow-name"}, trim: true, defaultPresent: true, defaultValue: ""}
	value, present := resolveInventoryField(binding, model.Row{"workflow-name": "   "})
	if !present || value != "" {
		t.Fatalf("expected trimmed value to fall back to default: value=%v present=%t", value, present)
	}
}

func TestResolveInventoryFieldOmitsEmptyWithoutDefault(t *testing.T) {
	binding := inventoryBinding{field: "githubId", inputs: []string{"workflow-id"}, trim: true, omitEmpty: true}
	_, present := resolveInventoryField(binding, model.Row{"workflow-id": "   "})
	if present {
		t.Fatal("expected omitEmpty binding to suppress a blank trimmed value")
	}
}

func TestResolveInventoryFieldAppliesEqualsProjection(t *testing.T) {
	binding := inventoryBinding{field: "experimental", inputs: []string{"campaign-experimental"}, equalsPresent: true, equals: true}
	value, present := resolveInventoryField(binding, model.Row{"campaign-experimental": true})
	if !present || value != true {
		t.Fatalf("expected equals projection to report true: value=%v present=%t", value, present)
	}
	value, present = resolveInventoryField(binding, model.Row{"campaign-experimental": false})
	if !present || value != false {
		t.Fatalf("expected equals projection to report false: value=%v present=%t", value, present)
	}
}

func TestResolveInventoryFieldAppliesNotEqualsProjection(t *testing.T) {
	binding := inventoryBinding{field: "enabled", inputs: []string{"campaign-enabled"}, notEqualsPresent: true, notEquals: false}
	value, present := resolveInventoryField(binding, model.Row{"campaign-enabled": false})
	if !present || value != false {
		t.Fatalf("expected not-equals projection to report false: value=%v present=%t", value, present)
	}
}

func TestNormalizeInventoryFieldsRejectsUnregisteredKind(t *testing.T) {
	if _, err := NormalizeInventoryFields("unknown-kind", model.Row{}); err == nil {
		t.Fatal("expected an error for an unregistered inventory observation kind")
	}
}

func TestNormalizeInventoryFieldsProjectsRegisteredKind(t *testing.T) {
	row, err := NormalizeInventoryFields("repositories", model.Row{"visibility": "public", "rollout-mode": "live"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expected := model.Row{"visibility": "public", "rolloutMode": "live", "organizationLink": nil, "repositoryLink": nil}
	if !reflect.DeepEqual(row, expected) {
		t.Fatalf("got %#v, want %#v", row, expected)
	}
}

func TestNormalizeInventoryFieldsAppliesVisibilityDefault(t *testing.T) {
	row, err := NormalizeInventoryFields("repositories", model.Row{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if row["visibility"] != "unknown" {
		t.Fatalf("expected default visibility, got %v", row["visibility"])
	}
}
