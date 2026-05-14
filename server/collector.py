#!/usr/bin/env python3
"""HTTP + SQLite backend for ESP32 BLE receiver readings."""

from __future__ import annotations

import argparse
import hmac
import json
import math
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


DEFAULT_DB_PATH = Path(__file__).with_name("ble_positions.sqlite3")
STATIC_DIR = Path(__file__).with_name("static")
DEFAULT_WINDOW_SECONDS = 5.0
METERS_PER_DEGREE_LAT = 111_320.0


SCHEMA = """
CREATE TABLE IF NOT EXISTS receivers (
    id TEXT PRIMARY KEY,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS badges (
    id TEXT PRIMARY KEY,
    mac TEXT,
    label TEXT,
    device_type TEXT NOT NULL DEFAULT 'unknown',
    known INTEGER NOT NULL DEFAULT 0,
    battery_percent INTEGER,
    created_at TEXT,
    updated_at TEXT,
    last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS badge_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    badge_id TEXT NOT NULL,
    badge_mac TEXT,
    receiver_id TEXT NOT NULL,
    rssi INTEGER NOT NULL,
    receiver_latitude REAL NOT NULL,
    receiver_longitude REAL NOT NULL,
    receiver_x REAL NOT NULL,
    receiver_y REAL NOT NULL,
    battery_percent INTEGER,
    movement INTEGER NOT NULL,
    tx_power_at_1m INTEGER,
    button_clicks INTEGER NOT NULL DEFAULT 0,
    receiver_seen_at_ms INTEGER,
    received_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS badge_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    badge_id TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    confidence TEXT NOT NULL,
    confidence_radius_m REAL NOT NULL,
    method TEXT NOT NULL,
    closest_receiver_id TEXT,
    receivers_used INTEGER NOT NULL,
    last_seen_at TEXT NOT NULL,
    calculated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_readings_badge_time
    ON badge_readings(badge_id, received_at);
CREATE INDEX IF NOT EXISTS idx_positions_badge_time
    ON badge_positions(badge_id, calculated_at);
"""


class PositionStore:
    def __init__(self, db_path: Path, window_seconds: float) -> None:
        self.db_path = db_path
        self.window_seconds = window_seconds
        self._init_db()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _init_db(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            self._migrate_db(connection)

    def _migrate_db(self, connection: sqlite3.Connection) -> None:
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(badges)").fetchall()
        }
        migrations = {
            "mac": "ALTER TABLE badges ADD COLUMN mac TEXT",
            "device_type": (
                "ALTER TABLE badges ADD COLUMN device_type TEXT NOT NULL DEFAULT 'unknown'"
            ),
            "known": "ALTER TABLE badges ADD COLUMN known INTEGER NOT NULL DEFAULT 0",
            "created_at": "ALTER TABLE badges ADD COLUMN created_at TEXT",
            "updated_at": "ALTER TABLE badges ADD COLUMN updated_at TEXT",
        }
        for column, statement in migrations.items():
            if column not in columns:
                connection.execute(statement)

        now = utc_now()
        connection.execute(
            "UPDATE badges SET created_at = COALESCE(created_at, ?), updated_at = COALESCE(updated_at, ?)",
            (now, now),
        )

    def origin(self, connection: sqlite3.Connection) -> tuple[float, float] | None:
        row = connection.execute(
            "SELECT latitude, longitude FROM receivers ORDER BY first_seen_at LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return float(row["latitude"]), float(row["longitude"])

    def xy_from_lat_lng(
        self,
        latitude: float,
        longitude: float,
        origin_lat: float,
        origin_lng: float,
    ) -> tuple[float, float]:
        meters_per_degree_lng = METERS_PER_DEGREE_LAT * math.cos(math.radians(origin_lat))
        x = (longitude - origin_lng) * meters_per_degree_lng
        y = (latitude - origin_lat) * METERS_PER_DEGREE_LAT
        return x, y

    def lat_lng_from_xy(
        self,
        x: float,
        y: float,
        origin_lat: float,
        origin_lng: float,
    ) -> tuple[float, float]:
        meters_per_degree_lng = METERS_PER_DEGREE_LAT * math.cos(math.radians(origin_lat))
        latitude = origin_lat + y / METERS_PER_DEGREE_LAT
        longitude = origin_lng + x / meters_per_degree_lng
        return latitude, longitude

    def upsert_receiver(
        self,
        connection: sqlite3.Connection,
        receiver_id: str,
        latitude: float,
        longitude: float,
        now: str,
    ) -> tuple[float, float]:
        existing_origin = self.origin(connection)
        origin_lat, origin_lng = existing_origin or (latitude, longitude)
        x, y = self.xy_from_lat_lng(latitude, longitude, origin_lat, origin_lng)

        connection.execute(
            """
            INSERT INTO receivers (
                id, latitude, longitude, x, y, first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                latitude = excluded.latitude,
                longitude = excluded.longitude,
                x = excluded.x,
                y = excluded.y,
                last_seen_at = excluded.last_seen_at
            """,
            (receiver_id, latitude, longitude, x, y, now, now),
        )
        return x, y

    def insert_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        receiver_id = require_text(payload, "receiver_id")
        receiver_lat = require_float(payload, "receiver_lat")
        receiver_lng = require_float(payload, "receiver_lng")
        readings = payload.get("readings")
        if not isinstance(readings, list):
            raise ValueError("readings must be a list")

        now = utc_now()
        raw_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        updated_badges: set[str] = set()

        with self.connect() as connection:
            receiver_x, receiver_y = self.upsert_receiver(
                connection, receiver_id, receiver_lat, receiver_lng, now
            )

            for reading in readings:
                if not isinstance(reading, dict):
                    raise ValueError("each reading must be an object")

                device_mac = normalize_mac(
                    optional_text(reading.get("device_mac"))
                    or optional_text(reading.get("badge_mac"))
                )
                badge_id = (
                    device_id_for_mac(device_mac)
                    if device_mac is not None
                    else require_text(reading, "badge_id")
                )
                rssi = require_int(reading, "rssi")
                battery_percent = optional_int(reading.get("battery_percent"))

                connection.execute(
                    """
                    INSERT INTO badges (
                        id,
                        mac,
                        label,
                        device_type,
                        known,
                        battery_percent,
                        created_at,
                        updated_at,
                        last_seen_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        mac = COALESCE(excluded.mac, badges.mac),
                        battery_percent = COALESCE(excluded.battery_percent, badges.battery_percent),
                        updated_at = excluded.updated_at,
                        last_seen_at = excluded.last_seen_at
                    """,
                    (
                        badge_id,
                        device_mac,
                        badge_id,
                        "unknown",
                        0,
                        battery_percent,
                        now,
                        now,
                        now,
                    ),
                )

                connection.execute(
                    """
                    INSERT INTO badge_readings (
                        badge_id,
                        badge_mac,
                        receiver_id,
                        rssi,
                        receiver_latitude,
                        receiver_longitude,
                        receiver_x,
                        receiver_y,
                        battery_percent,
                        movement,
                        tx_power_at_1m,
                        button_clicks,
                        receiver_seen_at_ms,
                        received_at,
                        raw_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        badge_id,
                        device_mac,
                        receiver_id,
                        rssi,
                        receiver_lat,
                        receiver_lng,
                        receiver_x,
                        receiver_y,
                        battery_percent,
                        int(bool(reading.get("movement", False))),
                        optional_int(reading.get("tx_power_at_1m")),
                        optional_int(reading.get("button_clicks")) or 0,
                        optional_int(reading.get("seen_at_ms")),
                        now,
                        raw_json,
                    ),
                )
                updated_badges.add(badge_id)

            positions = [
                self.calculate_position(connection, badge_id)
                for badge_id in sorted(updated_badges)
            ]

        return {
            "ok": True,
            "readings": len(readings),
            "positions": [position for position in positions if position is not None],
        }

    def calculate_position(
        self,
        connection: sqlite3.Connection,
        badge_id: str,
    ) -> dict[str, Any] | None:
        since = (
            datetime.now(timezone.utc) - timedelta(seconds=self.window_seconds)
        ).isoformat()

        rows = connection.execute(
            """
            SELECT br.*
            FROM badge_readings br
            INNER JOIN (
                SELECT receiver_id, MAX(received_at) AS latest_received_at
                FROM badge_readings
                WHERE badge_id = ? AND received_at >= ?
                GROUP BY receiver_id
            ) latest
                ON latest.receiver_id = br.receiver_id
               AND latest.latest_received_at = br.received_at
            WHERE br.badge_id = ?
            """,
            (badge_id, since, badge_id),
        ).fetchall()

        if not rows:
            return None

        total_weight = 0.0
        weighted_x = 0.0
        weighted_y = 0.0
        closest = max(rows, key=lambda row: int(row["rssi"]))

        for row in rows:
            weight = rssi_to_weight(int(row["rssi"]))
            total_weight += weight
            weighted_x += float(row["receiver_x"]) * weight
            weighted_y += float(row["receiver_y"]) * weight

        if total_weight <= 0:
            return None

        x = weighted_x / total_weight
        y = weighted_y / total_weight

        previous = connection.execute(
            """
            SELECT x, y
            FROM badge_positions
            WHERE badge_id = ?
            ORDER BY calculated_at DESC
            LIMIT 1
            """,
            (badge_id,),
        ).fetchone()
        if previous is not None:
            x, y = smooth_position(
                (float(previous["x"]), float(previous["y"])),
                (x, y),
            )

        origin = self.origin(connection)
        if origin is None:
            return None
        latitude, longitude = self.lat_lng_from_xy(x, y, origin[0], origin[1])

        receivers_used = len(rows)
        confidence, confidence_radius_m = confidence_for_receivers(receivers_used)
        now = utc_now()
        last_seen_at = max(str(row["received_at"]) for row in rows)

        connection.execute(
            """
            INSERT INTO badge_positions (
                badge_id,
                latitude,
                longitude,
                x,
                y,
                confidence,
                confidence_radius_m,
                method,
                closest_receiver_id,
                receivers_used,
                last_seen_at,
                calculated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                badge_id,
                latitude,
                longitude,
                x,
                y,
                confidence,
                confidence_radius_m,
                "weighted_centroid",
                str(closest["receiver_id"]),
                receivers_used,
                last_seen_at,
                now,
            ),
        )

        return {
            "badge_id": badge_id,
            "latitude": latitude,
            "longitude": longitude,
            "x": x,
            "y": y,
            "confidence": confidence,
            "confidence_radius_m": confidence_radius_m,
            "method": "weighted_centroid",
            "closest_receiver_id": str(closest["receiver_id"]),
            "receivers_used": receivers_used,
            "last_seen_at": last_seen_at,
            "calculated_at": now,
        }

    def latest_positions(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    bp.*,
                    b.mac AS device_mac,
                    b.label AS label,
                    b.device_type AS device_type,
                    b.known AS known
                FROM badge_positions bp
                LEFT JOIN badges b ON b.id = bp.badge_id
                INNER JOIN (
                    SELECT badge_id, MAX(calculated_at) AS latest_calculated_at
                    FROM badge_positions
                    GROUP BY badge_id
                ) latest
                    ON latest.badge_id = bp.badge_id
                   AND latest.latest_calculated_at = bp.calculated_at
                ORDER BY bp.badge_id
                """
            ).fetchall()

        now = datetime.now(timezone.utc)
        positions = []
        for row in rows:
            item = dict(row)
            calculated_at = parse_utc_iso(str(item["calculated_at"]))
            age_seconds = max(0.0, (now - calculated_at).total_seconds())
            item["age_seconds"] = age_seconds
            item["stale"] = age_seconds > self.window_seconds
            item["known"] = bool(item.get("known", False))
            positions.append(item)
        return positions

    def receivers(self) -> list[dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT id, latitude, longitude, x, y, first_seen_at, last_seen_at
                FROM receivers
                ORDER BY id
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def recent_readings(self, limit: int) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 500))
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    br.id,
                    br.badge_id,
                    br.badge_mac,
                    br.receiver_id,
                    br.rssi,
                    br.battery_percent,
                    br.movement,
                    br.button_clicks,
                    br.received_at,
                    b.label,
                    b.device_type,
                    b.known
                FROM badge_readings br
                LEFT JOIN badges b ON b.id = br.badge_id
                ORDER BY br.id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()

        readings = []
        for row in rows:
            item = dict(row)
            item["movement"] = bool(item["movement"])
            item["known"] = bool(item.get("known", False))
            readings.append(item)
        return readings

    def devices(self, include_unknown: bool = True) -> list[dict[str, Any]]:
        where = "" if include_unknown else "WHERE known = 1"
        with self.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT
                    id,
                    mac,
                    label,
                    device_type,
                    known,
                    battery_percent,
                    created_at,
                    updated_at,
                    last_seen_at
                FROM badges
                {where}
                ORDER BY known DESC, label COLLATE NOCASE, id
                """
            ).fetchall()

        devices = []
        for row in rows:
            item = dict(row)
            item["known"] = bool(item["known"])
            devices.append(item)
        return devices

    def upsert_known_device(self, payload: dict[str, Any]) -> dict[str, Any]:
        mac = normalize_mac(require_text(payload, "mac"))
        if mac is None:
            raise ValueError("invalid mac")
        now = utc_now()
        device_id = optional_text(payload.get("id")) or device_id_for_mac(mac)
        label = optional_text(payload.get("label")) or device_id
        device_type = optional_text(payload.get("device_type")) or "tag"

        with self.connect() as connection:
            existing = connection.execute(
                "SELECT id FROM badges WHERE lower(mac) = ? OR id = ? LIMIT 1",
                (mac, device_id),
            ).fetchone()
            if existing is not None:
                device_id = str(existing["id"])

            connection.execute(
                """
                INSERT INTO badges (
                    id,
                    mac,
                    label,
                    device_type,
                    known,
                    created_at,
                    updated_at,
                    last_seen_at
                ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    mac = excluded.mac,
                    label = excluded.label,
                    device_type = excluded.device_type,
                    known = 1,
                    updated_at = excluded.updated_at,
                    last_seen_at = COALESCE(badges.last_seen_at, excluded.last_seen_at)
                """,
                (device_id, mac, label, device_type, now, now, now),
            )

        return {
            "ok": True,
            "device": {
                "id": device_id,
                "mac": mac,
                "label": label,
                "device_type": device_type,
                "known": True,
            },
        }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_utc_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def rssi_to_weight(rssi: int) -> float:
    return 10 ** (rssi / 10)


def smooth_position(
    previous: tuple[float, float],
    current: tuple[float, float],
    alpha: float = 0.25,
) -> tuple[float, float]:
    return (
        alpha * current[0] + (1.0 - alpha) * previous[0],
        alpha * current[1] + (1.0 - alpha) * previous[1],
    )


def confidence_for_receivers(receivers_used: int) -> tuple[str, float]:
    if receivers_used >= 3:
        return "high", 15.0
    if receivers_used == 2:
        return "medium", 25.0
    return "low", 40.0


def require_text(payload: dict[str, Any], field: str) -> str:
    value = optional_text(payload.get(field))
    if value is None:
        raise ValueError(f"missing required field: {field}")
    return value


def optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_mac(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip().lower().replace("-", ":")
    compact = text.replace(":", "")
    if len(compact) != 12:
        return None
    try:
        int(compact, 16)
    except ValueError:
        return None
    return ":".join(compact[index : index + 2] for index in range(0, 12, 2))


def device_id_for_mac(mac: str) -> str:
    return f"ble:{mac}"


def require_float(payload: dict[str, Any], field: str) -> float:
    value = payload.get(field)
    if value is None:
        raise ValueError(f"missing required field: {field}")
    return float(value)


def require_int(payload: dict[str, Any], field: str) -> int:
    value = payload.get(field)
    if value is None:
        raise ValueError(f"missing required field: {field}")
    return int(value)


def optional_int(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)


class CollectorHandler(BaseHTTPRequestHandler):
    store: PositionStore
    api_key: str | None = None

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path in ("", "/"):
            self.write_static(STATIC_DIR / "index.html")
            return

        if parsed.path.startswith("/static/"):
            static_root = STATIC_DIR.resolve()
            static_path = (STATIC_DIR / parsed.path.removeprefix("/static/")).resolve()
            try:
                static_path.relative_to(static_root)
            except ValueError:
                self.write_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            self.write_static(static_path)
            return

        if parsed.path == "/health":
            self.write_json({"ok": True})
            return

        if not self.authorized():
            self.write_json({"error": "unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return

        if parsed.path == "/positions":
            self.write_json({"positions": self.store.latest_positions()})
            return

        if parsed.path == "/receivers":
            self.write_json({"receivers": self.store.receivers()})
            return

        if parsed.path == "/devices":
            query = parse_qs(parsed.query)
            include_unknown = query.get("include_unknown", ["1"])[0] not in ("0", "false", "False")
            self.write_json({"devices": self.store.devices(include_unknown)})
            return

        if parsed.path in ("/readings", "/reports"):
            query = parse_qs(parsed.query)
            limit = optional_int(query.get("limit", ["100"])[0]) or 100
            self.write_json({"readings": self.store.recent_readings(limit)})
            return

        self.write_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed_path = urlparse(self.path).path
        if parsed_path not in ("/report", "/devices"):
            self.write_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return

        if not self.authorized():
            self.write_json({"error": "unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return

        try:
            payload = self.read_json_body()
            if not isinstance(payload, dict):
                raise ValueError("request body must be a JSON object")
            if parsed_path == "/devices":
                response = self.store.upsert_known_device(payload)
            else:
                response = self.store.insert_payload(payload)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError, TypeError) as exc:
            self.write_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return

        self.write_json(response, HTTPStatus.CREATED)

    def authorized(self) -> bool:
        if not self.api_key:
            return True
        supplied = self.headers.get("X-API-Key", "")
        return hmac.compare_digest(supplied, self.api_key)

    def read_json_body(self) -> Any:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise ValueError("empty request body")
        if content_length > 8192:
            raise ValueError("request body too large")
        body = self.rfile.read(content_length).decode("utf-8")
        return json.loads(body)

    def write_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_static(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.write_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return

        content_type = "application/octet-stream"
        if path.suffix == ".html":
            content_type = "text/html; charset=utf-8"
        elif path.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif path.suffix == ".js":
            content_type = "application/javascript; charset=utf-8"
        elif path.suffix == ".svg":
            content_type = "image/svg+xml"

        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0", help="address to listen on")
    parser.add_argument("--port", type=int, default=8080, help="port to listen on")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH, help="SQLite database path")
    parser.add_argument(
        "--api-key",
        default=os.environ.get("COLLECTOR_API_KEY"),
        help="optional API key required in the X-API-Key header",
    )
    parser.add_argument(
        "--window-seconds",
        type=float,
        default=DEFAULT_WINDOW_SECONDS,
        help="recent reading window used for position estimates",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    store = PositionStore(args.db, args.window_seconds)

    class Handler(CollectorHandler):
        pass

    Handler.store = store
    Handler.api_key = args.api_key
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"listening on http://{args.host}:{args.port}")
    print(f"writing data to {args.db}")
    print(f"api key required: {'yes' if args.api_key else 'no'}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
