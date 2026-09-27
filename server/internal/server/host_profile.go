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

func validateHostProfile(store *redisx.Store, config *Config) error {
	profile := config.HostProfile
	if profile == (HostProfile{}) {
		profile = localHostProfile()
		config.HostProfile = profile
	}
	if err := profile.validate(); err != nil {
		return err
	}
	if profile.RequiresRedis && store == nil {
		return fmt.Errorf("host profile %q requires Redis", profile.Name)
	}
	if store != nil {
		client, reportsSession := store.Client.(interface{ SingleSession() bool })
		if profile.RedisSession == HostRedisSerialized && (!reportsSession || !client.SingleSession()) {
			return fmt.Errorf("host profile %q requires a serialized Redis client", profile.Name)
		}
		if profile.RedisSession == HostRedisPooled && reportsSession && client.SingleSession() {
			return fmt.Errorf("host profile %q requires a pooled Redis client", profile.Name)
		}
		if profile.IsolateProcessNamespace != store.ProcessIsolated() {
			return fmt.Errorf(
				"host profile %q process namespace isolation does not match the Redis store",
				profile.Name,
			)
		}
	}
	if !profile.SupportsCollection && config.Collector != nil {
		return fmt.Errorf("host profile %q does not support server-side collection", profile.Name)
	}
	if profile.SingleReplica && !config.SingleReplicaConfirmed {
		return fmt.Errorf("host profile %q requires a confirmed single-replica deployment", profile.Name)
	}
	if profile.Authentication == HostAuthenticationBearer && config.GitHubOAuth != nil {
		return fmt.Errorf("host profile %q does not support GitHub OAuth", profile.Name)
	}
	if profile.Listener == HostListenerPlatform &&
		(strings.TrimSpace(config.Listen) != "" || config.CertFile != "" || config.KeyFile != "") {
		return fmt.Errorf("host profile %q must not configure a process listener or TLS files", profile.Name)
	}
	if profile.TrustsPlatformProxy {
		config.Proxy.TrustForwarded = true
	}
	return nil
}
