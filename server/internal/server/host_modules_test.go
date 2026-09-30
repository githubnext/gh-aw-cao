package server

import "testing"

func TestTargetPolicyOverridesCapabilities(t *testing.T) {
	trueValue := true
	tests := []struct {
		name   string
		policy targetPolicy
		want   bool
	}{
		{name: "no overrides", policy: targetPolicy{Module: "container"}, want: false},
		{name: "authentication override", policy: targetPolicy{Authentication: HostAuthenticationOAuth}, want: true},
		{name: "listener override", policy: targetPolicy{Listener: HostListenerPlatform}, want: true},
		{name: "require-https override", policy: targetPolicy{RequireHTTPS: &trueValue}, want: true},
		{name: "trust-platform-proxy override", policy: targetPolicy{TrustPlatformProxy: &trueValue}, want: true},
		{name: "supports-single-replica override", policy: targetPolicy{SupportsSingleReplica: &trueValue}, want: true},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := targetPolicyOverridesCapabilities(testCase.policy); got != testCase.want {
				t.Errorf("targetPolicyOverridesCapabilities(%+v) = %t, want %t", testCase.policy, got, testCase.want)
			}
		})
	}
}

func TestApplyTargetModuleOverridesRejectsOverridesOnFixedModule(t *testing.T) {
	fixed := hostTargetModules["container"]
	if _, err := applyTargetModuleOverrides(fixed, targetPolicy{Module: "container", Listener: HostListenerPlatform}); err == nil {
		t.Fatal("expected an error when overriding a fixed host target module's capabilities")
	}
}

func TestApplyTargetModuleOverridesAcceptsFixedModuleWithoutOverrides(t *testing.T) {
	fixed := hostTargetModules["container"]
	resolved, err := applyTargetModuleOverrides(fixed, targetPolicy{Module: "container"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved != fixed {
		t.Errorf("applyTargetModuleOverrides changed a fixed module without any override: got %+v, want %+v", resolved, fixed)
	}
}

func TestApplyTargetModuleOverridesRequiresAuthenticationAndListenerOnGeneric(t *testing.T) {
	generic := hostTargetModules["generic"]
	if _, err := applyTargetModuleOverrides(generic, targetPolicy{Module: "generic"}); err == nil {
		t.Fatal("expected an error when the generic module is missing authentication and listener")
	}
	if _, err := applyTargetModuleOverrides(generic, targetPolicy{
		Module:   "generic",
		Listener: HostListenerProcess,
	}); err == nil {
		t.Fatal("expected an error when the generic module is missing authentication")
	}
}

func TestApplyTargetModuleOverridesRejectsNonOAuthAuthenticationOnGeneric(t *testing.T) {
	generic := hostTargetModules["generic"]
	if _, err := applyTargetModuleOverrides(generic, targetPolicy{
		Module:         "generic",
		Authentication: HostAuthenticationBearer,
		Listener:       HostListenerProcess,
	}); err == nil {
		t.Fatal("expected an error when the generic module requests bearer authentication")
	}
}

func TestApplyTargetModuleOverridesMergesGenericCapabilities(t *testing.T) {
	generic := hostTargetModules["generic"]
	requireHTTPS := true
	trustProxy := true
	singleReplica := true
	resolved, err := applyTargetModuleOverrides(generic, targetPolicy{
		Module:                "generic",
		Authentication:        HostAuthenticationOAuth,
		Listener:              HostListenerPlatform,
		RequireHTTPS:          &requireHTTPS,
		TrustPlatformProxy:    &trustProxy,
		SupportsSingleReplica: &singleReplica,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved.authentication != HostAuthenticationOAuth ||
		resolved.listener != HostListenerPlatform ||
		!resolved.requireHTTPS ||
		!resolved.trustPlatformProxy ||
		!resolved.supportsSingleReplica {
		t.Fatalf("applyTargetModuleOverrides did not merge overrides: %+v", resolved)
	}
}

func TestGenericHostCannotDisableHTTPS(t *testing.T) {
	disabled := false
	for _, listener := range []HostListener{HostListenerProcess, HostListenerExternal, HostListenerPlatform} {
		if _, err := applyTargetModuleOverrides(hostTargetModules["generic"], targetPolicy{
			Module: "generic", Authentication: HostAuthenticationOAuth,
			Listener: listener, RequireHTTPS: &disabled,
		}); err == nil {
			t.Fatalf("generic %s listener accepted disabled HTTPS", listener)
		}
	}
}

func TestApplyTargetModuleOverridesDefaultsRequireHTTPSToTrueOnGeneric(t *testing.T) {
	generic := hostTargetModules["generic"]
	resolved, err := applyTargetModuleOverrides(generic, targetPolicy{
		Module:         "generic",
		Authentication: HostAuthenticationOAuth,
		Listener:       HostListenerProcess,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resolved.requireHTTPS {
		t.Error("expected the generic module to default require-https to true without an explicit override")
	}
}

func TestRedisPolicyOverridesCapabilities(t *testing.T) {
	trueValue := true
	tests := []struct {
		name   string
		policy redisPolicy
		want   bool
	}{
		{name: "no overrides", policy: redisPolicy{Module: "redis-cloud"}, want: false},
		{name: "session override", policy: redisPolicy{Session: HostRedisSerialized}, want: true},
		{name: "isolate-process-namespace override", policy: redisPolicy{IsolateProcessNamespace: &trueValue}, want: true},
		{name: "single-replica override", policy: redisPolicy{SingleReplica: &trueValue}, want: true},
		{name: "supports-collection override", policy: redisPolicy{SupportsCollection: &trueValue}, want: true},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := redisPolicyOverridesCapabilities(testCase.policy); got != testCase.want {
				t.Errorf("redisPolicyOverridesCapabilities(%+v) = %t, want %t", testCase.policy, got, testCase.want)
			}
		})
	}
}

func TestApplyRedisProviderModuleOverridesRejectsOverridesOnFixedModule(t *testing.T) {
	fixed := redisProviderModules["redis-cloud"]
	if _, err := applyRedisProviderModuleOverrides(fixed, redisPolicy{Module: "redis-cloud", Session: HostRedisSerialized}); err == nil {
		t.Fatal("expected an error when overriding a fixed Redis provider module's capabilities")
	}
}

func TestApplyRedisProviderModuleOverridesAcceptsFixedModuleWithoutOverrides(t *testing.T) {
	fixed := redisProviderModules["redis-cloud"]
	resolved, err := applyRedisProviderModuleOverrides(fixed, redisPolicy{Module: "redis-cloud"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved != fixed {
		t.Errorf("applyRedisProviderModuleOverrides changed a fixed module without any override: got %+v, want %+v", resolved, fixed)
	}
}

func TestApplyRedisProviderModuleOverridesMergesGenericCapabilities(t *testing.T) {
	generic := redisProviderModules["generic"]
	isolate := true
	singleReplica := true
	supportsCollection := false
	resolved, err := applyRedisProviderModuleOverrides(generic, redisPolicy{
		Module:                  "generic",
		Session:                 HostRedisSerialized,
		IsolateProcessNamespace: &isolate,
		SingleReplica:           &singleReplica,
		SupportsCollection:      &supportsCollection,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resolved.session != HostRedisSerialized ||
		!resolved.isolateProcessNamespace ||
		!resolved.singleReplica ||
		resolved.supportsCollection {
		t.Fatalf("applyRedisProviderModuleOverrides did not merge overrides: %+v", resolved)
	}
}

func TestResolveRedisProviderModuleRejectsUnknownModule(t *testing.T) {
	if _, err := resolveRedisProviderModule(redisPolicy{Module: "unknown"}); err == nil {
		t.Fatal("expected an error for an unknown Redis provider module")
	}
}
