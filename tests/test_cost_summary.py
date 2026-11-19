"""Unit checks for the summary, not agent workflow runs."""

import csv
from decimal import Decimal
import importlib.util
import io
from pathlib import Path
import unittest
from contextlib import redirect_stdout


SPEC = importlib.util.spec_from_file_location(
    "cost_summary", Path(__file__).resolve().parents[1] / "tools" / "cost_summary.py"
)
summary = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(summary)


def events(*rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(summary.FIELDS)
    for changes in rows:
        row = dict.fromkeys(summary.FIELDS, "н/д")
        row.update(changes)
        writer.writerow([row[field] for field in summary.FIELDS])
    stream.seek(0)
    return stream


class CostSummaryTests(unittest.TestCase):
    def test_deduplication_stages_and_unknowns(self):
        first = {"этап": "research", "результат": "попытка 1", "секунды": "2.5",
                 "токены": "10", "стоимость": "0.1"}
        second = {**first, "результат": "попытка 2"}
        stages, total, duplicates, excluded = summary.summarize(events(
            first, first, second, {"этап": "verify", "секунды": "0"},
            {"тип": "итог", "стоимость": "100"},
        ))
        self.assertEqual((len(total), duplicates, excluded), (3, 1, 1))
        self.assertEqual(sum(row["стоимость"] for row in stages["research"]), Decimal("0.2"))
        output = io.StringIO()
        with redirect_stdout(output):
            summary.print_totals("ПРОЕКТ", total)
        self.assertIn("секунды | 5.0 | 3/3 | 5.0", output.getvalue())
        self.assertIn("токены | 20 | 2/3 | н/д", output.getvalue())
        self.assertIn("стоимость | 0.2 | 2/3 | н/д", output.getvalue())

    def test_empty_is_not_known_zero(self):
        self.assertEqual(summary.summarize(events()), ({}, [], 0, 0))
        output = io.StringIO()
        with redirect_stdout(output):
            summary.print_totals("ПРОЕКТ", [])
        self.assertIn("стоимость | 0 | 0/0 | н/д", output.getvalue())

    def test_invalid_numbers_fail(self):
        for value in ("-1", "NaN", "Infinity", "USD 1", "1,2"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                summary.summarize(events({"стоимость": value}))
        with self.assertRaises(ValueError):
            summary.summarize(events({"токены": "1.5"}))

    def test_broken_schema_or_row_fails(self):
        with self.assertRaises(ValueError):
            summary.summarize(io.StringIO("этап,стоимость\nresearch,1\n"))
        stream = events()
        stream.seek(0, 2)
        stream.write("research,1\n")
        stream.seek(0)
        with self.assertRaises(ValueError):
            summary.summarize(stream)

    def test_token_components_and_legacy_totals(self):
        stages, total, _, _ = summary.summarize(events(
            {"этап": "research", "токены": "вход=30; выход=5; кэш=н/д"},
            {"этап": "strategy", "токены": "вход=40; выход=10; кэш=50"},
            {"этап": "verify", "токены": "1200"},
        ))
        self.assertIsNone(total[0]["токены"])
        self.assertEqual(total[0]["токены вход"], Decimal(30))
        self.assertIsNone(total[0]["токены кэш"])
        self.assertEqual(total[1]["токены"], Decimal(100))
        self.assertEqual(total[2]["токены"], Decimal(1200))
        self.assertIsNone(total[2]["токены вход"])
        output = io.StringIO()
        with redirect_stdout(output):
            summary.print_totals("ПРОЕКТ", total)
        self.assertIn("токены | 1300 | 2/3 | н/д", output.getvalue())
        self.assertIn("токены вход | 70 | 2/3 | н/д", output.getvalue())

    def test_invalid_token_components_fail(self):
        for value in ("вход=1; выход=2", "вход=1; выход=2; кэш=-1",
                      "вход=1.5; выход=2; кэш=3", "вход=1; вход=2; кэш=3",
                      "вход=1; выход=2; кэш=NaN", "вход=; выход=2; кэш=3"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                summary.summarize(events({"токены": value}))

    def test_human_events_do_not_inflate_work(self):
        _, total, _, _ = summary.summarize(events(
            {"тип": "шаг", "секунды": "12", "токены": "вход=3; выход=2; кэш=1"},
            {"тип": "ожидание человека", "секунды": "3600"},
            {"тип": "вмешательство человека", "секунды": "0"},
        ))
        output = io.StringIO()
        with redirect_stdout(output):
            summary.print_totals("ПРОЕКТ", total)
        self.assertIn("секунды | 12 | 1/1 | 12", output.getvalue())
        self.assertIn("токены | 6 | 1/1 | 6", output.getvalue())


if __name__ == "__main__":
    unittest.main()
