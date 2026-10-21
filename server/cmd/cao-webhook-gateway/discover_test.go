package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	gateway "github.com/githubnext/gh-cao/server/internal/webhookgateway"
)

func discoveryFixture(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("../../../specs/fixtures/webhook-manifest-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "test.lock.yml")
	if err := os.WriteFile(path, []byte("# gh-aw-manifest: "+compact.String()+"\nname: test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestGatewayDiscoveryIsReadOnlyAndExplicit(t *testing.T) {
	path := discoveryFixture(t)
	var output bytes.Buffer
	if err := discoverWorkflows(t.Context(), []string{path}, &output); err != nil {
		t.Fatal(err)
	}
	var mapping gateway.TriggerMapping
	if err := json.Unmarshal(output.Bytes(), &mapping); err != nil {
		t.Fatal(err)
	}
	if !mapping.DiscoveryOnly || len(mapping.ByEvent) != 4 {
		t.Fatalf("incorrect discovered routes: %+v", mapping)
	}
	for _, paths := range [][]string{nil, {"test.lock.yml"}, {path, path}, {filepath.Join(t.TempDir(), "missing.lock.yml")}} {
		output.Reset()
		if err := discoverWorkflows(t.Context(), paths, &output); err == nil || output.Len() != 0 {
			t.Fatal("invalid inventory produced a success-shaped partial mapping", paths, err)
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := discoverWorkflows(cancelled, []string{path}, &output); !errors.Is(err, context.Canceled) {
		t.Fatal("discovery ignored cancellation", err)
	}
}

func TestGatewayDiscoveryRejectsMixedRoles(t *testing.T) {
	for _, name := range []string{"CAO_GATEWAY_RECEIVE_KEY_FILE", "CAO_GATEWAY_DISPATCH_KEY_FILE",
		"CAO_GATEWAY_WEBHOOK_SECRET", "CAO_GATEWAY_PREVIOUS_WEBHOOK_SECRET"} {
		t.Setenv(name, "")
	}
	path := discoveryFixture(t)
	for _, args := range [][]string{
		{"--role=discover"},
		{"--role=discover", "--workflow=" + path, "--policy=/unapproved/cao.json"},
		{"--role=discover", "--workflow=" + path, "--once"},
		{"--role=local", "--workflow=" + path},
		{"--role=receive", "--workflow=" + path},
		{"--role=dispatch", "--workflow=" + path},
	} {
		if err := run(t.Context(), args); err == nil {
			t.Fatal("discovery accepted missing or mixed role arguments", args)
		}
	}
	t.Setenv("CAO_GATEWAY_DISPATCH_KEY_FILE", "/private/not-for-discovery")
	if err := run(t.Context(), []string{"--role=discover", "--workflow=" + path}); err == nil {
		t.Fatal("discovery accepted production credentials")
	}
}

func TestReadWorkflowArtifactBounds(t *testing.T) {
	dir := t.TempDir()
	atLimit := filepath.Join(dir, "limit.lock.yml")
	if err := os.WriteFile(atLimit, bytes.Repeat([]byte("a"), gateway.MaxWorkflowArtifactBytes), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := readWorkflowArtifact(atLimit)
	if err != nil || len(data) != gateway.MaxWorkflowArtifactBytes {
		t.Fatal("artifact at the limit was rejected", len(data), err)
	}
	oversized := filepath.Join(dir, "over.lock.yml")
	if err := os.WriteFile(oversized, bytes.Repeat([]byte("a"), gateway.MaxWorkflowArtifactBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readWorkflowArtifact(oversized); err == nil {
		t.Fatal("oversized artifact was accepted")
	}
	if _, err := readWorkflowArtifact(filepath.Join(dir, "missing.lock.yml")); err == nil {
		t.Fatal("missing artifact was accepted")
	}
}

func TestGatewayDiscoveryRejectsInvalidInputs(t *testing.T) {
	path := discoveryFixture(t)
	var output bytes.Buffer
	if err := discoverWorkflows(t.Context(), []string{filepath.Join(t.TempDir(), "workflow.yml")}, &output); err == nil {
		t.Fatal("non-lock-file path was accepted")
	}
	bad := filepath.Join(t.TempDir(), "bad.lock.yml")
	if err := os.WriteFile(bad, []byte("name: no manifest\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := discoverWorkflows(t.Context(), []string{path, bad}, &output); err == nil || output.Len() != 0 {
		t.Fatal("invalid manifest produced a partial mapping", err)
	}
	tooMany := make([]string, 1025)
	if err := discoverWorkflows(t.Context(), tooMany, &output); err == nil {
		t.Fatal("oversized inventory was accepted")
	}
}
