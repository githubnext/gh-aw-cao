package webhookgateway

import (
	"bytes"
	"encoding/json"
	"strings"
)

const CompilerSourceID = "compiler"

type DiscoveryRepository struct {
	Repository              string `json:"repository"`
	RepositoryID            int64  `json:"repositoryId"`
	ReceivingInstallationID int64  `json:"receivingInstallationId"`
	DispatchInstallationID  int64  `json:"dispatchInstallationId"`
}

type DiscoveryPolicy struct {
	Repositories     []DiscoveryRepository `json:"repositories"`
	IntervalSeconds  int64                 `json:"intervalSeconds,omitempty"`
	ActivateSecurity bool                  `json:"activateSecurity"`
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
	*d = DiscoveryPolicy(result)
	return nil
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
		if len(d.Repositories) == 0 || len(d.Repositories) > 64 || d.Interval() < 30 || d.Interval() > 3600 {
			return ErrInvalid
		}
		for _, r := range d.Repositories {
			if !RepositoryNameOK(r.Repository) || r.RepositoryID <= 0 || r.ReceivingInstallationID <= 0 ||
				r.DispatchInstallationID <= 0 || repositories[r.RepositoryID] || names[strings.ToLower(r.Repository)] {
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
