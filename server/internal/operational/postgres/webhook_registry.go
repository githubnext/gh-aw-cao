package postgres

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"math"
	"slices"
	"time"

	wg "github.com/githubnext/gh-aw-cao/server/internal/webhookgateway"
)

var _ wg.RegistryStore = (*webhookQueue)(nil)

func (q *webhookQueue) registry(t *transaction) (wg.RegistrySnapshot, error) {
	data, err := t.get(key{"state", "webhook-gateway:registry:" + q.name, ""})
	if err != nil || data == nil {
		return wg.RegistrySnapshot{}, err
	}
	var snapshot wg.RegistrySnapshot
	if json.Unmarshal(data, &snapshot) != nil || snapshot.Version < 1 || snapshot.Control.Revision < 1 ||
		snapshot.Revision.Revision < 1 || len(snapshot.Records) > 64 {
		return wg.RegistrySnapshot{}, wg.ErrInvalid
	}
	digest, err := wg.RegistryDigest(snapshot.Control, snapshot.Records)
	if err != nil || snapshot.Revision.Digest != digest || snapshot.Revision.Enabled != snapshot.Control.Enabled {
		return wg.RegistrySnapshot{}, wg.ErrInvalid
	}
	return snapshot, nil
}

func (q *webhookQueue) saveRegistry(t *transaction, snapshot wg.RegistrySnapshot) error {
	data, err := json.Marshal(snapshot)
	if err != nil {
		return wg.ErrInvalid
	}
	if int64(len(data)) > min(1<<20, t.config.MaxRecordBytes) {
		return wg.ErrCapacity
	}
	if err := q.applyRevision(t, snapshot.Revision); err != nil {
		return err
	}
	return t.put(key{"state", "webhook-gateway:registry:" + q.name, ""}, data, time.Time{})
}

func (q *webhookQueue) BindRegistry(ctx context.Context, control wg.QueueRevision) (wg.RegistrySnapshot, error) {
	if control.Revision < 1 || len(control.Digest) != 64 {
		return wg.RegistrySnapshot{}, wg.ErrInvalid
	}
	if _, err := hex.DecodeString(control.Digest); err != nil {
		return wg.RegistrySnapshot{}, wg.ErrInvalid
	}
	var result wg.RegistrySnapshot
	err := q.transact(ctx, func(t *transaction) error {
		existing, err := q.registry(t)
		if err != nil {
			return err
		}
		current, err := q.policy(t)
		if err != nil {
			return err
		}
		if existing.Version > 0 && existing.Revision != current {
			return wg.ErrConflict
		}
		if existing.Version == 0 && (control.Revision < current.Revision ||
			control.Revision == current.Revision && current != control) {
			return wg.ErrConflict
		}
		if control.Revision < existing.Control.Revision ||
			control.Revision == existing.Control.Revision && control != existing.Control {
			return wg.ErrConflict
		}
		if existing.Version > 0 && control == existing.Control {
			result = existing
			return nil
		}
		if current.Revision >= math.MaxInt64-1 || existing.Version >= math.MaxInt64-1 {
			return wg.ErrCapacity
		}
		digest, err := wg.RegistryDigest(control, nil)
		if err != nil {
			return err
		}
		result = wg.RegistrySnapshot{Version: existing.Version + 1, Control: control,
			Revision: wg.QueueRevision{Revision: current.Revision + 1, Digest: digest, Enabled: control.Enabled}}
		return q.saveRegistry(t, result)
	})
	if err != nil {
		return wg.RegistrySnapshot{}, err
	}
	return result, nil
}

func (q *webhookQueue) ReplaceRegistry(ctx context.Context, control wg.QueueRevision, expected int64, records []wg.RepositoryInventory) (wg.RegistrySnapshot, error) {
	if expected < 1 || len(records) > 64 {
		return wg.RegistrySnapshot{}, wg.ErrInvalid
	}
	records = slices.Clone(records)
	slices.SortFunc(records, func(a, b wg.RepositoryInventory) int {
		if a.RepositoryID < b.RepositoryID {
			return -1
		}
		if a.RepositoryID > b.RepositoryID {
			return 1
		}
		return 0
	})
	for i, record := range records {
		if record.RepositoryID <= 0 || i > 0 && record.RepositoryID == records[i-1].RepositoryID {
			return wg.RegistrySnapshot{}, wg.ErrInvalid
		}
	}
	var result wg.RegistrySnapshot
	err := q.transact(ctx, func(t *transaction) error {
		current, err := q.registry(t)
		if err != nil {
			return err
		}
		policy, err := q.policy(t)
		if err != nil {
			return err
		}
		if current.Version != expected || current.Control != control || current.Revision != policy {
			return wg.ErrConflict
		}
		if current.Version >= math.MaxInt64-1 || policy.Revision >= math.MaxInt64-1 {
			return wg.ErrCapacity
		}
		digest, err := wg.RegistryDigest(control, records)
		if err != nil {
			return err
		}
		result = wg.RegistrySnapshot{Version: current.Version + 1, Control: control, Revision: policy, Records: records}
		if digest != policy.Digest {
			result.Revision = wg.QueueRevision{Revision: policy.Revision + 1, Digest: digest, Enabled: control.Enabled}
		}
		return q.saveRegistry(t, result)
	})
	if err != nil {
		return wg.RegistrySnapshot{}, err
	}
	return result, nil
}
