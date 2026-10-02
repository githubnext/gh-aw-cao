package server

import (
	"encoding/json"
	"net/http"
)

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
	_ = json.NewEncoder(response).Encode(a.logs.Snapshot())
}
