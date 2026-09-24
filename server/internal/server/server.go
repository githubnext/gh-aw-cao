package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

type Config struct {
	Listen              string
	SiteDirectory       string
	CertFile            string
	KeyFile             string
	AccessToken         string
	HostingMode         HostingMode
	AzureProxy          AzureProxyPolicy
	GitHubOAuth         *GitHubOAuthConfig
	DatabaseQueriesPath string
	DashboardQueries    []query.Definition
	SourceDirectory     string
	Logger              *log.Logger
}

type App struct {
	store       *redisx.Store
	config      Config
	accessToken string
	oauth       *githubOAuth
	hub         *eventHub
}

func New(store *redisx.Store, config Config) (*App, error) {
	mode := config.HostingMode
	if mode == "" {
		mode = HostingModeLocal
		config.HostingMode = mode
	}
	if mode == HostingModeLocal {
		if err := ValidateListen(config.Listen, config.CertFile, config.KeyFile); err != nil {
			return nil, err
		}
	} else if mode != HostingModeAzureFunctions {
		return nil, fmt.Errorf("unsupported hosting mode %q", mode)
	}
	if err := validateAzureMode(store, &config); err != nil {
		return nil, err
	}
	info, err := os.Stat(config.SiteDirectory)
	if err != nil || !info.IsDir() {
		return nil, errors.New("site directory must exist and contain the built dashboard")
	}
	if config.Logger == nil {
		config.Logger = log.Default()
	}
	var oauth *githubOAuth
	var accessToken string
	if mode == HostingModeAzureFunctions {
		oauth = newGitHubOAuth(*config.GitHubOAuth, store)
	} else {
		accessToken = strings.TrimSpace(config.AccessToken)
		if accessToken == "" {
			generated, err := generateAccessToken()
			if err != nil {
				return nil, fmt.Errorf("generate dashboard access token: %w", err)
			}
			accessToken = generated
		} else if len(accessToken) < 32 {
			return nil, errors.New("dashboard access token must contain at least 32 characters")
		}
	}
	return &App{store: store, config: config, accessToken: accessToken, oauth: oauth, hub: newEventHub()}, nil
}

func (a *App) Serve(ctx context.Context) error {
	if a.config.SourceDirectory != "" {
		result, err := ingest.Run(ctx, a.store, a.config.SourceDirectory, ingest.Options{DatabaseQueriesPath: a.config.DatabaseQueriesPath})
		if err != nil {
			return fmt.Errorf("initial ingestion failed: %w", err)
		}
		a.hub.Broadcast(result.Revision)
		a.config.Logger.Printf("activated local dashboard revision %d", result.Revision)
	}
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(ctx, "tcp", a.config.Listen)
	if err != nil {
		return err
	}
	servingListener := listener
	if a.config.CertFile != "" {
		certificate, certificateErr := tls.LoadX509KeyPair(a.config.CertFile, a.config.KeyFile)
		if certificateErr != nil {
			_ = listener.Close()
			return fmt.Errorf("load TLS certificate: %w", certificateErr)
		}
		servingListener = tls.NewListener(listener, &tls.Config{
			Certificates: []tls.Certificate{certificate},
			MinVersion:   tls.VersionTLS12,
		})
	}
	httpServer := &http.Server{
		Handler:           a.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       65 * time.Second,
		WriteTimeout:      65 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	a.config.Logger.Printf("serving local dashboard at %s", a.capabilityURL())
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	err = httpServer.Serve(servingListener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	if a.oauth != nil {
		mux.HandleFunc("GET /auth/login", a.oauth.login)
		mux.HandleFunc("GET /auth/callback", a.oauth.callback)
		mux.HandleFunc("POST /auth/logout", a.oauth.logout)
	}
	mux.HandleFunc("GET /api/v1/health", a.health)
	mux.HandleFunc("GET /api/v1/events", a.events)
	mux.HandleFunc("POST /api/v1/query", a.query)
	mux.HandleFunc("GET /api/v1/diagnostics", a.diagnostics)
	mux.HandleFunc("POST /api/v1/refresh", a.refresh)
	mux.HandleFunc("/", a.static)
	return securityHeaders(a.requireAccess(mux))
}

func generateAccessToken() (string, error) {
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(token), nil
}

func (a *App) capabilityURL() string {
	scheme := "http"
	if a.config.CertFile != "" {
		scheme = "https"
	}
	return scheme + "://" + a.config.Listen + "/?access_token=" + a.accessToken
}

func (a *App) requireAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if a.oauth != nil {
			a.requireGitHubAccess(next).ServeHTTP(response, request)
			return
		}
		if !validLocalRequestHost(request.Host) {
			http.Error(response, "invalid request host", http.StatusMisdirectedRequest)
			return
		}
		if request.URL.Path == "/api/v1/health" {
			next.ServeHTTP(response, request)
			return
		}
		if !strings.HasPrefix(request.URL.Path, "/api/") {
			if (request.Method == http.MethodGet || request.Method == http.MethodHead) &&
				constantTimeTokenEqual(request.URL.Query().Get("access_token"), a.accessToken) {
				a.serveIndex(response, a.accessToken)
				return
			}
			next.ServeHTTP(response, request)
			return
		}
		if a.authorized(request) {
			next.ServeHTTP(response, request)
			return
		}
		writeError(response, http.StatusUnauthorized, "dashboard access token is required")
	})
}

func validLocalRequestHost(value string) bool {
	host := value
	if parsedHost, _, err := net.SplitHostPort(value); err == nil {
		host = parsedHost
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	return strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback())
}

func (a *App) authorized(request *http.Request) bool {
	const prefix = "Bearer "
	authorization := request.Header.Get("Authorization")
	return strings.HasPrefix(authorization, prefix) &&
		constantTimeTokenEqual(strings.TrimPrefix(authorization, prefix), a.accessToken)
}

func (a *App) requireGitHubAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !validAzureProxyRequest(request, a.config.AzureProxy) {
			http.Error(response, "invalid forwarded request host", http.StatusMisdirectedRequest)
			return
		}
		if request.URL.Path == "/api/v1/health" ||
			strings.HasPrefix(request.URL.Path, "/auth/login") ||
			strings.HasPrefix(request.URL.Path, "/auth/callback") {
			next.ServeHTTP(response, request)
			return
		}
		session, ok := a.oauth.session(response, request)
		if !ok {
			if strings.HasPrefix(request.URL.Path, "/api/") || request.URL.Path == "/auth/logout" {
				writeError(response, http.StatusUnauthorized, "GitHub authentication is required")
				return
			}
			http.Redirect(response, request, "/auth/login", http.StatusFound)
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodHead && request.Method != http.MethodOptions {
			if !constantTimeTokenEqual(request.Header.Get("X-CSRF-Token"), session.CSRFToken) {
				writeError(response, http.StatusForbidden, "CSRF token is required")
				return
			}
		}
		next.ServeHTTP(response, request)
	})
}

func constantTimeTokenEqual(candidate, expected string) bool {
	return len(candidate) == len(expected) &&
		subtle.ConstantTimeCompare([]byte(candidate), []byte(expected)) == 1
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("X-Frame-Options", "DENY")
		response.Header().Set("Referrer-Policy", "same-origin")
		response.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		response.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		if strings.HasPrefix(request.URL.Path, "/api/") {
			response.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(response, request)
	})
}

func (a *App) health(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	active, activeErr := a.store.Active(ctx)
	redisHealthy := a.store.Ping(ctx) == nil
	status := http.StatusOK
	if !redisHealthy || activeErr != nil {
		status = http.StatusServiceUnavailable
	}
	payload := map[string]any{
		"redis": map[string]any{"connected": redisHealthy},
		"data":  map[string]any{"available": active.Generation != ""},
	}
	if a.authorized(request) || (a.oauth != nil && a.oauth.requestHasSession(request)) {
		rowCount := 0
		for _, count := range active.Counts {
			rowCount += count
		}
		payload["revision"] = active.Revision
		payload["generation"] = active.Generation
		payload["counts"] = active.Counts
		payload["sourceCount"] = len(active.Counts)
		payload["rowCount"] = rowCount
	}
	writeJSON(response, status, payload)
}

func (a *App) events(response http.ResponseWriter, request *http.Request) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		http.Error(response, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Connection", "keep-alive")
	active, _ := a.store.Active(request.Context())
	writeEvent(response, active.Revision)
	flusher.Flush()
	lastRevision := active.Revision
	channel := a.hub.Subscribe()
	defer a.hub.Unsubscribe(channel)
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	for {
		select {
		case revision := <-channel:
			if revision != lastRevision {
				writeEvent(response, revision)
				flusher.Flush()
				lastRevision = revision
			}
		case <-poll.C:
			active, err := a.store.Active(request.Context())
			if err == nil && active.Revision != lastRevision {
				writeEvent(response, active.Revision)
				flusher.Flush()
				lastRevision = active.Revision
			}
		case <-heartbeat.C:
			_, _ = io.WriteString(response, ": keepalive\n\n")
			flusher.Flush()
		case <-request.Context().Done():
			return
		}
	}
}

func writeEvent(writer io.Writer, revision int64) {
	payload, _ := json.Marshal(map[string]int64{"revision": revision})
	_, _ = fmt.Fprintf(writer, "data: %s\n\n", payload)
}

type queryRequest struct {
	SourceNames     []string                     `json:"sourceNames"`
	Queries         []query.Definition           `json:"queries,omitempty"`
	CompiledQueries []query.Definition           `json:"compiledQueries,omitempty"`
	Aliases         []string                     `json:"aliases,omitempty"`
	ReplacedSources []string                     `json:"replacedSources,omitempty"`
	Pagination      map[string]paginationRequest `json:"pagination,omitempty"`
	PageID          string                       `json:"pageId,omitempty"`
	ViewID          string                       `json:"viewId,omitempty"`
	RouteParameters map[string]any               `json:"routeParameters,omitempty"`
	QueryContext    map[string]any               `json:"queryContext,omitempty"`
	Context         map[string]any               `json:"context,omitempty"`
	EvaluatedAt     string                       `json:"evaluatedAt,omitempty"`
}

type paginationRequest struct {
	Limit             int    `json:"limit"`
	ContinuationToken string `json:"continuationToken,omitempty"`
}

func (a *App) query(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, 8<<20)
	decoder := json.NewDecoder(request.Body)
	var input queryRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid query request")
		return
	}
	if len(input.SourceNames) > 256 || len(input.Aliases) > 256 || len(input.ReplacedSources) > 256 {
		writeError(response, http.StatusBadRequest, "query request exceeds source limits")
		return
	}
	for _, name := range append(append([]string{}, input.SourceNames...), input.Aliases...) {
		if strings.TrimSpace(name) == "" {
			writeError(response, http.StatusBadRequest, "source names must be non-empty")
			return
		}
	}
	active, err := a.store.Active(request.Context())
	if err != nil || active.Generation == "" {
		writeError(response, http.StatusServiceUnavailable, "dashboard data is unavailable")
		return
	}
	evaluatedAt := evaluationTime(active)
	if len(input.SourceNames) == 0 && len(input.Aliases) == 0 {
		writeJSON(response, http.StatusOK, map[string]any{
			"revision":    active.Revision,
			"evaluatedAt": evaluatedAt,
			"sources":     map[string]model.Source{},
			"metrics": model.Metrics{
				PushedDown:         []string{},
				FallbackOperations: []string{},
			},
		})
		return
	}
	definitions := append([]query.Definition{}, a.config.DashboardQueries...)
	if len(input.Queries) > 0 {
		definitions = append([]query.Definition{}, input.Queries...)
	}
	definitions = append(definitions, input.CompiledQueries...)
	resolveQueryContext(definitions, evaluatedAt)
	replaced := map[string]bool{}
	for _, name := range input.ReplacedSources {
		replaced[name] = true
	}
	requested := append([]string{}, input.Aliases...)
	for _, name := range input.SourceNames {
		if !replaced[name] {
			requested = append(requested, name)
		}
	}
	started := time.Now()
	loader := &generationLoader{ctx: request.Context(), store: a.store, generation: active.Generation}
	engine := query.New(loader)
	sources, metrics, err := engine.Execute(definitions, requested)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	for name, page := range input.Pagination {
		source, ok := sources[name]
		if !ok {
			continue
		}
		paginated, err := paginate(source, strconv.FormatInt(active.Revision, 10), page)
		if err != nil {
			writeError(response, http.StatusBadRequest, err.Error())
			return
		}
		sources[name] = paginated
	}
	metrics.DurationMS = time.Since(started).Milliseconds()
	writeJSON(response, http.StatusOK, map[string]any{"revision": active.Revision, "evaluatedAt": evaluatedAt, "sources": sources, "metrics": metrics})
}

type generationLoader struct {
	ctx        context.Context
	store      *redisx.Store
	generation string
}

func (loader *generationLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	source, metrics, err := loader.store.LoadSource(loader.ctx, loader.generation, name, definition)
	if errors.Is(err, redisx.ErrSourceUnavailable) {
		return unavailableSource(name), metrics, nil
	}
	return source, metrics, err
}

func unavailableSource(name string) model.Source {
	return model.Source{
		Source: name,
		Rows:   []model.Row{},
		Metadata: model.Metadata{
			"source-id":    name,
			"availability": "unavailable",
			"completeness": "unknown",
			"freshness":    "unknown",
		},
	}
}

func paginate(source model.Source, revision string, page paginationRequest) (model.Source, error) {
	if page.Limit <= 0 || page.Limit > query.MaxOutputRows {
		return model.Source{}, fmt.Errorf("pagination limit for %q is invalid", source.Source)
	}
	offset := 0
	if page.ContinuationToken != "" {
		data, err := base64.RawURLEncoding.DecodeString(page.ContinuationToken)
		if err != nil {
			return model.Source{}, fmt.Errorf("invalid or stale continuation token for %q", source.Source)
		}
		var cursor struct {
			Source   string `json:"source"`
			Revision string `json:"revision"`
			Offset   int    `json:"offset"`
		}
		if json.Unmarshal(data, &cursor) != nil || cursor.Source != source.Source || cursor.Revision != revision || cursor.Offset <= 0 {
			return model.Source{}, fmt.Errorf("invalid or stale continuation token for %q", source.Source)
		}
		offset = cursor.Offset
	}
	if offset > len(source.Rows) {
		return model.Source{}, fmt.Errorf("invalid or stale continuation token for %q", source.Source)
	}
	end := min(len(source.Rows), offset+page.Limit)
	total := len(source.Rows)
	source.Rows = source.Rows[offset:end]
	source.Metadata["total-row-count"] = total
	if end < total {
		cursor, _ := json.Marshal(map[string]any{"source": source.Source, "revision": revision, "offset": end})
		source.ContinuationToken = base64.RawURLEncoding.EncodeToString(cursor)
	}
	return source, nil
}

func (a *App) diagnostics(response http.ResponseWriter, request *http.Request) {
	active, err := a.store.Active(request.Context())
	if err != nil || active.Generation == "" {
		writeError(response, http.StatusServiceUnavailable, "dashboard data is unavailable")
		return
	}
	diagnostics, err := a.store.Diagnostics(request.Context(), active.Generation)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "dashboard diagnostics are unavailable")
		return
	}
	writeJSON(response, http.StatusOK, diagnostics)
}

func (a *App) refresh(response http.ResponseWriter, request *http.Request) {
	active, err := a.store.Active(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "dashboard data is unavailable")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"revision":    active.Revision,
		"evaluatedAt": evaluationTime(active),
		"changed":     false,
	})
}

func evaluationTime(active model.ActiveGeneration) string {
	if !active.EvaluatedAt.IsZero() {
		return active.EvaluatedAt.UTC().Format(time.RFC3339Nano)
	}
	if active.Activated.IsZero() {
		return time.Now().UTC().Format(time.RFC3339Nano)
	}
	return active.Activated.UTC().Format(time.RFC3339Nano)
}

func resolveQueryContext(definitions []query.Definition, evaluatedAt string) {
	for definitionIndex := range definitions {
		for computedIndex := range definitions[definitionIndex].Compute {
			for argumentIndex := range definitions[definitionIndex].Compute[computedIndex].Args {
				argument := &definitions[definitionIndex].Compute[computedIndex].Args[argumentIndex]
				if argument.Context == "time-end" {
					argument.Context = ""
					argument.Value = evaluatedAt
				}
			}
		}
	}
}

func (a *App) static(response http.ResponseWriter, request *http.Request) {
	if strings.HasPrefix(request.URL.Path, "/api/") {
		http.NotFound(response, request)
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	clean := filepath.Clean(strings.TrimPrefix(request.URL.Path, "/"))
	if clean == "." {
		clean = "index.html"
	}
	path := filepath.Join(a.config.SiteDirectory, clean)
	relative, err := filepath.Rel(a.config.SiteDirectory, path)
	if err != nil || strings.HasPrefix(relative, "..") {
		http.NotFound(response, request)
		return
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		path = filepath.Join(a.config.SiteDirectory, "index.html")
	}
	if filepath.Base(path) == "index.html" {
		a.serveIndex(response, "")
		return
	}
	if contentType := mime.TypeByExtension(filepath.Ext(path)); contentType != "" {
		response.Header().Set("Content-Type", contentType)
	}
	http.ServeFile(response, request, path)
}

func (a *App) serveIndex(response http.ResponseWriter, accessToken string) {
	path := filepath.Join(a.config.SiteDirectory, "index.html")
	// #nosec G304,G703 -- path is constrained to the configured site directory.
	content, err := os.ReadFile(path)
	if err != nil {
		http.Error(response, "not found", http.StatusNotFound)
		return
	}
	html := string(content)
	injections := `<meta name="dashboard-data-backend" content="redis-http">`
	if a.oauth != nil {
		injections += `<script>const m=document.cookie.match(/(?:^|;\s*)cao_csrf=([^;]+)/);if(m){const c=decodeURIComponent(m[1]);const f=window.fetch.bind(window);window.fetch=(i,n={})=>{const u=typeof i==="string"?i:i.url;if(u&&new URL(u,location.href).origin===location.origin){const h=new Headers(n.headers||{});if(!h.has("X-CSRF-Token"))h.set("X-CSRF-Token",c);n={...n,headers:h};}return f(i,n);};}</script>`
	} else if accessToken != "" {
		token, _ := json.Marshal(accessToken)
		injections += fmt.Sprintf(
			`<script>localStorage.setItem("cao-dashboard-access-token",%s);const u=new URL(location.href);u.searchParams.delete("access_token");history.replaceState(null,"",u.pathname+u.search+u.hash);</script>`,
			token,
		)
	}
	if index := strings.Index(strings.ToLower(html), "</head>"); index >= 0 {
		html = html[:index] + injections + html[index:]
	} else {
		html = injections + html
	}
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	// #nosec G705 -- content comes from the configured local static site, with fixed bootstrap markup inserted.
	_, _ = io.WriteString(response, html)
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"error": message})
}

type eventHub struct {
	mu      sync.Mutex
	clients map[chan int64]struct{}
}

func newEventHub() *eventHub { return &eventHub{clients: map[chan int64]struct{}{}} }

func (hub *eventHub) Subscribe() chan int64 {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	channel := make(chan int64, 1)
	hub.clients[channel] = struct{}{}
	return channel
}

func (hub *eventHub) Unsubscribe(channel chan int64) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	delete(hub.clients, channel)
	close(channel)
}

func (hub *eventHub) Broadcast(revision int64) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	for channel := range hub.clients {
		select {
		case channel <- revision:
		default:
		}
	}
}

func ParseDashboardQueries(path string) ([]query.Definition, error) {
	if path == "" {
		return nil, nil
	}
	// #nosec G304 -- the operator explicitly configures the local dashboard query path.
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var definitions []query.Definition
	if json.Unmarshal(content, &definitions) == nil {
		return definitions, nil
	}
	var document struct {
		Queries []query.Definition `json:"queries"`
	}
	if err := json.Unmarshal(content, &document); err != nil {
		return nil, fmt.Errorf("parse dashboard query file: %w", err)
	}
	return document.Queries, nil
}

func ParsePort(address string) int {
	_, port, _ := net.SplitHostPort(address)
	value, _ := strconv.Atoi(port)
	return value
}
