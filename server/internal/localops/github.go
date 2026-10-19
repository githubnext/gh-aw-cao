package localops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var resourcePath = regexp.MustCompile(`^/api/v1/github/repos/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_.-]{1,100})(/releases/latest|/contents/\.github/workflows/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}\.lock\.yml)?$`)

type githubService struct {
	options                     Options
	db                          *sql.DB
	mu                          sync.Mutex
	blocked, credentialsBlocked time.Time
	closed                      bool
	slots                       chan struct{}
	flights                     map[string]*githubFlight
	auth                        *credentialFlight
	ctx                         context.Context
	cancel                      context.CancelFunc
	now                         func() time.Time
	readToken                   func(context.Context) ([]byte, error)
	fetch                       func(context.Context, []string) ([]byte, error)
}
type credentialFlight struct {
	done  chan struct{}
	value []byte
	err   error
}
type githubFlight struct {
	done     chan struct{}
	response map[string]any
	err      error
}
type cachedGitHub struct {
	body           map[string]any
	etag, upstream string
	checked        time.Time
}

func newGitHubService(options Options) (*githubService, error) {
	path := filepath.Join(options.Workspace, ".cao", "github-resources.sqlite")
	if err := privateDirectory(filepath.Dir(path)); err != nil {
		return nil, err
	}
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if err := checkPrivateFile(path + suffix); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(context.Background(), "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS github_resources(id TEXT PRIMARY KEY,body TEXT NOT NULL,etag TEXT NOT NULL,upstream_etag TEXT,checked_at INTEGER NOT NULL)"); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		_ = db.Close()
		return nil, err
	}
	service := &githubService{options: options, db: db, slots: make(chan struct{}, 16), flights: map[string]*githubFlight{}, now: time.Now}
	service.ctx, service.cancel = context.WithCancel(context.Background())
	service.readToken = func(ctx context.Context) ([]byte, error) {
		return readCommand(ctx, options, 16<<10, "auth", "token", "--hostname", "github.com")
	}
	service.fetch = func(ctx context.Context, args []string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, options.GHExecutable, args...) // #nosec G204 -- trusted host executable and internally allowlisted GitHub read argv.
		cmd.Dir = options.Workspace
		cmd.Env = commandEnvironment()
		cmd.WaitDelay = 2 * time.Second
		configureProcess(cmd)
		cmd.Cancel = func() error { return killProcess(cmd) }
		stdout := &boundedBuffer{limit: 512 << 10}
		stderr := &boundedBuffer{limit: 16 << 10}
		cmd.Stdout, cmd.Stderr = stdout, stderr
		err := cmd.Run()
		return stdout.Bytes(), err
	}
	return service, nil
}
func (g *githubService) close() error {
	g.mu.Lock()
	g.closed = true
	g.cancel()
	auth := g.auth
	flights := make([]*githubFlight, 0, len(g.flights))
	for _, flight := range g.flights {
		flights = append(flights, flight)
	}
	g.mu.Unlock()
	if auth != nil {
		<-auth.done
	}
	for _, flight := range flights {
		<-flight.done
	}
	return g.db.Close()
}
func unavailableGitHub(status int, delay time.Duration) map[string]any {
	message := "Live GitHub data is unavailable."
	if status == 429 {
		message = "GitHub rate limit reached."
	}
	return map[string]any{"status": status, "headers": map[string]string{"Cache-Control": "no-store", "Retry-After": strconv.Itoa(max(1, int(math.Ceil(delay.Seconds()))))}, "body": map[string]any{"error": message}}
}
func githubError(status int, message string) map[string]any {
	return map[string]any{"status": status, "headers": map[string]string{"Cache-Control": "no-store"}, "body": map[string]any{"error": message}}
}
func (g *githubService) cached(entry *cachedGitHub, stale bool) map[string]any {
	headers := map[string]string{"ETag": entry.etag, "Cache-Control": "private, max-age=300, stale-while-revalidate=86400", "Age": strconv.FormatInt(max(0, int64(g.now().Sub(entry.checked).Seconds())), 10)}
	if stale {
		headers["Cache-Control"] = "private, max-age=0, stale-while-revalidate=86400"
		headers["Warning"] = `110 - "Response is stale"`
		g.mu.Lock()
		blocked := g.blocked
		g.mu.Unlock()
		if blocked.After(g.now()) {
			headers["Retry-After"] = strconv.Itoa(max(1, int(math.Ceil(blocked.Sub(g.now()).Seconds()))))
		}
	}
	return map[string]any{"status": 200, "headers": headers, "body": entry.body}
}
func (g *githubService) request(ctx context.Context, path, etag string) (any, error) {
	match := resourcePath.FindStringSubmatch(path)
	if len(match) == 0 || match[2] == "." || match[2] == ".." {
		return githubError(400, "Invalid GitHub resource."), nil
	}
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return nil, failure(503, "GitHub resource service is closed.")
	}
	credentialsBlocked := g.credentialsBlocked
	g.mu.Unlock()
	if g.now().Before(credentialsBlocked) {
		return unavailableGitHub(503, time.Minute), nil
	}
	credential, err := g.credential(ctx)
	if err != nil || strings.TrimSpace(string(credential)) == "" {
		g.mu.Lock()
		g.credentialsBlocked = g.now().Add(time.Minute)
		g.mu.Unlock()
		return unavailableGitHub(503, time.Minute), nil
	}
	upstream := "/repos/" + strings.ToLower(match[1]) + "/" + strings.ToLower(match[2]) + match[3]
	sum := sha256.Sum256(bytes.TrimSpace(credential))
	key := hex.EncodeToString(sum[:]) + ":" + upstream
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return nil, failure(503, "GitHub resource service is closed.")
	}
	if existing := g.flights[key]; existing != nil {
		g.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-existing.done:
			return conditionGitHub(existing.response, etag), existing.err
		}
	}
	select {
	case g.slots <- struct{}{}:
	default:
		g.mu.Unlock()
		return unavailableGitHub(429, time.Minute), nil
	}
	flight := &githubFlight{done: make(chan struct{})}
	g.flights[key] = flight
	g.mu.Unlock()
	defer func() { g.mu.Lock(); delete(g.flights, key); close(flight.done); <-g.slots; g.mu.Unlock() }()
	flight.response, flight.err = g.resolve(ctx, key, upstream, match[3])
	return conditionGitHub(flight.response, etag), flight.err
}
func (g *githubService) credential(ctx context.Context) ([]byte, error) {
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return nil, errors.New("github service is closed")
	}
	flight := g.auth
	if flight == nil {
		flight = &credentialFlight{done: make(chan struct{})}
		g.auth = flight
		go func(ctx context.Context) { //nolint:contextcheck // Shared credential lookup survives individual request cancellation and stops with the service.
			tokenCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			flight.value, flight.err = g.readToken(tokenCtx)
			g.mu.Lock()
			g.auth = nil
			close(flight.done)
			g.mu.Unlock()
		}(g.ctx)
	}
	g.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-flight.done:
		return flight.value, flight.err
	}
}
func conditionGitHub(response map[string]any, etag string) map[string]any {
	if response == nil || response["status"] != 200 || etag == "" {
		return response
	}
	headers, _ := response["headers"].(map[string]string)
	if headers["Warning"] != "" {
		return response
	}
	for _, candidate := range strings.Split(etag, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == headers["ETag"] {
			return map[string]any{"status": 304, "headers": headers}
		}
	}
	return response
}
func (g *githubService) resolve(ctx context.Context, key, path, suffix string) (map[string]any, error) {
	var serialized, etag string
	var upstream sql.NullString
	var checked int64
	err := g.db.QueryRowContext(ctx, "SELECT body,etag,upstream_etag,checked_at FROM github_resources WHERE id=?", key).Scan(&serialized, &etag, &upstream, &checked)
	var entry *cachedGitHub
	if err == nil {
		body := map[string]any{}
		if json.Unmarshal([]byte(serialized), &body) != nil {
			return nil, errors.New("github cache is invalid")
		}
		entry = &cachedGitHub{body, etag, upstream.String, time.UnixMilli(checked)}
		if g.now().Sub(entry.checked) > 24*time.Hour+5*time.Minute {
			if _, err = g.db.ExecContext(ctx, "DELETE FROM github_resources WHERE id=?", key); err != nil {
				return nil, err
			}
			entry = nil
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if entry != nil && g.now().Sub(entry.checked) < 5*time.Minute {
		return g.cached(entry, false), nil
	}
	g.mu.Lock()
	blocked := g.blocked
	g.mu.Unlock()
	if g.now().Before(blocked) {
		if entry != nil {
			return g.cached(entry, true), nil
		}
		return unavailableGitHub(429, blocked.Sub(g.now())), nil
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	args := []string{"api", "--hostname", "github.com", "--method", "GET", "--include", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10"}
	if entry != nil && entry.upstream != "" {
		args = append(args, "-H", "If-None-Match: "+entry.upstream)
	}
	args = append(args, path)
	response, executeErr := g.fetch(ctx, args)
	status, headers, raw, parseErr := parseGitHubResponse(response)
	if len(response) > 512<<10 {
		parseErr = errors.New("github response exceeds limit")
	}
	if contentLength, err := strconv.ParseInt(headers.Get("Content-Length"), 10, 64); err == nil && contentLength > 512<<10 {
		parseErr = errors.New("github response exceeds limit")
	}
	if parseErr != nil {
		g.block(30 * time.Second)
		if entry != nil {
			return g.cached(entry, true), nil
		}
		return unavailableGitHub(503, time.Minute), nil
	}
	if headers.Get("X-RateLimit-Remaining") == "0" {
		reset, _ := strconv.ParseInt(headers.Get("X-RateLimit-Reset"), 10, 64)
		g.block(max(time.Minute, time.Unix(reset, 0).Sub(g.now())))
	}
	if status == 304 && entry != nil {
		entry.checked = g.now()
		if err = g.save(ctx, key, entry); err != nil {
			return nil, err
		}
		return g.cached(entry, false), nil
	}
	if status == 429 || status == 403 && (headers.Get("Retry-After") != "" || headers.Get("X-RateLimit-Remaining") == "0") {
		delay := time.Minute
		if value, e := strconv.Atoi(headers.Get("Retry-After")); e == nil && value > 0 {
			delay = time.Duration(min(value, 86400)) * time.Second
		} else if date, e := http.ParseTime(headers.Get("Retry-After")); e == nil {
			delay = max(time.Second, date.Sub(g.now()))
		}
		g.block(delay)
		if entry != nil {
			return g.cached(entry, true), nil
		}
		return unavailableGitHub(429, delay), nil
	}
	if status < 200 || status >= 300 || executeErr != nil {
		if status == 404 || status == 401 || status == 403 {
			if _, err = g.db.ExecContext(ctx, "DELETE FROM github_resources WHERE id=?", key); err != nil {
				return nil, err
			}
		}
		if status == 404 {
			return githubError(404, "GitHub resource not found."), nil
		}
		if status == 401 || status == 403 {
			g.block(time.Minute)
		}
		if status >= 500 && entry != nil {
			return g.cached(entry, true), nil
		}
		return unavailableGitHub(503, time.Minute), nil
	}
	body, err := normalizeGitHubResource(raw, suffix)
	if err != nil {
		g.block(30 * time.Second)
		if entry != nil {
			return g.cached(entry, true), nil
		}
		return unavailableGitHub(503, time.Minute), nil
	}
	encoded, _ := json.Marshal(body)
	sum := sha256.Sum256(encoded)
	entry = &cachedGitHub{body, `"` + hex.EncodeToString(sum[:]) + `"`, headers.Get("ETag"), g.now()}
	if err = g.save(ctx, key, entry); err != nil {
		return nil, err
	}
	return g.cached(entry, false), nil
}
func (g *githubService) block(delay time.Duration) {
	g.mu.Lock()
	g.blocked = maxTime(g.blocked, g.now().Add(delay))
	g.mu.Unlock()
}
func (g *githubService) save(ctx context.Context, key string, entry *cachedGitHub) error {
	raw, err := json.Marshal(entry.body)
	if err != nil {
		return err
	}
	if len(raw) > 64<<10 {
		return errors.New("github resource exceeds cache limit")
	}
	tx, err := g.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, "INSERT INTO github_resources VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,etag=excluded.etag,upstream_etag=excluded.upstream_etag,checked_at=excluded.checked_at", key, string(raw), entry.etag, entry.upstream, entry.checked.UnixMilli()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM github_resources WHERE checked_at < ?", g.now().Add(-24*time.Hour-5*time.Minute).UnixMilli()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM github_resources WHERE id IN (SELECT id FROM github_resources ORDER BY checked_at DESC,id LIMIT -1 OFFSET 128)"); err != nil {
		return err
	}
	return tx.Commit()
}
func parseGitHubResponse(raw []byte) (int, http.Header, []byte, error) {
	normalized := strings.ReplaceAll(string(raw), "\r\n", "\n")
	head, body, present := strings.Cut(normalized, "\n\n")
	if !present {
		return 0, nil, nil, errors.New("invalid GitHub response")
	}
	lines := strings.Split(head, "\n")
	var status int
	fields := strings.Fields(lines[0])
	if len(fields) < 2 || !strings.HasPrefix(fields[0], "HTTP/") {
		return 0, nil, nil, errors.New("invalid GitHub status")
	}
	status, _ = strconv.Atoi(fields[1])
	if status < 100 || status > 599 {
		return 0, nil, nil, errors.New("invalid GitHub status")
	}
	headers := http.Header{}
	for _, line := range lines[1:] {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			return 0, nil, nil, errors.New("invalid GitHub header")
		}
		headers.Add(key, strings.TrimSpace(value))
	}
	return status, headers, []byte(body), nil
}
func normalizeGitHubResource(raw []byte, suffix string) (map[string]any, error) {
	value := map[string]any{}
	if len(raw) > 512<<10 || json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, errors.New("invalid GitHub resource")
	}
	fields := []string{"full_name", "description", "html_url", "default_branch", "stargazers_count", "forks_count", "open_issues_count", "archived", "visibility"}
	if suffix == "/releases/latest" {
		fields = []string{"tag_name", "name", "html_url", "published_at", "draft", "prerelease"}
	}
	if strings.HasPrefix(suffix, "/contents/") {
		path := strings.TrimPrefix(suffix, "/contents/")
		if value["type"] != "file" || value["path"] != path || value["encoding"] != "base64" || !regexp.MustCompile(`(?i)^[0-9a-f]{40,64}$`).MatchString(text(value["sha"])) {
			return nil, errors.New("invalid compiler resource")
		}
		decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(text(value["content"]), "\n", ""))
		if err != nil {
			return nil, err
		}
		metadata := regexp.MustCompile(`(?m)^# gh-aw-metadata: (.+)$`).FindSubmatch(decoded)
		compiler := map[string]any{}
		if len(metadata) != 2 || json.Unmarshal(metadata[1], &compiler) != nil {
			return nil, errors.New("missing compiler metadata")
		}
		version := text(compiler["compiler_version"])
		if !strings.HasPrefix(version, "v") {
			version = "v" + version
		}
		if !compilerVersionPattern.MatchString(version) {
			return nil, errors.New("invalid compiler version")
		}
		value = map[string]any{"path": path, "sha": value["sha"], "gh_aw_version": version}
		fields = []string{"path", "sha", "gh_aw_version"}
	}
	result := map[string]any{}
	for _, field := range fields {
		v := value[field]
		var valid bool
		switch field {
		case "archived", "draft", "prerelease":
			_, valid = v.(bool)
		case "stargazers_count", "forks_count", "open_issues_count":
			n, ok := v.(float64)
			valid = ok && n >= 0 && n <= 1<<53-1 && n == float64(int64(n))
		default:
			_, valid = v.(string)
			if v == nil && (field == "description" || field == "name" || field == "published_at") {
				valid = true
			}
		}
		if !valid {
			return nil, errors.New("invalid GitHub resource field")
		}
		result[field] = v
	}
	raw, _ = json.Marshal(result)
	if len(raw) > 64<<10 {
		return nil, errors.New("github resource exceeds cache limit")
	}
	return result, nil
}
