package redisx

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type moduleInfoClient struct {
	reply any
	err   error
	calls int
}

func (client *moduleInfoClient) Do(_ context.Context, command ...string) (any, error) {
	client.calls++
	if len(command) != 6 || command[0] != "COMMAND" || command[1] != "INFO" ||
		command[2] != "JSON.SET" || command[3] != "FT.CREATE" ||
		command[4] != "FT.SEARCH" || command[5] != "FT.AGGREGATE" {
		return nil, errors.New("unexpected module preflight command")
	}
	return client.reply, client.err
}

func (*moduleInfoClient) DoMany(context.Context, [][]string) ([]any, error) {
	return nil, nil
}

func TestIndexedModulesAreRequiredExceptForProcessIsolatedStore(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reply  any
		err    error
		failed bool
	}{
		{"available", []any{[]any{"json.set"}, []any{"ft.create"}, []any{"ft.search"}, []any{"ft.aggregate"}}, nil, false},
		{"missing JSON", []any{nil, []any{"ft.create"}, []any{"ft.search"}, []any{"ft.aggregate"}}, nil, true},
		{"missing Search", []any{[]any{"json.set"}, nil, []any{"ft.search"}, []any{"ft.aggregate"}}, nil, true},
		{"malformed reply", []any{}, nil, true},
		{"permission denied", nil, errors.New("NOPERM"), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &moduleInfoClient{reply: tc.reply, err: tc.err}
			err := NewStore(client, "module-test").RequireIndexedModules(t.Context())
			if (err != nil) != tc.failed {
				t.Fatalf("preflight error = %v, want failure %v", err, tc.failed)
			}
			if tc.name == "missing Search" && !strings.Contains(err.Error(), "FT.CREATE") {
				t.Fatalf("wrong missing command: %v", err)
			}
			if client.calls != 1 {
				t.Fatalf("preflight used %d commands", client.calls)
			}
		})
	}
	client := &moduleInfoClient{err: errors.New("unavailable")}
	isolated, err := NewProcessIsolatedStore(client, "module-test")
	if err != nil {
		t.Fatal(err)
	}
	if err := isolated.RequireIndexedModules(t.Context()); err != nil || client.calls != 0 {
		t.Fatalf("process-isolated provider required Redis modules: %v, calls=%d", err, client.calls)
	}
}
