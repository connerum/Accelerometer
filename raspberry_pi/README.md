# Raspberry Pi BLE HolyIOT Tracker

Run this on a Raspberry Pi 5 to scan the HolyIOT BLE tag directly.

## Setup

```sh
cd raspberry_pi
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

If scanning fails with permissions errors, run with `sudo -E` or add your user to the Bluetooth-capable setup used by your Pi OS image.

## Run

```sh
python3 holyiot_tracker.py
```

Default target MAC:

```text
E0:15:6B:37:A2:02
```

Override it if needed:

```sh
python3 holyiot_tracker.py --mac E0:15:6B:37:A2:02
```

The script prints only:

```text
[12345 ms] speed=0.00 m/s
[23456 ms] button=click
```

Speed is an RSSI/iBeacon-distance estimate, not true accelerometer velocity. The HolyIOT passive broadcast exposes shake/vibration status, not raw XYZ accelerometer samples.
