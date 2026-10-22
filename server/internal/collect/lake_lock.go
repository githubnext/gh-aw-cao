package collect

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// lockEvidence serializes shared-shard read/replace and manifest publication
// with erasure across processes sharing a lake. Repository leases alone do not
// protect observations from other repositories in the same file.
func (l Lake) lockEvidence(ctx context.Context) (func(), error) {
	if err := l.Validate(); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(l.Directory, ".evidence.lock"), os.O_CREATE|os.O_RDWR, 0o600) // #nosec G304 -- configured evidence lake.
	if err != nil {
		return nil, err
	}
	for {
		if err := ctx.Err(); err != nil {
			_ = file.Close()
			return nil, err
		}
		locked, err := tryLockEvidence(file)
		if err != nil {
			_ = file.Close()
			return nil, fmt.Errorf("lock evidence lake: %w", err)
		}
		if locked {
			return func() { _ = file.Close() }, nil
		}
		sleep(ctx, 20*time.Millisecond)
	}
}
