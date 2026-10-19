package localops

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

const recoveryMessage = "CLI queue recovery is blocked: interrupted subprocess termination is unverified. Operator reconciliation is required."
const queueSchema = `
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;
PRAGMA wal_autocheckpoint=128;
PRAGMA journal_size_limit=1048576;
CREATE TABLE IF NOT EXISTS jobs(
 id INTEGER PRIMARY KEY AUTOINCREMENT, invocation TEXT NOT NULL,
 idempotency_key TEXT UNIQUE, fingerprint TEXT NOT NULL,
 status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER,
 completed_at INTEGER, completion_week TEXT, deadline INTEGER,
 ok INTEGER, exit_code INTEGER, error TEXT, output_bytes INTEGER NOT NULL DEFAULT 0,
 output_chunks INTEGER NOT NULL DEFAULT 0, output_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_fifo ON jobs(status,id);
CREATE INDEX IF NOT EXISTS jobs_retention ON jobs(completion_week);
CREATE TABLE IF NOT EXISTS output(job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL,stream TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job_id,seq));
CREATE TABLE IF NOT EXISTS queue_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS execution_claims(job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE RESTRICT);
`

var secretKey = regexp.MustCompile(`(?i)token|secret|password|credential|authorization|private[-_]?key`)
var secretValue = regexp.MustCompile(`(?i)\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|(?:token|secret|password|credential|authorization|private[-_]?key)\s*["']?\s*[:=]\s*["']?\S+|--[\w-]*(?:token|password|secret|credential)\b`)
var tokenValue = regexp.MustCompile(`(?i)\b(?:gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|AKIA[A-Z0-9]{16})`)
var bearerValue = regexp.MustCompile(`(?i)\bBearer\s+\S+`)
var assignmentValue = regexp.MustCompile(`(?i)((?:token|secret|password|credential|authorization|private[-_]?key)\s*["']?\s*[:=]\s*).*`)
var outputURL = regexp.MustCompile("https://[^\\s\\x00-\\x20\\x7f<>\"'`]+")
var pullRequestPath = regexp.MustCompile(`^/(?:[A-Za-z0-9_.~-]+/)+[A-Za-z0-9_.~-]+/pull/[1-9][0-9]*$`)

func lastPullRequestURL(data string) string {
	last := ""
	for _, candidate := range outputURL.FindAllString(data, -1) {
		parsed, err := url.Parse(strings.TrimRight(candidate, ").,;!?]}"))
		if err != nil || !pullRequestPath.MatchString(parsed.Path) {
			continue
		}
		parsed.RawQuery, parsed.Fragment, parsed.RawFragment, parsed.ForceQuery = "", "", "", false
		if _, err = validateDashboardURL(parsed.String()); err == nil {
			last = parsed.String()
		}
	}
	return last
}

var idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

type queue struct {
	mu            sync.Mutex
	db, owner     *sql.DB
	ownerConn     *sql.Conn
	options       Options
	active        map[int64]context.CancelFunc
	wake          chan struct{}
	changed       chan struct{}
	ctx           context.Context
	cancelContext context.CancelFunc
	wg            sync.WaitGroup
	closed        bool
	revision      uint64
	reason        string
	secrets       []string
	credentials   map[string]int
	admission     *nativeQuota
}

func checkPrivateFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("queue files must be regular, single-link files owned by the current user")
	}
	return privateMetadata(path, info, false)
}

func privateDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("queue directory must be owned by the current user and not a symlink")
	}
	if err = privateMetadata(path, info, true); err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil || real != path {
		return errors.New("queue directory cannot traverse symbolic links")
	}
	return privateDirectoryPermissions(path, info)
}

func newQueue(options Options) (_ *queue, err error) {
	ctx := context.Background()
	path, err := filepath.Abs(options.QueuePath)
	if err != nil || path == ":memory:" {
		return nil, errors.New("durable queue filename required")
	}
	if err := privateDirectory(filepath.Dir(path)); err != nil {
		return nil, err
	}
	for _, base := range []string{path, path + ".owner.sqlite"} {
		for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
			if err := checkPrivateFile(base + suffix); err != nil {
				return nil, err
			}
		}
	}
	owner, err := sql.Open("sqlite", path+".owner.sqlite")
	if err != nil {
		return nil, err
	}
	owner.SetMaxOpenConns(1)
	var ownerConn *sql.Conn
	var db *sql.DB
	defer func() {
		if err != nil {
			if db != nil {
				_ = db.Close()
			}
			if ownerConn != nil {
				_ = ownerConn.Close()
			}
			_ = owner.Close()
		}
	}()
	ownerConn, err = owner.Conn(ctx)
	if err != nil {
		return nil, err
	}
	if _, err = ownerConn.ExecContext(ctx, "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE"); err != nil {
		return nil, errors.New("CLI queue database is unavailable or already owned")
	}
	if err = os.Chmod(path+".owner.sqlite", 0600); err != nil {
		return nil, err
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(ctx, queueSchema); err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		return nil, err
	}
	backfill := false
	for _, name := range []string{"retry_of", "pull_request_url"} {
		found, e := queueHasColumn(ctx, db, name)
		if e != nil {
			return nil, e
		}
		if !found {
			kind := "INTEGER"
			if name == "pull_request_url" {
				kind = "TEXT"
				backfill = true
			}
			if _, err = db.ExecContext(ctx, "ALTER TABLE jobs ADD COLUMN "+name+" "+kind); err != nil {
				return nil, err
			}
		}
		if backfill {
			if err = backfillPullRequestURLs(ctx, db); err != nil {
				return nil, err
			}
		}
	}
	var pages, pageSize int64
	if err = db.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pages); err != nil {
		return nil, err
	}
	if err = db.QueryRowContext(ctx, "PRAGMA page_size").Scan(&pageSize); err != nil {
		return nil, err
	}
	if pages*pageSize > 128<<20 {
		return nil, errors.New("queue database size limit exceeded")
	}
	if _, err = db.ExecContext(ctx, fmt.Sprintf("PRAGMA max_page_count=%d", (128<<20)/pageSize)); err != nil {
		return nil, err
	}
	q := &queue{db: db, owner: owner, ownerConn: ownerConn, options: options, active: map[int64]context.CancelFunc{}, wake: make(chan struct{}, 1), changed: make(chan struct{}, 1)}
	q.ctx, q.cancelContext = context.WithCancel(ctx)
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		if secretKey.MatchString(key) && len(value) >= 8 && value != "true" && value != "false" && value != "enabled" && value != "disabled" {
			q.secrets = append(q.secrets, value)
		}
	}
	var interrupted int
	if err = db.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM jobs WHERE status='running')+(SELECT count(*) FROM execution_claims)").Scan(&interrupted); err != nil {
		return nil, err
	}
	if interrupted > 0 {
		tx, e := db.BeginTx(ctx, nil)
		if e != nil {
			return nil, e
		}
		_, e = tx.ExecContext(ctx, "INSERT OR REPLACE INTO queue_state VALUES('recovery_blocked',?)", recoveryMessage)
		if e == nil {
			_, e = tx.ExecContext(ctx, "UPDATE jobs SET status='failed',ok=0,error='CLI action interrupted; subprocess termination is unverified.',completed_at=?,completion_week=? WHERE status='running'", time.Now().UnixMilli(), monday(time.Now()))
		}
		if e != nil {
			_ = tx.Rollback()
			return nil, e
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
	}
	if options.AcknowledgeRecovery {
		if _, err = db.ExecContext(ctx, "BEGIN IMMEDIATE; DELETE FROM execution_claims; DELETE FROM queue_state WHERE key='recovery_blocked'; COMMIT"); err != nil {
			return nil, err
		}
	}
	e := db.QueryRowContext(ctx, "SELECT value FROM queue_state WHERE key='recovery_blocked'").Scan(&q.reason)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return nil, e
	}
	if err = q.retainLocked(ctx); err != nil {
		return nil, err
	}
	q.admission, err = newNativeQuota(options)
	if err != nil {
		return nil, err
	}
	q.wg.Add(2)
	go q.pump()
	go q.notifyChanges()
	q.signal()
	return q, nil
}

func queueHasColumn(ctx context.Context, db *sql.DB, name string) (bool, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info(jobs)")
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	found := false
	for rows.Next() {
		var cid, notNull, pk int
		var column, kind string
		var def any
		if err := rows.Scan(&cid, &column, &kind, &notNull, &def, &pk); err != nil {
			return false, err
		}
		if column == name {
			found = true
		}
	}
	return found, rows.Err()
}

func backfillPullRequestURLs(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, "SELECT job_id,data FROM output ORDER BY job_id,seq")
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	addresses := map[int64]string{}
	for rows.Next() {
		var id int64
		var data string
		if err = rows.Scan(&id, &data); err != nil {
			return err
		}
		if address := lastPullRequestURL(data); address != "" {
			addresses[id] = address
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if err = rows.Close(); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for id, address := range addresses {
		if _, err = tx.ExecContext(ctx, "UPDATE jobs SET pull_request_url=? WHERE id=?", address, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func monday(now time.Time) string {
	now = now.UTC()
	weekday := (int(now.Weekday()) + 6) % 7
	return now.AddDate(0, 0, -weekday).Format("2006-01-02")
}
func (q *queue) retainLocked(ctx context.Context) error {
	result, err := q.db.ExecContext(ctx, "DELETE FROM jobs WHERE completion_week < ? AND status NOT IN ('queued','running') AND id NOT IN (SELECT job_id FROM execution_claims)", monday(time.Now().Add(-30*24*time.Hour)))
	if err != nil {
		return err
	}
	deleted, err := result.RowsAffected()
	if err == nil && deleted > 0 {
		q.revision++
		q.signal()
	}
	return err
}
func (q *queue) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
	select {
	case q.changed <- struct{}{}:
	default:
	}
}
func (q *queue) notifyChanges() {
	defer q.wg.Done()
	for {
		select {
		case <-q.ctx.Done():
			return
		case <-q.changed:
			if q.options.OnQueueChanged != nil {
				q.options.OnQueueChanged()
			}
		}
	}
}
func number(value any, fallback, minimum, maximum int64) (int64, error) {
	if value == nil || value == "" {
		return fallback, nil
	}
	var n int64
	switch v := value.(type) {
	case int:
		n = int64(v)
	case int64:
		n = v
	case float64:
		n = int64(v)
		if float64(n) != v {
			return 0, failure(400, "Invalid queue integer.")
		}
	case string:
		var err error
		n, err = strconv.ParseInt(v, 10, 64)
		if err != nil {
			return 0, failure(400, "Invalid queue integer.")
		}
	default:
		return 0, failure(400, "Invalid queue integer.")
	}
	if n < minimum || n > maximum {
		return 0, failure(400, "Invalid queue integer.")
	}
	return n, nil
}
func (q *queue) detail(ctx context.Context, id any) (map[string]any, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.detailLocked(ctx, id)
}
func (q *queue) detailLocked(ctx context.Context, rawID any) (map[string]any, error) {
	id, err := number(rawID, 0, 1, 1<<53-1)
	if err != nil {
		return nil, err
	}
	var invocation, status string
	var key, week, errorText, pr sql.NullString
	var created int64
	var started, completed, deadline, ok, exit, retry sql.NullInt64
	var bytes, chunks, truncated int
	err = q.db.QueryRowContext(ctx, "SELECT invocation,status,idempotency_key,created_at,started_at,completed_at,completion_week,deadline,ok,exit_code,error,output_bytes,output_chunks,output_truncated,retry_of,pull_request_url FROM jobs WHERE id=?", id).Scan(&invocation, &status, &key, &created, &started, &completed, &week, &deadline, &ok, &exit, &errorText, &bytes, &chunks, &truncated, &retry, &pr)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, failure(404, "CLI command was not found.")
	}
	if err != nil {
		return nil, err
	}
	result := map[string]any{}
	if err = json.Unmarshal([]byte(invocation), &result); err != nil {
		return nil, err
	}
	nullableInt := func(value sql.NullInt64) any {
		if value.Valid {
			return value.Int64
		}
		return nil
	}
	nullableString := func(value sql.NullString) any {
		if value.Valid {
			return value.String
		}
		return nil
	}
	for name, value := range map[string]any{"id": id, "status": status, "createdAt": created, "startedAt": nullableInt(started), "completedAt": nullableInt(completed), "completionWeek": nullableString(week), "deadline": nullableInt(deadline), "idempotencyKey": nullableString(key), "ok": nil, "exitCode": nullableInt(exit), "error": nullableString(errorText), "retryOf": nullableInt(retry), "outputBytes": bytes, "outputChunks": chunks, "outputTruncated": truncated != 0, "stdout": "", "stderr": "", "result": nil} {
		result[name] = value
	}
	if ok.Valid {
		result["ok"] = ok.Int64 != 0
		terminal := map[string]any{"ok": ok.Int64 != 0, "exitCode": nullableInt(exit)}
		if errorText.Valid && errorText.String != "" {
			terminal["error"] = errorText.String
		}
		if pr.Valid && pr.String != "" {
			terminal["pullRequestUrl"] = pr.String
		}
		result["result"] = terminal
	}
	if status == "queued" && q.reason != "" {
		result["reason"] = q.reason
	}
	rows, err := q.db.QueryContext(ctx, "SELECT stream,data FROM output WHERE job_id=? ORDER BY seq", id)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	remaining := 64 << 10
	for rows.Next() {
		var stream, data string
		if err = rows.Scan(&stream, &data); err != nil {
			return nil, err
		}
		if len(data) > remaining {
			break
		}
		result[stream] = text(result[stream]) + data
		remaining -= len(data)
	}
	return result, rows.Err()
}
func (q *queue) enqueue(ctx context.Context, invocation Invocation, key any, retry any) (map[string]any, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return nil, failure(503, "CLI queue is closed.")
	}
	raw, err := json.Marshal(invocation)
	if err != nil {
		return nil, err
	}
	if len(raw) > 1<<20 {
		return nil, failure(400, "Queue input limit exceeded.")
	}
	if invocation.Input != nil && utf8.RuneCountInString(*invocation.Input) > 100000 {
		return nil, failure(400, "Queue input limit exceeded.")
	}
	if _, err = ParseCommand(invocation.Command); err != nil {
		return nil, err
	}
	if secretValue.Match(raw) {
		return nil, failure(400, "Secret-bearing CLI input cannot be persisted.")
	}
	for field, value := range invocation.Values {
		if secretKey.MatchString(field) && value != "" {
			return nil, failure(400, "Secret-bearing CLI input cannot be persisted.")
		}
	}
	for _, secret := range q.secrets {
		if strings.Contains(string(raw), secret) {
			return nil, failure(400, "Secret-bearing CLI input cannot be persisted.")
		}
	}
	for secret := range q.credentials {
		if strings.Contains(string(raw), secret) {
			return nil, failure(400, "Secret-bearing CLI input cannot be persisted.")
		}
	}
	sum := sha256.Sum256(raw)
	fingerprint := hex.EncodeToString(sum[:])
	if key != nil {
		token, ok := key.(string)
		if !ok || !idempotencyPattern.MatchString(token) || secretValue.MatchString(token) {
			return nil, failure(400, "Invalid queue idempotency key.")
		}
		var id int64
		var existing, persisted string
		err = q.db.QueryRowContext(ctx, "SELECT id,fingerprint,invocation FROM jobs WHERE idempotency_key=?", token).Scan(&id, &existing, &persisted)
		if err == nil {
			if existing != fingerprint {
				var original Invocation
				if json.Unmarshal([]byte(persisted), &original) != nil || !reflect.DeepEqual(original, invocation) {
					return nil, failure(409, "Queue idempotency key conflicts with another invocation.")
				}
			}
			return q.detailLocked(ctx, id)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	if err = q.retainLocked(ctx); err != nil {
		return nil, err
	}
	var count int
	if err = q.db.QueryRowContext(ctx, "SELECT count(*) FROM jobs").Scan(&count); err != nil {
		return nil, err
	}
	if count >= 10000 {
		return nil, failure(409, "CLI queue capacity exceeded.")
	}
	inserted, err := q.db.ExecContext(ctx, "INSERT INTO jobs(invocation,idempotency_key,fingerprint,status,created_at,retry_of) VALUES(?,?,?,'queued',?,?)", string(raw), key, fingerprint, time.Now().UnixMilli(), retry)
	if err != nil {
		return nil, err
	}
	id, err := inserted.LastInsertId()
	if err != nil {
		return nil, err
	}
	q.revision++
	q.signal()
	return q.detailLocked(ctx, id)
}
func (q *queue) list(ctx context.Context, payload map[string]any) (any, error) {
	limit, err := number(payload["limit"], 50, 1, 500)
	if err != nil {
		return nil, err
	}
	offset, err := number(payload["offset"], 0, 0, 1<<53-1)
	if err != nil {
		return nil, err
	}
	where := ""
	args := []any{}
	if status := text(payload["status"]); status != "" {
		parts := strings.Split(status, ",")
		marks := make([]string, len(parts))
		for i, value := range parts {
			if !validStatus(value) {
				return nil, failure(400, "Invalid queue status.")
			}
			marks[i] = "?"
			args = append(args, value)
		}
		where = " WHERE status IN (" + strings.Join(marks, ",") + ")"
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	var total int
	if err = q.db.QueryRowContext(ctx, "SELECT count(*) FROM jobs"+where, args...).Scan(&total); err != nil {
		return nil, err
	}
	ids, err := q.listIDs(ctx, "SELECT id FROM jobs"+where+" ORDER BY id DESC LIMIT ? OFFSET ?", append(args, limit, offset)...)
	if err != nil {
		return nil, err
	}
	commands := []any{}
	for _, id := range ids {
		value, e := q.detailLocked(ctx, id)
		if e != nil {
			return nil, e
		}
		values := mapping(value["values"])
		delete(value, "values")
		for _, key := range []string{"input", "stdout", "stderr", "arguments"} {
			delete(value, key)
		}
		for _, key := range []string{"repository", "campaign", "package-source"} {
			if v, present := values[key]; present {
				value[key] = v
			}
		}
		commands = append(commands, value)
	}
	var reason any
	if q.reason != "" {
		reason = q.reason
	}
	return map[string]any{"commands": commands, "total": total, "running": len(q.active), "pausedReason": reason, "revision": q.revision}, nil
}
func validStatus(value string) bool {
	switch value {
	case "queued", "running", "completed", "failed", "canceled", "timed-out":
		return true
	}
	return false
}
func (q *queue) listIDs(ctx context.Context, query string, args ...any) ([]int64, error) {
	rows, err := q.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
func (q *queue) output(ctx context.Context, rawID, afterRaw, limitRaw any) (any, error) {
	id, err := number(rawID, 0, 1, 1<<53-1)
	if err != nil {
		return nil, err
	}
	after, err := number(afterRaw, 0, 0, 1<<53-1)
	if err != nil {
		return nil, err
	}
	limit, err := number(limitRaw, 100, 1, 500)
	if err != nil {
		return nil, err
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	rows, err := q.db.QueryContext(ctx, "SELECT seq,stream,data FROM output WHERE job_id=? AND seq>? ORDER BY seq LIMIT ?", id, after, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := []any{}
	for rows.Next() {
		var sequence int64
		var stream, data string
		if err = rows.Scan(&sequence, &stream, &data); err != nil {
			return nil, err
		}
		result = append(result, map[string]any{"sequence": sequence, "stream": stream, "data": data})
	}
	return result, rows.Err()
}
func (q *queue) finishLocked(ctx context.Context, id int64, status string, exit any, message string) error {
	ok := status == "completed"
	var errorText any
	if message != "" {
		errorText = message
	}
	_, err := q.db.ExecContext(ctx, "UPDATE jobs SET status=?,ok=?,exit_code=?,error=?,completed_at=?,completion_week=? WHERE id=? AND status IN ('queued','running')", status, ok, exit, errorText, time.Now().UnixMilli(), monday(time.Now()), id)
	q.revision++
	return err
}
func (q *queue) cancel(ctx context.Context, rawID any) (any, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	value, err := q.detailLocked(ctx, rawID)
	if err != nil {
		return nil, err
	}
	id := value["id"].(int64)
	if cancel := q.active[id]; cancel != nil {
		cancel()
	}
	if err = q.finishLocked(ctx, id, "canceled", nil, "The CLI action was canceled."); err != nil {
		return nil, err
	}
	q.signal()
	return q.detailLocked(ctx, id)
}
func (q *queue) append(ctx context.Context, id int64, stream, data string) error {
	if data == "" {
		return nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return nil
	}
	for _, secret := range q.secrets {
		data = strings.ReplaceAll(data, secret, "[REDACTED]")
	}
	for secret := range q.credentials {
		data = strings.ReplaceAll(data, secret, "[REDACTED]")
	}
	data = tokenValue.ReplaceAllString(data, "[REDACTED]")
	data = bearerValue.ReplaceAllString(data, "******")
	data = assignmentValue.ReplaceAllString(data, "${1}[REDACTED]")
	data = strings.ToValidUTF8(data, "�")
	var status string
	var size, chunks, total int64
	err := q.db.QueryRowContext(ctx, "SELECT status,output_bytes,output_chunks,(SELECT coalesce(sum(output_bytes),0) FROM jobs) FROM jobs WHERE id=?", id).Scan(&status, &size, &chunks, &total)
	if err != nil {
		return err
	}
	if status != "running" {
		return nil
	}
	if !utf8.ValidString(data) || len(data) > 16<<10 || size+int64(len(data)) > 1<<20 || chunks >= 4096 || total+int64(len(data)) > 64<<20 {
		return q.truncateLocked(ctx, id)
	}
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, "INSERT INTO output(job_id,seq,stream,data) VALUES(?,?,?,?)", id, chunks+1, stream, data); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE jobs SET output_bytes=output_bytes+?,output_chunks=? WHERE id=?", len(data), chunks+1, id); err != nil {
		return err
	}
	if address := lastPullRequestURL(data); address != "" {
		if _, err = tx.ExecContext(ctx, "UPDATE jobs SET pull_request_url=? WHERE id=?", address, id); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil {
		q.revision++
		q.signal()
	}
	return err
}
func (q *queue) markTruncated(ctx context.Context, id int64) {
	q.mu.Lock()
	defer q.mu.Unlock()
	_ = q.truncateLocked(ctx, id)
}
func (q *queue) truncateLocked(ctx context.Context, id int64) error {
	result, err := q.db.ExecContext(ctx, "UPDATE jobs SET output_truncated=1 WHERE id=? AND output_truncated=0", id)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err == nil && changed > 0 {
		q.revision++
		q.signal()
	}
	return err
}
func (q *queue) pump() {
	defer q.wg.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	retention := time.NewTicker(time.Minute)
	defer retention.Stop()
	for {
		select {
		case <-q.ctx.Done():
			return
		case <-q.wake:
		case <-ticker.C:
		case <-retention.C:
			q.mu.Lock()
			if err := q.retainLocked(q.ctx); err != nil {
				q.reason = "CLI queue retention is unavailable."
			}
			q.mu.Unlock()
		}
		for {
			q.mu.Lock()
			if q.closed || len(q.active) >= q.options.MaxConcurrency {
				q.mu.Unlock()
				break
			}
			var blocked string
			e := q.db.QueryRowContext(q.ctx, "SELECT value FROM queue_state WHERE key='recovery_blocked'").Scan(&blocked)
			if e == nil {
				q.reason = blocked
				q.mu.Unlock()
				break
			}
			if !errors.Is(e, sql.ErrNoRows) {
				q.reason = "CLI queue storage is unavailable."
				q.mu.Unlock()
				break
			}
			var id int64
			var raw string
			e = q.db.QueryRowContext(q.ctx, "SELECT id,invocation FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").Scan(&id, &raw)
			running := len(q.active)
			q.mu.Unlock()
			if errors.Is(e, sql.ErrNoRows) {
				break
			}
			if e != nil {
				break
			}
			var invocation Invocation
			if json.Unmarshal([]byte(raw), &invocation) != nil {
				break
			}
			capacity, reason := q.admission.admit(q.ctx, id, invocation, running)
			q.mu.Lock()
			if q.reason != reason {
				q.reason = reason
				q.revision++
				select {
				case q.changed <- struct{}{}:
				default:
				}
			}
			if q.closed || running >= capacity {
				_ = q.admission.release(context.WithoutCancel(q.ctx), id)
				q.mu.Unlock()
				break
			}
			ctx, cancel := context.WithTimeout(q.ctx, q.options.Timeout)
			now := time.Now()
			tx, e := q.db.BeginTx(ctx, nil)
			if e == nil {
				var changed sql.Result
				changed, e = tx.ExecContext(ctx, "UPDATE jobs SET status='running',started_at=?,deadline=? WHERE id=? AND status='queued'", now.UnixMilli(), now.Add(q.options.Timeout).UnixMilli(), id)
				if e == nil {
					count, _ := changed.RowsAffected()
					if count != 1 {
						e = errors.New("command no longer queued")
					}
				}
				if e == nil {
					_, e = tx.ExecContext(ctx, "INSERT INTO execution_claims VALUES(?)", id)
				}
				if e == nil {
					e = tx.Commit()
				} else {
					_ = tx.Rollback()
				}
			}
			if e != nil {
				_ = q.admission.release(context.WithoutCancel(q.ctx), id)
				cancel()
				q.mu.Unlock()
				break
			}
			q.active[id] = cancel
			q.revision++
			select {
			case q.changed <- struct{}{}:
			default:
			}
			q.wg.Add(1)
			q.mu.Unlock()
			go q.execute(ctx, id, invocation)
		}
	}
}
func (q *queue) execute(ctx context.Context, id int64, invocation Invocation) {
	defer q.wg.Done()
	persistCtx := context.WithoutCancel(ctx)
	frames := newOutputFrames(func(stream, data string) error { return q.append(persistCtx, id, stream, data) }, func() { q.markTruncated(persistCtx, id) })
	observer := &rateLimitObserver{}
	options := q.options
	credential := ""
	options.onCredential = func(value string) {
		q.mu.Lock()
		defer q.mu.Unlock()
		if q.credentials == nil {
			q.credentials = map[string]int{}
		}
		q.credentials[value]++
		credential = value
	}
	defer func() {
		q.mu.Lock()
		defer q.mu.Unlock()
		if credential != "" {
			q.credentials[credential]--
			if q.credentials[credential] == 0 {
				delete(q.credentials, credential)
			}
		}
	}()
	result, err := executeCommand(ctx, options, invocation, func(stream, data string) error {
		observer.write(stream, data)
		if observer.limited {
			q.admission.park(context.WithoutCancel(ctx), observer.retryAfter)
		}
		return frames.write(stream, data)
	})
	executionContextErr := ctx.Err()
	frames.flush()
	reconcileCtx, reconcileCancel := context.WithCancel(persistCtx)
	stopReconcile := context.AfterFunc(q.ctx, reconcileCancel) //nolint:contextcheck // Reconciliation survives job cancellation but stops with queue shutdown.
	var quotaErr error
	if result == nil {
		quotaErr = q.admission.release(persistCtx, id)
	} else {
		quotaErr = q.admission.complete(reconcileCtx, id)
	}
	stopReconcile()
	reconcileCancel()
	q.mu.Lock()
	defer q.mu.Unlock()
	if quotaErr != nil && !q.closed {
		q.reason = "CLI action admission reconciliation is unavailable."
	}
	if cancel := q.active[id]; cancel != nil {
		cancel()
	}
	status, message := "completed", ""
	var exit any
	if result != nil {
		exit = result["exitCode"]
	}
	if err != nil || result == nil || result["ok"] != true {
		status, message = "failed", "The CLI action did not complete successfully."
	}
	if errors.Is(executionContextErr, context.DeadlineExceeded) {
		status, message = "timed-out", "The CLI action exceeded its time limit."
	}
	if q.closed {
		status, message = "failed", "CLI action interrupted by server shutdown."
	}
	if err = q.finishLocked(persistCtx, id, status, exit, message); err != nil {
		q.reason = "CLI queue completion persistence is unavailable."
		_, _ = q.db.ExecContext(context.WithoutCancel(ctx), "INSERT OR REPLACE INTO queue_state VALUES('recovery_blocked',?)", recoveryMessage)
	} else {
		_, _ = q.db.ExecContext(context.WithoutCancel(ctx), "UPDATE jobs SET exit_code=? WHERE id=? AND status IN ('canceled','timed-out')", exit, id)
		if _, claimErr := q.db.ExecContext(context.WithoutCancel(ctx), "DELETE FROM execution_claims WHERE job_id=?", id); claimErr != nil {
			q.reason = "CLI queue claim reconciliation is unavailable."
			_, _ = q.db.ExecContext(context.WithoutCancel(ctx), "INSERT OR REPLACE INTO queue_state VALUES('recovery_blocked',?)", recoveryMessage)
		}
	}
	delete(q.active, id)
	q.signal()
}
func (q *queue) close() error {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return nil
	}
	q.closed = true
	q.cancelContext()
	for _, cancel := range q.active {
		cancel()
	}
	q.mu.Unlock()
	q.wg.Wait()
	_, checkpoint := q.db.ExecContext(context.Background(), "PRAGMA wal_checkpoint(TRUNCATE)")
	dbErr := q.db.Close()
	_, ownerErr := q.ownerConn.ExecContext(context.Background(), "ROLLBACK")
	return errors.Join(checkpoint, dbErr, ownerErr, q.ownerConn.Close(), q.owner.Close(), q.admission.store.Close())
}
