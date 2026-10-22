package cli

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestDeployAzureRestartDefaultPauseHonorsCancellation(t *testing.T) {
	loaded, err := loadDeployAzureConfig(writeDeployConfig(t, testDeployConfig()))
	if err != nil {
		t.Fatal(err)
	}
	az := &fakeAzureApply{t: t, referencesStuck: true}
	deps := defaultDeployAzureDeps()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	err = deployAzureRestartAndAwaitReferences(ctx, deps, az, loaded.config)
	if err == nil || ctx.Err() != context.DeadlineExceeded || !strings.Contains(err.Error(), "did not resolve") {
		t.Fatalf("expected cancellable default pause, got %v", err)
	}
	if !az.restarted || az.referencePolls != 1 {
		t.Fatal("restart did not poll unresolved references before waiting")
	}
}
