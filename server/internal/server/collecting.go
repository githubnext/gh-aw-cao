package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/collect"
	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/ingest"
	"github.com/githubnext/gh-aw-cao/server/internal/redisx"
)

// defaultQueueMaxLength bounds the task and dead-letter streams. Acked stream
// entries persist until trimmed, so an untrimmed queue grows monotonically
// with event volume rather than with outstanding work.
const defaultQueueMaxLength = 200_000

// CollectorConfig configures the optional server collection profile.
//
// Leaving it nil selects the default Actions profile, in which the server
// ingests snapshots published by the Activity workflow and performs no GitHub
// collection of its own.
type CollectorConfig struct {
	// AppID and PrivateKeyPEM authenticate the GitHub App whose installations
	// define ingestion scope.
	AppID         int64
	PrivateKeyPEM []byte
	BaseURL       string
	UploadURL     string

	// LakeDirectory holds collected evidence in the published snapshot layout.
	LakeDirectory string
	// CatalogRoot contains activity/cao.mjs.
	CatalogRoot string
	// ControlRepository names the control repository for inventory discovery.
	ControlRepository string

	NodeBinary   string
	GitHubBinary string

	WindowDays            int
	RunLimit              int
	MaxStorageMB          int
	RequestTimeoutMinutes int
	RateLimitFloor        int
	MinProjectionInterval time.Duration
	// RetainGenerations bounds superseded canonical generations kept in Redis
	// for rollback. Zero selects the shared default.
	RetainGenerations int
	// InventoryLimit optionally caps enrolled repositories named during
	// inventory discovery. Zero means unbounded; exceeding a configured limit
	// fails the projection rather than publishing a partial inventory.
	InventoryLimit    int
	CollectionTimeout time.Duration

	// Workers enables in-process collection workers. Deployments that scale
	// collection separately leave this zero and run the collect role instead.
	Workers int
	// Consumer identifies this process within the consumer group.
	Consumer string
	// RecoverDeliveries enables webhook delivery replay for gap recovery.
	RecoverDeliveries bool
	// QueueMaxLength bounds the task and dead-letter streams so an unattended
	// queue cannot grow Redis without bound.
	QueueMaxLength int
	// AdmitOnly runs the admission half of the profile alone: the process
	// verifies deliveries and enqueues work, and never collects or projects.
	// It therefore needs no App private key and no evidence lake, which keeps
	// the internet-facing front end from holding credentials it cannot use.
	AdmitOnly bool
}

// Validate reports whether the collector can be constructed.
func (config *CollectorConfig) Validate() error {
	if config == nil {
		return nil
	}
	if config.AppID <= 0 {
		return errors.New("collection requires a GitHub App identifier")
	}
	if config.AdmitOnly {
		// Admission verifies deliveries against the webhook secret and writes
		// to Redis. Requiring collection credentials here would place the App
		// private key in a process that never calls GitHub.
		if len(config.PrivateKeyPEM) > 0 {
			return errors.New(
				"admission-only collection must not be given the App private key; " +
					"it never calls GitHub")
		}
		if config.Workers > 0 {
			return errors.New("admission-only collection cannot run workers")
		}
		if config.RecoverDeliveries {
			return errors.New("admission-only collection cannot replay deliveries")
		}
	} else {
		if len(config.PrivateKeyPEM) == 0 {
			return errors.New("collection requires a GitHub App private key")
		}
		if strings.TrimSpace(config.LakeDirectory) == "" {
			return errors.New("collection requires an evidence lake directory")
		}
		if strings.TrimSpace(config.CatalogRoot) == "" {
			return errors.New("collection requires the catalog root containing activity/cao.mjs")
		}
	}
	if config.QueueMaxLength <= 0 {
		config.QueueMaxLength = defaultQueueMaxLength
	}
	return nil
}

// Collector is the assembled collection profile. It satisfies Reconciler, so
// the existing rebuild and webhook plumbing works unchanged, and additionally
// satisfies EventAdmitter, so deliveries are queued instead of projected
// inline.
type Collector struct {
	config     CollectorConfig
	client     *githubapp.Client
	enrollment collect.Enrollment
	queue      collect.Queue
	lake       collect.Lake
	runner     collect.Runner
	projector  collect.Projector
	admitter   collect.Admitter
	backfill   collect.Backfill
	reporter   collect.Reporter
	replayer   collect.DeliveryReplayer
}

var _ Reconciler = (*Collector)(nil)
var _ EventAdmitter = (*Collector)(nil)

// NewCollector assembles the collection profile from configuration.
func NewCollector(store *redisx.Store, config CollectorConfig, databaseQueriesPath string) (*Collector, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if store == nil {
		return nil, errors.New("collection requires Redis")
	}
	enrollment := collect.Enrollment{Store: store}
	queue := collect.Queue{Store: store, MaxLength: int64(config.QueueMaxLength)}
	if config.AdmitOnly {
		// Erasure is enqueued rather than performed, because this process has
		// no evidence lake to erase from.
		return &Collector{
			config:     config,
			enrollment: enrollment,
			queue:      queue,
			admitter:   collect.Admitter{Enrollment: enrollment, Queue: queue},
			reporter: collect.Reporter{
				Enrollment: enrollment, Queue: queue, Store: store,
			},
		}, nil
	}
	client, err := githubapp.New(githubapp.Config{
		AppID:         config.AppID,
		PrivateKeyPEM: config.PrivateKeyPEM,
		BaseURL:       config.BaseURL,
		UploadURL:     config.UploadURL,
	})
	if err != nil {
		return nil, err
	}
	lake := collect.Lake{Directory: config.LakeDirectory}
	if err := lake.Prepare(); err != nil {
		return nil, err
	}
	budget := &githubapp.Budget{Store: store, Floor: config.RateLimitFloor}
	runner := collect.Runner{
		Lake:                  lake,
		CatalogRoot:           config.CatalogRoot,
		NodeBinary:            config.NodeBinary,
		GitHubBinary:          config.GitHubBinary,
		WindowDays:            config.WindowDays,
		RunLimit:              config.RunLimit,
		MaxStorageMB:          config.MaxStorageMB,
		RequestTimeoutMinutes: config.RequestTimeoutMinutes,
		Timeout:               config.CollectionTimeout,
		Tokens:                client,
		Budget:                budget,
	}
	if err := runner.Validate(); err != nil {
		return nil, err
	}
	projector := collect.Projector{
		Store:                    store,
		Lake:                     lake,
		Enrollment:               enrollment,
		CatalogRoot:              config.CatalogRoot,
		NodeBinary:               config.NodeBinary,
		DatabaseQueriesPath:      databaseQueriesPath,
		ControlRepository:        config.ControlRepository,
		MinInterval:              config.MinProjectionInterval,
		RetainGenerations:        config.RetainGenerations,
		InventoryRepositoryLimit: config.InventoryLimit,
	}
	backfill := collect.Backfill{
		Store: store, Enrollment: enrollment, Queue: queue,
		Projector: projector, Lake: lake, Enumerator: client,
	}
	return &Collector{
		config:     config,
		client:     client,
		enrollment: enrollment,
		queue:      queue,
		lake:       lake,
		runner:     runner,
		projector:  projector,
		admitter: collect.Admitter{
			Enrollment: enrollment, Queue: queue,
			Lake: &lake, Projection: projector,
		},
		backfill: backfill,
		reporter: collect.Reporter{
			Enrollment: enrollment, Queue: queue, Backfill: backfill,
			Budget: budget, Store: store,
		},
		replayer: collect.DeliveryReplayer{
			Store: store, Client: client, Enabled: config.RecoverDeliveries,
		},
	}, nil
}

// Rebuild reprojects the evidence lake. Cold start and recovery both reuse the
// existing administrative rebuild endpoint through this method.
func (c *Collector) Rebuild(ctx context.Context) (ingest.Result, error) {
	if c.config.AdmitOnly {
		return ingest.Result{}, ErrAdmitOnly
	}
	populated, err := c.lake.Populated()
	if err != nil {
		return ingest.Result{}, err
	}
	if populated {
		return c.projector.Rebuild(ctx)
	}
	state, err := c.backfill.Run(ctx)
	if err != nil {
		return ingest.Result{}, err
	}
	return ingest.Result{Revision: state.Revision}, nil
}

// Reconcile is the lease-taking path the default profile uses. Collection
// never needs it because Admit is preferred, but implementing it keeps the
// Reconciler contract total.
func (c *Collector) Reconcile(ctx context.Context, event GitHubWebhook) (ingest.Result, error) {
	if _, err := c.admitter.Admit(ctx, event.Event, event.Payload); err != nil {
		if errors.Is(err, collect.ErrNotEnrolled) {
			return ingest.Result{}, nil
		}
		return ingest.Result{}, err
	}
	if c.config.AdmitOnly {
		// Admission is complete; a collection worker projects.
		return ingest.Result{}, nil
	}
	return c.projector.Project(ctx)
}

// Admit queues collection for one verified delivery without taking the global
// projection lease, so concurrent deliveries never contend.
func (c *Collector) Admit(ctx context.Context, event GitHubWebhook) (map[string]any, error) {
	admission, err := c.admitter.Admit(ctx, event.Event, event.Payload)
	if err != nil {
		if errors.Is(err, collect.ErrNotEnrolled) {
			// Out-of-scope repositories are acknowledged, not retried.
			return map[string]any{"ignored": true, "reason": "not-enrolled"}, nil
		}
		return nil, err
	}
	return map[string]any{"kind": string(admission.Kind), "queued": admission.Enqueued}, nil
}

// Start launches cold start, in-process workers, and delivery recovery.
func (c *Collector) Start(ctx context.Context, onProjection func(revision int64)) error {
	if err := c.queue.Ensure(ctx); err != nil {
		return err
	}
	if c.config.AdmitOnly {
		// Nothing to start: this process only admits deliveries.
		return nil
	}
	go func() {
		if _, err := c.backfill.Run(ctx); err != nil && ctx.Err() == nil {
			serverLog.Printf("cold start failed")
		}
	}()
	for index := 0; index < c.config.Workers; index++ {
		worker := collect.Worker{
			Queue:        c.queue,
			Runner:       c.runner,
			Projector:    c.projector,
			Consumer:     fmt.Sprintf("%s-%d", c.consumer(), index),
			Project:      true,
			OnProjection: onProjection,
		}
		go func() {
			if err := worker.Run(ctx); err != nil && ctx.Err() == nil {
				serverLog.Printf("collection worker stopped")
			}
		}()
	}
	if c.config.RecoverDeliveries {
		go c.recoverDeliveries(ctx)
	}
	return nil
}

func (c *Collector) consumer() string {
	if name := strings.TrimSpace(c.config.Consumer); name != "" {
		return name
	}
	return "server"
}

func (c *Collector) recoverDeliveries(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := c.replayer.Recover(ctx); err != nil {
				serverLog.Printf("delivery recovery failed")
			}
		}
	}
}

// ErrAdmitOnly reports an operation that requires collection credentials and
// an evidence lake on a process configured to admit deliveries only.
var ErrAdmitOnly = errors.New(
	"this process admits deliveries only; run the collect or backfill role")

// Worker builds a standalone collection worker for the collect role.
func (c *Collector) Worker(consumer string) collect.Worker {
	return collect.Worker{
		Queue: c.queue, Runner: c.runner, Projector: c.projector,
		Consumer: consumer, Project: true,
	}
}

// Backfill exposes cold start for the backfill role.
func (c *Collector) Backfill() collect.Backfill { return c.backfill }

// validateProfileExclusivity enforces that exactly one ingestion profile is
// configured. The Actions profile ingests snapshots published by the Activity
// workflow; the collection profile acquires evidence directly. Running both
// against one deployment would give two writers for one canonical database, so
// a dual configuration is rejected at startup rather than resolved silently.
func validateProfileExclusivity(config Config) error {
	if config.Collector == nil {
		return nil
	}
	if strings.TrimSpace(config.SourceDirectory) != "" {
		return errors.New(
			"collection and published-snapshot ingestion are alternatives: " +
				"configure either a source directory or collection, not both")
	}
	if config.Reconciler != nil {
		return errors.New("collection replaces the configured reconciler; configure only one")
	}
	if strings.TrimSpace(config.WebhookSecret) == "" {
		return errors.New("collection requires a webhook secret")
	}
	return config.Collector.Validate()
}

// Collector reports the assembled collection profile, or nil in the Actions
// profile.
func (a *App) Collector() *Collector {
	collector, _ := a.reconciler.(*Collector)
	return collector
}

// collectionStatus reports collection health. In the Actions profile it
// reports that collection is not configured rather than failing.
func (a *App) collectionStatus(response http.ResponseWriter, request *http.Request) {
	if !a.adminAuthorized(request) {
		writeError(response, http.StatusForbidden, "administrative authorization is required")
		return
	}
	collector, ok := a.reconciler.(*Collector)
	if !ok {
		writeJSON(response, http.StatusOK, collect.Status{Configured: false})
		return
	}
	status, err := collector.reporter.Snapshot(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "collection status is unavailable")
		return
	}
	writeJSON(response, http.StatusOK, status)
}
