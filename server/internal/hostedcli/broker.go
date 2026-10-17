package hostedcli

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/githubnext/gh-aw-cao/server/internal/audit"
	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/logger"
)

var brokerLog = logger.New("cao:hostedcli:broker")

// Minter mints and revokes scoped installation tokens. A nonempty token returned
// with an error transfers cleanup ownership only; it must never be handed out.
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
	// Revocations retains encrypted cleanup ownership across restarts.
	// Nil is intended only for process-local tests and alternative brokers.
	Revocations *Revocations
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

type ownedToken struct {
	token   githubapp.ScopedToken
	version string
	pending bool
	revoked bool
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

	mutex  sync.Mutex
	pool   map[string][]pooledToken
	owned  map[string]*ownedToken
	closed bool
	stats  BrokerStats

	cleanupMutex  sync.Mutex
	minting       sync.WaitGroup
	unobserveOnce sync.Once
	unobserve     func()
}

// NewBroker constructs a token broker.
func NewBroker(minter Minter, options BrokerOptions) *Broker {
	options = options.resolve()
	broker := &Broker{
		minter: minter, options: options,
		mints: make(chan struct{}, options.MaxConcurrentMints),
		pool:  map[string][]pooledToken{},
		owned: map[string]*ownedToken{},
	}
	broker.unobserve = observeBroker(broker)
	return broker
}

// ErrBrokerClosed reports use after Close.
var ErrBrokerClosed = errors.New("token broker is closed")

// Acquire returns an unused token for scope that stays valid until needUntil.
// The caller owns the token and must call Release exactly once.
func (b *Broker) Acquire(ctx context.Context, installationID int64, scope githubapp.TokenScope, needUntil time.Time) (githubapp.ScopedToken, error) {
	key := scope.Key(installationID)
	b.cleanupMutex.Lock()
	b.mutex.Lock()
	if err := b.issuanceErrorLocked(); err != nil {
		b.mutex.Unlock()
		b.cleanupMutex.Unlock()
		return githubapp.ScopedToken{}, err
	}
	b.cleanupMutex.Unlock()
	var stale []githubapp.ScopedToken
	for len(b.pool[key]) > 0 {
		entries := b.pool[key]
		entry := entries[len(entries)-1]
		b.pool[key] = entries[:len(entries)-1]
		if entry.token.ExpiresAt.After(needUntil) {
			b.dropEmpty(key)
			b.stats.Reused++
			b.mutex.Unlock()
			countToken(ctx, tokenReuse, nil)
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
		countToken(ctx, tokenDiscard, nil)
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
	b.cleanupMutex.Lock()
	defer b.cleanupMutex.Unlock()
	b.mutex.Lock()
	entry := b.owned[token.Hashed()]
	if entry == nil {
		entry = &ownedToken{token: token}
		b.owned[token.Hashed()] = entry
	}
	entry.pending = true
	b.mutex.Unlock()
	if err := b.cleanup(ctx, entry); err != nil {
		brokerLog.Printf("scoped token cleanup retained for retry")
	}
}

// Maintain revokes idle or nearly expired pooled tokens and retries failed
// revocations. Call it periodically.
func (b *Broker) Maintain(ctx context.Context) error {
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
	b.mutex.Unlock()
	b.revokeAll(ctx, revoke)
	b.cleanupMutex.Lock()
	defer b.cleanupMutex.Unlock()
	var result error
	b.mutex.Lock()
	var pending []*ownedToken
	for _, entry := range b.owned {
		if entry.pending {
			pending = append(pending, entry)
		}
	}
	b.mutex.Unlock()
	for _, entry := range pending {
		result = errors.Join(result, b.cleanup(ctx, entry))
	}
	if b.options.Revocations == nil {
		return result
	}
	// Only the executor holding the command queue lease runs maintenance.
	// Locally owned active tokens are still in use; all other journal records
	// belong to interrupted executors and are cleanup-only.
	seen := map[string]bool{}
	for range 16 {
		token, version, err := b.options.Revocations.next(ctx)
		if err != nil {
			return errors.Join(result, err)
		}
		if token.Secret() == "" || seen[token.Hashed()] {
			break
		}
		seen[token.Hashed()] = true
		b.mutex.Lock()
		entry := b.owned[token.Hashed()]
		if entry == nil {
			entry = &ownedToken{token: token, version: version, pending: true}
			b.owned[token.Hashed()] = entry
		}
		active := !entry.pending
		b.mutex.Unlock()
		if !active {
			result = errors.Join(result, b.cleanup(ctx, entry))
		}
	}
	return result
}

// Close rejects further use and waits for in-flight mints before revoking every
// owned token. If both persistence and revocation are unavailable it keeps
// retrying until ownership is durable, the token expires, or ctx is canceled.
// On cancellation the broker still owns cleanup and Close can be called again.
func (b *Broker) Close(ctx context.Context) error {
	b.mutex.Lock()
	b.closed = true
	b.pool = map[string][]pooledToken{}
	b.mutex.Unlock()
	b.minting.Wait()
	b.cleanupMutex.Lock()
	defer b.cleanupMutex.Unlock()
	defer b.unobserveOnce.Do(func() {
		if b.unobserve != nil {
			b.unobserve()
		}
	})
	for {
		b.mutex.Lock()
		entries := make([]*ownedToken, 0, len(b.owned))
		for _, entry := range b.owned {
			entry.pending = true
			entries = append(entries, entry)
		}
		b.mutex.Unlock()
		var result error
		unsafe := false
		for _, entry := range entries {
			err := b.cleanup(ctx, entry)
			result = errors.Join(result, err)
			unsafe = unsafe || (err != nil && entry.version == "" && !entry.revoked)
		}
		if !unsafe {
			return result
		}
		if b.options.Revocations == nil || !sleep(ctx, time.Second) {
			return errors.Join(result, ctx.Err())
		}
	}
}

// Stats returns broker counters.
func (b *Broker) Stats() BrokerStats {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	stats := b.stats
	stats.Pooled = b.pooledLocked()
	for _, entry := range b.owned {
		if entry.pending {
			stats.PendingRevocations++
		}
	}
	return stats
}

func (b *Broker) mint(ctx context.Context, installationID int64, scope githubapp.TokenScope) (token githubapp.ScopedToken, err error) {
	ctx, span := tracer().Start(ctx, spanTokenMint, trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(attribute.Int64(attributeInstall, installationID), attribute.StringSlice(attributeRepository, scope.Repositories)))
	defer func() {
		if err == nil {
			span.SetAttributes(attribute.String(attributeHashed, token.Hashed()))
		}
		countToken(ctx, tokenMint, err)
		endSpan(span, err)
	}()
	select {
	case b.mints <- struct{}{}:
	case <-ctx.Done():
		return githubapp.ScopedToken{}, ctx.Err()
	}
	defer func() { <-b.mints }()
	b.cleanupMutex.Lock()
	b.mutex.Lock()
	if err := b.issuanceErrorLocked(); err != nil {
		b.mutex.Unlock()
		b.cleanupMutex.Unlock()
		return githubapp.ScopedToken{}, err
	}
	b.minting.Add(1)
	b.mutex.Unlock()
	b.cleanupMutex.Unlock()
	defer b.minting.Done()
	token, err = b.minter.MintScopedToken(ctx, installationID, scope)
	if token.Secret() == "" {
		if err == nil {
			err = errors.New("scoped token mint returned no credential")
		}
		return githubapp.ScopedToken{}, err
	}
	err = errors.Join(err, ctx.Err())
	cleanupDeadline := b.options.Now().Add(githubapp.ScopedTokenLifetime)
	if token.ExpiresAt.IsZero() || token.ExpiresAt.After(cleanupDeadline) {
		token.ExpiresAt = cleanupDeadline
		err = errors.Join(err, errors.New("scoped token mint returned invalid expiry"))
	}
	// Register ownership before scope/audit failure can discard the result.
	// Persistence and maintenance serialize so recovery cannot race this mint.
	b.cleanupMutex.Lock()
	entry := &ownedToken{token: token}
	b.mutex.Lock()
	b.owned[token.Hashed()] = entry
	b.stats.Minted++
	closed := b.closed
	b.mutex.Unlock()
	if b.options.Revocations != nil {
		storeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), b.options.RevokeTimeout)
		var retainErr error
		entry.version, retainErr = b.options.Revocations.retain(storeCtx, entry.token)
		err = errors.Join(err, retainErr)
		cancel()
	}
	if closed {
		err = errors.Join(err, ErrBrokerClosed)
	}
	b.mutex.Lock()
	entry.pending = err != nil
	b.mutex.Unlock()
	b.cleanupMutex.Unlock()
	if err != nil {
		b.Release(ctx, token)
		return githubapp.ScopedToken{}, err
	}
	if err := b.options.Audit.Record(ctx, "token.minted", audit.Success,
		slog.Int64("installation_id", installationID),
		slog.Any("repositories", scope.Repositories),
		slog.Any("permissions", scope.Permissions),
		slog.String("hashed_token", token.Hashed()),
		slog.Time("expires_at", token.ExpiresAt)); err != nil {
		// A credential without a durable audit record is never handed out.
		b.Release(ctx, token)
		return githubapp.ScopedToken{}, err
	}
	return token, nil
}

// Both cleanupMutex and mutex protect this admission check.
func (b *Broker) issuanceErrorLocked() error {
	if b.closed {
		return ErrBrokerClosed
	}
	for _, entry := range b.owned {
		if entry.pending && entry.version == "" && !entry.revoked {
			return errors.New("scoped token cleanup is unavailable")
		}
	}
	return nil
}

// cleanup is serialized by cleanupMutex. Only confirmed revocation/expiry
// allows removing a journal entry; storage and audit failures cannot erase
// the in-process owner.
func (b *Broker) cleanup(ctx context.Context, entry *ownedToken) error {
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), b.options.RevokeTimeout)
	defer cancel()
	var retainErr error
	expired := !entry.token.ExpiresAt.After(b.options.Now())
	if !entry.revoked && !expired && entry.version == "" && b.options.Revocations != nil {
		entry.version, retainErr = b.options.Revocations.retain(cleanupCtx, entry.token)
	}
	if !entry.revoked && !expired {
		if err := b.revoke(cleanupCtx, entry.token); err != nil {
			return errors.Join(retainErr, err)
		}
	}
	entry.revoked = true
	if entry.version != "" {
		if err := b.options.Revocations.complete(cleanupCtx, entry.token, entry.version); err != nil {
			return err
		}
	}
	b.mutex.Lock()
	delete(b.owned, entry.token.Hashed())
	b.mutex.Unlock()
	return nil
}

func (b *Broker) revoke(ctx context.Context, token githubapp.ScopedToken) error {
	// Revocation must outlive a canceled command context.
	revokeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), b.options.RevokeTimeout)
	defer cancel()
	revokeCtx, span := tracer().Start(revokeCtx, spanTokenRevoke, trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(attribute.String(attributeHashed, token.Hashed())))
	err := b.minter.RevokeToken(revokeCtx, token)
	countToken(revokeCtx, tokenRevoke, err)
	endSpan(span, err)
	b.mutex.Lock()
	if err != nil {
		b.stats.RevocationFailures++
	} else {
		b.stats.Revoked++
	}
	b.mutex.Unlock()
	if err != nil {
		brokerLog.Printf("scoped token revocation failed; will retry")
		_ = b.options.Audit.Record(ctx, "token.revoke_failed", audit.Failure, slog.String("hashed_token", token.Hashed()))
		return errors.New("scoped token revocation failed")
	} else {
		_ = b.options.Audit.Record(ctx, "token.revoked", audit.Success, slog.String("hashed_token", token.Hashed()))
	}
	return nil
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
