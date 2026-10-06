package memory

import (
	"context"
	"math"
	"regexp"
	"strconv"
	"time"
)

var counterNames = [...]string{
	"webhookReceived", "webhookDuplicate", "webhookAdmissionFailed",
	"taskQueued", "taskCoalesced", "collectionSucceeded", "collectionFailed",
	"collectionRetried", "collectionDeadLettered",
}

var loadPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

type load struct {
	amount float64
	at     time.Time
}

func decayed(l load, now time.Time, halfLife time.Duration) float64 {
	if l.at.IsZero() || !l.at.Add(8*time.Minute).After(now) {
		return 0
	}
	return l.amount * math.Pow(0.5, math.Max(0, now.Sub(l.at).Seconds())/halfLife.Seconds())
}

func (s *Store) Ping(ctx context.Context) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	s.mu.Unlock()
	return nil
}

func (s *Store) diagnosticSpace() error {
	if s.healthRevision == math.MaxUint64 {
		return capacity()
	}
	return s.reserve(map[recordKey]int64{{"diagnostics", "", ""}: 2048})
}

func (s *Store) IncrementIngestionCounter(ctx context.Context, name string) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	index := -1
	for i, n := range counterNames {
		if n == name {
			index = i
			break
		}
	}
	if index < 0 {
		return invalid("unknown ingestion counter")
	}
	if s.counters[index] == math.MaxInt64 {
		return capacity()
	}
	if err := s.diagnosticSpace(); err != nil {
		return err
	}
	s.counters[index]++
	s.healthRevision++
	loadIndex := -1
	switch name {
	case "webhookReceived":
		loadIndex = 0
	case "collectionSucceeded":
		loadIndex = 1
	case "collectionFailed":
		loadIndex = 2
	}
	if loadIndex >= 0 {
		now := s.config.Clock()
		s.loads[loadIndex] = load{amount: decayed(s.loads[loadIndex], now, time.Minute) + 1, at: now}
	}
	return nil
}

func (s *Store) RecordIngestionHealthEvent(ctx context.Context, event, code string, at time.Time) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	index := -1
	switch event {
	case "failure":
		if code == "admission" || code == "collection" || code == "redis" {
			index = 0
		}
	case "success":
		if code == "" {
			index = 2
		}
	case "webhook":
		if code == "" {
			index = 3
		}
	}
	if index < 0 || at.IsZero() {
		return invalid("invalid ingestion event, code, or time")
	}
	if err := s.diagnosticSpace(); err != nil {
		return err
	}
	s.events[index] = at.UTC().Format(time.RFC3339Nano)
	if index == 0 {
		s.events[1] = code
	}
	s.healthRevision++
	return nil
}

func (s *Store) IngestionHealth(ctx context.Context) (map[string]int64, map[string]string, error) {
	if err := s.enter(ctx); err != nil {
		return nil, nil, err
	}
	defer s.mu.Unlock()
	counters := make(map[string]int64)
	for i, name := range counterNames {
		if s.counters[i] != 0 {
			counters[name] = s.counters[i]
		}
	}
	events := make(map[string]string)
	for i, name := range []string{"lastFailureAt", "lastFailureCode", "lastSuccessAt", "lastWebhookAt"} {
		if s.events[i] != "" {
			events[name] = s.events[i]
		}
	}
	if s.healthRevision != 0 {
		events["healthRevision"] = strconv.FormatUint(s.healthRevision, 10)
	}
	return counters, events, nil
}

func (s *Store) Loads(ctx context.Context, names []string, halfLife time.Duration) (map[string]float64, error) {
	if err := s.enter(ctx); err != nil {
		return nil, err
	}
	defer s.mu.Unlock()
	if len(names) == 0 || len(names) > 16 || halfLife < time.Second || halfLife > 24*time.Hour {
		return nil, invalid("invalid load names or half-life")
	}
	for _, name := range names {
		if !loadPattern.MatchString(name) {
			return nil, invalid("invalid load name")
		}
	}
	now := s.config.Clock()
	result := make(map[string]float64, len(names))
	for _, name := range names {
		index := -1
		switch name {
		case "webhook":
			index = 0
		case "collection":
			index = 1
		case "failure":
			index = 2
		}
		if index >= 0 {
			result[name] = decayed(s.loads[index], now, halfLife)
		} else {
			result[name] = 0
		}
	}
	return result, nil
}
