package webhookgateway

import (
	"bytes"
	"encoding/json"
	"strings"
)

const CompilerSourceID = "compiler"

// MaxDiscoveryRepositories bounds explicit enrollment independently of the
// registry byte budget, API quota and per-round discovery work.
const (
	MaxDiscoveryRepositories   = 2048
	MaxDiscoveredSubscriptions = 2048
)

type DiscoveryRepository struct {
	Repository              string `json:"repository"`
	RepositoryID            int64  `json:"repositoryId"`
	ReceivingInstallationID int64  `json:"receivingInstallationId"`
	DispatchInstallationID  int64  `json:"dispatchInstallationId"`
	AllowLabelRemoval       bool   `json:"allowLabelRemoval,omitempty"`
}

type DiscoveryPolicy struct {
	Repositories          []DiscoveryRepository `json:"repositories"`
	IntervalSeconds       int64                 `json:"intervalSeconds,omitempty"`
	ActivateSecurity      bool                  `json:"activateSecurity"`
	ActivateCommands      bool                  `json:"activateCommands,omitempty"`
	ActivateNotifications bool                  `json:"activateNotifications,omitempty"`
	ServerURL             string                `json:"serverUrl,omitempty"`
}

func (d *DiscoveryPolicy) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || len(fields["activateSecurity"]) == 0 ||
		bytes.Equal(bytes.TrimSpace(fields["activateSecurity"]), []byte("null")) {
		return ErrInvalid
	}
	type plain DiscoveryPolicy
	var result plain
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return ErrInvalid
	}
	if _, explicit := fields["intervalSeconds"]; explicit && result.IntervalSeconds == 0 {
		return ErrInvalid
	}
	for _, key := range []string{"activateCommands", "activateNotifications", "serverUrl"} {
		if raw, exists := fields[key]; exists && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return ErrInvalid
		}
	}
	if _, explicit := fields["serverUrl"]; explicit && !validGitHubServerURL(result.ServerURL) {
		return ErrInvalid
	}
	*d = DiscoveryPolicy(result)
	return nil
}

func (d DiscoveryPolicy) GitHubServerURL() string {
	if d.ServerURL == "" {
		return "https://github.com"
	}
	return d.ServerURL
}

// CompilerSourceAllowed rechecks independent notification/command activation and
// the separate consuming-label grant. Compiler metadata cannot supply authority.
func (p PolicySnapshot) CompilerSourceAllowed(s Subscription) bool {
	notification := s.Compiler != nil && notificationFamily(s.Source.Event)
	if !commandFamily(s.Source.Event) && !notification {
		return true
	}
	d := p.Policy.Discovery
	if s.Compiler == nil || d == nil || s.Source.ServerURL != d.GitHubServerURL() {
		return false
	}
	if notification && (!d.ActivateNotifications || validateNotificationDeclaration(*s.Compiler) != nil) ||
		!notification && (!d.ActivateCommands || s.Compiler.CommandFilter == nil ||
			validateCommandDeclaration(*s.Compiler, DefaultLimits()) != nil) {
		return false
	}
	for _, source := range d.Repositories {
		if source.RepositoryID == s.Source.RepositoryID && source.ReceivingInstallationID == s.Source.InstallationID &&
			p.RepositoryAllowed(source.Repository) && CompilerRepositoryMatches(*s.Compiler, source.Repository) {
			return !RequiresLabelRemoval(s) || source.AllowLabelRemoval
		}
	}
	return false
}

// ProjectAssignment is control-repository authority, not a declaration supplied
// by an organization webhook or by the repository containing a workflow.
type ProjectAssignment struct {
	ProjectID      string `json:"projectId"`
	OrganizationID int64  `json:"organizationId"`
	RepositoryID   int64  `json:"repositoryId"`
}

func (d DiscoveryPolicy) Interval() int64 {
	if d.IntervalSeconds == 0 {
		return 300
	}
	return d.IntervalSeconds
}

func RepositoryNameOK(name string) bool {
	owner, repository, ok := strings.Cut(name, "/")
	if !ok || !identifier(owner) || owner[0] == '-' || !identifier(repository) ||
		repository == "." || repository == ".." || strings.Contains(repository, "/") {
		return false
	}
	for _, c := range owner {
		if c == '.' || c == '_' {
			return false
		}
	}
	return true
}

func ValidateDiscoveryPolicy(p GatewayPolicy) error {
	if len(p.ProjectAssignments) > 128 {
		return ErrInvalid
	}
	repositories := make(map[int64]bool)
	names := make(map[string]bool)
	if p.Discovery != nil {
		d := p.Discovery
		if len(d.Repositories) == 0 || len(d.Repositories) > MaxDiscoveryRepositories || d.Interval() < 30 || d.Interval() > 3600 {
			return ErrInvalid
		}
		if !validGitHubServerURL(d.GitHubServerURL()) {
			return ErrInvalid
		}
		for _, r := range d.Repositories {
			if !RepositoryNameOK(r.Repository) || r.RepositoryID <= 0 || r.ReceivingInstallationID <= 0 ||
				r.DispatchInstallationID <= 0 || repositories[r.RepositoryID] || names[strings.ToLower(r.Repository)] ||
				r.AllowLabelRemoval && !d.ActivateCommands {
				return ErrInvalid
			}
			repositories[r.RepositoryID], names[strings.ToLower(r.Repository)] = true, true
		}
	}
	projects := make(map[string]bool)
	for _, a := range p.ProjectAssignments {
		if !nodeID(a.ProjectID) || a.OrganizationID <= 0 || !repositories[a.RepositoryID] || projects[a.ProjectID] {
			return ErrInvalid
		}
		projects[a.ProjectID] = true
	}
	return nil
}

func (p PolicySnapshot) ProjectAssigned(project string, organization, repository int64) bool {
	for _, assignment := range p.Policy.ProjectAssignments {
		if assignment.ProjectID == project && assignment.OrganizationID == organization &&
			assignment.RepositoryID == repository {
			return true
		}
	}
	return false
}

func SecurityEventPermission(event string) string {
	switch event {
	case "dependabot_alert":
		return "vulnerability_alerts"
	case "code_scanning_alert":
		return "security_events"
	case "secret_scanning_alert":
		return "secret_scanning_alerts"
	default:
		return ""
	}
}
