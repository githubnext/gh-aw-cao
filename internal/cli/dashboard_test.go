package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestDashboardOperatorDoesNotServeHTTP(t *testing.T) {
	command := dashboardCommand()
	var names []string
	for _, child := range command.Commands() {
		names = append(names, child.Name())
	}
	slices.Sort(names)
	if !reflect.DeepEqual(names, []string{"action", "evaluate"}) {
		t.Fatalf("dashboard operator commands = %v; local serving belongs to cao-dashboard serve-local", names)
	}
	command.SetArgs([]string{"serve"})
	command.SetOut(io.Discard)
	command.SetErr(io.Discard)
	if err := command.Execute(); err == nil {
		t.Fatal("the operator extension must not host the local server")
	}
}

func TestDashboardNativeCommandsValidateWithoutExecution(t *testing.T) {
	for _, test := range []struct {
		command string
		valid   bool
	}{
		{"gh aw compile", true},
		{"gh workflow run cao-dashboard.yml --repo acme/control", true},
		{"gh agent-task create --from-file -", true},
		{"curl https://attacker.test", false},
		{"gh api --method DELETE repos/acme/control", false},
		{"gh workflow run --repo acme/control", false},
	} {
		t.Run(test.command, func(t *testing.T) {
			command := dashboardActionCommand()
			var output bytes.Buffer
			command.SetOut(&output)
			command.SetArgs([]string{"--command", test.command, "--validate"})
			err := command.Execute()
			if (err == nil) != test.valid {
				t.Fatalf("valid %v, error %v", test.valid, err)
			}
		})
	}
}

func TestDashboardNativeQueryTool(t *testing.T) {
	command := dashboardEvaluateCommand()
	command.SetIn(strings.NewReader(`{"queries":[{"name":"failed","from":"runs","filter":{"predicates":[{"field":"conclusion","equals":"failure"}]}}],"sources":{"runs":[{"conclusion":"failure"},{"conclusion":"success"}]}}`))
	var output bytes.Buffer
	command.SetOut(&output)
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	var result map[string]struct {
		Rows []map[string]any `json:"rows"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result["failed"].Rows) != 1 || result["failed"].Rows[0]["conclusion"] != "failure" {
		t.Fatalf("native tool result: %s", output.String())
	}
}

func TestDashboardNativeQueryToolRejectsInvalidInput(t *testing.T) {
	for _, input := range []string{
		`{} {}`, `{"unknown":true}`, `{"queries":`, strings.Repeat(" ", (8<<20)+1),
	} {
		command := dashboardEvaluateCommand()
		command.SetIn(strings.NewReader(input))
		command.SetOut(io.Discard)
		command.SetErr(io.Discard)
		if err := command.Execute(); err == nil {
			t.Fatal("invalid query request was accepted")
		}
	}
}
