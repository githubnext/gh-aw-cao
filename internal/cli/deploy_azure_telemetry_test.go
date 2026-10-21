package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeployAzureTelemetryPlanKeepsOnlySecretReferences(t *testing.T) {
	const header = "Authorization=Bearer%20synthetic-plan-otlp"
	config := testDeployConfig()
	config["telemetry"] = map[string]any{"otlpEndpoint": "https://collector.example.test", "logsEnabled": true}
	config["secrets"].(map[string]any)["otlpHeaders"] = map[string]any{"env": "CAO_TEST_OTLP_HEADERS"}
	fake := &fakeAz{t: t, groupExists: true, whatIfStderr: header}
	root, stdout, stderr := testDeployRootWith(fake, func(name string) (string, bool) {
		if name == "CAO_TEST_OTLP_HEADERS" {
			return header, true
		}
		return testDeployEnv(name)
	})
	planPath := filepath.Join(t.TempDir(), "plan.json")
	root.SetArgs([]string{"deploy", "azure", "--config", writeDeployConfig(t, config),
		"--template", testDeployTemplatePath(t), "--out", planPath})
	if err := root.ExecuteContext(t.Context()); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatal(err)
	}
	var plan deployAzurePlan
	if err := json.Unmarshal(content, &plan); err != nil {
		t.Fatal(err)
	}
	if plan.SecureParameters["otlpHeaders"] != "env:CAO_TEST_OTLP_HEADERS" ||
		plan.Parameters["otlpEndpoint"] != "https://collector.example.test" ||
		plan.Parameters["otlpLogsEnabled"] != true {
		t.Fatal("reviewed plan lost the explicit route or secret reference")
	}
	observed := string(content) + stdout.String() + stderr.String()
	for _, call := range fake.calls {
		observed += strings.Join(call, " ")
	}
	if strings.Contains(observed, header) {
		t.Fatal("OTLP authentication escaped into a plan, output or command argument")
	}
	for _, file := range fake.parameterFiles {
		if _, err := os.Stat(file); !os.IsNotExist(err) {
			t.Fatal("temporary secure parameter file was not removed")
		}
	}
}

func TestDeployAzureTelemetryParameters(t *testing.T) {
	config := testDeployConfig()
	config["telemetry"] = map[string]any{
		"otlpEndpoint": "https://collector.example.test/otlp",
		"logsEnabled":  true,
	}
	config["secrets"].(map[string]any)["otlpHeaders"] = map[string]any{"env": "CAO_TEST_OTLP_HEADERS"}
	content, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseDeployAzureConfig(content)
	if err != nil {
		t.Fatal(err)
	}
	parameters := parsed.parameters()
	if parameters["otlpEndpoint"] != "https://collector.example.test/otlp" || parameters["otlpLogsEnabled"] != true {
		t.Fatal("telemetry config did not reach template parameters")
	}
	template, err := (deployAzureFileTemplate{path: testDeployTemplatePath(t)}).Load(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, parameter := range parsed.secureParameters() {
		names = append(names, parameter.name)
	}
	if _, err := checkDeployAzureTemplate(template, parameters, names); err != nil {
		t.Fatal(err)
	}
	const syntheticHeader = "Authorization=Bearer%20synthetic-otlp"
	secrets, err := resolveDeployAzureSecrets(parsed, func(name string) (string, bool) {
		if name == "CAO_TEST_OTLP_HEADERS" {
			return syntheticHeader, true
		}
		return testDeployEnv(name)
	})
	if err != nil {
		t.Fatal(err)
	}
	entry, found := secrets.entries["otlpHeaders"].(map[string]any)
	if !found || entry["value"] != syntheticHeader {
		t.Fatal("OTLP headers did not enter the secure parameter path")
	}
	if secrets.redact(syntheticHeader) != "***" {
		t.Fatal("OTLP headers did not enter diagnostic redaction")
	}
	if _, exists := parameters["otlpHeaders"]; exists || strings.Contains(string(content), syntheticHeader) {
		t.Fatal("OTLP credentials entered non-secure configuration")
	}
}

func TestDeployAzureTelemetryRejectsUnsafeConfiguration(t *testing.T) {
	for _, endpoint := range []string{
		"http://collector.example.test", "https://user:password@collector.example.test",
		"https://collector.example.test?token=value", "https://collector.example.test?",
		"https://collector.example.test#fragment", "https://collector.example.test#",
		"collector.example.test", "https:///missing-host",
	} {
		t.Run(endpoint, func(t *testing.T) {
			config := testDeployConfig()
			config["telemetry"] = map[string]any{"otlpEndpoint": endpoint}
			content, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := parseDeployAzureConfig(content); err == nil || !strings.Contains(err.Error(), "HTTPS collector") {
				t.Fatal("unsafe endpoint was not rejected with a bounded error")
			}
		})
	}
	for _, field := range []string{"logs", "headers"} {
		config := testDeployConfig()
		if field == "logs" {
			config["telemetry"] = map[string]any{"logsEnabled": true}
		} else {
			config["secrets"].(map[string]any)["otlpHeaders"] = map[string]any{"env": "CAO_TEST_OTLP_HEADERS"}
		}
		content, err := json.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parseDeployAzureConfig(content); err == nil || !strings.Contains(err.Error(), "otlpEndpoint is required") {
			t.Fatalf("%s without an endpoint was not rejected", field)
		}
	}
}
