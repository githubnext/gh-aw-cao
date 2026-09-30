package githubquota

import "testing"

func TestBuildRegistryProvidersNormalizesAndDeduplicates(t *testing.T) {
	providers := []BucketProvider{
		{Name: "  Collector-Primary  ", App: "Collector", Installations: []int64{123, 456}},
		{Name: "collector-secondary", App: "collector-2", Installations: []int64{123}, Resources: []string{"core", "graphql"}},
	}

	normalized, byName, err := buildRegistryProviders(providers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(normalized) != 2 {
		t.Fatalf("normalized providers = %#v, want 2 entries", normalized)
	}
	if normalized[0].Name != "collector-primary" || normalized[0].App != "collector" {
		t.Errorf("normalized[0] = %#v, want trimmed lowercase name and app", normalized[0])
	}
	if index, ok := byName["collector-secondary"]; !ok || index != 1 {
		t.Errorf("byName[collector-secondary] = %d, %t, want 1, true", index, ok)
	}
}

func TestBuildRegistryProvidersRejectsDuplicateName(t *testing.T) {
	providers := []BucketProvider{
		{Name: "a", App: "a", Installations: []int64{1}},
		{Name: "A", App: "b", Installations: []int64{2}},
	}

	if _, _, err := buildRegistryProviders(providers); err == nil {
		t.Fatal("expected an error for a duplicate provider name after normalization")
	}
}

func TestBuildRegistryProvidersRejectsInvalidProvider(t *testing.T) {
	providers := []BucketProvider{{Name: "a", App: "a", Installations: nil}}

	if _, _, err := buildRegistryProviders(providers); err == nil {
		t.Fatal("expected an error for a provider with no installations")
	}
}

func TestBuildRegistryProvidersHandlesEmptyInput(t *testing.T) {
	normalized, byName, err := buildRegistryProviders(nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(normalized) != 0 || len(byName) != 0 {
		t.Errorf("normalized = %#v, byName = %#v, want both empty", normalized, byName)
	}
}

func TestRegistryBucketCount(t *testing.T) {
	tests := []struct {
		name      string
		providers []BucketProvider
		want      int
	}{
		{name: "empty", providers: nil, want: 0},
		{
			name: "single provider single resource",
			providers: []BucketProvider{
				{Installations: []int64{1, 2, 3}, Resources: []string{"core"}},
			},
			want: 3,
		},
		{
			name: "multiple providers multiple resources",
			providers: []BucketProvider{
				{Installations: []int64{1, 2}, Resources: []string{"core", "graphql"}},
				{Installations: []int64{1}, Resources: []string{"core"}},
			},
			want: 5,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := registryBucketCount(tt.providers); got != tt.want {
				t.Errorf("registryBucketCount() = %d, want %d", got, tt.want)
			}
		})
	}
}
