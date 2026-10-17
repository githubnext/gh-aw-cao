package hostedcli

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

// Revocations stores cleanup ownership in the protected operational queue.
// The codec must encrypt/authenticate values and support retained rotation keys.
// The namespace must be stable across executor restarts and separate from OAuth.
type Revocations struct {
	queue     operational.RevocationQueue
	namespace string
	seal      func([]byte) (string, error)
	open      func(string) ([]byte, error)
}

func NewRevocations(queue operational.RevocationQueue, namespace string, seal func([]byte) (string, error), open func(string) ([]byte, error)) *Revocations {
	return &Revocations{queue: queue, namespace: namespace, seal: seal, open: open}
}

type tokenRevocation struct {
	Token          string    `json:"token"`
	InstallationID int64     `json:"installationId"`
	ExpiresAt      time.Time `json:"expiresAt"`
}

func (r *Revocations) retain(ctx context.Context, token githubapp.ScopedToken) (string, error) {
	plain, err := json.Marshal(tokenRevocation{token.Secret(), token.InstallationID, token.ExpiresAt}) // #nosec G117 -- token material is immediately AES-GCM sealed before protected persistence.
	if err != nil {
		return "", errors.New("encode scoped token cleanup failed")
	}
	sealed, err := r.seal(plain)
	if err != nil {
		return "", errors.New("encrypt scoped token cleanup failed")
	}
	if err := r.queue.QueueRevocation(ctx, token.Hashed(), sealed, r.namespace); err != nil {
		return "", errors.New("persist scoped token cleanup failed")
	}
	return sealed, nil
}

func (r *Revocations) next(ctx context.Context) (githubapp.ScopedToken, string, error) {
	record, err := r.queue.PendingRevocation(ctx, r.namespace)
	if err != nil {
		return githubapp.ScopedToken{}, "", errors.New("read scoped token cleanup failed")
	}
	if record.ID == "" {
		return githubapp.ScopedToken{}, "", nil
	}
	plain, err := r.open(record.Value)
	if err != nil {
		return githubapp.ScopedToken{}, "", errors.New("decrypt scoped token cleanup failed")
	}
	var value tokenRevocation
	if err := json.Unmarshal(plain, &value); err != nil {
		return githubapp.ScopedToken{}, "", errors.New("decode scoped token cleanup failed")
	}
	token := githubapp.NewScopedToken(value.Token, value.InstallationID, value.ExpiresAt)
	if token.Secret() == "" || token.Hashed() != record.ID || value.ExpiresAt.IsZero() || value.InstallationID <= 0 {
		return githubapp.ScopedToken{}, "", errors.New("invalid scoped token cleanup record")
	}
	return token, record.Value, nil
}

func (r *Revocations) complete(ctx context.Context, token githubapp.ScopedToken, version string) error {
	if err := r.queue.CompleteRevocation(ctx, token.Hashed(), version, r.namespace); err != nil {
		return errors.New("complete scoped token cleanup failed")
	}
	return nil
}
