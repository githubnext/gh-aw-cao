package simulator

import (
	"net/http"
	"time"
)

// ActionsAPI composes the mini GitHub REST API and runner OIDC broker on one
// local listener. Existing REST-only simulator callers remain unchanged.
type ActionsAPI struct {
	GitHub *API
	OIDC   *OIDCBroker
}

func NewActionsAPI(scenario Scenario, timeScale float64, now func() time.Time, trace *Trace) (*ActionsAPI, error) {
	api, err := NewAPIHandler(scenario, timeScale)
	if err != nil {
		return nil, err
	}
	broker, err := NewOIDCBroker(now, trace)
	if err != nil {
		return nil, err
	}
	return &ActionsAPI{GitHub: api, OIDC: broker}, nil
}

func (a *ActionsAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/token", "/.well-known/jwks":
		a.OIDC.ServeHTTP(w, r)
	default:
		a.GitHub.ServeHTTP(w, r)
	}
}
