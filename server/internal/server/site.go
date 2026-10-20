package server

import (
	"errors"
	"os"
)

func validateHostedSite(directory string) error {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return errors.New("hosted site directory must contain the built dashboard")
	}
	defer func() { _ = root.Close() }()
	content, err := root.ReadFile("index.html")
	if err != nil || len(content) == 0 {
		return errors.New("hosted site directory must contain a readable, non-empty built dashboard index.html")
	}
	return nil
}
