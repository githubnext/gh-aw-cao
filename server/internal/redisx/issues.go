package redisx

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// IssueUpdate is an explicitly scoped status observation from a verified issues
// delivery. It is never used to create an issue or to change its identity.
type IssueUpdate struct {
	Repository, ID, Delivery string
	InstallationID           int64
	State, StateReason       string
	ClosedAt, ObservedAt     string
}

// ApplyIssueUpdate atomically checks current enrollment, delivery identity and
// active generation before recording a small generation-scoped status overlay.
// Webhook payloads are not general projection authority: this is limited to
// GitHub's signed issue status observation for a retained issue. It never
// changes a canonical row; a newer projected snapshot wins over the overlay.
func (s *Store) ApplyIssueUpdate(ctx context.Context, issue IssueUpdate, ttl time.Duration) (updated, duplicate bool, revision int64, err error) {
	hash := sha256.Sum256([]byte(issue.ID))
	row := hex.EncodeToString(hash[:16])
	// The active generation is resolved inside the script, never in Go: an
	// activation between lookup and write must not update a retired generation.
	script := `
if redis.call("EXISTS", KEYS[3]) == 1 then return {0, 1, 0} end
if redis.call("SISMEMBER", KEYS[6], ARGV[1]) == 0 or
   redis.call("HGET", KEYS[4], ARGV[1]) ~= ARGV[2] then return {0, 0, 0} end
local generation = redis.call("GET", KEYS[2])
if not generation or generation == "" then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[9])
  return {0, 0, 0}
end
local rowkey = ARGV[3] .. generation .. ARGV[4] .. ARGV[5]
local setkey = ARGV[3] .. generation .. ARGV[6]
if redis.call("SISMEMBER", setkey, rowkey) == 0 then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[9])
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
  redis.call("SET", KEYS[3], "1", "PX", ARGV[9])
  return {0, 0, 0}
end
local overlaykey = ARGV[3] .. generation .. ARGV[8]
local old = redis.call("HGET", overlaykey, ARGV[7])
local observed = type(issue.statusObservedAt) == "string" and issue.statusObservedAt or ""
if old then
  local previous = cjson.decode(old)
  observed = type(previous.statusObservedAt) == "string" and previous.statusObservedAt or observed
end
local function timestamp(value)
  local base, fraction = string.match(value, "^(%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d)%.?(%d*)Z$")
  if not base then return nil end
  return base .. string.sub(fraction .. "000000000", 1, 9)
end
local previousTime = observed == "" and nil or timestamp(observed)
if observed ~= "" and not previousTime then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[9])
  return {0, 0, 0}
end
local snapshot = type(issue.statusObservedAt) == "string" and
  timestamp(issue.statusObservedAt) or nil
if type(issue.statusObservedAt) == "string" and
   issue.statusObservedAt ~= "" and not snapshot then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[9])
  return {0, 0, 0}
end
if snapshot and (not previousTime or snapshot > previousTime) then previousTime = snapshot end
if previousTime and previousTime >= timestamp(ARGV[10]) then
  redis.call("SET", KEYS[3], "1", "PX", ARGV[9])
  return {0, 0, 0}
end
redis.call("HSET", overlaykey, ARGV[7], cjson.encode({
  state=ARGV[11], closed=ARGV[11]=="CLOSED",
  stateReason=ARGV[12] ~= "" and ARGV[12] or cjson.null,
  closedAt=ARGV[13] ~= "" and ARGV[13] or cjson.null,
  statusObservedAt=ARGV[10], rowHash=ARGV[5]
}))
redis.call("SET", KEYS[3], "1", "PX", ARGV[9])
local revision = redis.call("INCR", KEYS[5])
redis.call("HSET", KEYS[1], "revision", revision)
return {1, 0, revision}`
	value, err := s.Client.Do(ctx, "EVAL", script, "6",
		s.activeKey(), s.activeGenerationKey(), s.deliveryKey(issue.Delivery),
		s.Key("collect:repository-installation"), s.revisionSequenceKey(), s.Key("collect:repositories"),
		strings.ToLower(issue.Repository), strconv.FormatInt(issue.InstallationID, 10),
		s.namespace+":g:", ":source:"+safeName("issues")+":row:", row,
		":source:"+safeName("issues")+":rows", issue.ID,
		":issue-status", strconv.FormatInt(ttl.Milliseconds(), 10),
		issue.ObservedAt, issue.State, issue.StateReason, issue.ClosedAt,
	)
	if err != nil {
		return false, false, 0, fmt.Errorf("apply issue status: %w", err)
	}
	values, err := Strings(value)
	if err != nil || len(values) != 3 {
		return false, false, 0, fmt.Errorf("decode issue status result: %v", err)
	}
	revision, err = strconv.ParseInt(values[2], 10, 64)
	return values[0] == "1", values[1] == "1", revision, err
}
