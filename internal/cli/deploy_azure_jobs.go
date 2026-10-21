package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/githubnext/gh-cao/internal/azcli"
)

func deployAzurePause(ctx context.Context, deps deployAzureDeps, duration time.Duration) error {
	if deps.pause != nil {
		return deps.pause(ctx, duration)
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func deployAzureRunJob(ctx context.Context, deps deployAzureDeps, az azcli.Executor, config deployAzureConfig, job string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	scope := []string{"--subscription", config.Subscription, "--resource-group", config.ResourceGroup, "--name", job}
	run := func(verb []string, extra ...string) (azcli.Result, error) {
		args := append(append(append([]string{}, verb...), scope...), extra...)
		return az.Run(ctx, append(args, "--output", "json")...)
	}
	result, err := run([]string{"containerapp", "job", "execution", "list"})
	if err != nil {
		return "", fmt.Errorf("check concurrent ingestion: %w", err)
	}
	var executions []struct {
		Name       string `json:"name"`
		Properties struct {
			Status string `json:"status"`
		} `json:"properties"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &executions); err != nil {
		return "", fmt.Errorf("parse ingestion executions: %w", err)
	}
	for _, execution := range executions {
		switch execution.Properties.Status {
		case "Succeeded", "Failed", "Stopped":
		default:
			return "", fmt.Errorf("concurrent ingestion execution %s is %s; do not start overlapping database bootstrap or ingestion", execution.Name, execution.Properties.Status)
		}
	}
	result, err = run([]string{"containerapp", "job", "start"})
	if err != nil {
		return "", fmt.Errorf("start ingestion: %w", err)
	}
	var started struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &started); err != nil {
		return "", fmt.Errorf("parse started ingestion execution: %w", err)
	}
	if started.Name == "" || !strings.HasPrefix(started.Name, job+"-") || strings.ContainsAny(started.Name, "/\\ \t\n") {
		return "", errors.New("ingestion start did not return the expected exact execution name")
	}
	for attempt := 0; attempt < 120; attempt++ {
		result, err = run([]string{"containerapp", "job", "execution", "show"}, "--job-execution-name", started.Name)
		if err != nil {
			return started.Name, fmt.Errorf("read ingestion execution %s: %w", started.Name, err)
		}
		var execution struct {
			Name       string `json:"name"`
			Properties struct {
				Status string `json:"status"`
			} `json:"properties"`
		}
		if err := json.Unmarshal([]byte(result.Stdout), &execution); err != nil {
			return started.Name, fmt.Errorf("parse ingestion execution: %w", err)
		}
		if execution.Name != started.Name {
			return started.Name, errors.New("azure returned a different ingestion execution; refusing to wait on it")
		}
		switch execution.Properties.Status {
		case "Succeeded":
			return started.Name, nil
		case "Failed", "Stopped":
			return started.Name, deployAzureJobFailure(ctx, run, config, job, started.Name, execution.Properties.Status)
		case "Running", "Processing", "Pending", "Unknown":
		default:
			return started.Name, fmt.Errorf("ingestion execution %s has unexpected status %q", started.Name, execution.Properties.Status)
		}
		if err := deployAzurePause(ctx, deps, 10*time.Second); err != nil {
			return started.Name, fmt.Errorf("wait for ingestion execution %s timed out or was cancelled: %w", started.Name, err)
		}
	}
	return started.Name, fmt.Errorf("ingestion execution %s did not finish within the bounded wait", started.Name)
}

func deployAzureJobFailure(ctx context.Context, run func([]string, ...string) (azcli.Result, error), config deployAzureConfig, job, execution, status string) error {
	result, err := run([]string{"containerapp", "job", "replica", "list"}, "--execution", execution)
	diagnostic := "replica diagnostics unavailable"
	var containers []string
	if err == nil {
		var replicas []struct {
			Name       string `json:"name"`
			Properties struct {
				InitContainers []struct {
					Name             string `json:"name"`
					RunningState     string `json:"runningState"`
					RunningStateInfo string `json:"runningStateDetails"`
				} `json:"initContainers"`
				Containers []struct {
					Name             string `json:"name"`
					RunningState     string `json:"runningState"`
					RunningStateInfo string `json:"runningStateDetails"`
				} `json:"containers"`
			} `json:"properties"`
		}
		if parseErr := json.Unmarshal([]byte(result.Stdout), &replicas); parseErr != nil {
			diagnostic = "could not parse replica diagnostics"
		} else {
			var failures []string
			for _, replica := range replicas {
				for _, container := range replica.Properties.InitContainers {
					failures = append(failures, fmt.Sprintf("init/bootstrap container %s: %s (%s)", container.Name, container.RunningState, container.RunningStateInfo))
					containers = append(containers, container.Name)
				}
				for _, container := range replica.Properties.Containers {
					failures = append(failures, fmt.Sprintf("container %s: %s (%s)", container.Name, container.RunningState, container.RunningStateInfo))
					containers = append(containers, container.Name)
				}
			}
			if len(failures) > 0 {
				diagnostic = strings.Join(failures, "; ")
			}
		}
	} else {
		diagnostic += ": " + err.Error()
	}
	inspect := "inspect the execution's console logs in the environment's Log Analytics workspace"
	if len(containers) > 0 {
		inspect = fmt.Sprintf("inspect az containerapp job logs show --subscription %s --resource-group %s --name %s --execution %s --container %s",
			config.Subscription, config.ResourceGroup, job, execution, strings.Join(containers, " (and --container "))
		if len(containers) > 1 {
			inspect += strings.Repeat(")", len(containers)-1)
		}
	}
	return fmt.Errorf("job execution %s %s: %s; %s; check Key Vault/ACR role propagation, PostgreSQL network reachability and database bootstrap permissions; verification was not attempted",
		execution, status, diagnostic, inspect)
}
