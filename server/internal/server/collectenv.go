package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// CollectorConfigFromEnv reads the optional collection profile from the
// environment.
//
// It returns nil when CAO_COLLECT_APP_ID is unset, which selects the default
// Actions profile. Secrets are read from the environment only; they are never
// written to policy, logs, or status.
//
//nolint:nilnil // a nil config with a nil error is the documented "Actions profile selected" result.
func CollectorConfigFromEnv() (*CollectorConfig, error) {
	rawAppID := strings.TrimSpace(os.Getenv("CAO_COLLECT_APP_ID"))
	if rawAppID == "" {
		return nil, nil
	}
	appID, err := strconv.ParseInt(rawAppID, 10, 64)
	if err != nil || appID <= 0 {
		return nil, errors.New("CAO_COLLECT_APP_ID must be a positive GitHub App identifier")
	}
	admitOnly := envBool("CAO_COLLECT_ADMIT_ONLY")
	var privateKey []byte
	if !admitOnly {
		key, err := collectorPrivateKey()
		if err != nil {
			return nil, err
		}
		privateKey = key
	}
	config := &CollectorConfig{
		AppID:                 appID,
		AdmitOnly:             admitOnly,
		PrivateKeyPEM:         privateKey,
		BaseURL:               strings.TrimSpace(os.Getenv("CAO_COLLECT_GITHUB_API_URL")),
		UploadURL:             strings.TrimSpace(os.Getenv("CAO_COLLECT_GITHUB_UPLOAD_URL")),
		LakeDirectory:         strings.TrimSpace(os.Getenv("CAO_COLLECT_LAKE_DIRECTORY")),
		CatalogRoot:           strings.TrimSpace(os.Getenv("CAO_COLLECT_CATALOG_ROOT")),
		ControlRepository:     strings.TrimSpace(os.Getenv("CAO_COLLECT_CONTROL_REPOSITORY")),
		NodeBinary:            strings.TrimSpace(os.Getenv("CAO_COLLECT_NODE_BINARY")),
		GitHubBinary:          strings.TrimSpace(os.Getenv("CAO_COLLECT_GH_BINARY")),
		Consumer:              strings.TrimSpace(os.Getenv("CAO_COLLECT_CONSUMER")),
		WindowDays:            envInt("CAO_COLLECT_WINDOW_DAYS"),
		RunLimit:              envInt("CAO_COLLECT_RUN_LIMIT"),
		MaxStorageMB:          envInt("CAO_COLLECT_MAX_STORAGE_MB"),
		RequestTimeoutMinutes: envInt("CAO_COLLECT_REQUEST_TIMEOUT_MINUTES"),
		RateLimitFloor:        envInt("CAO_COLLECT_RATE_LIMIT_FLOOR"),
		Workers:               envInt("CAO_COLLECT_WORKERS"),
		QueueMaxLength:        envInt("CAO_COLLECT_QUEUE_MAX_LENGTH"),
		RetainGenerations:     envInt("CAO_COLLECT_RETAIN_GENERATIONS"),
		InventoryLimit:        envInt("CAO_COLLECT_INVENTORY_LIMIT"),
		MinProjectionInterval: envDuration("CAO_COLLECT_PROJECTION_INTERVAL"),
		CollectionTimeout:     envDuration("CAO_COLLECT_TIMEOUT"),
		RecoverDeliveries:     envBool("CAO_COLLECT_RECOVER_DELIVERIES"),
	}
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return config, nil
}

// collectorPrivateKey reads the App private key from a file reference when one
// is given, so deployments can mount a Key Vault secret instead of exporting
// key material in process environment listings.
func collectorPrivateKey() ([]byte, error) {
	if path := strings.TrimSpace(os.Getenv("CAO_COLLECT_PRIVATE_KEY_FILE")); path != "" {
		// #nosec G304,G703 -- the operator explicitly configures the private-key file path.
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read CAO_COLLECT_PRIVATE_KEY_FILE: %w", err)
		}
		return content, nil
	}
	inline := strings.TrimSpace(os.Getenv("CAO_COLLECT_PRIVATE_KEY"))
	if inline == "" {
		return nil, errors.New(
			"collection requires CAO_COLLECT_PRIVATE_KEY or CAO_COLLECT_PRIVATE_KEY_FILE")
	}
	return []byte(inline), nil
}

func envInt(name string) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil {
		return 0
	}
	return value
}

func envDuration(name string) time.Duration {
	value, err := time.ParseDuration(strings.TrimSpace(os.Getenv(name)))
	if err != nil {
		return 0
	}
	return value
}

func envBool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// NewCollectorFromEnv assembles the collection profile for the worker roles,
// which run the same binary without serving the dashboard.
func NewCollectorFromEnv(ctx context.Context, databaseQueriesPath string) (*Collector, error) {
	config, err := CollectorConfigFromEnv()
	if err != nil {
		return nil, err
	}
	if config == nil {
		return nil, errors.New("collection is not configured; CAO_COLLECT_APP_ID is required")
	}
	if config.AdmitOnly {
		return nil, errors.New(
			"the collect and backfill roles require collection credentials; " +
				"unset CAO_COLLECT_ADMIT_ONLY")
	}
	if strings.TrimSpace(os.Getenv("CAO_SOURCE_DIRECTORY")) != "" {
		return nil, errors.New(
			"collection and published-snapshot ingestion are alternatives: " +
				"unset CAO_SOURCE_DIRECTORY to run the collection profile")
	}
	store, err := StoreFromEnv(ctx)
	if err != nil {
		return nil, err
	}
	return NewCollector(store, *config, databaseQueriesPath)
}
