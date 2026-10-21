package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/githubnext/gh-cao/server/internal/admission"
)

const conclusionRetention = 24 * time.Hour

type conclusionRecord struct {
	Identity   admission.Identity          `json:"identity"`
	Request    admission.ConclusionRequest `json:"request"`
	AcceptedAt time.Time                   `json:"accepted_at"`
}

type conclusionReceipt struct {
	admission.ConclusionReceipt
	Digest string `json:"digest"`
}

// RecordConclusion consumes a validated request. A permanent, operation-scoped
// receipt survives payload retention and prevents replay from recreating work.
func (s *Store) RecordConclusion(ctx context.Context, identity admission.Identity, input admission.ConclusionRequest) (admission.ConclusionReceipt, error) {
	data, err := json.Marshal(input)
	if err != nil {
		return admission.ConclusionReceipt{}, admission.ErrDenied
	}
	digest := sha256.Sum256(data)
	name := identity.Key()
	denied := false
	var result conclusionReceipt
	err = s.transact(ctx, func(t *transaction) error {
		receipt := key{"conclusion-receipt", name, ""}
		found, err := t.json(receipt, &result)
		if err != nil {
			return err
		}
		fingerprint := hex.EncodeToString(digest[:])
		if found {
			denied = result.Digest != fingerprint || !result.Populated && !t.now.Before(result.AcceptedAt.Add(conclusionRetention))
			return nil
		}
		result = conclusionReceipt{
			ConclusionReceipt: admission.ConclusionReceipt{AcceptedAt: t.now},
			Digest:            fingerprint,
		}
		if err := t.putJSON(key{"conclusion-session", name, ""}, conclusionRecord{
			Identity: identity, Request: input, AcceptedAt: t.now,
		}, t.now.Add(conclusionRetention)); err != nil {
			return err
		}
		return t.putJSON(receipt, result, time.Time{})
	})
	if err != nil {
		return admission.ConclusionReceipt{}, errors.Join(admission.ErrUnavailable, err)
	}
	if denied {
		return admission.ConclusionReceipt{}, admission.ErrDenied
	}
	return result.ConclusionReceipt, nil
}

func (s *Store) CompleteConclusion(ctx context.Context, identity admission.Identity) error {
	denied := false
	err := s.transact(ctx, func(t *transaction) error {
		key := key{"conclusion-receipt", identity.Key(), ""}
		var receipt conclusionReceipt
		found, err := t.json(key, &receipt)
		if err != nil {
			return err
		}
		if !found || !receipt.Populated && !t.now.Before(receipt.AcceptedAt.Add(conclusionRetention)) {
			denied = true
			return nil
		}
		if receipt.Populated {
			return nil
		}
		receipt.Populated = true
		return t.putJSON(key, receipt, time.Time{})
	})
	if err != nil {
		return errors.Join(admission.ErrUnavailable, err)
	}
	if denied {
		return admission.ErrDenied
	}
	return nil
}
