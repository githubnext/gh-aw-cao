package localops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const maximumCompilerBytes = 128 << 20

func compilerAsset() string {
	asset := runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}
	return asset
}

func compilerCache(workspace, version string) (string, error) {
	directory := filepath.Join(workspace, ".cao", "tools")
	if err := privateDirectory(directory); err != nil {
		return "", errors.New("private gh-aw compiler cache is unavailable")
	}
	return filepath.Join(directory, "gh-aw-"+version+"-"+compilerAsset()), nil
}

func verifiedCompilerCache(path string) (bool, error) {
	for _, candidate := range []string{path, path + ".sha256"} {
		if err := checkPrivateFile(candidate); err != nil {
			return false, errors.New("gh-aw compiler cache is unsafe")
		}
	}
	info, err := os.Stat(path + ".sha256")
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || info.Size() != 64 {
		return false, errors.New("gh-aw compiler checksum is invalid")
	}
	expected, err := os.ReadFile(path + ".sha256") // #nosec G304 -- host-owned private cache paths were checked for ownership, symlinks, and hardlinks above.
	if err != nil {
		return false, errors.New("gh-aw compiler checksum is unavailable")
	}
	file, err := os.Open(path) // #nosec G304 -- host-owned private regular single-link cache file, validated above.
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, errors.New("gh-aw compiler cache is unavailable")
	}
	defer func() { _ = file.Close() }()
	digest := sha256.New()
	size, err := io.Copy(digest, io.LimitReader(file, maximumCompilerBytes+1))
	if err != nil || size == 0 || size > maximumCompilerBytes || hex.EncodeToString(digest.Sum(nil)) != string(expected) {
		return false, errors.New("gh-aw compiler checksum verification failed")
	}
	return true, nil
}

func compilerClient(options Options) *http.Client {
	if options.compilerHTTPClient != nil {
		return options.compilerHTTPClient
	}
	return &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(request *http.Request, previous []*http.Request) error {
			host := request.URL.Hostname()
			if len(previous) >= 5 || request.URL.Scheme != "https" || request.URL.User != nil || host != "github.com" && !strings.HasSuffix(host, ".githubusercontent.com") {
				return errors.New("untrusted gh-aw compiler download redirect")
			}
			return nil
		},
	}
}

func downloadCompilerPart(ctx context.Context, client *http.Client, url string, destination io.Writer, limit int64) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("gh-aw compiler download is unavailable")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK || response.ContentLength > limit {
		return errors.New("gh-aw compiler download failed")
	}
	size, err := io.Copy(destination, io.LimitReader(response.Body, limit+1))
	if err != nil || size == 0 || size > limit {
		return errors.New("gh-aw compiler download exceeded its limit or was interrupted")
	}
	return nil
}

func downloadCompiler(ctx context.Context, options Options, version, path string) (string, error) {
	client := compilerClient(options)
	base := "https://github.com/github/gh-aw/releases/download/" + version + "/"
	var checksums strings.Builder
	if err := downloadCompilerPart(ctx, client, base+"checksums.txt", &checksums, 256<<10); err != nil {
		return "", err
	}
	expected := ""
	for _, line := range strings.Split(checksums.String(), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == compilerAsset() {
			digest, err := hex.DecodeString(fields[0])
			if err == nil && len(digest) == sha256.Size {
				expected = strings.ToLower(fields[0])
			}
		}
	}
	if expected == "" {
		return "", errors.New("pinned gh-aw compiler checksum is unavailable")
	}
	staged, err := os.CreateTemp(filepath.Dir(path), ".gh-aw-download-")
	if err != nil {
		return "", errors.New("gh-aw compiler staging is unavailable")
	}
	defer func() { _ = staged.Close(); _ = os.Remove(staged.Name()) }()
	digest := sha256.New()
	err = downloadCompilerPart(ctx, client, base+compilerAsset(), io.MultiWriter(staged, digest), maximumCompilerBytes)
	if err != nil {
		return "", err
	}
	if hex.EncodeToString(digest.Sum(nil)) != expected {
		return "", errors.New("pinned gh-aw compiler checksum verification failed")
	}
	if err = errors.Join(staged.Sync(), staged.Chmod(0700), staged.Close()); err != nil {
		return "", errors.New("gh-aw compiler staging failed")
	}
	for _, candidate := range []string{path, path + ".sha256"} {
		if err = checkPrivateFile(candidate); err != nil {
			return "", errors.New("gh-aw compiler cache is unsafe")
		}
	}
	if err = os.Rename(staged.Name(), path); err != nil {
		return "", errors.New("gh-aw compiler cache could not be published")
	}
	if err = os.WriteFile(path+".sha256", []byte(expected), 0600); err != nil { // #nosec G703 -- path is host-owned, private, and checked against symlinks and hardlinks.
		return "", errors.New("gh-aw compiler checksum could not be published")
	}
	return path, nil
}
