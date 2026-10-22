package cli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

func TestNativeCampaignAddMatchesProductionContract(t *testing.T) {
	node, repository := nodeRuntime(t)
	for _, existing := range []bool{false, true} {
		t.Run(strconv.FormatBool(existing), func(t *testing.T) {
			directory := t.TempDir()
			legacy := filepath.Join(directory, "legacy")
			native := filepath.Join(directory, "native")
			for _, root := range []string{legacy, native} {
				writeTestFile(t, filepath.Join(root, "demo", "cao.json"), testCampaignDeclaration)
				if existing {
					writeTestFile(t, filepath.Join(root, policyPath), `{"version":1,"control-plane":{
"scope":{"allowed-owners":["acme"]},"defaults":{"mode":"live"},"campaigns":{
"demo":{"mode":"review","enabled":false,"workers":{"second":{"workflow":"old","enabled":false,"max-mode":"review"},"stale":{"workflow":"stale"}}},
"other":{"mode":"review"}}}}`)
				}
			}
			program := `
const { addCaoCampaign } = await import(process.argv[1]);
process.chdir(process.argv[2]);
const result = await addCaoCampaign("githubnext/gh-cao/demo@feature/config", ["--force"], {
  execute(command, args) {
    if (command === "gh" && args.join(" ") === "aw version")
      return {status:0, stdout:"", stderr:"gh-aw v0.92.4"};
    if (command === "gh" && args[0] === "repo")
      return {status:0, stdout:"acme/control\n", stderr:""};
    return {status:0, stdout:"", stderr:""};
  }
});
process.stdout.write(JSON.stringify(result));
`
			baseline, err := exec.Command(node, "--input-type=module", "-e", program,
				filepath.Join(repository, "activity", "cli", "campaigns.mjs"), legacy).CombinedOutput()
			if err != nil {
				t.Fatalf("production add: %v: %s", err, baseline)
			}
			t.Chdir(native)
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
			if got, want := decode(stdout.Bytes()), decode(baseline); !reflect.DeepEqual(got, want) {
				t.Fatalf("add output = %v, want production output %v", got, want)
			}
			read := func(root string) any {
				t.Helper()
				content, err := os.ReadFile(filepath.Join(root, policyPath))
				if err != nil {
					t.Fatal(err)
				}
				return decode(content)
			}
			if got, want := read(native), read(legacy); !reflect.DeepEqual(got, want) {
				t.Fatalf("add policy = %v, want production policy %v", got, want)
			}
		})
	}
}
