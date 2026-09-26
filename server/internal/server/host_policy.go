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
	Name               string             `json:"name"`
	Authentication     HostAuthentication `json:"authentication"`
	Listener           HostListener       `json:"listener"`
	RequireHTTPS       *bool              `json:"require-https"`
	TrustPlatformProxy bool               `json:"trust-platform-proxy"`
	SingleReplica      bool               `json:"single-replica"`
	SupportsCollection bool               `json:"supports-collection"`
	Redis              redisPolicy        `json:"redis"`
}

type redisPolicy struct {
	Preset                  string           `json:"preset"`
	URLEnv                  string           `json:"url-env"`
	HostEnv                 string           `json:"host-env"`
	PortEnv                 string           `json:"port-env"`
	UsernameEnv             string           `json:"username-env"`
	PasswordEnv             string           `json:"password-env"`
	NamespaceEnv            string           `json:"namespace-env"`
	Session                 HostRedisSession `json:"session"`
	IsolateProcessNamespace bool             `json:"isolate-process-namespace"`
	AllowPrivatePlaintext   bool             `json:"allow-private-plaintext"`
	TLS                     redisTLSPolicy   `json:"tls"`
}

type redisTLSPolicy struct {
	Mode             redisTLSMode `json:"mode"`
	ServerNameEnv    string       `json:"server-name-env"`
	CACertificateEnv string       `json:"ca-certificate-env"`
}

type redisPreset struct {
	urlEnv      string
	hostEnv     string
	portEnv     string
	usernameEnv string
	passwordEnv string
}

var redisPresets = map[string]redisPreset{
	"generic":         {urlEnv: "REDIS_URL"},
	"aws-elasticache": {urlEnv: "REDIS_URL"},
	"redis-cloud":     {urlEnv: "REDIS_URL"},
	"gcp-memorystore": {hostEnv: "REDISHOST", portEnv: "REDISPORT", usernameEnv: "REDIS_USERNAME", passwordEnv: "REDIS_PASSWORD"},
	"railway":         {urlEnv: "REDIS_URL"},
	"render":          {urlEnv: "REDIS_URL"},
	"digitalocean":    {urlEnv: "REDIS_URL"},
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
		if errors.Is(err, os.ErrNotExist) &&
			strings.TrimSpace(os.Getenv("CAO_POLICY_PATH")) == "" &&
			strings.TrimSpace(os.Getenv(marketplacePolicyPathEnv)) == "" {
			return nil, nil
		}
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
		return nil, nil
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
	name := strings.TrimSpace(policy.Name)
	if name == "" {
		name = "configured"
	}
	requireHTTPS := true
	if policy.RequireHTTPS != nil {
		requireHTTPS = *policy.RequireHTTPS
	}
	session := policy.Redis.Session
	if session == "" {
		session = HostRedisPooled
	}
	profile := HostProfile{
		Name:                    name,
		Authentication:          policy.Authentication,
		Listener:                policy.Listener,
		RequiresHTTPS:           requireHTTPS,
		TrustsPlatformProxy:     policy.TrustPlatformProxy,
		RequiresRedis:           true,
		RedisSession:            session,
		IsolateProcessNamespace: policy.Redis.IsolateProcessNamespace,
		SingleReplica:           policy.SingleReplica,
		SupportsCollection:      policy.SupportsCollection,
	}
	if err := profile.validate(); err != nil {
		return nil, err
	}

	presetName := policy.Redis.Preset
	if presetName == "" {
		presetName = "generic"
	}
	preset, ok := redisPresets[presetName]
	if !ok {
		return nil, fmt.Errorf("unsupported Redis preset %q", presetName)
	}
	urlEnv := firstNonempty(policy.Redis.URLEnv, preset.urlEnv)
	hostEnv := firstNonempty(policy.Redis.HostEnv, preset.hostEnv)
	portEnv := firstNonempty(policy.Redis.PortEnv, preset.portEnv)
	usernameEnv := firstNonempty(policy.Redis.UsernameEnv, preset.usernameEnv)
	passwordEnv := firstNonempty(policy.Redis.PasswordEnv, preset.passwordEnv)
	tlsMode := policy.Redis.TLS.Mode
	if tlsMode == "" {
		tlsMode = redisTLSAuto
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
	namespaceEnv := firstNonempty(policy.Redis.NamespaceEnv, "REDIS_NAMESPACE")
	namespace := envValue(lookup, namespaceEnv)
	if namespace == "" {
		namespace = "hosted-dashboard"
	}
	return &resolvedHostPolicy{
		Profile:                profile,
		SingleReplicaConfirmed: true,
		RedisURL:               redisURL,
		RedisNamespace:         namespace,
		RedisOptions: redisx.Options{
			AllowPrivatePlaintext: policy.Redis.AllowPrivatePlaintext,
			SingleSession:         session == HostRedisSerialized,
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
