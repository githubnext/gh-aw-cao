package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

func TestNativeCampaignAddMatchesProductionContract(t *testing.T) {
	// Frozen Node administration contract: retirement must not require Node
	// or import the removed activity/cli/campaigns.mjs implementation.
	for _, existing := range []bool{false, true} {
		t.Run(strconv.FormatBool(existing), func(t *testing.T) {
			directory := t.TempDir()
			native := filepath.Join(directory, "native")
			writeTestFile(t, filepath.Join(native, "demo", "cao.json"), testCampaignDeclaration)
			if existing {
				writeTestFile(t, filepath.Join(native, policyPath), `{"version":1,"control-plane":{
"scope":{"allowed-owners":["acme"]},"defaults":{"mode":"live"},"campaigns":{
"demo":{"mode":"review","enabled":false,"workers":{"second":{"workflow":"old","enabled":false,"max-mode":"review"},"stale":{"workflow":"stale"}}},
"other":{"mode":"review"}}}}`)
			}
			t.Chdir(native)
			t.Setenv("PATH", "")
			archive := campaignArchive(t, map[string]string{"catalog/demo/cao.json": testCampaignDeclaration})
			var calls [][]string
			root, stdout, _ := testCommand(t, campaignGH(t, archive, &calls), nil)
			root.SetArgs([]string{"add", "githubnext/gh-cao/demo@feature/config", "--force"})
			if err := root.Execute(); err != nil {
				t.Fatal(err)
			}
			decode := func(content []byte) any {
				t.Helper()
				var value any
				if err := json.Unmarshal(content, &value); err != nil {
					t.Fatal(err)
				}
				return value
			}
			baseline := []byte(`{"command":"add","campaign":"demo","orchestrator":"demo","workers":["second","first"],"policy":".github/workflows/cao.json"}`)
			if got, want := decode(stdout.Bytes()), decode(baseline); !reflect.DeepEqual(got, want) {
				t.Fatalf("add output = %v, want frozen output %v", got, want)
			}
			read := func(root string) any {
				t.Helper()
				content, err := os.ReadFile(filepath.Join(root, policyPath))
				if err != nil {
					t.Fatal(err)
				}
				return decode(content)
			}
			expected := `{"$schema":"https://raw.githubusercontent.com/githubnext/gh-cao/main/.github/workflows/shared/cao.schema.json","version":1,"gh-aw-version":"v0.92.4","control-plane":{"scope":{"allowed-owners":["acme"],"allowed-repositories":["acme/control"]},"marketplace":{"registries":[{"id":"official","name":"Official CAO catalog","repository":"githubnext/gh-cao","ref":"main","auth":{"type":"none"}},{"id":"agentics","name":"Agentics workflows","repository":"githubnext/agentics","path":"workflows","format":"workflows","ref":"main","auth":{"type":"none"}}]},"campaigns":{"demo":{"workers":{"second":{"workflow":"demo-second"},"first":{"workflow":"demo-first"}}}}}}`
			if existing {
				expected = `{"version":1,"control-plane":{"scope":{"allowed-owners":["acme"]},"defaults":{"mode":"live"},"campaigns":{"demo":{"mode":"review","enabled":false,"workers":{"second":{"workflow":"demo-second","enabled":false,"max-mode":"review"},"first":{"workflow":"demo-first"}}},"other":{"mode":"review"}}}}`
			}
			if got, want := read(native), decode([]byte(expected)); !reflect.DeepEqual(got, want) {
				t.Fatalf("add policy = %v, want frozen policy %v", got, want)
			}
			if want := []string{"aw", "add", "githubnext/gh-cao/demo@feature/config", "--force"}; !reflect.DeepEqual(calls[0], want) {
				t.Fatalf("catalog campaign did not resolve to gh-aw source: %q", calls)
			}
		})
	}
}
