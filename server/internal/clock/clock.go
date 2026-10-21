// Package clock supplies service time independently of wall-clock I/O deadlines.
package clock

import "time"

type Provider interface {
	Now() time.Time
}

// Now preserves wall-clock behavior unless a service explicitly supplies time.
func Now(provider Provider) time.Time {
	if provider != nil {
		return provider.Now().UTC()
	}
	return time.Now().UTC()
}
