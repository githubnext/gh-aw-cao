package webhookgateway

import (
	"encoding/json"
	"path"
	"strings"
)

// DiscoveryUpdate recognizes bounded hints only. The worker always re-reads the
// configured repository's current default branch, never a supplied ref or URL.
func DiscoveryUpdate(event Event) (bool, error) {
	if event.Name == "repository" {
		return true, nil
	}
	if event.Name != "push" {
		return false, nil
	}
	root, err := boundedJSON(event.Payload, DefaultLimits().MaxEventBytes, DefaultLimits())
	if err != nil {
		return false, err
	}
	object, ok := root.(map[string]any)
	if !ok {
		return false, ErrInvalid
	}
	if object["forced"] == true || object["deleted"] == true {
		return true, nil
	}
	commits, exists := object["commits"]
	if !exists {
		return true, nil
	}
	array, ok := commits.([]any)
	if !ok {
		return false, ErrInvalid
	}
	if size, exists := object["size"]; exists {
		number, ok := size.(json.Number)
		count, err := number.Int64()
		if !ok || err != nil || count < 0 {
			return false, ErrInvalid
		}
		if count != int64(len(array)) {
			return true, nil
		}
	}
	for _, commit := range array {
		change, ok := commit.(map[string]any)
		if !ok {
			return false, ErrInvalid
		}
		for _, kind := range []string{"added", "modified", "removed"} {
			value, exists := change[kind]
			if !exists {
				continue
			}
			files, ok := value.([]any)
			if !ok {
				return false, ErrInvalid
			}
			for _, file := range files {
				name, ok := file.(string)
				if !ok {
					return false, ErrInvalid
				}
				if path.Dir(name) == ".github/workflows" && path.Clean(name) == name && strings.HasSuffix(name, ".lock.yml") {
					return true, nil
				}
			}
		}
	}
	return false, nil
}
