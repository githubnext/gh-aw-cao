// Package hosting exposes CAO's hosted HTTP service to an externally owned
// listener without exposing its Redis, authentication, or projection internals.
package hosting

import (
	"context"
	"errors"
	"log"
	"net/http"

	"github.com/githubnext/gh-aw-cao/server/internal/server"
)

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

// New requires a hosted policy with target.module=generic and
// target.listener=external. It never opens a socket or weakens CAO's request
// authentication, proxy, CSRF, or rate-limit boundaries.
func New(ctx context.Context, config Config) (*Service, error) {
	if config.SiteDirectory == "" || config.DashboardQueriesPath == "" || config.DatabaseQueriesPath == "" {
		return nil, errors.New("external host requires site, dashboard queries, and database queries paths")
	}
	app, err := server.NewExternallyHostedAppFromEnv(
		ctx, config.SiteDirectory, config.DashboardQueriesPath, config.DatabaseQueriesPath, config.Logger,
	)
	if err != nil {
		return nil, err
	}
	return &Service{app: app, handler: app.Handler()}, nil
}

// Start loads the authoritative projection and starts CAO background tasks.
// Keep ctx alive until after the HTTP host has drained active requests.
func (s *Service) Start(ctx context.Context) error { return s.app.Start(ctx) }

// Handler returns the complete CAO handler, including its security boundary.
// Before Start and after Stop it returns 503 for every request.
func (s *Service) Handler() http.Handler { return s.handler }

// Stop cancels CAO background tasks after the embedding host drains HTTP.
func (s *Service) Stop() { s.app.Stop() }
