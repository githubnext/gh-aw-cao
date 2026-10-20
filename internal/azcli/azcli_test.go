package azcli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestHelperAzProcess(t *testing.T) {
	if os.Getenv("AZCLI_HELPER_PROCESS") != "1" {
		return
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	if len(args) > 0 {
		args = args[1:]
	}
	switch strings.Join(args, " ") {
	case "ok":
		_, _ = fmt.Fprint(os.Stdout, `{"ok":true}`)
		_, _ = fmt.Fprint(os.Stderr, os.Getenv("AZURE_CORE_ONLY_SHOW_ERRORS"))
		os.Exit(0)
	case "fail":
		fmt.Fprint(os.Stderr, "synthetic failure")
		os.Exit(3)
	case "sleep":
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	os.Exit(2)
}

func helperProcess(t *testing.T) Executor {
	t.Helper()
	t.Setenv("AZCLI_HELPER_PROCESS", "1")
	return ExecutorFunc(func(ctx context.Context, args ...string) (Result, error) {
		return Process{Path: os.Args[0], WaitDelay: time.Second}.Run(ctx, append([]string{"-test.run=TestHelperAzProcess", "--"}, args...)...)
	})
}

func TestProcessCapturesOutputAndEnvironment(t *testing.T) {
	result, err := helperProcess(t).Run(context.Background(), "ok")
	if err != nil {
		t.Fatal(err)
	}
	if result.Stdout != `{"ok":true}` || result.Stderr != "true" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestProcessReportsExitStatus(t *testing.T) {
	_, err := helperProcess(t).Run(context.Background(), "fail")
	var exit *ExitError
	if !errors.As(err, &exit) || exit.Code != 3 || !strings.Contains(exit.Error(), "synthetic failure") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestProcessHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := helperProcess(t).Run(ctx, "sleep")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline error, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("cancellation took %s", elapsed)
	}
}

func TestProcessRejectsCancelledContextWithoutStarting(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (Process{Path: "/nonexistent/az"}).Run(ctx, "account", "show"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

func TestProcessMissingAzure(t *testing.T) {
	t.Setenv("PATH", "")
	if _, err := (Process{}).Run(context.Background(), "account", "show"); err == nil || !strings.Contains(err.Error(), "install az") {
		t.Fatalf("expected missing az error, got %v", err)
	}
}

func TestReadOnlyGuard(t *testing.T) {
	calls := 0
	next := ExecutorFunc(func(context.Context, ...string) (Result, error) {
		calls++
		return Result{}, nil
	})
	guard := ReadOnly(next)
	const sub = "00000000-0000-4000-8000-000000000001"
	checkName := func(provider string) string {
		return "/subscriptions/" + sub + "/providers/" + provider + "/checkNameAvailability?api-version=2023-07-01"
	}
	allowed := [][]string{
		{"version", "--output", "json"},
		{"account", "show", "--subscription", "x"},
		{"group", "exists", "--name", "x"},
		{"resource", "list", "--resource-group", "x"},
		{"resource", "show", "--ids", "x"},
		{"provider", "list", "--subscription", "x"},
		{"role", "assignment", "list", "--assignee", "x"},
		{"ad", "signed-in-user", "show"},
		{"ad", "sp", "show", "--id", "x"},
		{"storage", "account", "check-name", "--name", "x"},
		{"acr", "check-name", "--name", "x"},
		{"keyvault", "list-deleted"},
		{"appservice", "list-locations", "--sku", "EP1"},
		{"postgres", "flexible-server", "list-skus", "--location", "x"},
		{"functionapp", "config", "appsettings", "list", "--name", "x"},
		{"deployment", "group", "what-if", "--resource-group", "x"},
		{"deployment", "sub", "what-if", "--location", "x"},
		{"rest", "--method", "post", "--url", checkName("Microsoft.KeyVault"), "--body", `{"name":"x"}`, "--output", "json"},
		{"rest", "--method", "POST", "--url", checkName("Microsoft.Web"), "--body", `{"name":"x"}`},
		{"rest", "-m", "post", "-u", checkName("Microsoft.DBforPostgreSQL"), "-b", `{"name":"x"}`},
		{"rest", "--method=post", "--url=https://management.azure.com" + checkName("Microsoft.Web")},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01"},
		{"rest", "--method", "get", "--url", "https://management.azure.com/subscriptions/" + sub + "/resourceGroups/rg-synthetic/providers/Microsoft.Authorization/permissions?api-version=2022-04-01"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Web/geoRegions?api-version=2024-11-01&sku=EP1&linuxWorkersEnabled=true"},
		{"rest", "--method", "post", "--url", "/subscriptions/" + sub + "/providers/Microsoft.DBforPostgreSQL/locations/westus3/checkNameAvailability?api-version=2024-08-01", "--body", "{}"},
	}
	for _, args := range allowed {
		if _, err := guard.Run(context.Background(), args...); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	for _, args := range [][]string{
		{"rest", "--method", "post", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01", "--body", "{}"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01&api-version=2022-04-01"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01&bad=%zz"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/resourceGroups/../providers/Microsoft.Authorization/permissions?api-version=2022-04-01"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/resourceGroups/rg%2Fother/providers/Microsoft.Authorization/permissions?api-version=2022-04-01"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Authorization/permissions?api-version=2020-01-01"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Web/geoRegions?api-version=2024-11-01&sku=EP1&linuxWorkersEnabled=false"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Web/geoRegions?api-version=2024-11-01&sku=EP1&linuxWorkersEnabled=true&extra=1"},
		{"rest", "--method", "get", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Web/geoRegions?api-version=2024-11-01&sku=EP1&sku=EP2&linuxWorkersEnabled=true"},
		{"rest", "--url", checkName("Microsoft.Web")},
		{"rest", "--method", "get", "--url", checkName("Microsoft.Web")},
		{"rest", "--method", "put", "--url", checkName("Microsoft.Web")},
		{"rest", "--method", "patch", "--url", checkName("Microsoft.Web")},
		{"rest", "--method", "delete", "--url", checkName("Microsoft.Web")},
		{"rest", "--method", "post", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Storage/checkNameAvailability?api-version=1"},
		{"rest", "--method", "post", "--url", "/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Web/sites/x/restart?api-version=1"},
		{"rest", "--method", "post", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Web/checkNameAvailability"},
		{"rest", "--method", "post", "--url", checkName("Microsoft.Web") + "&x=1"},
		{"rest", "--method", "post", "--url", "https://attacker.example.test" + checkName("Microsoft.Web")},
		{"rest", "--method", "post", "--url", "http://management.azure.com" + checkName("Microsoft.Web")},
		{"rest", "--method", "post", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Web/checkNameAvailability/../../x?api-version=1"},
		{"rest", "--method", "post", "--url", "/subscriptions/" + sub + "/providers/Microsoft.Web%2FcheckNameAvailability?api-version=1"},
		{"rest", "--method", "post", "--method", "delete", "--url", checkName("Microsoft.Web")},
		{"rest", "--method", "post", "--url", checkName("Microsoft.Web"), "--url", "/subscriptions/" + sub + "/resourceGroups/rg?api-version=1"},
		{"rest", "--method", "post", "--url", checkName("Microsoft.Web"), "--resource", "https://example.test"},
		{"rest", "--method", "post", "--url", checkName("Microsoft.Web"), "extra"},
		{"rest", "--method", "post", "--url"},
		{"rest"},
		{"role", "assignment", "create"},
		{"provider", "register", "--namespace", "x"},
		{"keyvault", "purge", "--name", "x"},
		{"keyvault", "recover", "--name", "x"},
		{"functionapp", "config", "appsettings", "set"},
		{"functionapp", "config", "access-restriction", "add"},
	} {
		if _, err := guard.Run(context.Background(), args...); err == nil {
			t.Fatalf("%v: write command was allowed", args)
		}
	}
	for _, args := range [][]string{
		{"group", "create", "--name", "x"},
		{"group", "delete", "--name", "x"},
		{"deployment", "group", "create"},
		{"deployment", "sub", "create"},
		{"keyvault", "secret", "set"},
		{"functionapp", "start"},
		{"acr", "import"},
		{"acr", "build"},
		{"bicep", "build"},
		{"resource", "update"},
		{"account", "set"},
		{"account"},
		{},
	} {
		if _, err := guard.Run(context.Background(), args...); err == nil {
			t.Fatalf("%v: write command was allowed", args)
		}
	}
	if calls != len(allowed) {
		t.Fatalf("guard forwarded %d calls, want %d", calls, len(allowed))
	}
}
