package memory

import (
	"context"
	"strings"
	"time"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

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
	if _, exists := s.markers[recordKey{"delivery", id, ""}]; exists {
		return operational.DeliveryAlreadyCommitted, nil
	}
	key := recordKey{"delivery-reservation", id, ""}
	if _, exists := s.markers[key]; exists {
		return operational.DeliveryInProgress, nil
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
