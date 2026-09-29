package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/githubnext/gh-aw-cao/server/internal/simulator"
)

const maxScenarioBytes = 1 << 20

func loadSimulatorScenario(path string) (simulator.Scenario, error) {
	// #nosec G304 -- the operator explicitly supplies the local scenario path.
	file, err := os.Open(path)
	if err != nil {
		return simulator.Scenario{}, fmt.Errorf("open simulator scenario: %w", err)
	}
	defer func() {
		_ = file.Close()
	}()
	data, err := io.ReadAll(io.LimitReader(file, maxScenarioBytes+1))
	if err != nil {
		return simulator.Scenario{}, fmt.Errorf("read simulator scenario: %w", err)
	}
	if len(data) > maxScenarioBytes {
		return simulator.Scenario{}, errors.New("simulator scenario exceeds the 1 MiB limit")
	}
	return simulator.LoadScenario(data)
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
		if *scenarioPath == "" {
			return errors.New("--scenario is required")
		}
		if *timeout <= 0 {
			return errors.New("--request-timeout must be positive")
		}
		if *concurrency < 1 || *concurrency > 512 {
			return errors.New("--concurrency must be between 1 and 512")
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

func newSimulateAPICommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "simulate-api",
		Short: "serve a scenario-controlled fake GitHub REST API",
	}
	scenarioPath := cmd.Flags().String("scenario", "", "JSON simulator scenario file")
	listen := cmd.Flags().String("listen", "127.0.0.1:8081", "local address for the fake GitHub API")
	timeScale := cmd.Flags().Float64("time-scale", 1, "scenario-time multiplier (for example, 3600 maps one hour to one second)")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		if *scenarioPath == "" {
			return errors.New("--scenario is required")
		}
		scenario, err := loadSimulatorScenario(*scenarioPath)
		if err != nil {
			return err
		}
		handler, err := simulator.NewAPIHandler(scenario, *timeScale)
		if err != nil {
			return err
		}
		server, listener, err := simulator.Listen(cmd.Context(), *listen, handler)
		if err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		serverErrors := make(chan error, 1)
		go func() {
			serverErrors <- server.Serve(listener)
		}()
		select {
		case <-ctx.Done():
			shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := server.Shutdown(shutdownContext); err != nil {
				return fmt.Errorf("stop simulator API: %w", err)
			}
			return nil
		case err := <-serverErrors:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return fmt.Errorf("simulator API stopped: %w", err)
		}
	}
	return cmd
}
