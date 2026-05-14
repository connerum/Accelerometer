const API_KEY_STORAGE = "blePositionApiKey";
const REFRESH_MS = 5000;

const state = {
  positions: [],
  receivers: [],
  devices: [],
  showKnownOnly: false,
  refreshTimer: null,
};

const els = {
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveKeyButton: document.getElementById("saveKeyButton"),
  refreshButton: document.getElementById("refreshButton"),
  knownOnlyButton: document.getElementById("knownOnlyButton"),
  allDevicesButton: document.getElementById("allDevicesButton"),
  connectionStatus: document.getElementById("connectionStatus"),
  lastRefresh: document.getElementById("lastRefresh"),
  shownCount: document.getElementById("shownCount"),
  knownCount: document.getElementById("knownCount"),
  unknownCount: document.getElementById("unknownCount"),
  freshCount: document.getElementById("freshCount"),
  receiverCount: document.getElementById("receiverCount"),
  mapSummary: document.getElementById("mapSummary"),
  mapSurface: document.getElementById("mapSurface"),
  deviceTableSummary: document.getElementById("deviceTableSummary"),
  devicesTableBody: document.getElementById("devicesTableBody"),
  devicesEmptyState: document.getElementById("devicesEmptyState"),
  receiverTableSummary: document.getElementById("receiverTableSummary"),
  receiverList: document.getElementById("receiverList"),
  knownDeviceForm: document.getElementById("knownDeviceForm"),
  deviceMacInput: document.getElementById("deviceMacInput"),
  deviceLabelInput: document.getElementById("deviceLabelInput"),
  deviceTypeInput: document.getElementById("deviceTypeInput"),
  deviceSaveStatus: document.getElementById("deviceSaveStatus"),
};

function init() {
  els.apiKeyInput.value = localStorage.getItem(API_KEY_STORAGE) || "";

  els.saveKeyButton.addEventListener("click", saveApiKey);
  els.refreshButton.addEventListener("click", refreshAll);
  els.knownOnlyButton.addEventListener("click", () => setFilter(true));
  els.allDevicesButton.addEventListener("click", () => setFilter(false));
  els.knownDeviceForm.addEventListener("submit", saveKnownDevice);

  render();
  refreshAll();
  state.refreshTimer = window.setInterval(refreshAll, REFRESH_MS);
}

function saveApiKey() {
  localStorage.setItem(API_KEY_STORAGE, els.apiKeyInput.value.trim());
  refreshAll();
}

function setFilter(showKnownOnly) {
  state.showKnownOnly = showKnownOnly;
  els.knownOnlyButton.classList.toggle("active", showKnownOnly);
  els.allDevicesButton.classList.toggle("active", !showKnownOnly);
  render();
}

function authHeaders(extraHeaders = {}) {
  const apiKey = els.apiKeyInput.value.trim();
  return apiKey ? { ...extraHeaders, "X-API-Key": apiKey } : extraHeaders;
}

async function apiGet(path) {
  const response = await fetch(path, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function apiPost(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function refreshAll() {
  setConnection("Loading", "status-muted");
  try {
    const [positions, receivers, devices] = await Promise.all([
      apiGet("/positions"),
      apiGet("/receivers"),
      apiGet("/devices"),
    ]);
    state.positions = positions.positions || [];
    state.receivers = receivers.receivers || [];
    state.devices = devices.devices || [];
    setConnection("Live", "status-good");
    els.lastRefresh.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    render();
  } catch (error) {
    setConnection("API error", "status-bad");
    els.lastRefresh.textContent = error.message;
  }
}

async function saveKnownDevice(event) {
  event.preventDefault();
  els.deviceSaveStatus.textContent = "Saving";
  try {
    await apiPost("/devices", {
      mac: els.deviceMacInput.value.trim(),
      label: els.deviceLabelInput.value.trim(),
      device_type: els.deviceTypeInput.value,
    });
    els.knownDeviceForm.reset();
    els.deviceTypeInput.value = "tag";
    els.deviceSaveStatus.textContent = "Saved";
    await refreshAll();
  } catch (error) {
    els.deviceSaveStatus.textContent = error.message;
  }
}

function setConnection(text, className) {
  els.connectionStatus.textContent = text;
  els.connectionStatus.className = `status-pill ${className}`;
}

function render() {
  const filteredPositions = filteredDevices();
  const knownCount = state.positions.filter((position) => Boolean(position.known)).length;
  const unknownCount = state.positions.length - knownCount;
  const freshCount = filteredPositions.filter((position) => !position.stale).length;

  els.shownCount.textContent = String(filteredPositions.length);
  els.knownCount.textContent = String(knownCount);
  els.unknownCount.textContent = String(unknownCount);
  els.freshCount.textContent = String(freshCount);
  els.receiverCount.textContent = String(state.receivers.length);

  renderDevicesTable(filteredPositions);
  renderReceivers();
  renderMap(filteredPositions);
}

function filteredDevices() {
  const positions = [...state.positions].sort((a, b) => {
    if (Boolean(a.stale) !== Boolean(b.stale)) {
      return a.stale ? 1 : -1;
    }
    return displayName(a).localeCompare(displayName(b));
  });
  return state.showKnownOnly
    ? positions.filter((position) => Boolean(position.known))
    : positions;
}

function renderDevicesTable(positions) {
  els.deviceTableSummary.textContent = `${positions.length} ${plural(positions.length, "device", "devices")}`;
  els.devicesTableBody.innerHTML = "";
  els.devicesEmptyState.classList.toggle("hidden", positions.length !== 0);

  const fragment = document.createDocumentFragment();
  for (const position of positions) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>
        <div class="device-name">
          <span class="device-title">${escapeHtml(displayName(position))}</span>
          <span class="device-subtitle">${escapeHtml(position.device_mac || position.badge_id || "unknown")}</span>
        </div>
      </td>
      <td>${statusTag(position)}</td>
      <td>${escapeHtml(position.device_type || "unknown")}</td>
      <td>${confidenceTag(position.confidence)}</td>
      <td>${escapeHtml(ageLabel(position.age_seconds))}</td>
      <td>
        <div>${numberLabel(position.latitude, 6)}, ${numberLabel(position.longitude, 6)}</div>
        <div class="small-muted">radius ${numberLabel(position.confidence_radius_m, 0)} m</div>
      </td>
      <td>${escapeHtml(position.closest_receiver_id || "-")}</td>
      <td>${escapeHtml(String(position.receivers_used || 0))}</td>
      <td>${batteryLabel(position)}</td>
    `;
    fragment.appendChild(row);
  }
  els.devicesTableBody.appendChild(fragment);
}

function renderReceivers() {
  els.receiverTableSummary.textContent = `${state.receivers.length} ${plural(state.receivers.length, "receiver", "receivers")}`;
  els.receiverList.innerHTML = "";

  if (state.receivers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No receivers online.";
    els.receiverList.appendChild(empty);
    return;
  }

  const now = Date.now();
  const fragment = document.createDocumentFragment();
  for (const receiver of state.receivers) {
    const ageSeconds = secondsSince(receiver.last_seen_at, now);
    const online = ageSeconds < 45;
    const item = document.createElement("article");
    item.className = "receiver-item";
    item.innerHTML = `
      <div class="receiver-title">
        <span>${escapeHtml(receiver.id)}</span>
        <span class="status-pill ${online ? "status-good" : "status-warn"}">${online ? "Online" : "Stale"}</span>
      </div>
      <div>${numberLabel(receiver.latitude, 6)}, ${numberLabel(receiver.longitude, 6)}</div>
      <div class="small-muted">last seen ${escapeHtml(ageLabel(ageSeconds))}</div>
    `;
    fragment.appendChild(item);
  }
  els.receiverList.appendChild(fragment);
}

function renderMap(positions) {
  els.mapSurface.innerHTML = "";
  els.mapSummary.textContent = `${positions.length} ${plural(positions.length, "device", "devices")}`;

  const points = [
    ...state.receivers.map((receiver) => ({
      type: "receiver",
      label: receiver.id,
      lat: Number(receiver.latitude),
      lng: Number(receiver.longitude),
    })),
    ...positions.map((position) => ({
      type: "device",
      label: displayName(position),
      lat: Number(position.latitude),
      lng: Number(position.longitude),
      known: Boolean(position.known),
      stale: Boolean(position.stale),
    })),
  ].filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  if (points.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No plotted points.";
    els.mapSurface.appendChild(empty);
    return;
  }

  const bounds = paddedBounds(points);
  const fragment = document.createDocumentFragment();
  for (const point of points) {
    const x = ((point.lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * 86 + 7;
    const y = (1 - (point.lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * 82 + 9;
    const pointEl = document.createElement("span");
    const classes = ["map-point", point.type];
    if (point.type === "device" && !point.known) classes.push("unknown");
    if (point.stale) classes.push("stale");
    pointEl.className = classes.join(" ");
    pointEl.style.setProperty("--x", `${x}%`);
    pointEl.style.setProperty("--y", `${y}%`);
    pointEl.title = point.label;

    const label = document.createElement("span");
    label.className = "map-label";
    label.style.setProperty("--x", `${x}%`);
    label.style.setProperty("--y", `${y}%`);
    label.textContent = point.label;

    fragment.appendChild(pointEl);
    fragment.appendChild(label);
  }
  els.mapSurface.appendChild(fragment);
}

function paddedBounds(points) {
  let minLat = Math.min(...points.map((point) => point.lat));
  let maxLat = Math.max(...points.map((point) => point.lat));
  let minLng = Math.min(...points.map((point) => point.lng));
  let maxLng = Math.max(...points.map((point) => point.lng));

  if (minLat === maxLat) {
    minLat -= 0.0002;
    maxLat += 0.0002;
  }
  if (minLng === maxLng) {
    minLng -= 0.0002;
    maxLng += 0.0002;
  }

  const latPad = (maxLat - minLat) * 0.18;
  const lngPad = (maxLng - minLng) * 0.18;
  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLng: minLng - lngPad,
    maxLng: maxLng + lngPad,
  };
}

function displayName(position) {
  if (position.label && position.label !== position.badge_id) return position.label;
  return position.badge_id || position.device_mac || "Unknown device";
}

function statusTag(position) {
  const known = Boolean(position.known);
  const stateClass = known ? "tag-known" : "tag-unknown";
  const label = known ? "Known" : "Unknown";
  const stale = position.stale ? " stale" : "";
  return `<span class="tag ${stateClass}">${label}${stale}</span>`;
}

function confidenceTag(confidence) {
  const value = confidence || "low";
  return `<span class="tag confidence-${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function batteryLabel(position) {
  const device = state.devices.find((item) => item.id === position.badge_id);
  const battery = device?.battery_percent;
  return battery === null || battery === undefined ? "-" : `${escapeHtml(String(battery))}%`;
}

function ageLabel(seconds) {
  if (!Number.isFinite(Number(seconds))) return "-";
  const value = Math.max(0, Number(seconds));
  if (value < 1) return "now";
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  return `${Math.round(value / 3600)}h`;
}

function secondsSince(isoValue, nowMs = Date.now()) {
  const timestamp = Date.parse(isoValue);
  if (!Number.isFinite(timestamp)) return Infinity;
  return Math.max(0, (nowMs - timestamp) / 1000);
}

function numberLabel(value, digits) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "-";
}

function plural(count, singular, pluralValue) {
  return count === 1 ? singular : pluralValue;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init();
