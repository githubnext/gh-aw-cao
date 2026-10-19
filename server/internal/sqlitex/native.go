package sqlitex

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/githubnext/gh-aw-cao/server/internal/model"
	"github.com/githubnext/gh-aw-cao/server/internal/postgresx"
	"github.com/githubnext/gh-aw-cao/server/internal/repositorymemory"
)

const maxInventoryBytes = 32 << 20

type nativeStateFile struct {
	Fingerprint string          `json:"fingerprint"`
	State       postgresx.State `json:"state"`
}

func readSidecar(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("snapshot sidecar %q must be a bounded regular file", filepath.Base(path))
	}
	file, err := os.Open(path) //nolint:gosec // G304: the sidecar must be a bounded regular file, verified before and after opening.
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, openedInfo) {
		return nil, errors.New("snapshot sidecar changed while opening")
	}
	content, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) > limit {
		return nil, errors.New("snapshot sidecar exceeds its byte budget")
	}
	return content, nil
}

func (s *Store) initializeNative(ctx context.Context, path string, info os.FileInfo) error {
	file, err := os.Open(path) //nolint:gosec // G304: New validates the regular, symlink-free snapshot path; SameFile below verifies its identity.
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, openedInfo) {
		return errors.New("native snapshot changed while opening")
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return err
	}
	snapshotDigest := hex.EncodeToString(hasher.Sum(nil))
	inventory, err := readSidecar(filepath.Join(filepath.Dir(path), "inventory-sources.json"), maxInventoryBytes)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read native snapshot inventory: %w", err)
	}
	if len(inventory) > 0 {
		var documents map[string]json.RawMessage
		if err := json.Unmarshal(inventory, &documents); err != nil || documents == nil {
			return errors.New("native snapshot inventory must contain source documents")
		}
		for name, content := range documents {
			var object map[string]json.RawMessage
			if json.Unmarshal(content, &object) != nil || object == nil || (object["rows"] == nil && object["metadata"] == nil) {
				continue
			}
			var source model.Source
			if err := decode(string(content), &source); err != nil {
				return fmt.Errorf("invalid native inventory source %q: %w", name, err)
			}
			source.Source = name
			if source.Rows == nil {
				source.Rows = []model.Row{}
			}
			s.inventory[name] = source
		}
		_, _ = hasher.Write([]byte("\x00inventory\x00"))
		_, _ = hasher.Write(inventory)
	}
	if err := s.normalizeInventory(ctx); err != nil {
		return err
	}
	overrides, err := readSidecar(filepath.Join(filepath.Dir(path), "compiler-overrides.json"), maxInventoryBytes)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read native compiler overrides: %w", err)
	}
	if len(overrides) > 0 {
		if err := s.loadCompilerOverrides(overrides); err != nil {
			return err
		}
		_, _ = hasher.Write([]byte("\x00compiler-overrides\x00"))
		_, _ = hasher.Write(overrides)
	}
	memory, err := repositorymemory.Load(filepath.Dir(path))
	if err != nil {
		return err
	}
	_, _ = hasher.Write([]byte("\x00memory\x00" + memory.Revision))
	s.memory = memory
	if memoryInfo, err := os.Stat(filepath.Join(filepath.Dir(path), "memory", "manifest.json")); err == nil && memoryInfo.Mode().IsRegular() {
		s.memoryAvailable = true
	}
	manifest, err := readSidecar(filepath.Join(filepath.Dir(path), "payload-hashes.json"), maxInventoryBytes)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	verifiedManifest := false
	if len(manifest) > 0 {
		var hashes map[string]any
		if json.Unmarshal(manifest, &hashes) != nil || hashes == nil {
			return errors.New("native snapshot payload manifest must be an object")
		}
		if expected, present := hashes["gh-aw-logs.sqlite"]; present {
			digest, ok := expected.(string)
			if !ok || !strings.EqualFold(digest, snapshotDigest) {
				return errors.New("native snapshot does not match its payload manifest checksum")
			}
			verifiedManifest = true
		}
		_, _ = hasher.Write([]byte("\x00manifest\x00"))
		_, _ = hasher.Write(manifest)
	}
	sum := hasher.Sum(nil)
	s.fingerprint = hex.EncodeToString(sum)
	s.nativeState = postgresx.State{
		Revision:     int64(binary.BigEndian.Uint64(sum[:8]) & (1<<63 - 1)),
		DataRevision: s.fingerprint,
		EvaluatedAt:  info.ModTime().UTC(),
	}
	if s.nativeState.Revision == 0 {
		s.nativeState.Revision = 1
	}
	var records int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM __idb_records WHERE database_name=?`, s.database).Scan(&records); err != nil {
		return err
	}
	s.nativeState.Ready = records > 0 || verifiedManifest || s.tables["__idb_stores"] || len(s.inventory) > 0
	currentInfo, err := os.Stat(path)
	if err != nil || !os.SameFile(info, currentInfo) || currentInfo.Size() != info.Size() || !currentInfo.ModTime().Equal(info.ModTime()) {
		return errors.New("native snapshot changed while opening")
	}
	s.statePath = path + ".cao-state.json"
	content, err := readSidecar(s.statePath, 64<<10)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(content) > 0 {
		var previous nativeStateFile
		if err := json.Unmarshal(content, &previous); err != nil {
			return fmt.Errorf("read native snapshot state: %w", err)
		}
		if previous.Fingerprint == s.fingerprint {
			if previous.State.Revision <= 0 || previous.State.EvaluatedAt.IsZero() {
				return errors.New("native snapshot state is invalid")
			}
			previous.State.Ready = s.nativeState.Ready
			s.nativeState = previous.State
		}
	}
	return nil
}

func (s *Store) setNativeState(state postgresx.State) error {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	state.Ready, state.Counts = s.nativeState.Ready, nil
	if state.DataRevision == "" {
		state.DataRevision = s.fingerprint
	}
	content, err := json.Marshal(nativeStateFile{Fingerprint: s.fingerprint, State: state})
	if err != nil {
		return err
	}
	if _, err := readSidecar(s.statePath, 64<<10); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(s.statePath), ".cao-state-")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(file.Name()) }()
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), s.statePath); err != nil {
		return err
	}
	s.nativeState = state
	return nil
}

func (r *readTransaction) memorySource(name string) (model.Source, error) {
	metadata := defaultMetadata(name)
	metadata["source-kind"] = "runtime"
	source := model.Source{Source: name, Rows: []model.Row{}, Metadata: metadata}
	if !r.store.memoryAvailable {
		metadata["availability"] = "unavailable"
		metadata["error"] = "repository memory is not present in this snapshot"
		return source, nil
	}
	metadata["completeness"] = "complete"
	var manifest model.Row
	if err := decode(string(r.store.memory.Manifest), &manifest); err != nil {
		return model.Source{}, err
	}
	if generated, ok := manifest["generatedAt"].(string); ok {
		metadata["as-of"] = generated
	}
	if name == repositorymemory.ManifestSource || name == "repository-memory-manifest" {
		source.Rows = []model.Row{manifest}
		return source, nil
	}
	keys := make([]string, 0, len(r.store.memory.Files))
	for key := range r.store.memory.Files {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	for _, key := range keys {
		campaign, path, _ := strings.Cut(key, "\x00")
		content := r.store.memory.Files[key]
		source.Rows = append(source.Rows, model.Row{"campaign": campaign, "path": path, "content": string(content), "size": len(content)})
	}
	return source, nil
}
