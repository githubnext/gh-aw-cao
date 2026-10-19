package localops

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode"
)

func validateDashboardURL(value string) (string, error) {
	parsed, err := url.Parse(value)
	unsafe := func(v string) bool {
		return strings.ContainsAny(v, "`$<>|&;\"'(){}\\") || strings.IndexFunc(v, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0
	}
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Opaque != "" || len(value) > 2048 || unsafe(value) || unsafe(parsed.Path) || !safeURL.MatchString(value) {
		return "", errors.New("CAO dashboard URL must be a safe HTTPS URL without credentials, query, or fragment")
	}
	return strings.TrimRight(parsed.String(), "/") + "/", nil
}
func (s *Service) dashboardURL(ctx context.Context, repository string) string {
	parts := strings.Split(repository, "/")
	if len(parts) != 2 || !dispatchRepository.MatchString(repository) || parts[1] == "." || parts[1] == ".." || len(repository) > 200 {
		return ""
	}
	s.urlMu.Lock()
	defer s.urlMu.Unlock()
	if s.urlRepository == repository && time.Since(s.urlChecked) < time.Minute {
		return s.urlValue
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	value := ""
	raw, err := readCommand(ctx, s.options, 16<<10, "api", "--hostname", githubHost(), "--method", "GET", "repos/"+repository+"/pages", "--jq", ".html_url")
	if err == nil {
		value, _ = validateDashboardURL(strings.TrimSpace(string(raw)))
	}
	s.urlRepository, s.urlValue, s.urlChecked = repository, value, time.Now()
	if value == "" && s.options.Log != nil {
		s.options.Log("CAO command backlinks are unavailable; configure a public dashboard URL.", nil)
	}
	return value
}
