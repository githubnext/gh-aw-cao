package memory

import (
	"bytes"
	"context"
	"strings"
	"time"
)

func (s *Store) TryLock(ctx context.Context, name, owner string, ttl time.Duration) (bool, error) {
	if err := s.enter(ctx); err != nil {
		return false, err
	}
	defer s.mu.Unlock()
	if err := s.name(name, owner); err != nil {
		return false, err
	}
	if err := validTTL(ttl); err != nil {
		return false, err
	}
	now := s.config.Clock()
	s.prune(now)
	if _, ok := s.locks[name]; ok {
		return false, nil
	}
	if len(s.locks) >= s.config.MaxLocks {
		return false, capacity()
	}
	if err := s.reserve(map[recordKey]int64{{"lock", name, ""}: charge(name, owner)}); err != nil {
		return false, err
	}
	s.locks[strings.Clone(name)] = expiringValue{strings.Clone(owner), now.Add(ttl)}
	return true, nil
}

func (s *Store) RenewLock(ctx context.Context, name, owner string, ttl time.Duration) (bool, error) {
	if err := s.enter(ctx); err != nil {
		return false, err
	}
	defer s.mu.Unlock()
	if err := s.name(name, owner); err != nil {
		return false, err
	}
	if err := validTTL(ttl); err != nil {
		return false, err
	}
	now := s.config.Clock()
	s.prune(now)
	v, ok := s.locks[name]
	if !ok || v.value != owner {
		return false, nil
	}
	v.expires = now.Add(ttl)
	s.locks[name] = v
	return true, nil
}

func (s *Store) Unlock(ctx context.Context, name, owner string) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(name, owner); err != nil {
		return err
	}
	s.prune(s.config.Clock())
	if v, ok := s.locks[name]; ok && v.value == owner {
		delete(s.locks, name)
		s.drop(recordKey{"lock", name, ""})
	}
	return nil
}

func (s *Store) LockHeld(ctx context.Context, name string) (bool, error) {
	if err := s.enter(ctx); err != nil {
		return false, err
	}
	defer s.mu.Unlock()
	if err := s.name(name); err != nil {
		return false, err
	}
	s.prune(s.config.Clock())
	_, ok := s.locks[name]
	return ok, nil
}

func (s *Store) SetOperationalState(ctx context.Context, name string, data []byte) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(name); err != nil {
		return err
	}
	if len(data) > s.config.MaxRecordBytes {
		return invalid("operational state exceeds payload limit")
	}
	if _, ok := s.states[name]; !ok && len(s.states) >= s.config.MaxStateEntries {
		return capacity()
	}
	if err := s.reserve(map[recordKey]int64{{"state", name, ""}: charge(name) + int64(len(data))}); err != nil {
		return err
	}
	s.states[strings.Clone(name)] = bytes.Clone(data)
	return nil
}

func (s *Store) OperationalState(ctx context.Context, name string) ([]byte, error) {
	if err := s.enter(ctx); err != nil {
		return nil, err
	}
	defer s.mu.Unlock()
	if err := s.name(name); err != nil {
		return nil, err
	}
	data, exists := s.states[name]
	if !exists {
		return nil, nil
	}
	return clonePresent(data), nil
}
