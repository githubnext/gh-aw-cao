package webhookgateway

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ClassifyDispatchResponse distinguishes known nonacceptance from possible acceptance.
// GitHub dispatch APIs have no idempotency key: server errors are not proof of nonacceptance.
func ClassifyDispatchResponse(now time.Time, response DispatchResponse) (DispatchResult, error) {
	if now.IsZero() || (response.Kind != "workflow_dispatch" && response.Kind != "repository_dispatch") {
		return DispatchResult{}, ErrInvalid
	}
	if response.TransportOutcome == "not-sent" {
		if response.StatusCode != 0 {
			return DispatchResult{}, ErrInvalid
		}
		return DispatchResult{Outcome: "retry", Reason: "not-sent", RetryAt: now}, nil
	}
	if response.TransportOutcome == "unknown" {
		return DispatchResult{Outcome: "ambiguous", Reason: "transport-completion-unknown"}, nil
	}
	if response.TransportOutcome != "response" || response.StatusCode < 100 || response.StatusCode > 599 {
		return DispatchResult{}, ErrInvalid
	}
	if response.StatusCode == http.StatusNoContent ||
		(response.Kind == "workflow_dispatch" && response.StatusCode == http.StatusOK) {
		result := DispatchResult{Outcome: "succeeded", Reason: "dispatch-accepted", AcceptedStatus: response.StatusCode}
		if response.Kind == "workflow_dispatch" && response.StatusCode == http.StatusOK {
			if response.WorkflowRunID > 0 {
				result.WorkflowRunID = response.WorkflowRunID
			} else if value, err := boundedJSON(response.Body, 16384, DefaultLimits()); err == nil {
				if object, ok := value.(map[string]any); ok {
					if number, ok := object["workflow_run_id"].(json.Number); ok {
						if id, err := strconv.ParseInt(string(number), 10, 64); err == nil && id > 0 {
							result.WorkflowRunID = id
						}
					}
				}
			}
		}
		if !acceptedObservation(response.Kind, result.AcceptedStatus, result.WorkflowRunID) {
			return DispatchResult{Outcome: "ambiguous", Reason: "acceptance-details-unavailable"}, nil
		}
		return result, nil
	}
	if response.StatusCode >= 500 || response.StatusCode == http.StatusRequestTimeout ||
		(response.StatusCode >= 200 && response.StatusCode < 400) {
		return DispatchResult{Outcome: "ambiguous", Reason: "dispatch-completion-unknown"}, nil
	}
	message := ""
	if len(response.Body) <= 16384 {
		limits := DefaultLimits()
		limits.MaxJSONDepth, limits.MaxJSONNodes, limits.MaxStringBytes = 8, 1024, 4096
		if value, err := boundedJSON(response.Body, 16384, limits); err == nil {
			if object, ok := value.(map[string]any); ok {
				message, _ = object["message"].(string)
			}
		}
	}
	message = strings.ToLower(strings.TrimSpace(message))
	rateLimited := response.StatusCode == http.StatusTooManyRequests ||
		(response.StatusCode == http.StatusForbidden &&
			(response.RateLimitRemaining == "0" ||
				strings.HasPrefix(message, "api rate limit exceeded") ||
				strings.HasPrefix(message, "you have exceeded a secondary rate limit") ||
				strings.HasPrefix(message, "you have triggered an abuse detection mechanism")))
	if rateLimited {
		retry := now.Add(time.Minute)
		if seconds, err := strconv.ParseInt(response.RetryAfter, 10, 64); err == nil && seconds >= 0 {
			if seconds > 7*24*3600 {
				seconds = 7 * 24 * 3600
			}
			retry = now.Add(time.Duration(seconds) * time.Second)
		} else if date, err := http.ParseTime(response.RetryAfter); err == nil && date.After(now) {
			retry = date
		} else if response.RateLimitRemaining == "0" {
			if reset, err := strconv.ParseInt(response.RateLimitReset, 10, 64); err == nil {
				date := time.Unix(reset, 0)
				if date.After(now) {
					retry = date
				}
			}
		}
		if retry.After(now.Add(7 * 24 * time.Hour)) {
			retry = now.Add(7 * 24 * time.Hour)
		}
		return DispatchResult{Outcome: "retry", Reason: "rate-limited", RetryAt: retry}, nil
	}
	if response.StatusCode == http.StatusNotFound {
		return DispatchResult{Outcome: "rejected", Reason: "permission-or-not-found"}, nil
	}
	if response.StatusCode == http.StatusUnprocessableEntity &&
		message == "workflow does not have 'workflow_dispatch' trigger" {
		return DispatchResult{Outcome: "rejected", Reason: "dispatch-trigger-missing"}, nil
	}
	if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusGone ||
		response.StatusCode == http.StatusUnprocessableEntity {
		switch message {
		case "workflow is disabled", "workflow has been disabled", "workflow has been deleted":
			return DispatchResult{Outcome: "rejected", Reason: "workflow-unavailable"}, nil
		}
	}
	if response.StatusCode >= 400 && response.StatusCode < 500 {
		return DispatchResult{Outcome: "rejected", Reason: "dispatch-rejected"}, nil
	}
	return DispatchResult{Outcome: "ambiguous", Reason: "dispatch-completion-unknown"}, nil
}
