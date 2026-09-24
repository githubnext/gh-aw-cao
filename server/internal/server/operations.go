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
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), 3*time.Second)
		defer cancel()
		_ = a.store.Unlock(unlockCtx, "projection", token)
	}()
	started := time.Now().UTC()
	status := rebuildStatus{State: "running", Required: true, StartedAt: started.Format(time.RFC3339Nano)}
	_ = a.writeRebuildStatus(request.Context(), status)
	result, err := a.reconciler.Rebuild(request.Context())
	if err != nil {
		status.State = "failed"
		status.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		_ = a.writeRebuildStatus(context.WithoutCancel(request.Context()), status)
		writeError(response, http.StatusInternalServerError, "rebuild failed")
		return
	}
	status.State = "succeeded"
	status.Required = false
	status.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	status.Generation = result.Generation
	status.Revision = result.Revision
	status.DataRevision = result.DataRevision
	status.Counts = result.Counts
	if err := a.writeRebuildStatus(request.Context(), status); err != nil {
		writeError(response, http.StatusServiceUnavailable, "rebuild completed but status could not be recorded")
		return
	}
	a.hub.Broadcast(result.Revision)
	writeJSON(response, http.StatusOK, status)
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
		writeError(response, http.StatusUnauthorized, "invalid webhook signature")
		return
	}
	delivery := strings.TrimSpace(request.Header.Get("X-GitHub-Delivery"))
	event := strings.TrimSpace(request.Header.Get("X-GitHub-Event"))
	if delivery == "" || event == "" {
		writeError(response, http.StatusBadRequest, "GitHub delivery and event headers are required")
		return
	}
	fresh, err := a.store.RememberDelivery(request.Context(), delivery, deliveryTTL)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "webhook deduplication is unavailable")
		return
	}
	if !fresh {
		writeJSON(response, http.StatusAccepted, map[string]any{"accepted": true, "duplicate": true})
		return
	}
	token, err := operationToken()
	if err != nil {
		_ = a.store.ForgetDelivery(request.Context(), delivery)
		writeError(response, http.StatusInternalServerError, "reconciliation could not start")
		return
	}
	acquired, err := a.store.TryLock(request.Context(), "projection", token, projectionLockTTL)
	if err != nil || !acquired {
		_ = a.store.ForgetDelivery(request.Context(), delivery)
		if err != nil {
			writeError(response, http.StatusServiceUnavailable, "reconciliation coordination is unavailable")
		} else {
			writeError(response, http.StatusConflict, "a projection update is already running")
		}
		return
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), 3*time.Second)
		defer cancel()
		_ = a.store.Unlock(unlockCtx, "projection", token)
	}()
	result, err := a.reconciler.Reconcile(request.Context(), GitHubWebhook{
		Delivery: delivery,
		Event:    event,
		Payload:  payload,
	})
	if err != nil {
		_ = a.store.ForgetDelivery(context.WithoutCancel(request.Context()), delivery)
		writeError(response, http.StatusInternalServerError, "reconciliation failed")
		return
	}
	a.hub.Broadcast(result.Revision)
	writeJSON(response, http.StatusAccepted, map[string]any{"accepted": true, "revision": result.Revision})
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
		return status, nil
	}
	active, err := a.store.Active(ctx)
	if err != nil {
		return rebuildStatus{}, err
	}
	return rebuildStatus{State: "idle", Required: active.Generation == ""}, nil
}
