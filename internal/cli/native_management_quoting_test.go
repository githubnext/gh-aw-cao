package cli

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestNativeManagementReleaseQueryQuotesRevision(t *testing.T) {
	for _, test := range []struct{ name, revision string }{
		{"commit", strings.Repeat("a", 40)},
		{"quotes", `a") | .name, "injected`},
		{"backslashes and jq interpolation", `a\(.name)\"`},
		{"control characters", "a\n\r\t\x00"},
		{"HTML and JSON", `a"><script>alert("tag")</script>{"sha":"other"}`},
		{"Unicode", "a\u2028\u2029\u00e9"},
	} {
		t.Run(test.name, func(t *testing.T) {
			nativeManagementDirectory(t)
			filename := ".github/aw/packages/one.json"
			record := nativePackageRecord{
				name: catalogRepository + "/one", source: catalogRepository + "/one@" + strings.Repeat("a", 40),
				revision: test.revision, filename: filename,
				document: map[string]any{"source": "original"},
			}
			writeTestFile(t, filename, `{"source":"original"}`)
			calls := 0
			gh := func(_ context.Context, args ...string) (string, string, error) {
				calls++
				switch calls {
				case 1:
					if len(args) != 5 || !reflect.DeepEqual(args[:4], []string{"api", "--paginate", "/repos/" + catalogRepository + "/tags", "--jq"}) {
						t.Fatalf("unexpected tag request: %q", args)
					}
					filter := args[len(args)-1]
					literal, ok := strings.CutPrefix(filter, `.[] | select(.commit.sha == `)
					if !ok {
						t.Fatalf("unexpected jq filter: %q", filter)
					}
					literal, ok = strings.CutSuffix(literal, `) | .name`)
					if !ok {
						t.Fatalf("unexpected jq filter: %q", filter)
					}
					var revision string
					if err := json.Unmarshal([]byte(literal), &revision); err != nil || revision != test.revision {
						t.Fatalf("jq revision was not one intact JSON string: %q: %v", literal, err)
					}
				case 2:
					if !reflect.DeepEqual(args, []string{"api", "/repos/" + catalogRepository + "/releases/tags/v1.2.3", "--jq", "select(.draft == false and .prerelease == false) | .tag_name"}) {
						t.Fatalf("unexpected release request: %q", args)
					}
				default:
					t.Fatalf("unexpected GitHub request: %q", args)
				}
				return "v1.2.3", "", nil
			}
			prepared, err := nativePrepareRelease(context.Background(), gh, record, nativeUpdateOptions{}, map[string]string{})
			if err != nil {
				t.Fatal(err)
			}
			if calls != 2 {
				t.Fatalf("expected tag and release requests, got %d", calls)
			}
			data, err := os.ReadFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			var document map[string]any
			if err := json.Unmarshal(data, &document); err != nil || document["source"] != record.name+"@v1.2.3" {
				t.Fatalf("unexpected prepared record: %s: %v", data, err)
			}
			if err := nativeRestorePackage(prepared); err != nil {
				t.Fatal(err)
			}
		})
	}
}
