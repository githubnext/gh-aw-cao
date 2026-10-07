package postgres

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func sessionInput(id, value string, ttl time.Duration) error {
	if err := names(id); err != nil {
		return err
	}
	if value == "" {
		return invalid("encrypted session record must not be empty")
	}
	return ttlValid(ttl)
}

func (s *Store) SessionRecord(ctx context.Context, id string) (string, error) {
	if err := names(id); err != nil {
		return "", err
	}
	var value []byte
	err := s.transact(ctx, func(t *transaction) error {
		var err error
		value, err = t.get(key{"session", id, ""})
		return err
	})
	return string(value), err
}

func (s *Store) PutSession(ctx context.Context, id, value string, ttl time.Duration) error {
	if err := sessionInput(id, value, ttl); err != nil {
		return err
	}
	return s.transact(ctx, func(t *transaction) error {
		// Reserve one extra record and its overhead for the logout transition.
		if err := t.put(key{"session-reserve", id, ""}, make([]byte, 2048), t.now.Add(ttl)); err != nil {
			return err
		}
		return t.put(key{"session", id, ""}, []byte(value), t.now.Add(ttl))
	})
}

func (s *Store) CompareSession(ctx context.Context, id, expected, value string, ttl time.Duration) (bool, error) {
	if err := sessionInput(id, value, ttl); err != nil {
		return false, err
	}
	saved := false
	err := s.transact(ctx, func(t *transaction) error {
		current, err := t.get(key{"session", id, ""})
		if err != nil || current == nil || string(current) != expected {
			return err
		}
		if err := t.put(key{"session-reserve", id, ""}, make([]byte, 2048), t.now.Add(ttl)); err != nil {
			return err
		}
		if err := t.put(key{"session", id, ""}, []byte(value), t.now.Add(ttl)); err != nil {
			return err
		}
		saved = true
		return nil
	})
	return saved && err == nil, err
}

func (s *Store) DeleteSession(ctx context.Context, id string) error {
	if err := names(id); err != nil {
		return err
	}
	return s.transact(ctx, func(t *transaction) error {
		if err := t.remove(key{"session-reserve", id, ""}); err != nil {
			return err
		}
		return t.remove(key{"session", id, ""})
	})
}

func (s *Store) InvalidateSession(ctx context.Context, id, expected, namespace string) (string, error) {
	if err := names(id); err != nil {
		return "", err
	}
	if err := opaque(namespace); err != nil {
		return "", err
	}
	var value []byte
	err := s.transact(ctx, func(t *transaction) error {
		var err error
		value, err = t.get(key{"session", id, ""})
		if err != nil || value == nil {
			return err
		}
		if expected != "" && string(value) != expected {
			return operational.ErrConflict
		}
		if err := t.remove(key{"session-reserve", id, ""}); err != nil {
			return err
		}
		if err := t.remove(key{"session", id, ""}); err != nil {
			return err
		}
		return t.put(key{"revocation", namespace, id}, value, time.Time{})
	})
	if err != nil {
		return "", err
	}
	return string(value), nil
}

func (s *Store) QueueRevocation(ctx context.Context, id, value, namespace string) error {
	if err := names(id); err != nil {
		return err
	}
	if err := opaque(namespace); err != nil {
		return err
	}
	if value == "" {
		return invalid("encrypted revocation record must not be empty")
	}
	return s.transact(ctx, func(t *transaction) error {
		return t.put(key{"revocation", namespace, id}, []byte(value), time.Time{})
	})
}

func (s *Store) PendingRevocation(ctx context.Context, namespace string) (operational.Revocation, error) {
	if err := opaque(namespace); err != nil {
		return operational.Revocation{}, err
	}
	var result operational.Revocation
	err := s.transact(ctx, func(t *transaction) error {
		err := t.tx.QueryRowContext(ctx, `SELECT field,value FROM cao_operational_records WHERE namespace=$1 AND kind='revocation' AND name=$2 ORDER BY position LIMIT 1`, s.namespace, namespace).Scan(&result.ID, &result.Value)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		// A cursor is disposable scheduling state and must not block revocation
		// when protected capacity is exhausted.
		_, err = t.tx.ExecContext(ctx, `UPDATE cao_operational_records SET position=DEFAULT WHERE namespace=$1 AND kind='revocation' AND name=$2 AND field=$3`, s.namespace, namespace, result.ID)
		return err
	})
	return result, err
}

func (s *Store) CompleteRevocation(ctx context.Context, id, expected, namespace string) error {
	if err := names(id); err != nil {
		return err
	}
	if err := opaque(namespace); err != nil {
		return err
	}
	return s.transact(ctx, func(t *transaction) error {
		k := key{"revocation", namespace, id}
		value, err := t.get(k)
		if err != nil || value == nil || string(value) != expected {
			return err
		}
		return t.remove(k)
	})
}
