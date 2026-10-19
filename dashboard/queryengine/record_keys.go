package queryengine

import (
	"cmp"
	"slices"
	"unicode/utf16"
)

// ValidRecordKey accepts the JSON representation of an IndexedDB record key.
func ValidRecordKey(value any) bool {
	switch key := value.(type) {
	case float64:
		return engineFinite(key)
	case string:
		return true
	case []any:
		for _, part := range key {
			if !ValidRecordKey(part) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// CompareRecordKeys preserves IndexedDB's numeric, UTF-16 string and compound
// key ordering. Both operands must first pass ValidRecordKey.
func CompareRecordKeys(left, right any) int {
	rank := func(key any) int {
		switch key.(type) {
		case float64:
			return 1
		case string:
			return 3
		default:
			return 4
		}
	}
	if difference := rank(left) - rank(right); difference != 0 {
		return difference
	}
	switch left := left.(type) {
	case float64:
		return cmp.Compare(left, right.(float64))
	case string:
		return slices.Compare(utf16.Encode([]rune(left)), utf16.Encode([]rune(right.(string))))
	default:
		return slices.CompareFunc(left.([]any), right.([]any), CompareRecordKeys)
	}
}
