# HTTP Position Collector

Small backend for ESP32 BLE receivers. It accepts HTTP reports, stores readings
in SQLite, and calculates approximate badge positions with a weighted centroid.

No Python packages are required.

## Run

Production VPS setup is in:

```text
server/deploy/VPS_SETUP.md
```

For local development:

```sh
cd server
python3 collector.py --host 0.0.0.0 --port 8080
```

The database is created at:

```text
server/ble_positions.sqlite3
```

## Endpoints

```sh
curl http://localhost:8080/health
curl http://localhost:8080/receivers
curl http://localhost:8080/positions
curl 'http://localhost:8080/readings?limit=20'
```

If `COLLECTOR_API_KEY` or `--api-key` is set, every endpoint except `/health`
requires:

```text
X-API-Key: your-key
```

## Test Reports

Send three receiver readings for one badge:

```sh
curl -X POST http://localhost:8080/report \
  -H 'Content-Type: application/json' \
  -d '{
    "receiver_id": "north_gate",
    "receiver_lat": 34.0121,
    "receiver_lng": -86.0151,
    "reported_at_ms": 1000,
    "readings": [
      {
        "badge_id": "badge_001",
        "badge_mac": "e0:15:6b:37:a2:02",
        "seen_at_ms": 900,
        "rssi": -61,
        "movement": true,
        "battery_percent": 97,
        "tx_power_at_1m": -58,
        "button_clicks": 0
      }
    ]
  }'

curl -X POST http://localhost:8080/report \
  -H 'Content-Type: application/json' \
  -d '{
    "receiver_id": "field_house",
    "receiver_lat": 34.0138,
    "receiver_lng": -86.0122,
    "reported_at_ms": 1000,
    "readings": [
      {
        "badge_id": "badge_001",
        "badge_mac": "e0:15:6b:37:a2:02",
        "seen_at_ms": 910,
        "rssi": -74,
        "movement": true,
        "battery_percent": 97,
        "tx_power_at_1m": -58,
        "button_clicks": 0
      }
    ]
  }'

curl -X POST http://localhost:8080/report \
  -H 'Content-Type: application/json' \
  -d '{
    "receiver_id": "south_path",
    "receiver_lat": 34.0105,
    "receiver_lng": -86.0113,
    "reported_at_ms": 1000,
    "readings": [
      {
        "badge_id": "badge_001",
        "badge_mac": "e0:15:6b:37:a2:02",
        "seen_at_ms": 920,
        "rssi": -69,
        "movement": true,
        "battery_percent": 97,
        "tx_power_at_1m": -58,
        "button_clicks": 0
      }
    ]
  }'

curl http://localhost:8080/positions
```

The returned position includes `latitude`, `longitude`, `confidence`,
`confidence_radius_m`, `closest_receiver_id`, and `receivers_used`.
