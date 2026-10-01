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


if __name__ == "__main__":
    unittest.main()
