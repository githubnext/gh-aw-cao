package webhookgatewayhost

import (
	"fmt"
	"net/http"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

var ErrAPIBudget = fmt.Errorf("gateway API request budget is unavailable: %w", gateway.ErrRequestNotSent)

// BudgetTransport reuses deployment-scoped operational request admission for
// every App/JWT, installation-token, authorization and dispatch HTTP request.
type BudgetTransport struct {
	Limiter operational.RequestLimiter
	Next    http.RoundTripper
}

func (t BudgetTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if t.Limiter == nil {
		return nil, ErrAPIBudget
	}
	admission, err := t.Limiter.TakeRateLimitToken(request.Context(), "webhook-gateway:api", 300, time.Minute)
	if err != nil || !admission.Allowed {
		return nil, ErrAPIBudget
	}
	next := t.Next
	if next == nil {
		next = http.DefaultTransport
	}
	return next.RoundTrip(request)
}
