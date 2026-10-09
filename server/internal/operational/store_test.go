package operational

import "testing"

// requiredFeature builds a serviceFeature with the given capability and
// presence, marked required, matching the shape ValidateOperationalServices
// constructs for every mandatory service.
func requiredFeature(name string, cap Capability, present bool) serviceFeature {
	return serviceFeature{name: name, cap: cap, present: present, required: true}
}

func TestClassifyFeatureRejectionInvalidGuarantees(t *testing.T) {
	tests := map[string]Capability{
		"scope beyond deployment":        {Scope: ScopeDeployment + 1},
		"persistence beyond restart":     {Scope: ScopeProcess, Persistence: PersistenceRestart + 1},
		"unsupported scope with restart": {Scope: ScopeUnsupported, Persistence: PersistenceRestart},
	}
	for name, cap := range tests {
		t.Run(name, func(t *testing.T) {
			feature := requiredFeature("widget", cap, true)
			if rule := classifyFeatureRejection(feature, Requirements{}); rule != featureRejectionRuleInvalidGuarantees {
				t.Fatalf("classifyFeatureRejection(%+v) = %q, want %q", cap, rule, featureRejectionRuleInvalidGuarantees)
			}
		})
	}
}

func TestClassifyFeatureRejectionMissingService(t *testing.T) {
	feature := requiredFeature("widget", Capability{Scope: ScopeProcess, Persistence: PersistenceRestart}, false)
	if rule := classifyFeatureRejection(feature, Requirements{}); rule != featureRejectionRuleMissingService {
		t.Fatalf("classifyFeatureRejection = %q, want %q", rule, featureRejectionRuleMissingService)
	}
}

func TestClassifyFeatureRejectionNotRequiredSkipsRemainingChecks(t *testing.T) {
	// Not required, scope unsupported and absent: would fail every later
	// check, but validateFeatures' original "continue" skipped them, so
	// classification must still report no rejection.
	feature := serviceFeature{name: "widget", cap: Capability{Scope: ScopeUnsupported}, present: false, required: false}
	if rule := classifyFeatureRejection(feature, Requirements{}); rule != featureRejectionRuleNone {
		t.Fatalf("classifyFeatureRejection = %q, want %q", rule, featureRejectionRuleNone)
	}
}

func TestClassifyFeatureRejectionUnsupported(t *testing.T) {
	feature := requiredFeature("widget", Capability{Scope: ScopeUnsupported, Persistence: PersistenceVolatile}, false)
	if rule := classifyFeatureRejection(feature, Requirements{}); rule != featureRejectionRuleUnsupported {
		t.Fatalf("classifyFeatureRejection = %q, want %q", rule, featureRejectionRuleUnsupported)
	}
}

func TestClassifyFeatureRejectionSingleProcess(t *testing.T) {
	feature := requiredFeature("widget", Capability{Scope: ScopeProcess, Persistence: PersistenceRestart}, true)
	if rule := classifyFeatureRejection(feature, Requirements{SingleProcess: false}); rule != featureRejectionRuleSingleProcess {
		t.Fatalf("classifyFeatureRejection = %q, want %q", rule, featureRejectionRuleSingleProcess)
	}
	if rule := classifyFeatureRejection(feature, Requirements{SingleProcess: true}); rule != featureRejectionRuleNone {
		t.Fatalf("classifyFeatureRejection with SingleProcess = %q, want %q", rule, featureRejectionRuleNone)
	}
}

func TestClassifyFeatureRejectionVolatileState(t *testing.T) {
	volatile := Capability{Scope: ScopeDeployment, Persistence: PersistenceVolatile}
	for _, name := range []string{"sessions", "revocations", "collection"} {
		feature := requiredFeature(name, volatile, true)
		if rule := classifyFeatureRejection(feature, Requirements{SingleProcess: true, AllowVolatile: false}); rule != featureRejectionRuleVolatileState {
			t.Fatalf("classifyFeatureRejection(%s) = %q, want %q", name, rule, featureRejectionRuleVolatileState)
		}
		if rule := classifyFeatureRejection(feature, Requirements{SingleProcess: true, AllowVolatile: true}); rule != featureRejectionRuleNone {
			t.Fatalf("classifyFeatureRejection(%s) with AllowVolatile = %q, want %q", name, rule, featureRejectionRuleNone)
		}
	}
	// A volatile feature outside the named set is not subject to this rule.
	other := requiredFeature("cache", volatile, true)
	if rule := classifyFeatureRejection(other, Requirements{SingleProcess: true, AllowVolatile: false}); rule != featureRejectionRuleNone {
		t.Fatalf("classifyFeatureRejection(cache) = %q, want %q", rule, featureRejectionRuleNone)
	}
}

func TestFeatureRejectionErrorMessages(t *testing.T) {
	feature := serviceFeature{name: "widget"}
	tests := map[featureRejectionRule]string{
		featureRejectionRuleInvalidGuarantees: "widget has invalid operational guarantees",
		featureRejectionRuleMissingService:    "widget advertised without a service: operational capability unsupported",
		featureRejectionRuleUnsupported:       "widget: operational capability unsupported",
		featureRejectionRuleSingleProcess:     "widget requires one owning process",
		featureRejectionRuleVolatileState:     "widget requires explicit volatile-state acknowledgement",
	}
	for rule, want := range tests {
		t.Run(string(rule), func(t *testing.T) {
			err := featureRejectionError(feature, rule)
			if err == nil || err.Error() != want {
				t.Fatalf("featureRejectionError(%q) = %v, want %q", rule, err, want)
			}
		})
	}
	if err := featureRejectionError(feature, featureRejectionRuleNone); err != nil {
		t.Fatalf("featureRejectionError(none) = %v, want nil", err)
	}
}

func TestValidateFeaturesStopsAtFirstRejection(t *testing.T) {
	features := []serviceFeature{
		requiredFeature("first", Capability{Scope: ScopeProcess, Persistence: PersistenceRestart}, true),
		{name: "second", cap: Capability{Scope: ScopeUnsupported, Persistence: PersistenceVolatile}, present: false, required: false},
	}
	if err := validateFeatures(features, Requirements{SingleProcess: true}); err != nil {
		t.Fatalf("expected both valid features to pass, got %v", err)
	}
	features[1].present = false
	features[1].required = true
	features[1].cap = Capability{Scope: ScopeDeployment, Persistence: PersistenceRestart}
	if err := validateFeatures(features, Requirements{SingleProcess: true}); err == nil {
		t.Fatal("expected a missing required service to fail validation")
	}
}
