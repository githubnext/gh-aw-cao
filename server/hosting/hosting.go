// Package hosting exposes CAO's hosted HTTP service to an externally owned
// listener without exposing its Redis, authentication, or projection internals.
package hosting

import (
	"context"
	"errors"
	"log"
	"net/http"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

var hostingLog = logger.New("cao:hosting")

// Config locates the built dashboard and its declarative query definitions.
// Host policy and credentials are loaded from CAO's reviewed policy and
// deployment environment, never supplied by the embedding HTTP host.
type Config struct {
	SiteDirectory        string
	DashboardQueriesPath string
	DatabaseQueriesPath  string
	Logger               *log.Logger
}

type Service struct {
	app     *server.App
	handler http.Handler
}

// missingConfigField identifies which required Config field is blank, so a
// misconfigured embedding host is diagnosable without logging the
// configured paths themselves.
type missingConfigField string

const (
	missingConfigFieldNone             missingConfigField = "none"
	missingConfigFieldSiteDirectory    missingConfigField = "site-directory"
	missingConfigFieldDashboardQueries missingConfigField = "dashboard-queries"
	missingConfigFieldDatabaseQueries  missingConfigField = "database-queries"
)

// classifyMissingConfig reports the first required Config field that is
// blank, applying the same precedence New previously checked inline. It is
// a pure function extracted from New so this precondition is testable
// without constructing a host policy or a server.App.
func classifyMissingConfig(config Config) missingConfigField {
	switch {
	case config.SiteDirectory == "":
		return missingConfigFieldSiteDirectory
	case config.DashboardQueriesPath == "":
		return missingConfigFieldDashboardQueries
	case config.DatabaseQueriesPath == "":
		return missingConfigFieldDatabaseQueries
	default:
		return missingConfigFieldNone
	}
}

// New requires a hosted policy with target.module=generic and
// target.listener=external. It never opens a socket or weakens CAO's request
// authentication, proxy, CSRF, or rate-limit boundaries.
func New(ctx context.Context, config Config) (*Service, error) {
	if field := classifyMissingConfig(config); field != missingConfigFieldNone {
		hostingLog.Printf("hosting config rejected missing_field=%s", field)
		return nil, errors.New("external host requires site, dashboard queries, and database queries paths")
	}
	app, err := server.NewExternallyHostedAppFromEnv(
		ctx, config.SiteDirectory, config.DashboardQueriesPath, config.DatabaseQueriesPath, config.Logger,
	)
	if err != nil {
		hostingLog.Printf("hosting app construction failed")
		return nil, err
	}
	return &Service{app: app, handler: app.Handler()}, nil
}

// Start loads the authoritative projection and starts CAO background tasks.
// Keep ctx alive until after the HTTP host has drained active requests.
func (s *Service) Start(ctx context.Context) error { return s.app.Start(ctx) }

// Handler returns the complete CAO handler, including its security boundary.
// Before Start and after Drain it returns 503 for every request.
func (s *Service) Handler() http.Handler { return s.handler }

// Drain stops admitting requests and ends SSE streams. Call it before the
// embedding host's http.Server.Shutdown, while the startup context is alive.
func (s *Service) Drain() { s.app.Drain() }

// Stop cancels CAO background tasks and waits until they exit before closing
// the hosted PostgreSQL pool. If ctx expires, the pool stays open; retry Stop
// after tasks finish. Drain the HTTP host before calling Stop.
func (s *Service) Stop(ctx context.Context) error { return s.app.Stop(ctx) }
