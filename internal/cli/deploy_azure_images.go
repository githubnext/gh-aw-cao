package cli

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/githubnext/gh-cao/internal/azcli"
)

// A release bundle source can implement this without changing apply ordering.
// Sources supply product files only; operator policy and evidence are separate.
type deployAzureBuildSource interface {
	Materialize(context.Context, string) (deployAzureSourceIdentity, error)
}

type deployAzureDevSource struct{ directory string }

type deployAzureSourceIdentity struct {
	Revision, Worktree string
}

//go:embed deploy_azure_assets.json
var deployAzureAssetAllowlistJSON []byte

var deployAzureAssetAllowlist = func() []string {
	var entries []string
	if err := json.Unmarshal(deployAzureAssetAllowlistJSON, &entries); err != nil {
		panic("invalid embedded Azure asset allowlist: " + err.Error())
	}
	return entries
}()

var deployAzureBuildInputExcluded = regexp.MustCompile(`(^|/)(testdata|__tests__|node_modules|\.git)/|^server/internal/testutil/|_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$|(?i:\.md$|\.(pem|key|p12|pfx|crt|cer|der)$)|(^|/)(\.env(\.|$)|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc$|cao(\.[a-z0-9-]+)?\.json$)`)

type deployAzureBuildContext struct {
	Directory, Revision, Digest string
	Worktree                    string
}

type deployAzureBuiltImage struct {
	Target              string `json:"target"`
	Reference           string `json:"reference"`
	Digest              string `json:"digest"`
	Repository          string `json:"repository"`
	Tag                 string `json:"tag"`
	Scan                string `json:"scan"`
	SBOM                string `json:"sbom"`
	Provenance          string `json:"provenance"`
	ConfiguredReference string `json:"configuredReference"`
}

func deployAzureImageTag(config deployAzureConfig) string {
	content, _ := json.Marshal(config)
	sum := sha256.Sum256(content)
	// The reviewed version plus configuration identity is never a mutable
	// shared `latest` tag. The freshly created registry is locked after build.
	version := config.Image.Tag
	if len(version) > 110 {
		version = version[:110]
	}
	return version + "-" + hex.EncodeToString(sum[:6])
}

func (s deployAzureDevSource) Materialize(ctx context.Context, destination string) (deployAzureSourceIdentity, error) {
	identity := deployAzureSourceIdentity{}
	root, err := filepath.Abs(s.directory)
	if err != nil {
		return identity, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return identity, err
	}
	git := func(args ...string) (string, error) {
		command := exec.CommandContext(ctx, "git", append([]string{"-C", root}, args...)...)
		output, err := command.Output()
		if err != nil {
			return "", fmt.Errorf("inspect development build source: %w", err)
		}
		return string(output), nil
	}
	revision, err := git("rev-parse", "HEAD")
	if err != nil {
		return identity, err
	}
	revision = strings.TrimSpace(revision)
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(revision) {
		return identity, errors.New("development source must have a full Git commit SHA")
	}
	identity.Revision = revision
	status, err := git("status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		return identity, err
	}
	identity.Worktree = "clean"
	if status != "" {
		identity.Worktree = "dirty"
	}
	files, err := git("ls-files", "-z")
	if err != nil {
		return identity, err
	}
	for _, name := range strings.Split(files, "\x00") {
		if !deployAzureBuildFileAllowed(name) {
			continue
		}
		if err := copyDeployAzureFile(filepath.Join(root, filepath.FromSlash(name)), filepath.Join(destination, filepath.FromSlash(name))); err != nil {
			return identity, fmt.Errorf("copy build source %s: %w", name, err)
		}
	}
	for _, required := range []string{"server/Dockerfile", "server/go.mod", "dashboard/site/package.json", "dashboard/site/manifest.webmanifest", "server/azure/provision.sh"} {
		if _, err := os.Stat(filepath.Join(destination, required)); err != nil {
			return identity, fmt.Errorf("development source is not a gh-cao checkout: missing %s", required)
		}
	}
	// A worktree is not an attested commit checkout. Detect changes during
	// copying; the context digest below remains the identity of actual inputs.
	after, err := git("status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		return identity, err
	}
	if status != after {
		return identity, errors.New("development source changed while materializing; retry from a stable worktree")
	}
	currentRevision, err := git("rev-parse", "HEAD")
	if err != nil {
		return identity, err
	}
	if strings.TrimSpace(currentRevision) != identity.Revision {
		return identity, errors.New("development source revision changed while materializing; retry from a stable worktree")
	}
	return identity, nil
}

func deployAzureBuildFileAllowed(name string) bool {
	if name == "" || !filepath.IsLocal(name) || strings.Contains(name, "\\") {
		return false
	}
	if deployAzureBuildInputExcluded.MatchString(name) {
		return false
	}
	for _, entry := range deployAzureAssetAllowlist {
		if name == entry || strings.HasSuffix(entry, "/") && strings.HasPrefix(name, entry) {
			return true
		}
	}
	return false
}

func copyDeployAzureFile(source, destination string) error {
	// Reject symbolic links in every path component, not only the leaf.
	for path := source; ; path = filepath.Dir(path) {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symbolic links are not allowed in build inputs: %s", source)
		}
		if filepath.Dir(path) == path {
			break
		}
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { _ = input.Close() }()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("build input is not a regular file: %s", source)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, deployAzureContextFileMode(info.Mode()))
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	return errors.Join(copyErr, closeErr)
}

func deployAzureContextFileMode(source os.FileMode) os.FileMode {
	if source&0o111 != 0 {
		return 0o755
	}
	return 0o644
}

func prepareDeployAzureBuild(ctx context.Context, source deployAzureBuildSource, workspace *deployAzureWorkspace, options deployAzureApplyOptions) (deployAzureBuildContext, error) {
	build := deployAzureBuildContext{Directory: filepath.Join(workspace.directory, "context")}
	if err := os.Mkdir(build.Directory, 0o700); err != nil {
		return build, err
	}
	identity, err := source.Materialize(ctx, build.Directory)
	if err != nil {
		return build, err
	}
	build.Revision, build.Worktree = identity.Revision, identity.Worktree
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(build.Revision) {
		return build, errors.New("build source must provide its full Git revision")
	}
	if build.Worktree != "clean" && build.Worktree != "dirty" {
		return build, errors.New("build source must identify its clean or dirty worktree state")
	}
	repoDir, err := filepath.EvalSymlinks(options.RepoDir)
	if err != nil {
		return build, fmt.Errorf("resolve operator repository: %w", err)
	}
	for _, name := range []string{"cao.json", "cao.azure.json"} {
		path := filepath.Join(repoDir, ".github", "workflows", name)
		content, err := os.ReadFile(path)
		if err != nil {
			return build, fmt.Errorf("read adopter-owned %s: %w", name, err)
		}
		value, err := nativeDecodeJSON(content)
		policy, ok := value.(map[string]any)
		if err != nil || !ok || policy == nil {
			return build, fmt.Errorf("adopter-owned %s must be a JSON object", name)
		}
		if name == "cao.json" {
			if err := nativeValidatePolicy(policy); err != nil {
				return build, fmt.Errorf("adopter-owned %s is invalid: %w", name, err)
			}
		}
		for _, pattern := range deployEmbeddedSecretPatterns {
			if pattern.Match(content) {
				return build, fmt.Errorf("adopter-owned %s appears to embed a secret", name)
			}
		}
		if err := copyDeployAzureFile(path, filepath.Join(build.Directory, ".github", "workflows", name)); err != nil {
			return build, err
		}
	}
	if options.SnapshotDir != "" {
		if err := copyDeployAzureSnapshot(options.SnapshotDir, filepath.Join(build.Directory, "cao-deploy-evidence")); err != nil {
			return build, err
		}
	}
	hash := sha256.New()
	err = filepath.WalkDir(build.Directory, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		// Remote builds preserve context modes, and images run as a non-root
		// user; the private parent workspace still protects the context on disk.
		if entry.IsDir() {
			return os.Chmod(path, 0o755)
		}
		if err := os.Chmod(path, deployAzureContextFileMode(info.Mode())); err != nil {
			return err
		}
		name, err := filepath.Rel(build.Directory, path)
		if err != nil {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fileSum := sha256.Sum256(content)
		_, err = fmt.Fprintf(hash, "%s\x00%04o\x00%x\n", filepath.ToSlash(name), deployAzureContextFileMode(info.Mode()), fileSum)
		return err
	})
	build.Digest = hex.EncodeToString(hash.Sum(nil))
	return build, err
}

func deployAzureBuildVersion(tag, revision string) string {
	if nativeExactVersion.MatchString("v" + strings.TrimPrefix(tag, "v")) {
		return tag
	}
	return "0.0.0-main." + revision
}

func deployAzureBuildImages(ctx context.Context, az azcli.Executor, config deployAzureConfig, build deployAzureBuildContext, options deployAzureApplyOptions, provision bool) ([]deployAzureBuiltImage, error) {
	repository := config.Image.Repository
	if repository == "" {
		repository = "cao-functions"
	}
	target := "azure-ingest-runtime"
	if options.EmptyEvidence {
		target = "azure-empty-ingest-runtime"
	}
	var images []deployAzureBuiltImage
	targets := []struct{ repository, target string }{{repository, "azure-functions-runtime"}, {"cao-ingest", target}}
	if provision {
		targets = append(targets, struct{ repository, target string }{"cao-db-provision", "azure-db-provision"})
	}
	for _, image := range targets {
		tag := deployAzureImageTag(config)
		args := []string{"acr", "build", "--subscription", config.Subscription, "--registry", config.Resources.ContainerRegistry,
			"--image", image.repository + ":" + tag, "--file", "server/Dockerfile", "--target", image.target,
			"--platform", "linux/amd64", "--build-arg", "REVISION=" + build.Revision,
			"--build-arg", "VERSION=" + deployAzureBuildVersion(config.Image.Tag, build.Revision), "--build-arg", "CAO_PROFILE=cao.azure.json",
			"--no-logs", "--output", "json"}
		if options.EmptyEvidence {
			args = append(args, "--build-arg", "CAO_INGEST_SOURCE=server/azure/empty-data")
		} else {
			args = append(args, "--build-arg", "CAO_INGEST_SOURCE=cao-deploy-evidence")
		}
		if _, err := az.Run(ctx, append(args, build.Directory)...); err != nil {
			return nil, deployAzureBuildFailure(ctx, az, config, image.target, err)
		}
		result, err := az.Run(ctx, "acr", "repository", "show", "--subscription", config.Subscription, "--name", config.Resources.ContainerRegistry, "--image", image.repository+":"+tag, "--output", "json")
		if err != nil {
			return nil, fmt.Errorf("resolve built image digest: %w", err)
		}
		var metadata struct {
			Digest string `json:"digest"`
		}
		if err := json.Unmarshal([]byte(result.Stdout), &metadata); err != nil {
			return nil, fmt.Errorf("parse built image digest: %w", err)
		}
		if !regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(metadata.Digest) {
			return nil, errors.New("ACR did not return a valid image digest")
		}
		if _, err := az.Run(ctx, "acr", "repository", "update", "--subscription", config.Subscription, "--name", config.Resources.ContainerRegistry,
			"--image", image.repository+":"+tag, "--write-enabled", "false", "--delete-enabled", "false", "--output", "none"); err != nil {
			return nil, fmt.Errorf("lock immutable image tag: %w", err)
		}
		images = append(images, deployAzureBuiltImage{
			Target: image.target, Reference: config.Resources.ContainerRegistry + ".azurecr.io/" + image.repository + "@" + metadata.Digest,
			Digest: metadata.Digest, Repository: image.repository, Tag: tag,
			Scan: "not-performed", SBOM: "not-generated", Provenance: "local-context-not-attested",
		})
	}
	return images, nil
}

func deployAzureImageParameters(config deployAzureConfig, images []deployAzureBuiltImage, emptyEvidence, provision bool) (map[string]any, error) {
	if config.Environment != "development" {
		return nil, errors.New("development image bindings cannot authorize production apply")
	}
	repository := config.Image.Repository
	if repository == "" {
		repository = "cao-functions"
	}
	ingestTarget := "azure-ingest-runtime"
	if emptyEvidence {
		ingestTarget = "azure-empty-ingest-runtime"
	}
	expected := map[string]struct{ repository, parameter string }{
		"azure-functions-runtime": {repository, "functionImageDigest"},
		ingestTarget:              {"cao-ingest", "ingestionImageDigest"},
	}
	if provision {
		expected["azure-db-provision"] = struct{ repository, parameter string }{"cao-db-provision", "provisioningImageDigest"}
	}
	parameters := config.parameters()
	for _, image := range images {
		binding, ok := expected[image.Target]
		if !ok || image.Repository != binding.repository || image.Tag != deployAzureImageTag(config) ||
			!regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(image.Digest) ||
			image.Reference != config.Resources.ContainerRegistry+".azurecr.io/"+binding.repository+"@"+image.Digest ||
			image.Scan != "not-performed" || image.SBOM != "not-generated" || image.Provenance != "local-context-not-attested" {
			return nil, errors.New("invalid development image binding or assurance disposition; refusing full template apply")
		}
		parameters[binding.parameter] = image.Digest
		delete(expected, image.Target)
	}
	if len(expected) != 0 {
		return nil, errors.New("missing development image target; refusing full template apply")
	}
	return parameters, nil
}

// Read back configured references, not a claim about the running platform's
// measured image or an independent scan/provenance attestation.
func deployAzureReadBackImages(ctx context.Context, az azcli.Executor, config deployAzureConfig, images []deployAzureBuiltImage) error {
	for i := range images {
		image := &images[i]
		scope := []string{"--subscription", config.Subscription, "--resource-group", config.ResourceGroup}
		var args []string
		if image.Target == "azure-functions-runtime" {
			args = append([]string{"functionapp", "config", "show"}, scope...)
			args = append(args, "--name", config.Resources.FunctionApp, "--query", "linuxFxVersion")
		} else {
			suffix := "-ingest"
			if image.Target == "azure-db-provision" {
				suffix = "-db-provision"
			}
			args = append([]string{"containerapp", "job", "show"}, scope...)
			args = append(args, "--name", config.Resources.FunctionApp+suffix, "--query", "properties.template")
		}
		result, err := az.Run(ctx, append(args, "--output", "json")...)
		if err != nil {
			return fmt.Errorf("read back configured image for %s: %w", image.Target, err)
		}
		reference := ""
		if image.Target == "azure-functions-runtime" {
			var fx string
			if err := json.Unmarshal([]byte(result.Stdout), &fx); err != nil {
				return fmt.Errorf("parse configured Functions image: %w", err)
			}
			reference = strings.TrimPrefix(fx, "DOCKER|")
			if fx != "DOCKER|"+image.Reference {
				return errors.New("configured Functions image does not match the built digest; refusing job execution")
			}
		} else {
			var template struct {
				Containers     []struct{ Image string } `json:"containers"`
				InitContainers []json.RawMessage        `json:"initContainers"`
			}
			if err := json.Unmarshal([]byte(result.Stdout), &template); err != nil {
				return fmt.Errorf("parse configured job image: %w", err)
			}
			if len(template.Containers) != 1 || len(template.InitContainers) != 0 || template.Containers[0].Image != image.Reference {
				return fmt.Errorf("configured image for %s does not match the built digest; refusing job execution", image.Target)
			}
			reference = template.Containers[0].Image
		}
		image.ConfiguredReference = reference
	}
	return nil
}

func deployAzureBuildFailure(ctx context.Context, az azcli.Executor, config deployAzureConfig, target string, failure error) error {
	run := regexp.MustCompile(`run with ID '([a-z0-9]+)'`).FindStringSubmatch(failure.Error())
	if len(run) != 2 {
		return fmt.Errorf("ACR build target %s failed; full template was not deployed: %w", target, failure)
	}
	logs, err := az.Run(ctx, "acr", "task", "logs", "--subscription", config.Subscription, "--registry", config.Resources.ContainerRegistry, "--run-id", run[1])
	if err != nil {
		return fmt.Errorf("ACR build target %s failed; full template was not deployed: %w; build log read-back failed: %v", target, failure, err)
	}
	tail := strings.TrimSpace(logs.Stdout)
	if len(tail) > 6000 {
		tail = tail[len(tail)-6000:]
	}
	return fmt.Errorf("ACR build target %s failed; full template was not deployed: %w\nACR build %s log tail:\n%s", target, failure, run[1], tail)
}
