package server

import (
	"strings"
	"testing"
)

func TestPositiveEnvSetting(t *testing.T) {
	t.Setenv("CAO_TEST_SETTING", "  42 ")
	value, set, err := positiveEnvSetting("CAO_TEST_SETTING", 64)
	if err != nil || !set || value != 42 {
		t.Fatalf("got value=%d set=%t err=%v", value, set, err)
	}

	t.Setenv("CAO_TEST_SETTING", "   ")
	if _, set, err := positiveEnvSetting("CAO_TEST_SETTING", 64); err != nil || set {
		t.Fatalf("blank value: set=%t err=%v", set, err)
	}

	for _, bad := range []string{"0", "-3", "abc", "1.5", "99999999999999999999"} {
		t.Setenv("CAO_TEST_SETTING", bad)
		_, set, err := positiveEnvSetting("CAO_TEST_SETTING", 64)
		if err == nil || set || !strings.Contains(err.Error(), "CAO_TEST_SETTING must be a positive integer") {
			t.Fatalf("value %q: set=%t err=%v", bad, set, err)
		}
	}
}

func TestMemoryConfigFromEnvAppliesAndDerivesLimits(t *testing.T) {
	t.Setenv("CAO_OPERATIONAL_CACHE_MAX_BYTES", "1024")
	t.Setenv("CAO_OPERATIONAL_PROTECTED_MAX_ENTRIES", "7")
	t.Setenv("CAO_OPERATIONAL_MAX_QUEUED_TASKS", "9")

	config, err := memoryConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config.MaxCacheBytes != 1024 || config.MaxCacheValueBytes <= 0 || config.MaxCacheValueBytes > 1024 {
		t.Fatalf("cache limits = %d/%d", config.MaxCacheBytes, config.MaxCacheValueBytes)
	}
	if config.MaxProtectedEntries != 7 || config.MaxMetadataEntries <= 0 || config.MaxMetadataEntries > 7 {
		t.Fatalf("protected entries = %d metadata = %d", config.MaxProtectedEntries, config.MaxMetadataEntries)
	}
	if config.MaxQueuedTasks != 9 {
		t.Fatalf("queued tasks = %d", config.MaxQueuedTasks)
	}
}

func TestMemoryConfigFromEnvRejectsInvalidValues(t *testing.T) {
	for _, name := range []string{"CAO_OPERATIONAL_TASK_MAX_BYTES", "CAO_OPERATIONAL_MAX_RATE_LIMIT_SUBJECTS"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "-1")
			if _, err := memoryConfigFromEnv(); err == nil || !strings.Contains(err.Error(), name) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestPostgresOperationalConfigFromEnv(t *testing.T) {
	t.Setenv("CAO_OPERATIONAL_CACHE_MAX_BYTES", "1000")
	config, err := PostgresOperationalConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config.MaxCacheBytes != 1000 || config.MaxCacheValueBytes != 1000 {
		t.Fatalf("cache limits = %d/%d", config.MaxCacheBytes, config.MaxCacheValueBytes)
	}

	t.Setenv("CAO_OPERATIONAL_CACHE_MAX_ENTRIES", "zero")
	if _, err := PostgresOperationalConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "CAO_OPERATIONAL_CACHE_MAX_ENTRIES") {
		t.Fatalf("err = %v", err)
	}
}
