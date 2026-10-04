package redisx

import "errors"

func (s *Store) EffectiveMaxMemoryBytes(providerMaximum int64) (int64, error) {
	if providerMaximum < 0 {
		return 0, errors.New("redis provider memory limit cannot be negative")
	}
	budget := s.MaxMemoryBytes()
	if providerMaximum > 0 {
		// Compute floor(80%) without overflowing int64 or rounding byte counts.
		budget = min(budget, providerMaximum/5*4+providerMaximum%5*4/5)
	}
	if budget <= 0 {
		return 0, errors.New("redis effective memory budget must be positive")
	}
	return budget, nil
}
