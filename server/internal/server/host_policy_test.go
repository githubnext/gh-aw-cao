package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

func TestHostPolicyResolvesGenericRedisURLAndTLS(t *testing.T) {
	required := true
	policy := hostPolicy{
		Name:               "managed-redis",
		Authentication:     HostAuthenticationOAuth,
		Listener:           HostListenerProcess,
		RequireHTTPS:       &required,
		SupportsCollection: true,
		Redis: redisPolicy{
			Preset:       "generic",
			NamespaceEnv: "CACHE_NAMESPACE",
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

func TestRedisPresetsMapProviderEnvironment(t *testing.T) {
	for _, preset := range []string{
		"generic", "redis-cloud", "railway", "render", "digitalocean",
	} {
		t.Run(preset, func(t *testing.T) {
			policy := hostPolicy{
				Authentication: HostAuthenticationOAuth,
				Listener:       HostListenerProcess,
				Redis:          redisPolicy{Preset: preset},
			}
			resolved, err := policy.resolve(mapLookup(map[string]string{
				"REDIS_URL": "rediss://cache.example.com:6379",
			}))
			if err != nil {
				t.Fatal(err)
			}
			if resolved.RedisURL == "" {
				t.Fatal("provider preset did not map REDIS_URL")
			}
		})
	}

	t.Run("aws-elasticache", func(t *testing.T) {
		policy := hostPolicy{
			Authentication: HostAuthenticationOAuth,
			Listener:       HostListenerProcess,
			Redis:          redisPolicy{Preset: "aws-elasticache"},
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
			Authentication: HostAuthenticationOAuth,
			Listener:       HostListenerProcess,
			Redis: redisPolicy{
				Preset: "gcp-memorystore",
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

func TestHostPolicyFileIsOptionalUnlessExplicitlyConfigured(t *testing.T) {
	t.Setenv("CAO_POLICY_PATH", "")
	t.Setenv(marketplacePolicyPathEnv, "")
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	resolved, err := loadHostPolicyFromEnv()
	if err != nil || resolved != nil {
		t.Fatalf("optional missing policy returned resolved=%+v err=%v", resolved, err)
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
					"name": "render",
					"authentication": "github-oauth",
					"listener": "process",
					"redis": {"preset": "render", "tls": {"mode": "required"}}
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
