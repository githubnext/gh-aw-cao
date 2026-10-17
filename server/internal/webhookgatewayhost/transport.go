package webhookgatewayhost

import (
	"errors"
	"net/http"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

var ErrAPIBudget = errors.New("gateway API request budget is unavailable")

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
