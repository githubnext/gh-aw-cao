package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	debuglogger "github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/simulator"
)

const maxScenarioBytes = 1 << 20

var simulatorLog = debuglogger.New("cao:simulator")

// errScenarioTooLarge is returned by readBoundedFile when the scenario file
// exceeds its byte limit. It is a sentinel so callers can classify this
// specific failure with errors.Is instead of matching message text.
var errScenarioTooLarge = errors.New("file exceeds the byte limit")

// scenarioLoadStage identifies which step of loading a simulator scenario
// file failed. It is useful for diagnosing a misconfigured --scenario flag
// without logging the file path or its contents.
type scenarioLoadStage string

const (
	scenarioLoadStageOpen      scenarioLoadStage = "open"
	scenarioLoadStageRead      scenarioLoadStage = "read"
	scenarioLoadStageOverLimit scenarioLoadStage = "over-limit"
	scenarioLoadStageDecode    scenarioLoadStage = "decode"
)

// readBoundedFile reads the file at path, rejecting it with
// errScenarioTooLarge once more than limit bytes are available. It is a
// small, pure-I/O boundary extracted from loadSimulatorScenario so the size
// limit is testable against a real temporary file rather than a mocked file
// system.
func readBoundedFile(path string, limit int64) ([]byte, error) {
	// #nosec G304 -- the operator explicitly supplies the local scenario path.
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open file: %w", err)
	}
	defer func() {
		_ = file.Close()
	}()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%w: %d bytes", errScenarioTooLarge, limit)
	}
	return data, nil
}

// classifyScenarioLoadFailure maps an error from readBoundedFile or
// simulator.LoadScenario to the stage that produced it, so
// loadSimulatorScenario can log which step failed without exposing the
// underlying file path, contents, or error text.
func classifyScenarioLoadFailure(err error, decoding bool) scenarioLoadStage {
	switch {
	case decoding:
		return scenarioLoadStageDecode
	case errors.Is(err, errScenarioTooLarge):
		return scenarioLoadStageOverLimit
	case errors.Is(err, os.ErrNotExist), errors.Is(err, os.ErrPermission):
		return scenarioLoadStageOpen
	default:
		return scenarioLoadStageRead
	}
}

func loadSimulatorScenario(path string) (simulator.Scenario, error) {
	data, err := readBoundedFile(path, maxScenarioBytes)
	if err != nil {
		simulatorLog.Printf("simulator scenario load failed stage=%s", classifyScenarioLoadFailure(err, false))
		return simulator.Scenario{}, fmt.Errorf("load simulator scenario: %w", err)
	}
	scenario, err := simulator.LoadScenario(data)
	if err != nil {
		simulatorLog.Printf("simulator scenario load failed stage=%s", classifyScenarioLoadFailure(err, true))
		return simulator.Scenario{}, err
	}
	simulatorLog.Printf("simulator scenario loaded bytes=%d repositories=%d", len(data), scenario.Repositories)
	return scenario, nil
}

// webhookDeliveryFlagFailure identifies which simulate-webhooks flag failed
// validation, so a failure is diagnosable without logging the flag values
// themselves (the scenario path, endpoint, and numeric settings an operator
// supplied).
type webhookDeliveryFlagFailure string

const (
	webhookDeliveryFlagFailureNone        webhookDeliveryFlagFailure = "none"
	webhookDeliveryFlagFailureScenario    webhookDeliveryFlagFailure = "scenario"
	webhookDeliveryFlagFailureTimeout     webhookDeliveryFlagFailure = "request-timeout"
	webhookDeliveryFlagFailureConcurrency webhookDeliveryFlagFailure = "concurrency"
)

// validateWebhookDeliveryFlags applies simulate-webhooks' flag preconditions:
// a non-empty scenario path, a positive request timeout, and a concurrency
// within [1, 512]. It is a pure function extracted from the command's RunE
// so each precondition is independently testable without building a cobra
// command or delivering real webhook traffic.
func validateWebhookDeliveryFlags(scenarioPath string, timeout time.Duration, concurrency int) (webhookDeliveryFlagFailure, error) {
	if scenarioPath == "" {
		return webhookDeliveryFlagFailureScenario, errors.New("--scenario is required")
	}
	if timeout <= 0 {
		return webhookDeliveryFlagFailureTimeout, errors.New("--request-timeout must be positive")
	}
	if concurrency < 1 || concurrency > 512 {
		return webhookDeliveryFlagFailureConcurrency, errors.New("--concurrency must be between 1 and 512")
	}
	return webhookDeliveryFlagFailureNone, nil
}

func newSimulateWebhooksCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "simulate-webhooks",
		Short: "deliver deterministic signed webhook traffic to CAO",
	}
	scenarioPath := cmd.Flags().String("scenario", "", "JSON simulator scenario file")
	endpoint := cmd.Flags().String("endpoint", "http://127.0.0.1:8080/api/github/webhook", "CAO webhook endpoint")
	concurrency := cmd.Flags().Int("concurrency", 64, "maximum concurrent webhook requests (1-512)")
	timeout := cmd.Flags().Duration("request-timeout", 30*time.Second, "timeout for each webhook request")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if failure, err := validateWebhookDeliveryFlags(*scenarioPath, *timeout, *concurrency); err != nil {
			simulatorLog.Printf("simulate-webhooks flag validation failed flag=%s", failure)
			return err
		}
		scenario, err := loadSimulatorScenario(*scenarioPath)
		if err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		result, err := scenario.Deliver(
			ctx, &http.Client{Timeout: *timeout}, *endpoint, os.Getenv("CAO_GITHUB_WEBHOOK_SECRET"), *concurrency,
		)
		encoded, marshalErr := json.Marshal(result)
		if marshalErr != nil {
			return marshalErr
		}
		_, _ = fmt.Fprintln(cmd.OutOrStdout(), string(encoded))
		return err
	}
	return cmd
}

// simulatorAPIStopReason classifies why runSimulatorAPI's select returned,
// so callers can log the outcome without duplicating this decision. It
// mirrors classifyWorkerStop's shape for the collection worker in main.go.
type simulatorAPIStopReason string

const (
	simulatorAPIStopReasonShutdown simulatorAPIStopReason = "shutdown"
	simulatorAPIStopReasonClean    simulatorAPIStopReason = "clean"
	simulatorAPIStopReasonError    simulatorAPIStopReason = "error"
)

// runSimulatorAPI serves httpServer on listener until ctx is cancelled or the
// server stops on its own, then reports which happened. It is extracted from
// newSimulateAPICommand's RunE so the shutdown-versus-server-error race is
// testable against a real *http.Server and net.Listener, without a cobra
// command or process signals.
//
// The shutdown context survives cancellation of ctx, because ctx is
// normally already cancelled by the signal handler that triggered shutdown.
func runSimulatorAPI(ctx context.Context, httpServer *http.Server, listener net.Listener, shutdownTimeout time.Duration) error {
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- httpServer.Serve(listener)
	}()
	select {
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
		defer cancel()
		err := httpServer.Shutdown(shutdownContext)
		simulatorLog.Printf("simulator API stopped reason=%s", simulatorAPIStopReasonShutdown)
		if err != nil {
			return fmt.Errorf("stop simulator API: %w", err)
		}
		return nil
	case err := <-serverErrors:
		if errors.Is(err, http.ErrServerClosed) {
			simulatorLog.Printf("simulator API stopped reason=%s", simulatorAPIStopReasonClean)
			return nil
		}
		simulatorLog.Printf("simulator API stopped reason=%s", simulatorAPIStopReasonError)
		return fmt.Errorf("simulator API stopped: %w", err)
	}
}

func newSimulateAPICommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "simulate-api",
		Short: "serve a scenario-controlled fake GitHub REST API",
	}
	scenarioPath := cmd.Flags().String("scenario", "", "JSON simulator scenario file")
	listen := cmd.Flags().String("listen", "127.0.0.1:8081", "local address for the fake GitHub API")
	timeScale := cmd.Flags().Float64("time-scale", 1, "scenario-time multiplier (for example, 3600 maps one hour to one second)")
	upstream := cmd.Flags().String("proxy-upstream", "", "optional loopback synthetic GitHub API to proxy with scenario faults")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if *scenarioPath == "" {
			return errors.New("--scenario is required")
		}
		scenario, err := loadSimulatorScenario(*scenarioPath)
		if err != nil {
			return err
		}
		var handler http.Handler
		handler, err = simulator.NewAPIHandler(scenario, *timeScale)
		if err != nil {
			return err
		}
		if *upstream != "" {
			proxy, err := simulator.NewFaultProxy(*upstream)
			if err != nil {
				return err
			}
			defer proxy.Close()
			for _, fault := range scenario.Faults {
				if err := proxy.Inject(fault); err != nil {
					return err
				}
			}
			handler = proxy
		} else if len(scenario.Faults) > 0 {
			return errors.New("scenario faults require --proxy-upstream")
		}
		server, listener, err := simulator.Listen(cmd.Context(), *listen, handler)
		if err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return runSimulatorAPI(ctx, server, listener, 5*time.Second)
	}
	return cmd
}
