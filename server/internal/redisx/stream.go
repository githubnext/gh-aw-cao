package redisx

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// StreamMessage is one entry read from a Redis stream consumer group.
type StreamMessage struct {
	ID     string
	Fields map[string]string
}

// StreamAdd appends an entry to a stream, trimming it to an approximate
// maximum length so an unattended queue cannot grow without bound.
func (s *Store) StreamAdd(ctx context.Context, stream string, maxLength int64, fields map[string]string) (string, error) {
	if len(fields) == 0 {
		return "", errors.New("stream entries require at least one field")
	}
	arguments := []string{"XADD", s.Key(stream)}
	if maxLength > 0 {
		arguments = append(arguments, "MAXLEN", "~", strconv.FormatInt(maxLength, 10))
	}
	arguments = append(arguments, "*")
	for name, value := range fields {
		arguments = append(arguments, name, value)
	}
	value, err := s.Client.Do(ctx, arguments...)
	if err != nil {
		return "", err
	}
	return fmt.Sprint(value), nil
}

// StreamEnsureGroup creates a consumer group, tolerating an existing one.
func (s *Store) StreamEnsureGroup(ctx context.Context, stream, group string) error {
	_, err := s.Client.Do(ctx, "XGROUP", "CREATE", s.Key(stream), group, "0", "MKSTREAM")
	if err != nil && isBusyGroup(err) {
		return nil
	}
	return err
}

// StreamRead reads undelivered entries for one consumer in a group.
func (s *Store) StreamRead(
	ctx context.Context,
	stream, group, consumer string,
	count int,
	block time.Duration,
) ([]StreamMessage, error) {
	arguments := []string{"XREADGROUP", "GROUP", group, consumer, "COUNT", strconv.Itoa(count)}
	if block > 0 {
		arguments = append(arguments, "BLOCK", strconv.FormatInt(block.Milliseconds(), 10))
	}
	arguments = append(arguments, "STREAMS", s.Key(stream), ">")
	value, err := s.Client.Do(ctx, arguments...)
	if err != nil || value == nil {
		return nil, err
	}
	streams, ok := value.([]any)
	if !ok {
		return nil, errors.New("unexpected XREADGROUP response")
	}
	var messages []StreamMessage
	for _, entry := range streams {
		pair, ok := entry.([]any)
		if !ok || len(pair) != 2 {
			continue
		}
		parsed, err := parseStreamEntries(pair[1])
		if err != nil {
			return nil, err
		}
		messages = append(messages, parsed...)
	}
	return messages, nil
}

// StreamAck acknowledges processed entries.
func (s *Store) StreamAck(ctx context.Context, stream, group string, ids ...string) error {
	if len(ids) == 0 {
		return nil
	}
	arguments := append([]string{"XACK", s.Key(stream), group}, ids...)
	_, err := s.Client.Do(ctx, arguments...)
	return err
}

// StreamClaim reclaims entries abandoned by a consumer that stopped, so a
// worker that dies mid-task does not strand its repository.
func (s *Store) StreamClaim(
	ctx context.Context,
	stream, group, consumer string,
	minIdle time.Duration,
	start string,
	count int,
) ([]StreamMessage, string, error) {
	if start == "" {
		start = "0-0"
	}
	value, err := s.Client.Do(ctx, "XAUTOCLAIM", s.Key(stream), group, consumer,
		strconv.FormatInt(minIdle.Milliseconds(), 10), start, "COUNT", strconv.Itoa(count))
	if err != nil || value == nil {
		return nil, "0-0", err
	}
	response, ok := value.([]any)
	if !ok || len(response) < 2 {
		return nil, "0-0", errors.New("unexpected XAUTOCLAIM response")
	}
	cursor := fmt.Sprint(response[0])
	messages, err := parseStreamEntries(response[1])
	if err != nil {
		return nil, "0-0", err
	}
	return messages, cursor, nil
}

// StreamLength reports the stream depth used as the worker scaling signal.
func (s *Store) StreamLength(ctx context.Context, stream string) (int64, error) {
	value, err := s.Client.Do(ctx, "XLEN", s.Key(stream))
	if err != nil {
		return 0, err
	}
	return toInt64(value), nil
}

// StreamPending reports how many entries a group has delivered but not
// acknowledged.
func (s *Store) StreamPending(ctx context.Context, stream, group string) (int64, error) {
	value, err := s.Client.Do(ctx, "XPENDING", s.Key(stream), group)
	if err != nil {
		if isNoGroup(err) {
			return 0, nil
		}
		return 0, err
	}
	summary, ok := value.([]any)
	if !ok || len(summary) == 0 {
		return 0, nil
	}
	return toInt64(summary[0]), nil
}

// SetAdd adds members to a set and reports how many were new.
func (s *Store) SetAdd(ctx context.Context, key string, members ...string) (int64, error) {
	if len(members) == 0 {
		return 0, nil
	}
	value, err := s.Client.Do(ctx, append([]string{"SADD", s.Key(key)}, members...)...)
	if err != nil {
		return 0, err
	}
	return toInt64(value), nil
}

// SetRemove removes members from a set.
func (s *Store) SetRemove(ctx context.Context, key string, members ...string) error {
	if len(members) == 0 {
		return nil
	}
	_, err := s.Client.Do(ctx, append([]string{"SREM", s.Key(key)}, members...)...)
	return err
}

// SetContains reports set membership.
func (s *Store) SetContains(ctx context.Context, key, member string) (bool, error) {
	value, err := s.Client.Do(ctx, "SISMEMBER", s.Key(key), member)
	if err != nil {
		return false, err
	}
	return toInt64(value) == 1, nil
}

// SetCount reports set cardinality.
func (s *Store) SetCount(ctx context.Context, key string) (int64, error) {
	value, err := s.Client.Do(ctx, "SCARD", s.Key(key))
	if err != nil {
		return 0, err
	}
	return toInt64(value), nil
}

// SetScan walks a set by cursor so enumeration of a very large enrollment set
// never blocks Redis on a single command.
func (s *Store) SetScan(ctx context.Context, key, cursor string, count int) ([]string, string, error) {
	if cursor == "" {
		cursor = "0"
	}
	value, err := s.Client.Do(ctx, "SSCAN", s.Key(key), cursor, "COUNT", strconv.Itoa(count))
	if err != nil {
		return nil, "0", err
	}
	response, ok := value.([]any)
	if !ok || len(response) != 2 {
		return nil, "0", errors.New("unexpected SSCAN response")
	}
	members, err := Strings(response[1])
	if err != nil {
		return nil, "0", err
	}
	return members, fmt.Sprint(response[0]), nil
}

// HashSet writes one hash field.
func (s *Store) HashSet(ctx context.Context, key, field, value string) error {
	_, err := s.Client.Do(ctx, "HSET", s.Key(key), field, value)
	return err
}

// HashGet reads one hash field, returning an empty string when absent.
func (s *Store) HashGet(ctx context.Context, key, field string) (string, error) {
	value, err := s.Client.Do(ctx, "HGET", s.Key(key), field)
	if err != nil || value == nil {
		return "", err
	}
	return fmt.Sprint(value), nil
}

// HashDelete removes one hash field.
func (s *Store) HashDelete(ctx context.Context, key, field string) error {
	_, err := s.Client.Do(ctx, "HDEL", s.Key(key), field)
	return err
}

// MarkOnce sets a key only when absent, reporting whether this caller won. It
// is the debounce and idempotence primitive for collection tasks.
func (s *Store) MarkOnce(ctx context.Context, key string, ttl time.Duration) (bool, error) {
	value, err := s.Client.Do(ctx, "SET", s.Key(key), "1", "NX", "PX",
		strconv.FormatInt(ttl.Milliseconds(), 10))
	if err != nil {
		return false, err
	}
	return value != nil && fmt.Sprint(value) == "OK", nil
}

// Clear removes a key.
func (s *Store) Clear(ctx context.Context, key string) error {
	_, err := s.Client.Do(ctx, "DEL", s.Key(key))
	return err
}

func parseStreamEntries(value any) ([]StreamMessage, error) {
	if value == nil {
		return nil, nil
	}
	entries, ok := value.([]any)
	if !ok {
		return nil, errors.New("unexpected stream entry list")
	}
	messages := make([]StreamMessage, 0, len(entries))
	for _, entry := range entries {
		parts, ok := entry.([]any)
		if !ok || len(parts) != 2 {
			continue
		}
		fields, err := Strings(parts[1])
		if err != nil {
			return nil, err
		}
		message := StreamMessage{ID: fmt.Sprint(parts[0]), Fields: map[string]string{}}
		for index := 0; index+1 < len(fields); index += 2 {
			message.Fields[fields[index]] = fields[index+1]
		}
		messages = append(messages, message)
	}
	return messages, nil
}

func toInt64(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case string:
		parsed, err := strconv.ParseInt(typed, 10, 64)
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

func isBusyGroup(err error) bool {
	var response redisResponseError
	return errors.As(err, &response) && len(response.message) >= 9 && response.message[:9] == "BUSYGROUP"
}

func isNoGroup(err error) bool {
	var response redisResponseError
	return errors.As(err, &response) && len(response.message) >= 7 && response.message[:7] == "NOGROUP"
}

// StreamBacklog reports how many entries a consumer group has never been
// delivered.
//
// Stream length is not backlog: acknowledged entries stay in the stream until
// it is trimmed. The group's lag is the number that reflects outstanding work,
// which is what status reporting and autoscaling need.
func (s *Store) StreamBacklog(ctx context.Context, stream, group string) (int64, error) {
	value, err := s.Client.Do(ctx, "XINFO", "GROUPS", s.Key(stream))
	if err != nil {
		if isNoGroup(err) {
			return 0, nil
		}
		return 0, err
	}
	groups, ok := value.([]any)
	if !ok {
		return 0, nil
	}
	for _, entry := range groups {
		fields, ok := entry.([]any)
		if !ok {
			continue
		}
		properties := map[string]any{}
		for index := 0; index+1 < len(fields); index += 2 {
			name, ok := fields[index].(string)
			if !ok {
				if raw, isBytes := fields[index].([]byte); isBytes {
					name = string(raw)
				} else {
					continue
				}
			}
			properties[name] = fields[index+1]
		}
		if groupName(properties["name"]) != group {
			continue
		}
		// Redis reports lag as nil when it cannot be determined exactly, for
		// example after entries were trimmed. Unacknowledged entries are the
		// fail-closed fallback: reporting zero would hide real work.
		if properties["lag"] == nil {
			return toInt64(properties["pending"]), nil
		}
		return toInt64(properties["lag"]), nil
	}
	return 0, nil
}

func groupName(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return ""
	}
}
