package postgresx

import "testing"

func TestRuntimeSourceClassificationUsesServerRegistry(t *testing.T) {
	for name, table := range entityTables {
		if got := IsRuntimeSource(name); got != table.runtime {
			t.Fatalf("source %q: runtime=%t, want %t", name, got, table.runtime)
		}
	}
	for _, name := range []string{"unknown", "$notRegistered", "$transactions", ""} {
		if IsRuntimeSource(name) {
			t.Fatalf("unregistered runtime source %q was admitted", name)
		}
	}
}
