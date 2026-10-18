package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	gateway "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

func discoverWorkflows(ctx context.Context, paths []string, output io.Writer) error {
	if len(paths) == 0 || len(paths) > 1024 {
		return errors.New("gateway discovery requires 1 to 1024 explicit workflow lock files")
	}
	mapping := gateway.NewTriggerMapping()
	seen := make(map[string]bool)
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !filepath.IsAbs(path) || !strings.HasSuffix(path, ".lock.yml") {
			return errors.New("gateway discovery requires absolute workflow lock-file paths")
		}
		workflow := ".github/workflows/" + filepath.Base(path)
		if seen[workflow] {
			return errors.New("gateway discovery workflow identity is duplicated")
		}
		seen[workflow] = true
		file, err := os.Open(path) // #nosec G304 G703 -- paths are supplied explicitly by the local operator, never a delivery.
		if err != nil {
			return errors.New("gateway discovery artifact is unavailable")
		}
		data, readErr := io.ReadAll(io.LimitReader(file, gateway.MaxWorkflowArtifactBytes+1))
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || len(data) > gateway.MaxWorkflowArtifactBytes {
			return errors.New("gateway discovery artifact is unreadable or oversized")
		}
		if err := mapping.AddWorkflow(data, workflow, gateway.DefaultLimits()); err != nil {
			return errors.New("gateway discovery manifest is invalid or conflicting")
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(mapping)
}
