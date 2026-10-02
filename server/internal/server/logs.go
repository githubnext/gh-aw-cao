package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type serverLogRedis struct {
	Status       string           `json:"status"`
	Counters     map[string]int64 `json:"counters,omitempty"`
	QueueDepth   *int64           `json:"queueDepth,omitempty"`
	PendingTasks *int64           `json:"pendingTasks,omitempty"`
	DeadLetters  *int64           `json:"deadLetters,omitempty"`
}

type serverLogSnapshot struct {
	Logs  []json.RawMessage `json:"logs"`
	Redis serverLogRedis    `json:"redis"`
}

func (a *App) serverLogRedis(ctx context.Context) serverLogRedis {
	if a.store == nil {
		return serverLogRedis{Status: "not-configured"}
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	counters, _, err := a.store.IngestionHealth(ctx)
	if err != nil {
		return serverLogRedis{Status: "unavailable"}
	}
	result := serverLogRedis{Status: "ok", Counters: counters}
	if collector := a.Collector(); collector != nil {
		queue := collector.reporter.Queue
		depth, err := queue.Depth(ctx)
		if err != nil {
			return serverLogRedis{Status: "unavailable"}
		}
		pending, err := queue.Pending(ctx)
		if err != nil {
			return serverLogRedis{Status: "unavailable"}
		}
		dead, err := queue.DeadLetters(ctx)
		if err != nil {
			return serverLogRedis{Status: "unavailable"}
		}
		result.QueueDepth, result.PendingTasks, result.DeadLetters = &depth, &pending, &dead
	}
	return result
}

func (a *App) serverLogs(response http.ResponseWriter, request *http.Request) {
	_, actions := request.Context().Value(githubActionsActorContextKey{}).(string)
	if !actions && !a.adminAuthorized(request) {
		writeError(response, http.StatusForbidden, "administrator access is required")
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Content-Disposition", `attachment; filename="cao-server-logs.json"`)
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	_ = json.NewEncoder(response).Encode(serverLogSnapshot{
		Logs: a.logs.Snapshot(), Redis: a.serverLogRedis(request.Context()),
	})
}
