package server

import (
	"os"
	"strings"
	"testing"
)

func TestProfilesAreMutuallyExclusive(t *testing.T) {
	collector := &CollectorConfig{
		AppID:         1,
		PrivateKeyPEM: []byte("key"),
		LakeDirectory: t.TempDir(),
		CatalogRoot:   t.TempDir(),
	}
	t.Run("published snapshots and collection cannot both be configured", func(t *testing.T) {
		err := validateProfileExclusivity(Config{
			Collector:       collector,
			SourceDirectory: t.TempDir(),
			WebhookSecret:   strings.Repeat("s", 32),
		})
		if err == nil || !strings.Contains(err.Error(), "alternatives") {
			t.Fatalf("expected a dual-profile rejection, got %v", err)
		}
	})
	t.Run("collection replaces a configured reconciler", func(t *testing.T) {
		err := validateProfileExclusivity(Config{
			Collector:     collector,
			Reconciler:    DirectoryReconciler{},
			WebhookSecret: strings.Repeat("s", 32),
		})
		if err == nil {
			t.Fatal("expected a conflicting reconciler to be rejected")
		}
	})
	t.Run("collection requires a webhook secret", func(t *testing.T) {
		err := validateProfileExclusivity(Config{Collector: collector})
		if err == nil || !strings.Contains(err.Error(), "webhook secret") {
			t.Fatalf("expected a missing webhook secret to be rejected, got %v", err)
		}
	})
	t.Run("the default profile is unaffected", func(t *testing.T) {
		if err := validateProfileExclusivity(Config{SourceDirectory: t.TempDir()}); err != nil {
			t.Fatalf("the published-snapshot profile must validate unchanged: %v", err)
		}
	})
}

func TestCollectorConfigFromEnvSelectsTheDefaultProfileWhenUnset(t *testing.T) {
	t.Setenv("CAO_COLLECT_APP_ID", "")
	config, err := CollectorConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config != nil {
		t.Fatal("an unset App identifier must select the published-snapshot profile")
	}
}

func TestCollectorConfigFromEnvFailsClosed(t *testing.T) {
	t.Run("an incomplete configuration is rejected", func(t *testing.T) {
		t.Setenv("CAO_COLLECT_APP_ID", "12345")
		t.Setenv("CAO_COLLECT_PRIVATE_KEY", "")
		t.Setenv("CAO_COLLECT_PRIVATE_KEY_FILE", "")
		if _, err := CollectorConfigFromEnv(); err == nil {
			t.Fatal("expected a missing private key to be rejected")
		}
	})
	t.Run("a non-numeric App identifier is rejected", func(t *testing.T) {
		t.Setenv("CAO_COLLECT_APP_ID", "not-a-number")
		if _, err := CollectorConfigFromEnv(); err == nil {
			t.Fatal("expected an invalid App identifier to be rejected")
		}
	})
}

func TestCollectorConfigFromEnvReadsTheCollectionProfile(t *testing.T) {
	lake := t.TempDir()
	catalog := t.TempDir()
	t.Setenv("CAO_COLLECT_APP_ID", "12345")
	t.Setenv("CAO_COLLECT_PRIVATE_KEY", "-----BEGIN PRIVATE KEY-----")
	t.Setenv("CAO_COLLECT_LAKE_DIRECTORY", lake)
	t.Setenv("CAO_COLLECT_CATALOG_ROOT", catalog)
	t.Setenv("CAO_COLLECT_WORKERS", "4")
	t.Setenv("CAO_COLLECT_PROJECTION_INTERVAL", "90s")
	t.Setenv("CAO_COLLECT_RECOVER_DELIVERIES", "true")
	config, err := CollectorConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config == nil {
		t.Fatal("expected the collection profile to be selected")
	}
	if config.AppID != 12345 || config.Workers != 4 {
		t.Fatalf("unexpected configuration: %+v", config)
	}
	if config.MinProjectionInterval.Seconds() != 90 {
		t.Fatalf("projection interval = %s, want 90s", config.MinProjectionInterval)
	}
	if !config.RecoverDeliveries {
		t.Fatal("expected delivery recovery to be enabled")
	}
}

func TestCollectorPrivateKeyPrefersAFileReference(t *testing.T) {
	directory := t.TempDir()
	path := directory + "/key.pem"
	if err := os.WriteFile(path, []byte("-----BEGIN PRIVATE KEY-----"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAO_COLLECT_PRIVATE_KEY_FILE", path)
	t.Setenv("CAO_COLLECT_PRIVATE_KEY", "inline-should-not-be-used")
	key, err := collectorPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(key) != "-----BEGIN PRIVATE KEY-----" {
		t.Fatalf("unexpected key material: %q", key)
	}
}

// An admission-only front end verifies deliveries and enqueues work. Giving it
// the App private key would place a credential it cannot use in the
// internet-facing process.
func TestAdmitOnlyRefusesCollectionCredentials(t *testing.T) {
	config := CollectorConfig{AppID: 42, AdmitOnly: true}
	if err := config.Validate(); err != nil {
		t.Fatalf("admission-only configuration was rejected: %v", err)
	}
	withKey := CollectorConfig{AppID: 42, AdmitOnly: true, PrivateKeyPEM: []byte("key")}
	if err := withKey.Validate(); err == nil {
		t.Fatal("admission-only accepted the App private key")
	}
	withWorkers := CollectorConfig{AppID: 42, AdmitOnly: true, Workers: 1}
	if err := withWorkers.Validate(); err == nil {
		t.Fatal("admission-only accepted collection workers")
	}
	collecting := CollectorConfig{AppID: 42}
	if err := collecting.Validate(); err == nil {
		t.Fatal("the collection profile was accepted without a private key")
	}
}
