package simulator

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

// IssueService emits synthetic provider webhooks, not provider API calls.
// Resource URLs are inert references; delivery is restricted to local HTTP.
// Exported fixture fields may be changed to exercise invalid receiver evidence.
type IssueService struct {
	Provider, Event, Scope, CollectionID, ResourceURLPrefix string
	Secret                                                  string
	Trace                                                   *Trace
}

func NewIssueService(provider string) (*IssueService, error) {
	s := &IssueService{Provider: provider, Secret: rand.Text() + rand.Text(), Trace: &Trace{}}
	switch provider {
	case "jira":
		s.Event, s.Scope = "jira_issue", "APP"
		s.ResourceURLPrefix = "https://simulator.atlassian.net/rest/api/3/issue/"
	case "linear":
		s.Event, s.Scope = "linear_issue", "linear-org"
		s.ResourceURLPrefix = "https://linear.app/simulator/issue/"
	case "azure-devops":
		s.Event, s.Scope, s.CollectionID = "azure_devops_issue", "azure-project", "azure-collection"
		s.ResourceURLPrefix = "https://dev.azure.com/simulator/_apis/wit/workItems/"
	default:
		return nil, errors.New("unsupported simulator issue provider")
	}
	return s, nil
}

var issueDeliveryID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)

// Delivery builds repeatable issue lifecycle evidence at an explicit time.
// Updates carry native before/after values rather than pre-normalized activities.
func (s IssueService) Delivery(id string, issue int, activity string, at time.Time) (Delivery, error) {
	if !issueDeliveryID.MatchString(id) || issue < 1 || issue > 1000000 || at.IsZero() {
		return Delivery{}, errors.New("invalid simulator issue delivery identity")
	}
	native := map[string]string{
		"opened": "create", "edited": "update", "closed": "update", "reopened": "update",
		"labeled": "update", "unlabeled": "update", "deleted": "remove",
	}[activity]
	if native == "" && (s.Provider != "azure-devops" || activity != "restored") {
		return Delivery{}, errors.New("unsupported simulator issue activity")
	}
	number, stamp := strconv.Itoa(issue), at.UTC().Format(time.RFC3339Nano)
	root := map[string]any{"id": id}
	switch s.Provider {
	case "jira":
		action := map[string]string{"create": "jira:issue_created", "update": "jira:issue_updated", "remove": "jira:issue_deleted"}[native]
		labels := []string{}
		changes := []any{}
		switch activity {
		case "closed":
			changes = append(changes, map[string]any{"fieldtype": "jira", "field": "resolution", "from": nil, "to": "1"})
		case "reopened":
			changes = append(changes, map[string]any{"fieldtype": "jira", "field": "resolution", "from": "1", "to": nil})
		case "labeled":
			labels = []string{"urgent"}
			changes = append(changes, map[string]any{"fieldtype": "jira", "field": "labels", "fromString": nil, "toString": "urgent"})
		case "unlabeled":
			changes = append(changes, map[string]any{"fieldtype": "jira", "field": "labels", "fromString": "urgent", "toString": nil})
		}
		root["webhookEvent"], root["timestamp"] = action, at.UnixMilli()
		root["issue"] = map[string]any{"id": number, "self": s.ResourceURLPrefix + number,
			"fields": map[string]any{"project": map[string]string{"key": s.Scope}, "labels": labels, "summary": "MUST-NOT-PERSIST"}}
		root["changelog"] = map[string]any{"items": changes}
	case "linear":
		data := map[string]any{"id": "issue-" + number, "url": s.ResourceURLPrefix + "APP-" + number,
			"completedAt": nil, "canceledAt": nil, "labelIds": []string{}, "title": "MUST-NOT-PERSIST"}
		before := map[string]any{}
		switch activity {
		case "closed":
			before["completedAt"], data["completedAt"] = nil, stamp
		case "reopened":
			before["completedAt"] = stamp
		case "labeled":
			before["labelIds"], data["labelIds"] = []string{}, []string{"urgent"}
		case "unlabeled":
			before["labelIds"] = []string{"urgent"}
		}
		root["type"], root["action"], root["organizationId"] = "Issue", native, s.Scope
		root["webhookTimestamp"], root["data"], root["updatedFrom"] = at.UnixMilli(), data, before
	case "azure-devops":
		action := map[string]string{"create": "workitem.created", "update": "workitem.updated", "remove": "workitem.deleted"}[native]
		if activity == "restored" {
			action = "workitem.restored"
		}
		fields := map[string]any{"System.Title": map[string]string{"oldValue": "old", "newValue": "MUST-NOT-PERSIST"}}
		switch activity {
		case "closed":
			fields["System.State"] = map[string]string{"oldValue": "Active", "newValue": "Done"}
		case "reopened":
			fields["System.State"] = map[string]string{"oldValue": "Done", "newValue": "Active"}
		case "labeled":
			fields["System.Tags"] = map[string]string{"oldValue": "", "newValue": "urgent;"}
		case "unlabeled":
			fields["System.Tags"] = map[string]string{"oldValue": "urgent;", "newValue": ""}
		}
		root["eventType"], root["resourceVersion"] = action, "2.0"
		root["resourceContainers"] = map[string]any{"collection": map[string]string{"id": s.CollectionID}, "project": map[string]string{"id": s.Scope}}
		resource := map[string]any{"id": issue, "url": s.ResourceURLPrefix + number, "fields": fields}
		if native == "update" {
			// Update IDs are revision IDs, not work item identities.
			resource["id"], resource["workItemId"] = issue+1000000, issue
			resource["url"] = s.ResourceURLPrefix + number + "/updates/1"
		}
		root["resource"] = resource
	default:
		return Delivery{}, errors.New("unsupported simulator issue provider")
	}
	payload, err := json.Marshal(root)
	if err != nil {
		return Delivery{}, err
	}
	return Delivery{ID: id, Event: s.Event, Payload: payload}, nil
}

// WebhookSecrets implements the receiver's test-only secret boundary.
func (s IssueService) WebhookSecrets(context.Context, string) ([]byte, []byte, error) {
	return []byte(s.Secret), nil, nil
}

func (s IssueService) SignedRequest(ctx context.Context, endpoint string, delivery Delivery) (*http.Request, error) {
	if !issueDeliveryID.MatchString(delivery.ID) || delivery.Event != s.Event ||
		len(delivery.Payload) > 1<<20 || !json.Valid(delivery.Payload) || len(s.Secret) < 32 || len(s.Secret) > 512 {
		return nil, errors.New("invalid simulator issue webhook")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(delivery.Payload))
	if err != nil {
		return nil, errors.New("create simulator issue webhook request")
	}
	request.Header.Set("Content-Type", "application/json")
	mac := hmac.New(sha256.New, []byte(s.Secret))
	_, _ = mac.Write(delivery.Payload)
	signature := hex.EncodeToString(mac.Sum(nil))
	switch s.Provider {
	case "jira":
		request.Header.Set("X-Hub-Signature", "sha256="+signature)
		request.Header.Set("X-Atlassian-Webhook-Identifier", delivery.ID)
	case "linear":
		request.Header.Set("Linear-Signature", signature)
		request.Header.Set("Linear-Delivery", delivery.ID)
	case "azure-devops":
		request.SetBasicAuth("cao", s.Secret)
	default:
		return nil, errors.New("unsupported simulator issue provider")
	}
	return request, nil
}

func (s IssueService) DeliverWebhook(ctx context.Context, endpoint string, delivery Delivery) (int, error) {
	request, err := s.SignedRequest(ctx, endpoint, delivery)
	if err != nil {
		return 0, err
	}
	return deliverLocalWebhook(request, s.Trace, s.Provider+".webhook")
}
