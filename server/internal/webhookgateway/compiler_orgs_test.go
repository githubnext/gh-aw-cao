package webhookgateway

import (
	"errors"
	"testing"
	"time"
)

func TestCompilerOrganizationPatternsRequireAuthenticatedOrganizationIdentity(t *testing.T) {
	trigger := CompilerTrigger{SchemaVersion: 2, Event: "dependabot_alert", Orgs: []string{"*-labs", "approved", "my-*"}}
	if err := validateCompilerOrgs(trigger, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"APPROVED", "my-org", "test-labs"} {
		if !CompilerOrganizationMatches(trigger, name, 12, "Organization") {
			t.Fatal("literal/wildcard organization did not match", name)
		}
		if CompilerOrganizationMatches(trigger, name, 12, "User") ||
			CompilerOrganizationMatches(trigger, name, 0, "Organization") {
			t.Fatal("a name alone established organization authority")
		}
	}
	for _, invalid := range [][]string{{}, {"Approved"}, {"-bad"}, {"bad-"}, {"a?"}, {"a/b"}, {"approved", "approved"}, {"z", "a"}} {
		trigger.Orgs = invalid
		if validateCompilerOrgs(trigger, DefaultLimits()) == nil {
			t.Fatal("noncanonical organization selector accepted", invalid)
		}
	}
	trigger.Orgs = []string{"*"}
	for _, event := range []string{"jira_issue", "linear_issue", "azure_devops_issue", "webhook"} {
		trigger.Event = event
		if validateCompilerOrgs(trigger, DefaultLimits()) == nil {
			t.Fatal("GitHub selectors replaced external source scope")
		}
	}
}

func TestRegistryOrganizationSelectorsOnlyNarrowReviewedEnrollment(t *testing.T) {
	for _, scenario := range []string{"exact", "wildcard", "outside", "user", "no-enrollment"} {
		t.Run(scenario, func(t *testing.T) {
			base, registry := discoveryFixture(t)
			for i := range registry.Records[0].Workflows[0].Triggers {
				selector := "approved"
				if scenario == "wildcard" || scenario == "user" {
					selector = "*"
				}
				if scenario == "outside" {
					selector = "unapproved"
				}
				registry.Records[0].Workflows[0].Triggers[i].Orgs = []string{selector}
			}
			if scenario == "user" {
				registry.Records[0].OwnerType = "User"
			}
			if scenario == "no-enrollment" {
				base.Policy.Discovery.Repositories[0].RepositoryID++
			}
			refreshRegistryDigest(t, &registry)
			policy, err := RegistryPolicy(base, registry, time.Now())
			if scenario == "no-enrollment" && errors.Is(err, ErrUnauthorized) {
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			if scenario == "exact" || scenario == "wildcard" {
				want = 2
			}
			if len(policy.Subscriptions) != want {
				t.Fatal("organization selector broadened or bypassed enrollment", len(policy.Subscriptions))
			}
		})
	}
}
