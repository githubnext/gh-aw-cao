package collect

import (
	"testing"
)

func TestParseEventClassifiesDeliveries(t *testing.T) {
	cases := []struct {
		name       string
		event      string
		payload    string
		wantKind   IntentKind
		wantRepo   string
		wantRepos  int
		wantInstal int64
	}{
		{
			name:  "completed workflow run",
			event: "workflow_run",
			payload: `{"action":"completed","installation":{"id":42},
				"repository":{"full_name":"octo/api"},
				"workflow_run":{"status":"completed","conclusion":"success"}}`,
			wantKind: IntentCollect, wantRepo: "octo/api", wantInstal: 42,
		},
		{
			name:     "in-progress workflow run is ignored",
			event:    "workflow_run",
			payload:  `{"action":"in_progress","repository":{"full_name":"octo/api"}}`,
			wantKind: IntentIgnore,
		},
		{
			name:  "installation created enrolls repositories",
			event: "installation",
			payload: `{"action":"created","installation":{"id":7},
				"repositories":[{"full_name":"octo/api"},{"full_name":"octo/web"}]}`,
			wantKind: IntentEnroll, wantRepos: 2, wantInstal: 7,
		},
		{
			name:     "installation deleted removes the installation",
			event:    "installation",
			payload:  `{"action":"deleted","installation":{"id":7}}`,
			wantKind: IntentRemoveInstallation, wantInstal: 7,
		},
		{
			name:  "repositories removed unenrolls",
			event: "installation_repositories",
			payload: `{"action":"removed","installation":{"id":7},
				"repositories_removed":[{"full_name":"octo/web"}]}`,
			wantKind: IntentUnenroll, wantRepos: 1, wantInstal: 7,
		},
		{
			name:     "unrelated events are ignored",
			event:    "push",
			payload:  `{"repository":{"full_name":"octo/api"}}`,
			wantKind: IntentIgnore,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			intent, err := ParseEvent(testCase.event, []byte(testCase.payload))
			if err != nil {
				t.Fatal(err)
			}
			if intent.Kind != testCase.wantKind {
				t.Fatalf("kind = %q, want %q", intent.Kind, testCase.wantKind)
			}
			if intent.Repository != testCase.wantRepo {
				t.Fatalf("repository = %q, want %q", intent.Repository, testCase.wantRepo)
			}
			if len(intent.Repositories) != testCase.wantRepos {
				t.Fatalf("repositories = %d, want %d", len(intent.Repositories), testCase.wantRepos)
			}
			if intent.InstallationID != testCase.wantInstal {
				t.Fatalf("installation = %d, want %d", intent.InstallationID, testCase.wantInstal)
			}
		})
	}
}

func TestParseEventFailsClosedOnUnusablePayload(t *testing.T) {
	if _, err := ParseEvent("workflow_run", []byte("not json")); err == nil {
		t.Fatal("expected a parse failure")
	}
	if _, err := ParseEvent("workflow_run", []byte(`{"action":"completed"}`)); err == nil {
		t.Fatal("expected a missing-repository failure")
	}
}

func TestNormalizeRepositoryRejectsUnsafeReferences(t *testing.T) {
	valid := []struct{ input, want string }{
		{"octo/api", "octo/api"},
		{" Octo/Api ", "octo/api"},
	}
	for _, testCase := range valid {
		input, want := testCase.input, testCase.want
		got, err := NormalizeRepository(input)
		if err != nil {
			t.Fatalf("%q: %v", input, err)
		}
		if got != want {
			t.Fatalf("%q normalized to %q, want %q", input, got, want)
		}
	}
	invalid := []string{"", "octo", "octo/api/extra", "../etc", "octo/../api", "octo/a pi", "-octo/api"}
	for _, input := range invalid {
		if _, err := NormalizeRepository(input); err == nil {
			t.Fatalf("expected %q to be rejected", input)
		}
	}
}
