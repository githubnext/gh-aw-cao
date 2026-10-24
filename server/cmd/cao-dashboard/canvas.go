package main

import (
	"encoding/json"
	"errors"
	"os"

	debuglogger "github.com/githubnext/gh-cao/server/internal/logger"
	"github.com/githubnext/gh-cao/server/internal/server"
)

var canvasLog = debuglogger.New("cao:dashboard:canvas")

func readCanvasConfig(path string) (*server.LocalCanvasConfig, error) {
	if path == "" {
		canvasLog.Printf("canvas integration disabled: reason=no_config_path")
		return nil, nil //nolint:nilnil // An omitted internal flag disables canvas integration.
	}
	content, err := os.ReadFile(path) // #nosec G304 -- explicitly selected private local adapter configuration.
	if err != nil {
		canvasLog.Printf("canvas configuration rejected: reason=read_failed")
		return nil, errors.New("read local canvas configuration")
	}
	return parseCanvasConfig(content)
}

// parseCanvasConfig decodes adapter configuration without echoing its content.
func parseCanvasConfig(content []byte) (*server.LocalCanvasConfig, error) {
	var config server.LocalCanvasConfig
	if err := json.Unmarshal(content, &config); err != nil {
		canvasLog.Printf("canvas configuration rejected: reason=invalid_json bytes=%d", len(content))
		return nil, errors.New("invalid local canvas configuration")
	}
	return &config, nil
}
