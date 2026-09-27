package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

const (
	defaultHostPolicyPath = ".github/workflows/cao.json"
	maxHostPolicyBytes    = 4 << 20
)

type redisTLSMode string

const (
	redisTLSAuto     redisTLSMode = "auto"
	redisTLSRequired redisTLSMode = "required"
	redisTLSDisabled redisTLSMode = "disabled"
)

type resolvedHostPolicy struct {
	Profile                HostProfile
	SingleReplicaConfirmed bool
	RedisURL               string
	RedisNamespace         string
	RedisOptions           redisx.Options
}

type hostPolicyDocument struct {
	ControlPlane struct {
		Web struct {
			Host json.RawMessage `json:"host"`
		} `json:"web"`
	} `json:"control-plane"`
}

type hostPolicy struct {
	Target targetPolicy `json:"target"`
	Redis  redisPolicy  `json:"redis"`
}

type targetPolicy struct {
	Module                string             `json:"module"`
	Name                  string             `json:"name"`
	Authentication        HostAuthentication `json:"authentication"`
	Listener              HostListener       `json:"listener"`
	RequireHTTPS          *bool              `json:"require-https"`
	TrustPlatformProxy    *bool              `json:"trust-platform-proxy"`
	SupportsSingleReplica *bool              `json:"supports-single-replica"`
	Replicas              int                `json:"replicas"`
}

type redisPolicy struct {
	Module                  string           `json:"module"`
	URLEnv                  string           `json:"url-env"`
	HostEnv                 string           `json:"host-env"`
	PortEnv                 string           `json:"port-env"`
	UsernameEnv             string           `json:"username-env"`
	PasswordEnv             string           `json:"password-env"`
	NamespaceEnv            string           `json:"namespace-env"`
	Session                 HostRedisSession `json:"session"`
	IsolateProcessNamespace *bool            `json:"isolate-process-namespace"`
	SingleReplica           *bool            `json:"single-replica"`
	SupportsCollection      *bool            `json:"supports-collection"`
	AllowPrivatePlaintext   bool             `json:"allow-private-plaintext"`
	TLS                     redisTLSPolicy   `json:"tls"`
}

type redisTLSPolicy struct {
	Mode             redisTLSMode `json:"mode"`
	ServerNameEnv    string       `json:"server-name-env"`
	CACertificateEnv string       `json:"ca-certificate-env"`
}

func configuredHostPolicyPath() string {
	if value := strings.TrimSpace(os.Getenv("CAO_POLICY_PATH")); value != "" {
		return value
	}
	if value := strings.TrimSpace(os.Getenv(marketplacePolicyPathEnv)); value != "" {
		return value
	}
	return defaultHostPolicyPath
}

func loadHostPolicyFromEnv() (*resolvedHostPolicy, error) {
	path := configuredHostPolicyPath()
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("read CAO host policy")
	}
	if len(data) > maxHostPolicyBytes {
		return nil, errors.New("CAO host policy exceeds 4 MiB")
	}
	var document hostPolicyDocument
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(&document); err != nil {
		return nil, errors.New("parse CAO host policy")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, errors.New("parse CAO host policy")
	}
	if len(document.ControlPlane.Web.Host) == 0 ||
		string(document.ControlPlane.Web.Host) == "null" {
		return nil, errors.New("cao.json requires control-plane.web.host")
	}
	var policy hostPolicy
	hostDecoder := json.NewDecoder(strings.NewReader(string(document.ControlPlane.Web.Host)))
	hostDecoder.DisallowUnknownFields()
	if err := hostDecoder.Decode(&policy); err != nil {
		return nil, errors.New("parse CAO host policy")
	}
	return policy.resolve(os.LookupEnv)
}

func (policy hostPolicy) resolve(lookup func(string) (string, bool)) (*resolvedHostPolicy, error) {
	profile, supportsSingleReplica, err := resolveTargetModule(policy.Target)
	if err != nil {
		return nil, err
	}
	provider, err := resolveRedisProviderModule(policy.Redis)
	if err != nil {
		return nil, err
	}
	profile.RedisSession = provider.session
	profile.IsolateProcessNamespace = provider.isolateProcessNamespace
	profile.SingleReplica = provider.singleReplica
	profile.SupportsCollection = provider.supportsCollection
	if profile.SingleReplica && !supportsSingleReplica {
		return nil, fmt.Errorf(
			"host target module %q cannot guarantee the Redis provider's single-replica requirement",
			policy.Target.Module,
		)
	}
	if profile.SingleReplica && policy.Target.Replicas != 1 {
		return nil, fmt.Errorf("host target module %q requires replicas to be 1 for the Redis provider", policy.Target.Module)
	}
	if err := profile.validate(); err != nil {
		return nil, err
	}
	urlEnv := firstNonempty(policy.Redis.URLEnv, provider.urlEnv)
	hostEnv := firstNonempty(policy.Redis.HostEnv, provider.hostEnv)
	portEnv := firstNonempty(policy.Redis.PortEnv, provider.portEnv)
	usernameEnv := firstNonempty(policy.Redis.UsernameEnv, provider.usernameEnv)
	passwordEnv := firstNonempty(policy.Redis.PasswordEnv, provider.passwordEnv)
	tlsMode := policy.Redis.TLS.Mode
	if tlsMode == "" {
		tlsMode = provider.tlsMode
		if tlsMode == "" {
			tlsMode = redisTLSAuto
		}
	} else if provider.tlsMode == redisTLSRequired && tlsMode != redisTLSRequired {
		return nil, fmt.Errorf("Redis provider module %q requires TLS", policy.Redis.Module)
	}
	if tlsMode != redisTLSAuto && tlsMode != redisTLSRequired && tlsMode != redisTLSDisabled {
		return nil, fmt.Errorf("unsupported Redis TLS mode %q", tlsMode)
	}
	redisURL, err := redisURLFromEnvironment(
		lookup, urlEnv, hostEnv, portEnv, usernameEnv, passwordEnv, tlsMode,
	)
	if err != nil {
		return nil, err
	}
	if policy.Redis.Module == "upstash" && !isUpstashRedisURL(redisURL) {
		return nil, errors.New("Upstash Redis provider module requires an upstash.io endpoint")
	}
	namespaceEnv := firstNonempty(policy.Redis.NamespaceEnv, "REDIS_NAMESPACE")
	namespace := envValue(lookup, namespaceEnv)
	if namespace == "" {
		namespace = "hosted-dashboard"
	}
	return &resolvedHostPolicy{
		Profile:                profile,
		SingleReplicaConfirmed: !profile.SingleReplica || policy.Target.Replicas == 1,
		RedisURL:               redisURL,
		RedisNamespace:         namespace,
		RedisOptions: redisx.Options{
			AllowPrivatePlaintext: policy.Redis.AllowPrivatePlaintext,
			SingleSession:         provider.session == HostRedisSerialized,
			ForceTLS:              tlsMode == redisTLSRequired,
			DisableTLS:            tlsMode == redisTLSDisabled,
			TLSServerName:         envValue(lookup, policy.Redis.TLS.ServerNameEnv),
			TLSCACertificatePEM:   envValue(lookup, policy.Redis.TLS.CACertificateEnv),
		},
	}, nil
}

func redisURLFromEnvironment(
	lookup func(string) (string, bool),
	urlEnv, hostEnv, portEnv, usernameEnv, passwordEnv string,
	tlsMode redisTLSMode,
) (string, error) {
	if rawURL := envValue(lookup, urlEnv); rawURL != "" {
		return rawURL, nil
	}
	host := envValue(lookup, hostEnv)
	if host == "" {
		return "", fmt.Errorf("Redis connection requires environment variable %s", firstNonempty(urlEnv, hostEnv))
	}
	port := envValue(lookup, portEnv)
	if port == "" {
		port = "6379"
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", errors.New("Redis port environment variable must contain a port number")
	}
	scheme := "redis"
	if tlsMode == redisTLSRequired {
		scheme = "rediss"
	}
	parsed := &url.URL{Scheme: scheme, Host: net.JoinHostPort(host, port)}
	username := envValue(lookup, usernameEnv)
	password := envValue(lookup, passwordEnv)
	if username != "" || password != "" {
		parsed.User = url.UserPassword(username, password)
	}
	return parsed.String(), nil
}

func envValue(lookup func(string) (string, bool), name string) string {
	if name == "" {
		return ""
	}
	value, _ := lookup(name)
	return strings.TrimSpace(value)
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
