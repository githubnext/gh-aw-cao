package githubapp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"testing"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
)

func TestWebhookGatewayPreflightQuotaFailurePreventsDispatch(t *testing.T) {
	for _, kind := range []string{"repository_dispatch", "workflow_dispatch"} {
		for _, failAt := range []int{1, 2} {
			t.Run(kind+"/"+strconv.Itoa(failAt), func(t *testing.T) {
				posts, observations := 0, 0
				client := gatewayTestClient(t, func(w http.ResponseWriter, r *http.Request) {
					if gatewayAuthorityResponse(w, r) {
						return
					}
					posts++
					w.WriteHeader(http.StatusNoContent)
				})
				dispatcher := WebhookGatewayDispatcher{Client: client,
					ObserveQuota: func(context.Context, int64, githubquota.ResponseQuota) error {
						observations++
						if observations == failAt {
							return errors.New("quota storage unavailable")
						}
						return nil
					}}
				subscription := gatewayTestSubscription(kind)
				response := dispatcher.Dispatch(t.Context(), subscription, gatewayTestEnvelope(subscription, json.RawMessage(`{}`)))
				if posts != 0 || observations != failAt || response.TransportOutcome != "not-sent" || response.StatusCode != 0 {
					t.Fatalf("quota persistence failure allowed dispatch: posts=%d observations=%d response=%+v",
						posts, observations, response)
				}
			})
		}
	}
}
