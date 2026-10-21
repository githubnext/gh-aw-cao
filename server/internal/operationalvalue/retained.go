package operationalvalue

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

// FilterRepositories removes collector observations outside keep's repository
// scope. It preserves retained lines verbatim, including extension metadata.
// The caller must serialize this read/replace with collection and projection.
// This boundary does not own independently published value-evidence packets.
func FilterRepositories(path string, keep func(string) bool) error {
	file, err := os.Open(path) // #nosec G304 -- operator-configured collector shard.
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	var content bytes.Buffer
	changed := false
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), maxWorkerOutput)
	for line := 1; scanner.Scan(); line++ {
		raw := scanner.Bytes()
		if len(bytes.TrimSpace(raw)) == 0 {
			content.Write(raw)
			content.WriteByte('\n')
			continue
		}
		var item envelope
		if err := json.Unmarshal(raw, &item); err != nil {
			return fmt.Errorf("retained operational value line %d: invalid JSON", line)
		}
		if item.SchemaVersion != 2 || item.Kind != "operational_value" {
			return fmt.Errorf("retained operational value line %d: unexpected envelope", line)
		}
		repositories, err := normalizeRepositories([]string{item.OperationalValue.Repository})
		if err != nil {
			return fmt.Errorf("retained operational value line %d: invalid repository", line)
		}
		if !keep(strings.ToLower(repositories[0])) {
			changed = true
			continue
		}
		content.Write(raw)
		content.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if !changed {
		return nil
	}
	return writeContent(path, content.Bytes())
}
