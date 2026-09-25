package main

import "testing"

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
