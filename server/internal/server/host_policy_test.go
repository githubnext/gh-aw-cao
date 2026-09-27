package server

import (
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestHostPolicyResolvesGenericRedisURLAndTLS(t *testing.T) {
	required := true
	collection := true
	policy := hostPolicy{
		Target: targetPolicy{
			Module:         "generic",
			Name:           "managed-redis",
			Authentication: HostAuthenticationOAuth,
			Listener:       HostListenerProcess,
			RequireHTTPS:   &required,
		},
		Redis: redisPolicy{
			Module:             "generic",
			NamespaceEnv:       "CACHE_NAMESPACE",
			SupportsCollection: &collection,
			TLS: redisTLSPolicy{
				Mode:             redisTLSRequired,
				ServerNameEnv:    "CACHE_SERVER_NAME",
				CACertificateEnv: "CACHE_CA",
			},
		},
	}
	values := map[string]string{
		"REDIS_URL":         "redis://cache.internal:6379",
		"CACHE_NAMESPACE":   "production",
		"CACHE_SERVER_NAME": "cache.example.com",
		"CACHE_CA":          "certificate",
	}
	resolved, err := policy.resolve(mapLookup(values))
	if err != nil {
		t.Fatal(err)
	}
	if resolved.RedisURL != values["REDIS_URL"] || resolved.RedisNamespace != "production" {
		t.Fatalf("unexpected Redis resolution: %+v", resolved)
	}
	if !resolved.RedisOptions.ForceTLS ||
		resolved.RedisOptions.TLSServerName != "cache.example.com" ||
		resolved.RedisOptions.TLSCACertificatePEM != "certificate" {
		t.Fatalf("TLS settings were not preserved: %+v", resolved.RedisOptions)
	}
}

func TestRedisProviderModulesMapEnvironment(t *testing.T) {
	for _, module := range []string{
		"generic", "redis-cloud", "railway", "render", "digitalocean",
	} {
		t.Run(module, func(t *testing.T) {
			policy := hostPolicy{
				Target: targetPolicy{Module: "container"},
				Redis:  redisPolicy{Module: module},
			}
			resolved, err := policy.resolve(mapLookup(map[string]string{
				"REDIS_URL": "rediss://cache.example.com:6379",
			}))
			if err != nil {
				t.Fatal(err)
			}
			if resolved.RedisURL == "" {
				t.Fatal("provider module did not map REDIS_URL")
			}
		})
	}

	t.Run("aws-elasticache", func(t *testing.T) {
		policy := hostPolicy{
			Target: targetPolicy{Module: "container"},
			Redis:  redisPolicy{Module: "aws-elasticache"},
		}
		resolved, err := policy.resolve(mapLookup(map[string]string{
			"REDIS_URL": "rediss://cache.example.amazonaws.com:6379",
		}))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(resolved.RedisURL, "amazonaws.com") {
			t.Fatalf("unexpected ElastiCache URL: %q", resolved.RedisURL)
		}
	})

	t.Run("gcp-memorystore", func(t *testing.T) {
		policy := hostPolicy{
			Target: targetPolicy{Module: "container"},
			Redis: redisPolicy{
				Module: "gcp-memorystore",
				TLS:    redisTLSPolicy{Mode: redisTLSRequired},
			},
		}
		resolved, err := policy.resolve(mapLookup(map[string]string{
			"REDISHOST": "10.0.0.5",
			"REDISPORT": "6378",
		}))
		if err != nil {
			t.Fatal(err)
		}
		if resolved.RedisURL != "rediss://10.0.0.5:6378" {
			t.Fatalf("unexpected Memorystore URL: %q", resolved.RedisURL)
		}
	})
}

func TestHostPolicyFileIsRequired(t *testing.T) {
	t.Setenv("CAO_POLICY_PATH", "")
	t.Setenv(marketplacePolicyPathEnv, "")
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	if _, err := loadHostPolicyFromEnv(); err == nil {
		t.Fatal("missing default cao.json was accepted")
	}
	t.Chdir(workingDirectory)

	t.Setenv("CAO_POLICY_PATH", filepath.Join(t.TempDir(), "missing.json"))
	if _, err := loadHostPolicyFromEnv(); err == nil {
		t.Fatal("explicitly configured missing policy was accepted")
	}
}

func TestConfiguredHostPolicyReadsCaoJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cao.json")
	document := `{
		"version": 1,
		"control-plane": {
			"scope": {"allowed-owners": ["example"]},
			"web": {
				"host": {
					"target": {"module": "container", "name": "render"},
					"redis": {"module": "render", "tls": {"mode": "required"}}
				}
			}
		}
	}`
	if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAO_POLICY_PATH", path)
	t.Setenv("REDIS_URL", "rediss://cache.example.com:6379")
	resolved, err := loadHostPolicyFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Profile.Name != "render" || !resolved.RedisOptions.ForceTLS {
		t.Fatalf("unexpected resolved policy: %+v", resolved)
	}
}

func TestHostPolicyRejectsFlatHostFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cao.json")
	document := `{
		"control-plane": {
			"web": {
				"host": {
					"name": "legacy",
					"authentication": "github-oauth",
					"listener": "process",
					"redis": {"preset": "generic"}
				}
			}
		}
	}`
	if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAO_POLICY_PATH", path)
	if _, err := loadHostPolicyFromEnv(); err == nil {
		t.Fatal("flat host policy was accepted")
	}
}

func TestHostAndRedisModulesComposeIndependently(t *testing.T) {
	resolved, err := (hostPolicy{
		Target: targetPolicy{Module: "container", Replicas: 1},
		Redis:  redisPolicy{Module: "upstash"},
	}).resolve(mapLookup(map[string]string{
		"REDIS_URL": "rediss://example.upstash.io:6379",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Profile.Listener != HostListenerProcess ||
		resolved.Profile.RedisSession != HostRedisSerialized ||
		!resolved.Profile.SingleReplica ||
		resolved.Profile.SupportsCollection {
		t.Fatalf("modules did not compose expected capabilities: %+v", resolved.Profile)
	}
	if !resolved.SingleReplicaConfirmed {
		t.Fatal("policy resolution ignored the single-replica target configuration")
	}

	azure, err := (hostPolicy{
		Target: targetPolicy{Module: "azure-functions"},
		Redis:  redisPolicy{Module: "redis-cloud"},
	}).resolve(mapLookup(map[string]string{
		"REDIS_URL": "rediss://cache.example.com:6379",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if azure.Profile.Listener != HostListenerPlatform ||
		!azure.Profile.TrustsPlatformProxy ||
		azure.Profile.RedisSession != HostRedisPooled {
		t.Fatalf("Azure target did not compose with Redis Cloud: %+v", azure.Profile)
	}
}

func TestDeploymentModuleRegistry(t *testing.T) {
	targets := make([]string, 0, len(hostTargetModules))
	for name := range hostTargetModules {
		targets = append(targets, name)
	}
	sort.Strings(targets)
	if !slices.Equal(targets, []string{"azure-functions", "container", "generic"}) {
		t.Fatalf("unexpected host target modules: %v", targets)
	}
	providers := make([]string, 0, len(redisProviderModules))
	for name := range redisProviderModules {
		providers = append(providers, name)
	}
	sort.Strings(providers)
	if !slices.Equal(providers, []string{
		"aws-elasticache", "digitalocean", "gcp-memorystore", "generic", "local",
		"railway", "redis-cloud", "render", "upstash",
	}) {
		t.Fatalf("unexpected Redis provider modules: %v", providers)
	}
}

func TestModulesRejectUnknownOrOverriddenCapabilities(t *testing.T) {
	tests := []hostPolicy{
		{Target: targetPolicy{Module: "unknown"}, Redis: redisPolicy{Module: "generic"}},
		{Target: targetPolicy{Module: "container", Listener: HostListenerPlatform}, Redis: redisPolicy{Module: "generic"}},
		{Target: targetPolicy{Module: "container"}, Redis: redisPolicy{Module: "unknown"}},
		{Target: targetPolicy{Module: "container", Replicas: 1}, Redis: redisPolicy{Module: "upstash", Session: HostRedisPooled}},
		{Target: targetPolicy{Module: "container", Replicas: 1}, Redis: redisPolicy{Module: "upstash", TLS: redisTLSPolicy{Mode: redisTLSDisabled}}},
		{Target: targetPolicy{Module: "azure-functions"}, Redis: redisPolicy{Module: "upstash"}},
		{Target: targetPolicy{Module: "container"}, Redis: redisPolicy{Module: "upstash"}},
	}
	for _, policy := range tests {
		if _, err := policy.resolve(mapLookup(map[string]string{
			"REDIS_URL": "rediss://cache.example.com:6379",
		})); err == nil {
			t.Fatalf("accepted invalid module policy: %+v", policy)
		}
		if _, err := (hostPolicy{
			Target: targetPolicy{Module: "container", Replicas: 1},
			Redis:  redisPolicy{Module: "upstash"},
		}).resolve(mapLookup(map[string]string{
			"REDIS_URL": "rediss://cache.example.com:6379",
		})); err == nil {
			t.Fatal("Upstash module accepted a non-Upstash endpoint")
		}
	}
}

func TestGenericTLSOptionsRejectInvalidCA(t *testing.T) {
	_, err := redisx.NewWithOptions(
		"redis://cache.example.com:6379",
		redisx.Options{ForceTLS: true, TLSCACertificatePEM: "not a certificate"},
	)
	if err == nil {
		t.Fatal("invalid Redis CA certificate was accepted")
	}
}

func TestRedisEnvironmentRejectsInvalidPort(t *testing.T) {
	for _, port := range []string{"0", "65536", "invalid"} {
		_, err := redisURLFromEnvironment(
			mapLookup(map[string]string{"REDISHOST": "cache.internal", "REDISPORT": port}),
			"", "REDISHOST", "REDISPORT", "", "", redisTLSAuto,
		)
		if err == nil {
			t.Errorf("accepted invalid Redis port %q", port)
		}
	}
}

func mapLookup(values map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		value, ok := values[name]
		return value, ok
	}
}
