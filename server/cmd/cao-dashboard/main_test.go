package main

import (
	"errors"
	"io"
	"sort"
	"strings"
	"testing"
)

func TestResolveRedisEndpoint(t *testing.T) {
	const defaultValue = "redis://127.0.0.1:6379/0"

	tests := []struct {
		name       string
		flagValue  string
		envValue   string
		wantURL    string
		wantSource redisEndpointSource
	}{
		{
			name:       "flag takes priority over env and default",
			flagValue:  "redis://flag:6379/1",
			envValue:   "redis://env:6379/2",
			wantURL:    "redis://flag:6379/1",
			wantSource: redisEndpointSourceFlag,
		},
		{
			name:       "env used when flag is empty",
			flagValue:  "",
			envValue:   "redis://env:6379/2",
			wantURL:    "redis://env:6379/2",
			wantSource: redisEndpointSourceEnv,
		},
		{
			name:       "env used when flag is only whitespace",
			flagValue:  "   ",
			envValue:   "redis://env:6379/2",
			wantURL:    "redis://env:6379/2",
			wantSource: redisEndpointSourceEnv,
		},
		{
			name:       "default used when flag and env are empty",
			flagValue:  "",
			envValue:   "",
			wantURL:    defaultValue,
			wantSource: redisEndpointSourceDefault,
		},
		{
			name:       "default used when env is only whitespace",
			flagValue:  "",
			envValue:   "  ",
			wantURL:    defaultValue,
			wantSource: redisEndpointSourceDefault,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotURL, gotSource := resolveRedisEndpoint(tt.flagValue, tt.envValue, defaultValue)
			if gotURL != tt.wantURL {
				t.Errorf("resolveRedisEndpoint() url = %q, want %q", gotURL, tt.wantURL)
			}
			if gotSource != tt.wantSource {
				t.Errorf("resolveRedisEndpoint() source = %q, want %q", gotSource, tt.wantSource)
			}
		})
	}
}

func TestResolveNamespaceDefault(t *testing.T) {
	const checkoutDefault = "checkout-abc123"

	tests := []struct {
		name          string
		envValue      string
		wantNamespace string
		wantSource    namespaceDefaultSource
	}{
		{
			name:          "env override takes priority over checkout default",
			envValue:      "custom-namespace",
			wantNamespace: "custom-namespace",
			wantSource:    namespaceDefaultSourceEnv,
		},
		{
			name:          "checkout default used when env is empty",
			envValue:      "",
			wantNamespace: checkoutDefault,
			wantSource:    namespaceDefaultSourceCheckout,
		},
		{
			name:          "checkout default used when env is only whitespace",
			envValue:      "   ",
			wantNamespace: checkoutDefault,
			wantSource:    namespaceDefaultSourceCheckout,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotNamespace, gotSource := resolveNamespaceDefault(tt.envValue, checkoutDefault)
			if gotNamespace != tt.wantNamespace {
				t.Errorf("resolveNamespaceDefault() namespace = %q, want %q", gotNamespace, tt.wantNamespace)
			}
			if gotSource != tt.wantSource {
				t.Errorf("resolveNamespaceDefault() source = %q, want %q", gotSource, tt.wantSource)
			}
		})
	}
}

func TestResolveConsumerName(t *testing.T) {
	stubHostname := func() (string, error) { return "stub-host", nil }

	t.Run("flag takes priority over hostname", func(t *testing.T) {
		gotName, gotSource, err := resolveConsumerName("worker-1", stubHostname)
		if err != nil {
			t.Fatalf("resolveConsumerName() error = %v, want nil", err)
		}
		if gotName != "worker-1" {
			t.Errorf("resolveConsumerName() name = %q, want %q", gotName, "worker-1")
		}
		if gotSource != consumerNameSourceFlag {
			t.Errorf("resolveConsumerName() source = %q, want %q", gotSource, consumerNameSourceFlag)
		}
	})

	t.Run("hostname used when flag is empty", func(t *testing.T) {
		gotName, gotSource, err := resolveConsumerName("", stubHostname)
		if err != nil {
			t.Fatalf("resolveConsumerName() error = %v, want nil", err)
		}
		if gotName != "stub-host" {
			t.Errorf("resolveConsumerName() name = %q, want %q", gotName, "stub-host")
		}
		if gotSource != consumerNameSourceHostname {
			t.Errorf("resolveConsumerName() source = %q, want %q", gotSource, consumerNameSourceHostname)
		}
	})

	t.Run("hostname used when flag is only whitespace", func(t *testing.T) {
		gotName, gotSource, err := resolveConsumerName("   ", stubHostname)
		if err != nil {
			t.Fatalf("resolveConsumerName() error = %v, want nil", err)
		}
		if gotName != "stub-host" {
			t.Errorf("resolveConsumerName() name = %q, want %q", gotName, "stub-host")
		}
		if gotSource != consumerNameSourceHostname {
			t.Errorf("resolveConsumerName() source = %q, want %q", gotSource, consumerNameSourceHostname)
		}
	})

	t.Run("error propagated when flag empty and hostname fails", func(t *testing.T) {
		failingHostname := func() (string, error) { return "", errors.New("no hostname") }
		_, _, err := resolveConsumerName("", failingHostname)
		if err == nil {
			t.Fatal("resolveConsumerName() error = nil, want non-nil")
		}
	})
}

func TestResolveIngestSource(t *testing.T) {
	tests := []struct {
		name           string
		flagValue      string
		positionalArgs []string
		wantSource     string
		wantOrigin     ingestSourceOrigin
		wantErr        bool
	}{
		{
			name:           "flag takes priority over positional arg",
			flagValue:      "/flag/dir",
			positionalArgs: []string{"/positional/dir"},
			wantSource:     "/flag/dir",
			wantOrigin:     ingestSourceOriginFlag,
		},
		{
			name:           "positional arg used when flag is empty",
			flagValue:      "",
			positionalArgs: []string{"/positional/dir"},
			wantSource:     "/positional/dir",
			wantOrigin:     ingestSourceOriginPositionalArg,
		},
		{
			name:           "positional arg used when flag is only whitespace",
			flagValue:      "   ",
			positionalArgs: []string{"/positional/dir"},
			wantSource:     "/positional/dir",
			wantOrigin:     ingestSourceOriginPositionalArg,
		},
		{
			name:           "error when flag and positional args are empty",
			flagValue:      "",
			positionalArgs: nil,
			wantErr:        true,
		},
		{
			name:           "error when flag empty and multiple positional args",
			flagValue:      "",
			positionalArgs: []string{"/one", "/two"},
			wantErr:        true,
		},
		{
			name:           "error when flag empty and single positional arg is blank",
			flagValue:      "",
			positionalArgs: []string{"   "},
			wantErr:        true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotSource, gotOrigin, err := resolveIngestSource(tt.flagValue, tt.positionalArgs)
			if tt.wantErr {
				if err == nil {
					t.Fatal("resolveIngestSource() error = nil, want non-nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveIngestSource() error = %v, want nil", err)
			}
			if gotSource != tt.wantSource {
				t.Errorf("resolveIngestSource() source = %q, want %q", gotSource, tt.wantSource)
			}
			if gotOrigin != tt.wantOrigin {
				t.Errorf("resolveIngestSource() origin = %q, want %q", gotOrigin, tt.wantOrigin)
			}
		})
	}
}

func TestRootCommandRegistersEverySubcommand(t *testing.T) {
	want := []string{"backfill", "collect", "doctor", "ingest", "serve", "serve-hosted"}
	root := newRootCommand()

	got := make([]string, 0, len(want))
	for _, cmd := range root.Commands() {
		got = append(got, cmd.Name())
	}
	sort.Strings(got)

	if len(got) != len(want) {
		t.Fatalf("newRootCommand() registered %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("newRootCommand() registered %v, want %v", got, want)
			break
		}
	}
}

func TestRootCommandRejectsUnknownSubcommand(t *testing.T) {
	root := newRootCommand()
	root.SetArgs([]string{"bogus"})
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)

	err := root.Execute()
	if err == nil {
		t.Fatal("Execute() error = nil, want non-nil")
	}
	if !strings.Contains(err.Error(), `unknown command "bogus"`) {
		t.Fatalf("Execute() error = %q, want to contain %q", err.Error(), `unknown command "bogus"`)
	}
}

func TestRootCommandParsesKnownSubcommandFlags(t *testing.T) {
	root := newRootCommand()
	root.SetArgs([]string{"serve-hosted", "--listen", "127.0.0.1:9000"})
	root.SetOut(io.Discard)
	root.SetErr(io.Discard)

	found, _, err := root.Find([]string{"serve-hosted", "--listen", "127.0.0.1:9000"})
	if err != nil {
		t.Fatalf("Find() error = %v, want nil", err)
	}
	if found.Name() != "serve-hosted" {
		t.Fatalf("Find() name = %q, want %q", found.Name(), "serve-hosted")
	}
	if err := found.ParseFlags([]string{"--listen", "127.0.0.1:9000"}); err != nil {
		t.Fatalf("ParseFlags() error = %v, want nil", err)
	}
	gotListen, err := found.Flags().GetString("listen")
	if err != nil {
		t.Fatalf("Flags().GetString(listen) error = %v, want nil", err)
	}
	if gotListen != "127.0.0.1:9000" {
		t.Errorf("listen flag = %q, want %q", gotListen, "127.0.0.1:9000")
	}
}
