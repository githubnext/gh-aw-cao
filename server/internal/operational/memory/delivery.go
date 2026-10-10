package memory

import (
	"context"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/logger"
	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

var deliveryLog = logger.New("cao:operational:memory:delivery")

// classifyDeliveryReservation decides ReserveDelivery's outcome from
// already-computed marker facts: whether the delivery is already permanently
// committed, and whether another reservation is currently in progress. It is
// a pure function extracted from ReserveDelivery so each precedence branch
// (committed takes priority over in-progress) is independently testable
// without constructing a *Store or touching its marker map.
func classifyDeliveryReservation(alreadyCommitted, reservationInProgress bool) operational.DeliveryReservation {
	switch {
	case alreadyCommitted:
		return operational.DeliveryAlreadyCommitted
	case reservationInProgress:
		return operational.DeliveryInProgress
	default:
		return operational.DeliveryReserved
	}
}

func (s *Store) ReserveDelivery(ctx context.Context, id string, ttl time.Duration) (operational.DeliveryReservation, error) {
	if err := s.enter(ctx); err != nil {
		return operational.DeliveryAlreadyCommitted, err
	}
	defer s.mu.Unlock()
	if err := s.name(id); err != nil {
		return operational.DeliveryAlreadyCommitted, err
	}
	if err := validTTL(ttl); err != nil {
		return operational.DeliveryAlreadyCommitted, err
	}
	now := s.config.Clock()
	s.prune(now)
	_, alreadyCommitted := s.markers[recordKey{"delivery", id, ""}]
	key := recordKey{"delivery-reservation", id, ""}
	_, reservationInProgress := s.markers[key]
	outcome := classifyDeliveryReservation(alreadyCommitted, reservationInProgress)
	deliveryLog.Printf("delivery reservation classified outcome=%d", outcome)
	if outcome != operational.DeliveryReserved {
		return outcome, nil
	}
	if err := s.reserve(map[recordKey]int64{key: charge(id)}); err != nil {
		return operational.DeliveryAlreadyCommitted, err
	}
	s.markers[recordKey{"delivery-reservation", strings.Clone(id), ""}] = now.Add(ttl)
	return operational.DeliveryReserved, nil
}

func (s *Store) ReleaseDeliveryReservation(ctx context.Context, id string) error {
	return s.forgetMarker(ctx, "delivery-reservation", id)
}

func (s *Store) RememberDelivery(ctx context.Context, id string, ttl time.Duration) (bool, error) {
	if err := s.enter(ctx); err != nil {
		return false, err
	}
	defer s.mu.Unlock()
	if err := s.name(id); err != nil {
		return false, err
	}
	if err := validTTL(ttl); err != nil {
		return false, err
	}
	now := s.config.Clock()
	s.prune(now)
	key := recordKey{"delivery", id, ""}
	if _, exists := s.markers[key]; exists {
		return false, nil
	}
	if err := s.reserve(map[recordKey]int64{key: charge(id)}); err != nil {
		return false, err
	}
	s.markers[recordKey{"delivery", strings.Clone(id), ""}] = now.Add(ttl)
	return true, nil
}

func (s *Store) ForgetDelivery(ctx context.Context, id string) error {
	return s.forgetMarker(ctx, "delivery", id)
}

func (s *Store) forgetMarker(ctx context.Context, kind, id string) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer s.mu.Unlock()
	if err := s.name(id); err != nil {
		return err
	}
	key := recordKey{kind, id, ""}
	delete(s.markers, key)
	s.drop(key)
	return nil
}
