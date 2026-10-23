package simulator

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIssueServiceSimulator(t *testing.T) {
	for _, provider := range []string{"jira", "linear", "azure-devops"} {
		t.Run(provider, func(t *testing.T) {
			service, err := NewIssueService(provider)
			if err != nil {
				t.Fatal(err)
			}
			at := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
			activities := []string{"opened", "edited", "closed", "reopened", "labeled", "unlabeled", "deleted"}
			if provider == "azure-devops" {
				activities = append(activities, "restored")
			}
			for _, activity := range activities {
				first, err := service.Delivery(activity, 42, activity, at)
				if err != nil {
					t.Fatal(err)
				}
				second, err := service.Delivery(activity, 42, activity, at)
				if err != nil || !bytes.Equal(first.Payload, second.Payload) || !json.Valid(first.Payload) {
					t.Fatal("delivery generation is not repeatable", err)
				}
				request, err := service.SignedRequest(t.Context(), "http://127.0.0.1:1/webhooks", first)
				if err != nil {
					t.Fatal(err)
				}
				mac := hmac.New(sha256.New, []byte(service.Secret))
				_, _ = mac.Write(first.Payload)
				signature := hex.EncodeToString(mac.Sum(nil))
				switch provider {
				case "jira":
					if request.Header.Get("X-Hub-Signature") != "sha256="+signature ||
						request.Header.Get("X-Atlassian-Webhook-Identifier") != activity {
						t.Fatal("incorrect Jira authentication")
					}
				case "linear":
					if request.Header.Get("Linear-Signature") != signature || request.Header.Get("Linear-Delivery") != activity {
						t.Fatal("incorrect Linear authentication")
					}
				default:
					user, password, ok := request.BasicAuth()
					if !ok || user != "cao" || password != service.Secret {
						t.Fatal("incorrect Azure service hook authentication")
					}
				}
			}
			for _, activity := range []string{"unknown", "restored"} {
				if provider == "azure-devops" && activity == "restored" {
					continue
				}
				if _, err := service.Delivery("invalid", 42, activity, at); err == nil {
					t.Fatal("unsupported activity accepted")
				}
			}
			for _, issue := range []int{0, -1, 1000001} {
				if _, err := service.Delivery("invalid", issue, "opened", at); err == nil {
					t.Fatal("out-of-bounds issue identity accepted")
				}
			}
			if _, err := service.Delivery("bad\nid", 1, "opened", at); err == nil {
				t.Fatal("invalid delivery identity accepted")
			}
			if _, err := service.Delivery("valid", 1, "opened", time.Time{}); err == nil {
				t.Fatal("missing timestamp accepted")
			}
			delivery, err := service.Delivery("valid", 1, "opened", at)
			if err != nil {
				t.Fatal(err)
			}
			for _, payload := range [][]byte{[]byte("{"), bytes.Repeat([]byte(" "), (1<<20)+1)} {
				corrupt := delivery
				corrupt.Payload = payload
				if _, err := service.SignedRequest(t.Context(), "http://127.0.0.1:1", corrupt); err == nil {
					t.Fatal("malformed or oversized body accepted")
				}
			}
			for _, endpoint := range []string{"https://linear.app", "https://example.atlassian.net", "https://dev.azure.com", "http://localhost:80"} {
				if status, err := service.DeliverWebhook(t.Context(), endpoint, delivery); status != 0 || err == nil {
					t.Fatal("non-numeric-loopback endpoint permitted")
				}
			}
		})
	}
	if _, err := NewIssueService("github"); err == nil {
		t.Fatal("unknown provider accepted")
	}
}

func TestIssueServiceSimulatorHTTPIsolation(t *testing.T) {
	service, err := NewIssueService("linear")
	if err != nil {
		t.Fatal(err)
	}
	delivery, err := service.Delivery("local", 1, "opened", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()
	status := http.StatusFound
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(status)
	}))
	defer source.Close()
	t.Setenv("HTTP_PROXY", target.URL)
	t.Setenv("HTTPS_PROXY", target.URL)
	t.Setenv("ALL_PROXY", target.URL)
	for _, code := range []int{http.StatusFound, http.StatusUnauthorized, http.StatusServiceUnavailable, http.StatusOK} {
		status = code
		got, err := service.DeliverWebhook(t.Context(), source.URL, delivery)
		if got != code || (err == nil) != (code == http.StatusOK) || calls != 0 {
			t.Fatalf("unexpected local delivery status=%d error=%v redirected/proxied=%d", got, err, calls)
		}
	}
	for _, event := range service.Trace.Events() {
		if event.Stage != "linear.webhook" || strings.Contains(event.Stage, service.Secret) {
			t.Fatal("trace contains more than provider/stage and HTTP status")
		}
	}
}
