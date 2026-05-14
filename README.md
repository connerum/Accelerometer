# ESP32 BLE Approximate Positioning

This project follows the simple recommended architecture:

1. BLE badge advertises.
2. Three fixed ESP32 receivers scan for the badge.
3. Each ESP32 reports RSSI readings to an HTTP backend.
4. The backend stores data in SQLite and estimates badge position with a
   smoothed weighted centroid.

This is approximate zone/location tracking, not GPS-grade triangulation.
Expect the map position to jump without field calibration.

## Backend

Production VPS:

```text
46.224.173.239
```

Use the deployment guide:

```text
server/deploy/VPS_SETUP.md
```

The ESP32 production report URL is:

```text
http://46.224.173.239/report
```

Keep that URL stable. Future backend updates should preserve `/report`, which
lets the server change without reflashing the ESP32 receivers.

For local development, run the collector on a laptop, Raspberry Pi, or small
server on the same network:

```sh
cd server
python3 collector.py --host 0.0.0.0 --port 8080
```

SQLite data is stored at:

```text
server/ble_positions.sqlite3
```

Useful endpoints:

```sh
curl http://YOUR_SERVER_IP:8080/health
curl http://YOUR_SERVER_IP:8080/receivers
curl http://YOUR_SERVER_IP:8080/positions
curl 'http://YOUR_SERVER_IP:8080/readings?limit=20'
```

## ESP32 Receiver Settings

Each ESP32 needs a unique receiver ID and fixed GPS coordinates:

```ini
build_flags =
  -D ARDUINO_USB_MODE=1
  -D ARDUINO_USB_CDC_ON_BOOT=1
  -D WIFI_SSID=\"YourWiFiName\"
  -D WIFI_PASSWORD=\"YourWiFiPassword\"
  -D REPORT_URL=\"http://46.224.173.239/report\"
  -D HTTP_API_KEY=\"YourProductionCollectorApiKey\"
  -D RECEIVER_ID=\"north_gate\"
  -D RECEIVER_LAT=34.012345
  -D RECEIVER_LNG=-86.012345
  -D BADGE_ID=\"badge_001\"
  -D TARGET_BADGE_MAC=\"e0:15:6b:37:a2:02\"
```

```ini
-D REPORT_URL=\"http://46.224.173.239/report\"
-D HTTP_API_KEY=\"6cd60369f23504945829520b4e072ab0581bf785164b7babc8a6ca9c8a72fd13\"
```

Use different `RECEIVER_ID`, `RECEIVER_LAT`, and `RECEIVER_LNG` values for the
three ESP32s.

Then flash:

```sh
pio run -t upload
```

## HTTP Payload

The ESP32 posts to `POST /report`:

```json
{
  "protocol_version": 1,
  "receiver_id": "north_gate",
  "receiver_lat": 34.012345,
  "receiver_lng": -86.012345,
  "reported_at_ms": 12345,
  "readings": [
    {
      "badge_id": "badge_001",
      "badge_mac": "e0:15:6b:37:a2:02",
      "seen_at_ms": 12001,
      "rssi": -67,
      "movement": true,
      "speed_mps": 0.32,
      "distance_m": 2.1,
      "battery_percent": 97,
      "tx_power_at_1m": -58,
      "button_clicks": 0
    }
  ]
}
```

## Positioning

The backend groups recent readings by badge over the last 5 seconds, uses the
strongest RSSI as the closest receiver, and estimates a lat/lng with a weighted
centroid. Confidence is based on how many receivers saw the badge recently:

```text
3 receivers: high
2 receivers: medium
1 receiver: low
```

The next practical step is field calibration: place the badge at known points,
record RSSI from all receivers, and tune receiver placement plus the confidence
radius.
