package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"time"
)

var localCommandPath = regexp.MustCompile(`^/__cli_commands/([a-zA-Z0-9-]+)(?:/(output|cancel|retry))?$`)

func (s *LocalServer) commands(w http.ResponseWriter, r *http.Request) {
	if !s.config.Queue {
		http.NotFound(w, r)
		return
	}
	legacy := r.URL.Path == "/__cli_action"
	var operation string
	status := http.StatusOK
	payload := map[string]any{}
	if legacy || r.URL.Path == "/__cli_commands" {
		switch {
		case r.Method == http.MethodPost:
			operation, status = "queue.enqueue", http.StatusAccepted
		case r.Method == http.MethodGet && !legacy:
			operation = "queue.list"
			limit, err := localInteger(r.URL.Query().Get("limit"), 50, 300)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			offset, err := localInteger(r.URL.Query().Get("offset"), 0, 1000000)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			payload["limit"], payload["offset"], payload["status"] = limit, offset, r.URL.Query().Get("status")
		default:
			allow := "GET, POST"
			if legacy {
				allow = "POST"
			}
			w.Header().Set("Allow", allow)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
	} else {
		match := localCommandPath.FindStringSubmatch(r.URL.Path)
		if match == nil {
			writeError(w, http.StatusNotFound, "CLI command was not found.")
			return
		}
		payload["id"] = match[1]
		switch {
		case r.Method == http.MethodGet && match[2] == "":
			operation = "queue.detail"
		case r.Method == http.MethodGet && match[2] == "output":
			after, err := localInteger(r.URL.Query().Get("after"), 0, 1<<53-1)
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			s.streamCommand(w, r, match[1], after)
			return
		case r.Method == http.MethodPost && (match[2] == "cancel" || match[2] == "retry"):
			operation = "queue." + match[2]
			if match[2] == "retry" {
				status = http.StatusAccepted
			}
		default:
			allow := "GET"
			if match[2] == "cancel" || match[2] == "retry" {
				allow = "POST"
			}
			w.Header().Set("Allow", allow)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
	}
	if r.Method == http.MethodPost {
		body, ok := localJSON(w, r, 1<<20)
		if !ok {
			return
		}
		payload["body"] = body
		if key := r.Header.Get("Idempotency-Key"); key != "" {
			payload["idempotencyKey"] = key
		}
	}
	var result json.RawMessage
	if !s.call(w, r, operation, payload, &result) {
		return
	}
	if legacy {
		var command struct {
			ID json.Number `json:"id"`
		}
		if json.Unmarshal(result, &command) != nil || command.ID == "" {
			writeError(w, http.StatusBadGateway, "Invalid CLI command response.")
			return
		}
		s.streamCommand(w, r, command.ID.String(), 0)
		return
	}
	writeJSON(w, status, result)
}

func (s *LocalServer) streamCommand(w http.ResponseWriter, r *http.Request, id string, after int) {
	var command map[string]any
	if !s.call(w, r, "queue.detail", map[string]any{"id": id}, &command) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	encoder := json.NewEncoder(w)
	streamError := func(message string) {
		if r.Context().Err() == nil {
			serverLog.Printf("local command stream unavailable")
			_ = encoder.Encode(map[string]any{"type": "error", "error": message})
			flusher.Flush()
		}
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	terminal := func(status any) bool {
		return status == "completed" || status == "failed" || status == "canceled" || status == "timed-out"
	}
	lastStatus := ""
	for {
		if status, ok := command["status"].(string); ok && status != lastStatus {
			if err := encoder.Encode(map[string]any{"type": "status", "command": map[string]any{
				"id": command["id"], "status": status,
			}}); err != nil {
				return
			}
			lastStatus = status
		}
		var chunks []map[string]any
		if err := s.bridge.Call(r.Context(), "queue.output", map[string]any{"id": id, "after": after, "limit": 128}, &chunks); err != nil {
			streamError("Command output is unavailable.")
			return
		}
		for _, chunk := range chunks {
			chunk["type"] = "output"
			if err := encoder.Encode(chunk); err != nil {
				return
			}
			if sequence, ok := chunk["sequence"].(float64); ok {
				after = int(sequence)
			}
		}
		flusher.Flush()
		if len(chunks) == 128 {
			continue
		}
		if err := s.bridge.Call(r.Context(), "queue.detail", map[string]any{"id": id}, &command); err != nil {
			streamError("Command state is unavailable.")
			return
		}
		if terminal(command["status"]) {
			var remaining []map[string]any
			if err := s.bridge.Call(r.Context(), "queue.output", map[string]any{"id": id, "after": after, "limit": 1}, &remaining); err != nil {
				streamError("Final command output is unavailable.")
				return
			}
			if len(remaining) > 0 {
				continue
			}
			result := map[string]any{"ok": command["status"] == "completed", "exitCode": command["exitCode"]}
			if command["error"] != nil {
				result["error"] = command["error"]
			}
			if extra, ok := command["result"].(map[string]any); ok && extra["pullRequestUrl"] != nil {
				result["pullRequestUrl"] = extra["pullRequestUrl"]
			}
			if err := encoder.Encode(map[string]any{"type": "complete", "command": command, "result": result}); err != nil {
				return
			}
			flusher.Flush()
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}
