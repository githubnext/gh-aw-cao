package admission

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type admittedRunFunc func(context.Context, Identity) error

func (f admittedRunFunc) RecordAdmittedRun(ctx context.Context, i Identity) error { return f(ctx, i) }

func TestOnlyApprovedAdmissionsPublishRuns(t *testing.T) {
	fixture := newFixture(t)
	body, err := json.Marshal(fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	token := fixture.token(t, fixture.claims)
	var policyErr, decisionErr, projectionErr error
	writes := 0
	service := &Service{Verifier: fixture.verifier,
		Policies: policyFunc(func(context.Context, Identity) (Allowances, error) { return Allowances{Primary: 1000}, policyErr }),
		Decisions: decisionsFunc(func(_ context.Context, _ string, a *Allowances) (Allowances, error) {
			if decisionErr != nil {
				return Allowances{}, decisionErr
			}
			if a == nil {
				return Allowances{}, ErrDenied
			}
			return *a, nil
		}),
		Runs: admittedRunFunc(func(_ context.Context, i Identity) error {
			writes++
			if i.RepositoryID != "1001" || i.ActorID != "101" || i.RunID != "1234" {
				t.Fatal("unverified publication identity")
			}
			return projectionErr
		}),
	}
	call := func(credential string) int {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "https://admission.example/api/admission", strings.NewReader(string(body)))
		request.Header.Set("Authorization", "Bearer "+credential)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		service.ServeHTTP(response, request)
		return response.Code
	}
	for _, failure := range []error{ErrDenied, ErrUnavailable} {
		policyErr = failure
		if status := call(token); status == 200 || writes != 0 {
			t.Fatal("blocked/outage admission published a run")
		}
	}
	policyErr = nil
	decisionErr = ErrDenied
	if status := call(token); status != 403 || writes != 0 {
		t.Fatal("revoked admission published a run")
	}
	decisionErr = nil
	if status := call("invalid"); status != 403 || writes != 0 {
		t.Fatal("invalid credentials published a run")
	}
	projectionErr = errors.New("synthetic canonical storage outage")
	if status := call(token); status != 503 || writes != 1 {
		t.Fatal("publication failure returned approval")
	}
	projectionErr = nil
	if status := call(token); status != 200 || writes != 2 {
		t.Fatal("publication did not recover on retry")
	}
}
