package postgres

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"
)

func (s *Store) AddMembers(ctx context.Context, name string, members ...string) (int64, error) {
	if err := names(append([]string{name}, members...)...); err != nil {
		return 0, err
	}
	var added int64
	err := s.transact(ctx, func(t *transaction) error {
		for _, member := range members {
			k := key{"member", name, member}
			value, err := t.get(k)
			if err != nil {
				return err
			}
			if value == nil {
				if err := t.put(k, []byte{1}, time.Time{}); err != nil {
					return err
				}
				added++
			}
		}
		return nil
	})
	return added, err
}

func (s *Store) RemoveMembers(ctx context.Context, name string, members ...string) error {
	if err := names(append([]string{name}, members...)...); err != nil {
		return err
	}
	return s.transact(ctx, func(t *transaction) error {
		for _, member := range members {
			if err := t.remove(key{"member", name, member}); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) HasMember(ctx context.Context, name, member string) (bool, error) {
	if err := names(name, member); err != nil {
		return false, err
	}
	var present bool
	err := s.transact(ctx, func(t *transaction) error {
		value, err := t.get(key{"member", name, member})
		present = value != nil
		return err
	})
	return present && err == nil, err
}

func (s *Store) MemberCount(ctx context.Context, name string) (int64, error) {
	if err := names(name); err != nil {
		return 0, err
	}
	var count int64
	err := s.transact(ctx, func(t *transaction) error {
		return t.tx.QueryRowContext(ctx, `SELECT count(*) FROM cao_operational_records WHERE namespace=$1 AND kind='member' AND name=$2`, s.namespace, name).Scan(&count)
	})
	return count, err
}

func (s *Store) ScanMembers(ctx context.Context, name, cursor string, count int) ([]string, string, error) {
	if err := names(name); err != nil {
		return nil, "", err
	}
	offset := int64(0)
	if cursor != "" {
		n, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || n < 0 || cursor[0] == '-' || cursor[0] == '+' {
			return nil, "", invalid("invalid scan cursor")
		}
		offset = n
	}
	if count <= 0 || count > 10000 {
		return nil, "", invalid("scan count must be between 1 and 10000")
	}
	result := []string{}
	next := "0"
	err := s.transact(ctx, func(t *transaction) error {
		rows, err := t.tx.QueryContext(ctx, `SELECT field FROM cao_operational_records WHERE namespace=$1 AND kind='member' AND name=$2 ORDER BY field COLLATE "C" LIMIT $3 OFFSET $4`, s.namespace, name, count+1, offset)
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var value string
			if err := rows.Scan(&value); err != nil {
				return err
			}
			result = append(result, value)
		}
		if len(result) > count {
			result = result[:count]
			next = strconv.FormatInt(offset+int64(count), 10)
		}
		return rows.Err()
	})
	return result, next, err
}

func (s *Store) ReadAttribute(ctx context.Context, name, field string) (string, error) {
	if err := names(name, field); err != nil {
		return "", err
	}
	var value []byte
	err := s.transact(ctx, func(t *transaction) error {
		var err error
		value, err = t.get(key{"attribute", name, field})
		return err
	})
	return string(value), err
}

func (s *Store) WriteAttribute(ctx context.Context, name, field, value string) error {
	if err := names(name, field); err != nil {
		return err
	}
	return s.transact(ctx, func(t *transaction) error {
		return t.put(key{"attribute", name, field}, []byte(value), time.Time{})
	})
}

func (s *Store) DeleteAttribute(ctx context.Context, name, field string) error {
	if err := names(name, field); err != nil {
		return err
	}
	return s.transact(ctx, func(t *transaction) error { return t.remove(key{"attribute", name, field}) })
}

func (s *Store) Clear(ctx context.Context, name string) error {
	if err := names(name); err != nil {
		return err
	}
	return s.transact(ctx, func(t *transaction) error {
		for _, kind := range []string{"member", "attribute", "debounce", "state"} {
			records, err := t.list(kind, name)
			if err != nil {
				return err
			}
			for _, r := range records {
				if err := t.remove(r.key); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func (s *Store) TransferOwners(ctx context.Context, owners, prefix, suffix string, installation int64, repositories []string) (int, error) {
	if err := names(append([]string{owners}, repositories...)...); err != nil {
		return 0, err
	}
	if err := opaque(prefix); err != nil {
		return 0, err
	}
	if err := opaque(suffix); err != nil {
		return 0, err
	}
	if installation <= 0 {
		return 0, invalid("installation must be positive")
	}
	transferred := 0
	err := s.transact(ctx, func(t *transaction) error {
		for _, repo := range repositories {
			k := key{"attribute", owners, repo}
			prior, err := t.get(k)
			if err != nil {
				return err
			}
			old, parseErr := strconv.ParseInt(string(prior), 10, 64)
			if parseErr == nil && old > 0 && old != installation {
				oldSet := prefix + string(prior) + suffix
				if err := names(oldSet); err != nil {
					return err
				}
				if err := t.remove(key{"member", oldSet, repo}); err != nil {
					return err
				}
				transferred++
			}
			if err := t.put(k, []byte(strconv.FormatInt(installation, 10)), time.Time{}); err != nil {
				return err
			}
		}
		return nil
	})
	return transferred, err
}

func (t *transaction) count(kind, name string) (int64, error) {
	var count int64
	err := t.tx.QueryRowContext(t.ctx, `SELECT count(*) FROM cao_operational_records WHERE namespace=$1 AND kind=$2 AND ($3='' OR name=$3) AND (expires_at IS NULL OR expires_at>$4)`, t.namespace, kind, name, t.now).Scan(&count)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return count, err
}
