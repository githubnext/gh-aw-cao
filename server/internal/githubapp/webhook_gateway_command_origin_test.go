package githubapp

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func TestGatewayCommandServerURLMatchesActualAPIBasePath(t *testing.T) {
	for _, base := range []string{"", "https://api.github.com", "https://github.example", "https://github.example/github/base/api/v3/", "https://github.example/github/base"} {
		client := &Client{config: Config{BaseURL: base}}
		rest, err := enterpriseClient(&http.Client{}, client.config)
		if err != nil {
			t.Fatal(err)
		}
		server := client.WebhookGatewayServerURL()
		expected := server + "/api/v3"
		if server == "https://github.com" {
			expected = "https://api.github.com"
		}
		if strings.TrimSuffix(rest.BaseURL.String(), "/") != expected {
			t.Fatal("server origin diverges from actual authenticated API", server, rest.BaseURL)
		}
	}
	for _, base := range []string{"http://github.example/api/v3", "https://token@github.example/api/v3", "https://github.example/api/v3?query"} {
		client := &Client{config: Config{BaseURL: base}}
		if client.WebhookGatewayServerURL() != "" {
			t.Fatal("unapproved API origin accepted")
		}
	}
}

func TestGatewayCommandFinalPreflightRequiresReceivingServerBinding(t *testing.T) {
	s := labelAPISubscription(t, "issues")
	for _, receiving := range []*Client{nil, {config: Config{BaseURL: "https://other.example/api/v3"}}} {
		dispatcher := WebhookGatewayDispatcher{Receiving: receiving}
		if err := dispatcher.compilerSourcePreflight(t.Context(), s, nil, GatewayRepository{}); !errors.Is(err, gateway.ErrUnauthorized) {
			t.Fatal("missing/mismatched independently configured receiving origin reached final egress", err)
		}
	}
}

func TestGatewayNotificationFinalPreflightRequiresReceivingServerBinding(t *testing.T) {
	s := labelAPISubscription(t, "issues")
	s.Source.Event, s.Compiler.Event, s.Compiler.CommandFilter = "issues", "issues", nil
	s.Source.RequiredPermissions = map[string]string{"contents": "read", "issues": "read"}
	for _, receiving := range []*Client{nil, {config: Config{BaseURL: "https://other.example/api/v3"}}} {
		dispatcher := WebhookGatewayDispatcher{Receiving: receiving}
		if err := dispatcher.compilerSourcePreflight(t.Context(), s, nil, GatewayRepository{}); !errors.Is(err, gateway.ErrUnauthorized) {
			t.Fatal("notification bypassed independent receiving origin binding", err)
		}
	}
}
