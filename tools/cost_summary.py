"""Read-only summary of project events; no dependencies beyond Python."""

import argparse
import csv
from decimal import Decimal, InvalidOperation
from pathlib import Path
import re
import sys


FIELDS = (
    "время", "этап", "тип", "результат", "входы", "выходы",
    "причина перехода", "модель", "секунды", "токены", "стоимость",
    "источник метрики",
)
TOKEN_PARTS = {"вход": "токены вход", "выход": "токены выход", "кэш": "токены кэш"}
METRICS = ("секунды", "токены", *TOKEN_PARTS.values(), "стоимость")
HUMAN_EVENTS = {"ожидание человека", "вмешательство человека"}


def number(raw, metric, line):
    if raw.strip().casefold() in ("", "н/д"):
        return None
    try:
        value = Decimal(raw)
    except InvalidOperation:
        raise ValueError(f"Строка {line}, {metric}: неверное число") from None
    if not value.is_finite() or value < 0:
        raise ValueError(f"Строка {line}, {metric}: нужно конечное число >= 0")
    if metric.startswith("токены") and value != value.to_integral_value():
        raise ValueError(f"Строка {line}: токены должны быть целыми")
    return value


def token_values(raw, line):
    values = dict.fromkeys(TOKEN_PARTS.values())
    if "=" not in raw:
        return {**values, "токены": number(raw, "токены", line)}
    parts = {}
    for part in raw.split(";"):
        key, separator, value = part.strip().partition("=")
        if not separator or key not in TOKEN_PARTS or key in parts or not value.strip():
            raise ValueError(f"Строка {line}: ожидается вход=N; выход=N; кэш=N")
        parts[key] = number(value, TOKEN_PARTS[key], line)
    if parts.keys() != TOKEN_PARTS.keys():
        raise ValueError(f"Строка {line}: нужны все три категории токенов")
    values.update((TOKEN_PARTS[key], value) for key, value in parts.items())
    values["токены"] = sum(parts.values(), Decimal(0)) if None not in parts.values() else None
    return values


def summarize(stream):
    reader = csv.DictReader(stream, strict=True)
    if reader.fieldnames != list(FIELDS):
        raise ValueError("Заголовок CSV должен соответствовать projects/_template/events.csv")
    stages = {}
    total = []
    seen = set()
    duplicates = 0
    excluded = 0
    for row in reader:
        if None in row or any(value is None for value in row.values()):
            raise ValueError(f"Строка {reader.line_num}: неверное число полей")
        key = tuple(row[field].strip() for field in FIELDS)
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        if row["тип"].strip().casefold() == "итог":
            excluded += 1
            continue
        values = token_values(row["токены"].strip(), reader.line_num)
        for metric in ("секунды", "стоимость"):
            values[metric] = number(row[metric], metric, reader.line_num)
        values["тип"] = row["тип"].strip().casefold()
        values["входы"] = row["входы"]
        values["результат"] = row["результат"]
        stage = row["этап"].strip() or "н/д"
        stages.setdefault(stage, []).append(values)
        total.append(values)
    return stages, total, duplicates, excluded


def print_totals(label, rows):
    rows = [row for row in rows if row.get("тип") not in HUMAN_EVENTS]
    for metric in METRICS:
        known = [row[metric] for row in rows if row[metric] is not None]
        subtotal = sum(known, Decimal(0))
        complete = bool(rows) and len(known) == len(rows)
        print(f"{label} | {metric} | {subtotal:f} | {len(known)}/{len(rows)} | "
              f"{format(subtotal, 'f') if complete else 'н/д'}")


def main():
    parser = argparse.ArgumentParser(description="Сводка events.csv без записи в файлы")
    parser.add_argument("events", type=Path, help="Путь к events.csv одного проекта")
    args = parser.parse_args()
    try:
        with args.events.open(encoding="utf-8-sig", newline="") as stream:
            stages, total, duplicates, excluded = summarize(stream)
    except (OSError, UnicodeError, csv.Error, ValueError) as error:
        print(f"Ошибка: {error}", file=sys.stderr)
        return 1
    print(f"Журнал проекта: {args.events}")
    print("Стоимость — в единой валюте журнала; единицы и происхождение см. в источнике метрики.")
    print("Суммы ниже — известные подытоги с покрытием событий, не покрытием этапов.")
    print("Этап | Метрика | Известный подытог | Покрытие событий | Полный итог")
    for stage, rows in stages.items():
        print_totals(stage, rows)
    print_totals("ПРОЕКТ", total)
    waits = [row for row in total if row["тип"] == "ожидание человека"]
    closed = [row for row in waits if row["результат"].startswith("конец;")]
    known_waits = [row["секунды"] for row in closed if row["секунды"] is not None]
    print(f"Ожидание: известный подытог длительностей закрывающих строк "
          f"{sum(known_waits, Decimal(0)):f}; известных {len(known_waits)}/{len(closed)}. "
          "Это не объединение интервалов; открытые ожидания и пересечения проверьте по metrics.")
    interventions = [row for row in total if row["тип"] == "вмешательство человека"]
    message_ids = [re.search(r"(?:^|;)\s*сообщение_id=([^;]+)", row["входы"])
                   for row in interventions]
    print(f"Вмешательства: зарегистрировано уникальных ID "
          f"{len({match.group(1).strip() for match in message_ids if match})}; "
          f"строк без ID {sum(match is None for match in message_ids)}. "
          "Полнота истории этим счётом не подтверждается.")
    print(f"Исключено точных дублей: {duplicates}; строк тип=итог: {excluded}")
    # shortcut: нет ID событий; смысловые дубли проверяет агент до записи, добавить ID при автоматизации журнала.
    print("Учтены только точные дубли полей; полнота истории и единая валюта проверяются отдельно.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
