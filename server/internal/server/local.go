package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/sqlitex"
)

type LocalConfig struct {
	Listen              string               `json:"listen"`
	Workspace           string               `json:"workspace"`
	SiteDirectory       string               `json:"siteDirectory"`
	OverlayDirectory    string               `json:"overlayDirectory"`
	SourceDirectory     string               `json:"sourceDirectory"`
	DatabasePath        string               `json:"databasePath"`
	DatabaseQueriesPath string               `json:"databaseQueriesPath"`
	Prefix              string               `json:"prefix"`
	CaoURL              string               `json:"caoUrl"`
	Canvas              bool                 `json:"canvas"`
	Admin               bool                 `json:"admin"`
	Queue               bool                 `json:"queue"`
	QueryDesigner       bool                 `json:"queryDesigner"`
	EnhanceIntent       bool                 `json:"enhanceIntent"`
	AllowMissingOrigin  bool                 `json:"allowMissingOrigin"`
	OnReady             func(string, string) `json:"-"`
	OnBrowserTrace      func(map[string]any) `json:"-"`
}

type LocalServer struct {
	config    LocalConfig
	app       *App
	bridge    LocalOperations
	control   *LocalBridge
	authority string
	codespace string
	mu        sync.Mutex
	sockets   map[*localSocket]struct{}
	changes   chan struct{}
}

type LocalOperations interface {
	Call(context.Context, string, any, any) error
	Notify(any) error
}

var localPrefixPattern = regexp.MustCompile(`^/[a-f0-9]{48}$`)

func NewLocalServer(ctx context.Context, config LocalConfig) (*LocalServer, error) {
	if !localPrefixPattern.MatchString(config.Prefix) {
		return nil, errors.New("local preview requires a random capability path")
	}
	host, _, err := net.SplitHostPort(config.Listen)
	if err != nil || host != "localhost" && net.ParseIP(host) == nil {
		return nil, errors.New("local preview requires a numeric listen address or localhost")
	}
	if config.Admin && (config.Canvas || !localLoopback(host)) {
		return nil, errors.New("admin mode requires a loopback host and cannot be combined with canvas mode")
	}
	if config.CaoURL != "" {
		u, err := url.Parse(config.CaoURL)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("CAO URL must be an HTTPS URL without credentials, query or fragment")
		}
	}
	for _, path := range []string{config.SiteDirectory, config.OverlayDirectory} {
		if err := localPath(config.Workspace, path); err != nil {
			return nil, errors.New("dashboard server paths must remain within the workspace")
		}
	}
	local := &LocalServer{config: config, sockets: map[*localSocket]struct{}{}, changes: make(chan struct{}, 1)}
	app := &App{
		config: Config{SiteDirectory: config.SiteDirectory, SourceDirectory: config.SourceDirectory},
		hub:    newEventHub(), drain: make(chan struct{}),
	}
	if config.DatabasePath != "" {
		if err := localPath(config.Workspace, config.DatabasePath); err != nil {
			return nil, errors.New("dashboard database must remain within the workspace")
		}
		database, err := sqlitex.Open(ctx, config.DatabasePath)
		if err != nil {
			return nil, fmt.Errorf("open local dashboard SQLite: %w", err)
		}
		app.localDatabase = database
		definitions, err := ParseDashboardQueries(config.DatabaseQueriesPath)
		if err != nil {
			_ = database.Close()
			return nil, err
		}
		app.databaseQueries = definitions
	}
	local.app = app
	return local, nil
}

func localLoopback(host string) bool {
	return host == "localhost" || net.ParseIP(host).IsLoopback()
}

func localPath(root, path string) error {
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(root, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return errors.New("path escapes its root")
	}
	return nil
}

func (s *LocalServer) SetOperations(operations LocalOperations) {
	s.bridge = operations
	s.app.localOperations = operations
}

func (s *LocalServer) SetControl(control *LocalBridge) { s.control = control }

func (s *LocalServer) Changed() {
	select {
	case s.changes <- struct{}{}:
	default:
	}
}

func (s *LocalServer) observeChanges(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.changes:
			if s.app.localDatabase == nil {
				continue
			}
			state, err := s.app.localDatabase.State(ctx)
			if err == nil {
				state.Revision++
				err = s.app.localDatabase.SetState(ctx, state)
			}
			if err != nil && ctx.Err() == nil {
				serverLog.Printf("local preview revision update failed")
			}
		}
	}
}

func (s *LocalServer) Event(content json.RawMessage) {
	var event struct {
		Event     string          `json:"event"`
		Dashboard json.RawMessage `json:"dashboard"`
		TraceID   string          `json:"traceId,omitempty"`
	}
	if json.Unmarshal(content, &event) != nil || event.Event != "dashboard" {
		return
	}
	message := event.Dashboard
	if event.TraceID != "" {
		message, _ = json.Marshal(map[string]any{"type": "dashboard-update", "traceId": event.TraceID, "dashboard": event.Dashboard})
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for socket := range s.sockets {
		if err := socket.write(1, message); err != nil {
			_ = socket.connection.Close()
		}
	}
}

func (s *LocalServer) Serve(ctx context.Context, input io.Reader, output io.Writer) (serveErr error) {
	if s.app.localDatabase != nil {
		defer func() { serveErr = errors.Join(serveErr, s.app.localDatabase.Close()) }()
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", s.config.Listen)
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close() }()
	s.authority = listener.Addr().String()
	if !s.config.Admin && os.Getenv("CODESPACES") == "true" && os.Getenv("CODESPACE_NAME") != "" && os.Getenv("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN") != "" {
		_, port, _ := net.SplitHostPort(s.authority)
		s.codespace = os.Getenv("CODESPACE_NAME") + "-" + port + "." + os.Getenv("GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN")
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	changeDone := make(chan struct{})
	go func() {
		defer close(changeDone)
		s.observeChanges(runCtx)
	}()
	defer func() { cancel(); <-changeDone }()
	if input != nil && output != nil {
		transport := s.control
		if transport == nil {
			transport = NewLocalBridge(input, output, s.Event)
		}
		go func() {
			select {
			case <-transport.done:
				cancel()
			case <-runCtx.Done():
			}
		}()
		ready := map[string]any{"event": "ready", "url": "http://" + s.authority + s.config.Prefix}
		if s.codespace != "" {
			ready["codespaceUrl"] = "https://" + s.codespace + s.config.Prefix
		}
		if err := transport.Notify(ready); err != nil {
			return err
		}
	}
	if s.config.OnReady != nil {
		forwarded := ""
		if s.codespace != "" {
			forwarded = "https://" + s.codespace + s.config.Prefix
		}
		s.config.OnReady("http://"+s.authority+s.config.Prefix, forwarded)
	}
	httpServer := &http.Server{
		Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout: 30 * time.Second, MaxHeaderBytes: 32 << 10,
		BaseContext: func(net.Listener) context.Context { return runCtx },
	}
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-runCtx.Done()
		close(s.app.drain)
		s.app.hub.shutdown()
		s.mu.Lock()
		for socket := range s.sockets {
			_ = socket.write(8, nil)
			_ = socket.connection.Close()
		}
		s.mu.Unlock()
		shutdown, stop := context.WithTimeout(context.WithoutCancel(runCtx), 5*time.Second)
		defer stop()
		if err := httpServer.Shutdown(shutdown); err != nil {
			serverLog.Printf("local HTTP shutdown failed")
		}
	}()
	err = httpServer.Serve(listener)
	cancel()
	<-shutdownDone
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *LocalServer) allowedHost(host string) bool {
	if host == s.authority || s.codespace != "" && host == s.codespace {
		return true
	}
	address, port, err := net.SplitHostPort(s.authority)
	return err == nil && localLoopback(address) && host == net.JoinHostPort("localhost", port)
}

func (s *LocalServer) allowedOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if s.codespace != "" && u.Host == s.codespace {
		return u.Scheme == "https"
	}
	return u.Scheme == "http" && s.allowedHost(u.Host)
}

func (s *LocalServer) Handler() http.Handler {
	mux := http.NewServeMux()
	if s.app.localDatabase != nil {
		mux.HandleFunc("POST /api/v1/query", s.app.query)
		mux.HandleFunc("POST /api/v1/refresh", s.app.refresh)
		mux.HandleFunc("GET /api/v1/diagnostics", s.app.diagnostics)
		mux.HandleFunc("GET /api/v1/events", s.app.events)
		mux.HandleFunc("GET /api/v1/memory/{campaign}", s.app.repositoryMemoryCampaign)
		mux.HandleFunc("GET /api/v1/memory/{campaign}/content", s.app.repositoryMemoryContent)
	}
	mux.HandleFunc("/api/v1/github/", s.github)
	mux.HandleFunc("/__query_designer", s.authoring)
	mux.HandleFunc("/__query_designer/enhance", s.authoring)
	mux.HandleFunc("/__custom_views", s.authoring)
	mux.HandleFunc("/__dialog_selector", s.authoring)
	mux.HandleFunc("/__cli_action", s.commands)
	mux.HandleFunc("/__cli_commands", s.commands)
	mux.HandleFunc("/__cli_commands/", s.commands)
	mux.HandleFunc("/__dashboard_socket", s.websocket)
	mux.HandleFunc("/", s.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		response := &localResponse{ResponseWriter: w}
		w = response
		defer func() {
			if s.bridge == nil {
				return
			}
			path := strings.TrimPrefix(r.URL.Path, s.config.Prefix)
			if path == "" {
				path = "/"
			}
			status := response.status
			if status == 0 {
				status = http.StatusOK
			}
			if err := s.bridge.Notify(map[string]any{
				"event": "request", "method": r.Method, "path": string(localRedact([]byte(path))),
				"status": status, "durationMs": time.Since(start).Milliseconds(),
			}); err != nil {
				serverLog.Printf("local request diagnostics unavailable")
			}
		}()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if !s.allowedHost(r.Host) || r.URL.IsAbs() {
			http.Error(w, "Bad request", http.StatusBadRequest)
			return
		}
		if r.URL.Path != s.config.Prefix && !strings.HasPrefix(r.URL.Path, s.config.Prefix+"/") {
			http.NotFound(w, r)
			return
		}
		copy := r.Clone(r.Context())
		copy.URL.Path = strings.TrimPrefix(r.URL.Path, s.config.Prefix)
		copy.URL.RawPath = ""
		if copy.URL.Path == "" {
			copy.URL.Path = "/"
		}
		if strings.Contains(copy.URL.Path, "\\") || strings.ContainsRune(copy.URL.Path, 0) {
			http.NotFound(w, r)
			return
		}
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") && copy.Method == http.MethodPost {
			// Route handlers preserve 404/405 for unavailable or wrong-method routes.
			if !s.localMutation(copy.URL.Path) {
				mux.ServeHTTP(w, copy)
				return
			}
			origin := r.Header.Get("Origin")
			contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if origin == "" && !s.config.AllowMissingOrigin || origin != "" && !s.allowedOrigin(origin) ||
				err != nil || contentType != "application/json" {
				writeError(w, http.StatusForbidden, "Forbidden")
				return
			}
		}
		mux.ServeHTTP(w, copy)
	})
}

func (s *LocalServer) localMutation(path string) bool {
	if strings.HasPrefix(path, "/api/v1/github/") {
		return false
	}
	switch path {
	case "/api/v1/query", "/api/v1/refresh":
		return s.app.localDatabase != nil
	case "/__query_designer":
		return s.config.Canvas && s.config.QueryDesigner
	case "/__query_designer/enhance":
		return s.config.Canvas && s.config.EnhanceIntent
	case "/__custom_views":
		return s.config.Canvas && s.config.QueryDesigner
	case "/__dialog_selector":
		return s.config.Canvas || s.config.Admin
	default:
		return s.config.Queue && (path == "/__cli_action" || strings.HasPrefix(path, "/__cli_commands"))
	}
}

func (s *LocalServer) call(w http.ResponseWriter, r *http.Request, operation string, payload, result any) bool {
	if s.bridge == nil {
		writeError(w, http.StatusServiceUnavailable, "local tooling is unavailable")
		return false
	}
	if err := s.bridge.Call(r.Context(), operation, payload, result); err != nil {
		status, message := http.StatusServiceUnavailable, "Local operation failed. Check workspace tooling and try again."
		var failure *localError
		if errors.As(err, &failure) && failure.Status >= 400 && failure.Status < 600 {
			status, message = failure.Status, failure.Message
		}
		var public interface {
			HTTPStatus() int
		}
		if errors.As(err, &public) && public.HTTPStatus() >= 400 && public.HTTPStatus() < 600 {
			status, message = public.HTTPStatus(), err.Error()
		}
		serverLog.Printf("local tooling operation failed operation=%s", operation)
		writeError(w, status, message)
		return false
	}
	return true
}

func localJSON(w http.ResponseWriter, r *http.Request, maximum int64) (json.RawMessage, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maximum)
	content, err := io.ReadAll(r.Body)
	if err != nil {
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			writeError(w, http.StatusRequestEntityTooLarge, "Request body is too large.")
		} else {
			writeError(w, http.StatusBadRequest, "Invalid request body.")
		}
		return nil, false
	}
	if !json.Valid(content) {
		writeError(w, http.StatusBadRequest, "Invalid JSON request.")
		return nil, false
	}
	return content, true
}

func (s *LocalServer) authoring(w http.ResponseWriter, r *http.Request) {
	if !s.localMutation(r.URL.Path) {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	maximum := int64(160 << 10)
	operation, status := "query.generate", http.StatusOK
	switch r.URL.Path {
	case "/__query_designer/enhance":
		operation = "query.enhance"
	case "/__custom_views":
		operation, status = "views.save", http.StatusCreated
	case "/__dialog_selector":
		operation, maximum = "selector", 4096
	}
	body, ok := localJSON(w, r, maximum)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	var result json.RawMessage
	if s.call(w, r.WithContext(ctx), operation, body, &result) {
		writeJSON(w, status, result)
	}
}

func (s *LocalServer) github(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if r.Header.Get("Origin") != "" && !s.allowedOrigin(r.Header.Get("Origin")) ||
		r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		writeError(w, http.StatusForbidden, "Forbidden.")
		return
	}
	var result struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    json.RawMessage   `json:"body"`
	}
	if !s.call(w, r, "github", map[string]any{"path": r.URL.RequestURI(), "etag": r.Header.Get("If-None-Match")}, &result) {
		return
	}
	for name, value := range result.Headers {
		if name == "ETag" || name == "Cache-Control" || name == "Age" || name == "Warning" || name == "Retry-After" {
			w.Header().Set(name, value)
		}
	}
	switch {
	case result.Status == http.StatusNotModified:
		w.WriteHeader(http.StatusNotModified)
	case result.Status >= 200 && result.Status < 600:
		writeJSON(w, result.Status, result.Body)
	default:
		writeError(w, http.StatusBadGateway, "Invalid GitHub resource response.")
	}
}

func localInteger(value string, fallback, maximum int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	number, err := strconv.Atoi(value)
	if err != nil || number < 0 || number > maximum || strconv.Itoa(number) != value {
		return 0, errors.New("invalid queue pagination")
	}
	return number, nil
}

// Keep the local adapter on the same transaction/query boundary as hosted data.
type dashboardReadStore interface {
	State(context.Context) (postgresx.State, error)
	WithReadTransaction(context.Context, func(context.Context, postgresx.NativeReader) error) error
	Diagnostics(context.Context) (model.Diagnostics, error)
}

func (a *App) queryStore() dashboardReadStore {
	if a.localDatabase != nil {
		return a.localDatabase
	}
	return a.database
}
