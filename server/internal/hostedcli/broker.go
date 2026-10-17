package hostedcli

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/audit"
	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var brokerLog = logger.New("cao:hostedcli:broker")

// Minter mints and revokes scoped installation tokens.
type Minter interface {
	MintScopedToken(context.Context, int64, githubapp.TokenScope) (githubapp.ScopedToken, error)
	RevokeToken(context.Context, githubapp.ScopedToken) error
}

// BrokerOptions bound the pool of pre-minted tokens.
type BrokerOptions struct {
	// MaxPooled bounds unused pre-minted tokens across all scopes; zero
	// disables pooling so every command mints on demand.
	MaxPooled int
	// MaxPooledPerScope bounds unused tokens for one identical grant.
	MaxPooledPerScope int
	// IdleTTL revokes a pooled token that no command claimed in time.
	IdleTTL time.Duration
	// MaxConcurrentMints bounds simultaneous token creation requests.
	MaxConcurrentMints int
	// RevokeTimeout bounds one revocation request.
	RevokeTimeout time.Duration
	Now           func() time.Time
	// Audit records token lifecycle events; nil disables them.
	Audit *audit.Logger
}

func (o BrokerOptions) resolve() BrokerOptions {
	if o.MaxPooled < 0 {
		o.MaxPooled = 0
	}
	if o.MaxPooledPerScope <= 0 {
		o.MaxPooledPerScope = 2
	}
	if o.IdleTTL <= 0 {
		o.IdleTTL = 2 * time.Minute
	}
	if o.MaxConcurrentMints <= 0 {
		o.MaxConcurrentMints = 4
	}
	if o.RevokeTimeout <= 0 {
		o.RevokeTimeout = 10 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

type pooledToken struct {
	token    githubapp.ScopedToken
	pooledAt time.Time
}

// BrokerStats reports counters without credential material.
type BrokerStats struct {
	Pooled, PendingRevocations   int
	Minted, Reused, Revoked      int64
	RevocationFailures, Discards int64
}

// Broker hands out single-use scoped tokens. A token leaves the pool exactly
// once and is revoked on Release; it is never returned to the pool. Pooling
// only pre-mints tokens ahead of queued commands so a backlog drains without
// serializing on token creation.
type Broker struct {
	minter  Minter
	options BrokerOptions
	mints   chan struct{}

	mutex   sync.Mutex
	pool    map[string][]pooledToken
	pending []githubapp.ScopedToken
	closed  bool
	stats   BrokerStats
}

// NewBroker constructs a token broker.
func NewBroker(minter Minter, options BrokerOptions) *Broker {
	options = options.resolve()
	return &Broker{
		minter: minter, options: options,
		mints: make(chan struct{}, options.MaxConcurrentMints),
		pool:  map[string][]pooledToken{},
	}
}

// ErrBrokerClosed reports use after Close.
var ErrBrokerClosed = errors.New("token broker is closed")

// Acquire returns an unused token for scope that stays valid until needUntil.
// The caller owns the token and must call Release exactly once.
func (b *Broker) Acquire(ctx context.Context, installationID int64, scope githubapp.TokenScope, needUntil time.Time) (githubapp.ScopedToken, error) {
	key := scope.Key(installationID)
	b.mutex.Lock()
	if b.closed {
		b.mutex.Unlock()
		return githubapp.ScopedToken{}, ErrBrokerClosed
	}
	var stale []githubapp.ScopedToken
	for len(b.pool[key]) > 0 {
		entries := b.pool[key]
		entry := entries[len(entries)-1]
		b.pool[key] = entries[:len(entries)-1]
		if entry.token.ExpiresAt.After(needUntil) {
			b.dropEmpty(key)
			b.stats.Reused++
			b.mutex.Unlock()
			b.revokeAll(ctx, stale)
			brokerLog.Printf("handed out pooled scoped token")
			return entry.token, nil
		}
		stale = append(stale, entry.token)
	}
	b.dropEmpty(key)
	b.mutex.Unlock()
	b.revokeAll(ctx, stale)
	token, err := b.mint(ctx, installationID, scope)
	if err != nil {
		return githubapp.ScopedToken{}, err
	}
	if !token.ExpiresAt.After(needUntil) {
		b.Release(ctx, token)
		return githubapp.ScopedToken{}, errors.New("scoped token lifetime is shorter than the command deadline")
	}
	return token, nil
}

// Prefetch pre-mints one token for scope when the pool has room. It is a
// best-effort optimization for queued commands and never blocks on a full
// pool.
func (b *Broker) Prefetch(ctx context.Context, installationID int64, scope githubapp.TokenScope, needUntil time.Time) error {
	key := scope.Key(installationID)
	b.mutex.Lock()
	full := b.closed || b.pooledLocked() >= b.options.MaxPooled || len(b.pool[key]) >= b.options.MaxPooledPerScope
	b.mutex.Unlock()
	if full {
		return nil
	}
	token, err := b.mint(ctx, installationID, scope)
	if err != nil {
		return err
	}
	b.mutex.Lock()
	if b.closed || b.pooledLocked() >= b.options.MaxPooled || len(b.pool[key]) >= b.options.MaxPooledPerScope ||
		!token.ExpiresAt.After(needUntil) {
		b.stats.Discards++
		b.mutex.Unlock()
		b.Release(ctx, token)
		return nil
	}
	b.pool[key] = append(b.pool[key], pooledToken{token: token, pooledAt: b.options.Now()})
	b.mutex.Unlock()
	return nil
}

// Release revokes a token immediately. Failed revocations are retried by
// Maintain until the token expires.
func (b *Broker) Release(ctx context.Context, token githubapp.ScopedToken) {
	if token.Secret() == "" {
		return
	}
	if err := b.revoke(ctx, token); err != nil {
		b.mutex.Lock()
		b.pending = append(b.pending, token)
		b.mutex.Unlock()
	}
}

// Maintain revokes idle or nearly expired pooled tokens and retries failed
// revocations. Call it periodically.
func (b *Broker) Maintain(ctx context.Context) {
	now := b.options.Now()
	var revoke []githubapp.ScopedToken
	b.mutex.Lock()
	for key, entries := range b.pool {
		kept := entries[:0]
		for _, entry := range entries {
			if now.Sub(entry.pooledAt) >= b.options.IdleTTL || !entry.token.ExpiresAt.After(now.Add(b.options.IdleTTL)) {
				revoke = append(revoke, entry.token)
				continue
			}
			kept = append(kept, entry)
		}
		b.pool[key] = kept
		b.dropEmpty(key)
	}
	pending := b.pending
	b.pending = nil
	b.mutex.Unlock()
	b.revokeAll(ctx, revoke)
	for _, token := range pending {
		if !token.ExpiresAt.After(now) {
			continue // An expired token is already invalid.
		}
		b.Release(ctx, token)
	}
}

// Close revokes every pooled and pending token and rejects further use.
func (b *Broker) Close(ctx context.Context) {
	b.mutex.Lock()
	b.closed = true
	var revoke []githubapp.ScopedToken
	for _, entries := range b.pool {
		for _, entry := range entries {
			revoke = append(revoke, entry.token)
		}
	}
	b.pool = map[string][]pooledToken{}
	revoke = append(revoke, b.pending...)
	b.pending = nil
	b.mutex.Unlock()
	b.revokeAll(ctx, revoke)
}

// Stats returns broker counters.
func (b *Broker) Stats() BrokerStats {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	stats := b.stats
	stats.Pooled = b.pooledLocked()
	stats.PendingRevocations = len(b.pending)
	return stats
}

func (b *Broker) mint(ctx context.Context, installationID int64, scope githubapp.TokenScope) (githubapp.ScopedToken, error) {
	select {
	case b.mints <- struct{}{}:
	case <-ctx.Done():
		return githubapp.ScopedToken{}, ctx.Err()
	}
	defer func() { <-b.mints }()
	token, err := b.minter.MintScopedToken(ctx, installationID, scope)
	if err != nil {
		return githubapp.ScopedToken{}, err
	}
	b.mutex.Lock()
	b.stats.Minted++
	b.mutex.Unlock()
	b.options.Audit.Record(ctx, "token.minted", audit.Success,
		slog.Int64("installation_id", installationID),
		slog.Any("repositories", scope.Repositories),
		slog.Any("permissions", scope.Permissions),
		slog.String("hashed_token", token.Hashed()),
		slog.Time("expires_at", token.ExpiresAt))
	return token, nil
}

func (b *Broker) revoke(ctx context.Context, token githubapp.ScopedToken) error {
	// Revocation must outlive a canceled command context.
	revokeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), b.options.RevokeTimeout)
	defer cancel()
	err := b.minter.RevokeToken(revokeCtx, token)
	b.mutex.Lock()
	if err != nil {
		b.stats.RevocationFailures++
	} else {
		b.stats.Revoked++
	}
	b.mutex.Unlock()
	if err != nil {
		brokerLog.Printf("scoped token revocation failed; will retry")
		b.options.Audit.Record(ctx, "token.revoke_failed", audit.Failure, slog.String("hashed_token", token.Hashed()))
	} else {
		b.options.Audit.Record(ctx, "token.revoked", audit.Success, slog.String("hashed_token", token.Hashed()))
	}
	return err
}

func (b *Broker) revokeAll(ctx context.Context, tokens []githubapp.ScopedToken) {
	for _, token := range tokens {
		b.Release(ctx, token)
	}
}

func (b *Broker) pooledLocked() int {
	total := 0
	for _, entries := range b.pool {
		total += len(entries)
	}
	return total
}

func (b *Broker) dropEmpty(key string) {
	if len(b.pool[key]) == 0 {
		delete(b.pool, key)
	}
}
