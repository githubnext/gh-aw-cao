package localops

import (
	"strings"
	"testing"
)

func TestTrustedTemplateDashboardURLDefaultsAndCache(t *testing.T) {
	t.Setenv("CAO_DASHBOARD_URL", "https://environment.example/control")
	s := service(t, func(o *Options) { o.Repository = "owner/repo" })
	if got := s.templateContext(t.Context(), "complete"); got["cao-url"] != "https://environment.example/control/" || got["cao-repository"] != "owner/repo" || got["cao-repository-url"] != "https://github.com/owner/repo" {
		t.Fatal(got)
	}
	explicit := service(t, func(o *Options) { o.CaoURL = "https://explicit.example/site" })
	if got := explicit.templateContext(t.Context(), "complete"); got["cao-url"] != "https://explicit.example/site/" {
		t.Fatal(got)
	}
	t.Setenv("CAO_DASHBOARD_URL", "")
	document := fixtureDocument()
	action := actionByID(document, "complete")
	action["command"] = "gh workflow run complete -f dashboard={{cao-url}} -f control={{cao-repository-url}}"
	pages := service(t, func(o *Options) { o.Repository = "owner/repo"; o.Dashboard = func() map[string]any { return document } })
	trusted := pages.templateContext(t.Context(), "complete")
	if trusted["cao-url"] != "https://owner.github.io/repo/" {
		t.Fatal(trusted)
	}
	if pages.DashboardURL() != trusted["cao-url"] || explicit.DashboardURL() != "https://explicit.example/site/" {
		t.Fatal("public URL accessor omitted validated host URL")
	}
	t.Setenv("LOCALOPS_PAGES_FAIL", "1")
	if got := pages.templateContext(t.Context(), "complete"); got["cao-url"] != trusted["cao-url"] {
		t.Fatal("trusted URL was not cached", got)
	}
	for _, values := range []map[string]string{{"cao-url": "https://browser.example/"}, {"cao-repository": "browser/repo"}, {"cao-repository-url": "https://github.com/browser/repo"}} {
		_, err := ResolveAction(document, map[string]any{"id": "complete", "values": values}, trusted)
		statusError(t, err, 400)
	}
	other := service(t, func(o *Options) {
		o.Repository = "owner/other"
		o.Dashboard = func() map[string]any { return document }
	})
	if got := other.templateContext(t.Context(), "complete"); got["cao-url"] != "" {
		t.Fatal("failed Pages lookup invented a URL", got)
	}
}
func TestTrustedTemplateDashboardURLValidation(t *testing.T) {
	for _, value := range []string{"http://localhost:3000/capability", "https://user:password@example.test/", "https://example.test/?token=anything", "https://example.test/#fragment", "https://example.test/?", " https://example.test/", "https://example.test/foo bar", "https://example.test/%20unsafe", "https://example.test/%3Bunsafe", "https://example.test/$(command)", "https://example.test/;command", "https://example.test/`command`", "https://example.test/|command", "https://example.test/%0Aunsafe", "https:///missing-host", strings.Repeat("x", 2049)} {
		if _, err := validateDashboardURL(value); err == nil {
			t.Errorf("accepted %q", value)
		}
	}
	t.Setenv("CAO_DASHBOARD_URL", "http://localhost:3000/private-capability")
	if _, err := New(Options{Workspace: workspace(t)}); err == nil {
		t.Fatal("unsafe environment URL was accepted")
	}
}
