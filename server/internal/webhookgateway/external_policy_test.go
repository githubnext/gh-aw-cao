package webhookgateway

import (
	"encoding/json"
	"testing"
)

func TestExternalEnrollmentStrictDecoding(t *testing.T) {
	base, _, _ := externalFixture(t)
	for _, source := range base.Policy.ExternalSources {
		for _, scenario := range []string{"unknown-field", "null", "unsafe-secret", "unknown-destination", "noncanonical-url", "wrong-provider-fields"} {
			t.Run(source.ID+"/"+scenario, func(t *testing.T) {
				data, err := json.Marshal(source)
				if err != nil {
					t.Fatal(err)
				}
				var raw map[string]any
				if err := json.Unmarshal(data, &raw); err != nil {
					t.Fatal(err)
				}
				switch scenario {
				case "unknown-field":
					raw["privateKey"] = "forbidden"
				case "null":
					raw["scope"] = nil
				case "unsafe-secret":
					raw["secretEnv"] = "GITHUB_TOKEN"
				case "unknown-destination":
					raw["destinationRepositoryIds"] = []int{99}
				case "noncanonical-url":
					raw["resourceUrlPrefix"] = "https://example.com/a/../"
				case "wrong-provider-fields":
					if source.Event == "webhook" {
						raw["scope"] = ""
					} else {
						raw["urlPath"] = ""
					}
				}
				data, err = json.Marshal(raw)
				if err != nil {
					t.Fatal(err)
				}
				var parsed ExternalSource
				err = json.Unmarshal(data, &parsed)
				if scenario == "unknown-destination" && err == nil {
					policy := base.Policy
					policy.ExternalSources = []ExternalSource{parsed}
					err = validateExternalSources(policy)
				}
				if err == nil {
					t.Fatal("invalid external enrollment accepted")
				}
			})
		}
	}
}

func TestProviderManifestsRejectMissingOrAmbiguousContracts(t *testing.T) {
	_, registry, _ := externalFixture(t)
	original := registry.Records[0].Workflows[0].Triggers
	for _, scenario := range []string{"missing-normalization", "unknown-policy", "wrong-provider", "missing-scope",
		"duplicate-native-event", "wrong-native-event", "azure-missing-closed-states", "generic-multiple-types", "generic-prototype-path", "generic-legacy-version"} {
		t.Run(scenario, func(t *testing.T) {
			data, err := json.Marshal(original)
			if err != nil {
				t.Fatal(err)
			}
			var triggers []CompilerTrigger
			if err := json.Unmarshal(data, &triggers); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "missing-normalization":
				triggers[0].ActivityNormalization = nil
			case "unknown-policy":
				triggers[0].ActivityNormalization.Policy = "unknown/v1"
			case "wrong-provider":
				triggers[0].Provider = "linear"
			case "missing-scope":
				triggers[0].Conditions = nil
			case "duplicate-native-event":
				triggers[0].NativeEvents = append(triggers[0].NativeEvents, triggers[0].NativeEvents[0])
			case "wrong-native-event":
				triggers[0].NativeEvents = []string{"create"}
			case "azure-missing-closed-states":
				triggers[2].ActivityNormalization.ClosedStates = nil
			case "generic-multiple-types":
				triggers[3].Types = []string{"com.example.deploy", "com.example.release"}
			case "generic-prototype-path":
				triggers[4].Conditions[0].Path = []string{"__proto__"}
			case "generic-legacy-version":
				triggers[3].SchemaVersion = 1
			}
			data, err = json.Marshal(map[string]any{"version": 1, "webhook_subscriptions": triggers})
			if err != nil {
				t.Fatal(err)
			}
			lock := append([]byte("# gh-aw-manifest: "), data...)
			if _, err := ParseWorkflowManifest(lock, ".github/workflows/test.lock.yml", DefaultLimits()); err == nil {
				t.Fatal("ambiguous compiler provider/generic declaration accepted")
			}
		})
	}
}
