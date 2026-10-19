// Package localpreview prepares native dashboard previews from verified,
// published canonical snapshots. It never executes a JavaScript runtime.
package localpreview

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/dashboard"
)

// Options identifies workspace-owned sources. Relative paths are resolved from
// Workspace. DataDirectory is an explicit offline alternative to a gh artifact.
type Options struct {
	Workspace, SiteDirectory, CatalogDirectory, Repository, GHExecutable string
	DataDirectory, DashboardPath                                         string
	Canvas, Admin                                                        bool
}

// Workspace owns a disposable directory underneath the selected workspace.
// SourceDirectory contains a verified native SQLite snapshot and its sidecars.
type Workspace struct {
	Directory, SiteDirectory, OverlayDirectory, SourceDirectory string
	DatabasePath, DatabaseQueriesPath, Prefix                   string

	options   Options
	base      string
	catalog   string
	mu        sync.Mutex
	closed    bool
	signature [32]byte
	current   []byte
	document  map[string]any
}

// Prepare authenticates and verifies the latest published artifact, or uses an
// explicitly supplied offline snapshot. Failure removes all disposable files.
func Prepare(ctx context.Context, options Options) (_ *Workspace, err error) {
	if options.Canvas && options.Admin {
		return nil, errors.New("admin mode cannot be combined with canvas mode")
	}
	if options.Workspace == "" {
		options.Workspace = "."
	}
	options.Workspace, err = filepath.Abs(options.Workspace)
	if err != nil {
		return nil, err
	}
	options.Workspace, err = filepath.EvalSymlinks(options.Workspace)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(options.Workspace)
	if err != nil || !info.IsDir() {
		return nil, errors.New("preview workspace must be an existing directory")
	}
	// Resolve inputs before creating the output, so an invalid input never
	// leaves state behind and symlinked paths cannot widen workspace authority.
	for _, field := range []*string{&options.SiteDirectory, &options.CatalogDirectory, &options.DataDirectory, &options.DashboardPath} {
		if *field == "" {
			continue
		}
		*field, err = ownedPath(options.Workspace, *field)
		if err != nil {
			return nil, err
		}
	}
	if options.CatalogDirectory == "" {
		if _, e := os.Stat(filepath.Join(options.Workspace, "dashboard", "site", "dashboard.json")); e == nil {
			options.CatalogDirectory = options.Workspace
		}
	}
	directory, err := os.MkdirTemp(options.Workspace, ".cao-dashboard-preview-")
	if err != nil {
		return nil, err
	}
	w := &Workspace{Directory: directory, options: options, catalog: options.CatalogDirectory}
	defer func() {
		if err != nil {
			_ = w.Close()
		}
	}()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	artifact := filepath.Join(directory, "artifact")
	if err := os.Mkdir(artifact, 0o700); err != nil {
		return nil, err
	}
	if options.DataDirectory != "" {
		if err := copyTree(ctx, options.DataDirectory, artifact, directory); err != nil {
			return nil, err
		}
	} else {
		repository, e := download(ctx, options, artifact)
		if e != nil {
			return nil, e
		}
		w.options.Repository = repository
	}
	index, err := inspectArtifact(ctx, artifact)
	if err != nil {
		return nil, err
	}
	w.SourceDirectory = index.canonical
	w.DatabasePath = filepath.Join(index.canonical, "gh-aw-logs.sqlite")
	if err := validateSnapshot(ctx, index.canonical); err != nil {
		return nil, err
	}
	if err := w.refreshCompilerMetadata(ctx); err != nil {
		return nil, err
	}
	w.SiteDirectory = options.SiteDirectory
	if w.SiteDirectory == "" {
		w.SiteDirectory = index.site
	}
	if w.SiteDirectory == "" {
		w.SiteDirectory = filepath.Join(directory, "site")
		if err := extractSite(ctx, w.SiteDirectory); err != nil {
			return nil, err
		}
	}
	if _, err := regularFile(w.SiteDirectory, "index.html"); err != nil {
		return nil, errors.New("dashboard site must contain a regular index.html")
	}
	w.base = options.DashboardPath
	if w.base == "" && options.SiteDirectory == "" && w.catalog != "" {
		candidate := filepath.Join(w.catalog, "dashboard", "site", "dashboard.json")
		if _, e := os.Stat(candidate); e == nil {
			w.base, err = ownedPath(options.Workspace, candidate)
			if err != nil {
				return nil, err
			}
		}
	}
	if w.base == "" {
		w.base, err = regularFile(w.SiteDirectory, "dashboard.json")
		if err != nil {
			return nil, errors.New("dashboard site must contain dashboard.json")
		}
	}
	w.DatabaseQueriesPath = filepath.Join(directory, "database-queries.json")
	queries, err := dashboard.Catalog.ReadFile("site/src/data/queries/database.json")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(w.DatabaseQueriesPath, queries, 0o600); err != nil {
		return nil, err
	}
	capability := make([]byte, 24)
	if _, err := rand.Read(capability); err != nil {
		return nil, err
	}
	w.Prefix = "/" + hex.EncodeToString(capability)
	w.OverlayDirectory = filepath.Join(directory, "public")
	if err := os.Mkdir(w.OverlayDirectory, 0o700); err != nil {
		return nil, err
	}
	if err := w.prepareBrowserAssets(); err != nil {
		return nil, err
	}
	if err := w.publishData(ctx); err != nil {
		return nil, err
	}
	if _, err := w.Refresh(); err != nil {
		return nil, err
	}
	return w, nil
}

// Close is idempotent and removes only this preview's disposable files.
func (w *Workspace) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	return os.RemoveAll(w.Directory)
}

// Dashboard returns an independent copy of the complete declarative document.
func (w *Workspace) Dashboard() map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	content, _ := json.Marshal(w.document)
	var document map[string]any
	_ = json.Unmarshal(content, &document)
	return document
}

// Refresh publishes a valid document atomically. Invalid edits leave all
// previously published files and the active document unchanged.
func (w *Workspace) Refresh() ([]byte, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil, errors.New("preview workspace is closed")
	}
	document, signature, err := w.compose()
	if err != nil {
		return nil, err
	}
	if signature == w.signature && w.current != nil {
		return append([]byte(nil), w.current...), nil
	}
	document = redact(document, "").(map[string]any)
	core, chunks, err := splitDocument(document)
	if err != nil {
		return nil, err
	}
	content, err := json.Marshal(core)
	if err != nil {
		return nil, err
	}
	for name, chunk := range chunks {
		if err := atomicWrite(w.OverlayDirectory, name, chunk); err != nil {
			return nil, err
		}
	}
	if err := atomicWrite(w.OverlayDirectory, "dashboard.json", content); err != nil {
		return nil, err
	}
	w.signature, w.current, w.document = signature, content, document
	return append([]byte(nil), content...), nil
}

// Watch polls declarative inputs, including new campaigns and custom views.
// Invalid updates are ignored until fixed; callbacks only see valid changes.
// It blocks until cancellation or Close and does not invoke the callback under
// a lock, so callbacks may safely read Dashboard or request another refresh.
func (w *Workspace) Watch(ctx context.Context, onDashboard func([]byte)) error {
	w.mu.Lock()
	previous := sha256.Sum256(w.current)
	w.mu.Unlock()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			w.mu.Lock()
			closed := w.closed
			w.mu.Unlock()
			if closed {
				return nil
			}
			content, err := w.Refresh()
			if err != nil {
				continue
			}
			next := sha256.Sum256(content)
			if next != previous {
				previous = next
				if onDashboard != nil {
					onDashboard(content)
				}
			}
		}
	}
}

func within(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && (relative == "." || filepath.IsLocal(relative))
}

func ownedPath(root, name string) (string, error) {
	if !filepath.IsAbs(name) {
		name = filepath.Join(root, name)
	}
	resolved, err := filepath.EvalSymlinks(name)
	if err != nil {
		return "", errors.New("dashboard path must exist within the workspace")
	}
	if !within(root, resolved) {
		return "", errors.New("dashboard paths must remain within the workspace")
	}
	return resolved, nil
}

func regularFile(root, name string) (string, error) {
	if !fs.ValidPath(name) || strings.ContainsAny(name, "\\\x00") {
		return "", errors.New("unsafe dashboard file path")
	}
	candidate := filepath.Join(root, filepath.FromSlash(name))
	resolved, err := filepath.EvalSymlinks(candidate)
	if errors.Is(err, fs.ErrNotExist) {
		return "", errors.New("dashboard input file does not exist within its source directory")
	}
	if err != nil || !within(root, resolved) {
		return "", errors.New("dashboard file escapes its source directory")
	}
	info, err := os.Lstat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("dashboard input must be a regular file")
	}
	return resolved, nil
}

func copyTree(ctx context.Context, source, destination, exclude string) error {
	inputRoot, err := os.OpenRoot(source)
	if err != nil {
		return err
	}
	defer func() { _ = inputRoot.Close() }()
	outputRoot, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer func() { _ = outputRoot.Close() }()
	return filepath.WalkDir(source, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if exclude != "" && within(exclude, name) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(source, name)
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("dashboard artifacts must not contain symbolic links")
		}
		if entry.IsDir() {
			return outputRoot.MkdirAll(relative, 0o700)
		}
		if !entry.Type().IsRegular() {
			return errors.New("dashboard artifact contains a non-regular file")
		}
		input, err := inputRoot.Open(relative)
		if err != nil {
			return err
		}
		output, err := outputRoot.OpenFile(relative, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			_ = input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		return errors.Join(copyErr, input.Close(), output.Close())
	})
}

func extractSite(ctx context.Context, destination string) error {
	return fs.WalkDir(dashboard.Site, "site", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		target := filepath.Join(destination, filepath.FromSlash(strings.TrimPrefix(name, "site")))
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		content, err := dashboard.Site.ReadFile(name)
		if err != nil {
			return err
		}
		return os.WriteFile(target, content, 0o600)
	})
}

func atomicWrite(root, name string, content []byte) error {
	if !fs.ValidPath(name) || strings.Contains(name, `\`) {
		return errors.New("unsafe overlay path")
	}
	directory := filepath.Dir(name)
	handle, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = handle.Close() }()
	if err := handle.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	random := make([]byte, 12)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	pending := filepath.Join(directory, ".pending-"+hex.EncodeToString(random))
	file, err := handle.OpenFile(pending, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = handle.Remove(pending) }()
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return handle.Rename(pending, name)
}

func readObject(path string) (map[string]any, []byte, error) {
	content, err := os.ReadFile(path) // #nosec G304 -- Callers validate explicit document or artifact paths before parsing.
	if err != nil {
		return nil, nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(content, &value); err != nil || value == nil {
		return nil, nil, fmt.Errorf("%s must contain a JSON object", filepath.Base(path))
	}
	return value, content, nil
}
