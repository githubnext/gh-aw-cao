package webhookgatewaylocal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/githubnext/gh-cao/server/internal/simulator"
	wg "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

var eventTypes = map[string]string{
	"IssuesEvent": "issues", "IssueCommentEvent": "issue_comment", "PullRequestEvent": "pull_request",
	"PullRequestReviewEvent": "pull_request_review", "PullRequestReviewCommentEvent": "pull_request_review_comment",
	"PushEvent": "push", "CreateEvent": "create", "DeleteEvent": "delete",
	"ReleaseEvent": "release", "ForkEvent": "fork", "WatchEvent": "watch",
}

func supportedEvent(name string) bool {
	for _, event := range eventTypes {
		if event == name {
			return true
		}
	}
	return false
}

type pollEvent struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
	Repo    struct {
		ID int64 `json:"id"`
	} `json:"repo"`
}

type ReceiptReader interface {
	HasDelivery(context.Context, string) (bool, error)
}

type Poller struct {
	Client     *Client
	Repository Repository
	Simulation *Simulation
	Handler    http.Handler
	Receipts   ReceiptReader
	Interval   time.Duration
	etag       string
	minimum    time.Duration
}

type PollResult struct {
	Seen, Delivered, Replayed, Ignored int
	Unchanged                          bool
}

// Poll reads at most GitHub's bounded three-page repository feed. Only a fully
// admitted snapshot advances its ETag. Retained receipts recognize already
// admitted event IDs even when GitHub changes their feed payloads.
func (p *Poller) Poll(ctx context.Context) (PollResult, error) {
	var result PollResult
	if p.Client == nil || p.Simulation == nil || p.Handler == nil || p.Receipts == nil {
		return result, wg.ErrInvalid
	}
	current, err := p.Client.Repository(ctx)
	if err != nil {
		return result, err
	}
	if current.ID != p.Repository.ID || current.Owner != p.Repository.Owner {
		return result, errors.New("local GitHub repository identity changed")
	}
	events := make([]pollEvent, 0, 300)
	etag := ""
	for page := 1; page <= 3; page++ {
		var batch []pollEvent
		condition := ""
		if page == 1 {
			condition = p.etag
		}
		headers, unchanged, err := p.Client.get(ctx, "/events?per_page=100&page="+strconv.Itoa(page), condition, &batch, 8<<20)
		if err != nil {
			return result, err
		}
		if page == 1 {
			if seconds, err := strconv.Atoi(headers.Get("X-Poll-Interval")); err == nil && seconds > 0 && seconds <= 86400 {
				p.minimum = time.Duration(seconds) * time.Second
			}
			etag = headers.Get("ETag")
		}
		if unchanged {
			result.Unchanged = true
			return result, nil
		}
		if batch == nil || len(batch) > 100 {
			return result, errors.New("local GitHub feed is invalid or exceeds page bounds")
		}
		events = append(events, batch...)
		if len(batch) < 100 {
			break
		}
	}
	for i := len(events) - 1; i >= 0; i-- {
		event := events[i]
		result.Seen++
		name, ok := eventTypes[event.Type]
		if !ok || !p.subscribed(name) {
			result.Ignored++
			continue
		}
		if event.ID == "" || len(event.ID) > 128 || event.Repo.ID != p.Repository.ID || event.Payload == nil {
			return result, errors.New("local GitHub event identity is invalid")
		}
		identity, err := json.Marshal([]string{p.Client.base, strconv.FormatInt(p.Repository.ID, 10), event.ID})
		if err != nil {
			return result, err
		}
		deliveryID := "simulation-" + wg.MetadataDigest(identity)
		known, err := p.Receipts.HasDelivery(ctx, deliveryID)
		if err != nil {
			return result, errors.New("local delivery receipt lookup failed; polling progress retained")
		}
		if known {
			result.Replayed++
			continue
		}
		payload := event.Payload
		payload["repository"] = map[string]any{"id": p.Repository.ID}
		payload["installation"] = map[string]any{"id": 1}
		if p.Repository.Owner.Type == "Organization" {
			payload["organization"] = map[string]any{"id": p.Repository.Owner.ID}
		}
		body, err := json.Marshal(payload)
		if err != nil || len(body) > wg.DefaultLimits().MaxEventBytes {
			return result, errors.New("local simulated event exceeds ingress bounds")
		}
		request, err := simulator.SignedRequest(ctx, "http://127.0.0.1/webhooks/local", p.Simulation.secret,
			simulator.Delivery{ID: deliveryID, Event: name, Payload: body})
		if err != nil {
			return result, err
		}
		response := &deliveryResponse{header: make(http.Header)}
		p.Handler.ServeHTTP(response, request)
		if response.status != http.StatusAccepted && response.status != http.StatusNoContent {
			return result, errors.New("local simulated delivery was not admitted; polling progress retained")
		}
		result.Delivered++
	}
	p.etag = etag
	return result, nil
}

func (p *Poller) subscribed(name string) bool {
	for _, sub := range p.Simulation.snapshot.Subscriptions {
		if sub.Source.Event == name {
			return true
		}
	}
	return false
}

// Run stops on infrastructure failures; restart safely replays the feed through
// the durable deduplication boundary. No error or failed admission is skipped.
func (p *Poller) Run(ctx context.Context) error {
	if p.Interval < time.Second {
		return wg.ErrInvalid
	}
	for {
		if _, err := p.Poll(ctx); err != nil {
			return err
		}
		timer := time.NewTimer(max(p.Interval, p.minimum))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

type deliveryResponse struct {
	header http.Header
	status int
}

func (w *deliveryResponse) Header() http.Header { return w.header }
func (w *deliveryResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *deliveryResponse) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return len(data), nil
}
