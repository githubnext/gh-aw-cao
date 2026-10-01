import argparse
import importlib.util
import math
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "simulate-redis-generations.py"
SPEC = importlib.util.spec_from_file_location("generation_pressure", SCRIPT)
generation_pressure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generation_pressure)


class GenerationPressureTests(unittest.TestCase):
    def options(self, **overrides):
        options = dict(
            hours=1, rows=1000, bytes_per_row=1024,
            rows_per_second=10, prepare_seconds=0, webhook_seconds=60,
            collection_seconds=0, poll_minutes=5, grace_minutes=10,
            retain=3, rss_factor=1.5, redis_host_gib=8,
        )
        options.update(overrides)
        return argparse.Namespace(**options)

    def test_retention_and_staging_peak(self):
        series, summary = generation_pressure.simulate(self.options())
        self.assertEqual(summary["completed_generations"], 11)
        one_generation = 1000 * 1024 / 1024**3 * 1.5
        self.assertTrue(math.isclose(summary["peak_redis_rss_gib"],
                                     round(4 * one_generation, 3)))
        self.assertGreater(summary["redis_write_busy_fraction"], 0)
        self.assertIn('data-series="redis-rss"', generation_pressure.chart(series, summary))

    def test_slow_writes_skip_polling_ticks(self):
        _, summary = generation_pressure.simulate(
            self.options(rows_per_second=2))
        self.assertEqual(summary["completed_generations"], 5)
        self.assertLess(summary["completed_generations"], 11)

    def test_no_completed_collection_means_no_rebuild(self):
        _, summary = generation_pressure.simulate(
            self.options(collection_seconds=7200))
        self.assertEqual(summary["completed_generations"], 0)
        self.assertEqual(summary["redis_write_busy_fraction"], 0)

    def test_fleet_counts_retained_rows_but_not_issue_status_updates(self):
        _, summary = generation_pressure.simulate(
            self.options(repositories=10_000, runs_per_repo_day=2,
                         tools_per_run=50, issues_per_run=1,
                         issue_updates_per_issue=1, retention_days=30))
        assumptions = summary["assumptions"]
        self.assertEqual(assumptions["runs_per_day"], 20_000)
        self.assertEqual(assumptions["issues_per_day"], 20_000)
        self.assertEqual(assumptions["issue_status_updates_per_day"], 20_000)
        self.assertEqual(assumptions["rows"], 31_210_000)
        self.assertEqual(summary["completed_generations"], 0)

        _, no_updates = generation_pressure.simulate(
            self.options(repositories=10_000, issue_updates_per_issue=0,
                         retention_days=30))
        self.assertEqual(no_updates["assumptions"]["rows"], assumptions["rows"])
        self.assertEqual(no_updates["peak_redis_rss_gib"], summary["peak_redis_rss_gib"])
        self.assertEqual(no_updates["assumptions"]["issue_status_updates_per_day"], 0)

    def test_timeout_discards_staging_and_retries_without_activation(self):
        series, summary = generation_pressure.simulate(
            self.options(rows=1000, rows_per_second=1, timeout_minutes=5))
        self.assertEqual(summary["completed_generations"], 0)
        self.assertGreater(summary["timed_out_projections"], 0)
        one_generation = 1000 * 1024 / 1024**3 * 1.5
        self.assertLess(max(row[1] for row in series), 2 * one_generation)


if __name__ == "__main__":
    unittest.main()
