#!/usr/bin/env python3
"""Import an EcoVolt telemetry CSV as a Convex historical session.

The importer intentionally has no dependency on the full telemetry bridge. It
uses Python's standard library, while reusing the Convex URL and deploy key
already configured in ``maindata.py`` (environment variables still override
those defaults).

Interactive usage:
    python backend/import_csv_to_convex.py

Command-line usage:
    python backend/import_csv_to_convex.py data.csv --session-name "Test run"
"""

from __future__ import annotations

import argparse
import ast
import csv
import hashlib
import http.client
import json
import math
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Sequence
from urllib.parse import urlsplit


BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BACKEND_DIR.parent
MAINDATA_PATH = BACKEND_DIR / "maindata.py"
MUTATION_PATH = "telemetry:insertTelemetryBatch"
COUNT_QUERY_PATH = "telemetry:getLatestSessionTimestamp"

# Canonical Convex field -> accepted CSV headers, in preference order.
FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "speed_ms": ("speed_ms",),
    "voltage_v": ("voltage_v", "voltage"),
    "current_a": ("current_a", "current"),
    "power_w": ("power_w", "avg_power"),
    "energy_j": ("energy_j", "energy"),
    "distance_m": ("distance_m", "distance"),
    "latitude": ("latitude", "lat"),
    "longitude": ("longitude", "lon", "lng"),
    "altitude_m": ("altitude_m", "altitude", "alt"),
    "gyro_x": ("gyro_x",),
    "gyro_y": ("gyro_y",),
    "gyro_z": ("gyro_z",),
    "accel_x": ("accel_x",),
    "accel_y": ("accel_y",),
    "accel_z": ("accel_z",),
    "steering_gyro_x": ("steering_gyro_x", "s_gyro_x"),
    "steering_gyro_y": ("steering_gyro_y", "s_gyro_y"),
    "steering_gyro_z": ("steering_gyro_z", "s_gyro_z"),
    "steering_accel_x": ("steering_accel_x", "s_accel_x"),
    "steering_accel_y": ("steering_accel_y", "s_accel_y"),
    "steering_accel_z": ("steering_accel_z", "s_accel_z"),
    "total_acceleration": ("total_acceleration", "total_accel"),
    "message_id": ("message_id", "msg_id"),
    "uptime_seconds": ("uptime_seconds", "uptime"),
    "throttle_pct": ("throttle_pct", "throttle"),
    "brake_pct": ("brake_pct", "brake"),
    "brake2_pct": ("brake2_pct", "brake2"),
    "motor_voltage_v": ("motor_voltage_v",),
    "motor_current_a": ("motor_current_a",),
    "motor_rpm": ("motor_rpm",),
    "motor_phase_1_current_a": ("motor_phase_1_current_a",),
    "motor_phase_2_current_a": ("motor_phase_2_current_a",),
    "motor_phase_3_current_a": ("motor_phase_3_current_a",),
    "motor_phase_current_a": ("motor_phase_current_a",),
    "inst_eff_km_kwh": ("inst_eff_km_kwh",),
    "acc_eff_km_kwh": ("acc_eff_km_kwh",),
    "current_efficiency_km_kwh": ("current_efficiency_km_kwh",),
    "cumulative_energy_kwh": ("cumulative_energy_kwh",),
    "route_distance_km": ("route_distance_km",),
    "avg_speed_kmh": ("avg_speed_kmh",),
    "max_speed_kmh": ("max_speed_kmh",),
    "avg_power": ("avg_power",),
    "avg_voltage": ("avg_voltage",),
    "avg_current": ("avg_current",),
    "max_power_w": ("max_power_w",),
    "max_current_a": ("max_current_a", "max_current"),
    "optimal_speed_kmh": ("optimal_speed_kmh",),
    "optimal_speed_ms": ("optimal_speed_ms",),
    "optimal_efficiency_km_kwh": ("optimal_efficiency_km_kwh",),
    "optimal_speed_confidence": ("optimal_speed_confidence",),
    "optimal_speed_data_points": ("optimal_speed_data_points",),
    "current_g_force": ("current_g_force",),
    "max_g_force": ("max_g_force",),
    "accel_magnitude": ("accel_magnitude",),
    "avg_acceleration": ("avg_acceleration",),
    "elevation_gain_m": ("elevation_gain_m",),
    "quality_score": ("quality_score",),
}

STRING_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "motion_state": ("motion_state",),
    "driver_mode": ("driver_mode",),
    "throttle_intensity": ("throttle_intensity",),
    "brake_intensity": ("brake_intensity",),
    "outlier_severity": ("outlier_severity",),
}

DERIVED_INPUT_COLUMNS = {"g_lat", "g_long", "energy", "energy_j", "distance", "distance_m"}


class ImportFailure(RuntimeError):
    """Raised for a user-actionable import failure."""


def load_env_files() -> None:
    """Load missing variables using the same locations as maindata.py."""
    for root in (PROJECT_ROOT, BACKEND_DIR):
        for filename in (".env.local", ".env"):
            path = root / filename
            if not path.is_file():
                continue
            try:
                for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
                    line = raw_line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, value = line.split("=", 1)
                    key = key.strip()
                    value = value.strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                        value = value[1:-1]
                    if key:
                        os.environ.setdefault(key, value)
            except OSError:
                continue


def literal_assignment(module: ast.Module, name: str) -> Any:
    """Read a literal top-level assignment without importing maindata.py."""
    for node in module.body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if any(isinstance(target, ast.Name) and target.id == name for target in targets):
            try:
                return ast.literal_eval(node.value)
            except (TypeError, ValueError) as exc:
                raise ImportFailure(f"{name} in maindata.py is not a literal value") from exc
    raise ImportFailure(f"Could not find {name} in {MAINDATA_PATH}")


def load_convex_config() -> tuple[str, str, int]:
    """Resolve Convex settings from env, falling back to maindata.py."""
    load_env_files()
    try:
        module = ast.parse(MAINDATA_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, SyntaxError) as exc:
        raise ImportFailure(f"Could not read Convex configuration from {MAINDATA_PATH}") from exc

    url = os.environ.get("CONVEX_URL") or str(literal_assignment(module, "CONVEX_CLOUD_URL"))
    deploy_key = os.environ.get("CONVEX_DEPLOY_KEY") or str(
        literal_assignment(module, "CONVEX_DEPLOY_KEY_DEFAULT")
    )
    batch_size = int(literal_assignment(module, "MAX_BATCH_SIZE"))
    if not url.strip():
        raise ImportFailure("CONVEX_URL is empty")
    if not deploy_key.strip():
        raise ImportFailure("CONVEX_DEPLOY_KEY is empty")
    return url.strip(), deploy_key.strip(), batch_size


def parse_number(value: str | None, column: str, row_number: int) -> float | None:
    if value is None or not value.strip():
        return None
    try:
        number = float(value)
    except ValueError as exc:
        raise ImportFailure(f"Row {row_number}: {column} is not a number: {value!r}") from exc
    if not math.isfinite(number):
        raise ImportFailure(f"Row {row_number}: {column} must be finite")
    return number


def first_number(
    row: dict[str, str], aliases: Sequence[str], row_number: int
) -> float | None:
    for column in aliases:
        if column in row and row[column] is not None and row[column].strip():
            return parse_number(row[column], column, row_number)
    return None


def first_string(row: dict[str, str], aliases: Sequence[str]) -> str | None:
    for column in aliases:
        value = row.get(column)
        if value is not None and value.strip():
            return value.strip()
    return None


def normalize_timestamp(value: str | None, row_number: int) -> str:
    if value is None or not value.strip():
        raise ImportFailure(f"Row {row_number}: timestamp is required")
    raw = value.strip()
    try:
        parsed = datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
    except ValueError as exc:
        raise ImportFailure(f"Row {row_number}: invalid ISO timestamp: {raw!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def convert_row(
    row: dict[str, str], row_number: int, session_id: str, session_name: str
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "session_id": session_id,
        "session_name": session_name,
        "timestamp": normalize_timestamp(row.get("timestamp"), row_number),
        "data_source": "csv_import",
    }

    for field, aliases in FIELD_ALIASES.items():
        value = first_number(row, aliases, row_number)
        if value is not None:
            record[field] = value

    for field, aliases in STRING_FIELD_ALIASES.items():
        value = first_string(row, aliases)
        if value is not None:
            record[field] = value

    # Preserve the historical dashboard's primary power series when an export
    # contains only the bridge's rolling avg_power column.
    if "power_w" not in record and "voltage_v" in record and "current_a" in record:
        record["power_w"] = record["voltage_v"] * record["current_a"]

    if "current_efficiency_km_kwh" not in record and "inst_eff_km_kwh" in record:
        record["current_efficiency_km_kwh"] = record["inst_eff_km_kwh"]
    if "cumulative_energy_kwh" not in record and "energy_j" in record:
        record["cumulative_energy_kwh"] = record["energy_j"] / 3_600_000.0
    if "route_distance_km" not in record and "distance_m" in record:
        record["route_distance_km"] = record["distance_m"] / 1000.0
    if "accel_magnitude" not in record and "total_acceleration" in record:
        record["accel_magnitude"] = record["total_acceleration"]

    if "current_g_force" not in record:
        g_lat = first_number(row, ("g_lat", "g_lateral"), row_number)
        g_long = first_number(row, ("g_long", "g_longitudinal"), row_number)
        if g_lat is not None and g_long is not None:
            record["current_g_force"] = math.hypot(g_lat, g_long)

    return record


def read_header(csv_path: Path) -> list[str]:
    try:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle)
            header = next(reader, None)
    except OSError as exc:
        raise ImportFailure(f"Could not read {csv_path}: {exc}") from exc
    if not header:
        raise ImportFailure("CSV file is empty")
    normalized = [column.strip() for column in header]
    if len(set(normalized)) != len(normalized):
        raise ImportFailure("CSV contains duplicate column names")
    if "timestamp" not in normalized:
        raise ImportFailure("CSV must contain a timestamp column")
    return normalized


def iter_records(csv_path: Path, session_id: str, session_name: str) -> Iterator[dict[str, Any]]:
    try:
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                raise ImportFailure("CSV file is empty")
            reader.fieldnames = [column.strip() for column in reader.fieldnames]
            for row_number, row in enumerate(reader, start=2):
                if None in row:
                    raise ImportFailure(f"Row {row_number}: more values than header columns")
                if not any((value or "").strip() for value in row.values()):
                    continue
                yield convert_row(row, row_number, session_id, session_name)
    except UnicodeDecodeError as exc:
        raise ImportFailure("CSV must be UTF-8 encoded") from exc
    except csv.Error as exc:
        raise ImportFailure(f"Invalid CSV: {exc}") from exc


def count_records(csv_path: Path, session_id: str, session_name: str) -> int:
    return sum(1 for _ in iter_records(csv_path, session_id, session_name))


def file_session_id(csv_path: Path, session_name: str) -> str:
    digest = hashlib.sha256()
    digest.update(session_name.encode("utf-8"))
    digest.update(b"\0")
    with csv_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    slug = re.sub(r"[^a-z0-9]+", "-", session_name.lower()).strip("-")[:32] or "session"
    return f"csv-{slug}-{digest.hexdigest()[:12]}"


def batched(records: Iterator[dict[str, Any]], size: int) -> Iterator[list[dict[str, Any]]]:
    batch: list[dict[str, Any]] = []
    for record in records:
        batch.append(record)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


class ConvexHttpClient:
    """Small keep-alive client for Convex's HTTP query/mutation API."""

    def __init__(self, base_url: str, deploy_key: str, timeout: float) -> None:
        parsed = urlsplit(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ImportFailure(f"Invalid CONVEX_URL: {base_url!r}")
        self.scheme = parsed.scheme
        self.host = parsed.hostname
        self.port = parsed.port
        self.base_path = parsed.path.rstrip("/")
        self.deploy_key = deploy_key
        self.timeout = timeout
        self.connection: http.client.HTTPConnection | None = None

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def _connection(self) -> http.client.HTTPConnection:
        if self.connection is None:
            connection_type = (
                http.client.HTTPSConnection if self.scheme == "https" else http.client.HTTPConnection
            )
            self.connection = connection_type(self.host, self.port, timeout=self.timeout)
        return self.connection

    def call(self, kind: str, function_path: str, args: dict[str, Any]) -> Any:
        body = json.dumps(
            {"path": function_path, "args": args, "format": "json"},
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        path = f"{self.base_path}/api/{kind}"
        headers = {
            "Authorization": f"Convex {self.deploy_key}",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        }
        try:
            connection = self._connection()
            connection.request("POST", path, body=body, headers=headers)
            response = connection.getresponse()
            response_body = response.read()
        except (OSError, http.client.HTTPException):
            self.close()
            raise

        try:
            payload = json.loads(response_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ImportFailure(f"Convex returned an invalid response (HTTP {response.status})") from exc

        if response.status >= 400 or payload.get("status") == "error":
            message = payload.get("errorMessage") or payload.get("message") or response.reason
            raise ImportFailure(f"Convex {kind} failed (HTTP {response.status}): {message}")
        if "value" not in payload:
            raise ImportFailure(f"Convex {kind} response did not contain a value")
        return payload["value"]

    def record_count(self, session_id: str) -> int:
        value = self.call("query", COUNT_QUERY_PATH, {"sessionId": session_id})
        if not isinstance(value, dict):
            raise ImportFailure("Convex count query returned an unexpected value")
        return int(value.get("recordCount", 0))

    def insert(self, records: list[dict[str, Any]]) -> int:
        value = self.call("mutation", MUTATION_PATH, {"records": records})
        if not isinstance(value, dict) or "inserted" not in value:
            raise ImportFailure("Convex insert mutation returned an unexpected value")
        return int(value["inserted"])


def upload(
    client: ConvexHttpClient,
    records: Iterator[dict[str, Any]],
    session_id: str,
    total: int,
    batch_size: int,
    max_attempts: int,
) -> None:
    existing = client.record_count(session_id)
    if existing:
        raise ImportFailure(
            f"Session {session_id} already contains {existing:,} records; "
            "use a different session name or --session-id"
        )

    uploaded = 0
    started = time.monotonic()
    for batch_number, batch in enumerate(batched(records, batch_size), start=1):
        expected_after = uploaded + len(batch)
        for attempt in range(1, max_attempts + 1):
            try:
                inserted = client.insert(batch)
                if inserted != len(batch):
                    raise ImportFailure(
                        f"Batch {batch_number} inserted {inserted} of {len(batch)} records"
                    )
                uploaded = expected_after
                break
            except (ImportFailure, OSError, http.client.HTTPException) as exc:
                client.close()
                try:
                    current = client.record_count(session_id)
                except (ImportFailure, OSError, http.client.HTTPException):
                    current = -1
                if current == expected_after:
                    uploaded = expected_after
                    break
                if current not in {-1, uploaded}:
                    raise ImportFailure(
                        f"Batch {batch_number} left an unexpected remote count of {current:,}; "
                        "stopping to avoid duplicates"
                    ) from exc
                if attempt == max_attempts:
                    raise ImportFailure(
                        f"Batch {batch_number} failed after {max_attempts} attempts: {exc}"
                    ) from exc
                time.sleep(min(2 ** (attempt - 1), 4))

        elapsed = max(time.monotonic() - started, 0.001)
        percent = uploaded * 100.0 / total
        print(f"\rUploaded {uploaded:,}/{total:,} ({percent:5.1f}%) at {uploaded / elapsed:,.0f} rows/s", end="", flush=True)

    print()
    remote_count = client.record_count(session_id)
    if remote_count != total:
        raise ImportFailure(f"Verification failed: Convex reports {remote_count:,} of {total:,} records")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upload an EcoVolt telemetry CSV into Convex historical mode.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("csv_path", nargs="?", help="CSV file to upload; prompts when omitted")
    parser.add_argument("--session-name", help="Historical session name; prompts when omitted")
    parser.add_argument("--session-id", help="Optional explicit unique session ID")
    parser.add_argument("--batch-size", type=int, help="Rows per Convex mutation")
    parser.add_argument("--timeout", type=float, default=45.0, help="HTTP timeout in seconds")
    parser.add_argument("--max-attempts", type=int, default=4, help="Attempts per failed batch")
    parser.add_argument("--dry-run", action="store_true", help="Validate and map the CSV without uploading")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        path_text = args.csv_path or input("CSV file location: ").strip().strip('"')
        session_name = args.session_name or input("Session name: ").strip()
        if not path_text:
            raise ImportFailure("CSV file location is required")
        if not session_name:
            raise ImportFailure("Session name is required")
        csv_path = Path(path_text).expanduser().resolve()
        if not csv_path.is_file():
            raise ImportFailure(f"CSV file not found: {csv_path}")

        header = read_header(csv_path)
        session_id = args.session_id.strip() if args.session_id else file_session_id(csv_path, session_name)
        if not session_id:
            raise ImportFailure("Session ID cannot be empty")

        # Conversion is intentionally performed once before any remote write so
        # malformed data cannot leave behind a partial session.
        total = count_records(csv_path, session_id, session_name)
        if not total:
            raise ImportFailure("CSV contains no data rows")

        consumed = {"timestamp"}
        for aliases in (*FIELD_ALIASES.values(), *STRING_FIELD_ALIASES.values()):
            consumed.update(aliases)
        consumed.update(DERIVED_INPUT_COLUMNS)
        ignored = [column for column in header if column not in consumed]

        print(f"File: {csv_path}")
        print(f"Session: {session_name} ({session_id})")
        print(f"Validated rows: {total:,}")
        if ignored:
            print(f"Ignored unsupported columns: {', '.join(ignored)}")
        if args.dry_run:
            print("Dry run complete; nothing was uploaded.")
            return 0

        convex_url, deploy_key, configured_batch_size = load_convex_config()
        batch_size = args.batch_size or configured_batch_size
        if not 1 <= batch_size <= 500:
            raise ImportFailure("--batch-size must be between 1 and 500")
        if args.timeout <= 0:
            raise ImportFailure("--timeout must be positive")
        if args.max_attempts < 1:
            raise ImportFailure("--max-attempts must be at least 1")

        client = ConvexHttpClient(convex_url, deploy_key, args.timeout)
        try:
            upload(
                client,
                iter_records(csv_path, session_id, session_name),
                session_id,
                total,
                batch_size,
                args.max_attempts,
            )
        finally:
            client.close()

        print(f"Upload complete: {total:,} records are available as {session_name!r}.")
        return 0
    except (EOFError, KeyboardInterrupt):
        print("\nImport cancelled.", file=sys.stderr)
        return 130
    except ImportFailure as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
