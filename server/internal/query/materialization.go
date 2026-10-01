package query

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

const MaterializedSignatureMetadata = "query-signature"

func DefinitionSignature(definition Definition) (string, error) {
	data, err := json.Marshal(definition)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

func StaticDefinitions(definitions []Definition, availableSources map[string]bool) ([]Definition, []string) {
	index := make(map[string]Definition, len(definitions))
	blocked := make(map[string]bool, len(definitions))
	for _, definition := range definitions {
		index[definition.Name] = definition
		for _, computed := range definition.Compute {
			for _, argument := range computed.Args {
				if argument.Context != "" {
					blocked[definition.Name] = true
				}
			}
		}
	}
	changed := true
	for changed {
		changed = false
		for _, definition := range definitions {
			if blocked[definition.Name] {
				continue
			}
			inputs := append([]string{definition.From}, definition.Union...)
			for _, join := range definition.Joins {
				inputs = append(inputs, join.Source)
			}
			for _, input := range inputs {
				_, isDefinition := index[input]
				if (isDefinition && blocked[input]) || (!isDefinition && !availableSources[input]) {
					blocked[definition.Name] = true
					changed = true
					break
				}
			}
		}
	}
	selected := make([]Definition, 0, len(definitions)-len(blocked))
	names := make([]string, 0, len(definitions)-len(blocked))
	for _, definition := range definitions {
		if !blocked[definition.Name] {
			selected = append(selected, definition)
			names = append(names, definition.Name)
		}
	}
	sort.Strings(names)
	return selected, names
}
