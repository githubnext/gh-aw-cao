package server

import (
	"context"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

type appStore interface {
	operational.Cache
	operational.RequestLimiter
	operational.Coordination
	operational.Diagnostics
	Capabilities() operational.Capabilities
	Health(context.Context) (operational.Health, error)
	Maintain(context.Context) error
}

type appServices struct {
	operational.Store
	operational.Cache
	operational.RequestLimiter
	operational.Coordination
	operational.Diagnostics
}

type repositoryMemoryServices struct {
	operational.Cache
	operational.Coordination
}

func (a *App) operationalHealth(connected bool) map[string]any {
	c := a.store.Capabilities()
	capability := func(value operational.Capability) map[string]string {
		scope := "unsupported"
		switch value.Scope {
		case operational.ScopeUnsupported:
		case operational.ScopeProcess:
			scope = "process"
		case operational.ScopeDeployment:
			scope = "deployment"
		}
		persistence := "volatile"
		if value.Persistence == operational.PersistenceRestart {
			persistence = "restart"
		}
		return map[string]string{"scope": scope, "persistence": persistence}
	}
	recovered := true
	if collector := a.Collector(); collector != nil {
		recovered = collector.RecoveryReady()
	}
	return map[string]any{
		"connected": connected, "recoveryReady": recovered,
		"capabilities": map[string]any{
			"cache": capability(c.Cache), "requestLimits": capability(c.RequestLimits),
			"sessions": capability(c.Sessions), "revocations": capability(c.Revocations),
			"githubQuota": capability(c.GitHubQuota), "collection": capability(c.Collection),
			"coordination": capability(c.Coordination), "diagnostics": capability(c.Diagnostics),
		},
	}
}
