package postgres

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/githubnext/gh-cao/server/internal/operational"
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

func (s *Store) PutSession(ctx context.Context, id, value string, ttl time.Duration, namespace string) error {
	if err := sessionInput(id, value, ttl); err != nil {
		return err
	}
	if err := opaque(namespace); err != nil {
		return err
	}
	return s.transact(ctx, func(t *transaction) error {
		// The destination reserves the bytes and entry needed to transfer
		// ownership at expiry, even when protected capacity is exhausted.
		if err := t.put(key{"session-reserve", id, ""}, []byte(namespace), time.Time{}); err != nil {
			return err
		}
		return t.put(key{"session", id, ""}, []byte(value), t.now.Add(ttl))
	})
}

func (s *Store) CompareSession(ctx context.Context, id, expected, value string, ttl time.Duration, namespace string) (bool, error) {
	if err := sessionInput(id, value, ttl); err != nil {
		return false, err
	}
	if err := opaque(namespace); err != nil {
		return false, err
	}
	saved := false
	err := s.transact(ctx, func(t *transaction) error {
		current, err := t.get(key{"session", id, ""})
		if err != nil || current == nil || string(current) != expected {
			return err
		}
		destination, err := t.get(key{"session-reserve", id, ""})
		if err != nil || string(destination) != namespace {
			return err
		}
		if err := t.put(key{"session-reserve", id, ""}, []byte(namespace), time.Time{}); err != nil {
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
		destination, err := t.get(key{"session-reserve", id, ""})
		if err != nil {
			return err
		}
		_, err = t.invalidateSession(id, "", string(destination))
		return err
	})
}

func (s *Store) InvalidateSession(ctx context.Context, id, expected, namespace string) (string, error) {
	if err := names(id); err != nil {
		return "", err
	}
	if err := opaque(namespace); err != nil {
		return "", err
	}
	var value string
	err := s.transact(ctx, func(t *transaction) error {
		var err error
		value, err = t.invalidateSession(id, expected, namespace)
		return err
	})
	if err != nil {
		return "", err
	}
	return value, nil
}

func (t *transaction) invalidateSession(id, expected, namespace string) (string, error) {
	var value []byte
	err := t.tx.QueryRowContext(t.ctx, `SELECT value FROM cao_operational_records WHERE namespace=$1 AND kind='session' AND name=$2 AND field=''`, t.namespace, id).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if expected != "" && string(value) != expected {
		return "", operational.ErrConflict
	}
	if err := t.remove(key{"session-reserve", id, ""}); err != nil {
		return "", err
	}
	if err := t.remove(key{"session", id, ""}); err != nil {
		return "", err
	}
	if err := t.put(key{"revocation", namespace, id}, value, time.Time{}); err != nil {
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
		var expiredID string
		err := t.tx.QueryRowContext(ctx, `SELECT s.name FROM cao_operational_records s
			JOIN cao_operational_records r ON r.namespace=s.namespace AND r.kind='session-reserve' AND r.name=s.name AND r.field=''
			WHERE s.namespace=$1 AND s.kind='session' AND s.expires_at<=$2 AND r.value=$3
			ORDER BY s.expires_at LIMIT 1`, s.namespace, t.now, []byte(namespace)).Scan(&expiredID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil {
			if _, err := t.invalidateSession(expiredID, "", namespace); err != nil {
				return err
			}
		}
		err = t.tx.QueryRowContext(ctx, `SELECT field,value FROM cao_operational_records WHERE namespace=$1 AND kind='revocation' AND name=$2 ORDER BY position LIMIT 1`, s.namespace, namespace).Scan(&result.ID, &result.Value)
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
