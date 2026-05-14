# VPS Production Setup

Target server:

```text
46.224.173.239
```

The ESP32s should report to this stable URL:

```text
http://46.224.173.239/report
```

Keep this URL stable. Future backend updates can change the Python app,
database schema, frontend, or nginx routing without reflashing ESP32s.

## 1. Install Packages

SSH into the VPS as root or a sudo user:

```sh
ssh root@46.224.173.239
```

Install runtime packages:

```sh
apt update
apt install -y python3 nginx ufw rsync sqlite3
```

## 2. Create App User And Directories

```sh
useradd --system --home /opt/ble-positioning --shell /usr/sbin/nologin blepos
mkdir -p /opt/ble-positioning /var/lib/ble-positioning
chown -R blepos:blepos /opt/ble-positioning /var/lib/ble-positioning
```

## 3. Upload This Project

From your Mac:

```sh
rsync -av --delete \
  --exclude '.pio' \
  --exclude '.vscode' \
  --exclude '__pycache__' \
  /Users/connerum/Documents/PlatformIO/Projects/Accelerometer/ \
  root@46.224.173.239:/opt/ble-positioning/
```

On the VPS:

```sh
chown -R blepos:blepos /opt/ble-positioning
```

## 4. Configure API Key

Generate a key on the VPS:

```sh
API_KEY="$(openssl rand -hex 32)"
printf 'COLLECTOR_API_KEY=%s\n' "$API_KEY" > /etc/ble-positioning.env
chmod 600 /etc/ble-positioning.env
cat /etc/ble-positioning.env
```

Use that exact value in the ESP32 `HTTP_API_KEY` build flag.

## 5. Install systemd Service

```sh
cp /opt/ble-positioning/server/deploy/ble-position.service /etc/systemd/system/ble-position.service
systemctl daemon-reload
systemctl enable --now ble-position.service
systemctl status ble-position.service --no-pager
```

## 6. Install nginx Reverse Proxy

```sh
cp /opt/ble-positioning/server/deploy/nginx-ble-positioning.conf /etc/nginx/sites-available/ble-positioning
ln -sf /etc/nginx/sites-available/ble-positioning /etc/nginx/sites-enabled/ble-positioning
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

## 7. Firewall

```sh
ufw allow OpenSSH
ufw allow 80/tcp
ufw --force enable
ufw status
```

Do not expose port `8080`. The collector listens only on `127.0.0.1`; nginx is
the public entry point.

## 8. Test Production

Health is public:

```sh
curl http://46.224.173.239/health
```

Protected endpoints need the API key:

```sh
. /etc/ble-positioning.env
curl -H "X-API-Key: $COLLECTOR_API_KEY" http://46.224.173.239/positions
```

Test one receiver report:

```sh
curl -X POST http://46.224.173.239/report \
  -H "X-API-Key: $COLLECTOR_API_KEY" \
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
```

## 9. ESP32 Production Build Flags

Set these before flashing each ESP32:

```ini
build_flags =
  -D ARDUINO_USB_MODE=1
  -D ARDUINO_USB_CDC_ON_BOOT=1
  -D WIFI_SSID=\"YourWiFiName\"
  -D WIFI_PASSWORD=\"YourWiFiPassword\"
  -D REPORT_URL=\"http://46.224.173.239/report\"
  -D HTTP_API_KEY=\"PASTE_COLLECTOR_API_KEY_HERE\"
  -D RECEIVER_ID=\"north_gate\"
  -D RECEIVER_LAT=34.012345
  -D RECEIVER_LNG=-86.012345
  -D BADGE_ID=\"badge_001\"
  -D TARGET_BADGE_MAC=\"e0:15:6b:37:a2:02\"
```

Only `RECEIVER_ID`, `RECEIVER_LAT`, and `RECEIVER_LNG` should differ between
the three ESP32 receivers.

## 10. Server-Only Updates

To update the backend later without touching ESP32s:

```sh
rsync -av --delete \
  --exclude '.pio' \
  --exclude '.vscode' \
  --exclude '__pycache__' \
  /Users/connerum/Documents/PlatformIO/Projects/Accelerometer/ \
  root@46.224.173.239:/opt/ble-positioning/

ssh root@46.224.173.239 'chown -R blepos:blepos /opt/ble-positioning && systemctl restart ble-position.service'
```

Keep `REPORT_URL` as `http://46.224.173.239/report` and keep the same
`COLLECTOR_API_KEY`; then ESP32s do not need updates.
