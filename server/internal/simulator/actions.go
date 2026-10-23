package simulator

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Actions models the runner's OIDC exchange and admission/conclusion POSTs.
// Every exchange uses a fresh token; retries are explicit scenario steps.
// Neither this runner nor the broker executes arbitrary workflow shell code.
type Actions struct {
	TokenURL  string
	Bootstrap string
	Audience  string
	Trace     *Trace
}

// Environment supplies the two runner variables consumed by Actions OIDC
// clients. The returned map contains a credential and must not be logged.
func (a Actions) Environment() map[string]string {
	return map[string]string{
		"ACTIONS_ID_TOKEN_REQUEST_URL":   a.TokenURL + "?api-version=2.0",
		"ACTIONS_ID_TOKEN_REQUEST_TOKEN": a.Bootstrap,
	}
}

type ActionResponse struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body,omitempty"`
}

type ActionJob struct {
	AdmissionURL  string
	ConclusionURL string
	Admission     json.RawMessage
	Conclusion    json.RawMessage
	Work          func(context.Context) error
}

// Run gates local work on a valid allowance and still posts conclusion when
// admitted work fails. A rejected gate never runs work or sends a conclusion.
func (a Actions) Run(ctx context.Context, job ActionJob) error {
	response, err := a.Post(ctx, "admission", job.AdmissionURL, job.Admission)
	if err != nil {
		return err
	}
	var decision struct {
		Primary int32 `json:"max_ai_credits"`
	}
	if response.Status != http.StatusOK || json.Unmarshal(response.Body, &decision) != nil || decision.Primary < 1 {
		return errors.New("simulator admission returned an invalid allowance")
	}
	var workErr error
	if job.Work != nil {
		workErr = job.Work(ctx)
	}
	status := http.StatusOK
	if workErr != nil {
		status = http.StatusInternalServerError
	}
	a.Trace.record("actions.job", status)
	_, conclusionErr := a.Post(ctx, "conclusion_admission", job.ConclusionURL, job.Conclusion)
	if workErr != nil {
		// The caller's error can contain arbitrary payloads or credentials.
		workErr = errors.New("simulator action work failed")
	}
	return errors.Join(workErr, conclusionErr)
}

func localClient(endpoint string) (*http.Client, func(), error) {
	transport, err := NewLocalTransport(endpoint)
	if err != nil {
		return nil, nil, err
	}
	return &http.Client{
		Transport: transport, Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}, transport.CloseIdleConnections, nil
}

func (a Actions) token(ctx context.Context) (string, error) {
	client, closeClient, err := localClient(a.TokenURL)
	if err != nil {
		return "", err
	}
	defer closeClient()
	endpoint, err := url.Parse(a.TokenURL)
	if err != nil {
		return "", errors.New("invalid simulator token endpoint")
	}
	query := endpoint.Query()
	query.Set("audience", a.Audience)
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return "", errors.New("create simulator token request")
	}
	request.Header.Set("Authorization", "Bearer "+a.Bootstrap)
	response, err := client.Do(request)
	if err != nil {
		a.Trace.record("actions.token", 0)
		return "", errors.New("simulator token exchange unavailable")
	}
	defer func() { _ = response.Body.Close() }()
	a.Trace.record("actions.token", response.StatusCode)
	var token struct {
		Value string `json:"value"`
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (20<<10)+1))
	if err != nil || len(data) > 20<<10 || response.StatusCode != http.StatusOK ||
		json.Unmarshal(data, &token) != nil || token.Value == "" {
		return "", errors.New("simulator token exchange rejected")
	}
	return token.Value, nil
}

// Post uses the same admission audience for both protocol endpoints. It does
// not interpret an HTTP denial as success or retry a possibly accepted POST.
func (a Actions) Post(ctx context.Context, stage, endpoint string, body json.RawMessage) (ActionResponse, error) {
	if stage != "admission" && stage != "conclusion_admission" {
		return ActionResponse{}, errors.New("unsupported simulator action stage")
	}
	if !json.Valid(body) || len(body) > 64<<10 {
		return ActionResponse{}, errors.New("invalid simulator action request")
	}
	client, closeClient, err := localClient(endpoint)
	if err != nil {
		return ActionResponse{}, err
	}
	defer closeClient()
	token, err := a.token(ctx)
	if err != nil {
		return ActionResponse{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return ActionResponse{}, errors.New("create simulator action request")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cache-Control", "no-store")
	response, err := client.Do(request)
	if err != nil {
		a.Trace.record("actions."+stage, 0)
		return ActionResponse{}, errors.New("simulator action endpoint unavailable")
	}
	defer func() { _ = response.Body.Close() }()
	a.Trace.record("actions."+stage, response.StatusCode)
	data, err := io.ReadAll(io.LimitReader(response.Body, (64<<10)+1))
	result := ActionResponse{Status: response.StatusCode}
	if err != nil || len(data) > 64<<10 {
		return result, errors.New("simulator action response exceeds limit or is unreadable")
	}
	if len(data) > 0 {
		if !json.Valid(data) {
			return result, errors.New("simulator action response is not JSON")
		}
		result.Body = data
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return result, errors.New("simulator action request rejected")
	}
	return result, nil
}

// DeliverWebhook posts a signed synthetic GitHub event to a local gateway.
// Delivery identity is supplied by the scenario so replays remain explicit.
func (a Actions) DeliverWebhook(ctx context.Context, endpoint, secret string, delivery Delivery) (int, error) {
	if len(delivery.Payload) > 1<<20 || !json.Valid(delivery.Payload) {
		return 0, errors.New("invalid simulator webhook payload")
	}
	request, err := SignedRequest(ctx, endpoint, secret, delivery)
	if err != nil {
		return 0, errors.New("create simulator webhook request")
	}
	return deliverLocalWebhook(request, a.Trace, "actions.webhook")
}

func deliverLocalWebhook(request *http.Request, trace *Trace, stage string) (int, error) {
	client, closeClient, err := localClient(request.URL.String())
	if err != nil {
		return 0, err
	}
	defer closeClient()
	response, err := client.Do(request)
	if err != nil {
		trace.record(stage, 0)
		return 0, errors.New("simulator webhook endpoint unavailable")
	}
	defer func() { _ = response.Body.Close() }()
	trace.record(stage, response.StatusCode)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, errors.New("simulator webhook rejected")
	}
	return response.StatusCode, nil
}
