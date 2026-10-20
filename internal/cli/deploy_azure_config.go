package cli

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"regexp"
	"strings"
)

const defaultDeployAzureConfigPath = ".github/cao/deploy-azure.json"

// deployAzureConfig is the reviewed, secret-free adopter configuration for
// `gh cao deploy azure`. Field names map to server/azure/main.bicep parameters.
type deployAzureConfig struct {
	SchemaVersion int                      `json:"schemaVersion"`
	Subscription  string                   `json:"subscription"`
	ResourceGroup string                   `json:"resourceGroup"`
	Location      string                   `json:"location"`
	Resources     deployAzureResources     `json:"resources"`
	Image         deployAzureImage         `json:"image"`
	AllowedHosts  []string                 `json:"allowedHosts"`
	Access        deployAzureAccess        `json:"access"`
	RetentionDays int                      `json:"retentionDays"`
	OAuth         deployAzureOAuth         `json:"oauth"`
	Secrets       deployAzureSecretSources `json:"secrets"`
	KeyVault      deployAzureKeyVault      `json:"keyVault,omitempty"`
}

type deployAzureKeyVault struct {
	PurgeProtection *bool `json:"purgeProtection,omitempty"`
}

type deployAzureResources struct {
	FunctionApp           string `json:"functionApp"`
	StorageAccount        string `json:"storageAccount"`
	ContainerRegistry     string `json:"containerRegistry"`
	KeyVault              string `json:"keyVault"`
	PostgresServer        string `json:"postgresServer,omitempty"`
	PostgresDatabase      string `json:"postgresDatabase,omitempty"`
	HostingPlan           string `json:"hostingPlan,omitempty"`
	ApplicationInsights   string `json:"applicationInsights,omitempty"`
	LogAnalyticsWorkspace string `json:"logAnalyticsWorkspace,omitempty"`
}

type deployAzureImage struct {
	Repository string `json:"repository,omitempty"`
	Tag        string `json:"tag"`
}

type deployAzureAccess struct {
	Organizations []string `json:"organizations"`
	Teams         []string `json:"teams"`
	Users         []string `json:"users"`
}

type deployAzureOAuth struct {
	ClientID string `json:"clientId"`
}

type deployAzureSecretSources struct {
	PostgresAdministratorPassword *deployAzureSecretRef `json:"postgresAdministratorPassword"`
	PostgresOwnerPassword         *deployAzureSecretRef `json:"postgresOwnerPassword,omitempty"`
	PostgresRuntimePassword       *deployAzureSecretRef `json:"postgresRuntimePassword,omitempty"`
	GitHubClientSecret            *deployAzureSecretRef `json:"githubClientSecret"`
	SessionSecret                 *deployAzureSecretRef `json:"sessionSecret"`
}

// deployAzureSecretRef names where a secure value lives; it never holds the value.
type deployAzureSecretRef struct {
	Env      string                  `json:"env,omitempty"`
	KeyVault *deployAzureKeyVaultRef `json:"keyVault,omitempty"`
}

type deployAzureKeyVaultRef struct {
	ID         string `json:"id"`
	SecretName string `json:"secretName"`
}

func (r *deployAzureSecretRef) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] != '{' {
		return errors.New("secret values must not be embedded; reference an env var or Key Vault secret")
	}
	type plain deployAzureSecretRef
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	var value plain
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	*r = deployAzureSecretRef(value)
	return nil
}

// describe returns a secret-free, reviewable identifier for the reference.
func (r deployAzureSecretRef) describe() string {
	if r.KeyVault != nil {
		return "keyVault:" + r.KeyVault.ID + "/secrets/" + r.KeyVault.SecretName
	}
	return "env:" + r.Env
}

type deployAzureSecureParameter struct {
	name      string
	field     string
	minLength int
	ref       *deployAzureSecretRef
}

func (c *deployAzureConfig) secureParameters() []deployAzureSecureParameter {
	parameters := []deployAzureSecureParameter{
		{"postgresAdministratorPassword", "secrets.postgresAdministratorPassword", 16, c.Secrets.PostgresAdministratorPassword},
		{"githubClientSecret", "secrets.githubClientSecret", 1, c.Secrets.GitHubClientSecret},
		{"sessionSecret", "secrets.sessionSecret", 32, c.Secrets.SessionSecret},
	}
	if c.Secrets.PostgresOwnerPassword != nil {
		parameters = append(parameters, deployAzureSecureParameter{"postgresOwnerPassword", "secrets.postgresOwnerPassword", 32, c.Secrets.PostgresOwnerPassword})
	}
	if c.Secrets.PostgresRuntimePassword != nil {
		parameters = append(parameters, deployAzureSecureParameter{"postgresRuntimePassword", "secrets.postgresRuntimePassword", 32, c.Secrets.PostgresRuntimePassword})
	}
	return parameters
}

// parameters returns non-secure main.bicep parameters derived from the config.
func (c *deployAzureConfig) parameters() map[string]any {
	parameters := map[string]any{
		"location":                   c.Location,
		"functionAppName":            c.Resources.FunctionApp,
		"storageAccountName":         c.Resources.StorageAccount,
		"containerRegistryName":      c.Resources.ContainerRegistry,
		"keyVaultName":               c.Resources.KeyVault,
		"functionImageTag":           deployAzureImageTag(*c),
		"allowedHosts":               nonNil(c.AllowedHosts),
		"githubAllowedOrganizations": nonNil(c.Access.Organizations),
		"githubAllowedTeams":         nonNil(c.Access.Teams),
		"githubAllowedUsers":         nonNil(c.Access.Users),
		"githubClientId":             c.OAuth.ClientID,
		"postgresRunRetentionDays":   c.RetentionDays,
	}
	optional := map[string]string{
		"postgresServerName":        c.Resources.PostgresServer,
		"postgresDatabaseName":      c.Resources.PostgresDatabase,
		"hostingPlanName":           c.Resources.HostingPlan,
		"applicationInsightsName":   c.Resources.ApplicationInsights,
		"logAnalyticsWorkspaceName": c.Resources.LogAnalyticsWorkspace,
		"functionImageRepository":   c.Image.Repository,
	}
	for name, value := range optional {
		if value != "" {
			parameters[name] = value
		}
	}
	if c.KeyVault.PurgeProtection != nil {
		parameters["keyVaultPurgeProtection"] = *c.KeyVault.PurgeProtection
	}
	return parameters
}

// postgresServerName mirrors the template default for postgresServerName.
func (c *deployAzureConfig) postgresServerName() string {
	if c.Resources.PostgresServer != "" {
		return c.Resources.PostgresServer
	}
	return c.Resources.FunctionApp + "-pg"
}

// globalResourceNames lists configured names that must not already exist.
func (c *deployAzureConfig) globalResourceNames() []string {
	return []string{c.Resources.FunctionApp, c.Resources.StorageAccount, c.Resources.ContainerRegistry, c.Resources.KeyVault, c.postgresServerName()}
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

type deployAzureLoadedConfig struct {
	config deployAzureConfig
	path   string
	digest string
}

func loadDeployAzureConfig(path string) (deployAzureLoadedConfig, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return deployAzureLoadedConfig{}, fmt.Errorf("read deploy config %s: %w", path, err)
	}
	config, err := parseDeployAzureConfig(content)
	if err != nil {
		return deployAzureLoadedConfig{}, fmt.Errorf("invalid deploy config %s: %w", path, err)
	}
	sum := sha256.Sum256(content)
	return deployAzureLoadedConfig{config: config, path: path, digest: hex.EncodeToString(sum[:])}, nil
}

func parseDeployAzureConfig(content []byte) (deployAzureConfig, error) {
	var config deployAzureConfig
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return deployAzureConfig{}, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return deployAzureConfig{}, errors.New("unexpected content after the configuration object")
	}
	if err := scanDeployAzureStrings(reflect.ValueOf(config), ""); err != nil {
		return deployAzureConfig{}, err
	}
	if err := config.validate(); err != nil {
		return deployAzureConfig{}, err
	}
	return config, nil
}

var (
	deployPlaceholderPatterns = []*regexp.Regexp{
		regexp.MustCompile(`<[^>]*>`),
		regexp.MustCompile(`\$\{[^}]*\}`),
		regexp.MustCompile(`\{\{[^}]*\}\}`),
		regexp.MustCompile(`(?i)\b(TODO|TBD|FIXME|CHANGEME|CHANGE_ME|REPLACE_ME|REPLACEME|PLACEHOLDER)\b`),
		regexp.MustCompile(`(?i)^x{3,}$`),
	}
	deployEmbeddedSecretPatterns = []*regexp.Regexp{
		regexp.MustCompile(`\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`),
		regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}`),
		regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
		regexp.MustCompile(`(?i)(AccountKey|SharedAccessKey|password|pwd|secret)\s*=`),
		regexp.MustCompile(`(?i)postgres(ql)?://[^/\s:@]+:[^@\s]+@`),
	}
)

func scanDeployAzureStrings(value reflect.Value, path string) error {
	switch value.Kind() {
	case reflect.Pointer:
		if value.IsNil() {
			return nil
		}
		return scanDeployAzureStrings(value.Elem(), path)
	case reflect.Struct:
		for index := 0; index < value.NumField(); index++ {
			name := strings.Split(value.Type().Field(index).Tag.Get("json"), ",")[0]
			child := name
			if path != "" {
				child = path + "." + name
			}
			if err := scanDeployAzureStrings(value.Field(index), child); err != nil {
				return err
			}
		}
	case reflect.Slice:
		for index := 0; index < value.Len(); index++ {
			if err := scanDeployAzureStrings(value.Index(index), fmt.Sprintf("%s[%d]", path, index)); err != nil {
				return err
			}
		}
	case reflect.String:
		text := value.String()
		for _, pattern := range deployEmbeddedSecretPatterns {
			if pattern.MatchString(text) {
				return fmt.Errorf("%s appears to embed a secret value; reference secrets by env var or Key Vault name only", path)
			}
		}
		for _, pattern := range deployPlaceholderPatterns {
			if pattern.MatchString(text) {
				return fmt.Errorf("%s contains an unresolved placeholder", path)
			}
		}
	}
	return nil
}

var (
	deploySubscriptionPattern  = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	deployResourceGroupPattern = regexp.MustCompile(`^[-\w.()]{0,89}[-\w()]$`)
	deployLocationPattern      = regexp.MustCompile(`^[a-z0-9]{2,40}$`)
	deployFunctionAppPattern   = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,58}[a-zA-Z0-9]$`)
	deployStoragePattern       = regexp.MustCompile(`^[a-z0-9]{3,24}$`)
	deployRegistryPattern      = regexp.MustCompile(`^[a-zA-Z0-9]{5,50}$`)
	deployKeyVaultPattern      = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$`)
	deployGenericNamePattern   = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]$`)
	deployImagePattern         = regexp.MustCompile(`^[a-z0-9]+(?:[._/-][a-z0-9]+)*$`)
	deployTagPattern           = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
	deployHostPattern          = regexp.MustCompile(`^(?i)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
	deployOwnerPattern         = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)
	deployTeamPattern          = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[a-z0-9][a-z0-9_-]{0,99}$`)
	deployClientIDPattern      = regexp.MustCompile(`^[A-Za-z0-9._-]{8,64}$`)
	deployEnvNamePattern       = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
	deployVaultIDPattern       = regexp.MustCompile(`^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[-\w.()]{1,90}/providers/Microsoft\.KeyVault/vaults/[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$`)
	deploySecretNamePattern    = regexp.MustCompile(`^[0-9a-zA-Z-]{1,127}$`)
)

func (c deployAzureConfig) validate() error {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	require := func(field, value string, pattern *regexp.Regexp, rule string) {
		switch {
		case value == "":
			add("%s is required", field)
		case !pattern.MatchString(value):
			add("%s must be %s", field, rule)
		}
	}
	optional := func(field, value string, pattern *regexp.Regexp, rule string) {
		if value != "" && !pattern.MatchString(value) {
			add("%s must be %s", field, rule)
		}
	}
	if c.SchemaVersion != 1 {
		add("schemaVersion must be 1")
	}
	require("subscription", c.Subscription, deploySubscriptionPattern, "a subscription GUID")
	require("resourceGroup", c.ResourceGroup, deployResourceGroupPattern, "a valid resource group name")
	require("location", c.Location, deployLocationPattern, "a lowercase Azure region name such as westus3")
	require("resources.functionApp", c.Resources.FunctionApp, deployFunctionAppPattern, "2-60 letters, digits, or hyphens")
	require("resources.storageAccount", c.Resources.StorageAccount, deployStoragePattern, "3-24 lowercase letters or digits")
	require("resources.containerRegistry", c.Resources.ContainerRegistry, deployRegistryPattern, "5-50 letters or digits")
	require("resources.keyVault", c.Resources.KeyVault, deployKeyVaultPattern, "3-24 letters, digits, or hyphens starting with a letter")
	optional("resources.postgresServer", c.Resources.PostgresServer, deployGenericNamePattern, "3-63 letters, digits, or hyphens")
	optional("resources.postgresDatabase", c.Resources.PostgresDatabase, deployGenericNamePattern, "1-63 letters, digits, or hyphens")
	optional("resources.hostingPlan", c.Resources.HostingPlan, deployGenericNamePattern, "letters, digits, or hyphens")
	optional("resources.applicationInsights", c.Resources.ApplicationInsights, deployGenericNamePattern, "letters, digits, or hyphens")
	optional("resources.logAnalyticsWorkspace", c.Resources.LogAnalyticsWorkspace, deployGenericNamePattern, "letters, digits, or hyphens")
	optional("image.repository", c.Image.Repository, deployImagePattern, "a lowercase container repository path")
	require("image.tag", c.Image.Tag, deployTagPattern, "a valid container image tag")
	if c.Image.Tag == "latest" {
		add("image.tag must be immutable or reviewed, not latest")
	}
	if len(c.AllowedHosts) == 0 {
		add("allowedHosts requires at least one public host name")
	}
	for index, host := range c.AllowedHosts {
		optional(fmt.Sprintf("allowedHosts[%d]", index), host, deployHostPattern, "a DNS host name")
	}
	if len(c.Access.Organizations)+len(c.Access.Teams)+len(c.Access.Users) == 0 {
		add("access requires at least one organization, team, or user")
	}
	for index, value := range c.Access.Organizations {
		require(fmt.Sprintf("access.organizations[%d]", index), value, deployOwnerPattern, "a GitHub organization login")
	}
	for index, value := range c.Access.Teams {
		require(fmt.Sprintf("access.teams[%d]", index), value, deployTeamPattern, "ORG/team-slug")
	}
	for index, value := range c.Access.Users {
		require(fmt.Sprintf("access.users[%d]", index), value, deployOwnerPattern, "a GitHub user login")
	}
	if c.RetentionDays == 0 {
		add("retentionDays is required and must be explicit")
	} else if c.RetentionDays < 7 || c.RetentionDays > 3650 {
		add("retentionDays must be between 7 and 3650")
	}
	require("oauth.clientId", c.OAuth.ClientID, deployClientIDPattern, "a GitHub OAuth App client ID")
	for _, secure := range c.secureParameters() {
		if secure.ref == nil {
			add("%s is required", secure.field)
			continue
		}
		hasEnv, hasVault := secure.ref.Env != "", secure.ref.KeyVault != nil
		switch {
		case hasEnv == hasVault:
			add("%s must set exactly one of env or keyVault", secure.field)
		case hasEnv:
			require(secure.field+".env", secure.ref.Env, deployEnvNamePattern, "an uppercase environment variable name")
		default:
			require(secure.field+".keyVault.id", secure.ref.KeyVault.ID, deployVaultIDPattern, "a Key Vault resource ID")
			require(secure.field+".keyVault.secretName", secure.ref.KeyVault.SecretName, deploySecretNamePattern, "a Key Vault secret name")
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}
