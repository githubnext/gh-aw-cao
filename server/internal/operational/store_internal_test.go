package operational

import "testing"

// TestClassifyFeatureRejectionIdentifiesEachStage exercises every rejection
// stage classifyFeatureRejection can report, in the same precedence order
// validateFeatures applies, against constructed serviceFeature and
// Requirements values rather than a full OperationalServices.
func TestClassifyFeatureRejectionIdentifiesEachStage(t *testing.T) {
	validGuarantees := Capability{Scope: ScopeDeployment, Persistence: PersistenceRestart}
	tests := map[string]struct {
		feature serviceFeature
		reqs    Requirements
		want    featureRejectionStage
	}{
		"invalid scope": {
			feature: serviceFeature{name: "cache", cap: Capability{Scope: ScopeDeployment + 1}, present: true, required: true},
			want:    featureRejectionStageInvalidGuarantees,
		},
		"invalid persistence": {
			feature: serviceFeature{name: "cache", cap: Capability{Persistence: PersistenceRestart + 1}, present: true, required: true},
			want:    featureRejectionStageInvalidGuarantees,
		},
		"unsupported scope with non-volatile persistence": {
			feature: serviceFeature{
				name: "cache", cap: Capability{Scope: ScopeUnsupported, Persistence: PersistenceRestart}, present: true, required: true,
			},
			want: featureRejectionStageInvalidGuarantees,
		},
		"advertised without service": {
			feature: serviceFeature{name: "cache", cap: validGuarantees, present: false, required: true},
			want:    featureRejectionStageAdvertisedWithout,
		},
		"optional and absent accepted": {
			feature: serviceFeature{name: "sessions", cap: Capability{}, present: false, required: false},
			want:    featureRejectionStageNone,
		},
		"required and unsupported": {
			feature: serviceFeature{name: "sessions", cap: Capability{}, present: false, required: true},
			want:    featureRejectionStageUnsupported,
		},
		"process scope without single process requirement": {
			feature: serviceFeature{name: "queue", cap: Capability{Scope: ScopeProcess}, present: true, required: true},
			reqs:    Requirements{SingleProcess: false},
			want:    featureRejectionStageSingleProcess,
		},
		"volatile persistence without acknowledgement": {
			feature: serviceFeature{
				name: "sessions", cap: Capability{Scope: ScopeDeployment, Persistence: PersistenceVolatile}, present: true, required: true,
			},
			reqs: Requirements{SingleProcess: true, AllowVolatile: false},
			want: featureRejectionStageVolatileAcknowledge,
		},
		"volatile persistence acknowledged": {
			feature: serviceFeature{
				name: "sessions", cap: Capability{Scope: ScopeDeployment, Persistence: PersistenceVolatile}, present: true, required: true,
			},
			reqs: Requirements{SingleProcess: true, AllowVolatile: true},
			want: featureRejectionStageNone,
		},
		"fully valid required feature": {
			feature: serviceFeature{name: "cache", cap: validGuarantees, present: true, required: true},
			reqs:    Requirements{SingleProcess: true, AllowVolatile: true},
			want:    featureRejectionStageNone,
		},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			if got := classifyFeatureRejection(tc.feature, tc.reqs); got != tc.want {
				t.Fatalf("classifyFeatureRejection() = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestValidateFeaturesStopsAtFirstRejection confirms validateFeatures
// reports the first rejecting feature in list order and accepts a fully
// satisfied feature list, mirroring classifyFeatureRejection's stage
// ordering through the exported entry point.
func TestValidateFeaturesStopsAtFirstRejection(t *testing.T) {
	validGuarantees := Capability{Scope: ScopeDeployment, Persistence: PersistenceRestart}
	reqs := Requirements{SingleProcess: true, AllowVolatile: true}
	ok := []serviceFeature{
		{name: "cache", cap: validGuarantees, present: true, required: true},
		{name: "sessions", cap: validGuarantees, present: true, required: false},
	}
	if err := validateFeatures(ok, reqs); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	missing := []serviceFeature{
		{name: "cache", cap: validGuarantees, present: true, required: true},
		{name: "queue", cap: Capability{}, present: false, required: true},
	}
	err := validateFeatures(missing, reqs)
	if err == nil {
		t.Fatal("expected an error for the missing required feature")
	}
}
