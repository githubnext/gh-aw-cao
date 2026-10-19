import base64
from collections import Counter, defaultdict
import hashlib
import json
import re
import sys

import yaml


def census(files):
    facts = {}
    counts = {name: Counter() for name in [
        "trigger_counts", "trigger_combinations", "schedule_cron_frequencies",
        "safe_output_types", "discussion_categories", "engine_distribution",
        "engine_models", "engine_versions", "timeout_distribution",
        "mcp_server_usage", "mcp_tool_usage", "union_write_scope_counts",
    ]}
    scopes = defaultdict(lambda: Counter(read=0, write=0, none=0))
    rows = []
    totals = Counter()
    sizes, jobs_counts, step_counts, script_counts = [], [], [], []
    for entry in files:
        raw = base64.b64decode(entry["content"], validate=True)
        blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        if blob != entry["gitBlob"]:
            raise ValueError("Input Git blob mismatch")
        text = raw.decode("utf-8")
        row = {"path": entry["path"], "gitBlob": blob,
               "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
        sizes.append(len(raw))
        try:
            doc = yaml.safe_load(text)
            if not isinstance(doc, dict) or not isinstance(doc.get("jobs"), dict):
                raise ValueError("No workflow jobs mapping")
        except (yaml.YAMLError, ValueError) as error:
            row.update({"status": "malformed", "reason": str(error).splitlines()[0][:160]})
            rows.append(row)
            totals["skipped_count"] += 1
            continue
        row["status"] = "parsed"
        triggers = doc.get("on", doc.get(True, {}))
        trigger_names = [triggers] if isinstance(triggers, str) else list(triggers or {})
        counts["trigger_counts"].update(trigger_names)
        counts["trigger_combinations"]["+".join(sorted(trigger_names))] += 1
        if isinstance(triggers, dict):
            for schedule in triggers.get("schedule", []) or []:
                if isinstance(schedule, dict) and isinstance(schedule.get("cron"), str):
                    counts["schedule_cron_frequencies"][schedule["cron"]] += 1
        jobs = list(doc["jobs"].values())
        steps = [step for job in jobs if isinstance(job, dict)
                 for step in (job.get("steps", []) or []) if isinstance(step, dict)]
        jobs_counts.append(len(jobs))
        step_counts.append(len(steps))
        script_counts.append(sum(isinstance(step.get("run"), str) for step in steps))
        for job in jobs:
            if isinstance(job, dict) and "timeout-minutes" in job:
                counts["timeout_distribution"][str(job["timeout-minutes"])] += 1

        first = text.splitlines()[0] if text else ""
        metadata = json.loads(first.partition("# gh-aw-metadata: ")[2]) if first.startswith("# gh-aw-metadata: ") else {}
        engine = metadata.get("agent_id")
        versions = metadata.get("engine_versions", {})
        if not engine and isinstance(versions, dict) and len(versions) == 1:
            engine = next(iter(versions))
        if not engine:
            env_ids = set(re.findall(r'^\s+GH_AW_ENGINE_ID:\s*["\']?([a-z0-9-]+)', text, re.M))
            if len(env_ids) == 1:
                engine = next(iter(env_ids))
        counts["engine_distribution"][engine or "unknown"] += 1
        totals["engine_unknown"] += not bool(engine)
        if metadata.get("agent_model"):
            counts["engine_models"][str(metadata["agent_model"])] += 1
        for key, value in versions.items():
            counts["engine_versions"][f"{key}:{value}"] += 1

        agent = doc["jobs"].get("agent", {})
        agent = agent if isinstance(agent, dict) else {}
        permissions = agent.get("permissions")
        row["agent_job_permissions"] = permissions
        if isinstance(permissions, dict):
            for scope, grant in permissions.items():
                if grant not in ("read", "write", "none"):
                    raise ValueError("Unsupported permission grant")
                scopes[scope][grant] += 1
        elif permissions in ("read-all", "write-all"):
            scopes["*"][permissions.split("-")[0]] += 1
        else:
            totals["agent_permissions_unknown"] += 1
        any_job_permissions = False
        union = {}
        for job in jobs:
            if not isinstance(job, dict) or "permissions" not in job:
                continue
            grants = job["permissions"]
            if isinstance(grants, dict):
                any_job_permissions = True
            elif grants in ("read-all", "write-all"):
                any_job_permissions = True
                grants = {"*": grants.split("-")[0]}
            else:
                continue
            for scope, grant in grants.items():
                if grant not in ("read", "write", "none"):
                    raise ValueError("Unsupported union permission grant")
                if {"none": 0, "read": 1, "write": 2}[grant] >= {"none": 0, "read": 1, "write": 2}.get(union.get(scope), -1):
                    union[scope] = grant
        totals["permissions_unknown"] += not any_job_permissions
        writes = [scope for scope, grant in union.items() if grant == "write"]
        for scope in union:
            counts["union_write_scope_counts"][scope] += scope in writes
        totals["workflows_with_any_write"] += bool(writes)
        row["union_job_permissions"] = union

        configs = []
        env_found = False
        for step in agent.get("steps", []) or []:
            env = step.get("env", {}) if isinstance(step, dict) else {}
            if "GH_AW_SAFE_OUTPUTS_CONFIG" not in env:
                continue
            env_found = True
            try:
                parsed = json.loads(env["GH_AW_SAFE_OUTPUTS_CONFIG"])
                if not isinstance(parsed, dict):
                    raise ValueError("Configuration is not a mapping")
                configs.append(parsed)
            except (json.JSONDecodeError, TypeError, ValueError):
                totals["safe_outputs_config_invalid"] += 1
        totals["safe_outputs_config_missing"] += not env_found
        if configs and any(config != configs[0] for config in configs):
            raise ValueError("Conflicting safe-output configurations in one workflow")
        config = configs[0] if configs else {}
        fallback = False
        if not configs:
            unescaped = text.replace('\\"', '"')
            match = re.search(r'"create_discussion"\s*:\s*\{[^{}]*"category"\s*:\s*"([^"]+)"', unescaped)
            if match:
                config = {"create_discussion": {"category": match[1]}}
                fallback = True
                totals["discussion_category_fallback_parsed"] += 1
        if fallback:
            row["safe_output_types_complete"] = False
        counts["safe_output_types"].update(list(config))
        if "create_discussion" in config:
            totals["create_discussion_workflows"] += 1
            discussion = config["create_discussion"]
            if isinstance(discussion, dict):
                category = discussion.get("category", "default")
                if not isinstance(category, str):
                    raise ValueError("Invalid discussion category")
                counts["discussion_categories"][category] += 1
                totals["discussion_category_detected"] += 1
        manifest_line = next((line for line in text.splitlines()[:8]
                              if line.startswith("# gh-aw-manifest: ")), None)
        manifest = json.loads(manifest_line.partition(": ")[2]) if manifest_line else {}
        servers = manifest.get("mcp_servers")
        if isinstance(servers, list):
            names = set()
            tools = set()
            for server in servers:
                names.add(server["name"])
                tools.update(f'{server["name"]}:{tool}' for tool in server.get("tools", []))
        else:
            totals["mcp_fallback_count"] += 1
            pairs = re.findall(r"^#\s+- mcp__([A-Za-z0-9_-]+?)__(\S+)", text, re.M)
            names = {pair[0] for pair in pairs}
            tools = {f"{server}:{tool}" for server, tool in pairs}
        counts["mcp_server_usage"].update(names)
        counts["mcp_tool_usage"].update(tools)
        rows.append(row)
    if not files or len({row["path"] for row in rows}) != len(files):
        raise ValueError("Empty or duplicated lockfile population")
    facts.update({name: dict(value) for name, value in counts.items()})
    facts.update({name: totals[name] for name in [
        "skipped_count", "engine_unknown", "permissions_unknown", "agent_permissions_unknown",
        "safe_outputs_config_missing", "safe_outputs_config_invalid", "create_discussion_workflows",
        "discussion_category_detected", "discussion_category_fallback_parsed",
        "workflows_with_any_write", "mcp_fallback_count",
    ]})
    facts["permissions_by_scope"] = {scope: dict(value) for scope, value in scopes.items()}
    facts.update({"lockfile_count": len(files), "total_bytes": sum(sizes),
                  "avg_bytes": sum(sizes) / len(sizes), "min_bytes": min(sizes), "max_bytes": max(sizes),
                  "workflow_dispatch_count": counts["trigger_counts"]["workflow_dispatch"],
                  "job_counts": {"total_jobs": sum(jobs_counts), "max_jobs": max(jobs_counts, default=0)},
                  "step_counts": {"total_steps": sum(step_counts), "max_steps": max(step_counts, default=0)},
                  "script_step_counts": {"total": sum(script_counts), "max": max(script_counts, default=0)}})
    facts["discussion_category_unresolved"] = {"count": totals["create_discussion_workflows"] - totals["discussion_category_detected"]}
    return {"parser": {"name": "PyYAML", "version": yaml.__version__, "entryPoint": "yaml.safe_load"},
            "facts": facts, "population": rows}


if __name__ == "__main__":
    json.dump(census(json.load(sys.stdin)), sys.stdout, separators=(",", ":"), sort_keys=True)
