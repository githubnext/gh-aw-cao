// cao-cli-quota bridges a local CLI queue to the shared GitHub quota service.
// Its stdin/stdout protocol contains only scheduling metadata, never credentials.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/githubquota"
	"github.com/githubnext/gh-aw-cao/server/internal/operational/memory"
)

type request struct {
	ID                int      `json:"id"`
	Operation         string   `json:"operation"`
	ReservationID     string   `json:"reservationId"`
	MaxConcurrency    int      `json:"maxConcurrency"`
	EstimatedCost     int      `json:"estimatedCost"`
	MinimumRemaining  int      `json:"minimumRemaining"`
	Running           int      `json:"running"`
	Resources         []string `json:"resources,omitempty"`
	RateLimited       bool     `json:"rateLimited"`
	RetryAfterSeconds int      `json:"retryAfterSeconds"`
}

type decision struct {
	ID            int    `json:"id"`
	Capacity      int    `json:"capacity"`
	Reason        string `json:"reason"`
	RetryAt       string `json:"retryAt,omitempty"`
	ReservationID string `json:"reservationId,omitempty"`
}

type meter struct {
	Limit     *int  `json:"limit"`
	Remaining *int  `json:"remaining"`
	Reset     int64 `json:"reset"`
}

type snapshot struct {
	identity     string
	observations map[string]githubquota.Observation
}

type reservation struct {
	buckets  []githubquota.Reservation
	finished bool
}

type bridge struct {
	service      *githubquota.Service
	read         func(context.Context, []string) (snapshot, error)
	reservations map[string]*reservation
	now          func() time.Time
	parkedUntil  time.Time
}

func newBridge(service *githubquota.Service, read func(context.Context, []string) (snapshot, error)) *bridge {
	return &bridge{service: service, read: read, reservations: make(map[string]*reservation), now: time.Now}
}

// The synthetic App key is a namespace for a non-App gh credential context.
// Installation=1 is a fixed namespace discriminator, not a claimed installation.
func bucket(identity, resource string) githubquota.BucketID {
	return githubquota.BucketID{App: identity, Installation: 1, Resource: resource}
}

func (b *bridge) unknown(id int) decision {
	return decision{ID: id, Reason: "unknown", RetryAt: b.now().Add(15 * time.Second).UTC().Format(time.RFC3339)}
}

func (b *bridge) handle(ctx context.Context, req request) decision {
	if req.Operation == "release" {
		if held := b.reservations[req.ReservationID]; held != nil {
			for _, r := range held.buckets {
				if err := b.service.Release(ctx, r); err != nil {
					return b.unknown(req.ID)
				}
			}
			delete(b.reservations, req.ReservationID)
		}
		return decision{ID: req.ID, Reason: "available"}
	}
	if req.Operation != "admit" && req.Operation != "complete" && req.Operation != "status" {
		return b.unknown(req.ID)
	}
	resources, err := requiredResources(req.Resources)
	if err != nil {
		return b.unknown(req.ID)
	}
	if req.Operation == "complete" {
		if held := b.reservations[req.ReservationID]; held != nil {
			held.finished = true
			resources = nil
			for _, r := range held.buckets {
				resources = append(resources, r.Bucket.Resource)
			}
		}
		if req.RateLimited {
			wait := max(req.RetryAfterSeconds, 60)
			wait = min(wait, 86400)
			b.parkedUntil = maxTime(b.parkedUntil, b.now().Add(time.Duration(wait)*time.Second))
			// Park every known meter: command output does not identify which
			// resource incurred a secondary limit.
			for _, held := range b.reservations {
				for _, r := range held.buckets {
					if err := b.service.Park(ctx, r.Bucket, b.parkedUntil, githubquota.ParkReasonSecondaryRateLimit); err != nil {
						return b.unknown(req.ID)
					}
				}
			}
		}
	}
	if b.parkedUntil.After(b.now()) {
		return decision{ID: req.ID, Reason: "parked", RetryAt: b.parkedUntil.UTC().Format(time.RFC3339)}
	}
	current, err := b.read(ctx, resources)
	if err != nil {
		return b.unknown(req.ID)
	}
	for _, resource := range resources {
		observation, ok := current.observations[resource]
		if !ok || observation.ResetAt.Before(b.now()) || observation.Limit <= 0 {
			return b.unknown(req.ID)
		}
		if err := b.service.Observe(ctx, bucket(current.identity, resource), observation); err != nil {
			return b.unknown(req.ID)
		}
	}
	// Never infer command cost. Only a fresh GitHub observation reconciles
	// completed work; a failed refresh leaves its reservation held.
	for id, held := range b.reservations {
		done := true
		for _, r := range held.buckets {
			if held.finished && r.Bucket.App == current.identity {
				observation, ok := current.observations[r.Bucket.Resource]
				if !ok {
					done = false
					continue
				}
				if err := b.service.Commit(ctx, r, observation); err != nil {
					return b.unknown(req.ID)
				}
			} else if r.ExpiresAt.After(b.now()) {
				done = false
			}
		}
		if done {
			delete(b.reservations, id)
		}
	}
	concurrency, cost, floor := req.MaxConcurrency, req.EstimatedCost, req.MinimumRemaining
	if concurrency <= 0 {
		concurrency = 4
	}
	if cost <= 0 {
		cost = 50
	}
	if floor <= 0 {
		floor = 100
	}
	active := 0
	for _, held := range b.reservations {
		if !held.finished {
			active++
		}
	}
	available := concurrency
	var retry time.Time
	for _, resource := range resources {
		state, stateErr := b.service.State(ctx, bucket(current.identity, resource))
		if stateErr != nil || state.Status == githubquota.StatusUnknown {
			return b.unknown(req.ID)
		}
		if state.Status == githubquota.StatusParked {
			return decision{ID: req.ID, Reason: "parked", RetryAt: state.ParkedUntil.UTC().Format(time.RFC3339)}
		}
		available = min(available, max(0, (state.Available-floor)/cost))
		retry = maxTime(retry, state.ResetAt)
	}
	if available == 0 {
		return decision{ID: req.ID, Reason: "exhausted", RetryAt: retry.UTC().Format(time.RFC3339)}
	}
	result := decision{ID: req.ID, Capacity: min(concurrency, active+available), Reason: "available"}
	if req.Operation != "admit" {
		return result
	}
	if max(active, req.Running) >= result.Capacity {
		result.Reason = "concurrency"
		return result
	}
	var held []githubquota.Reservation
	for _, resource := range resources {
		r, reserveErr := b.service.Reserve(ctx, bucket(current.identity, resource), githubquota.ReservationRequest{
			EstimatedCost: cost, MinimumRemain: floor, TTL: 20 * time.Minute,
		})
		if reserveErr != nil {
			for _, previous := range held {
				_ = b.service.Release(ctx, previous)
			}
			return b.unknown(req.ID)
		}
		held = append(held, r)
	}
	result.ReservationID = held[0].ID
	b.reservations[result.ReservationID] = &reservation{buckets: held}
	return result
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

type commandRunner func(context.Context, string, ...string) ([]byte, error)

func requiredResources(resources []string) ([]string, error) {
	if len(resources) == 0 {
		return []string{"core", "graphql"}, nil
	}
	seen := make(map[string]bool)
	for _, resource := range resources {
		if (resource != "core" && resource != "graphql") || seen[resource] {
			return nil, errors.New("invalid GitHub quota resource set")
		}
		seen[resource] = true
	}
	return resources, nil
}

func ghSnapshot(ctx context.Context, run commandRunner, executable, host string, required ...string) (snapshot, error) {
	resources, err := requiredResources(required)
	if err != nil {
		return snapshot{}, err
	}
	user, err := run(ctx, executable, "api", "--hostname", host, "user", "--jq", ".id")
	if err != nil {
		return snapshot{}, errors.New("GitHub credential identity is unavailable")
	}
	var userID int64
	if err := json.Unmarshal(bytes.TrimSpace(user), &userID); err != nil || userID <= 0 {
		return snapshot{}, errors.New("GitHub credential identity is invalid")
	}
	data, err := run(ctx, executable, "api", "--hostname", host, "rate_limit")
	if err != nil {
		return snapshot{}, errors.New("GitHub quota observation is unavailable")
	}
	var payload struct {
		Resources map[string]meter `json:"resources"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return snapshot{}, errors.New("GitHub quota observation is invalid")
	}
	sum := sha256.Sum256(fmt.Appendf(nil, "%s:%d", strings.ToLower(host), userID))
	result := snapshot{identity: "gh-" + hex.EncodeToString(sum[:24]), observations: make(map[string]githubquota.Observation)}
	for _, resource := range resources {
		m, ok := payload.Resources[resource]
		if !ok || m.Limit == nil || m.Remaining == nil || *m.Limit <= 0 || *m.Remaining < 0 || *m.Remaining > *m.Limit || m.Reset <= 0 {
			return snapshot{}, errors.New("GitHub quota observation is incomplete")
		}
		result.observations[resource] = githubquota.Observation{
			Limit: *m.Limit, Remaining: *m.Remaining, ResetAt: time.Unix(m.Reset, 0).UTC(),
		}
	}
	return result, nil
}

func serve(input io.Reader, output io.Writer, b *bridge) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	encoder := json.NewEncoder(output)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			if err := encoder.Encode(b.unknown(0)); err != nil {
				return err
			}
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		result := b.handle(ctx, req)
		cancel()
		if err := encoder.Encode(result); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func run() error {
	store, err := memory.New(memory.Config{})
	if err != nil {
		return err
	}
	defer func() { _ = store.Close() }()
	service, err := githubquota.New(store, githubquota.Options{})
	if err != nil {
		return err
	}
	host := os.Getenv("GH_HOST")
	if host == "" {
		host = "github.com"
	}
	executable := os.Getenv("CAO_CLI_QUOTA_GH_EXECUTABLE")
	if executable == "" {
		executable = "gh"
	}
	execute := func(ctx context.Context, name string, args ...string) ([]byte, error) {
		// Output and errors are deliberately never forwarded to logs or JSONL.
		cmd := exec.CommandContext(ctx, name, args...) //nolint:gosec // Executable is local operator configuration; arguments are fixed API reads.
		cmd.Dir = os.Getenv("CAO_CLI_QUOTA_WORKING_DIRECTORY")
		return cmd.Output()
	}
	b := newBridge(service, func(ctx context.Context, resources []string) (snapshot, error) {
		return ghSnapshot(ctx, execute, executable, host, resources...)
	})
	return serve(os.Stdin, os.Stdout, b)
}

func main() {
	if err := run(); err != nil {
		os.Exit(1)
	}
}
