package localpreview

import (
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

//go:generate go run assets_generate.go

// Source sites use browser module URLs, not an npm installation. These
// browser-only dependencies are generated once with native esbuild and shipped
// in the Go binary, so previewing or authoring never starts a build process.
func (w *Workspace) prepareBrowserAssets() error {
	input := base64.NewDecoder(base64.StdEncoding, strings.NewReader(browserAssetArchive))
	archive, err := gzip.NewReader(input)
	if err != nil {
		return err
	}
	defer func() { _ = archive.Close() }()
	content, err := io.ReadAll(archive)
	if err != nil {
		return err
	}
	var assets map[string]string
	if err := json.Unmarshal(content, &assets); err != nil {
		return err
	}
	for name, content := range assets {
		if err := atomicWrite(w.OverlayDirectory, name, []byte(content)); err != nil {
			return err
		}
	}
	replacements := map[string]map[string]string{
		"src/validator-dashboard.js": {
			"from 'yaml'": `from './vendor/yaml.js'`,
			`from "yaml"`: `from "./vendor/yaml.js"`,
		},
		"src/components/cli-terminal-runtime.js": {
			`'@xterm/xterm'`:               `'../vendor/xterm.js'`,
			`'@xterm/addon-fit'`:           `'../vendor/addon-fit.js'`,
			`'@xterm/addon-web-links'`:     `'../vendor/addon-web-links.js'`,
			`'@xterm/xterm/css/xterm.css'`: `'../vendor/xterm-css.js'`,
			`'strip-ansi'`:                 `'../vendor/strip-ansi.js'`,
			`"@xterm/xterm"`:               `"../vendor/xterm.js"`,
			`"@xterm/addon-fit"`:           `"../vendor/addon-fit.js"`,
			`"@xterm/addon-web-links"`:     `"../vendor/addon-web-links.js"`,
			`"@xterm/xterm/css/xterm.css"`: `"../vendor/xterm-css.js"`,
			`"strip-ansi"`:                 `"../vendor/strip-ansi.js"`,
		},
	}
	for name, rewrites := range replacements {
		// Built sites have already bundled these modules, or do not carry
		// their original source names. Leave all published bundles unchanged.
		if _, err := os.Stat(filepath.Join(w.SiteDirectory, filepath.FromSlash(name))); errors.Is(err, os.ErrNotExist) {
			continue
		}
		source, err := regularFile(w.SiteDirectory, name)
		if err != nil {
			return err
		}
		content, err := os.ReadFile(source) // #nosec G304 -- regularFile verified the declared site path and rejected escaping symlinks.
		if err != nil {
			return err
		}
		updated := string(content)
		for from, to := range rewrites {
			updated = strings.ReplaceAll(updated, from, to)
		}
		if updated != string(content) {
			if err := atomicWrite(w.OverlayDirectory, name, []byte(updated)); err != nil {
				return err
			}
		}
	}
	return nil
}
