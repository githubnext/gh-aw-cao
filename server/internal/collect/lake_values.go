package collect

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/githubnext/gh-cao/server/internal/operationalvalue"
)

func (l Lake) filterOperationalValues(keep func(string) bool) error {
	if err := operationalvalue.FilterRepositories(l.operationalValuesPath(), keep); err != nil {
		return err
	}
	if err := operationalvalue.FilterCollectionRepositories(filepath.Join(l.ShardDirectory(), "workflow-values-collections.jsonl"), keep); err != nil {
		return err
	}
	// Normalized files are disposable, potentially shared projections, not
	// independent evidence. Drop an affected file as a unit and let compaction
	// regenerate it from the preserved raw sources, rather than editing hashes,
	// metadata, or unrelated records in a published snapshot.
	for _, directory := range []string{
		l.RunsDirectory(), l.RecordsDirectory(),
		filepath.Join(l.RunsDirectory(), ".payloads"),
		filepath.Join(l.RecordsDirectory(), ".payloads"),
	} {
		entries, err := os.ReadDir(directory)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".jsonl") {
				continue
			}
			path := filepath.Join(directory, entry.Name())
			discard, err := containsWithdrawnValue(path, keep)
			if err != nil {
				return err
			}
			if discard {
				if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
					return fmt.Errorf("remove derived operational values: %w", err)
				}
			}
		}
	}
	return nil
}

func containsWithdrawnValue(path string, keep func(string) bool) (bool, error) {
	file, err := os.Open(path) // #nosec G304 -- discovered normalized evidence-lake file.
	if err != nil {
		return false, err
	}
	defer func() { _ = file.Close() }()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var item struct {
			Kind       string `json:"kind"`
			Collection string `json:"collection"`
			Record     struct {
				RepositoryID string `json:"repositoryId"`
			} `json:"record"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
			return false, errors.New("invalid normalized evidence while erasing operational values")
		}
		if item.Kind != "record" || item.Collection != "operationalValues" && item.Collection != "workflowValueCollections" {
			continue
		}
		coordinate, found := strings.CutPrefix(item.Record.RepositoryID, "repository:")
		coordinate = strings.ReplaceAll(coordinate, "%2F", "/")
		repository, err := NormalizeRepository(coordinate)
		if !found || err != nil {
			return false, errors.New("invalid normalized operational value repository")
		}
		if !keep(repository) {
			return true, nil
		}
	}
	return false, scanner.Err()
}
