package model

import "strings"

// EncodeCoordinate matches JavaScript encodeURIComponent for canonical IDs.
func EncodeCoordinate(value string) string {
	const hexDigits = "0123456789ABCDEF"
	var result strings.Builder
	for _, value := range []byte(value) {
		if value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || strings.ContainsRune("-_.!~*'()", rune(value)) {
			result.WriteByte(value)
		} else {
			result.WriteByte('%')
			result.WriteByte(hexDigits[value>>4])
			result.WriteByte(hexDigits[value&15])
		}
	}
	return result.String()
}
