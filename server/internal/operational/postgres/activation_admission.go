package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/githubnext/gh-cao/server/internal/admission"
)

type activationDecision struct {
	Allowances admission.Allowances `json:"allowances"`
	ExpiresAt  time.Time            `json:"expires_at"`
	Revoked    bool                 `json:"revoked"`
}

func (s *Store) CheckAdmission(ctx context.Context, name string) error {
	if len(name) != 64 {
		return admission.ErrDenied
	}
	denied := false
	err := s.transact(ctx, func(t *transaction) error {
		var record activationDecision
		found, err := t.json(key{"activation-admission", name, ""}, &record)
		if err != nil {
			return err
		}
		denied = found && (record.Revoked || !t.now.Before(record.ExpiresAt))
		return nil
	})
	if err != nil {
		return errors.Join(admission.ErrUnavailable, err)
	}
	if denied {
		return admission.ErrDenied
	}
	return nil
}

// ResolveAdmission uses the existing namespace transaction and protected-record
// budget. Records have no TTL: expiry or revocation must never regrant a run.
func (s *Store) ResolveAdmission(ctx context.Context, name string, proposal *admission.Allowances) (admission.Allowances, error) {
	if len(name) != 64 {
		return admission.Allowances{}, admission.ErrDenied
	}
	var result admission.Allowances
	denied := false
	err := s.transact(ctx, func(t *transaction) error {
		k := key{"activation-admission", name, ""}
		var record activationDecision
		found, err := t.json(k, &record)
		if err != nil {
			return err
		}
		if !found {
			record.ExpiresAt = t.now.Add(5 * time.Minute)
			if proposal != nil {
				record.Allowances = *proposal
			}
		}
		if proposal == nil || !t.now.Before(record.ExpiresAt) {
			record.Revoked = true
		}
		if err := t.putJSON(k, record, time.Time{}); err != nil {
			return err
		}
		result, denied = record.Allowances, record.Revoked
		return nil
	})
	if err != nil {
		return admission.Allowances{}, errors.Join(admission.ErrUnavailable, err)
	}
	if denied {
		return admission.Allowances{}, admission.ErrDenied
	}
	return result, nil
}
