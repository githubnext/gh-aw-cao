// Package localops owns the native, workspace-scoped preview operations.
package localops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Error struct {
	Status  int    `json:"status"`
	Message string `json:"message"`
}

func (e *Error) Error() string                 { return e.Message }
func (e *Error) HTTPStatus() int               { return e.Status }
func (e *Error) StatusCode() int               { return e.Status }
func (e *Error) PublicMessage() string         { return e.Message }
func failure(status int, message string) error { return &Error{status, message} }

type Invocation struct {
	ActionID  string            `json:"actionId"`
	Command   string            `json:"command"`
	Arguments map[string]bool   `json:"arguments"`
	Values    map[string]string `json:"values"`
	Input     *string           `json:"input,omitempty"`
}

type Options struct {
	Workspace, SourceDirectory, GHExecutable, QueuePath string
	CaoURL, Repository                                  string
	// OperatorExecutable overrides native gh cao dispatch, never a repository script.
	OperatorExecutable  string
	Admin, Canvas       bool
	Dashboard           func() map[string]any
	TemplateContext     func() map[string]string
	SaveDashboard       func(document []byte) (any, error)
	Approve             func(context.Context, Invocation) (bool, error)
	Author              func(context.Context, string, map[string]any) (any, error)
	NewAuthoringClient  func(AuthoringClientOptions) AuthoringClient
	AuthoringResources  map[string]string
	DisableAuthoring    bool
	OnQueueChanged      func()
	Log                 func(string, map[string]any)
	MaxConcurrency      int
	Timeout             time.Duration
	AcknowledgeRecovery bool
	onCredential        func(string)
	compilerHTTPClient  *http.Client
}

type Service struct {
	options                      Options
	queue                        *queue
	github                       *githubService
	mu                           sync.Mutex
	approval, generation, saving bool
	closed                       atomic.Bool
	urlMu                        sync.Mutex
	urlRepository, urlValue      string
	urlChecked                   time.Time
}

func New(options Options) (*Service, error) {
	if options.Workspace == "" {
		return nil, errors.New("workspace is required")
	}
	workspace, err := filepath.Abs(options.Workspace)
	if err != nil {
		return nil, err
	}
	options.Workspace = workspace
	if options.CaoURL == "" {
		options.CaoURL = os.Getenv("CAO_DASHBOARD_URL")
	}
	if options.CaoURL != "" {
		options.CaoURL, err = validateDashboardURL(options.CaoURL)
		if err != nil {
			return nil, err
		}
	}
	if options.GHExecutable == "" {
		options.GHExecutable = "gh"
	}
	if options.OperatorExecutable == "" {
		executable, err := os.Executable()
		if err != nil {
			return nil, err
		}
		if name := strings.TrimSuffix(strings.ToLower(filepath.Base(executable)), ".exe"); name == "gh-cao" {
			options.OperatorExecutable = executable
		}
	}
	if options.QueuePath == "" {
		options.QueuePath = filepath.Join(workspace, ".cao", "cli-actions.sqlite")
	}
	options.QueuePath, err = filepath.Abs(options.QueuePath)
	if err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(workspace, options.QueuePath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return nil, errors.New("CLI queue database must remain within the workspace")
	}
	if options.MaxConcurrency == 0 {
		options.MaxConcurrency = 4
	}
	if options.Timeout == 0 {
		options.Timeout = 15 * time.Minute
	}
	if options.MaxConcurrency < 1 || options.MaxConcurrency > 32 || options.Timeout < time.Millisecond || options.Timeout > 15*time.Minute {
		return nil, errors.New("invalid queue execution limits")
	}
	s := &Service{options: options}
	if options.Admin || options.Canvas {
		s.queue, err = newQueue(options)
		if err != nil {
			return nil, err
		}
	}
	s.github, err = newGitHubService(options)
	if err != nil {
		if s.queue != nil {
			_ = s.queue.close()
		}
		return nil, err
	}
	return s, nil
}

func (s *Service) Notify(_ any) error {
	if s.options.Log != nil {
		s.options.Log("local workspace notification", nil)
	}
	return nil
}

func (s *Service) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	var queueErr error
	if s.queue != nil {
		queueErr = s.queue.close()
	}
	return errors.Join(queueErr, s.github.close())
}

func (s *Service) DashboardURL() string {
	if s.closed.Load() {
		return ""
	}
	if s.options.CaoURL != "" {
		return s.options.CaoURL
	}
	if !s.options.Admin && !s.options.Canvas {
		return ""
	}
	for _, candidate := range array(mapping(s.dashboard()["dashboard"])["cli-actions"]) {
		action := mapping(candidate)
		if strings.Contains(text(action["command"]), "{{cao-url}}") {
			return s.templateContext(s.github.ctx, text(action["id"]))["cao-url"]
		}
	}
	return ""
}

func (s *Service) dashboard() map[string]any {
	if s.options.Dashboard == nil {
		return map[string]any{}
	}
	return s.options.Dashboard()
}

func (s *Service) templateContext(ctx context.Context, actionID string) map[string]string {
	if s.options.TemplateContext != nil {
		return s.options.TemplateContext()
	}
	host := map[string]string{}
	repository := s.options.Repository
	if repository == "" {
		repository = text(mapping(s.dashboard()["dashboard"])["repository"])
	}
	if repository != "" {
		host["cao-repository"] = repository
		host["cao-repository-url"] = "https://github.com/" + repository
	}
	caoURL := s.options.CaoURL
	if caoURL == "" && repository != "" && strings.Contains(text(actionByID(s.dashboard(), actionID)["command"]), "{{cao-url}}") {
		caoURL = s.dashboardURL(ctx, repository)
	}
	if caoURL != "" {
		host["cao-url"] = caoURL
	}
	return host
}

func (s *Service) approve(ctx context.Context, invocation Invocation) error {
	s.mu.Lock()
	if s.approval {
		s.mu.Unlock()
		return failure(409, "Another CLI action is awaiting approval.")
	}
	s.approval = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.approval = false; s.mu.Unlock() }()
	if s.options.Approve != nil {
		ok, err := s.options.Approve(ctx, invocation)
		if err != nil {
			return failure(503, "Trusted approval is unavailable.")
		}
		if !ok {
			return failure(403, "CLI action was not approved by the trusted host.")
		}
		return nil
	}
	if !s.options.Canvas && s.options.Admin {
		return nil
	}
	return failure(403, "CLI action requires approval from the trusted host.")
}

func decodePayload(value any) (map[string]any, error) {
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > 1<<20 {
		return nil, failure(400, "Invalid workspace request.")
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil || result == nil {
		return nil, failure(400, "Invalid workspace request.")
	}
	return result, nil
}

func (s *Service) Call(ctx context.Context, operation string, payload any, result any) error {
	if s.closed.Load() {
		return failure(503, "Workspace operations are closed.")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	body, err := decodePayload(payload)
	if err != nil {
		return err
	}
	value, err := s.call(ctx, operation, body)
	if err != nil {
		return err
	}
	if result == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, result)
}

func (s *Service) call(ctx context.Context, operation string, payload map[string]any) (any, error) {
	switch operation {
	case "github":
		return s.github.request(ctx, text(payload["path"]), text(payload["etag"]))
	case "selector":
		return s.selector(ctx, payload)
	case "query.generate", "query.enhance":
		return s.author(ctx, operation, payload)
	case "views.save":
		if !s.options.Canvas {
			return nil, failure(404, "Custom views are available only in canvas preview.")
		}
		if !onlyKeys(payload, "document") || text(payload["document"]) == "" {
			return nil, failure(400, "Save a complete Dashboard Language document; paths and identifiers are assigned by CAO.")
		}
		s.mu.Lock()
		if s.saving {
			s.mu.Unlock()
			return nil, failure(409, "Another custom view is being saved.")
		}
		s.saving = true
		s.mu.Unlock()
		defer func() { s.mu.Lock(); s.saving = false; s.mu.Unlock() }()
		document := text(payload["document"])
		if _, err := ValidateCustomView([]byte(document)); err != nil {
			return nil, failure(400, err.Error())
		}
		saved, err := SaveCustomView(s.options.Workspace, []byte(document))
		if err != nil {
			return nil, err
		}
		if s.options.SaveDashboard != nil {
			loaded, err := s.options.SaveDashboard([]byte(document))
			if err != nil {
				return nil, failure(503, "Could not load the saved custom view.")
			}
			if m, ok := loaded.(map[string]any); ok {
				for key, value := range m {
					saved[key] = value
				}
			}
		}
		return saved, nil
	}
	if !strings.HasPrefix(operation, "queue.") {
		return nil, failure(400, "Unknown workspace operation.")
	}
	if s.queue == nil {
		return nil, failure(404, "CLI commands are disabled in read-only preview.")
	}
	body := map[string]any{}
	if value, present := payload["body"]; present {
		var ok bool
		body, ok = value.(map[string]any)
		if !ok || body == nil {
			return nil, failure(400, "Invalid CLI command request.")
		}
	}
	id := payload["id"]
	switch operation {
	case "queue.list":
		return s.queue.list(ctx, payload)
	case "queue.sources":
		return s.queue.sources(ctx, payload)
	case "queue.detail":
		return s.queue.detail(ctx, id)
	case "queue.output":
		return s.queue.output(ctx, id, payload["after"], payload["limit"])
	case "queue.enqueue":
		invocation, err := ResolveAction(s.dashboard(), body, s.templateContext(ctx, text(body["id"])))
		if err != nil {
			return nil, err
		}
		if err := s.approve(ctx, invocation); err != nil {
			return nil, err
		}
		key := body["idempotencyKey"]
		if key == nil {
			key = payload["idempotencyKey"]
		}
		return s.queue.enqueue(ctx, invocation, key, nil)
	case "queue.cancel", "queue.retry":
		if !onlyKeys(body, "idempotencyKey") {
			return nil, failure(400, "Invalid CLI command request.")
		}
		if operation == "queue.cancel" {
			return s.queue.cancel(ctx, id)
		}
		original, err := s.queue.detail(ctx, id)
		if err != nil {
			return nil, err
		}
		if original["status"] != "failed" && original["status"] != "timed-out" {
			return nil, failure(409, "Only failed or timed-out CLI actions can be retried.")
		}
		invocation, err := ResolveAction(s.dashboard(), map[string]any{"id": original["actionId"], "arguments": original["arguments"], "values": original["values"], "input": original["input"]}, s.templateContext(ctx, text(original["actionId"])))
		if err != nil {
			return nil, err
		}
		if invocation.Command != original["command"] {
			return nil, failure(409, "CLI action declaration has changed.")
		}
		if err := s.approve(ctx, invocation); err != nil {
			return nil, err
		}
		key := body["idempotencyKey"]
		if key == nil {
			key = payload["idempotencyKey"]
		}
		value, err := s.queue.enqueue(ctx, invocation, key, original["id"])
		if err == nil && fmt.Sprint(value["retryOf"]) != fmt.Sprint(original["id"]) {
			return nil, failure(409, "Retry idempotency key conflicts with another command.")
		}
		return value, err
	}
	return nil, failure(400, "Unknown workspace operation.")
}

func onlyKeys(m map[string]any, keys ...string) bool {
	for key := range m {
		found := false
		for _, allowed := range keys {
			if key == allowed {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func text(value any) string            { result, _ := value.(string); return result }
func mapping(value any) map[string]any { result, _ := value.(map[string]any); return result }
func array(value any) []any            { result, _ := value.([]any); return result }
