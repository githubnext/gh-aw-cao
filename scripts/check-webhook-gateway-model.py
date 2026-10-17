#!/usr/bin/env python3
"""Run the bounded RFC-033 model and retain machine-readable TLC evidence."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def config_section(text, name):
    keywords = (
        "CONSTANTS|SPECIFICATION|INVARIANTS|PROPERTIES|CHECK_DEADLOCK"
    )
    match = re.search(
        rf"(?ms)^{name}\s+(.*?)(?=^(?:{keywords})\b|\Z)", text
    )
    return match[1].split() if match else []


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", default=os.environ.get("TLA2TOOLS_JAR"))
    parser.add_argument("--work-dir", help="optional scratch override (any directory)")
    parser.add_argument("--config", default="specs/tla/WebhookGateway.cfg")
    parser.add_argument("--result", help="result JSON (defaults beside configuration)")
    args = parser.parse_args()
    if not args.jar:
        parser.error("--jar or TLA2TOOLS_JAR is required (official tla2tools v1.7.4)")
    root = Path(__file__).resolve().parent.parent
    os.chdir(root)
    if args.work_dir:
        run_model(args, Path(args.work_dir).resolve())
    else:
        with tempfile.TemporaryDirectory(prefix="cao-webhook-gateway-", dir="/tmp") as work:
            run_model(args, Path(work))


def run_model(args, work):
    work.mkdir(parents=True, exist_ok=True)
    jar = Path(args.jar).resolve()
    model = Path("specs/tla/WebhookGateway.tla")
    config = Path(args.config)
    config_text = config.read_text()
    properties = config_section(config_text, "PROPERTIES")
    command = [
        "java", f"-Djava.io.tmpdir={work}", "-XX:+UseParallelGC", "-Xmx768m",
        "-cp", str(jar), "tlc2.TLC", "-workers", "2", "-fp", "0", "-seed", "33",
        "-metadir", str(work / "states"), "-config", str(config), str(model),
    ]
    started = time.time()
    run = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, check=False)
    output = run.stdout
    (work / "tlc.log").write_text(output)
    print(output, end="")
    counts = re.search(
        r"([\d,]+) states generated, ([\d,]+) distinct states found, "
        r"([\d,]+) states left on queue", output)
    success = (
        run.returncode == 0
        and "Model checking completed. No error has been found." in output
        and counts is not None and int(counts[3].replace(",", "")) == 0
    )
    if not success:
        raise SystemExit("TLC did not complete successfully; no result written")
    recorded_command = [
        arg.replace(str(work), "$TLC_WORK_DIR")
        if arg != str(jar) else "$TLA2TOOLS_JAR"
        for arg in command
    ]
    result = {
        "schema_version": 1, "rfc": "RFC-033", "status": "passed",
        "checked_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsed_seconds": round(time.time() - started, 3),
        "command": recorded_command,
        "command_is_template": True,
        "reproduce_command": (
            'python3 scripts/check-webhook-gateway-model.py --jar "$TLA2TOOLS_JAR"'
            f" --config {config}"
        ),
        "tool": {"release": "v1.7.4",
                 "url": "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
                 "sha256": digest(jar), "version_line": output.splitlines()[0]},
        "inputs": {str(path): digest(path) for path in (model, config)},
        "bounds": {
            "jobs": len(re.search(r"Jobs\s*=\s*\{([^}]+)\}", config_text)[1].split(",")),
            "workers": len(re.search(r"Workers\s*=\s*\{([^}]+)\}", config_text)[1].split(",")),
            **{
                key: int(re.search(rf"{name}\s*=\s*(\d+)", config_text)[1])
                for key, name in (
                    ("capacity", "Capacity"), ("max_time", "MaxTime"),
                    ("max_generation", "MaxGeneration")
                )
            },
        },
        "specification": config_section(config_text, "SPECIFICATION")[0],
        "invariants": config_section(config_text, "INVARIANTS"),
        "action_properties": [p for p in properties if p != "EventualSettlement"],
        "temporal_properties": [p for p in properties if p == "EventualSettlement"],
        "fairness_assumptions": (
            ["WF_vars(Tick)", "for each job: WF_vars(Reap(job))",
             "for each job: WF_vars(Expire(job))"]
            if "EventualSettlement" in properties else []
        ),
        "states_generated": int(counts[1].replace(",", "")),
        "distinct_states": int(counts[2].replace(",", "")),
        "states_remaining": int(counts[3].replace(",", "")),
        "stdout_sha256": hashlib.sha256(output.encode()).hexdigest(),
        "evidence": output[output.index("Model checking completed."):].splitlines(),
        "temporal_check_evidence": [
            line for line in output.splitlines() if "temporal properties" in line
        ],
        "limitations": [
            "Finite model; no unbounded proof or implementation conformance claim.",
            "Settlement liveness requires the listed clock/maintenance fairness; success is not guaranteed.",
            "Unobserved authorization changes may race with external acceptance.",
        ],
    }
    Path(args.result or config.with_suffix(".result.json")).write_text(
        json.dumps(result, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
