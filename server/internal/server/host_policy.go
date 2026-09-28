package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

const (
	defaultHostPolicyPath = ".github/workflows/cao.json"
	maxHostPolicyBytes    = 4 << 20
	maxHostProfileDepth   = 8
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
	document, err := loadComposedHostPolicy(path)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(document)
	if err != nil {
		return nil, errors.New("compose CAO host policy")
	}
	var policyDocument hostPolicyDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&policyDocument); err != nil {
		return nil, errors.New("parse CAO host policy")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, errors.New("parse CAO host policy")
	}
	if len(policyDocument.ControlPlane.Web.Host) == 0 ||
		string(policyDocument.ControlPlane.Web.Host) == "null" {
		return nil, errors.New("cao.json requires control-plane.web.host")
	}
	var policy hostPolicy
	hostDecoder := json.NewDecoder(strings.NewReader(string(policyDocument.ControlPlane.Web.Host)))
	hostDecoder.DisallowUnknownFields()
	if err := hostDecoder.Decode(&policy); err != nil {
		return nil, errors.New("parse CAO host policy")
	}
	return policy.resolve(os.LookupEnv)
}

func loadComposedHostPolicy(path string) (map[string]any, error) {
	entryPath, err := filepath.Abs(path)
	if err != nil {
		return nil, errors.New("resolve CAO host policy")
	}
	entryPath, err = filepath.EvalSymlinks(entryPath)
	if err != nil {
		return nil, errors.New("read CAO host policy")
	}
	rootDirectory := filepath.Dir(entryPath)
	loading := map[string]bool{}

	var load func(string, int) (map[string]any, error)
	load = func(currentPath string, depth int) (map[string]any, error) {
		if depth > maxHostProfileDepth {
			return nil, fmt.Errorf("deployment profile import depth exceeds %d", maxHostProfileDepth)
		}
		canonicalPath, err := filepath.EvalSymlinks(currentPath)
		if err != nil {
			return nil, errors.New("read CAO host policy")
		}
		relativePath, err := filepath.Rel(rootDirectory, canonicalPath)
		if err != nil || relativePath == ".." ||
			strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) ||
			filepath.IsAbs(relativePath) {
			return nil, errors.New("deployment profile imports must remain within the policy directory")
		}
		if loading[canonicalPath] {
			return nil, errors.New("deployment profile import cycle")
		}
		loading[canonicalPath] = true
		defer delete(loading, canonicalPath)

		// #nosec G304 -- the operator explicitly configures the reviewed policy path,
		// and imported paths are constrained to its directory.
		data, err := os.ReadFile(canonicalPath)
		if err != nil {
			return nil, errors.New("read CAO host policy")
		}
		if len(data) > maxHostPolicyBytes {
			return nil, errors.New("CAO host policy exceeds 4 MiB")
		}
		document, err := decodeUniqueJSONObject(data)
		if err != nil {
			return nil, errors.New("parse CAO host policy")
		}
		extendsValue, extends := document["extends"]
		if !extends {
			return document, nil
		}
		if err := validateDeploymentProfileDocument(document); err != nil {
			return nil, err
		}
		extendsPath, ok := extendsValue.(string)
		if !ok || strings.TrimSpace(extendsPath) == "" || filepath.IsAbs(extendsPath) {
			return nil, errors.New("deployment profile extends must be a non-empty relative path")
		}
		base, err := load(filepath.Join(filepath.Dir(canonicalPath), extendsPath), depth+1)
		if err != nil {
			return nil, err
		}
		delete(document, "extends")
		return mergePolicyMaps(base, document), nil
	}

	return load(entryPath, 0)
}

func validateDeploymentProfileDocument(document map[string]any) error {
	if err := requireOnlyKeys(document, "extends", "control-plane"); err != nil {
		return errors.New("deployment profile may only extend control-plane.web.host")
	}
	if _, ok := document["extends"]; !ok {
		return errors.New("deployment profile requires extends and control-plane.web.host")
	}
	control, ok := document["control-plane"].(map[string]any)
	if !ok || requireOnlyKeys(control, "web") != nil {
		return errors.New("deployment profile may only extend control-plane.web.host")
	}
	if _, ok := control["web"]; !ok {
		return errors.New("deployment profile requires control-plane.web.host")
	}
	web, ok := control["web"].(map[string]any)
	if !ok || requireOnlyKeys(web, "host") != nil {
		return errors.New("deployment profile may only extend control-plane.web.host")
	}
	if _, ok := web["host"]; !ok {
		return errors.New("deployment profile requires control-plane.web.host")
	}
	return nil
}

func requireOnlyKeys(document map[string]any, allowed ...string) error {
	keys := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		keys[key] = true
	}
	for key := range document {
		if !keys[key] {
			return fmt.Errorf("unsupported key %q", key)
		}
	}
	return nil
}

func mergePolicyMaps(base, overlay map[string]any) map[string]any {
	merged := make(map[string]any, len(base)+len(overlay))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range overlay {
		baseMap, baseIsMap := merged[key].(map[string]any)
		overlayMap, overlayIsMap := value.(map[string]any)
		if baseIsMap && overlayIsMap {
			merged[key] = mergePolicyMaps(baseMap, overlayMap)
		} else {
			merged[key] = value
		}
	}
	return merged
}

func decodeUniqueJSONObject(data []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeUniqueJSONValue(decoder)
	if err != nil {
		return nil, err
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, err
	}
	document, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("policy root must be an object")
	}
	return document, nil
}

func decodeUniqueJSONValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}
	switch delimiter {
	case '{':
		document := map[string]any{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errors.New("object key must be a string")
			}
			if _, exists := document[key]; exists {
				return nil, fmt.Errorf("duplicate mapping key: %s", key)
			}
			value, err := decodeUniqueJSONValue(decoder)
			if err != nil {
				return nil, err
			}
			document[key] = value
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return document, nil
	case '[':
		values := []any{}
		for decoder.More() {
			value, err := decodeUniqueJSONValue(decoder)
			if err != nil {
				return nil, err
			}
			values = append(values, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return values, nil
	default:
		return nil, errors.New("unexpected JSON delimiter")
	}
}

func ensureJSONEOF(decoder *json.Decoder) error {
	if _, err := decoder.Token(); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
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
		return nil, fmt.Errorf("redis provider module %q requires TLS", policy.Redis.Module)
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
		return nil, errors.New("upstash Redis provider module requires an upstash.io endpoint")
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
		return "", fmt.Errorf("redis connection requires environment variable %s", firstNonempty(urlEnv, hostEnv))
	}
	port := envValue(lookup, portEnv)
	if port == "" {
		port = "6379"
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", errors.New("redis port environment variable must contain a port number")
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
