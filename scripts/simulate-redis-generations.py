#!/usr/bin/env python3
"""Illustrative Redis-generation pressure model; not a throughput benchmark."""

import argparse
import json
import math
from pathlib import Path


def simulate(args):
    step = 10
    duration = args.hours * 3600
    poll = args.poll_minutes * 60
    grace = args.grace_minutes * 60
    webhook = args.webhook_seconds
    delay = args.collection_seconds
    prepare = args.prepare_seconds
    timeout = getattr(args, "timeout_minutes", 25) * 60
    repositories = getattr(args, "repositories", 0)
    runs_per_repo_day = getattr(args, "runs_per_repo_day", 2)
    tools_per_run = getattr(args, "tools_per_run", 50)
    issues_per_run = getattr(args, "issues_per_run", 1)
    issue_updates_per_issue = getattr(args, "issue_updates_per_issue", 1)
    retention_days = getattr(args, "retention_days", 30)
    daily_runs = repositories * runs_per_repo_day
    rows = (repositories + daily_runs * retention_days *
            (1 + tools_per_run + issues_per_run)) if repositories else args.rows
    write = rows / args.rows_per_second
    generation_gib = rows * args.bytes_per_row / 1024**3
    activations = [0]  # Begin with an existing complete generation.
    dirty = False
    job = None
    peak_rss = 0.0
    series = []
    completed = 0
    timed_out = 0
    collected_runs = 0
    for now in range(0, duration + 1, step):
        # Constant arrivals become visible to projection only after collection.
        if repositories:
            observed = max(0, math.floor((now - delay) * daily_runs / 86400))
            if observed > collected_runs:
                dirty = True
                collected_runs = observed
        elif now >= delay and (now - delay) % webhook == 0:
            dirty = True
        if job is not None:
            if now >= job + prepare + write and job + prepare + write <= job + timeout:
                activations.append(now)
                completed += 1
                job = None
            elif now >= job + timeout:
                timed_out += 1
                dirty = True
                job = None
        # Like PruneGenerations, keep the newest R AND anything within grace.
        while len(activations) > args.retain and now - activations[0] >= grace:
            activations.pop(0)
        if now > 0 and now % poll == 0 and job is None and dirty:
            job = now
            dirty = False

        staging = 0.0 if job is None else min(1.0, max(0.0, (now - job - prepare) / write))
        rss = (len(activations) + staging) * generation_gib * args.rss_factor
        peak_rss = max(peak_rss, rss)
        worker_busy = int(job is not None and now < job + prepare)
        redis_busy = int(job is not None and job + prepare <= now < job + prepare + write)
        series.append((now / 3600, rss, worker_busy, redis_busy))
    return series, {
        "assumptions": {
            "rows": rows,
            "repositories": repositories,
            "runs_per_repo_day": runs_per_repo_day if repositories else None,
            "tools_per_run": tools_per_run if repositories else None,
            "issues_per_run": issues_per_run if repositories else None,
            "issue_updates_per_issue": issue_updates_per_issue if repositories else None,
            "retention_days": retention_days if repositories else None,
            "runs_per_day": daily_runs if repositories else None,
            "issues_per_day": daily_runs * issues_per_run if repositories else None,
            "issue_status_updates_per_day": daily_runs * issues_per_run *
            issue_updates_per_issue if repositories else None,
            "bytes_per_row": args.bytes_per_row,
            "rows_per_second": args.rows_per_second,
            "prepare_seconds": prepare,
            "poll_minutes": args.poll_minutes,
            "timeout_minutes": timeout / 60,
            "grace_minutes": args.grace_minutes,
            "retained": args.retain,
            "redis_rss_factor": args.rss_factor,
        },
        "completed_generations": completed,
        "timed_out_projections": timed_out,
        "peak_redis_rss_gib": round(peak_rss, 3),
        "redis_host_gib": args.redis_host_gib,
        "worker_busy_fraction": round(sum(row[2] for row in series) / len(series), 3),
        "redis_write_busy_fraction": round(sum(row[3] for row in series) / len(series), 3),
    }


def chart(series, summary):
    width, height = 1200, 760
    left, right = 100, 1140
    top, middle, bottom = 110, 400, 690
    duration = series[-1][0]
    limit = summary["redis_host_gib"]
    maximum = max(limit, summary["peak_redis_rss_gib"] * 1.1, 1)

    def x(hour):
        return left + (right - left) * hour / duration

    def y_mem(gib):
        return middle - (middle - top) * gib / maximum

    def y_busy(fraction):
        return bottom - (bottom - (middle + 60)) * fraction

    def polyline(points, color, label):
        positions = " ".join(f"{px:.1f},{py:.1f}" for px, py in points)
        return (f'<polyline data-series="{label}" points="{positions}" fill="none" '
                f'stroke="{color}" stroke-width="3"/>')

    # Five-minute trailing busy share (a proxy for duty cycle, not measured CPU).
    window = 30
    worker = [sum(row[2] for row in series[max(0, i - window + 1):i + 1]) /
              min(i + 1, window) for i in range(len(series))]
    redis = [sum(row[3] for row in series[max(0, i - window + 1):i + 1]) /
             min(i + 1, window) for i in range(len(series))]
    elements = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" '
        'viewBox="0 0 1200 760" role="img" data-visual-kind="chart" '
        'data-visual-id="redis-generation-pressure" '
        'aria-label="Illustrative Redis generation memory and projection duty cycles">',
        '<rect width="1200" height="760" fill="#ffffff"/>',
        '<text x="100" y="42" font-size="24" fill="#24292f">'
        f'Illustrative generation pressure: {summary["assumptions"]["rows_per_second"]:,} '
        'rows/s (not measured)</text>',
        '<text x="100" y="85" font-size="18" fill="#24292f">'
        'Redis RSS estimate (GiB); host limit shown as dashed line</text>',
        '<text x="100" y="447" font-size="18" fill="#24292f">'
        '5-minute busy fraction: worker preparation (blue), Redis writes (orange)</text>',
    ]
    for index in range(7):
        hour = duration * index / 6
        px = x(hour)
        elements.append(f'<path d="M {px:.1f} {top} V {bottom}" stroke="#d0d7de"/>')
        elements.append(f'<text x="{px:.1f}" y="724" font-size="16" '
                        f'text-anchor="middle" fill="#24292f">{hour:.1f}h</text>')
    for index in range(6):
        value = maximum * index / 5
        py = y_mem(value)
        elements.append(f'<path d="M {left} {py:.1f} H {right}" stroke="#d0d7de"/>')
        elements.append(f'<text x="60" y="{py + 5:.1f}" font-size="16" '
                        f'fill="#24292f">{value:.1f}</text>')
    for fraction in (0, 0.5, 1):
        py = y_busy(fraction)
        elements.append(f'<path d="M {left} {py:.1f} H {right}" stroke="#d0d7de"/>')
        elements.append(f'<text x="48" y="{py + 5:.1f}" font-size="16" '
                        f'fill="#24292f">{fraction:.0%}</text>')
    limit_y = y_mem(limit)
    elements.append(f'<path d="M {left} {limit_y:.1f} H {right}" '
                    'stroke="#cf222e" stroke-width="2" stroke-dasharray="8 5"/>')
    elements.append(polyline([(x(row[0]), y_mem(row[1])) for row in series],
                             "#0969da", "redis-rss"))
    elements.append(polyline([(x(row[0]), y_busy(value)) for row, value in zip(series, worker)],
                             "#0969da", "worker-busy"))
    elements.append(polyline([(x(row[0]), y_busy(value)) for row, value in zip(series, redis)],
                             "#bc4c00", "redis-write-busy"))
    elements.append('<text x="100" y="754" font-size="16" fill="#24292f">'
                    'Synthetic steady arrivals; no actual CPU or Redis measurements</text>')
    elements.append("</svg>")
    return "\n".join(elements) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="destination SVG path")
    parser.add_argument("--hours", type=int, default=2)
    parser.add_argument("--rows", type=int, default=1_000_000)
    parser.add_argument("--repositories", type=int, default=0,
                        help="fleet mode: derive retained rows and run arrivals from repositories")
    parser.add_argument("--runs-per-repo-day", type=int, default=2)
    parser.add_argument("--tools-per-run", type=int, default=50)
    parser.add_argument("--issues-per-run", type=int, default=1)
    parser.add_argument("--issue-updates-per-issue", type=int, default=1)
    parser.add_argument("--retention-days", type=int, default=30)
    parser.add_argument("--bytes-per-row", type=int, default=1024)
    parser.add_argument("--rows-per-second", type=int, default=5000)
    parser.add_argument("--prepare-seconds", type=int, default=60)
    parser.add_argument("--webhook-seconds", type=int, default=60)
    parser.add_argument("--collection-seconds", type=int, default=60)
    parser.add_argument("--poll-minutes", type=int, default=5)
    parser.add_argument("--timeout-minutes", type=int, default=25)
    parser.add_argument("--grace-minutes", type=int, default=10)
    parser.add_argument("--retain", type=int, default=3)
    parser.add_argument("--rss-factor", type=float, default=1.5)
    parser.add_argument("--redis-host-gib", type=float, default=8)
    args = parser.parse_args()
    for name in ("hours", "rows", "bytes_per_row", "rows_per_second",
                 "webhook_seconds", "poll_minutes", "retain", "runs_per_repo_day",
                 "retention_days", "timeout_minutes"):
        if getattr(args, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    for name in ("prepare_seconds", "collection_seconds", "grace_minutes",
                 "repositories", "tools_per_run", "issues_per_run",
                 "issue_updates_per_issue"):
        if getattr(args, name) < 0:
            parser.error(f"--{name.replace('_', '-')} must be non-negative")
    for name in ("rss_factor", "redis_host_gib"):
        value = getattr(args, name)
        if not math.isfinite(value) or value <= 0:
            parser.error(f"--{name.replace('_', '-')} must be finite and positive")
    if args.hours > 168:
        parser.error("--hours must be at most 168")
    # Ten-second samples keep the model deterministic and cheap.
    if args.webhook_seconds % 10 or args.collection_seconds % 10 or args.prepare_seconds % 10:
        parser.error("second-valued inputs must be multiples of 10")
    series, summary = simulate(args)
    args.output.write_text(chart(series, summary), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
