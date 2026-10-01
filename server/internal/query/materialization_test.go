package query

import "testing"

func TestStaticDefinitionsExcludeDynamicAndUnavailableDependencies(t *testing.T) {
	field := "window"
	definitions := []Definition{
		{Name: "static", From: "runs"},
		{
			Name: "dynamic", From: "runs",
			Compute: []ComputedField{{As: "window", Function: "literal", Args: []Argument{{Context: "time-window"}}}},
			Select:  []SelectedField{{Field: field}},
		},
		{Name: "dynamic-dependent", From: "dynamic"},
		{Name: "missing-dependent", From: "runtime-health"},
	}

	selected, names := StaticDefinitions(definitions, map[string]bool{"runs": true})
	if len(selected) != 1 || selected[0].Name != "static" {
		t.Fatalf("selected = %#v, want only static", selected)
	}
	if len(names) != 1 || names[0] != "static" {
		t.Fatalf("names = %#v, want only static", names)
	}
}

func TestDefinitionSignatureIsStableAndSensitive(t *testing.T) {
	first := Definition{Name: "runs", From: "runs", Select: []SelectedField{{Field: "id"}}}
	second := first
	second.Select = []SelectedField{{Field: "conclusion"}}

	firstSignature, err := DefinitionSignature(first)
	if err != nil {
		t.Fatal(err)
	}
	repeatedSignature, err := DefinitionSignature(first)
	if err != nil {
		t.Fatal(err)
	}
	secondSignature, err := DefinitionSignature(second)
	if err != nil {
		t.Fatal(err)
	}
	if firstSignature != repeatedSignature {
		t.Fatalf("signature changed: %q != %q", firstSignature, repeatedSignature)
	}
	if firstSignature == secondSignature {
		t.Fatalf("different definitions share signature %q", firstSignature)
	}
}
