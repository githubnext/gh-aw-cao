package webhookgateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"
)

func TestCompilerRepositorySelectors(t *testing.T) {
	for _, selectors := range [][]string{
		{}, {"*/*"}, {"*/repo"}, {"foo/ba*"}, {"foo/*/nested"}, {"https://github.com/foo/repo"},
		{"foo/repo?query"}, {"${{ github.repository }}"}, {"!foo/repo"}, {"FOO/repo"},
		{"foo/repo", "foo/repo"}, {"foo/z", "bar/repo"}, {"../repo"}, {"foo/.."},
	} {
		trigger := CompilerTrigger{SchemaVersion: 2, Event: "dependabot_alert", Repos: selectors}
		if validateCompilerRepos(trigger, DefaultLimits()) == nil {
			t.Fatalf("invalid selector list accepted: %v", selectors)
		}
	}
	trigger := CompilerTrigger{SchemaVersion: 2, Event: "dependabot_alert", Repos: []string{"bar/baz", "foo/*"}}
	for repository, want := range map[string]bool{
		"bar/baz": true, "Bar/Baz": true, "foo/one": true, "foo/two": true,
		"bar/other": false, "foobar/one": false, "foo/one/nested": false, "different/repo": false,
	} {
		if got := CompilerRepositoryMatches(trigger, repository); got != want {
			t.Fatalf("repository %q matched=%v want=%v", repository, got, want)
		}
	}
	for _, event := range []string{"projects_v2_item", "secret_scanning_alert"} {
		trigger.Event = event
		if validateCompilerRepos(trigger, DefaultLimits()) == nil {
			t.Fatal("repository selectors accepted for unsupported event", event)
		}
	}
}

func TestCompilerSelectedSourceProjectionAndBatchValidation(t *testing.T) {
	base, registry := multiRepositoryRegistry(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, subscription := range policy.Subscriptions {
		if subscription.Source.Event != "dependabot_alert" {
			continue
		}
		repository := map[int64]string{21: "bar/baz", 22: "foo/one", 23: "foo/two"}[subscription.Source.RepositoryID]
		jobs := compilerSecurityJobs(t, policy, subscription, repository, "one", "two")
		payload, err := BuildDispatchBatch(jobs)
		if err != nil || CompilerBatchRepository(subscription, payload, repository) != nil ||
			CompilerBatchRepository(subscription, payload, "approved/exact") == nil {
			t.Fatal("source/destination URL binding failed", err)
		}
		unselected := bytes.ReplaceAll(payload, []byte(repository), []byte("foobar/one"))
		if ValidateBatchDispatchPayload(subscription, unselected, DefaultLimits()) == nil {
			t.Fatal("out-of-selector URL accepted in batch")
		}
		mixed := bytes.Replace(payload, []byte(repository), []byte("foo/other"), 1)
		if CompilerBatchRepository(subscription, mixed, repository) == nil {
			t.Fatal("independently selected source identities mixed in one batch")
		}
		body := fmt.Sprintf(`{"action":"created","installation":{"id":%d},"organization":{"id":%d},
			"repository":{"id":%d,"private":true,"full_name":"foobar/one"},"alert":{"number":42,
			"url":"https://api.github.com/repos/foobar/one/dependabot/alerts/42",
			"security_advisory":{"severity":"critical"}}}`, subscription.Source.InstallationID,
			subscription.Source.OrganizationID, subscription.Source.RepositoryID)
		event, err := ParseEvent("outside", subscription.Source.Event, []byte(body), DefaultLimits())
		if err != nil {
			t.Fatal(err)
		}
		event.SourceID = CompilerSourceID
		if _, err := buildGatewayDispatchPayload(subscription, event, policy.Revisions[subscription.ID], DefaultLimits()); err == nil {
			t.Fatal("out-of-selector signed source projected")
		}
	}
}

func TestManifestRepositorySelectorsAreStrict(t *testing.T) {
	for _, repos := range []json.RawMessage{json.RawMessage(`null`), json.RawMessage(`[]`),
		json.RawMessage(`"foo/*"`), json.RawMessage(`["foo/*"]`)} {
		var document map[string]any
		lock := batchManifestFixture(t)
		if err := json.Unmarshal(lock[len("# gh-aw-manifest: "):bytes.IndexByte(lock, '\n')], &document); err != nil {
			t.Fatal(err)
		}
		trigger := document["webhook_subscriptions"].([]any)[1].(map[string]any)
		trigger["repos"] = repos
		data, err := json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		lock = append(append([]byte("# gh-aw-manifest: "), data...), []byte("\nname: test\n")...)
		parsed, err := ParseWorkflowManifest(lock, ".github/workflows/test.lock.yml", DefaultLimits())
		if string(repos) == `["foo/*"]` {
			if err != nil || !slices.Equal(parsed[1].Declaration.Repos, []string{"foo/*"}) {
				t.Fatal("valid manifest selector lost", err)
			}
		} else if err == nil {
			t.Fatal("invalid manifest selector type accepted", string(repos))
		}
	}
}

func multiRepositoryRegistry(t *testing.T) (PolicySnapshot, RegistrySnapshot) {
	t.Helper()
	base, registry := discoveryFixture(t)
	config := base.Policy.Discovery
	config.Repositories = append(config.Repositories,
		DiscoveryRepository{Repository: "bar/baz", RepositoryID: 21, ReceivingInstallationID: 30, DispatchInstallationID: 40},
		DiscoveryRepository{Repository: "foo/one", RepositoryID: 22, ReceivingInstallationID: 31, DispatchInstallationID: 41},
		DiscoveryRepository{Repository: "foo/two", RepositoryID: 23, ReceivingInstallationID: 31, DispatchInstallationID: 41},
		DiscoveryRepository{Repository: "unselected/repo", RepositoryID: 24, ReceivingInstallationID: 32, DispatchInstallationID: 42})
	base.AllowedOwners = []string{"approved", "bar", "foo", "unselected"}
	base.AllowedRepos = nil
	for i := range registry.Records[0].Workflows[0].Triggers {
		trigger := &registry.Records[0].Workflows[0].Triggers[i]
		if SecurityEventPermission(trigger.Event) != "" {
			trigger.Repos = []string{"bar/baz", "foo/*"}
		}
	}
	for i, repository := range []int64{21, 22, 23, 24} {
		registry.Records = append(registry.Records, RepositoryInventory{RepositoryID: repository,
			OwnerID: int64(100 + i), OwnerType: "Organization", Visibility: "private",
			CommitSHA: registry.Records[0].CommitSHA, CheckedAt: registry.Records[0].CheckedAt.Add(-time.Second),
			Workflows: []DiscoveredWorkflow{}})
	}
	refreshRegistryDigest(t, &registry)
	return base, registry
}

func TestRegistryMultiRepositorySecuritySelection(t *testing.T) {
	base, registry := multiRepositoryRegistry(t)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil || len(policy.Subscriptions) != 6 {
		t.Fatalf("selected routes=%d want=6 err=%v", len(policy.Subscriptions), err)
	}
	counts := map[int64]int{}
	for _, subscription := range policy.Subscriptions {
		counts[subscription.Source.RepositoryID]++
		grant := policy.Grants[subscription.ID]
		revision := policy.Revisions[subscription.ID]
		if subscription.Destination.RepositoryID != 11 || subscription.Destination.InstallationID != 20 ||
			revision.RepositoryID != 11 || revision.CommitSHA != registry.Records[0].CommitSHA ||
			grant.SourceRepositoryID != subscription.Source.RepositoryID ||
			grant.SourceInstallationID != subscription.Source.InstallationID ||
			grant.SourceOrganizationID != subscription.Source.OrganizationID ||
			grant.DestinationRepositoryID != 11 || ValidateSubscription(subscription, DefaultLimits()) != nil {
			t.Fatal("source selection changed destination, artifact or grant boundary")
		}
		wantExpiry := registry.Records[1].CheckedAt.Add(time.Duration(2*base.Policy.Discovery.Interval()) * time.Second)
		if grant.ExpiresAt != wantExpiry {
			t.Fatal("grant outlived oldest source/destination inventory")
		}
	}
	for _, repository := range []int64{21, 22, 23} {
		if counts[repository] != 2 {
			t.Fatal("exact or wildcard selection lost enrolled source", repository)
		}
	}
	if counts[11] != 0 || counts[24] != 0 {
		t.Fatal("selection inferred declaring-repository or unrelated authority")
	}
}

func TestRegistryOmittedReposPreserveSameRepository(t *testing.T) {
	base, registry := multiRepositoryRegistry(t)
	for i := range registry.Records[0].Workflows[0].Triggers {
		registry.Records[0].Workflows[0].Triggers[i].Repos = nil
	}
	refreshRegistryDigest(t, &registry)
	policy, err := RegistryPolicy(base, registry, time.Now())
	if err != nil || len(policy.Subscriptions) != 2 {
		t.Fatal("omitted selectors changed legacy activation", err)
	}
	for _, subscription := range policy.Subscriptions {
		if subscription.Source.RepositoryID != subscription.Destination.RepositoryID {
			t.Fatal("omitted selectors activated cross-repository source")
		}
		subscription.Source.RepositoryID = 21
		if ValidateSubscription(subscription, DefaultLimits()) == nil {
			t.Fatal("cross-repository subscription accepted without explicit selectors")
		}
	}
}

func TestRegistrySelectorsRejectNonPrivateSources(t *testing.T) {
	for _, visibility := range []string{"public", "internal"} {
		base, registry := multiRepositoryRegistry(t)
		registry.Records[2].Visibility = visibility
		refreshRegistryDigest(t, &registry)
		if _, err := RegistryPolicy(base, registry, time.Now()); err == nil {
			t.Fatal("non-private selected inventory accepted", visibility)
		}
	}
}

func TestRegistrySelectorsNeverEnrollOrReviveSources(t *testing.T) {
	for _, scenario := range []string{"not-enrolled", "missing", "dirty", "stale", "future", "out-of-scope", "destination-dirty", "destination-stale"} {
		t.Run(scenario, func(t *testing.T) {
			base, registry := multiRepositoryRegistry(t)
			switch scenario {
			case "not-enrolled":
				base.Policy.Discovery.Repositories = slices.Delete(base.Policy.Discovery.Repositories, 2, 3)
				registry.Records = slices.Delete(registry.Records, 2, 3)
			case "missing":
				registry.Records = slices.Delete(registry.Records, 2, 3)
			case "dirty":
				registry.Records[2].Dirty = true
			case "stale":
				registry.Records[2].CheckedAt = time.Now().Add(-time.Hour)
			case "future":
				registry.Records[2].CheckedAt = time.Now().Add(time.Hour)
			case "out-of-scope":
				base.AllowedOwners = []string{"approved", "bar", "unselected"}
				registry.Records = slices.Delete(registry.Records, 2, 4)
			case "destination-dirty":
				registry.Records[0].Dirty = true
			case "destination-stale":
				registry.Records[0].CheckedAt = time.Now().Add(-time.Hour)
			}

			refreshRegistryDigest(t, &registry)
			policy, err := RegistryPolicy(base, registry, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			want := 4
			switch scenario {
			case "out-of-scope":
				want = 2
			case "destination-dirty", "destination-stale":
				want = 0
			}
			if len(policy.Subscriptions) != want {
				t.Fatalf("routes=%d want=%d", len(policy.Subscriptions), want)
			}
			for _, subscription := range policy.Subscriptions {
				if subscription.Source.RepositoryID == 22 {
					t.Fatal("unavailable selected repository remained active")
				}
			}
		})
	}
}
