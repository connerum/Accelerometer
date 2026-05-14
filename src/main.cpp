#include <Arduino.h>

#include <BLEAdvertisedDevice.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEUUID.h>
#include <HTTPClient.h>
#include <WiFi.h>

#include <cmath>
#include <cstring>
#include <cctype>
#include <limits>
#include <string>

namespace {

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif

#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif

#ifndef REPORT_URL
#define REPORT_URL ""
#endif

#ifndef HTTP_API_KEY
#define HTTP_API_KEY ""
#endif

#ifndef RECEIVER_ID
#ifdef DEVICE_ID
#define RECEIVER_ID DEVICE_ID
#else
#define RECEIVER_ID "receiver_1"
#endif
#endif

#ifndef RECEIVER_LAT
#define RECEIVER_LAT 0.0
#endif

#ifndef RECEIVER_LNG
#define RECEIVER_LNG 0.0
#endif

constexpr char kReceiverId[] = RECEIVER_ID;
constexpr char kWifiSsid[] = WIFI_SSID;
constexpr char kWifiPassword[] = WIFI_PASSWORD;
constexpr char kReportUrl[] = REPORT_URL;
constexpr char kHttpApiKey[] = HTTP_API_KEY;
constexpr double kReceiverLat = RECEIVER_LAT;
constexpr double kReceiverLng = RECEIVER_LNG;
constexpr uint16_t kHolyIotServiceUuid = 0x5242;
constexpr uint32_t kScanDurationSeconds = 5;
constexpr uint32_t kStatusPrintIntervalMs = 2000;
constexpr uint32_t kHttpReportIntervalMs = 2000;
constexpr uint32_t kReceiverHeartbeatIntervalMs = 30000;
constexpr uint32_t kWifiReconnectIntervalMs = 10000;
constexpr uint16_t kHttpTimeoutMs = 1500;
constexpr uint32_t kMovementHoldMs = 1200;
constexpr uint32_t kButtonRepeatGuardMs = 700;
constexpr uint32_t kReadingStaleMs = 5000;
constexpr uint32_t kSeenPrintIntervalMs = 5000;
constexpr size_t kMaxTrackedDevices = 48;
constexpr size_t kMaxReadingsPerReport = 32;
constexpr float kPathLossExponent = 2.0f;
constexpr float kSpeedFilterAlpha = 0.35f;

struct BleReading {
  bool active = false;
  char mac[18] = "";
  uint32_t seenMs = 0;
  uint32_t lastPrintMs = 0;
  int rssi = -127;
  bool movement = false;
  bool hasMovement = false;
  uint32_t lastMovementMs = 0;
  bool hasBattery = false;
  uint8_t batteryPercent = 0;
  bool hasTxPowerAt1m = false;
  int8_t txPowerAt1m = -58;
  uint32_t buttonClicks = 0;
};

BLEScan *scan = nullptr;
uint32_t lastWifiAttemptMs = 0;
uint32_t lastWifiStatusPrintMs = 0;
uint32_t lastHttpReportMs = 0;
uint32_t lastReceiverHeartbeatMs = 0;
BleReading readings[kMaxTrackedDevices];
uint32_t lastSeenMs = 0;
int lastRssi = -127;
bool lastMovement = false;
bool hasMovement = false;
uint32_t lastMovementMs = 0;
float lastDistanceM = std::numeric_limits<float>::quiet_NaN();
uint32_t lastDistanceMs = 0;
float filteredSpeedMps = 0.0f;
float lastSpeedMps = 0.0f;
int8_t lastTxPowerAt1m = -58;
bool hasTxPowerAt1m = false;
uint8_t lastBatteryPercent = 0;
bool hasBattery = false;
uint32_t pendingButtonClicks = 0;
uint32_t lastButtonClickMs = 0;

bool httpReportingConfigured() {
  return std::strlen(kWifiSsid) > 0 && std::strlen(kReportUrl) > 0;
}

char lowerAscii(char value) {
  return static_cast<char>(std::tolower(static_cast<unsigned char>(value)));
}

bool equalsIgnoreCase(const std::string &left, const char *right) {
  if (left.length() != std::strlen(right)) {
    return false;
  }

  for (size_t i = 0; i < left.length(); ++i) {
    if (lowerAscii(left[i]) != lowerAscii(right[i])) {
      return false;
    }
  }

  return true;
}

void copyLowerMac(char *destination, const std::string &source) {
  const size_t maxLength = 17;
  const size_t length = source.length() < maxLength ? source.length() : maxLength;
  for (size_t i = 0; i < length; ++i) {
    destination[i] = lowerAscii(source[i]);
  }
  destination[length] = '\0';
}

BleReading *findOrCreateReading(const std::string &address) {
  char normalizedMac[18];
  copyLowerMac(normalizedMac, address);

  BleReading *oldest = &readings[0];
  for (auto &reading : readings) {
    if (reading.active && std::strcmp(reading.mac, normalizedMac) == 0) {
      return &reading;
    }
    if (!reading.active) {
      oldest = &reading;
      break;
    }
    if (reading.seenMs < oldest->seenMs) {
      oldest = &reading;
    }
  }

  *oldest = BleReading{};
  oldest->active = true;
  std::strncpy(oldest->mac, normalizedMac, sizeof(oldest->mac) - 1);
  oldest->mac[sizeof(oldest->mac) - 1] = '\0';
  return oldest;
}

size_t freshReadingCount(uint32_t now) {
  size_t count = 0;
  for (const auto &reading : readings) {
    if (reading.active && now - reading.seenMs <= kReadingStaleMs) {
      ++count;
    }
  }
  return count;
}

const char *wifiStatusName(wl_status_t status) {
  switch (status) {
  case WL_IDLE_STATUS:
    return "idle";
  case WL_NO_SSID_AVAIL:
    return "no_ssid_available";
  case WL_SCAN_COMPLETED:
    return "scan_completed";
  case WL_CONNECTED:
    return "connected";
  case WL_CONNECT_FAILED:
    return "connect_failed";
  case WL_CONNECTION_LOST:
    return "connection_lost";
  case WL_DISCONNECTED:
    return "disconnected";
  default:
    return "unknown";
  }
}

void printWifiStatusIfChanged(bool force = false) {
  static wl_status_t lastPrintedStatus = static_cast<wl_status_t>(255);
  const uint32_t now = millis();
  const wl_status_t status = WiFi.status();

  if (!force && status == lastPrintedStatus && now - lastWifiStatusPrintMs < 10000) {
    return;
  }

  lastPrintedStatus = status;
  lastWifiStatusPrintMs = now;

  if (status == WL_CONNECTED) {
    Serial.printf("[%lu ms] wifi=connected ip=%s rssi=%d\n", now,
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    return;
  }

  Serial.printf("[%lu ms] wifi=status status=%s code=%d\n", now,
                wifiStatusName(status), static_cast<int>(status));
}

void connectWifiIfNeeded() {
  if (!httpReportingConfigured()) {
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    printWifiStatusIfChanged();
    return;
  }

  const uint32_t now = millis();
  if (lastWifiAttemptMs != 0 && now - lastWifiAttemptMs < kWifiReconnectIntervalMs) {
    printWifiStatusIfChanged();
    return;
  }

  lastWifiAttemptMs = now;
  Serial.printf("[%lu ms] wifi=connecting ssid=%s\n", now, kWifiSsid);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(true);
  WiFi.begin(kWifiSsid, kWifiPassword);
  printWifiStatusIfChanged(true);
}

float estimateDistanceMeters(int rssi, int8_t txPowerAt1m) {
  return powf(10.0f, (txPowerAt1m - rssi) / (10.0f * kPathLossExponent));
}

float updateEstimatedSpeed(uint32_t now, int rssi) {
  const int8_t txPowerAt1m = hasTxPowerAt1m ? lastTxPowerAt1m : -58;
  const float distanceM = estimateDistanceMeters(rssi, txPowerAt1m);

  if (std::isnan(lastDistanceM) || lastDistanceMs == 0 || now <= lastDistanceMs) {
    lastDistanceM = distanceM;
    lastDistanceMs = now;
    filteredSpeedMps = 0.0f;
    return filteredSpeedMps;
  }

  const float dtSeconds = (now - lastDistanceMs) / 1000.0f;
  const float instantSpeedMps = fabsf(distanceM - lastDistanceM) / dtSeconds;
  filteredSpeedMps =
      kSpeedFilterAlpha * instantSpeedMps + (1.0f - kSpeedFilterAlpha) * filteredSpeedMps;

  lastDistanceM = distanceM;
  lastDistanceMs = now;
  return filteredSpeedMps;
}

bool movementIsActive(const BleReading &reading, uint32_t now) {
  return reading.hasMovement && reading.movement &&
         now - reading.lastMovementMs <= kMovementHoldMs;
}

bool isHolyIotService(BLEAdvertisedDevice &device, int index) {
  BLEUUID uuid = device.getServiceDataUUID(index);
  esp_bt_uuid_t *native = uuid.getNative();
  return uuid.bitSize() == 16 && native != nullptr &&
         native->uuid.uuid16 == kHolyIotServiceUuid;
}

void readIBeaconTxPowerIfPresent(BLEAdvertisedDevice &device, BleReading &reading) {
  if (!device.haveManufacturerData()) {
    return;
  }

  const std::string manufacturerData = device.getManufacturerData();
  const auto *data =
      reinterpret_cast<const uint8_t *>(manufacturerData.data());
  const size_t length = manufacturerData.length();

  if (length < 25 || data[0] != 0x4C || data[1] != 0x00 || data[2] != 0x02 ||
      data[3] != 0x15) {
    return;
  }

  reading.txPowerAt1m = static_cast<int8_t>(data[24]);
  reading.hasTxPowerAt1m = true;
}

void decodeHolyIotServiceData(BleReading &reading, const std::string &serviceData,
                              uint32_t now) {
  const auto *data = reinterpret_cast<const uint8_t *>(serviceData.data());
  const size_t length = serviceData.length();

  // Arduino's BLE library strips the AD length/type and UUID from service data.
  // HolyIOT's remaining payload is:
  // [0]=0x41, [1]=battery, [2..7]=MAC, [10]=measurement type, [11..12]=value.
  if (length != 13) {
    return;
  }

  reading.batteryPercent = data[1];
  reading.hasBattery = true;
  const uint8_t measurementType = data[10];

  switch (measurementType) {
  case 4:
    reading.hasMovement = true;
    reading.movement = data[11] != 0;
    reading.lastMovementMs = reading.movement ? now : 0;
    break;
  case 6:
    if (data[11] == 1 &&
        (lastButtonClickMs == 0 || now - lastButtonClickMs >= kButtonRepeatGuardMs)) {
      lastButtonClickMs = now;
      ++reading.buttonClicks;
      ++pendingButtonClicks;
      Serial.printf("[%lu ms] button=click mac=%s\n", now, reading.mac);
    }
    break;
  }
}

void appendJsonString(String &payload, const char *value) {
  payload += '"';
  for (const char *cursor = value; *cursor != '\0'; ++cursor) {
    if (*cursor == '"' || *cursor == '\\') {
      payload += '\\';
    }
    payload += *cursor;
  }
  payload += '"';
}

String buildReportJson(uint32_t buttonClicks, bool includeReading) {
  String payload;
  payload.reserve(4096);
  const uint32_t now = millis();

  payload += "{\"protocol_version\":2,\"receiver_id\":";
  appendJsonString(payload, kReceiverId);
  payload += ",\"receiver_lat\":";
  payload += String(kReceiverLat, 7);
  payload += ",\"receiver_lng\":";
  payload += String(kReceiverLng, 7);
  payload += ",\"reported_at_ms\":";
  payload += String(millis());

  if (!includeReading) {
    payload += ",\"readings\":[]}";
    return payload;
  }

  payload += ",\"readings\":[";
  size_t appended = 0;
  for (const auto &reading : readings) {
    if (!reading.active || now - reading.seenMs > kReadingStaleMs) {
      continue;
    }
    if (appended >= kMaxReadingsPerReport) {
      break;
    }

    if (appended > 0) {
      payload += ',';
    }

    payload += "{\"device_id\":\"ble:";
    payload += reading.mac;
    payload += "\",\"device_mac\":";
    appendJsonString(payload, reading.mac);
    payload += ",\"badge_id\":\"ble:";
    payload += reading.mac;
    payload += "\",\"badge_mac\":";
    appendJsonString(payload, reading.mac);
    payload += ",\"seen_at_ms\":";
    payload += String(reading.seenMs);
    payload += ",\"rssi\":";
    payload += String(reading.rssi);
    payload += ",\"movement\":";
    payload += movementIsActive(reading, now) ? "true" : "false";
    payload += ",\"battery_percent\":";
    if (reading.hasBattery) {
      payload += String(reading.batteryPercent);
    } else {
      payload += "null";
    }
    payload += ",\"tx_power_at_1m\":";
    if (reading.hasTxPowerAt1m) {
      payload += String(reading.txPowerAt1m);
    } else {
      payload += "null";
    }
    payload += ",\"button_clicks\":";
    payload += String(reading.buttonClicks);
    payload += "}";
    ++appended;
  }
  payload += "]}";

  return payload;
}

void sendHttpReport(bool force) {
  if (!httpReportingConfigured()) {
    return;
  }

  connectWifiIfNeeded();
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  const uint32_t now = millis();
  const bool hasFreshReading = freshReadingCount(now) > 0;
  if (!hasFreshReading && now - lastReceiverHeartbeatMs < kReceiverHeartbeatIntervalMs) {
    return;
  }

  const uint32_t buttonClicks = pendingButtonClicks;
  if (hasFreshReading && !force && buttonClicks == 0 &&
      now - lastHttpReportMs < kHttpReportIntervalMs) {
    return;
  }

  for (auto &reading : readings) {
    if (reading.active && !movementIsActive(reading, now)) {
      reading.movement = false;
    }
  }

  HTTPClient http;
  http.setTimeout(kHttpTimeoutMs);
  if (!http.begin(kReportUrl)) {
    Serial.printf("[%lu ms] http=begin_failed\n", now);
    return;
  }

  const String payload = buildReportJson(buttonClicks, hasFreshReading);
  http.addHeader("Content-Type", "application/json");
  if (std::strlen(kHttpApiKey) > 0) {
    http.addHeader("X-API-Key", kHttpApiKey);
  }
  const int statusCode = http.POST(payload);
  http.end();

  if (statusCode >= 200 && statusCode < 300) {
    if (hasFreshReading) {
      lastHttpReportMs = now;
    } else {
      lastReceiverHeartbeatMs = now;
    }
    if (buttonClicks > 0) {
      pendingButtonClicks -= buttonClicks;
      for (auto &reading : readings) {
        reading.buttonClicks = 0;
      }
    }
    Serial.printf("[%lu ms] http=reported status=%d\n", now, statusCode);
  } else {
    Serial.printf("[%lu ms] http=failed status=%d\n", now, statusCode);
  }
}

class TargetCallbacks final : public BLEAdvertisedDeviceCallbacks {
public:
  void onResult(BLEAdvertisedDevice device) override {
    const std::string address = device.getAddress().toString();
    BleReading *reading = findOrCreateReading(address);
    if (reading == nullptr) {
      return;
    }

    const uint32_t now = millis();
    reading->seenMs = now;
    reading->rssi = device.getRSSI();
    lastSeenMs = now;
    lastRssi = reading->rssi;
    if (now - reading->lastPrintMs >= kSeenPrintIntervalMs) {
      reading->lastPrintMs = now;
      Serial.printf("[%lu ms] ble=seen mac=%s rssi=%d\n", now, reading->mac,
                    reading->rssi);
    }
    readIBeaconTxPowerIfPresent(device, *reading);

    for (int i = 0; i < device.getServiceDataCount(); ++i) {
      if (isHolyIotService(device, i)) {
        decodeHolyIotServiceData(*reading, device.getServiceData(i), now);
      }
    }
  }
};

TargetCallbacks callbacks;

void printLiveStatus() {
  static uint32_t lastStatusPrintMs = 0;
  const uint32_t now = millis();
  if (now - lastStatusPrintMs < kStatusPrintIntervalMs) {
    return;
  }

  lastStatusPrintMs = now;

  Serial.printf("[%lu ms] ble=fresh_devices count=%u\n", now,
                static_cast<unsigned>(freshReadingCount(now)));
}

} // namespace

void setup() {
  Serial.begin(115200);
  delay(1500);

  if (httpReportingConfigured()) {
    connectWifiIfNeeded();
  } else {
    Serial.println("http=disabled; set WIFI_SSID and REPORT_URL build flags to enable");
  }

  BLEDevice::init("esp-c3-holyiot-scanner");
  scan = BLEDevice::getScan();
  scan->setAdvertisedDeviceCallbacks(&callbacks, true);
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(100);
}

void loop() {
  printLiveStatus();
  sendHttpReport(false);
  scan->start(kScanDurationSeconds, false);
  scan->clearResults();
  sendHttpReport(pendingButtonClicks > 0);
}
