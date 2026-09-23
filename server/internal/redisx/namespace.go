package redisx

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const namespacePrefix = "cao:"

var namespaceName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func NormalizeNamespace(value string) (string, error) {
	name := strings.ToLower(strings.TrimSpace(value))
	name = strings.TrimPrefix(name, namespacePrefix)
	if !namespaceName.MatchString(name) {
		return "", errors.New("redis namespace must contain 1-64 lowercase letters, digits, underscores, or hyphens")
	}
	return namespacePrefix + name, nil
}

func DefaultNamespace(workingDirectory string) (string, error) {
	directory, err := filepath.Abs(workingDirectory)
	if err != nil {
		return "", errors.New("resolve Redis namespace working directory")
	}
	if resolved, resolveErr := filepath.EvalSymlinks(directory); resolveErr == nil {
		directory = resolved
	}
	directory = checkoutRoot(directory)
	sum := sha256.Sum256([]byte(directory))
	return NormalizeNamespace("checkout-" + hex.EncodeToString(sum[:12]))
}

func checkoutRoot(directory string) string {
	for candidate := directory; ; candidate = filepath.Dir(candidate) {
		if _, err := os.Stat(filepath.Join(candidate, ".git")); err == nil {
			return candidate
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return directory
		}
	}
}
