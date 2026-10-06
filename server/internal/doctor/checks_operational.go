package doctor

import (
	"context"
	"fmt"

	"github.com/githubnext/gh-aw-cao/server/internal/operational"
)

func (d Doctor) checkOperational(ctx context.Context) Check {
	const id, area, title = "operational.health", "operational", "Selected operational backend"
	if unavailable, ok := d.storeUnavailable(id, area, title); ok {
		unavailable.Details = []Detail{detail("backend", orDefault(d.Backend, "redis"))}
		return unavailable
	}
	health, err := d.Store.Health(ctx)
	if err != nil {
		return failed(id, area, title, err)
	}
	status := StatusPass
	if !health.Ready {
		status = StatusFail
	}
	return Check{
		ID: id, Area: area, Title: title, Status: status,
		Summary: "selected operational backend " + orDefault(d.Backend, "redis"),
		Details: []Detail{
			detail("ready", fmt.Sprint(health.Ready)),
			detail("cacheAccountingBytes", fmt.Sprint(health.CacheBytes)),
			detail("entries", fmt.Sprint(health.Entries)),
		},
	}
}

func (d Doctor) checkOperationalCapabilities(context.Context) Check {
	const id, area, title = "operational.capabilities", "operational", "Operational guarantees"
	if unavailable, ok := d.storeUnavailable(id, area, title); ok {
		return unavailable
	}
	caps := d.Store.Capabilities()
	if err := operational.Validate(caps, d.Store.Services(), operational.Requirements{
		SingleProcess: true, AllowVolatile: true,
	}); err != nil {
		return failed(id, area, title, err)
	}
	details := []Detail{}
	volatile := false
	for _, feature := range []struct {
		name string
		cap  operational.Capability
	}{
		{"cache", caps.Cache}, {"requestLimits", caps.RequestLimits},
		{"sessions", caps.Sessions}, {"revocations", caps.Revocations},
		{"githubQuota", caps.GitHubQuota}, {"collection", caps.Collection},
		{"coordination", caps.Coordination}, {"diagnostics", caps.Diagnostics},
	} {
		scope := "unsupported"
		switch feature.cap.Scope {
		case operational.ScopeUnsupported:
			scope = "unsupported"
		case operational.ScopeProcess:
			scope = "process"
		case operational.ScopeDeployment:
			scope = "deployment"
		}
		persistence := "volatile"
		if feature.cap.Persistence == operational.PersistenceRestart {
			persistence = "restart"
		}
		details = append(details, detail(feature.name, scope+"/"+persistence))
		if feature.cap.Scope != operational.ScopeUnsupported && feature.cap.Persistence == operational.PersistenceVolatile {
			volatile = true
		}
	}
	if volatile {
		return Check{
			ID: id, Area: area, Title: title, Status: StatusWarn, Details: details,
			Summary: "process-lifetime state: sessions may invalidate and accepted work or pending revocations may be lost on restart",
			Remedy:  "keep admission, collection, and backfill in the owning process; reconcile GitHub scope and rerun backfill after restart",
		}
	}
	return Check{ID: id, Area: area, Title: title, Status: StatusPass, Details: details,
		Summary: "selected supported features advertise restart persistence"}
}
