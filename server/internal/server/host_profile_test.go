package server

import (
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestBuiltInHostProfilesDeclareExpectedCapabilities(t *testing.T) {
	tests := []struct {
		profile    HostProfile
		auth       HostAuthentication
		listener   HostListener
		session    HostRedisSession
		collection bool
	}{
		{localHostProfile(), HostAuthenticationBearer, HostListenerProcess, HostRedisPooled, true},
		{hostedHostProfile(), HostAuthenticationOAuth, HostListenerProcess, HostRedisPooled, true},
		{azureFunctionsHostProfile(false), HostAuthenticationOAuth, HostListenerPlatform, HostRedisPooled, true},
		{upstashHostProfile(), HostAuthenticationOAuth, HostListenerProcess, HostRedisSerialized, false},
	}
	for _, test := range tests {
		t.Run(test.profile.Name, func(t *testing.T) {
			if err := test.profile.validate(); err != nil {
				t.Fatal(err)
			}
			if test.profile.Authentication != test.auth ||
				test.profile.Listener != test.listener ||
				test.profile.RedisSession != test.session ||
				test.profile.SupportsCollection != test.collection {
				t.Fatalf("unexpected capabilities: %+v", test.profile)
			}
		})
	}
}

func TestHostProfileRejectsInconsistentCapabilities(t *testing.T) {
	base := hostedHostProfile()
	tests := []HostProfile{
		func() HostProfile {
			value := base
			value.Authentication = ""
			return value
		}(),
		func() HostProfile {
			value := base
			value.Listener = ""
			return value
		}(),
		func() HostProfile {
			value := base
			value.RequiresRedis = false
			return value
		}(),
		func() HostProfile {
			value := base
			value.IsolateProcessNamespace = true
			return value
		}(),
		func() HostProfile {
			value := base
			value.SingleReplica = true
			return value
		}(),
		func() HostProfile {
			value := base
			value.Authentication = HostAuthenticationBearer
			value.Listener = HostListenerPlatform
			return value
		}(),
	}

	for _, profile := range tests {
		if err := profile.validate(); err == nil {
			t.Fatalf("accepted inconsistent profile: %+v", profile)
		}
	}
}

func TestHostProfileDefaultsOnlyWhenCompletelyUnset(t *testing.T) {
	config := Config{}
	if err := validateHostProfile(nil, &config); err == nil ||
		!strings.Contains(err.Error(), "requires Redis") {
		t.Fatalf("default local profile did not require Redis: %v", err)
	}

	config.HostProfile = HostProfile{Authentication: HostAuthenticationBearer}
	if err := validateHostProfile(nil, &config); err == nil ||
		!strings.Contains(err.Error(), "requires a name") {
		t.Fatalf("partially configured profile silently defaulted: %v", err)
	}
}

func TestUpstashHostProfileRequiresSerializedClientAndArtifactIngestion(t *testing.T) {
	pooled, err := redisx.New("redis://127.0.0.1:6379")
	if err != nil {
		t.Fatal(err)
	}
	config := Config{HostProfile: upstashHostProfile()}
	if err := validateHostProfile(nil, &config); err == nil ||
		!strings.Contains(err.Error(), "requires Redis") {
		t.Fatalf("accepted missing Redis: %v", err)
	}
	config.SingleReplicaConfirmed = true
	if err := validateHostProfile(redisx.NewStore(pooled, "test"), &config); err == nil ||
		!strings.Contains(err.Error(), "serialized Redis client") {
		t.Fatalf("accepted pooled client: %v", err)
	}

	serialized, err := redisx.NewWithOptions(
		"redis://127.0.0.1:6379",
		redisx.Options{SingleSession: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	standard := Config{HostProfile: hostedHostProfile()}
	if err := validateHostProfile(redisx.NewStore(serialized, "test"), &standard); err == nil ||
		!strings.Contains(err.Error(), "pooled Redis client") {
		t.Fatalf("standard profile accepted serialized client: %v", err)
	}
	if err := validateHostProfile(redisx.NewStore(serialized, "test"), &config); err == nil ||
		!strings.Contains(err.Error(), "namespace isolation") {
		t.Fatalf("accepted non-isolated store: %v", err)
	}
	store, err := redisx.NewProcessIsolatedStore(serialized, "test")
	if err != nil {
		t.Fatal(err)
	}
	config.SingleReplicaConfirmed = false
	if err := validateHostProfile(store, &config); err == nil ||
		!strings.Contains(err.Error(), "confirmed single-replica") {
		t.Fatalf("accepted unconfirmed replica count: %v", err)
	}
	config.SingleReplicaConfirmed = true
	config.Collector = &CollectorConfig{}
	if err := validateHostProfile(store, &config); err == nil ||
		!strings.Contains(err.Error(), "does not support server-side collection") {
		t.Fatalf("accepted collection profile: %v", err)
	}
	config.Collector = nil
	if err := validateHostProfile(store, &config); err != nil {
		t.Fatalf("rejected matching Upstash capabilities: %v", err)
	}
}

func TestLocalHostProfileRejectsOAuthConfiguration(t *testing.T) {
	client, err := redisx.New("redis://127.0.0.1:6379")
	if err != nil {
		t.Fatal(err)
	}
	config := Config{
		HostProfile: localHostProfile(),
		GitHubOAuth: &GitHubOAuthConfig{},
	}
	if err := validateHostProfile(redisx.NewStore(client, "test"), &config); err == nil ||
		!strings.Contains(err.Error(), "does not support GitHub OAuth") {
		t.Fatalf("local profile accepted OAuth: %v", err)
	}
}

func TestPlatformHostProfileRejectsProcessListenerAndEnforcesTrustedProxy(t *testing.T) {
	client, err := redisx.New("redis://127.0.0.1:6379")
	if err != nil {
		t.Fatal(err)
	}
	store := redisx.NewStore(client, "test")
	config := Config{
		HostProfile: azureFunctionsHostProfile(false),
		Listen:      "127.0.0.1:8080",
		Proxy:       ProxyPolicy{TrustForwarded: true},
	}
	if err := validateHostProfile(store, &config); err == nil ||
		!strings.Contains(err.Error(), "must not configure a process listener") {
		t.Fatalf("accepted process listener: %v", err)
	}
	config.Listen = ""
	config.Proxy.TrustForwarded = false
	if err := validateHostProfile(store, &config); err != nil {
		t.Fatal(err)
	}
	if !config.Proxy.TrustForwarded {
		t.Fatal("platform proxy capability was not enforced")
	}
}
