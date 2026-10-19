package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/githubnext/gh-aw-cao/server/internal/localpreview"
	"github.com/githubnext/gh-aw-cao/server/preview"
)

func newServeLocalCommand() *cobra.Command {
	var options localpreview.Options
	var host, backend, tracePath, caoURL string
	var port, concurrency int
	var replace, control, acknowledgeRecovery bool
	command := &cobra.Command{
		Use: "serve-local", Short: "Serve a local SQLite dashboard without Node.js, PostgreSQL or Redis",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) (err error) {
			if backend != "sqlite" && backend != "indexeddb" {
				return errors.New("--data-backend must be sqlite or indexeddb; use serve-hosted for PostgreSQL")
			}
			if host != "localhost" && net.ParseIP(host) == nil {
				return errors.New("--host must be a numeric IP address or localhost")
			}
			if port < 0 || port > 65535 {
				return errors.New("--port must be from 0 through 65535")
			}
			if options.Admin && (options.Canvas || host != "localhost" && !net.ParseIP(host).IsLoopback()) {
				return errors.New("--admin requires a loopback host and cannot be combined with --canvas")
			}
			if options.Workspace == "" {
				options.Workspace, err = os.Getwd()
				if err != nil {
					return err
				}
			}
			options.Workspace, err = filepath.EvalSymlinks(options.Workspace)
			if err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			if concurrency < 1 || concurrency > 32 {
				return errors.New("--command-concurrency must be from 1 through 32")
			}
			if !options.Canvas && !options.Admin && (cmd.Flags().Changed("command-concurrency") || acknowledgeRecovery) {
				return errors.New("command scheduling options require --canvas or --admin")
			}
			if options.Canvas && replace {
				return errors.New("--replace-existing cannot be used with --canvas")
			}
			if options.Canvas && !control {
				return errors.New("canvas mode requires trusted CLI action approval through the canvas host")
			}
			if options.Canvas && !cmd.Flags().Changed("port") {
				port = 0
			}
			if replace {
				release, err := replaceDashboardProcess(ctx, options.Workspace, port)
				if err != nil {
					return err
				}
				defer func() { err = errors.Join(err, release()) }()
			}
			workspace, err := localpreview.Prepare(ctx, options)
			if err != nil {
				return err
			}
			defer func() { err = errors.Join(err, workspace.Close()) }()
			trace, err := newDashboardTrace(options.Workspace, tracePath)
			if err != nil {
				return err
			}
			defer func() { err = errors.Join(err, trace.Close()) }()
			var transport *preview.Control
			if control {
				transport = preview.NewControl(cmd.InOrStdin(), cmd.OutOrStdout())
			}
			var server *preview.Server
			var running atomic.Pointer[preview.Server]
			serviceOptions := preview.WorkspaceOptions{
				Workspace: options.Workspace, SourceDirectory: workspace.SourceDirectory,
				GHExecutable: options.GHExecutable, Repository: options.Repository, Admin: options.Admin, Canvas: options.Canvas,
				Dashboard: workspace.Dashboard, SaveDashboard: workspace.SaveDashboard,
				QueueConcurrency: concurrency, AcknowledgeRecovery: acknowledgeRecovery, CaoURL: caoURL,
				OnQueueChanged: func() {
					if active := running.Load(); active != nil {
						active.Changed()
					}
				},
			}
			if transport != nil && options.Canvas {
				serviceOptions.Approve = func(ctx context.Context, action map[string]any) (bool, error) {
					var approved bool
					err := transport.Call(ctx, "approve", action, &approved)
					return approved, err
				}
			}
			operations, err := preview.NewWorkspaceOperations(ctx, serviceOptions)
			if err != nil {
				return err
			}
			defer func() { err = errors.Join(err, operations.Close()) }()
			config := preview.Config{
				Listen: net.JoinHostPort(host, fmt.Sprint(port)), Workspace: options.Workspace,
				SiteDirectory: workspace.SiteDirectory, OverlayDirectory: workspace.OverlayDirectory,
				SourceDirectory: workspace.SourceDirectory, Prefix: workspace.Prefix,
				DatabaseQueriesPath: workspace.DatabaseQueriesPath,
				Canvas:              options.Canvas, Admin: options.Admin, Queue: options.Canvas || options.Admin,
				QueryDesigner: options.Canvas, EnhanceIntent: options.Canvas,
				CaoURL: operations.DashboardURL(),
				OnBrowserTrace: func(event map[string]any) {
					trace.Record(event)
				},
			}
			var readyErr error
			if backend == "sqlite" {
				config.DatabasePath = workspace.DatabasePath
			}
			if !control {
				config.OnReady = func(address, forwarded string) {
					format := "Dashboard preview: %s/\n"
					if options.Canvas {
						format = "CAO_CANVAS_READY %s/\n"
					}
					if _, readyErr = fmt.Fprintf(cmd.OutOrStdout(), format, address); readyErr != nil {
						stop()
						return
					}
					if forwarded != "" {
						if _, readyErr = fmt.Fprintf(cmd.OutOrStdout(), "Dashboard preview (Codespace): %s/\n", forwarded); readyErr != nil {
							stop()
						}
					}
				}
			}
			server, err = preview.New(ctx, config, dashboardOperations{Operations: operations, trace: trace})
			if err != nil {
				return err
			}
			running.Store(server)
			server.SetControl(transport)
			watched := make(chan error, 1)
			go func() {
				watchErr := workspace.Watch(ctx, server.UpdateDashboard)
				watched <- watchErr
				if watchErr != nil && !errors.Is(watchErr, context.Canceled) {
					stop()
				}
			}()
			trace.Record(map[string]any{"event": "server.starting", "backend": backend})
			if control {
				err = server.Serve(ctx, cmd.InOrStdin(), cmd.OutOrStdout())
			} else {
				err = server.Serve(ctx, nil, nil)
			}
			stop()
			watchErr := <-watched
			if errors.Is(watchErr, context.Canceled) {
				watchErr = nil
			}
			trace.Record(map[string]any{"event": "server.stopped"})
			return errors.Join(err, readyErr, watchErr)
		},
	}
	flags := command.Flags()
	flags.StringVar(&options.Workspace, "workspace", "", "Operator workspace (default current directory)")
	flags.StringVar(&options.Repository, "repo", "", "Download verified artifacts from OWNER/REPOSITORY")
	flags.StringVar(&options.SiteDirectory, "site", "", "Explicit local dashboard site directory")
	flags.StringVar(&options.CatalogDirectory, "catalog", "", "Explicit campaign catalog directory")
	flags.StringVar(&options.DataDirectory, "data", "", "Existing verified dashboard artifact directory (offline)")
	flags.StringVar(&options.DashboardPath, "dashboard", "", "Editable Dashboard Language document")
	flags.StringVar(&options.GHExecutable, "gh-executable", "gh", "GitHub CLI executable")
	flags.StringVar(&host, "host", "127.0.0.1", "Listener address")
	flags.IntVar(&port, "port", 4173, "Listener port (0 assigns a free port)")
	flags.StringVar(&backend, "data-backend", "sqlite", "sqlite or browser indexeddb")
	flags.BoolVar(&options.Canvas, "canvas", false, "Enable trusted canvas authoring and approved commands")
	flags.BoolVar(&options.Admin, "admin", false, "Explicitly enable local loopback command execution")
	flags.IntVar(&concurrency, "command-concurrency", 4, "Maximum concurrent local commands (1 through 32)")
	flags.BoolVar(&acknowledgeRecovery, "acknowledge-command-recovery", false, "Resume queued work after verifying interrupted subprocesses have stopped")
	flags.StringVar(&caoURL, "cao-url", "", "HTTPS hosted CAO URL for declared command templates")
	flags.BoolVar(&replace, "replace-existing", false, "Replace this workspace's verified previous preview")
	flags.BoolVar(&control, "control-stdio", false, "Private readiness and trusted approval protocol")
	flags.StringVar(&tracePath, "trace-file", "", "Structured diagnostic JSONL file within the workspace")
	_ = flags.MarkHidden("control-stdio")
	return command
}

type dashboardOperations struct {
	preview.Operations
	trace *dashboardTrace
}

func (operations dashboardOperations) Notify(value any) error {
	operations.trace.Record(value)
	return operations.Operations.Notify(value)
}

type dashboardTrace struct {
	mu   sync.Mutex
	file *os.File
}

func newDashboardTrace(workspace, path string) (*dashboardTrace, error) {
	trace := &dashboardTrace{}
	if path == "" {
		return trace, nil
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(workspace, path)
	}
	relative, err := filepath.Rel(workspace, path)
	if err != nil || !filepath.IsLocal(relative) {
		return nil, errors.New("trace file must remain within the workspace")
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	if err := root.MkdirAll(filepath.Dir(relative), 0o700); err != nil {
		return nil, err
	}
	if info, err := root.Lstat(relative); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("trace file must be a regular file, not a symlink")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	trace.file, err = root.OpenFile(relative, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	return trace, err
}

func (trace *dashboardTrace) Record(value any) {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	if trace.file == nil {
		return
	}
	if err := json.NewEncoder(trace.file).Encode(map[string]any{
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano), "details": value,
	}); err != nil {
		commandLog.Printf("dashboard trace write failed")
	}
}

func (trace *dashboardTrace) Close() error {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	if trace.file == nil {
		return nil
	}
	err := trace.file.Close()
	trace.file = nil
	return err
}
