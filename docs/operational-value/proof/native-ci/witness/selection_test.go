package witness

import "testing"

func FuzzParseInputDefinition(f *testing.F) {
	f.Add("one")
	f.Fuzz(func(t *testing.T, value string) {})
}

func FuzzParseInputDefinitions(f *testing.F) {
	f.Add("many")
	f.Fuzz(func(t *testing.T, value string) {})
}
