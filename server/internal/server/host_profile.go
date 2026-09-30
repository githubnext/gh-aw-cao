package server

import (
	"errors"
	"fmt"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type HostAuthentication string

const (
	HostAuthenticationBearer HostAuthentication = "bearer"
	HostAuthenticationOAuth  HostAuthentication = "github-oauth"
)

type HostListener string

const (
	HostListenerProcess  HostListener = "process"
	HostListenerPlatform HostListener = "platform"
)

type HostRedisSession string

const (
	HostRedisPooled     HostRedisSession = "pooled"
	HostRedisSerialized HostRedisSession = "serialized"
)

// HostProfile describes runtime capabilities independently of a deployment
// provider. Platform integrations select a profile and supply its configuration.
type HostProfile struct {
	Name                    string
	Authentication          HostAuthentication
	Listener                HostListener
	RequiresHTTPS           bool
	TrustsPlatformProxy     bool
	RequiresRedis           bool
	RedisSession            HostRedisSession
	IsolateProcessNamespace bool
	SingleReplica           bool
	SupportsCollection      bool
}

func localHostProfile() HostProfile {
	return HostProfile{
		Name:               "local",
		Authentication:     HostAuthenticationBearer,
		Listener:           HostListenerProcess,
		RequiresRedis:      true,
		RedisSession:       HostRedisPooled,
		SupportsCollection: true,
	}
}

func hostedHostProfile() HostProfile {
	return HostProfile{
		Name:               "hosted",
		Authentication:     HostAuthenticationOAuth,
		Listener:           HostListenerProcess,
		RequiresHTTPS:      true,
		RequiresRedis:      true,
		RedisSession:       HostRedisPooled,
		SupportsCollection: true,
	}
}

func azureLocalSimulationProfile(profile HostProfile, localSimulation bool) HostProfile {
	if localSimulation {
		profile.RequiresHTTPS = false
	}
	return profile
}

func (profile HostProfile) validate() error {
	if strings.TrimSpace(profile.Name) == "" {
		return errors.New("host profile requires a name")
	}
	if profile.Authentication != HostAuthenticationBearer &&
		profile.Authentication != HostAuthenticationOAuth {
		return fmt.Errorf("host profile %q has unsupported authentication %q", profile.Name, profile.Authentication)
	}
	if profile.Listener != HostListenerProcess && profile.Listener != HostListenerPlatform {
		return fmt.Errorf("host profile %q has unsupported listener %q", profile.Name, profile.Listener)
	}
	if profile.RedisSession != HostRedisPooled && profile.RedisSession != HostRedisSerialized {
		return fmt.Errorf("host profile %q has unsupported Redis session %q", profile.Name, profile.RedisSession)
	}
	if !profile.RequiresRedis {
		return fmt.Errorf("host profile %q cannot disable the server Redis dependency", profile.Name)
	}
	if profile.Listener == HostListenerPlatform && profile.Authentication != HostAuthenticationOAuth {
		return fmt.Errorf("host profile %q cannot use bearer authentication with a platform listener", profile.Name)
	}
	if profile.IsolateProcessNamespace && profile.RedisSession != HostRedisSerialized {
		return fmt.Errorf("host profile %q requires namespace isolation without a serialized Redis session", profile.Name)
	}
	if profile.IsolateProcessNamespace && !profile.SingleReplica {
		return fmt.Errorf("host profile %q requires namespace isolation without one replica", profile.Name)
	}
	if profile.SingleReplica && profile.RedisSession != HostRedisSerialized {
		return fmt.Errorf("host profile %q requires one replica without a serialized Redis session", profile.Name)
	}
	if profile.TrustsPlatformProxy && profile.Listener != HostListenerPlatform {
		return fmt.Errorf("host profile %q trusts a platform proxy without a platform listener", profile.Name)
	}
	return nil
}

// hostProfileRejectionReason classifies which deployment precondition
// validateHostProfile rejected. It is useful for diagnosing a misconfigured
// deployment without logging the host profile's name or the Redis, listener,
// or OAuth configuration values that produced the rejection.
type hostProfileRejectionReason string

const (
	hostProfileRejectionReasonNone                 hostProfileRejectionReason = "none"
	hostProfileRejectionReasonInvalidProfile       hostProfileRejectionReason = "invalid-profile"
	hostProfileRejectionReasonMissingRedis         hostProfileRejectionReason = "missing-redis"
	hostProfileRejectionReasonRedisSessionMismatch hostProfileRejectionReason = "redis-session-mismatch"
	hostProfileRejectionReasonNamespaceMismatch    hostProfileRejectionReason = "namespace-isolation-mismatch"
	hostProfileRejectionReasonUnsupportedCollector hostProfileRejectionReason = "unsupported-collection"
	hostProfileRejectionReasonUnconfirmedReplica   hostProfileRejectionReason = "unconfirmed-single-replica"
	hostProfileRejectionReasonUnsupportedOAuth     hostProfileRejectionReason = "unsupported-oauth"
	hostProfileRejectionReasonPlatformListener     hostProfileRejectionReason = "platform-listener-conflict"
)

// classifyRedisSessionMismatch reports whether the store's reported session
// kind is incompatible with the profile's required HostRedisSession. It is a
// pure function extracted from validateHostProfile so the session-kind
// comparison is testable directly, without constructing a *redisx.Store for
// every case.
func classifyRedisSessionMismatch(required HostRedisSession, reportsSession, singleSession bool) bool {
	switch required {
	case HostRedisSerialized:
		return !reportsSession || !singleSession
	case HostRedisPooled:
		return reportsSession && singleSession
	default:
		return false
	}
}

// classifyHostProfileRejection reports which precondition, if any,
// validateHostProfile's checks reject for profile given config and the
// resolved Redis store capabilities. It is a pure function extracted from
// validateHostProfile so every rejection reason is independently testable
// without constructing a *redisx.Store or a network listener.
func classifyHostProfileRejection(
	profile HostProfile, config Config, storeConfigured bool, reportsSession, singleSession, processIsolated bool,
) hostProfileRejectionReason {
	if err := profile.validate(); err != nil {
		return hostProfileRejectionReasonInvalidProfile
	}
	if profile.RequiresRedis && !storeConfigured {
		return hostProfileRejectionReasonMissingRedis
	}
	if storeConfigured {
		if classifyRedisSessionMismatch(profile.RedisSession, reportsSession, singleSession) {
			return hostProfileRejectionReasonRedisSessionMismatch
		}
		if profile.IsolateProcessNamespace != processIsolated {
			return hostProfileRejectionReasonNamespaceMismatch
		}
	}
	if !profile.SupportsCollection && config.Collector != nil {
		return hostProfileRejectionReasonUnsupportedCollector
	}
	if profile.SingleReplica && !config.SingleReplicaConfirmed {
		return hostProfileRejectionReasonUnconfirmedReplica
	}
	if profile.Authentication == HostAuthenticationBearer && config.GitHubOAuth != nil {
		return hostProfileRejectionReasonUnsupportedOAuth
	}
	if profile.Listener == HostListenerPlatform &&
		(strings.TrimSpace(config.Listen) != "" || config.CertFile != "" || config.KeyFile != "") {
		return hostProfileRejectionReasonPlatformListener
	}
	return hostProfileRejectionReasonNone
}

func validateHostProfile(store *redisx.Store, config *Config) error {
	profile := config.HostProfile
	if profile == (HostProfile{}) {
		profile = localHostProfile()
		config.HostProfile = profile
	}
	reportsSession, singleSession := false, false
	processIsolated := false
	if store != nil {
		client, reports := store.Client.(interface{ SingleSession() bool })
		reportsSession = reports
		if reports {
			singleSession = client.SingleSession()
		}
		processIsolated = store.ProcessIsolated()
	}
	reason := classifyHostProfileRejection(profile, *config, store != nil, reportsSession, singleSession, processIsolated)
	serverLog.Printf("host profile validated profile=%s reason=%s", profile.Name, reason)
	switch reason {
	case hostProfileRejectionReasonNone:
		// fall through to apply the profile's implied configuration below.
	case hostProfileRejectionReasonInvalidProfile:
		return profile.validate()
	case hostProfileRejectionReasonMissingRedis:
		return fmt.Errorf("host profile %q requires Redis", profile.Name)
	case hostProfileRejectionReasonRedisSessionMismatch:
		if profile.RedisSession == HostRedisSerialized {
			return fmt.Errorf("host profile %q requires a serialized Redis client", profile.Name)
		}
		return fmt.Errorf("host profile %q requires a pooled Redis client", profile.Name)
	case hostProfileRejectionReasonNamespaceMismatch:
		return fmt.Errorf(
			"host profile %q process namespace isolation does not match the Redis store",
			profile.Name,
		)
	case hostProfileRejectionReasonUnsupportedCollector:
		return fmt.Errorf("host profile %q does not support server-side collection", profile.Name)
	case hostProfileRejectionReasonUnconfirmedReplica:
		return fmt.Errorf("host profile %q requires a confirmed single-replica deployment", profile.Name)
	case hostProfileRejectionReasonUnsupportedOAuth:
		return fmt.Errorf("host profile %q does not support GitHub OAuth", profile.Name)
	case hostProfileRejectionReasonPlatformListener:
		return fmt.Errorf("host profile %q must not configure a process listener or TLS files", profile.Name)
	}
	if profile.TrustsPlatformProxy {
		config.Proxy.TrustForwarded = true
	}
	return nil
}
