package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/server/internal/sqlitex"
)

const defaultSQLiteDataURL = "https://githubnext.github.io/gh-cao/cao/payload-hashes.json"
const defaultSQLitePath = "../.cao/gh-aw-logs.sqlite"
const maxSQLiteManifestBytes int64 = 8 << 20
const maxSQLiteDownloadBytes int64 = 2 << 30

type sqliteDownloadError struct {
	message string
	retry   bool
	status  int
}

func (e *sqliteDownloadError) Error() string { return e.message }

func sqliteManifestURLs(raw string) ([]*url.URL, error) {
	location, err := url.Parse(raw)
	if err != nil || location.Hostname() == "" || (location.Scheme != "https" && location.Scheme != "http") {
		return nil, errors.New("--download-sqlite URL must use HTTP or HTTPS")
	}
	if location.User != nil || location.Fragment != "" {
		return nil, errors.New("--download-sqlite URL must not contain credentials or a fragment")
	}
	if strings.HasSuffix(location.Path, "/payload-hashes.json") {
		return []*url.URL{location}, nil
	}
	location.Path = strings.TrimRight(strings.TrimSuffix(location.Path, "/index.html"), "/") + "/"
	location.RawPath = ""
	return []*url.URL{
		location.ResolveReference(&url.URL{Path: "payload-hashes.json"}),
		location.ResolveReference(&url.URL{Path: "cao/payload-hashes.json"}),
	}, nil
}

func downloadSQLite(ctx context.Context, rawURL, destination string) error {
	manifestURLs, err := sqliteManifestURLs(rawURL)
	if err != nil {
		return err
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	if err := validateSQLiteDestination(destination); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return fmt.Errorf("create SQLite cache directory: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	client := &http.Client{
		Timeout: 5 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			if request.URL.User != nil ||
				(request.URL.Scheme != "http" && request.URL.Scheme != "https") ||
				(via[len(via)-1].URL.Scheme == "https" && request.URL.Scheme != "https") {
				return errors.New("unsafe SQLite download redirect")
			}
			return nil
		},
	}
	for attempt := 1; ; attempt++ {
		err := downloadSQLiteAttempt(ctx, client, manifestURLs, destination)
		if err == nil {
			return nil
		}
		var failure *sqliteDownloadError
		if attempt == 3 || !errors.As(err, &failure) || !failure.retry {
			return err
		}
		commandLog.Printf("retrying SQLite snapshot download attempt=%d", attempt+1)
		timer := time.NewTimer(time.Duration(attempt) * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func validateSQLiteDestination(destination string) error {
	info, err := os.Lstat(destination)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect SQLite cache destination: %w", err)
	}
	if err == nil && !info.Mode().IsRegular() {
		return errors.New("SQLite cache destination must be a regular file, not a directory or symlink")
	}
	// An old WAL must never be replayed against a newly downloaded database.
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Lstat(destination + suffix); err == nil {
			return errors.New("SQLite cache has journal sidecars; stop its users and checkpoint it, or choose a new --sqlite path")
		} else if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("inspect SQLite cache journal: %w", err)
		}
	}
	return nil
}

func downloadSQLiteAttempt(ctx context.Context, client *http.Client, manifestURLs []*url.URL, destination string) (err error) {
	manifest := &strings.Builder{}
	var manifestURL *url.URL
	for index, candidate := range manifestURLs {
		manifest.Reset()
		resolvedURL, err := fetchSQLitePayload(ctx, client, candidate, "manifest", manifest, maxSQLiteManifestBytes)
		if err == nil {
			manifestURL = resolvedURL
			break
		}
		var failure *sqliteDownloadError
		if index == len(manifestURLs)-1 || !errors.As(err, &failure) || failure.status != http.StatusNotFound {
			return err
		}
	}
	var hashes map[string]json.RawMessage
	if err := json.Unmarshal([]byte(manifest.String()), &hashes); err != nil {
		return errors.New("SQLite snapshot manifest must contain a JSON object")
	}
	var expected string
	if err := json.Unmarshal(hashes["gh-aw-logs.sqlite"], &expected); err != nil {
		return errors.New("SQLite snapshot manifest contains no valid SQLite SHA-256 checksum")
	}
	digest, err := hex.DecodeString(expected)
	if err != nil || len(digest) != sha256.Size {
		return errors.New("SQLite snapshot manifest contains no valid SQLite SHA-256 checksum")
	}
	staging, err := os.MkdirTemp(filepath.Dir(destination), ".cao-snapshot-")
	if err != nil {
		return err
	}
	defer func() {
		err = errors.Join(err, os.RemoveAll(staging))
	}()
	temporary, err := os.CreateTemp(staging, "snapshot-*.sqlite")
	if err != nil {
		return err
	}
	if err := func() (err error) {
		defer func() { err = errors.Join(err, temporary.Close()) }()
		hash := sha256.New()
		location := manifestURL.ResolveReference(&url.URL{Path: "gh-aw-logs.sqlite"})
		if _, err := fetchSQLitePayload(ctx, client, location, "image", io.MultiWriter(temporary, hash), maxSQLiteDownloadBytes); err != nil {
			return err
		}
		if hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(expected) {
			return &sqliteDownloadError{message: "SQLite snapshot checksum mismatch; the Pages deployment may be changing", retry: true}
		}
		return temporary.Sync()
	}(); err != nil {
		return err
	}
	snapshot, err := sqlitex.Open(ctx, temporary.Name())
	if err != nil {
		return fmt.Errorf("validate downloaded SQLite snapshot: %w", err)
	}
	if err := snapshot.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateSQLiteDestination(destination); err != nil {
		return err
	}
	if err := os.Rename(temporary.Name(), destination); err != nil {
		return fmt.Errorf("publish downloaded SQLite snapshot: %w", err)
	}
	return nil
}

func fetchSQLitePayload(ctx context.Context, client *http.Client, location *url.URL, resource string, destination io.Writer, limit int64) (_ *url.URL, err error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create SQLite %s request", resource)
	}
	request.Header.Set("Accept", "application/octet-stream, application/json")
	request.Header.Set("Cache-Control", "no-cache")
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Transport errors can include the full URL, including secret query values.
		return nil, &sqliteDownloadError{message: fmt.Sprintf("download SQLite %s: transport failure or rejected redirect", resource), retry: true}
	}
	defer func() { err = errors.Join(err, response.Body.Close()) }()
	if response.StatusCode != http.StatusOK {
		retry := response.StatusCode == 408 || response.StatusCode == 425 ||
			response.StatusCode == 429 || response.StatusCode >= 500
		return nil, &sqliteDownloadError{message: fmt.Sprintf("download SQLite %s: HTTP %d", resource, response.StatusCode), retry: retry, status: response.StatusCode}
	}
	if response.ContentLength > limit {
		return nil, fmt.Errorf("SQLite %s exceeds the %d-byte download limit", resource, limit)
	}
	size, err := io.Copy(destination, io.LimitReader(response.Body, limit+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, &sqliteDownloadError{message: fmt.Sprintf("download SQLite %s: interrupted response", resource), retry: true}
		}
		return nil, fmt.Errorf("write downloaded SQLite %s: %w", resource, err)
	}
	if size > limit {
		return nil, fmt.Errorf("SQLite %s exceeds the %d-byte download limit", resource, limit)
	}
	if size == 0 {
		return nil, fmt.Errorf("download SQLite %s: empty response", resource)
	}
	return response.Request.URL, nil
}
