package server

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
)

// OperationalEnvironment describes reviewed storage selection without opening
// an adapter. Namespace is operational; DatabaseNamespace preserves the
// existing canonical Postgres dataset identity.
type OperationalEnvironment struct {
	Backend, Namespace, DatabaseNamespace string
	RedisURL                              string
	SingleProcess, AllowVolatile          bool
}

func OperationalEnvironmentFromEnv() (OperationalEnvironment, error) {
	host, err := loadHostPolicyFromEnv()
	if err != nil {
		return OperationalEnvironment{}, err
	}
	return operationalEnvironment(host), nil
}

// OperationalPolicySelectedFromEnv identifies an explicit reviewed selector
// without requiring Redis credentials for legacy local CLI commands.
func OperationalPolicySelectedFromEnv() (bool, error) {
	path := configuredHostPolicyPath()
	if _, err := os.Stat(path); os.IsNotExist(err) &&
		strings.TrimSpace(os.Getenv("CAO_POLICY_PATH")) == "" &&
		strings.TrimSpace(os.Getenv(marketplacePolicyPathEnv)) == "" {
		return false, nil
	}
	document, err := loadComposedHostPolicy(path)
	if err != nil {
		return false, err
	}
	control, _ := document["control-plane"].(map[string]any)
	web, _ := control["web"].(map[string]any)
	host, _ := web["host"].(map[string]any)
	_, selected := host["operational-store"]
	return selected, nil
}

func memoryConfigFromEnv() (memory.Config, error) {
	config := memory.Config{}
	for _, setting := range []struct {
		name string
		dest *int64
	}{
		{"CAO_OPERATIONAL_CACHE_MAX_BYTES", &config.MaxCacheBytes},
		{"CAO_OPERATIONAL_CACHE_MAX_VALUE_BYTES", &config.MaxCacheValueBytes},
		{"CAO_OPERATIONAL_PROTECTED_MAX_BYTES", &config.MaxProtectedBytes},
		{"CAO_OPERATIONAL_TASK_MAX_BYTES", &config.MaxTaskBytes},
	} {
		if value := strings.TrimSpace(os.Getenv(setting.name)); value != "" {
			n, err := strconv.ParseInt(value, 10, 64)
			if err != nil || n <= 0 {
				return config, fmt.Errorf("%s must be a positive integer", setting.name)
			}
			*setting.dest = n
		}
	}
	for _, setting := range []struct {
		name string
		dest *int
	}{
		{"CAO_OPERATIONAL_CACHE_MAX_ENTRIES", &config.MaxCacheEntries},
		{"CAO_OPERATIONAL_PROTECTED_MAX_ENTRIES", &config.MaxProtectedEntries},
		{"CAO_OPERATIONAL_MAX_QUEUED_TASKS", &config.MaxQueuedTasks},
		{"CAO_OPERATIONAL_MAX_RATE_LIMIT_SUBJECTS", &config.MaxRateLimitSubjects},
	} {
		if value := strings.TrimSpace(os.Getenv(setting.name)); value != "" {
			n, err := strconv.Atoi(value)
			if err != nil || n <= 0 {
				return config, fmt.Errorf("%s must be a positive integer", setting.name)
			}
			*setting.dest = n
		}
	}
	defaults := memory.DefaultConfig()
	if config.MaxCacheBytes > 0 && config.MaxCacheValueBytes == 0 {
		config.MaxCacheValueBytes = min(config.MaxCacheBytes, defaults.MaxCacheValueBytes)
	}
	if config.MaxProtectedBytes > 0 {
		config.MaxMetadataBytes = min(config.MaxProtectedBytes, defaults.MaxMetadataBytes)
	}
	if config.MaxProtectedEntries > 0 {
		config.MaxMetadataEntries = min(config.MaxProtectedEntries, defaults.MaxMetadataEntries)
	}
	return config, nil
}

func operationalEnvironment(host *resolvedHostPolicy) OperationalEnvironment {
	return OperationalEnvironment{
		Backend: host.OperationalBackend, Namespace: host.OperationalNamespace,
		RedisURL:          host.RedisURL,
		DatabaseNamespace: host.RedisNamespace, SingleProcess: host.Profile.SingleProcess,
		AllowVolatile: host.AllowVolatile,
	}
}
