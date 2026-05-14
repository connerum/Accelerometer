#!/usr/bin/env python3
"""Scan one HolyIOT BLE tag and print button clicks plus estimated speed."""

from __future__ import annotations

import argparse
import asyncio
import math
import time
from dataclasses import dataclass

from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData


HOLYIOT_SERVICE_UUID = "00005242-0000-1000-8000-00805f9b34fb"
DEFAULT_TARGET_MAC = "E0:15:6B:37:A2:02"
DEFAULT_TX_POWER_AT_1M = -58
MOVEMENT_HOLD_SECONDS = 1.2
STATUS_PRINT_SECONDS = 2.0
PATH_LOSS_EXPONENT = 2.0
SPEED_FILTER_ALPHA = 0.35
BUTTON_REPEAT_GUARD_SECONDS = 0.7


@dataclass
class TrackerState:
    start_time: float
    last_seen: float | None = None
    last_rssi: int = -127
    last_movement: bool = False
    has_movement: bool = False
    last_movement_time: float | None = None
    last_distance_m: float | None = None
    last_distance_time: float | None = None
    filtered_speed_mps: float = 0.0
    tx_power_at_1m: int = DEFAULT_TX_POWER_AT_1M
    has_tx_power_at_1m: bool = False
    last_button_click_time: float | None = None
    last_status_print_time: float = 0.0


def millis_since_start(state: TrackerState, now: float) -> int:
    return int((now - state.start_time) * 1000)


def normalize_mac(mac: str) -> str:
    return mac.strip().lower()


def signed_byte(value: int) -> int:
    return value - 256 if value >= 128 else value


def estimate_distance_meters(rssi: int, tx_power_at_1m: int) -> float:
    return 10 ** ((tx_power_at_1m - rssi) / (10 * PATH_LOSS_EXPONENT))


def movement_is_active(state: TrackerState, now: float) -> bool:
    if not state.has_movement or not state.last_movement:
        return False
    if state.last_movement_time is None:
        return False
    return now - state.last_movement_time <= MOVEMENT_HOLD_SECONDS


def update_estimated_speed(state: TrackerState, now: float, rssi: int) -> float:
    distance_m = estimate_distance_meters(rssi, state.tx_power_at_1m)

    if state.last_distance_m is None or state.last_distance_time is None:
        state.last_distance_m = distance_m
        state.last_distance_time = now
        state.filtered_speed_mps = 0.0
        return state.filtered_speed_mps

    dt_seconds = now - state.last_distance_time
    if dt_seconds <= 0:
        return state.filtered_speed_mps

    instant_speed_mps = abs(distance_m - state.last_distance_m) / dt_seconds
    state.filtered_speed_mps = (
        SPEED_FILTER_ALPHA * instant_speed_mps
        + (1.0 - SPEED_FILTER_ALPHA) * state.filtered_speed_mps
    )
    state.last_distance_m = distance_m
    state.last_distance_time = now
    return state.filtered_speed_mps


def print_speed(state: TrackerState, now: float, speed_mps: float) -> None:
    print(f"[{millis_since_start(state, now)} ms] speed={speed_mps:.2f} m/s", flush=True)


def maybe_read_ibeacon_tx_power(state: TrackerState, adv: AdvertisementData) -> None:
    apple_data = adv.manufacturer_data.get(0x004C)
    if not apple_data:
        return

    # Bleak normally strips the company ID and leaves 0x02 0x15 ... tx_power.
    if len(apple_data) >= 23 and apple_data[0] == 0x02 and apple_data[1] == 0x15:
        state.tx_power_at_1m = signed_byte(apple_data[22])
        state.has_tx_power_at_1m = True
        return

    # Tolerate payloads that still include the little-endian Apple company ID.
    if (
        len(apple_data) >= 25
        and apple_data[0] == 0x4C
        and apple_data[1] == 0x00
        and apple_data[2] == 0x02
        and apple_data[3] == 0x15
    ):
        state.tx_power_at_1m = signed_byte(apple_data[24])
        state.has_tx_power_at_1m = True


def decode_holyiot_service_data(state: TrackerState, payload: bytes, now: float) -> None:
    # HolyIOT service UUID 0x5242 payload:
    # [0]=0x41, [1]=battery, [2..7]=MAC, [10]=measurement type, [11..12]=value.
    if len(payload) != 13:
        return

    measurement_type = payload[10]
    measurement_value = payload[11]

    if measurement_type == 4:
        state.has_movement = True
        state.last_movement = measurement_value != 0
        state.last_movement_time = now if state.last_movement else None
    elif measurement_type == 6 and measurement_value == 1:
        if (
            state.last_button_click_time is None
            or now - state.last_button_click_time >= BUTTON_REPEAT_GUARD_SECONDS
        ):
            state.last_button_click_time = now
            print(f"[{millis_since_start(state, now)} ms] button=click", flush=True)


def make_detection_callback(target_mac: str, state: TrackerState):
    normalized_target = normalize_mac(target_mac)

    def on_detection(device: BLEDevice, adv: AdvertisementData) -> None:
        if normalize_mac(device.address) != normalized_target:
            return

        now = time.monotonic()
        state.last_seen = now
        state.last_rssi = adv.rssi
        maybe_read_ibeacon_tx_power(state, adv)

        payload = adv.service_data.get(HOLYIOT_SERVICE_UUID)
        if payload is not None:
            decode_holyiot_service_data(state, payload, now)

        speed_mps = update_estimated_speed(state, now, state.last_rssi)
        if not movement_is_active(state, now):
            state.last_movement = False
            state.filtered_speed_mps = 0.0
            speed_mps = 0.0

        print_speed(state, now, speed_mps)

    return on_detection


async def periodic_status(state: TrackerState) -> None:
    while True:
        await asyncio.sleep(0.25)
        now = time.monotonic()
        if now - state.last_status_print_time < STATUS_PRINT_SECONDS:
            continue

        state.last_status_print_time = now
        if not movement_is_active(state, now):
            state.last_movement = False
            state.filtered_speed_mps = 0.0

        print_speed(state, now, state.filtered_speed_mps)


async def run(args: argparse.Namespace) -> None:
    state = TrackerState(start_time=time.monotonic())
    scanner = BleakScanner(
        detection_callback=make_detection_callback(args.mac, state),
        scanning_mode="active" if args.active_scan else "passive",
    )

    async with scanner:
        await periodic_status(state)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mac", default=DEFAULT_TARGET_MAC, help="BLE tag MAC address to track")
    parser.add_argument(
        "--active-scan",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="request scan responses where supported",
    )
    return parser.parse_args()


def main() -> None:
    try:
        asyncio.run(run(parse_args()))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
