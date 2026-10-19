package webhookgateway

import (
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"sync"
	"time"

	"go.opentelemetry.io/otel/propagation"
)

// Ingress is mounted on a route with a trusted SourceID by the server.
type Ingress struct {
	SourceID   string
	Secrets    SecretProvider
	Policies   PolicyProvider
	Queue      Queue
	Authorizer Authorizer
	Limits     Limits
	Discovery  DiscoveryObserver
	External   bool

	mu       sync.Mutex
	revision QueueRevision
	index    map[ingressIndexKey][]Subscription
}

type ingressIndexKey struct{ source, event, action string }

func indexedAction(filter *Filter) string {
	if filter == nil {
		return ""
	}
	if filter.Op == "eq" && filter.Path == "/action" {
		var action string
		if json.Unmarshal(filter.Value, &action) == nil {
			return action
		}
	}
	if filter.Op == "and" {
		for i := range filter.Args {
			if action := indexedAction(&filter.Args[i]); action != "" {
				return action
			}
		}
	}
	return ""
}

func (h *Ingress) candidates(snapshot PolicySnapshot, event Event) []Subscription {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.index == nil || h.revision != snapshot.Revision {
		h.index = make(map[ingressIndexKey][]Subscription)
		for _, subscription := range snapshot.Subscriptions {
			key := ingressIndexKey{subscription.Source.ID, subscription.Source.Event, indexedAction(subscription.Filter)}
			h.index[key] = append(h.index[key], subscription)
		}
		h.revision = snapshot.Revision
	}
	key := ingressIndexKey{event.SourceID, event.Name, ""}
	result := append([]Subscription(nil), h.index[key]...)
	if event.Action != "" {
		key.action = event.Action
		result = append(result, h.index[key]...)
	}
	return result
}

func (h *Ingress) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, end := gatewayStage(r.Context(), "ingress", r.Header.Get("X-GitHub-Event"))
	outcome := "invalid"
	var event Event
	defer func() { end(outcome) }()
	respond := func(status int, classification string) {
		outcome = classification
		if h.External && event.Name == "linear_issue" && status >= 200 && status < 300 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		respond(http.StatusMethodNotAllowed, "invalid")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		respond(http.StatusUnsupportedMediaType, "invalid")
		return
	}
	if h.SourceID == "" || h.Secrets == nil || h.Policies == nil || h.Queue == nil || h.Authorizer == nil {
		respond(http.StatusServiceUnavailable, "unavailable")
		return
	}
	readBody := readWebhook
	if h.External {
		readBody = readWebhookBody
	}
	body, err := readBody(w, r)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			respond(http.StatusRequestEntityTooLarge, "invalid")
		} else {
			respond(http.StatusBadRequest, "invalid")
		}
		return
	}
	var authenticatedPolicy PolicySnapshot
	var externalSource ExternalSource
	if h.External {
		authenticatedPolicy, err = h.Policies.Load(ctx)
		if err != nil {
			respond(http.StatusServiceUnavailable, "unavailable")
			return
		}
		var enrolled bool
		externalSource, enrolled = authenticatedPolicy.ExternalSource(h.SourceID)
		if !enrolled {
			respond(http.StatusForbidden, "auth_denied")
			return
		}
	}
	current, previous, err := h.Secrets.WebhookSecrets(ctx, h.SourceID)
	if err != nil {
		respond(http.StatusServiceUnavailable, "unavailable")
		return
	}
	_, signatureEnd := gatewayStage(ctx, "signature", r.Header.Get("X-GitHub-Event"))
	signatureOK := validSignature(body, r.Header.Get("X-Hub-Signature-256"), current, previous)
	if h.External {
		event, err = AuthenticateExternal(externalSource, r, body, current, previous, time.Now(), h.Limits)
		signatureOK = err == nil
	}
	if !signatureOK {
		signatureEnd("auth_denied")
		respond(http.StatusUnauthorized, "auth_denied")
		return
	}
	signatureEnd("authenticated")
	if !h.External {
		event, err = ParseEvent(r.Header.Get("X-GitHub-Delivery"), r.Header.Get("X-GitHub-Event"), body, h.Limits)
	}
	if err != nil {
		respond(http.StatusBadRequest, "invalid")
		return
	}
	event.SourceID = h.SourceID
	traceGatewayIdentity(ctx, event.DeliveryID, "")
	if h.Discovery != nil {
		handled, err := h.Discovery.Observe(ctx, event)
		if handled {
			switch {
			case errors.Is(err, ErrUnauthorized):
				respond(http.StatusForbidden, "auth_denied")
			case err != nil:
				respond(http.StatusServiceUnavailable, "unavailable")
			default:
				respond(http.StatusAccepted, "discovery")
			}
			return
		}
		if err != nil {
			respond(http.StatusServiceUnavailable, "unavailable")
			return
		}
	}
	snapshot, err := h.Policies.Load(ctx)
	if err != nil || h.External && snapshot.Revision != authenticatedPolicy.Revision {
		respond(http.StatusServiceUnavailable, "unavailable")
		return
	}
	if err := h.Queue.ApplyRevision(ctx, snapshot.Revision); err != nil || !snapshot.Revision.Enabled {
		respond(http.StatusServiceUnavailable, "disabled")
		return
	}
	matches := make([]Subscription, 0)
	_, matchEnd := gatewayStage(ctx, "matching", event.Name)
	for _, subscription := range h.candidates(snapshot, event) {
		matched, err := MatchSubscription(subscription, event, h.Limits)
		if err != nil {
			matchEnd("invalid")
			respond(http.StatusServiceUnavailable, "invalid")
			return
		}
		if matched {
			matches = append(matches, subscription)
		}
	}
	if len(matches) == 0 {
		matchEnd("filtered")
		respond(http.StatusNoContent, "filtered")
		return
	}
	matchEnd("matched")
	now := time.Now()
	traceCarrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, traceCarrier)
	traceParent := traceCarrier.Get("traceparent")
	jobs := make([]Job, 0, len(matches))
	for _, subscription := range matches {
		revision, ok := snapshot.Revisions[subscription.ID]
		if !ok {
			respond(http.StatusServiceUnavailable, "unavailable")
			return
		}
		payload, err := buildGatewayDispatchPayload(subscription, event, revision, h.Limits)
		if err != nil {
			respond(http.StatusBadRequest, "invalid")
			return
		}
		identity, err := subscriptionIdentity(subscription, event)
		if err != nil {
			respond(http.StatusBadRequest, "invalid")
			return
		}
		job := Job{
			ID:         MetadataDigest([]byte(event.SourceID + "\x00" + event.DeliveryID + "\x00" + subscription.ID)),
			DeliveryID: event.DeliveryID, Subscription: subscription, SubscriptionDigest: revision.Digest,
			Event: identity, Payload: payload, QueueRevision: snapshot.Revision, State: Ready, Version: 1,
			TraceParent: traceParent,
			CreatedAt:   now, ExpiresAt: now.Add(time.Duration(subscription.Delivery.TTLSeconds) * time.Second), NotBefore: now,
		}
		if _, err := BuildDispatchBatch([]Job{job}); err != nil {
			respond(http.StatusBadRequest, "invalid")
			return
		}
		authCtx, authEnd := gatewayStage(ctx, "admission_authorization", event.Name)
		authorization, err := h.Authorizer.Authorize(authCtx, job)
		if err != nil || !authorization.Complete {
			authEnd("deferred")
			respond(http.StatusServiceUnavailable, "auth_deferred")
			return
		}
		decision, err := ValidateAuthorization(time.Now(), job, authorization)
		if err != nil || !decision.Allowed {
			if !decision.Cancel {
				authEnd("deferred")
				respond(http.StatusServiceUnavailable, "auth_deferred")
				return
			}
			authEnd("auth_denied")
			respond(http.StatusForbidden, "auth_denied")
			return
		}
		authEnd("authorized")
		jobs = append(jobs, job)
	}
	admitCtx, admitEnd := gatewayStage(ctx, "admission", event.Name)
	_, err = h.Queue.AdmitBatch(admitCtx, Admission{
		Revision: snapshot.Revision, DeliveryID: event.DeliveryID,
		DeliveryDigest: MetadataDigest(body), Jobs: jobs,
	})
	if err != nil {
		classification := "unavailable"
		if errors.Is(err, ErrCapacity) {
			classification = "capacity"
		}
		admitEnd(classification)
		respond(http.StatusServiceUnavailable, classification)
		return
	}
	admitEnd("accepted")
	// The only accepted response is after the queue's atomic commit.
	respond(http.StatusAccepted, "accepted")
}
