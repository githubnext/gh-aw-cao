package hostedcli

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubapp"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

// Revocations retains encrypted cleanup ownership and credential-free pending
// evidence in the same protected journal. Neither form expires automatically.
type Revocations struct {
	queue     operational.RevocationQueue
	namespace string
	seal      func([]byte) (string, error)
	open      func(string) ([]byte, error)
}

func NewRevocations(queue operational.RevocationQueue, namespace string, seal func([]byte) (string, error), open func(string) ([]byte, error)) *Revocations {
	return &Revocations{queue: queue, namespace: namespace, seal: seal, open: open}
}

func (r *Revocations) durableAudit() bool {
	if r == nil {
		return false
	}
	_, ok := r.queue.(operational.RevocationTransitions)
	return ok
}

type tokenAuditContext struct{}

func withTokenActor(ctx context.Context, command operational.CLICommand) context.Context {
	return context.WithValue(ctx, tokenAuditContext{}, command)
}

func (b *Broker) bindPooled(ctx context.Context, token githubapp.ScopedToken) error {
	b.cleanupMutex.Lock()
	defer b.cleanupMutex.Unlock()
	b.mutex.Lock()
	err := b.issuanceErrorLocked(ctx)
	entry := b.owned[token.Hashed()]
	b.mutex.Unlock()
	if err != nil {
		return err
	}
	if entry == nil || entry.pending || entry.revoked {
		return errors.New("pooled token cleanup owner is unavailable")
	}
	if command, ok := ctx.Value(tokenAuditContext{}).(operational.CLICommand); ok {
		entry.record.Actor, entry.record.Repository, entry.record.CommandID = command.Actor, command.Repository, command.ID
		if b.options.Revocations != nil {
			if err := b.options.Revocations.save(ctx, entry); err != nil {
				return err
			}
		}
	}
	b.mutex.Lock()
	defer b.mutex.Unlock()
	return b.issuanceErrorLocked(ctx)
}

type tokenRevocation struct {
	Token          string    `json:"token,omitempty"`
	InstallationID int64     `json:"installationId"`
	ExpiresAt      time.Time `json:"expiresAt"`
	HashedToken    string    `json:"hashedToken"`
	Actor          string    `json:"actor,omitempty"`
	Repository     string    `json:"repository,omitempty"`
	CommandID      int64     `json:"commandId,omitempty"`
	Repositories   []string  `json:"repositories,omitempty"`
	FailureAt      time.Time `json:"failureAt,omitempty"`
	Completion     string    `json:"completion,omitempty"`
	CompletedAt    time.Time `json:"completedAt,omitempty"`
	Recovered      bool      `json:"recovered,omitempty"`
	Reserve        string    `json:"reserve,omitempty"`
}

func tokenRecord(ctx context.Context, token githubapp.ScopedToken) tokenRevocation {
	command, _ := ctx.Value(tokenAuditContext{}).(operational.CLICommand)
	return tokenRevocation{
		InstallationID: token.InstallationID, ExpiresAt: token.ExpiresAt, HashedToken: token.Hashed(),
		Actor: command.Actor, Repository: command.Repository, CommandID: command.ID, Repositories: token.Repositories,
	}
}

func (r *Revocations) encode(entry *ownedToken) (string, error) {
	value := entry.record
	if !entry.revoked {
		value.Token = entry.token.Secret() // #nosec G117 -- encrypted immediately below.
		if value.FailureAt.IsZero() {
			// Reserve room for first-failure evidence at protected capacity.
			value.Reserve = strings.Repeat(" ", 128)
		}
	}
	plain, err := json.Marshal(value)
	if err != nil {
		return "", errors.New("encode scoped token cleanup failed")
	}
	if entry.revoked {
		return string(plain), nil
	}
	sealed, err := r.seal(plain)
	if err != nil {
		return "", errors.New("encrypt scoped token cleanup failed")
	}
	return sealed, nil
}

func (r *Revocations) retain(ctx context.Context, entry *ownedToken) error {
	value, err := r.encode(entry)
	if err != nil {
		return err
	}
	transition, ok := r.queue.(operational.RevocationTransitions)
	if !ok {
		return errors.New("scoped token cleanup requires atomic audit transitions")
	}
	changed, err := transition.TransitionRevocation(ctx, entry.record.HashedToken, "", value, r.namespace, nil)
	if err != nil {
		return errors.New("persist scoped token cleanup failed")
	}
	if !changed {
		return operational.ErrConflict
	}
	entry.version = value
	return nil
}

// save replaces the credential independently of the audit table. An uncertain
// CAS commit never causes a new insertion or token issuance.
func (r *Revocations) save(ctx context.Context, entry *ownedToken) error {
	if entry.version == "" {
		return r.retain(ctx, entry)
	}
	value, err := r.encode(entry)
	if err != nil {
		return err
	}
	if value == entry.version {
		return nil
	}
	transition, ok := r.queue.(operational.RevocationTransitions)
	if !ok {
		return errors.New("scoped token cleanup requires atomic audit transitions")
	}
	changed, err := transition.TransitionRevocation(ctx, entry.record.HashedToken, entry.version, value, r.namespace, nil)
	if err != nil {
		return errors.New("persist scoped token cleanup transition failed")
	}
	if !changed {
		// Another committed version owns recovery. Never overwrite it.
		return operational.ErrConflict
	}
	entry.version = value
	return nil
}

func (r *Revocations) pending(ctx context.Context) (*ownedToken, error) {
	record, err := r.queue.PendingRevocation(ctx, r.namespace)
	if err != nil {
		return nil, errors.New("read scoped token cleanup failed")
	}
	return r.decode(record)
}

func (r *Revocations) decode(record operational.Revocation) (*ownedToken, error) {
	if record.ID == "" {
		return nil, nil //nolint:nilnil // an empty journal has no cleanup owner.
	}
	plain := []byte(record.Value)
	receipt := strings.HasPrefix(record.Value, "{")
	if !receipt {
		var err error
		plain, err = r.open(record.Value)
		if err != nil {
			return nil, errors.New("decrypt scoped token cleanup failed")
		}
	}
	var value tokenRevocation
	if err := json.Unmarshal(plain, &value); err != nil {
		return nil, errors.New("decode scoped token cleanup failed")
	}
	token := githubapp.NewScopedToken(value.Token, value.InstallationID, value.ExpiresAt)
	if !receipt && value.HashedToken == "" {
		value.HashedToken = token.Hashed() // Upgrade retained pre-lifecycle journals.
	}
	if value.HashedToken != record.ID || value.ExpiresAt.IsZero() || value.InstallationID <= 0 ||
		(receipt && (value.Token != "" || (value.Completion != "token.revoked" && value.Completion != "token.expired") || value.CompletedAt.IsZero())) ||
		(!receipt && (token.Secret() == "" || token.Hashed() != record.ID || value.Completion != "")) {
		return nil, errors.New("invalid scoped token cleanup record")
	}
	value.Token = ""
	value.Reserve = ""
	return &ownedToken{token: token, version: record.Value, pending: true, revoked: receipt, record: value}, nil
}

func (v tokenRevocation) event(name string, observed time.Time) operational.AuditEvent {
	outcome := "success"
	if name == "token.revoke_failed" {
		outcome = "failure"
	}
	repositories, _ := json.Marshal(v.Repositories)
	attrs := map[string]string{
		"hashed_token": v.HashedToken, "installation_id": strconv.FormatInt(v.InstallationID, 10),
		"expires_at": v.ExpiresAt.UTC().Format(time.RFC3339Nano), "observed_at": observed.UTC().Format(time.RFC3339Nano),
		"recovered": strconv.FormatBool(v.Recovered), "repositories": string(repositories),
	}
	if v.Repository != "" {
		attrs["repository"] = v.Repository
	}
	if v.CommandID != 0 {
		attrs["command_id"] = strconv.FormatInt(v.CommandID, 10)
	}
	if name == "token.revoked" {
		// GitHub's revoke API treats an already-invalid token as success.
		attrs["confirmation"] = "revoke_api_accepted_or_already_invalid"
	}
	return operational.AuditEvent{Event: name, Outcome: outcome, Actor: v.Actor, Attributes: attrs}
}

// flush commits a terminal receipt and any retained first-failure observation
// together. Live-token journals are never mutated by this audit-only path.
func (r *Revocations) flush(ctx context.Context, entry *ownedToken) error {
	if !entry.revoked {
		return nil
	}
	transition, ok := r.queue.(operational.RevocationTransitions)
	if !ok {
		return errors.New("scoped token cleanup requires atomic audit transitions")
	}
	var events []operational.AuditEvent
	if !entry.record.FailureAt.IsZero() {
		events = append(events, entry.record.event("token.revoke_failed", entry.record.FailureAt))
	}
	events = append(events, entry.record.event(entry.record.Completion, entry.record.CompletedAt))
	changed, err := transition.TransitionRevocation(ctx, entry.record.HashedToken, entry.version, "", r.namespace, events)
	if err != nil {
		return errors.New("audit scoped token cleanup failed")
	}
	if !changed {
		return operational.ErrConflict
	}
	entry.version = ""
	return nil
}
