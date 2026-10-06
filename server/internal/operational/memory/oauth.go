package memory

import (
	"context"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func (s *Store) SessionRecord(ctx context.Context, id string) (string, error) {
	if err := s.enter(ctx); err != nil {
		return "", err
	}
	defer s.mu.Unlock()
	if err := s.name(id); err != nil {
		return "", err
	}
	s.prune(s.config.Clock())
	return s.sessions[id].value, nil
}

func (s *Store) DeleteSession(ctx context.Context, id string) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(id); err != nil {
		return err
	}
	delete(s.sessions, id)
	s.drop(recordKey{"session", id, ""})
	return nil
}

func (s *Store) putSession(id, value string, ttl time.Duration, now time.Time) error {
	if _, ok := s.sessions[id]; !ok && len(s.sessions) >= s.config.MaxSessions {
		return capacity()
	}
	if err := s.reserve(map[recordKey]int64{{"session", id, ""}: charge(id, value)}); err != nil {
		return err
	}
	s.sessions[strings.Clone(id)] = expiringValue{strings.Clone(value), now.Add(ttl)}
	return nil
}

func (s *Store) sessionInput(id, value string, ttl time.Duration) error {
	if err := s.name(id); err != nil {
		return err
	}
	if value == "" {
		return invalid("session encrypted record must not be empty")
	}
	if err := s.value(value); err != nil {
		return err
	}
	return validTTL(ttl)
}

func (s *Store) PutSession(ctx context.Context, id, value string, ttl time.Duration) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.sessionInput(id, value, ttl); err != nil {
		return err
	}
	now := s.config.Clock()
	s.prune(now)
	return s.putSession(id, value, ttl, now)
}

func (s *Store) CompareSession(ctx context.Context, id, expected, value string, ttl time.Duration) (bool, error) {
	if err := s.enter(ctx); err != nil {
		return false, err
	}
	defer s.mu.Unlock()
	if err := s.sessionInput(id, value, ttl); err != nil {
		return false, err
	}
	if err := s.value(expected); err != nil {
		return false, err
	}
	now := s.config.Clock()
	s.prune(now)
	current, ok := s.sessions[id]
	if !ok || current.value != expected {
		return false, nil
	}
	if err := s.putSession(id, value, ttl, now); err != nil {
		return false, err
	}
	return true, nil
}

// InvalidateSession uses an empty expected value for unconditional logout.
// namespace is opaque and independent of session identity, including "".
func (s *Store) InvalidateSession(ctx context.Context, id, expected, namespace string) (string, error) {
	if err := s.enter(ctx); err != nil {
		return "", err
	}
	defer s.mu.Unlock()
	if err := s.name(id); err != nil {
		return "", err
	}
	if err := s.namespace(namespace); err != nil {
		return "", err
	}
	if err := s.value(expected); err != nil {
		return "", err
	}
	s.prune(s.config.Clock())
	current, ok := s.sessions[id]
	if !ok {
		return "", nil
	}
	if expected != "" && current.value != expected {
		return "", operational.ErrConflict
	}
	key := revocationKey{namespace, id}
	if _, ok := s.revocations[key]; !ok && len(s.revocations) >= s.config.MaxRevocations {
		return "", capacity()
	}
	changes := map[recordKey]int64{
		{"session", id, ""}: 0, {"revocation", namespace, id}: charge(namespace, id, current.value),
	}
	if err := s.reserve(changes); err != nil {
		return "", err
	}
	s.seq++
	s.revocations[revocationKey{strings.Clone(namespace), strings.Clone(id)}] = revocationValue{current.value, s.seq}
	delete(s.sessions, id)
	return current.value, nil
}

func (s *Store) QueueRevocation(ctx context.Context, id, value, namespace string) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.namespace(namespace); err != nil {
		return err
	}
	if err := s.name(id); err != nil {
		return err
	}
	if value == "" {
		return invalid("revocation encrypted record must not be empty")
	}
	if err := s.value(value); err != nil {
		return err
	}
	key := revocationKey{namespace, id}
	if _, ok := s.revocations[key]; !ok && len(s.revocations) >= s.config.MaxRevocations {
		return capacity()
	}
	if err := s.reserve(map[recordKey]int64{{"revocation", namespace, id}: charge(namespace, id, value)}); err != nil {
		return err
	}
	s.seq++
	s.revocations[revocationKey{strings.Clone(namespace), strings.Clone(id)}] = revocationValue{strings.Clone(value), s.seq}
	return nil
}

func (s *Store) PendingRevocation(ctx context.Context, namespace string) (operational.Revocation, error) {
	if err := s.enter(ctx); err != nil {
		return operational.Revocation{}, err
	}
	defer s.mu.Unlock()
	if err := s.namespace(namespace); err != nil {
		return operational.Revocation{}, err
	}
	cursor := s.revocationCursor[namespace]
	var first, next revocationKey
	var firstOrder, nextOrder uint64
	for k, v := range s.revocations {
		if k.namespace != namespace {
			continue
		}
		if firstOrder == 0 || v.order < firstOrder {
			first, firstOrder = k, v.order
		}
		if v.order > cursor && (nextOrder == 0 || v.order < nextOrder) {
			next, nextOrder = k, v.order
		}
	}
	if nextOrder == 0 {
		next, nextOrder = first, firstOrder
	}
	if nextOrder == 0 {
		return operational.Revocation{}, nil
	}
	s.revocationCursor[strings.Clone(namespace)] = nextOrder
	return operational.Revocation{ID: next.id, Value: s.revocations[next].value}, nil
}

func (s *Store) CompleteRevocation(ctx context.Context, id, expected, namespace string) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.namespace(namespace); err != nil {
		return err
	}
	if err := s.name(id); err != nil {
		return err
	}
	if err := s.value(expected); err != nil {
		return err
	}
	key := revocationKey{namespace, id}
	if value, ok := s.revocations[key]; ok && value.value == expected {
		delete(s.revocations, key)
		s.drop(recordKey{"revocation", namespace, id})
		for k := range s.revocations {
			if k.namespace == namespace {
				return nil
			}
		}
		delete(s.revocationCursor, namespace)
	}
	return nil
}
