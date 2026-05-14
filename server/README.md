# HTTP Position Collector

Small backend for ESP32 BLE receivers. It accepts HTTP reports, stores readings
in SQLite, labels known devices server-side, and calculates approximate device
positions with a weighted centroid.

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

If `COLLECTOR_API_KEY` or `--api-key` is set, every endpoint except `/health`
requires `X-API-Key`.

The dashboard is served from the collector:

```text
http://localhost:8080/
```

The page stores the API key in browser local storage and uses it only for API
requests.

```sh
curl http://localhost:8080/health
curl -H 'X-API-Key: your-key' http://localhost:8080/receivers
curl -H 'X-API-Key: your-key' http://localhost:8080/positions
curl -H 'X-API-Key: your-key' http://localhost:8080/devices
curl -H 'X-API-Key: your-key' 'http://localhost:8080/readings?limit=20'
```

## Add Known Devices

ESP32 receivers report BLE MAC addresses. Known labels live on the server.

```sh
curl -X POST http://localhost:8080/devices \
  -H 'X-API-Key: your-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "mac": "45:C6:6A:F3:36:61",
    "label": "Gate Badge",
    "device_type": "tag"
  }'
```

Unknown scanned devices are created automatically with `known: false`. The
`/devices?include_unknown=0` endpoint returns only labeled known devices.

## Test Report

```sh
curl -X POST http://localhost:8080/report \
  -H 'X-API-Key: your-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "protocol_version": 2,
    "receiver_id": "north_gate",
    "receiver_lat": 34.0121,
    "receiver_lng": -86.0151,
    "reported_at_ms": 1000,
    "readings": [
      {
        "device_id": "ble:45:c6:6a:f3:36:61",
        "device_mac": "45:C6:6A:F3:36:61",
        "seen_at_ms": 900,
        "rssi": -61,
        "movement": true,
        "battery_percent": 97,
        "tx_power_at_1m": -58,
        "button_clicks": 0
      }
    ]
  }'
```

The returned position includes `latitude`, `longitude`, `confidence`,
`confidence_radius_m`, `closest_receiver_id`, `receivers_used`, `known`, and
`label`.
