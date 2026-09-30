package redisx

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Reconsider old observations incrementally; age alone cannot invalidate an
// observation still newer than the active projected issue row.
const issueStatusRetention = 30 * 24 * time.Hour

// ErrIssueStatusAmbiguous means two different status observations have the
// same GitHub updated_at. A fresh projection must resolve their ordering.
var ErrIssueStatusAmbiguous = errors.New("issue status observations conflict at the same timestamp")

const issueStatusPruneScript = `
local function prune(overlay, ages, now, generation, prefix, rowSuffix, setSuffix)
if not generation or generation == "" or
   redis.call("HEXISTS", prefix .. generation, "source:issues:metadata") == 0 then
  return
end
local function timestamp(value)
  if type(value) ~= "string" then return nil end
  local base, fraction = string.match(value, "^(%%d%%d%%d%%d%%-%%d%%d%%-%%d%%dT%%d%%d:%%d%%d:%%d%%d)%%.?(%%d*)Z$")
  if not base then return nil end
  return base .. string.sub(fraction .. "000000000", 1, 9)
end
local expired = redis.call("ZRANGEBYSCORE", ages, "-inf", now - %d, "LIMIT", 0, 100)
for _, id in ipairs(expired) do
  local raw = redis.call("HGET", overlay, id)
  if not raw then
    redis.call("ZREM", ages, id)
  else
    local ok, update = pcall(cjson.decode, raw)
    local row = ok and type(update) == "table" and type(update.rowHash) == "string" and
      prefix .. generation .. rowSuffix .. update.rowHash or nil
    local retained = row and redis.call("SISMEMBER",
      prefix .. generation .. setSuffix, row) == 1
    local discard = row and not retained
    if retained then
      local snapshotRaw = redis.call("HGET", row, "raw")
      local valid, issue = pcall(cjson.decode, snapshotRaw or "")
      if valid and type(issue) == "table" and issue.id == id then
        local snapshot = timestamp(issue.statusObservedAt)
        local observed = timestamp(update.statusObservedAt)
        discard = snapshot and observed and snapshot >= observed
      else
        discard = false
      end
    end
    if discard then
      redis.call("HDEL", overlay, id)
      redis.call("ZREM", ages, id)
    else
      redis.call("ZADD", ages, now, id)
    end
  end
end
end
`

// IssueUpdate is an explicitly scoped status observation from a verified issues
// delivery. It is never used to create an issue or to change its identity.
type IssueUpdate struct {
	Repository, ID, Delivery string
	InstallationID           int64
	State, StateReason       string
	ClosedAt, ObservedAt     string
}

// ApplyIssueUpdate atomically checks current enrollment, delivery identity and
// active generation before recording a small identity-keyed status overlay.
// Webhook payloads are not general projection authority: this is limited to
// GitHub's signed issue status observation for a retained issue. It never
// changes a canonical row; a newer projected snapshot wins over the overlay.
func (s *Store) ApplyIssueUpdate(ctx context.Context, issue IssueUpdate, ttl time.Duration) (updated, duplicate bool, revision int64, err error) {
	hash := sha256.Sum256([]byte(issue.ID))
	row := hex.EncodeToString(hash[:16])
	// The active generation is resolved inside the script, never in Go: an
	// activation between lookup and write must not update a retired generation.
	script := fmt.Sprintf(issueStatusPruneScript, int64(issueStatusRetention.Seconds())) + `
local now = tonumber(ARGV[13])
prune(KEYS[7], KEYS[8], now, redis.call("GET", KEYS[2]), ARGV[3], ARGV[4], ARGV[6])
if redis.call("EXISTS", KEYS[3]) == 1 then return {0, 1, 0} end
if redis.call("SISMEMBER", KEYS[6], ARGV[1]) == 0 or
   redis.call("HGET", KEYS[4], ARGV[1]) ~= ARGV[2] then return {0, 0, 0} end
local generation = redis.call("GET", KEYS[2])
if not generation or generation == "" then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
  return {0, 0, 0}
end
local rowkey = ARGV[3] .. generation .. ARGV[4] .. ARGV[5]
local setkey = ARGV[3] .. generation .. ARGV[6]
if redis.call("SISMEMBER", setkey, rowkey) == 0 then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
  return {0, 0, 0}
end
local raw = redis.call("HGET", rowkey, "raw")
if not raw then return {0, 0, 0} end
local issue = cjson.decode(raw)
local url = type(issue.url) == "string" and issue.url or ""
local repository = type(issue.repositoryFullName) == "string" and issue.repositoryFullName or ""
if issue.id ~= ARGV[7] or issue.isPullRequest ~= false or
   string.find(url, "/pull/", 1, true) or
   string.lower(repository) ~= ARGV[1] then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
  return {0, 0, 0}
end
local old = redis.call("HGET", KEYS[7], ARGV[7])
local previous
local observed = type(issue.statusObservedAt) == "string" and issue.statusObservedAt or ""
if old then
  previous = cjson.decode(old)
  observed = type(previous.statusObservedAt) == "string" and previous.statusObservedAt or observed
end
local function timestamp(value)
  local base, fraction = string.match(value, "^(%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d)%.?(%d*)Z$")
  if not base then return nil end
  return base .. string.sub(fraction .. "000000000", 1, 9)
end
local previousTime = observed == "" and nil or timestamp(observed)
if observed ~= "" and not previousTime then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
  return {0, 0, 0}
end
local snapshot = type(issue.statusObservedAt) == "string" and
  timestamp(issue.statusObservedAt) or nil
if type(issue.statusObservedAt) == "string" and
   issue.statusObservedAt ~= "" and not snapshot then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
  return {0, 0, 0}
end
if snapshot and (not previousTime or snapshot > previousTime) then previousTime = snapshot end
local incoming = timestamp(ARGV[9])
if not incoming or (previousTime and previousTime > incoming) then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
  return {0, 0, 0}
end
if previousTime == incoming then
  local function text(value)
    return type(value) == "string" and value or ""
  end
  local function closed(value)
    local raw = text(value)
    return timestamp(raw) or raw
  end
  local function differs(value)
    return text(value.state) ~= ARGV[10] or
      text(value.stateReason) ~= ARGV[11] or
      closed(value.closedAt) ~= closed(ARGV[12])
  end
  local conflict = (previous and timestamp(text(previous.statusObservedAt)) == incoming and
    (previous.ambiguous == true or differs(previous))) or
    (snapshot == incoming and differs(issue))
  if conflict then
    if not previous or previous.ambiguous ~= true or
       timestamp(text(previous.statusObservedAt)) ~= incoming then
      redis.call("HSET", KEYS[7], ARGV[7], cjson.encode({
        ambiguous=true, statusObservedAt=ARGV[9], rowHash=ARGV[5], repository=ARGV[1]
      }))
      redis.call("ZADD", KEYS[8], now, ARGV[7])
      local revision = redis.call("INCR", KEYS[5])
      redis.call("HSET", KEYS[1], "revision", revision)
      redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
      return {0, 2, revision}
    end
    redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
    return {0, 2, 0}
  end
  redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
  return {0, 0, 0}
end
redis.call("HSET", KEYS[7], ARGV[7], cjson.encode({
  state=ARGV[10], closed=ARGV[10]=="CLOSED",
  stateReason=ARGV[11] ~= "" and ARGV[11] or cjson.null,
  closedAt=ARGV[12] ~= "" and ARGV[12] or cjson.null,
  statusObservedAt=ARGV[9], rowHash=ARGV[5], repository=ARGV[1]
}))
redis.call("ZADD", KEYS[8], now, ARGV[7])
redis.call("SET", KEYS[3], "1", "PX", ARGV[8])
local revision = redis.call("INCR", KEYS[5])
redis.call("HSET", KEYS[1], "revision", revision)
return {1, 0, revision}`
	value, err := s.Client.Do(ctx, "EVAL", script, "8",
		s.activeKey(), s.activeGenerationKey(), s.deliveryKey(issue.Delivery),
		s.Key("collect:repository-installation"), s.revisionSequenceKey(), s.Key("collect:repositories"),
		s.issueStatusKey(), s.issueStatusAgeKey(),
		strings.ToLower(issue.Repository), strconv.FormatInt(issue.InstallationID, 10),
		s.namespace+":g:", ":source:"+safeName("issues")+":row:", row,
		":source:"+safeName("issues")+":rows", issue.ID,
		strconv.FormatInt(ttl.Milliseconds(), 10),
		issue.ObservedAt, issue.State, issue.StateReason, issue.ClosedAt,
		strconv.FormatInt(time.Now().UTC().Unix(), 10),
	)
	if err != nil {
		return false, false, 0, fmt.Errorf("apply issue status: %w", err)
	}
	values, err := Strings(value)
	if err != nil || len(values) != 3 {
		return false, false, 0, fmt.Errorf("decode issue status result: %v", err)
	}
	revision, err = strconv.ParseInt(values[2], 10, 64)
	if err == nil && values[1] == "2" {
		return false, false, revision, ErrIssueStatusAmbiguous
	}
	return values[0] == "1", values[1] == "1", revision, err
}
