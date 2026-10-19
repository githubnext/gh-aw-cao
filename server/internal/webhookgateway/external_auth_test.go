package webhookgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func externalRequest(t *testing.T, source ExternalSource, root map[string]any, secret string) (*http.Request, []byte) {
	t.Helper()
	body, err := json.Marshal(root)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/webhooks/"+source.ID, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	switch source.Event {
	case "jira_issue":
		request.Header.Set("X-Hub-Signature", signWebhook(body, []byte(secret)))
		request.Header.Set("X-Atlassian-Webhook-Identifier", "native-delivery")
	case "linear_issue":
		request.Header.Set("Linear-Signature", strings.TrimPrefix(signWebhook(body, []byte(secret)), "sha256="))
		request.Header.Set("Linear-Delivery", "native-delivery")
	case "azure_devops_issue":
		request.SetBasicAuth("cao", secret)
	default:
		request.Header.Set("X-Cao-Signature-256", signWebhook(body, []byte(secret)))
	}
	return request, body
}

func TestExternalAuthenticationNativeSchemesAndRotation(t *testing.T) {
	base, _, deliveries := externalFixture(t)
	current, previous := strings.Repeat("x", 32), strings.Repeat("p", 32)
	for _, delivery := range deliveries {
		t.Run(delivery.SourceID, func(t *testing.T) {
			source, _ := base.ExternalSource(delivery.SourceID)
			for _, secret := range []string{current, previous} {
				request, body := externalRequest(t, source, delivery.Payload, secret)
				request.Header.Set("X-GitHub-Event", "issues")
				event, err := AuthenticateExternal(source, request, body, []byte(current), []byte(previous), time.Now(), DefaultLimits())
				if err != nil || event.Name != source.Event || event.SourceID != source.ID ||
					event.InstallationID != 0 || event.RepositoryID != 0 || len(event.DeliveryID) != 64 {
					t.Fatal("native authentication failed or inferred GitHub identity", err)
				}
			}
			request, body := externalRequest(t, source, delivery.Payload, "wrong")
			if _, err := AuthenticateExternal(source, request, body, []byte(current), nil, time.Now(), DefaultLimits()); err == nil {
				t.Fatal("wrong source credential authenticated")
			}
			for _, size := range []int{31, 32, 512, 513} {
				credential := strings.Repeat("x", size)
				expected := size >= 32 && size <= 512
				request, body := externalRequest(t, source, delivery.Payload, credential)
				if _, err := AuthenticateExternal(source, request, body, []byte(credential), nil, time.Now(), DefaultLimits()); (err == nil) != expected {
					t.Fatal("current credential bounds not enforced", size, err)
				}
				request, body = externalRequest(t, source, delivery.Payload, current)
				if _, err := AuthenticateExternal(source, request, body, []byte(current), []byte(credential), time.Now(), DefaultLimits()); (err == nil) != expected {
					t.Fatal("rotation credential bounds not enforced", size, err)
				}
			}
			request, body = externalRequest(t, source, delivery.Payload, current)
			if source.Event != "azure_devops_issue" {
				body = append(body, ' ')
				if _, err := AuthenticateExternal(source, request, body, []byte(current), nil, time.Now(), DefaultLimits()); err == nil {
					t.Fatal("body changed after signing")
				}
			}
			request, body = externalRequest(t, source, delivery.Payload, current)
			source.ExpiresAt = time.Now().Add(-time.Second)
			if _, err := AuthenticateExternal(source, request, body, []byte(current), nil, time.Now(), DefaultLimits()); err == nil {
				t.Fatal("expired enrollment authenticated")
			}
		})
	}
}

func TestExternalAuthenticationRejectsStaleSignedTimestampsAndDuplicateHeaders(t *testing.T) {
	base, _, deliveries := externalFixture(t)
	secret := strings.Repeat("x", 32)
	for _, delivery := range deliveries {
		source, _ := base.ExternalSource(delivery.SourceID)
		header := map[string]string{"jira_issue": "X-Hub-Signature", "linear_issue": "Linear-Signature",
			"azure_devops_issue": "Authorization", "webhook": "X-Cao-Signature-256"}[source.Event]
		request, body := externalRequest(t, source, delivery.Payload, secret)
		request.Header.Add(header, request.Header.Get(header))
		if _, err := AuthenticateExternal(source, request, body, []byte(secret), nil, time.Now(), DefaultLimits()); err == nil {
			t.Fatal("ambiguous authentication headers accepted", source.Event)
		}
		if source.Event == "linear_issue" || source.Event == "webhook" {
			for _, delta := range []time.Duration{-10 * time.Minute, 10 * time.Minute} {
				field := "timestamp"
				if source.Event == "linear_issue" {
					field = "webhookTimestamp"
				}
				delivery.Payload[field] = time.Now().Add(delta).UnixMilli()
				request, body := externalRequest(t, source, delivery.Payload, secret)
				if _, err := AuthenticateExternal(source, request, body, []byte(secret), nil, time.Now(), DefaultLimits()); err == nil {
					t.Fatal("stale/future signed delivery accepted", source.Event)
				}
			}
		}
	}
}

type externalSecrets []byte

func (secret externalSecrets) WebhookSecrets(_ context.Context, _ string) ([]byte, []byte, error) {
	return secret, nil, nil
}

func TestExternalIngressNeverAcknowledgesFailedStorageOrChangedPolicy(t *testing.T) {
	base, registry, deliveries := externalFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	source, _ := policy.ExternalSource("linear")
	for _, scenario := range []string{"database-unavailable", "policy-changed"} {
		t.Run(scenario, func(t *testing.T) {
			queue := &shellQueue{admitErr: ErrUnavailable}
			loads := 0
			loader := shellPolicy{load: func() (PolicySnapshot, error) {
				loads++
				current := policy
				if scenario == "policy-changed" && loads > 1 {
					current.Revision.Revision++
				}
				return current, nil
			}}
			authorizer := &shellAuthorizer{fn: func(job Job) (AuthorizationSnapshot, error) {
				now := time.Now()
				return AuthorizationSnapshot{Complete: true, JobID: job.ID, Attempt: 1, ExternalSourceID: source.ID,
					CheckedAt: now, ExpiresAt: now.Add(time.Second), SourceAccessible: true, SourcePermissionsOK: true,
					DestinationAccessible: true, DispatchPermissionsOK: true, SourceVisibility: "private", DestinationVisibility: "private",
					DestinationInstallationID: job.Subscription.Destination.InstallationID, DestinationRepositoryID: 11,
					CurrentRevision: policy.Revisions[job.Subscription.ID], Grant: policy.Grants[job.Subscription.ID]}, nil
			}}
			secret := strings.Repeat("x", 32)
			handler := Ingress{SourceID: "linear", External: true, Policies: loader, Secrets: externalSecrets(secret),
				Queue: queue, Authorizer: authorizer}
			request, _ := externalRequest(t, source, deliveries[1].Payload, secret)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusServiceUnavailable ||
				scenario == "policy-changed" && (authorizer.calls != 0 || len(queue.admission.Jobs) != 0) {
				t.Fatal("failed persistence or changed authentication revision was acknowledged")
			}
		})
	}
}

func TestExternalIngressAuthenticatesFiltersAndCommitsMinimalJobs(t *testing.T) {
	base, registry, deliveries := externalFixture(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, delivery := range deliveries {
		t.Run(delivery.SourceID, func(t *testing.T) {
			queue := &shellQueue{}
			source, _ := policy.ExternalSource(delivery.SourceID)
			authorizer := &shellAuthorizer{fn: func(job Job) (AuthorizationSnapshot, error) {
				now := time.Now()
				return AuthorizationSnapshot{
					Complete: true, JobID: job.ID, Attempt: 1, ExternalSourceID: source.ID,
					CheckedAt: now, ExpiresAt: now.Add(10 * time.Second),
					SourceAccessible: true, SourcePermissionsOK: true, SourceVisibility: "private",
					DestinationAccessible: true, DispatchPermissionsOK: true, DestinationVisibility: "private",
					DestinationInstallationID: job.Subscription.Destination.InstallationID,
					DestinationRepositoryID:   job.Subscription.Destination.RepositoryID,
					CurrentRevision:           policy.Revisions[job.Subscription.ID], Grant: policy.Grants[job.Subscription.ID],
				}, nil
			}}
			secret := strings.Repeat("x", 32)
			handler := &Ingress{SourceID: source.ID, External: true, Secrets: externalSecrets(secret),
				Policies: shellPolicy{snapshot: policy}, Queue: queue, Authorizer: authorizer}
			request, _ := externalRequest(t, source, delivery.Payload, secret)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			expectedStatus := http.StatusAccepted
			if source.Event == "linear_issue" {
				expectedStatus = http.StatusOK
			}
			if response.Code != expectedStatus || len(queue.admission.Jobs) != 1 {
				t.Fatalf("ingress HTTP %d jobs=%d", response.Code, len(queue.admission.Jobs))
			}
			encoded, err := json.Marshal(queue.admission.Jobs)
			if err != nil || strings.Contains(string(encoded), "MUST-NOT-PERSIST") {
				t.Fatal("native resource body persisted", err)
			}
			batch, err := BuildDispatchBatch(queue.admission.Jobs)
			if err != nil || strings.Contains(string(batch), "_gateway") {
				t.Fatal("compiler dispatch gained provenance side channels", err)
			}
			request, _ = externalRequest(t, source, delivery.Payload, "wrong")
			response = httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || authorizer.calls != 1 {
				t.Fatal("unauthenticated delivery reached admission authorization")
			}
		})
	}
}
