package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadCanvasConfigOmittedPathDisablesCanvas(t *testing.T) {
	config, err := readCanvasConfig("")
	if config != nil || err != nil {
		t.Fatalf("readCanvasConfig(\"\") = %v, %v; want nil, nil", config, err)
	}
}

func TestReadCanvasConfigDecodesFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "canvas.json")
	body := `{"prefix":"/0123","adapterUrl":"http://127.0.0.1:9","memoryDirectory":"mem"}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	config, err := readCanvasConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.Prefix != "/0123" || config.AdapterURL != "http://127.0.0.1:9" || config.MemoryDirectory != "mem" {
		t.Fatalf("unexpected config: %+v", config)
	}
}

func TestReadCanvasConfigMissingFile(t *testing.T) {
	_, err := readCanvasConfig(filepath.Join(t.TempDir(), "absent.json"))
	if err == nil || err.Error() != "read local canvas configuration" {
		t.Fatalf("err = %v", err)
	}
}

func TestParseCanvasConfigRejectsInvalidJSONWithoutEchoingContent(t *testing.T) {
	_, err := parseCanvasConfig([]byte(`{"prefix": secret-value`))
	if err == nil || err.Error() != "invalid local canvas configuration" {
		t.Fatalf("err = %v", err)
	}
}
