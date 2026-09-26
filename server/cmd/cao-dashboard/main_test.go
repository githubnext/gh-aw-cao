package main

import (
	"errors"
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
