package githubapp

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestWebhookGatewayAcceptedHeadersSurviveBodyTimeout(t *testing.T) {
	client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if gatewayAuthorityResponse(w, r) {
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = http.NewResponseController(w).Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(250 * time.Millisecond):
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	subscription := gatewayTestSubscription("workflow_dispatch")
	response := (WebhookGatewayDispatcher{Client: client}).Dispatch(ctx, subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
	if response.TransportOutcome != "response" || response.StatusCode != 200 || response.WorkflowRunID != 0 || len(response.Body) != 0 {
		t.Fatalf("known acceptance overwritten by body timeout: %+v", response)
	}
}
