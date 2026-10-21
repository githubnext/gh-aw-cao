package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/githubnext/gh-cao/internal/azcli"
)

func TestDeployAzureSourceBuildRequiresReviewedDevelopmentEnvironment(t *testing.T) {
	for _, environment := range []string{"", "production", "Development", "staging"} {
		t.Run("environment="+environment, func(t *testing.T) {
			fake, deps, _, _, options := testAzureApplySetup(t)
			config := testDeployConfig()
			config["environment"] = environment
			configPath := writeDeployConfig(t, config)
			planPath := filepath.Join(t.TempDir(), "plan.json")
			planErr := deployAzurePlanRun(context.Background(), io.Discard, deps, configPath, testDeployTemplatePath(t), planPath)
			fake.calls = nil
			if environment == "" || environment == "production" {
				if planErr != nil {
					t.Fatal(planErr)
				}
				err := deployAzureApply(context.Background(), deps, configPath, testDeployTemplatePath(t), planPath, options)
				if err == nil || !strings.Contains(err.Error(), "production promotion is unsupported") {
					t.Fatalf("missing production restriction: %v", err)
				}
			} else if planErr == nil || !strings.Contains(planErr.Error(), "environment must be") {
				t.Fatalf("invalid environment admitted: %v", planErr)
			}
			if len(fake.calls) != 0 {
				t.Fatalf("environment restriction must fail before any Azure call: %q", fake.calls)
			}
			if _, err := os.Stat(options.ReceiptPath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("blocked environment wrote receipt: %v", err)
			}
		})
	}
}

func TestDeployAzureSourceBuildRejectsOldPlanAndTemplateBeforeAzure(t *testing.T) {
	for _, missing := range []string{"environment", "functionImageDigest", "ingestionImageDigest", "provisioningImageDigest"} {
		t.Run(missing, func(t *testing.T) {
			fake, deps, config, planPath, options := testAzureApplySetup(t)
			plan, err := readDeployAzurePlan(planPath)
			if err != nil {
				t.Fatal(err)
			}
			template, err := (deployAzureFileTemplate{path: testDeployTemplatePath(t)}).Load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if missing == "environment" {
				plan.Environment = ""
			} else {
				var document map[string]any
				if err := json.Unmarshal(template.Content, &document); err != nil {
					t.Fatal(err)
				}
				delete(document["parameters"].(map[string]any), missing)
				template.Content, err = json.Marshal(document)
				if err != nil {
					t.Fatal(err)
				}
			}
			loaded, err := loadDeployAzureConfig(config)
			if err != nil {
				t.Fatal(err)
			}
			if err := deployAzureExecute(context.Background(), deps, loaded, template, plan, planPath, options); err == nil {
				t.Fatal("legacy plan/template admitted")
			}
			if len(fake.calls) != 0 {
				t.Fatalf("legacy plan/template caused Azure calls: %q", fake.calls)
			}
		})
	}
}

func TestDeployAzureImageBindingsFailClosed(t *testing.T) {
	fake, deps, configPath, plan, options := testAzureApplySetup(t)
	if err := deployAzureApply(context.Background(), deps, configPath, testDeployTemplatePath(t), plan, options); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(options.ReceiptPath)
	if err != nil {
		t.Fatal(err)
	}
	var receipt deployAzureReceipt
	if err := json.Unmarshal(content, &receipt); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadDeployAzureConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"missing", "duplicate", "digest", "reference", "target", "repository", "tag", "scan", "sbom", "provenance"} {
		t.Run(name, func(t *testing.T) {
			images := slices.Clone(receipt.Images)
			switch name {
			case "missing":
				images = images[:2]
			case "duplicate":
				images[1] = images[0]
			case "digest":
				images[0].Digest = "invalid"
			case "reference":
				images[0].Reference = images[1].Reference
			case "target":
				images[0].Target = "unreviewed-target"
			case "repository":
				images[0].Repository = "other"
			case "tag":
				images[0].Tag = "latest"
			case "scan":
				images[0].Scan = "passed"
			case "sbom":
				images[0].SBOM = ""
			case "provenance":
				images[0].Provenance = "attested"
			}
			if _, err := deployAzureImageParameters(loaded.config, images, true, true); err == nil {
				t.Fatal("invalid image/assurance binding admitted")
			}
		})
	}
	fake.invalidDigest = true
	options.ReceiptPath = filepath.Join(t.TempDir(), "failed-receipt.json")
	fake.calls = nil
	if err := deployAzureApply(context.Background(), deps, configPath, testDeployTemplatePath(t), plan, options); err == nil {
		t.Fatal("invalid ACR digest admitted")
	}
	for _, call := range fake.calls {
		if azcli.CommandName(call) == "deployment group create" && !strings.HasSuffix(call[slices.Index(call, "--name")+1], "-registry") {
			t.Fatal("invalid digest reached full template deployment")
		}
	}
}

func TestDeployAzureImageReadBackBlocksJobsOnMismatch(t *testing.T) {
	for _, name := range []string{"fa-synthetic-test", "fa-synthetic-test-ingest", "fa-synthetic-test-db-provision"} {
		for _, output := range []string{`null`, `{}`, `{"containers":[{"image":"other@sha256:wrong"}]}`} {
			t.Run(name+"/"+output, func(t *testing.T) {
				fake, deps, config, plan, options := testAzureApplySetup(t)
				fake.imageReadBack = map[string]string{name: output}
				if err := deployAzureApply(context.Background(), deps, config, testDeployTemplatePath(t), plan, options); err == nil {
					t.Fatal("invalid/missing configured digest admitted")
				}
				for _, call := range fake.calls {
					if azcli.CommandName(call) == "containerapp job start" {
						t.Fatal("started job after image mismatch")
					}
				}
				if _, err := os.Stat(options.ReceiptPath); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("image mismatch wrote receipt: %v", err)
				}
			})
		}
	}
}

func TestDeployAzureImageBindingsCoverSnapshotAndOptionalProvisioning(t *testing.T) {
	fake, _, configPath, _, options := testAzureApplySetup(t)
	loaded, err := loadDeployAzureConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	build := deployAzureBuildContext{Directory: options.RepoDir, Revision: strings.Repeat("a", 40)}
	for _, provision := range []bool{false, true} {
		for _, empty := range []bool{false, true} {
			options.EmptyEvidence = empty
			images, err := deployAzureBuildImages(context.Background(), fake, loaded.config, build, options, provision)
			if err != nil {
				t.Fatal(err)
			}
			parameters, err := deployAzureImageParameters(loaded.config, images, empty, provision)
			if err != nil {
				t.Fatal(err)
			}
			if (parameters["provisioningImageDigest"] != nil) != provision ||
				parameters["functionImageDigest"] != testAzureImageDigest("cao-functions") ||
				parameters["ingestionImageDigest"] != testAzureImageDigest("cao-ingest") {
				t.Fatalf("incorrect per-target bindings: %+v", parameters)
			}
			if _, err := deployAzureImageParameters(loaded.config, images, !empty, provision); err == nil {
				t.Fatal("snapshot/empty target substitution was admitted")
			}
		}
	}
}

func TestDeployAzureDevelopmentContextProvenanceIncludesDirtyBytesAndModes(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"server/Dockerfile", "server/go.mod", "dashboard/site/package.json", "dashboard/site/manifest.webmanifest", "server/azure/provision.sh"} {
		writeTestFile(t, filepath.Join(root, name), "synthetic build input\n")
	}
	git := func(args ...string) {
		t.Helper()
		command := exec.Command("git", append([]string{"-C", root}, args...)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %q: %v: %s", args, err, output)
		}
	}
	git("init", "--quiet")
	git("add", ".")
	git("-c", "user.name=Synthetic Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic source")
	_, _, _, _, options := testAzureApplySetup(t)
	build := func() deployAzureBuildContext {
		t.Helper()
		workspace, err := newDeployAzureWorkspace()
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = workspace.Close() }()
		result, err := prepareDeployAzureBuild(context.Background(), deployAzureDevSource{directory: root}, workspace, options)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	clean := build()
	writeTestFile(t, filepath.Join(root, "server", "untracked.go"), "untracked input is not uploaded\n")
	untracked := build()
	if untracked.Worktree != "dirty" || untracked.Digest != clean.Digest {
		t.Fatal("untracked source must affect observed status but not enter the build context")
	}
	writeTestFile(t, filepath.Join(root, "server", "Dockerfile"), "different dirty input\n")
	dirty := build()
	if clean.Worktree != "clean" || dirty.Worktree != "dirty" || dirty.Revision != clean.Revision || dirty.Digest == clean.Digest {
		t.Fatalf("worktree bytes falsely identified as the base commit: clean=%+v dirty=%+v", clean, dirty)
	}
	if err := os.Chmod(filepath.Join(root, "server", "azure", "provision.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	executable := build()
	if executable.Digest == dirty.Digest {
		t.Fatal("context digest must bind executable mode as well as file contents")
	}
}
