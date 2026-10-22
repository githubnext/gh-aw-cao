package inputlimits

import (
	"fmt"
	"strconv"
)

type ByteLimit string

const (
	RepositoryMemoryManifest ByteLimit = "CAO_REPOSITORY_MEMORY_MANIFEST_MAX_BYTES"
	MarketplaceJSON          ByteLimit = "CAO_MARKETPLACE_JSON_MAX_BYTES"
	MarketplaceTreeJSON      ByteLimit = "CAO_MARKETPLACE_TREE_JSON_MAX_BYTES"

	DefaultRepositoryMemoryManifestBytes = 2 * 1024 * 1024
	DefaultMarketplaceJSONBytes          = 512 * 1024
	DefaultMarketplaceTreeJSONBytes      = 8 * 1024 * 1024
)

func (limit ByteLimit) Resolve(lookup func(string) (string, bool)) (int64, error) {
	var defaultBytes int64
	switch limit {
	case RepositoryMemoryManifest:
		defaultBytes = DefaultRepositoryMemoryManifestBytes
	case MarketplaceJSON:
		defaultBytes = DefaultMarketplaceJSONBytes
	case MarketplaceTreeJSON:
		defaultBytes = DefaultMarketplaceTreeJSONBytes
	default:
		return 0, fmt.Errorf("unknown input byte limit")
	}
	raw, set := lookup(string(limit))
	if !set {
		return defaultBytes, nil
	}
	value, err := strconv.ParseInt(raw, 10, strconv.IntSize)
	// Leave room for the extra byte used to detect oversized input.
	if err != nil || value <= 0 || value == int64(^uint(0)>>1) {
		return 0, fmt.Errorf("%s must be a positive byte count below the platform integer maximum", limit)
	}
	return value, nil
}
