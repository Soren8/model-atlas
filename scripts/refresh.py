#!/usr/bin/env python3
"""Refresh the normalized model snapshot from the upstream llm-frontier JSON.

Fetches https://llm-frontier.catalystneuro.com/data/llm-frontier.json (which is
itself derived from Artificial Analysis measurements), validates the schema,
normalizes the positional ``models`` rows into ``public/data/models.json``
(the served "latest" copy) plus a dated ``public/data/models-YYYY-MM-DD.json``
history file, and preserves the previous snapshot on any failure via atomic
write.

Only the standard library is used so the GitHub Actions refresh job needs no
extra dependencies.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
import tempfile
import urllib.request

UPSTREAM_URL = "https://llm-frontier.catalystneuro.com/data/llm-frontier.json"
DEFAULT_OUT = os.path.join("public", "data", "models.json")

# models rows are positional:
# [name, creator, release YYYY-MM-DD, iq, cost, retired 0/1, open 0/1,
#  hist, caps, era integer, time_sec|null, tps|null, ttft|null]
N_FIELDS = 13
RELEASE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class DataError(ValueError):
    """Raised when upstream data fails schema validation."""


def fetch_bytes(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(
        url, headers={"User-Agent": "model-atlas-refresh/1.0"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_upstream(data) -> dict:
    """Validate the upstream payload schema; return it unchanged or raise."""
    if not isinstance(data, dict):
        raise DataError("top-level JSON must be an object")
    for key in ("models", "updated", "eras"):
        if key not in data:
            raise DataError(f"missing required top-level key: {key!r}")
    if not isinstance(data["models"], list) or not data["models"]:
        raise DataError("'models' must be a non-empty list")
    if not isinstance(data["updated"], str) or not data["updated"]:
        raise DataError("'updated' must be a non-empty string")
    if not isinstance(data["eras"], list):
        raise DataError("'eras' must be a list")
    for i, era in enumerate(data["eras"]):
        if (
            not isinstance(era, list)
            or len(era) < 3
            or not isinstance(era[0], str)
            or not RELEASE_RE.match(era[0])
        ):
            raise DataError(f"eras[{i}] must start with a YYYY-MM-DD boundary date")
    max_era = len(data["eras"])  # era indices run 0..len(eras) with N boundaries
    for i, m in enumerate(data["models"]):
        where = f"models[{i}]"
        if not isinstance(m, (list, tuple)) or len(m) != N_FIELDS:
            raise DataError(f"{where} must be a {N_FIELDS}-element array")
        (name, creator, release, iq, cost, retired, is_open,
         _hist, caps, era, time_sec, tps, ttft) = m
        if not isinstance(name, str) or not name.strip():
            raise DataError(f"{where}: name must be a non-empty string")
        if not isinstance(creator, str) or not creator.strip():
            raise DataError(f"{where}: creator must be a non-empty string")
        if not isinstance(release, str) or not RELEASE_RE.match(release):
            raise DataError(f"{where}: release must be YYYY-MM-DD")
        if not _is_num(iq) or iq <= 0:
            raise DataError(f"{where}: iq must be a positive number")
        if not _is_num(cost) or cost <= 0:
            raise DataError(f"{where}: cost must be a positive number")
        if retired not in (0, 1) or is_open not in (0, 1):
            raise DataError(f"{where}: retired/open flags must be 0 or 1")
        if not isinstance(caps, list) or len(caps) != 8:
            raise DataError(f"{where}: caps must be an 8-element list")
        if isinstance(era, bool) or not isinstance(era, int) or era < 0 or era > max_era:
            raise DataError(f"{where}: era must be an integer in 0..{max_era}")
        if time_sec is not None and (not _is_num(time_sec) or time_sec <= 0):
            raise DataError(f"{where}: time_sec must be null or a positive number")
        if tps is not None and (not _is_num(tps) or tps <= 0):
            raise DataError(f"{where}: tps must be null or a positive number")
        if ttft is not None and (not _is_num(ttft) or ttft < 0):
            raise DataError(f"{where}: ttft must be null or a non-negative number")
    return data


def _slug(name: str, seen: set) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "model"
    slug, n = base, 2
    while slug in seen:
        slug = f"{base}-{n}"
        n += 1
    seen.add(slug)
    return slug


def _era_date_bounds(eras: list, index: int) -> tuple:
    """(lower, upper) YYYY-MM-DD bounds for era ``index``.

    Upstream ``eras[i][0]`` is the start of era ``i + 1``, so era ``index``
    covers ``eras[index-1][0] <= date < eras[index][0]`` (lower inclusive,
    upper exclusive); ``None`` means unbounded. With no boundaries there is
    a single era accepting any dated entry.
    """
    lower = eras[index - 1][0] if index >= 1 and index - 1 < len(eras) else None
    upper = eras[index][0] if 0 <= index < len(eras) else None
    return lower, upper


def _backfill_time(hist, time_sec, bounds) -> tuple:
    """Fill a missing ``time_sec`` from the upstream ``hist`` list.

    Returns ``(time_sec, observed_date)``. A measured ``time_sec`` is never
    overwritten (observed date ``None``). Otherwise the latest valid dated
    entry inside the model's own era bounds wins: entries must be
    ``[date, cost, index, time_sec]`` lists with a YYYY-MM-DD date in bounds
    and a positive finite time. Malformed entries (``hist`` of ``0``,
    3-element rows without time, bad dates, non-positive/non-finite times)
    are safely ignored; with no valid entry both stay ``None``. Throughput
    is never synthesized here — ``tps``/``ttft`` stay as measured.
    """
    if time_sec is not None:
        return time_sec, None
    if not isinstance(hist, list):
        return None, None
    lower, upper = bounds
    best = None
    for entry in hist:
        if not isinstance(entry, (list, tuple)) or len(entry) < 4:
            continue
        date, _cost, _index, t = entry[0], entry[1], entry[2], entry[3]
        if not isinstance(date, str) or not RELEASE_RE.match(date):
            continue
        if lower is not None and date < lower:
            continue
        if upper is not None and date >= upper:
            continue
        if isinstance(t, bool) or not _is_num(t):
            continue
        if not math.isfinite(t) or not t > 0:
            continue
        if best is None or date >= best[0]:
            best = (date, float(t))
    if best is None:
        return None, None
    return best[1], best[0]


def normalize(data: dict) -> dict:
    """Convert validated upstream data into the compact snapshot payload."""
    data = validate_upstream(data)
    seen: set = set()
    models = []
    for m in data["models"]:
        (name, creator, release, iq, cost, retired, is_open,
         hist, _caps, era, time_sec, tps, ttft) = m
        backfilled_time, observed = _backfill_time(
            hist, time_sec, _era_date_bounds(data["eras"], era))
        models.append({
            "id": _slug(name, seen),
            "name": name,
            "creator": creator,
            "release": release,
            "iq": float(iq),
            "cost": float(cost),
            "retired": bool(retired),
            "open": bool(is_open),
            "era": era,
            "time_sec": None if backfilled_time is None else float(backfilled_time),
            "time_observed": observed,
            "tps": None if tps is None else float(tps),
            "ttft": None if ttft is None else float(ttft),
        })
    eras = []
    for i in range(len(data["eras"]) + 1):
        eras.append({"index": i, **_era_label(data["eras"], i)})
    return {
        "source_url": UPSTREAM_URL,
        "source_updated": data["updated"],
        "eras": eras,
        "models": models,
    }


def _era_label(eras: list, index: int) -> dict:
    """Derive a human label for era ``index`` from the boundary declarations.

    Upstream ``eras`` entries are [boundary_date, note, new_label, old_label,
    settled_date]. Era 0 is the oldest composition; the highest index is
    current. With no boundaries there is a single unlabeled era.
    """
    if not eras:
        return {"label": "All models", "note": ""}
    if index >= len(eras):
        # Current era: the newest composition.
        entry = eras[-1]
        label = entry[2] if len(entry) > 2 and entry[2] else "current"
        return {
            "label": f"{label} (current, since {entry[0]})",
            "note": entry[1] if len(entry) > 1 else "",
        }
    entry = eras[index]
    label = entry[3] if len(entry) > 3 and entry[3] else f"era {index}"
    end = eras[index + 1][0] if index + 1 < len(eras) else entry[0]
    return {
        "label": f"{label} (before {end})",
        "note": entry[1] if len(entry) > 1 else "",
    }


def measurements_equal(a: dict, b: dict) -> bool:
    """True when two payloads carry identical measurements (ignoring fetch time)."""
    strip = lambda p: {"source_updated": p.get("source_updated"),
                       "eras": p.get("eras"), "models": p.get("models")}
    return (json.dumps(strip(a), sort_keys=True) ==
            json.dumps(strip(b), sort_keys=True))


def atomic_write_json(path: str, payload: dict) -> None:
    """Write JSON atomically: temp file in the same directory + os.replace."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".models.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            f.write("\n")
        # mkstemp creates 0600; Docker COPY preserves modes and nginx serves
        # as UID 101, so widen to world-readable before the atomic replace.
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def dated_snapshot_path(out: str, fetched_at: str) -> str:
    """Dated history sibling for the ``out`` snapshot (one file per UTC day).

    ``models.json`` stays the served "latest" copy; ``models-YYYY-MM-DD.json``
    accumulates the per-day history for future time-based views. A second
    update on the same day overwrites that day's file.
    """
    directory = os.path.dirname(os.path.abspath(out)) or "."
    date = fetched_at[:10]
    if not RELEASE_RE.match(date):
        raise DataError(f"fetched_at has no YYYY-MM-DD date: {fetched_at!r}")
    return os.path.join(directory, f"models-{date}.json")


def refresh(url: str = UPSTREAM_URL, out: str = DEFAULT_OUT) -> str:
    """Fetch, validate, normalize and store the snapshot.

    On change, writes both the dated history file and the ``out`` latest
    copy. Returns one of 'updated', 'unchanged'. Raises on any failure
    without touching the existing snapshot.
    """
    raw = fetch_bytes(url)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise DataError(f"upstream payload is not valid JSON: {e}") from e
    payload = normalize(data)
    payload["fetched_at"] = dt.datetime.now(dt.timezone.utc).isoformat(
        timespec="seconds")

    if os.path.exists(out):
        with open(out, encoding="utf-8") as f:
            existing = json.load(f)
        if measurements_equal(existing, payload):
            return "unchanged"

    atomic_write_json(dated_snapshot_path(out, payload["fetched_at"]), payload)
    atomic_write_json(out, payload)
    return "updated"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=UPSTREAM_URL, help="upstream JSON URL")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="normalized snapshot output path")
    args = ap.parse_args(argv)
    try:
        print(refresh(args.url, args.out))
        return 0
    except Exception as e:  # preserve previous snapshot on any failure
        print(f"refresh failed, previous snapshot preserved: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
