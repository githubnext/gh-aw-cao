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

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

var serverLog = logger.New("cao:server")

type Config struct {
	Listen              string
	SiteDirectory       string
	CertFile            string
	KeyFile             string
	AccessToken         string
	HostingMode         HostingMode
	Proxy               ProxyPolicy
	AzureProxy          AzureProxyPolicy
	GitHubOAuth         *GitHubOAuthConfig
	DatabaseQueriesPath string
	DashboardQueries    []query.Definition
	SourceDirectory     string
	Reconciler          Reconciler
	Collector           *CollectorConfig
	WebhookSecret       string
	AdminUsers          []string
	Logger              *log.Logger
}

type App struct {
	store         *redisx.Store
	config        Config
	accessToken   string
	oauth         *githubOAuth
	hub           *eventHub
	canonical     canonicalService
	reconciler    Reconciler
	webhookSecret []byte
}

func New(store *redisx.Store, config Config) (*App, error) {
	serverLog.Printf("initializing hosting_mode=%s", config.HostingMode)
	mode := config.HostingMode
	if mode == "" {
		mode = HostingModeLocal
		config.HostingMode = mode
	}
	if mode == HostingModeLocal {
		if err := ValidateListen(config.Listen, config.CertFile, config.KeyFile); err != nil {
			return nil, err
		}
	} else if mode != HostingModeAzureFunctions && mode != HostingModeHosted {
		return nil, fmt.Errorf("unsupported hosting mode %q", mode)
	}
	if err := validateHostedMode(store, &config); err != nil {
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
	if mode == HostingModeAzureFunctions || mode == HostingModeHosted {
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
	reconciler := config.Reconciler
	if err := validateProfileExclusivity(config); err != nil {
		return nil, err
	}
	if config.Collector != nil {
		collector, err := NewCollector(store, *config.Collector, config.DatabaseQueriesPath)
		if err != nil {
			return nil, fmt.Errorf("configure collection: %w", err)
		}
		reconciler = collector
	}
	if reconciler == nil && config.SourceDirectory != "" {
		reconciler = DirectoryReconciler{
			Store: store, SourceDirectory: config.SourceDirectory,
			DatabaseQueriesPath: config.DatabaseQueriesPath,
		}
	}
	serverLog.Printf("initialized hosting_mode=%s oauth=%t source_ingestion=%t", mode, oauth != nil, config.SourceDirectory != "")
	return &App{
		store: store, config: config, accessToken: accessToken, oauth: oauth, hub: newEventHub(),
		canonical: canonicalService{store: store}, reconciler: reconciler,
		webhookSecret: []byte(config.WebhookSecret),
	}, nil
}

func (a *App) Serve(ctx context.Context) error {
	serverLog.Printf("starting server tls=%t initial_ingestion=%t", a.config.CertFile != "", a.config.SourceDirectory != "")
	if a.config.SourceDirectory != "" {
		result, err := ingest.Run(ctx, a.store, a.config.SourceDirectory, ingest.Options{DatabaseQueriesPath: a.config.DatabaseQueriesPath})
		if err != nil {
			return fmt.Errorf("initial ingestion failed: %w", err)
		}
		if a.oauth != nil {
			go a.oauth.runRevocationWorker(ctx)
		}
		a.hub.Broadcast(result.Revision)
		a.config.Logger.Printf("activated local dashboard revision %d", result.Revision)
	}
	var listenConfig net.ListenConfig
	if collector := a.Collector(); collector != nil {
		if a.oauth != nil {
			go a.oauth.runRevocationWorker(ctx)
		}
		if err := collector.Start(ctx, a.hub.Broadcast); err != nil {
			return fmt.Errorf("start collection: %w", err)
		}
		serverLog.Printf("collection profile started workers=%d", a.config.Collector.Workers)
	}
	listener, err := listenConfig.Listen(ctx, "tcp", a.config.Listen)
	if err != nil {
		return err
	}
	serverLog.Printf("listener ready")
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
	if a.oauth != nil {
		a.config.Logger.Printf("serving hosted dashboard on %s", a.config.Listen)
	} else {
		a.config.Logger.Printf("serving local dashboard at %s", a.capabilityURL())
	}
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
	routePatterns := map[string]struct{}{}
	register := func(pattern string, handler http.HandlerFunc) {
		mux.HandleFunc(pattern, handler)
		routePatterns[pattern] = struct{}{}
	}
	if a.oauth != nil {
		register("GET /auth/login", a.oauth.login)
		register("GET /auth/logged-out", a.oauth.loggedOut)
		register("GET /auth/callback", a.oauth.callback)
		register("POST /auth/logout", a.oauth.logout)
		register("POST /auth/switch-account", a.oauth.switchAccount)
		register("GET /api/auth/session", a.oauth.currentAccount)
	}
	register("GET /api/v1/health", a.health)
	register("GET /api/health", a.health)
	register("GET /api/readiness", a.readiness)
	register("GET /api/v1/events", a.events)
	register("POST /api/v1/query", a.query)
	register("GET /api/v1/diagnostics", a.diagnostics)
	register("POST /api/v1/refresh", a.refresh)
	register("GET /api/repositories", a.repositories)
	register("GET /api/repositories/{id}", a.repository)
	register("GET /api/repositories/{id}/runs", a.repositoryRuns)
	register("GET /api/workflows/{id}/runs", a.workflowRuns)
	register("GET /api/runs/{id}/jobs", a.runJobs)
	register("GET /api/runs/{id}/sessions", a.runSessions)
	register("GET /api/sessions/{id}/events", a.sessionEvents)
	register("POST /api/github/webhook", a.githubWebhook)
	register("POST /api/admin/rebuild", a.rebuild)
	register("GET /api/admin/rebuild/status", a.rebuildStatus)
	register("GET /api/admin/collection/status", a.collectionStatus)
	mux.HandleFunc("/", a.static)
	instrumented := otelhttp.NewHandler(withResponseTraceHeaders(mux), telemetry.ServiceName,
		otelhttp.WithSpanNameFormatter(func(_ string, request *http.Request) string {
			// Match against the fixed, small set of registered API/auth
			// patterns directly instead of calling mux.Handler, which
			// would re-run ServeMux's route resolution a second time per
			// request just to name the span. Every other path (static
			// dashboard assets) is bucketed under one low-cardinality
			// span name.
			pattern := request.Method + " " + request.URL.Path
			if _, ok := routePatterns[pattern]; ok {
				return pattern
			}
			return request.Method + " /*"
		}),
	)
	return securityHeaders(a.requireAccess(instrumented))
}

// withResponseTraceHeaders exposes the W3C trace/span ids that otelhttp
// assigned to the in-flight request as response headers, so operators can
// correlate a client-visible request with exported spans without requiring
// the client to send its own traceparent header.
func withResponseTraceHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		telemetry.SetResponseTraceHeaders(response, trace.SpanContextFromContext(request.Context()))
		next.ServeHTTP(response, request)
	})
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
			a.logAuthBranch("access.hosted_mode")
			a.requireGitHubAccess(next).ServeHTTP(response, request)
			return
		}
		if !validLocalRequestHost(request.Host) {
			a.logAuthBranch("access.local_host_rejected")
			http.Error(response, "invalid request host", http.StatusMisdirectedRequest)
			return
		}
		if publicServiceEndpoint(request.URL.Path) || request.URL.Path == "/api/github/webhook" {
			a.logAuthBranch("access.local_public_allowed")
			next.ServeHTTP(response, request)
			return
		}
		if !strings.HasPrefix(request.URL.Path, "/api/") {
			if (request.Method == http.MethodGet || request.Method == http.MethodHead) &&
				constantTimeTokenEqual(request.URL.Query().Get("access_token"), a.accessToken) {
				a.logAuthBranch("access.local_capability_accepted")
				a.serveIndex(response, a.accessToken)
				return
			}
			a.logAuthBranch("access.local_static_allowed")
			next.ServeHTTP(response, request)
			return
		}
		if a.authorized(request) {
			a.logAuthBranch("access.local_bearer_accepted")
			next.ServeHTTP(response, request)
			return
		}
		a.logAuthBranch("access.local_bearer_rejected")
		writeError(response, http.StatusUnauthorized, "dashboard access token is required")
	})
}

func (a *App) logAuthBranch(branch string) {
	if a.oauth != nil {
		a.oauth.emitAuthBranch(branch)
		return
	}
	serverLog.Printf("oauth branch=%s", branch)
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
		policy := a.config.Proxy
		if len(policy.AllowedHosts) == 0 {
			policy = a.config.AzureProxy
		}
		if !validAzureProxyRequest(request, policy) {
			a.logAuthBranch("access.proxy_rejected")
			http.Error(response, "invalid forwarded request host", http.StatusMisdirectedRequest)
			return
		}
		if publicServiceEndpoint(request.URL.Path) ||
			request.URL.Path == "/api/github/webhook" ||
			strings.HasPrefix(request.URL.Path, "/auth/login") ||
			strings.HasPrefix(request.URL.Path, "/auth/logged-out") ||
			strings.HasPrefix(request.URL.Path, "/auth/callback") {
			a.logAuthBranch("access.public_allowed")
			next.ServeHTTP(response, request)
			return
		}
		var session oauthSession
		var ok bool
		if request.URL.Path == "/auth/logout" || request.URL.Path == "/auth/switch-account" {
			a.logAuthBranch("access.mutation_session_checked")
			session, ok = a.oauth.loadRequestSession(request)
		} else {
			a.logAuthBranch("access.refreshable_session_checked")
			session, ok = a.oauth.session(response, request)
		}
		if !ok {
			if strings.HasPrefix(request.URL.Path, "/api/") || request.URL.Path == "/auth/logout" {
				a.logAuthBranch("access.unauthorized")
				writeError(response, http.StatusUnauthorized, "GitHub authentication is required")
				return
			}
			a.logAuthBranch("access.login_redirected")
			http.Redirect(response, request, "/auth/login", http.StatusFound)
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodHead && request.Method != http.MethodOptions {
			if !constantTimeTokenEqual(request.Header.Get("X-CSRF-Token"), session.CSRFToken) {
				a.logAuthBranch("access.csrf_rejected")
				writeError(response, http.StatusForbidden, "CSRF token is required")
				return
			}
			a.logAuthBranch("access.csrf_accepted")
		} else {
			a.logAuthBranch("access.safe_method")
		}
		a.logAuthBranch("access.authorized")
		request = request.WithContext(context.WithValue(request.Context(), oauthSessionContextKey{}, session))
		next.ServeHTTP(response, request)
	})
}

type oauthSessionContextKey struct{}

func (a *App) adminAuthorized(request *http.Request) bool {
	if a.oauth == nil {
		a.logAuthBranch("admin.local_mode_allowed")
		return true
	}
	session, ok := request.Context().Value(oauthSessionContextKey{}).(oauthSession)
	if !ok {
		a.logAuthBranch("admin.session_missing")
		return false
	}
	for _, login := range a.config.AdminUsers {
		if strings.EqualFold(strings.TrimSpace(login), session.Login) {
			a.logAuthBranch("admin.allowed")
			return true
		}
	}
	a.logAuthBranch("admin.denied")
	return false
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
	serverLog.Printf("health status=%d redis=%t data=%t", status, redisHealthy, active.Generation != "")
	payload := map[string]any{
		"status": "healthy",
		"redis":  map[string]any{"connected": redisHealthy},
		"data":   map[string]any{"available": active.Generation != "", "rebuildRequired": active.Generation == ""},
	}
	if !redisHealthy {
		payload["status"] = "unhealthy"
	}
	detailsAuthorized := a.authorized(request) || (a.oauth != nil && a.oauth.requestHasSession(request))
	if detailsAuthorized {
		if a.oauth != nil {
			a.logAuthBranch("health.details_authorized")
		}
		rowCount := 0
		for _, count := range active.Counts {
			rowCount += count
		}
		payload["revision"] = active.Revision
		payload["generation"] = active.Generation
		payload["counts"] = active.Counts
		payload["sourceCount"] = len(active.Counts)
		payload["rowCount"] = rowCount
	} else if a.oauth != nil {
		a.logAuthBranch("health.details_redacted")
	}
	writeJSON(response, status, payload)
}

func (a *App) readiness(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 3*time.Second)
	defer cancel()
	active, activeErr := a.store.Active(ctx)
	redisHealthy := a.store.Ping(ctx) == nil
	ready := redisHealthy && activeErr == nil && active.Generation != ""
	status := http.StatusOK
	if !ready {
		status = http.StatusServiceUnavailable
	}
	writeJSON(response, status, map[string]any{
		"ready": ready,
		"redis": map[string]any{"connected": redisHealthy},
		"data": map[string]any{
			"available":       active.Generation != "",
			"rebuildRequired": active.Generation == "",
		},
	})
}

func publicServiceEndpoint(path string) bool {
	return path == "/api/v1/health" || path == "/api/health" || path == "/api/readiness"
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
	serverLog.Printf("event stream subscribed")
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
			serverLog.Printf("event stream closed")
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
	ctx, span := telemetry.Tracer().Start(request.Context(), "cao_dashboard.query.execute")
	defer span.End()
	request = request.WithContext(ctx)
	fail := func(status int, message string) {
		span.RecordError(errors.New(message))
		span.SetStatus(codes.Error, message)
		writeError(response, status, message)
	}
	request.Body = http.MaxBytesReader(response, request.Body, 8<<20)
	decoder := json.NewDecoder(request.Body)
	var input queryRequest
	if err := decoder.Decode(&input); err != nil {
		fail(http.StatusBadRequest, "invalid query request")
		return
	}
	if len(input.SourceNames) > 256 || len(input.Aliases) > 256 || len(input.ReplacedSources) > 256 {
		fail(http.StatusBadRequest, "query request exceeds source limits")
		return
	}
	serverLog.Printf(
		"query received sources=%d aliases=%d definitions=%d compiled=%d paginated=%d",
		len(input.SourceNames), len(input.Aliases), len(input.Queries), len(input.CompiledQueries), len(input.Pagination),
	)
	for _, name := range append(append([]string{}, input.SourceNames...), input.Aliases...) {
		if strings.TrimSpace(name) == "" {
			fail(http.StatusBadRequest, "source names must be non-empty")
			return
		}
	}
	active, err := a.store.Active(ctx)
	if err != nil || active.Generation == "" {
		fail(http.StatusServiceUnavailable, "dashboard data is unavailable")
		return
	}
	span.SetAttributes(
		attribute.Int64("cao_dashboard.query.revision", active.Revision),
		attribute.Int("cao_dashboard.query.source_count", len(input.SourceNames)),
		attribute.Int("cao_dashboard.query.alias_count", len(input.Aliases)),
	)
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
	loader := &generationLoader{ctx: ctx, store: a.store, generation: active.Generation}
	engine := query.New(loader)
	sources, metrics, err := engine.Execute(definitions, requested)
	if err != nil {
		serverLog.Printf("query failed")
		fail(http.StatusBadRequest, err.Error())
		return
	}
	for name, page := range input.Pagination {
		source, ok := sources[name]
		if !ok {
			continue
		}
		paginated, err := paginate(source, strconv.FormatInt(active.Revision, 10), page)
		if err != nil {
			fail(http.StatusBadRequest, err.Error())
			return
		}
		sources[name] = paginated
	}
	metrics.DurationMS = time.Since(started).Milliseconds()
	serverLog.Printf("query completed sources=%d duration_ms=%d redis_commands=%d redis_rows=%d", len(sources), metrics.DurationMS, metrics.RedisCommands, metrics.RedisRows)
	span.SetAttributes(
		attribute.Int64("cao_dashboard.query.duration_ms", metrics.DurationMS),
		attribute.Int("cao_dashboard.query.pushed_down_count", len(metrics.PushedDown)),
		attribute.Int("cao_dashboard.query.fallback_count", len(metrics.FallbackOperations)),
	)
	span.SetStatus(codes.Ok, "")
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
	serverLog.Printf("diagnostics served")
	writeJSON(response, http.StatusOK, diagnostics)
}

func (a *App) refresh(response http.ResponseWriter, request *http.Request) {
	active, err := a.store.Active(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "dashboard data is unavailable")
		return
	}
	serverLog.Printf("refresh checked revision=%d", active.Revision)
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
		injections += `<meta name="cao-auth-mode" content="github">`
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
