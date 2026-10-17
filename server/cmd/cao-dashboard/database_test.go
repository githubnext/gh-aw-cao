package main

import (
	"io"
	"strings"
	"testing"
)

func TestDatabaseCommandsRequireExplicitAuthority(t *testing.T) {
	t.Setenv("CAO_DATABASE_ADMIN_URL", "")
	t.Setenv("CAO_POSTGRES_URL", "postgres://runtime@127.0.0.1/runtime")
	for _, test := range []struct {
		args []string
		want string
	}{
		{[]string{"bootstrap"}, "--store"},
		{[]string{"bootstrap", "--store", "operational"}, "--namespace"},
		{[]string{"bootstrap", "--store", "operational", "--namespace", "deployment"}, "CAO_DATABASE_ADMIN_URL"},
		{[]string{"maintain", "--store", "operational", "--namespace", "deployment"}, "maintain requires"},
		{[]string{"retain-audit", "--store", "canonical", "--namespace", "deployment"}, "retain-audit requires"},
	} {
		cmd := newDatabaseCommand()
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		cmd.SetArgs(test.args)
		if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("%v: got %v, want %s", test.args, err, test.want)
		}
	}
}
