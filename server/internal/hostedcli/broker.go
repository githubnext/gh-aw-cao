package hostedcli

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/githubnext/gh-cao/server/internal/audit"
	"github.com/githubnext/gh-cao/server/internal/githubapp"
	"github.com/githubnext/gh-cao/server/internal/logger"
	"github.com/githubnext/gh-cao/server/internal/operational"
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
	record  tokenRevocation
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
	if err := b.issuanceErrorLocked(ctx); err != nil {
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
			if err := b.bindPooled(ctx, entry.token); err != nil {
				b.Release(ctx, entry.token)
				return githubapp.ScopedToken{}, err
			}
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

// An empty key checks only global capacity before resolving an installation.
func (b *Broker) prefetchCapacity(key string) bool {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return !b.closed && b.pooledLocked() < b.options.MaxPooled &&
		(key == "" || len(b.pool[key]) < b.options.MaxPooledPerScope)
}

// Prefetch pre-mints one token for scope when the pool has room. It is a
// best-effort optimization for queued commands and never blocks on a full
// pool.
func (b *Broker) Prefetch(ctx context.Context, installationID int64, scope githubapp.TokenScope, needUntil time.Time) error {
	key := scope.Key(installationID)
	if !b.prefetchCapacity(key) {
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
	// Do not wait behind another token's journal transaction (which can itself
	// be waiting for an audit writer). Revocation is safe to repeat; issuance is
	// never repeated. Ownership and receipt persistence still serialize below.
	expired := !token.ExpiresAt.After(b.options.Now())
	var revokeErr error
	if !expired {
		revokeErr = b.revoke(ctx, token)
	}
	observed := b.options.Now()
	b.cleanupMutex.Lock()
	defer b.cleanupMutex.Unlock()
	b.mutex.Lock()
	entry := b.owned[token.Hashed()]
	if entry == nil {
		entry = &ownedToken{token: token, record: tokenRecord(ctx, token)}
		b.owned[token.Hashed()] = entry
	}
	if command, ok := ctx.Value(tokenAuditContext{}).(operational.CLICommand); ok {
		entry.record.Actor, entry.record.Repository, entry.record.CommandID = command.Actor, command.Repository, command.ID
	}
	entry.pending = true
	b.mutex.Unlock()
	if !entry.revoked {
		if revokeErr == nil {
			b.confirmCleanup(entry, expired, observed)
		} else if entry.record.FailureAt.IsZero() {
			entry.record.FailureAt = observed
		}
	}
	err := b.persistCleanup(ctx, entry)
	if err == nil && entry.revoked {
		b.mutex.Lock()
		delete(b.owned, entry.record.HashedToken)
		b.mutex.Unlock()
	}
	if err != nil || revokeErr != nil {
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
	result := b.maintainOwned(ctx)
	b.cleanupMutex.Unlock()
	return errors.Join(result, b.flushJournal(ctx))
}

func (b *Broker) maintainOwned(ctx context.Context) error {
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
		recovered, err := b.options.Revocations.pending(ctx)
		if err != nil {
			return errors.Join(result, err)
		}
		if recovered == nil || seen[recovered.record.HashedToken] {
			break
		}
		id := recovered.record.HashedToken
		seen[id] = true
		if recovered.revoked {
			continue
		}
		b.mutex.Lock()
		entry := b.owned[id]
		if entry == nil {
			entry = recovered
			entry.record.Recovered = true
			b.owned[id] = entry
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
			b.cleanupMutex.Unlock()
			return errors.Join(result, b.flushJournal(ctx))
		}
		if b.options.Revocations == nil || !sleep(ctx, time.Second) {
			b.cleanupMutex.Unlock()
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
	if err := b.issuanceErrorLocked(ctx); err != nil {
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
	entry := &ownedToken{token: token, record: tokenRecord(ctx, token)}
	entry.record.Repositories = scope.Repositories
	b.mutex.Lock()
	b.owned[token.Hashed()] = entry
	b.stats.Minted++
	closed := b.closed
	b.mutex.Unlock()
	if b.options.Revocations != nil {
		storeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), b.options.RevokeTimeout)
		retainErr := b.options.Revocations.retain(storeCtx, entry)
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
	b.cleanupMutex.Lock()
	b.mutex.Lock()
	err = b.issuanceErrorLocked(ctx)
	b.mutex.Unlock()
	b.cleanupMutex.Unlock()
	if err != nil {
		b.Release(ctx, token)
		return githubapp.ScopedToken{}, err
	}
	return token, nil
}

// Both cleanupMutex and mutex protect this admission check.
func (b *Broker) issuanceErrorLocked(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
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
	expired := !entry.record.ExpiresAt.After(b.options.Now())
	if !entry.revoked && !expired {
		if err := b.revoke(cleanupCtx, entry.token); err != nil {
			if entry.record.FailureAt.IsZero() {
				entry.record.FailureAt = b.options.Now()
			}
			return errors.Join(err, b.persistCleanup(ctx, entry))
		}
	}
	if !entry.revoked {
		b.confirmCleanup(entry, expired, b.options.Now())
	}
	if err := b.persistCleanup(ctx, entry); err != nil {
		return err
	}
	b.mutex.Lock()
	delete(b.owned, entry.record.HashedToken)
	b.mutex.Unlock()
	return nil
}

func (b *Broker) confirmCleanup(entry *ownedToken, expired bool, observed time.Time) {
	entry.revoked = true
	entry.record.Completion = "token.revoked"
	if expired {
		entry.record.Completion = "token.expired"
	}
	entry.record.CompletedAt = observed
	// Evidence must not retain plaintext while its durable receipt is pending.
	entry.token = githubapp.ScopedToken{}
}

func (b *Broker) persistCleanup(ctx context.Context, entry *ownedToken) error {
	// Use a fresh budget after the external effect; an exhausted revoke budget
	// must not suppress the attempt to durably remove its credential.
	storeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), operational.AuditWriteTimeout)
	defer cancel()
	if b.options.Revocations != nil {
		err := b.options.Revocations.save(storeCtx, entry)
		if errors.Is(err, operational.ErrConflict) {
			// A different durable version (or its committed deletion) owns
			// reconciliation after an uncertain commit; never overwrite it.
			b.mutex.Lock()
			delete(b.owned, entry.record.HashedToken)
			b.mutex.Unlock()
		}
		return err
	}
	// Process-local brokers have no restart guarantee.
	name, outcome := "token.revoke_failed", audit.Failure
	if entry.revoked {
		name, outcome = entry.record.Completion, audit.Success
	}
	return b.options.Audit.Record(storeCtx, name, outcome, slog.String("hashed_token", entry.record.HashedToken))
}

// Audit delivery never holds cleanupMutex: an unavailable audit append for one
// receipt must not prevent another Release from revoking its live credential.
func (b *Broker) flushJournal(ctx context.Context) error {
	if b.options.Revocations == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), operational.AuditWriteTimeout)
	defer cancel()
	seen := map[string]bool{}
	var result error
	for range 16 {
		journal := b.options.Revocations
		record, err := journal.queue.PendingRevocation(ctx, journal.namespace)
		if err != nil {
			return errors.Join(result, errors.New("read scoped token receipt failed"))
		}
		if record.ID == "" || seen[record.ID] {
			break
		}
		seen[record.ID] = true
		if !strings.HasPrefix(record.Value, "{") {
			continue
		}
		entry, err := journal.decode(record)
		if err != nil {
			result = errors.Join(result, err)
			continue
		}
		err = journal.flush(ctx, entry)
		if err != nil && !errors.Is(err, operational.ErrConflict) {
			result = errors.Join(result, err)
		}
	}
	return result
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
		return errors.New("scoped token revocation failed")
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
