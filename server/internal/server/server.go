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
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/marketplace"
	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/query"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
	"github.com/githubnext/gh-aw-cao/server/internal/repositorymemory"
	"github.com/githubnext/gh-aw-cao/server/internal/telemetry"
)

var serverLog = logger.New("cao:server")

type Config struct {
	Listen                 string
	SiteDirectory          string
	CertFile               string
	KeyFile                string
	AccessToken            string
	HostProfile            HostProfile
	SingleReplicaConfirmed bool
	Proxy                  ProxyPolicy
	// CORS is the reviewed cross-origin policy; the zero value is
	// same-origin only.
	CORS                 CORSPolicy
	GitHubOAuth          *GitHubOAuthConfig
	DatabaseQueriesPath  string
	Database             *postgresx.Store
	DashboardQueries     []query.Definition
	DashboardQueriesPath string
	AgentCatalogPath     string
	MCPContractPath      string
	MCPEnabled           bool
	GitHubActionsToken   string
	GitHubActionsActor   string
	ActionsRepository    string
	GitHubAPIURL         string
	ActionsHTTPClient    *http.Client
	SourceDirectory      string
	Reconciler           Reconciler
	Collector            *CollectorConfig
	WebhookSecret        string
	AdminUsers           []string
	Logger               *log.Logger
	// RateLimits overrides inbound request rate limits; the zero value keeps
	// the production defaults.
	RateLimits RateLimitConfig
}

type App struct {
	store           *redisx.Store
	database        *postgresx.Store
	ownedDatabase   *postgresx.Store
	closeDatabase   sync.Once
	closeError      error
	databaseQueries []query.Definition
	config          Config
	accessToken     string
	oauth           *githubOAuth
	hub             *eventHub
	canonical       canonicalService
	reconciler      Reconciler
	memory          *repositorymemory.RemoteResolver
	webhookSecret   []byte
	mcp             http.Handler
	actionsToken    string
	actionsActor    string
	quota           *githubquota.Service
	startMu         sync.Mutex
	startContext    context.Context
	stop            context.CancelFunc
	draining        bool
	drain           chan struct{}
	taskMu          sync.Mutex
	taskCount       int
	tasksDone       chan struct{}
}

func New(ctx context.Context, store *redisx.Store, config Config) (*App, error) {
	if config.Database == nil {
		return nil, errors.New("dashboard Postgres database is required")
	}
	databaseQueries := []query.Definition{{
		Name: "$records", From: "$domains",
		Union: []string{"$tools", "$skills", "$friction", "$audits", "$issues"},
	}}
	if config.DatabaseQueriesPath != "" {
		content, err := os.ReadFile(config.DatabaseQueriesPath)
		if err != nil {
			return nil, fmt.Errorf("read database queries: %w", err)
		}
		parsed, err := query.ParseDefinitions(content)
		if err != nil {
			return nil, err
		}
		databaseQueries = append(databaseQueries, parsed...)
		databaseQueries = append(databaseQueries, rawSourceDefinitions(parsed)...)
	}
	if err := validateHostProfile(store, &config); err != nil {
		return nil, err
	}
	if err := config.RateLimits.validate(); err != nil {
		return nil, err
	}
	cors, err := config.CORS.normalize()
	if err != nil {
		return nil, err
	}
	config.CORS = cors
	profile := config.HostProfile
	serverLog.Printf("initializing host_profile=%s", profile.Name)
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
	if profile.Authentication == HostAuthenticationOAuth {
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
	var quota *githubquota.Service
	var memoryResolver *repositorymemory.RemoteResolver
	if err := validateProfileExclusivity(config); err != nil {
		return nil, err
	}
	if config.Collector != nil {
		collector, err := NewCollector(ctx, store, config.Database, *config.Collector, config.DatabaseQueriesPath)
		if err != nil {
			return nil, fmt.Errorf("configure collection: %w", err)
		}
		quota = collector.quota
		reconciler = collector
		if !config.Collector.AdmitOnly {
			memoryResolver = &repositorymemory.RemoteResolver{
				Cache:         store,
				Installations: collector.enrollment,
				Source:        collector.client,
				Governor: &githubapp.Budget{
					Store: store, Floor: config.Collector.RateLimitFloor, Cost: 1,
				},
				ControlRepository: config.Collector.ControlRepository,
			}
		}
	}
	if reconciler == nil && config.SourceDirectory != "" {
		reconciler = DirectoryReconciler{
			Store: config.Database, Operational: store, SourceDirectory: config.SourceDirectory,
			DatabaseQueriesPath: config.DatabaseQueriesPath,
		}
	}
	if config.MCPEnabled && profile.Authentication == HostAuthenticationOAuth {
		if _, _, err := parseActionsRepository(config.ActionsRepository); err != nil {
			return nil, fmt.Errorf("hosted MCP requires an Actions repository: %w", err)
		}
	}
	actionsToken, actionsActor, err := githubActionsMCPIdentity(config, accessToken)
	if err != nil {
		return nil, err
	}
	if actionsToken != "" {
		if err := verifyGitHubActionsPermissionsAtStartup(config, actionsToken); err != nil {
			return nil, err
		}
	}
	if store != nil && quota == nil {
		quota, err = githubquota.New(store, githubquota.Options{})
		if err != nil {
			return nil, fmt.Errorf("configure github quota: %w", err)
		}
	}
	serverLog.Printf("initialized host_profile=%s oauth=%t source_ingestion=%t", profile.Name, oauth != nil, config.SourceDirectory != "")
	app := &App{
		store: store, database: config.Database, databaseQueries: databaseQueries, config: config, accessToken: accessToken, oauth: oauth, hub: newEventHub(),
		canonical: canonicalService{store: config.Database, definitions: databaseQueries}, reconciler: reconciler, memory: memoryResolver,
		webhookSecret: []byte(config.WebhookSecret), actionsToken: actionsToken, actionsActor: actionsActor,
		quota: quota, drain: make(chan struct{}),
	}
	if config.MCPEnabled {
		handler, err := app.newMCPHandler()
		if err != nil {
			return nil, fmt.Errorf("configure MCP: %w", err)
		}
		app.mcp = handler
	}
	return app, nil
}

func rawSourceDefinitions(definitions []query.Definition) []query.Definition {
	var recordQuery *query.Definition
	declared := make(map[string]bool, len(definitions))
	for i := range definitions {
		declared[definitions[i].Name] = true
		if definitions[i].Name == "run-records" {
			recordQuery = &definitions[i]
		}
	}
	result := make([]query.Definition, 0, 9)
	for _, name := range []string{"jobs", "sessions", "events"} {
		if !declared[name] {
			result = append(result, query.Definition{Name: name, From: "$" + name})
		}
	}
	if recordQuery != nil {
		for _, name := range []string{"domains", "tools", "skills", "friction", "audits", "issues"} {
			if declared[name] {
				continue
			}
			derived := *recordQuery
			derived.Name, derived.From = name, "$"+name
			result = append(result, derived)
		}
	}
	return result
}

//nolint:contextcheck // Startup validation has no request context.
func verifyGitHubActionsPermissionsAtStartup(config Config, token string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return verifyGitHubActionsPermissions(ctx, config, token)
}

// Start initializes the projection and background tasks without taking
// ownership of an HTTP listener. The caller must keep ctx alive while serving
// and call Drain before shutting down its HTTP server, then Stop after HTTP
// requests have drained.
func (a *App) Start(ctx context.Context) error {
	return a.start(ctx, ctx)
}

func (a *App) start(startupCtx, runtimeCtx context.Context) error {
	if a.config.HostProfile.Listener == HostListenerPlatform {
		return fmt.Errorf("host profile %q delegates startup to the platform", a.config.HostProfile.Name)
	}
	a.startMu.Lock()
	defer a.startMu.Unlock()
	if a.startContext != nil {
		return errors.New("dashboard service has already started")
	}
	if a.draining {
		return errors.New("dashboard service has already stopped")
	}
	if err := startupCtx.Err(); err != nil {
		return err
	}
	runCtx, cancel := context.WithCancel(runtimeCtx)
	serverLog.Printf("starting service initial_ingestion=%t", a.config.SourceDirectory != "")
	if a.config.SourceDirectory != "" {
		result, err := ingest.Run(startupCtx, a.database, a.store, a.config.SourceDirectory, ingest.Options{DatabaseQueriesPath: a.config.DatabaseQueriesPath})
		if err != nil {
			cancel()
			return fmt.Errorf("initial ingestion failed: %w", err)
		}
		a.hub.Broadcast(result.Revision)
		a.config.Logger.Printf("activated dashboard revision %d", result.Revision)
	}
	if collector := a.Collector(); collector != nil {
		if err := collector.start(startupCtx, runCtx, a.hub.Broadcast, a.startTask); err != nil {
			a.cancelAndWaitTasks(cancel, startupCtx)
			return fmt.Errorf("start collection: %w", err)
		}
		serverLog.Printf("collection profile started workers=%d", a.config.Collector.Workers)
	}
	if err := startupCtx.Err(); err != nil {
		a.cancelAndWaitTasks(cancel, startupCtx)
		return err
	}
	if err := runCtx.Err(); err != nil {
		a.cancelAndWaitTasks(cancel, startupCtx)
		return err
	}
	a.startContext = runCtx
	a.stop = cancel
	if a.oauth != nil && (a.config.SourceDirectory != "" || a.Collector() != nil) {
		a.startTask(func() { a.oauth.runRevocationWorker(runCtx) })
	}
	return nil
}

// Drain stops admitting requests and ends active SSE streams. The host then
// calls http.Server.Shutdown to wait for ordinary HTTP requests before Stop.
func (a *App) Drain() {
	a.startMu.Lock()
	defer a.startMu.Unlock()
	a.drainLocked()
}

func (a *App) drainLocked() {
	if !a.draining {
		a.draining = true
		if a.drain == nil {
			a.drain = make(chan struct{})
		}
		close(a.drain)
	}
}

// startTask is called under startMu during startup.
func (a *App) startTask(work func()) {
	a.taskMu.Lock()
	if a.taskCount == 0 {
		a.tasksDone = make(chan struct{})
	}
	a.taskCount++
	a.taskMu.Unlock()
	go func() {
		defer a.finishTask()
		work()
	}()
}

func (a *App) finishTask() {
	a.taskMu.Lock()
	defer a.taskMu.Unlock()
	a.taskCount--
	if a.taskCount == 0 {
		close(a.tasksDone)
	}
}

// launchTask tracks work admitted by an HTTP request while the service is
// running. Direct handler users without a started lifecycle retain their
// existing detached-operation behavior.
func (a *App) launchTask(work func()) bool {
	a.startMu.Lock()
	defer a.startMu.Unlock()
	if a.draining || (a.startContext != nil && a.startContext.Err() != nil) {
		return false
	}
	if a.startContext == nil {
		go work()
	} else {
		a.startTask(work)
	}
	return true
}

func (a *App) operationContext(requestCtx context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(requestCtx), projectionTimeout)
	a.startMu.Lock()
	runCtx := a.startContext
	a.startMu.Unlock()
	if runCtx == nil {
		return ctx, cancel
	}
	stop := context.AfterFunc(runCtx, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

// Stop cancels CAO-owned background tasks and waits until they exit or ctx is
// canceled. The external host must call Drain and wait for HTTP shutdown first.
func (a *App) Stop(ctx context.Context) error {
	a.startMu.Lock()
	a.drainLocked()
	if a.stop != nil {
		a.stop()
	}
	a.startMu.Unlock()
	if a.hub != nil {
		a.hub.shutdown()
	}
	if err := a.waitTasks(ctx); err != nil {
		return err
	}
	if a.hub != nil {
		if err := a.hub.wait(ctx); err != nil {
			return err
		}
	}
	if a.ownedDatabase != nil {
		a.closeDatabase.Do(func() { a.closeError = a.ownedDatabase.Close() })
		return a.closeError
	}
	return nil
}

func (a *App) waitTasks(ctx context.Context) error {
	a.taskMu.Lock()
	if a.taskCount == 0 {
		a.taskMu.Unlock()
		return nil
	}
	done := a.tasksDone
	a.taskMu.Unlock()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *App) cancelAndWaitTasks(cancel context.CancelFunc, parent context.Context) {
	cancel()
	ctx, waitCancel := context.WithTimeout(context.WithoutCancel(parent), 5*time.Second)
	defer waitCancel()
	if err := a.waitTasks(ctx); err != nil {
		serverLog.Printf("background startup cleanup failed: %v", err)
	}
}

func (a *App) requireStarted(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		a.startMu.Lock()
		ctx := a.startContext
		draining := a.draining
		a.startMu.Unlock()
		if draining || ctx == nil || ctx.Err() != nil {
			writeError(response, http.StatusServiceUnavailable, "dashboard service is not running")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func (a *App) requireNotDraining(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		a.startMu.Lock()
		draining := a.draining
		a.startMu.Unlock()
		if draining {
			writeError(response, http.StatusServiceUnavailable, "dashboard service is not running")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func (a *App) Serve(ctx context.Context) error {
	if a.config.HostProfile.Listener != HostListenerProcess {
		return fmt.Errorf("host profile %q delegates listener ownership", a.config.HostProfile.Name)
	}
	defer func(ctx context.Context) {
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if err := a.Stop(stopCtx); err != nil {
			serverLog.Printf("background shutdown failed: %v", err)
		}
	}(ctx)
	if err := a.start(ctx, context.WithoutCancel(ctx)); err != nil {
		return err
	}
	serverLog.Printf("starting server tls=%t", a.config.CertFile != "")
	var listenConfig net.ListenConfig
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
	serveDone := make(chan struct{})
	shutdownResult := make(chan error, 1)
	defer close(serveDone)
	go func(ctx context.Context) {
		select {
		case <-ctx.Done():
			a.Drain()
			shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			err := httpServer.Shutdown(shutdown)
			if err != nil {
				serverLog.Printf("HTTP shutdown failed: %v", err)
			}
			shutdownResult <- err
		case <-serveDone:
		}
	}(ctx)
	err = httpServer.Serve(servingListener)
	if errors.Is(err, http.ErrServerClosed) {
		return <-shutdownResult
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
	if a.mcp != nil {
		mux.Handle("POST /mcp", a.mcp)
		routePatterns["POST /mcp"] = struct{}{}
	}
	register("GET /api/v1/diagnostics", a.diagnostics)
	register("GET /api/v1/memory/{campaign}", a.repositoryMemoryCampaign)
	register("GET /api/v1/memory/{campaign}/content", a.repositoryMemoryContent)
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
	register("GET /api/v1/ingestion/health", a.collectionStatus)
	register("GET /api/v1/github-quota/usage", a.gitHubQuotaUsage)
	mux.HandleFunc("/", a.static)
	tracedMux := withResponseTraceHeaders(mux)
	instrumented := otelhttp.NewHandler(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		original := request.Context().Value(originalHTTPRequestKey{}).(*http.Request)
		restored := original.WithContext(request.Context())
		restored.Body = request.Body
		tracedMux.ServeHTTP(response, restored)
	}), telemetry.SpanHTTPServer,
		otelhttp.WithFilter(func(request *http.Request) bool {
			// OAuth callbacks use a dedicated, allowlisted server span instead
			// of the generic HTTP instrumentation.
			return request.Method != http.MethodGet || request.URL.Path != "/auth/callback"
		}),
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
	safeTelemetry := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		safe := request.Clone(context.WithValue(request.Context(), originalHTTPRequestKey{}, request))
		safe.RemoteAddr = ""
		safe.Host = ""
		safe.RequestURI = ""
		safe.Header = make(http.Header)
		if traceparent := request.Header.Get("Traceparent"); traceparent != "" {
			safe.Header.Set("Traceparent", traceparent)
		}
		path := ""
		if _, ok := routePatterns[request.Method+" "+request.URL.Path]; ok {
			path = request.URL.Path
		}
		safe.URL = &url.URL{Path: path}
		switch request.Method {
		case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut,
			http.MethodPatch, http.MethodDelete, http.MethodOptions:
		default:
			safe.Method = ""
		}
		instrumented.ServeHTTP(response, safe)
	})
	handler := a.preAuthRateLimit(a.cors(a.requireAccess(a.rateLimit(safeTelemetry))))
	switch a.config.HostProfile.Listener {
	case HostListenerExternal:
		handler = a.requireStarted(handler)
	case HostListenerProcess:
		handler = a.requireNotDraining(handler)
	case HostListenerPlatform:
	}
	return securityHeaders(handler)
}

type originalHTTPRequestKey struct{}

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
		if !strings.HasPrefix(request.URL.Path, "/api/") && request.URL.Path != "/mcp" {
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
		if request.URL.Path == "/mcp" {
			if actor, ok := a.authorizedGitHubActions(request); ok {
				a.logAuthBranch("access.local_actions_accepted")
				request = request.WithContext(context.WithValue(
					request.Context(), githubActionsActorContextKey{}, actor))
				next.ServeHTTP(response, request)
				return
			}
			a.logAuthBranch("access.local_actions_rejected")
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
	token, ok := bearerToken(request)
	return ok && constantTimeTokenEqual(token, a.accessToken)
}

type githubActionsActorContextKey struct{}

func githubActionsMCPIdentity(config Config, accessToken string) (string, string, error) {
	token := strings.TrimSpace(config.GitHubActionsToken)
	if !config.MCPEnabled || token == "" {
		return "", "", nil
	}
	actor := strings.TrimSpace(config.GitHubActionsActor)
	if len(token) < 32 {
		return "", "", errors.New("GitHub Actions MCP token must contain at least 32 characters")
	}
	if constantTimeTokenEqual(token, accessToken) {
		return "", "", errors.New("GitHub Actions MCP token must differ from the dashboard access token")
	}
	if actor == "" {
		return "", "", errors.New("GitHub Actions MCP actor is required when its token is configured")
	}
	if len(actor) > 100 || strings.IndexFunc(actor, func(value rune) bool {
		return value <= ' ' || value == '\x7f'
	}) >= 0 {
		return "", "", errors.New("GitHub Actions MCP actor is invalid")
	}
	return token, strings.ToLower(actor), nil
}

func (a *App) authorizedGitHubActions(request *http.Request) (string, bool) {
	if a.actionsToken == "" || a.actionsActor == "" {
		return "", false
	}
	token, ok := bearerToken(request)
	actor := strings.ToLower(strings.TrimSpace(request.Header.Get("X-GitHub-Actor")))
	return a.actionsActor, ok &&
		constantTimeTokenEqual(token, a.actionsToken) &&
		constantTimeTokenEqual(actor, a.actionsActor)
}

func bearerToken(request *http.Request) (string, bool) {
	const prefix = "Bearer "
	authorization := request.Header.Get("Authorization")
	return strings.TrimPrefix(authorization, prefix), strings.HasPrefix(authorization, prefix)
}

func (a *App) requireGitHubAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !validProxyRequest(request, a.proxyPolicy()) {
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
		if request.URL.Path == "/mcp" && a.mcp != nil {
			ctx, span := telemetry.Tracer().Start(request.Context(), "cao_dashboard.auth.mcp")
			defer span.End()
			actor, err := verifyHostedActionsMCP(ctx, a.config, request)
			if err != nil {
				a.logAuthBranch("access.hosted_actions_rejected")
				var refusal *hostedMCPRefusal
				code := "authentication_failed"
				if errors.As(err, &refusal) {
					code = refusal.code
				}
				result := map[string]string{
					"error": "GitHub Actions MCP authentication is required",
					"code":  code,
				}
				spanContext := span.SpanContext()
				if spanContext.IsValid() {
					telemetry.SetResponseTraceHeaders(response, spanContext)
					result["traceId"] = spanContext.TraceID().String()
				}
				serverLog.Printf("hosted MCP authentication rejected code=%s trace_id=%s", code, result["traceId"])
				writeJSON(response, http.StatusUnauthorized, result)
				return
			}
			a.logAuthBranch("access.hosted_actions_accepted")
			next.ServeHTTP(response, request.WithContext(context.WithValue(
				request.Context(), githubActionsActorContextKey{}, actor)))
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
			if !navigationRequest(request) {
				// Subresource fetches (web app manifest, service worker,
				// scripts) must not follow a redirect to the cross-origin
				// GitHub authorize endpoint, which browsers block by CORS.
				a.logAuthBranch("access.subresource_unauthorized")
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

// navigationRequest reports whether a request may enter the GitHub login
// flow. Browsers identify subresources and embedded navigations with Fetch
// Metadata; clients that omit these headers keep the existing behavior.
func navigationRequest(request *http.Request) bool {
	mode := request.Header.Get("Sec-Fetch-Mode")
	destination := request.Header.Get("Sec-Fetch-Dest")
	return (mode == "" || mode == "navigate") &&
		(destination == "" || destination == "document")
}

func (a *App) proxyPolicy() ProxyPolicy {
	return a.config.Proxy
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
	active, activeErr := a.database.State(ctx)
	redisHealthy := a.store.Ping(ctx) == nil
	status := http.StatusOK
	if !redisHealthy || activeErr != nil {
		status = http.StatusServiceUnavailable
	}
	serverLog.Printf("health status=%d redis=%t data=%t", status, redisHealthy, active.Ready)
	payload := map[string]any{
		"status": "healthy",
		"redis":  map[string]any{"connected": redisHealthy},
		"data":   map[string]any{"available": active.Ready, "rebuildRequired": !active.Ready},
	}
	if status != http.StatusOK {
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
	active, activeErr := a.database.State(ctx)
	redisHealthy := a.store.Ping(ctx) == nil
	ready := redisHealthy && activeErr == nil && active.Ready
	status := http.StatusOK
	if !ready {
		status = http.StatusServiceUnavailable
	}
	writeJSON(response, status, map[string]any{
		"ready": ready,
		"redis": map[string]any{"connected": redisHealthy},
		"data": map[string]any{
			"available":       active.Ready,
			"rebuildRequired": !active.Ready,
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
	if err := http.NewResponseController(response).SetWriteDeadline(time.Time{}); err != nil &&
		!errors.Is(err, http.ErrNotSupported) {
		serverLog.Printf("event stream requires a response writer with deadline control: %v", err)
		writeError(response, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Connection", "keep-alive")
	allowHealth := a.adminAuthorized(request)
	channel := a.hub.Subscribe(a, allowHealth)
	if channel == nil {
		return
	}
	defer a.hub.Unsubscribe(channel)
	active, _ := a.database.State(request.Context())
	healthRevision, _ := a.ingestionHealthRevision(request.Context(), allowHealth)
	writeEvent(response, active.Revision, healthRevision)
	flusher.Flush()
	lastRevision := active.Revision
	lastHealthRevision := healthRevision
	serverLog.Printf("event stream subscribed")
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	a.startMu.Lock()
	drain := a.drain
	a.startMu.Unlock()
	for {
		select {
		case <-drain:
			serverLog.Printf("event stream drained")
			return
		case observation, ok := <-channel:
			if !ok {
				return
			}
			healthRevision := int64(0)
			if allowHealth {
				healthRevision = observation.healthRevision
			}
			if observation.revision != lastRevision || healthRevision != lastHealthRevision {
				writeEvent(response, observation.revision, healthRevision)
				flusher.Flush()
				lastRevision = observation.revision
				lastHealthRevision = healthRevision
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

func (a *App) ingestionHealthRevision(ctx context.Context, allowed bool) (int64, error) {
	if !allowed {
		return 0, nil
	}
	_, events, err := a.store.IngestionHealth(ctx)
	if err != nil {
		return 0, err
	}
	revision, err := strconv.ParseInt(events["healthRevision"], 10, 64)
	if err != nil && events["healthRevision"] == "" {
		return 0, nil
	}
	return revision, err
}

func writeEvent(writer io.Writer, revision, healthRevision int64) {
	payload, _ := json.Marshal(map[string]int64{
		"revision": revision, "healthRevision": healthRevision,
	})
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
	ctx, span := telemetry.Tracer().Start(request.Context(), telemetry.SpanQueryExecute)
	defer span.End()
	request = request.WithContext(ctx)
	fail := func(status int, message string) {
		if status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, "query execution failed")
		}
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
	result, status, err := a.executeQuery(ctx, input, a.adminAuthorized(request))
	if err != nil {
		writeQueryError(response, status, err)
		return
	}

	result.Metrics.RateLimitCost = queryRateLimitCost(result.Metrics)
	if status, err := a.chargeQueryRateLimit(ctx, response, result.Metrics.RateLimitCost); err != nil {
		fail(status, err.Error())
		return
	}
	span.SetAttributes(queryTelemetryAttributes(input, result)...)
	span.SetStatus(codes.Ok, "")
	writeJSON(response, http.StatusOK, result)
}

func writeQueryError(response http.ResponseWriter, status int, err error) {
	var limitErr *query.PlanLimitError
	if errors.As(err, &limitErr) {
		writeJSON(response, http.StatusUnprocessableEntity, map[string]string{
			"error": limitErr.Error(), "code": "query_plan_too_large", "queryId": limitErr.QueryID, "boundary": limitErr.Boundary,
		})
		return
	}
	writeError(response, status, err.Error())
}

type queryResponse struct {
	Revision       int64                   `json:"revision"`
	HealthRevision int64                   `json:"healthRevision,omitempty"`
	EvaluatedAt    string                  `json:"evaluatedAt"`
	Sources        map[string]model.Source `json:"sources"`
	Metrics        model.Metrics           `json:"metrics"`
}

func (a *App) executeQuery(ctx context.Context, input queryRequest, allowCollectionHealth bool) (queryResponse, int, error) {
	if a.database == nil {
		return queryResponse{}, http.StatusServiceUnavailable, errors.New("dashboard data is unavailable")
	}
	var response queryResponse
	var status int
	err := a.database.WithReadTransaction(ctx, func(reader postgresx.SourceReader) error {
		var queryErr error
		response, status, queryErr = a.executeQueryWithReader(ctx, input, allowCollectionHealth, reader)
		return queryErr
	})
	if err != nil && status == 0 {
		status = http.StatusServiceUnavailable
	}
	return response, status, err
}

func (a *App) executeQueryWithReader(ctx context.Context, input queryRequest, allowCollectionHealth bool, reader postgresx.SourceReader) (queryResponse, int, error) {
	active, err := reader.State(ctx)
	if err != nil || !active.Ready {
		return queryResponse{}, http.StatusServiceUnavailable, errors.New("dashboard data is unavailable")
	}
	evaluatedAt := evaluationTime(active)
	healthRevision := int64(0)
	if allowCollectionHealth {
		_, events, healthErr := a.store.IngestionHealth(ctx)
		if healthErr == nil {
			healthRevision, _ = strconv.ParseInt(events["healthRevision"], 10, 64)
		}
	}
	if len(input.SourceNames) == 0 && len(input.Aliases) == 0 {
		return queryResponse{
			Revision: active.Revision, HealthRevision: healthRevision, EvaluatedAt: evaluatedAt,
			Sources: map[string]model.Source{},
			Metrics: model.Metrics{PushedDown: []string{}, FallbackOperations: []string{}},
		}, http.StatusOK, nil
	}
	definitions := append([]query.Definition{}, a.databaseQueries...)
	definitions = append(definitions, a.config.DashboardQueries...)
	if len(input.Queries) > 0 {
		definitions = append(append([]query.Definition{}, a.databaseQueries...), input.Queries...)
	}
	definitions = append(definitions, input.CompiledQueries...)
	ResolveQueryContext(definitions, evaluatedAt)
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
	loader := &databaseLoader{
		ctx: ctx, database: reader, operational: a.store, dataRevision: active.DataRevision,
		app: a, allowCollectionHealth: allowCollectionHealth,
	}
	engine := query.New(loader)
	sources, metrics, err := engine.Execute(definitions, requested)
	if err != nil {
		serverLog.Printf("query failed")
		return queryResponse{}, http.StatusBadRequest, err
	}
	for name, page := range input.Pagination {
		source, ok := sources[name]
		if !ok {
			continue
		}
		paginated, err := paginate(source, strconv.FormatInt(active.Revision, 10), page)
		if err != nil {
			return queryResponse{}, http.StatusBadRequest, err
		}
		sources[name] = paginated
	}
	metrics.DurationMS = time.Since(started).Milliseconds()
	serverLog.Printf("query completed sources=%d duration_ms=%d", len(sources), metrics.DurationMS)
	return queryResponse{
		Revision: active.Revision, HealthRevision: healthRevision,
		EvaluatedAt: evaluatedAt, Sources: sources, Metrics: metrics,
	}, http.StatusOK, nil
}

type databaseLoader struct {
	ctx                   context.Context
	database              postgresx.SourceReader
	operational           *redisx.Store
	dataRevision          string
	app                   *App
	allowCollectionHealth bool
}

// sourceOnlyLoader keeps the original bounded Go evaluator available for any
// complete plan outside the native compiler's proven semantic subset.
type sourceOnlyLoader struct{ loader *databaseLoader }

func (only sourceOnlyLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	return only.loader.LoadSource(name, definition)
}

func (loader *databaseLoader) ExecutePlan(definitions []query.Definition, requested, order []string) (map[string]model.Source, model.Metrics, error) {
	if native, ok := loader.database.(postgresx.NativePlanExecutor); ok {
		runtime := map[string]bool{}
		for _, name := range RuntimeQuerySourceNames() {
			runtime[name] = true
		}
		registered := false
		for _, name := range order {
			if runtime[name] {
				registered = true
				break
			}
			for _, definition := range definitions {
				if definition.Name != name {
					continue
				}
				if runtime[definition.From] {
					registered = true
					break
				}
				for _, source := range definition.Union {
					registered = registered || runtime[source]
				}
				for _, join := range definition.Joins {
					registered = registered || runtime[join.Source]
				}
			}
		}
		if !registered {
			result, metrics, supported, err := native.ExecuteNativePlan(loader.ctx, definitions, requested, order)
			if supported {
				return result, metrics, err
			}
		}
	}
	return query.New(sourceOnlyLoader{loader: loader}).Execute(definitions, requested)
}

func (loader *databaseLoader) LoadSource(name string, definition *query.Definition) (model.Source, model.Metrics, error) {
	if name == simulationDaysSourceName {
		return simulationDaysSource(), model.Metrics{}, nil
	}
	if name == collectionHealthSourceName {
		source, err := loader.app.collectionHealthSource(loader.ctx, loader.allowCollectionHealth)
		return source, model.Metrics{}, err
	}

	if name == gitHubQuotaUsageSourceName {
		source, err := loader.app.gitHubQuotaUsageSource(loader.ctx, loader.allowCollectionHealth)
		return source, model.Metrics{}, err
	}
	if name == marketplace.SourceName {
		// The marketplace catalog is never stored as an ingested Redis source:
		// it is resolved (and cached) transparently here so every query-engine
		// caller sees an ordinary source, with no secrets ever leaving this call.
		return marketplaceSource(loader.ctx, loader.operational, loader.dataRevision), model.Metrics{}, nil
	}
	source, metrics, err := loader.database.LoadSource(loader.ctx, name, definition)
	if errors.Is(err, postgresx.ErrSourceUnavailable) {
		return unavailableSource(name), metrics, nil
	}
	return source, metrics, err
}

// RuntimeQuerySourceNames lists sources resolved by the server rather than
// stored as Postgres dashboard entities.
func RuntimeQuerySourceNames() []string {
	return []string{collectionHealthSourceName, gitHubQuotaUsageSourceName, marketplace.SourceName, simulationDaysSourceName}
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
	active, err := a.database.State(request.Context())
	if err != nil || !active.Ready {
		writeError(response, http.StatusServiceUnavailable, "dashboard data is unavailable")
		return
	}
	diagnostics, err := a.database.Diagnostics(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "dashboard diagnostics are unavailable")
		return
	}
	serverLog.Printf("diagnostics served")
	writeJSON(response, http.StatusOK, diagnostics)
}

func (a *App) refresh(response http.ResponseWriter, request *http.Request) {
	active, err := a.database.State(request.Context())
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

func evaluationTime(active postgresx.State) string {
	if !active.EvaluatedAt.IsZero() {
		return active.EvaluatedAt.UTC().Format(time.RFC3339Nano)
	}
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// ResolveQueryContext binds the ingestion evaluation time to dashboard queries.
func ResolveQueryContext(definitions []query.Definition, evaluatedAt string) {
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
	if strings.HasPrefix(request.URL.Path, "/api/") || request.URL.Path == "/mcp" {
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
	injections := `<meta name="dashboard-data-backend" content="server-http">`
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
	clients map[chan eventObservation]bool
	current eventObservation
	cancel  context.CancelFunc
	wake    chan struct{}
	workers sync.WaitGroup
	stopped bool
	done    chan struct{}
}

type eventObservation struct {
	revision       int64
	healthRevision int64
}

func newEventHub() *eventHub {
	return &eventHub{clients: map[chan eventObservation]bool{}, wake: make(chan struct{}, 1)}
}

func (hub *eventHub) Subscribe(app *App, allowHealth bool) chan eventObservation {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.stopped {
		return nil
	}
	channel := make(chan eventObservation, 1)
	hub.clients[channel] = allowHealth
	if hub.cancel == nil {
		ctx, cancel := context.WithCancel(context.Background())
		hub.cancel = cancel
		hub.workers.Add(1)
		go hub.observe(ctx, app)
	}
	return channel
}

func (hub *eventHub) Unsubscribe(channel chan eventObservation) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	delete(hub.clients, channel)
	close(channel)
	if len(hub.clients) == 0 && hub.cancel != nil {
		hub.cancel()
		hub.cancel = nil
	}
}

func (hub *eventHub) Broadcast(revision int64) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	hub.current.revision = revision
	hub.publishLocked()
	select {
	case hub.wake <- struct{}{}:
	default:
	}
}

func (hub *eventHub) publishLocked() {
	for channel := range hub.clients {
		select {
		case channel <- hub.current:
		default:
			// A slow stream needs the latest state, not every intermediate revision.
			select {
			case <-channel:
			default:
			}
			select {
			case channel <- hub.current:
			default:
			}
		}
	}
}

func (hub *eventHub) observe(ctx context.Context, app *App) {
	defer hub.workers.Done()
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
		case <-hub.wake:
		}
		hub.mu.Lock()
		needsHealth := false
		for _, allowed := range hub.clients {
			needsHealth = needsHealth || allowed
		}
		hub.mu.Unlock()
		active, err := app.database.State(ctx)
		if err != nil {
			continue
		}
		healthRevision, healthErr := app.ingestionHealthRevision(ctx, needsHealth)
		hub.mu.Lock()
		if ctx.Err() == nil {
			changed := hub.current.revision != active.Revision ||
				(needsHealth && healthErr == nil && hub.current.healthRevision != healthRevision)
			if healthErr == nil && changed {
				hub.current = eventObservation{revision: active.Revision, healthRevision: healthRevision}
				hub.publishLocked()
			}
		}
		hub.mu.Unlock()
	}
}

func (hub *eventHub) shutdown() {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.stopped {
		return
	}
	hub.stopped = true
	if hub.cancel != nil {
		hub.cancel()
		hub.cancel = nil
	}
	hub.done = make(chan struct{})
	go func() {
		hub.workers.Wait()
		close(hub.done)
	}()
}

func (hub *eventHub) wait(ctx context.Context) error {
	select {
	case <-hub.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// dashboardQueriesShape identifies which JSON shape decodeDashboardQueries
// found the query definitions in. It is useful for diagnosing a
// misconfigured or newly wrapped queries file without logging the file's
// path or contents.
type dashboardQueriesShape string

const (
	dashboardQueriesShapeArray     dashboardQueriesShape = "array"
	dashboardQueriesShapeQueries   dashboardQueriesShape = "queries"
	dashboardQueriesShapeDashboard dashboardQueriesShape = "dashboard.queries"
)

// decodeDashboardQueries parses the raw bytes of a dashboard query file into
// its definitions and which JSON shape supplied them. It accepts a bare
// top-level array of query.Definition, or a wrapped document exposing them
// under "queries" or, failing that, "dashboard.queries". It is a pure
// function over already-read bytes, so every shape ParseDashboardQueries
// accepts is testable without a file on disk.
func decodeDashboardQueries(content []byte) ([]query.Definition, dashboardQueriesShape, error) {
	var definitions []query.Definition
	if json.Unmarshal(content, &definitions) == nil {
		return definitions, dashboardQueriesShapeArray, nil
	}
	var document struct {
		Queries   []query.Definition `json:"queries"`
		Dashboard struct {
			Queries []query.Definition `json:"queries"`
		} `json:"dashboard"`
	}
	if err := json.Unmarshal(content, &document); err != nil {
		return nil, "", fmt.Errorf("parse dashboard query file: %w", err)
	}
	if len(document.Queries) > 0 {
		return document.Queries, dashboardQueriesShapeQueries, nil
	}
	return document.Dashboard.Queries, dashboardQueriesShapeDashboard, nil
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
	definitions, shape, err := decodeDashboardQueries(content)
	if err != nil {
		return nil, err
	}
	serverLog.Printf("dashboard queries parsed shape=%s count=%d", shape, len(definitions))
	return definitions, nil
}

func ParsePort(address string) int {
	_, port, _ := net.SplitHostPort(address)
	value, _ := strconv.Atoi(port)
	return value
}
