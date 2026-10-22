package inputlimits

import (
	"strconv"
	"strings"
	"testing"
)

func TestByteLimits(t *testing.T) {
	for _, test := range []struct {
		limit ByteLimit
		bytes int64
	}{
		{RepositoryMemoryManifest, 2 * 1024 * 1024},
		{MarketplaceJSON, 512 * 1024},
		{MarketplaceTreeJSON, 8 * 1024 * 1024},
	} {
		t.Run(string(test.limit), func(t *testing.T) {
			t.Run("default", func(t *testing.T) {
				got, err := test.limit.Resolve(func(string) (string, bool) { return "", false })
				if err != nil || got != test.bytes {
					t.Fatalf("bytes=%d, err=%v, want %d", got, err, test.bytes)
				}
			})
			for _, value := range []int64{1, 64, test.bytes + 1} {
				t.Run(strconv.FormatInt(value, 10), func(t *testing.T) {
					got, err := test.limit.Resolve(func(name string) (string, bool) {
						if name != string(test.limit) {
							t.Fatalf("looked up %q, want %q", name, test.limit)
						}
						return strconv.FormatInt(value, 10), true
					})
					if err != nil || got != value {
						t.Fatalf("bytes=%d, err=%v, want %d", got, err, value)
					}
				})
			}
			for _, raw := range []string{"", "0", "-1", "1.5", "2MiB", "invalid", " 64 ", "9223372036854775807", "9223372036854775808"} {
				t.Run("invalid="+raw, func(t *testing.T) {
					got, err := test.limit.Resolve(func(string) (string, bool) { return raw, true })
					if err == nil || got != 0 || !strings.Contains(err.Error(), string(test.limit)) {
						t.Fatalf("bytes=%d, err=%v, want explicit configuration error", got, err)
					}
				})
			}
		})
	}
}

func TestUnknownByteLimit(t *testing.T) {
	if _, err := ByteLimit("unknown").Resolve(func(string) (string, bool) { return "", false }); err == nil {
		t.Fatal("unknown limit was accepted")
	}
}
