package server

import (
	"net/http"
)

func (a *App) serverLogs(response http.ResponseWriter, request *http.Request) {
	_, actions := request.Context().Value(githubActionsActorContextKey{}).(string)
	if !actions && !a.adminAuthorized(request) {
		writeError(response, http.StatusForbidden, "administrator access is required")
		return
	}
	response.Header().Set("Content-Type", "application/x-ndjson")
	response.Header().Set("Content-Disposition", `attachment; filename="cao-server-logs.jsonl"`)
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	for _, line := range a.logs.Snapshot() {
		_, _ = response.Write(line)
		_, _ = response.Write([]byte("\n"))
	}
}
