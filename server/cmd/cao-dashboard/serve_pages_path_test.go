package main

import "testing"

func TestNormalizePagesBasePath(t *testing.T) {
	for input, want := range map[string]string{"/": "/", "/repo": "/repo/", "/repo/": "/repo/", "/a/b": "/a/b/"} {
		got, err := normalizePagesBasePath(input)
		if err != nil || got != want {
			t.Errorf("normalizePagesBasePath(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"", "repo", "/a//b", "/a/../b", "/a b", "/a?b", "/a#b", "/a%2fb", `/a\b`, "/a\tb", "/./a"} {
		if got, err := normalizePagesBasePath(input); err == nil {
			t.Errorf("normalizePagesBasePath(%q) = %q; want error", input, got)
		}
	}
}

func TestPagesFileName(t *testing.T) {
	cases := []struct {
		base, request, name string
		ok                  bool
	}{
		{"/", "/", ".", true},
		{"/", "/data/x.json", "data/x.json", true},
		{"/repo/", "/repo/", ".", true},
		{"/repo/", "/repo/docs/", "docs", true},
		{"/repo/", "/other/x", "", false},
		{"/repo/", "/repo/../x", "", false},
		{"/repo/", "/repo/a//b", "", false},
		{"/repo/", `/repo/a\b`, "", false},
	}
	for _, c := range cases {
		name, ok := pagesFileName(c.base, c.request)
		if name != c.name || ok != c.ok {
			t.Errorf("pagesFileName(%q, %q) = %q, %v; want %q, %v", c.base, c.request, name, ok, c.name, c.ok)
		}
	}
}
