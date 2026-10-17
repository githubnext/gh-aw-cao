package cli

import (
	"bytes"
	"encoding/json"
	"slices"
)

// Preserve operator-owned key order instead of sorting the entire policy on mutation.
func orderedPolicyJSON(document map[string]any, original []byte) ([]byte, error) {
	var compact bytes.Buffer
	if err := writeOrderedJSON(&compact, document, original); err != nil {
		return nil, err
	}
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, compact.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	return formatted.Bytes(), nil
}

func writeOrderedJSON(output *bytes.Buffer, value any, original json.RawMessage) error {
	switch value := value.(type) {
	case map[string]any:
		var keys []string
		old := map[string]json.RawMessage{}
		if trimmed := bytes.TrimSpace(original); len(trimmed) != 0 && trimmed[0] == '{' {
			decoder := json.NewDecoder(bytes.NewReader(original))
			if _, err := decoder.Token(); err != nil {
				return err
			}
			for decoder.More() {
				token, err := decoder.Token()
				if err != nil {
					return err
				}
				key := token.(string)
				var raw json.RawMessage
				if err := decoder.Decode(&raw); err != nil {
					return err
				}
				old[key] = raw
				if _, exists := value[key]; exists && !slices.Contains(keys, key) {
					keys = append(keys, key)
				}
			}
		}
		var added []string
		for key := range value {
			if _, exists := old[key]; !exists {
				added = append(added, key)
			}
		}
		slices.Sort(added)
		keys = append(keys, added...)
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			encoded, err := json.Marshal(key)
			if err != nil {
				return err
			}
			output.Write(encoded)
			output.WriteByte(':')
			if err := writeOrderedJSON(output, value[key], old[key]); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	case []any:
		var old []json.RawMessage
		if trimmed := bytes.TrimSpace(original); len(trimmed) != 0 && trimmed[0] == '[' {
			if err := json.Unmarshal(original, &old); err != nil {
				return err
			}
		}
		output.WriteByte('[')
		for index, element := range value {
			if index > 0 {
				output.WriteByte(',')
			}
			var raw json.RawMessage
			if index < len(old) {
				raw = old[index]
			}
			if err := writeOrderedJSON(output, element, raw); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	default:
		encoder := json.NewEncoder(output)
		encoder.SetEscapeHTML(false)
		return encoder.Encode(value)
	}
	return nil
}
