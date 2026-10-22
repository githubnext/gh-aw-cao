package main

import (
	"encoding/json"
	"errors"
	"os"

	"github.com/githubnext/gh-cao/server/internal/server"
)

func readCanvasConfig(path string) (*server.LocalCanvasConfig, error) {
	if path == "" {
		return nil, nil //nolint:nilnil // An omitted internal flag disables canvas integration.
	}
	content, err := os.ReadFile(path) // #nosec G304 -- explicitly selected private local adapter configuration.
	if err != nil {
		return nil, errors.New("read local canvas configuration")
	}
	var config server.LocalCanvasConfig
	if err := json.Unmarshal(content, &config); err != nil {
		return nil, errors.New("invalid local canvas configuration")
	}
	return &config, nil
}
