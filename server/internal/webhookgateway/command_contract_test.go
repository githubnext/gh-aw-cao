package webhookgateway

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"
)

func TestCommandPublishedMetadataBounds(t *testing.T) {
	for _, family := range []string{"slash_command", "label_command"} {
		for _, scenario := range []string{"wrong-strategy", "too-many-names", "expression", "unsorted-names", "unsorted-events", "unsorted-native", "missing-action", "bodyless-source", "false-removal"} {
			t.Run(family+"/"+scenario, func(t *testing.T) {
				_, _, _, s := commandFixture(t, family)
				filter := s.Compiler.CommandFilter
				switch scenario {
				case "wrong-strategy":
					filter.Strategy = "decentralized"
					if family == "label_command" {
						filter.Strategy = "centralized"
					}
				case "too-many-names":
					count := 26
					if family == "label_command" {
						count = 51
					}
					filter.Names = make([]string, count)
					for i := range count {
						filter.Names[i] = fmt.Sprintf("command-%02d", i)
					}
					names := filter.Names
					filter.Names = names[:count-1]
					if err := validateCommandDeclaration(*s.Compiler, DefaultLimits()); err != nil {
						t.Fatal("exact native name-count boundary rejected", err)
					}
					filter.Names = names
				case "expression":
					filter.Names = []string{"${{ github.token }}"}
				case "unsorted-names":
					filter.Names = []string{"z", "a"}
				case "unsorted-events":
					slices.Reverse(filter.Events)
				case "unsorted-native":
					slices.Reverse(s.Compiler.NativeEvents)
				case "missing-action":
					s.Compiler.Types = nil
				case "bodyless-source":
					filter.Events = []string{"pull_request_review"}
				case "false-removal":
					filter.RemoveLabel = new(bool)
				}
				if validateCommandDeclaration(*s.Compiler, DefaultLimits()) == nil {
					t.Fatal("invalid command metadata activated")
				}
			})
		}
	}
	_, _, _, s := commandFixture(t, "slash_command")
	s.Compiler.CommandFilter.Names = []string{"*", "prefix with spaces*", "review"}
	if err := validateCommandDeclaration(*s.Compiler, DefaultLimits()); err != nil {
		t.Fatal("native configured-name grammar narrowed", err)
	}
	for _, raw := range []string{
		`{"policy":"slash-command/v1","names":["review"],"events":["issues"],"strategy":"inline","remove_label":null}`,
		`{"policy":"slash-command/v1","names":["review"],"events":["issues"],"strategy":"inline","extra":true}`,
	} {
		var filter CommandFilter
		if json.Unmarshal([]byte(raw), &filter) == nil {
			t.Fatal("unknown or explicit-null metadata accepted")
		}
	}
}

func TestCommandReviewedServerBasePaths(t *testing.T) {
	for _, server := range []string{"https://github.com", "https://github.example:8443/github/base"} {
		_, _, _, s := commandFixture(t, "slash_command")
		s.Source.ServerURL = server
		link := server + "/approved/exact/issues/42#issuecomment-9"
		if _, _, valid := commandURLParts(s, link, "issue_comment"); !valid {
			t.Fatal("approved origin/base-path rejected", server)
		}
		for _, invalid := range []string{
			"https://other.example/approved/exact/issues/42#issuecomment-9",
			server + "-elsewhere/approved/exact/issues/42#issuecomment-9",
			server + "/../approved/exact/issues/42#issuecomment-9",
			server + "/%61pproved/exact/issues/42#issuecomment-9",
			link + "?query",
		} {
			if _, _, valid := commandURLParts(s, invalid, "issue_comment"); valid {
				t.Fatal("unapproved source URL accepted", invalid)
			}
		}
	}
	for _, invalid := range []string{
		"https://github.example/", "https://github.example:443", "https://github.example:65536/github",
		"https://github.example/a/../b", "https://github.example/a//b", "https://github.example/%61",
		"https://github.example/github?query", "https://token@github.example/github", "http://github.example/github",
	} {
		if validGitHubServerURL(invalid) {
			t.Fatal("noncanonical reviewed server accepted", invalid)
		}
	}
}
