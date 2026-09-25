package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

const (
	projectionLockTTL = 30 * time.Minute
	projectionTimeout = 25 * time.Minute
	deliveryTTL       = 7 * 24 * time.Hour
)

type Reconciler interface {
	Rebuild(context.Context) (ingest.Result, error)
	Reconcile(context.Context, GitHubWebhook) (ingest.Result, error)
}

type GitHubWebhook struct {
	Delivery string
	Event    string
	Payload  json.RawMessage
}

type DirectoryReconciler struct {
	Store               *redisx.Store
	SourceDirectory     string
	DatabaseQueriesPath string
}

func (reconciler DirectoryReconciler) Rebuild(ctx context.Context) (ingest.Result, error) {
	return ingest.Run(ctx, reconciler.Store, reconciler.SourceDirectory, ingest.Options{
		DatabaseQueriesPath: reconciler.DatabaseQueriesPath,
		Force:               true,
	})
}

func (reconciler DirectoryReconciler) Reconcile(ctx context.Context, _ GitHubWebhook) (ingest.Result, error) {
	return reconciler.Rebuild(ctx)
}

type rebuildStatus struct {
	State        string         `json:"state"`
	Required     bool           `json:"required"`
	StartedAt    string         `json:"startedAt,omitempty"`
	CompletedAt  string         `json:"completedAt,omitempty"`
	Generation   string         `json:"generation,omitempty"`
	Revision     int64          `json:"revision,omitempty"`
	DataRevision string         `json:"dataRevision,omitempty"`
	Counts       map[string]int `json:"counts,omitempty"`
}

func (a *App) rebuild(response http.ResponseWriter, request *http.Request) {
	if !a.adminAuthorized(request) {
		writeError(response, http.StatusForbidden, "administrative authorization is required")
		return
	}
	if a.reconciler == nil {
		writeError(response, http.StatusServiceUnavailable, "rebuild is not configured")
		return
	}
	token, err := operationToken()
	if err != nil {
		writeError(response, http.StatusInternalServerError, "rebuild could not start")
		return
	}
	acquired, err := a.store.TryLock(request.Context(), "projection", token, projectionLockTTL)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "rebuild coordination is unavailable")
		return
	}
	if !acquired {
		writeError(response, http.StatusConflict, "a projection update is already running")
		return
	}
	started := time.Now().UTC()
	active, _ := a.store.Active(request.Context())
	status := rebuildStatus{
		State: "running", Required: active.Generation == "",
		StartedAt: started.Format(time.RFC3339Nano),
	}
	if err := a.writeRebuildStatus(request.Context(), status); err != nil {
		a.releaseProjectionLock(request.Context(), token)
		writeError(response, http.StatusServiceUnavailable, "rebuild status is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), projectionTimeout)
	go a.performRebuild(ctx, cancel, token, status)
	writeJSON(response, http.StatusAccepted, status)
}

func (a *App) performRebuild(ctx context.Context, cancel context.CancelFunc, token string, status rebuildStatus) {
	defer cancel()
	defer a.releaseProjectionLock(ctx, token)
	result, err := a.reconciler.Rebuild(ctx)
	if err != nil {
		status.State = "failed"
		status.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		a.persistRebuildStatus(ctx, status)
		serverLog.Printf("rebuild failed")
		return
	}
	status.State = "succeeded"
	status.Required = false
	status.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	status.Generation = result.Generation
	status.Revision = result.Revision
	status.DataRevision = result.DataRevision
	status.Counts = result.Counts
	a.persistRebuildStatus(ctx, status)
	a.hub.Broadcast(result.Revision)
	serverLog.Printf("rebuild completed revision=%d", result.Revision)
}

func (a *App) persistRebuildStatus(parent context.Context, status rebuildStatus) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 3*time.Second)
	defer cancel()
	_ = a.writeRebuildStatus(ctx, status)
}

func (a *App) releaseProjectionLock(parent context.Context, token string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 3*time.Second)
	defer cancel()
	_ = a.store.Unlock(ctx, "projection", token)
}

func (a *App) rebuildStatus(response http.ResponseWriter, request *http.Request) {
	status, err := a.readRebuildStatus(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "rebuild status is unavailable")
		return
	}
	writeJSON(response, http.StatusOK, status)
}

func (a *App) githubWebhook(response http.ResponseWriter, request *http.Request) {
	if a.reconciler == nil || len(a.webhookSecret) == 0 {
		writeError(response, http.StatusServiceUnavailable, "webhook reconciliation is not configured")
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, 10<<20)
	payload, err := io.ReadAll(request.Body)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid webhook payload")
		return
	}
	if !validWebhookSignature(payload, request.Header.Get("X-Hub-Signature-256"), a.webhookSecret) {
		a.logAuthBranch("webhook.signature_rejected")
		writeError(response, http.StatusUnauthorized, "invalid webhook signature")
		return
	}
	a.logAuthBranch("webhook.signature_accepted")
	delivery := strings.TrimSpace(request.Header.Get("X-GitHub-Delivery"))
	event := strings.TrimSpace(request.Header.Get("X-GitHub-Event"))
	if delivery == "" || event == "" {
		writeError(response, http.StatusBadRequest, "GitHub delivery and event headers are required")
		return
	}
	if admitter, ok := a.reconciler.(EventAdmitter); ok {
		a.admitWebhook(response, request, admitter, GitHubWebhook{
			Delivery: delivery,
			Event:    event,
			Payload:  payload,
		})
		return
	}
	token, err := operationToken()
	if err != nil {
		writeError(response, http.StatusInternalServerError, "reconciliation could not start")
		return
	}
	acquired, err := a.store.TryLock(request.Context(), "projection", token, projectionLockTTL)
	if err != nil || !acquired {
		if err != nil {
			writeError(response, http.StatusServiceUnavailable, "reconciliation coordination is unavailable")
		} else {
			writeError(response, http.StatusConflict, "a projection update is already running")
		}
		return
	}
	fresh, err := a.store.RememberDelivery(request.Context(), delivery, deliveryTTL)
	if err != nil {
		a.releaseProjectionLock(request.Context(), token)
		writeError(response, http.StatusServiceUnavailable, "webhook deduplication is unavailable")
		return
	}
	if !fresh {
		a.releaseProjectionLock(request.Context(), token)
		writeJSON(response, http.StatusAccepted, map[string]any{"accepted": true, "duplicate": true})
		return
	}
	eventPayload := GitHubWebhook{
		Delivery: delivery,
		Event:    event,
		Payload:  payload,
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), projectionTimeout)
	go a.performReconciliation(ctx, cancel, token, eventPayload)
	writeJSON(response, http.StatusAccepted, map[string]any{"accepted": true})
}

// EventAdmitter is implemented by a reconciler that admits webhook deliveries
// without taking the global projection lease.
//
// The directory reconciler does not implement it, so the default profile keeps
// its existing lease-per-delivery behavior unchanged.
type EventAdmitter interface {
	Admit(ctx context.Context, event GitHubWebhook) (map[string]any, error)
}

// admitWebhook records the delivery and hands it to the admitting reconciler.
// Admission is bounded work — enrollment bookkeeping or a queue append — so it
// runs inline and reports its outcome instead of spawning a projection.
func (a *App) admitWebhook(
	response http.ResponseWriter,
	request *http.Request,
	admitter EventAdmitter,
	event GitHubWebhook,
) {
	fresh, err := a.store.RememberDelivery(request.Context(), event.Delivery, deliveryTTL)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "webhook deduplication is unavailable")
		return
	}
	if !fresh {
		writeJSON(response, http.StatusAccepted, map[string]any{"accepted": true, "duplicate": true})
		return
	}
	result, err := admitter.Admit(request.Context(), event)
	if err != nil {
		// Forget the delivery so a retry of a transiently failed admission is
		// not silently swallowed as a duplicate.
		a.forgetDelivery(request.Context(), event.Delivery)
		writeError(response, http.StatusServiceUnavailable, "webhook admission is unavailable")
		return
	}
	payload := map[string]any{"accepted": true}
	for key, value := range result {
		payload[key] = value
	}
	writeJSON(response, http.StatusAccepted, payload)
}

func (a *App) forgetDelivery(parent context.Context, delivery string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), 3*time.Second)
	defer cancel()
	_ = a.store.ForgetDelivery(ctx, delivery)
}

func (a *App) performReconciliation(
	ctx context.Context,
	cancel context.CancelFunc,
	token string,
	event GitHubWebhook,
) {
	defer cancel()
	defer a.releaseProjectionLock(ctx, token)
	result, err := a.reconciler.Reconcile(ctx, event)
	if err != nil {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cleanupCancel()
		_ = a.store.ForgetDelivery(cleanupCtx, event.Delivery)
		serverLog.Printf("webhook reconciliation failed")
		return
	}
	a.hub.Broadcast(result.Revision)
	serverLog.Printf("webhook reconciliation completed revision=%d", result.Revision)
}

func validWebhookSignature(payload []byte, signature string, secret []byte) bool {
	const prefix = "sha256="
	if !strings.HasPrefix(signature, prefix) {
		return false
	}
	provided, err := hex.DecodeString(strings.TrimPrefix(signature, prefix))
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(payload)
	return hmac.Equal(provided, mac.Sum(nil))
}

func operationToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func (a *App) writeRebuildStatus(ctx context.Context, status rebuildStatus) error {
	payload, err := json.Marshal(status)
	if err != nil {
		return err
	}
	return a.store.SetOperationalState(ctx, "rebuild", payload)
}

func (a *App) readRebuildStatus(ctx context.Context) (rebuildStatus, error) {
	payload, err := a.store.OperationalState(ctx, "rebuild")
	if err != nil {
		return rebuildStatus{}, err
	}
	if len(payload) > 0 {
		var status rebuildStatus
		if err := json.Unmarshal(payload, &status); err != nil {
			return rebuildStatus{}, err
		}
		if status.State == "running" {
			held, err := a.store.LockHeld(ctx, "projection")
			if err != nil {
				return rebuildStatus{}, err
			}
			if !held {
				active, err := a.store.Active(ctx)
				if err != nil {
					return rebuildStatus{}, err
				}
				status.State = "interrupted"
				status.Required = active.Generation == ""
				status.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
			}
		}
		return status, nil
	}
	active, err := a.store.Active(ctx)
	if err != nil {
		return rebuildStatus{}, err
	}
	return rebuildStatus{State: "idle", Required: active.Generation == ""}, nil
}
