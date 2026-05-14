const API_KEY_STORAGE = "blePositionApiKey";
const REFRESH_MS = 5000;
const PROPERTY_CENTER = [33.905150, -86.053748];
const PROPERTY_ZOOM = 19;

const state = {
  positions: [],
  receivers: [],
  devices: [],
  showKnownOnly: false,
  refreshTimer: null,
  editingReceivers: false,
  map: null,
  receiverMarkers: new Map(),
  deviceLayers: new Map(),
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
  mapActionStatus: document.getElementById("mapActionStatus"),
  mapSummary: document.getElementById("mapSummary"),
  mapSurface: document.getElementById("mapSurface"),
  deviceTableSummary: document.getElementById("deviceTableSummary"),
  deviceActionStatus: document.getElementById("deviceActionStatus"),
  devicesTableBody: document.getElementById("devicesTableBody"),
  devicesEmptyState: document.getElementById("devicesEmptyState"),
  receiverTableSummary: document.getElementById("receiverTableSummary"),
  receiverActionStatus: document.getElementById("receiverActionStatus"),
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
  els.devicesTableBody.addEventListener("click", handleDeviceTableClick);
  els.receiverList.addEventListener("submit", handleReceiverRename);
  els.receiverList.addEventListener("click", handleReceiverClick);
  els.receiverList.addEventListener("focusin", () => {
    state.editingReceivers = true;
  });
  els.receiverList.addEventListener("focusout", () => {
    window.setTimeout(() => {
      state.editingReceivers = els.receiverList.contains(document.activeElement);
    }, 0);
  });

  initMap();
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

function initMap() {
  if (!window.L) {
    els.mapActionStatus.textContent = "Map library unavailable";
    return;
  }

  state.map = L.map("mapSurface", {
    zoomControl: true,
    attributionControl: true,
  }).setView(PROPERTY_CENTER, PROPERTY_ZOOM);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 20,
      attribution: "Tiles &copy; Esri",
    }
  ).addTo(state.map);
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

async function apiPatch(path, payload) {
  const response = await fetch(path, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function apiDelete(path) {
  const response = await fetch(path, {
    method: "DELETE",
    headers: authHeaders(),
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

async function handleDeviceTableClick(event) {
  const button = event.target.closest("[data-delete-device-id]");
  if (!button) return;

  const deviceId = button.dataset.deleteDeviceId;
  const label = button.dataset.deviceLabel || deviceId;
  if (!window.confirm(`Delete known device "${label}"? It will remain visible as unknown if scanned again.`)) {
    return;
  }

  els.deviceActionStatus.textContent = "Deleting";
  try {
    await apiDelete(`/devices/${encodeURIComponent(deviceId)}`);
    els.deviceActionStatus.textContent = "Deleted";
    await refreshAll();
  } catch (error) {
    els.deviceActionStatus.textContent = error.message;
  }
}

async function handleReceiverRename(event) {
  event.preventDefault();
  const form = event.target.closest("[data-receiver-id]");
  if (!form) return;

  const receiverId = form.dataset.receiverId;
  const labelInput = form.querySelector("input[name='label']");
  const latitudeInput = form.querySelector("input[name='latitude']");
  const longitudeInput = form.querySelector("input[name='longitude']");
  els.receiverActionStatus.textContent = "Saving";
  try {
    state.editingReceivers = false;
    const latitude = parseCoordinate(latitudeInput.value, -90, 90, "latitude");
    const longitude = parseCoordinate(longitudeInput.value, -180, 180, "longitude");
    await apiPatch(`/receivers/${encodeURIComponent(receiverId)}`, {
      label: labelInput.value.trim(),
      latitude,
      longitude,
    });
    els.receiverActionStatus.textContent = "Saved";
    await refreshAll();
  } catch (error) {
    els.receiverActionStatus.textContent = error.message;
  }
}

async function handleReceiverClick(event) {
  const button = event.target.closest("[data-delete-receiver-id]");
  if (!button) return;

  const receiverId = button.dataset.deleteReceiverId;
  const label = button.dataset.receiverLabel || receiverId;
  if (!window.confirm(`Delete receiver "${label}"? If that ESP32 keeps reporting, it will reappear.`)) {
    return;
  }

  els.receiverActionStatus.textContent = "Deleting";
  try {
    await apiDelete(`/receivers/${encodeURIComponent(receiverId)}`);
    els.receiverActionStatus.textContent = "Deleted";
    await refreshAll();
  } catch (error) {
    els.receiverActionStatus.textContent = error.message;
  }
}

async function saveReceiverPosition(receiverId, latlng) {
  els.mapActionStatus.textContent = "Saving receiver location";
  try {
    await apiPatch(`/receivers/${encodeURIComponent(receiverId)}`, {
      latitude: latlng.lat,
      longitude: latlng.lng,
    });
    els.mapActionStatus.textContent = "Receiver location saved";
    await refreshAll();
  } catch (error) {
    els.mapActionStatus.textContent = error.message;
  }
}

function setConnection(text, className) {
  els.connectionStatus.textContent = text;
  els.connectionStatus.className = `status-pill ${className}`;
}

function render() {
  const visibleRows = filteredDeviceRows();
  const knownCount = state.devices.filter((device) => Boolean(device.known)).length;
  const unknownCount = state.devices.length - knownCount;
  const freshCount = visibleRows.filter((row) => row.hasPosition && !row.stale).length;

  els.shownCount.textContent = String(visibleRows.length);
  els.knownCount.textContent = String(knownCount);
  els.unknownCount.textContent = String(unknownCount);
  els.freshCount.textContent = String(freshCount);
  els.receiverCount.textContent = String(state.receivers.length);

  renderDevicesTable(visibleRows);
  if (!state.editingReceivers) {
    renderReceivers();
  }
  renderMap(visibleRows.filter((row) => row.hasPosition));
}

function filteredDeviceRows() {
  const rowsById = new Map();
  for (const position of state.positions) {
    rowsById.set(position.badge_id, { ...position, hasPosition: true });
  }

  for (const device of state.devices) {
    if (!rowsById.has(device.id)) {
      rowsById.set(device.id, {
        badge_id: device.id,
        device_mac: device.mac,
        label: device.label,
        device_type: device.device_type,
        known: Boolean(device.known),
        battery_percent: device.battery_percent,
        last_seen_at: device.last_seen_at,
        stale: true,
        hasPosition: false,
      });
    }
  }

  const rows = [...rowsById.values()].sort((a, b) => {
    if (Boolean(a.stale) !== Boolean(b.stale)) {
      return a.stale ? 1 : -1;
    }
    return displayName(a).localeCompare(displayName(b));
  });
  return state.showKnownOnly
    ? rows.filter((row) => Boolean(row.known))
    : rows;
}

function renderDevicesTable(rows) {
  els.deviceTableSummary.textContent = `${rows.length} ${plural(rows.length, "device", "devices")}`;
  els.devicesTableBody.innerHTML = "";
  els.devicesEmptyState.classList.toggle("hidden", rows.length !== 0);

  const fragment = document.createDocumentFragment();
  for (const rowData of rows) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>
        <div class="device-name">
          <span class="device-title">${escapeHtml(displayName(rowData))}</span>
          <span class="device-subtitle">${escapeHtml(rowData.device_mac || rowData.badge_id || "unknown")}</span>
        </div>
      </td>
      <td>${statusTag(rowData)}</td>
      <td>${escapeHtml(rowData.device_type || "unknown")}</td>
      <td>${rowData.hasPosition ? confidenceTag(rowData.confidence) : "-"}</td>
      <td>${escapeHtml(deviceAgeLabel(rowData))}</td>
      <td>${locationCell(rowData)}</td>
      <td>${escapeHtml(receiverDisplayName(rowData.closest_receiver_id))}</td>
      <td>${rowData.hasPosition ? escapeHtml(String(rowData.receivers_used || 0)) : "-"}</td>
      <td>${batteryLabel(rowData)}</td>
      <td>${deviceActions(rowData)}</td>
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
        <span>${escapeHtml(receiverDisplayName(receiver.id))}</span>
        <span class="status-pill ${online ? "status-good" : "status-warn"}">${online ? "Online" : "Stale"}</span>
      </div>
      <div class="small-muted">${escapeHtml(receiver.id)}</div>
      <div>${numberLabel(receiver.latitude, 6)}, ${numberLabel(receiver.longitude, 6)}</div>
      <div class="small-muted">last seen ${escapeHtml(ageLabel(ageSeconds))}</div>
      <form class="receiver-actions" data-receiver-id="${escapeHtml(receiver.id)}">
        <label class="receiver-label-field">
          <span>Label</span>
          <input name="label" value="${escapeHtml(receiver.label || receiver.id)}" maxlength="80">
        </label>
        <div class="coordinate-grid">
          <label>
            <span>Latitude</span>
            <input
              name="latitude"
              inputmode="decimal"
              value="${numberLabel(receiver.latitude, 6)}"
              placeholder="33.905150"
            >
          </label>
          <label>
            <span>Longitude</span>
            <input
              name="longitude"
              inputmode="decimal"
              value="${numberLabel(receiver.longitude, 6)}"
              placeholder="-86.053748"
            >
          </label>
        </div>
        <div class="action-row">
          <button class="button button-small" type="submit">Save</button>
          <button
            class="button button-small button-danger"
            type="button"
            data-delete-receiver-id="${escapeHtml(receiver.id)}"
            data-receiver-label="${escapeHtml(receiverDisplayName(receiver.id))}"
          >Delete</button>
        </div>
      </form>
    `;
    fragment.appendChild(item);
  }
  els.receiverList.appendChild(fragment);
}

function renderMap(positions) {
  els.mapSummary.textContent = `${positions.length} ${plural(positions.length, "device", "devices")}`;
  if (!state.map) {
    return;
  }

  const activeReceivers = new Set();
  for (const receiver of state.receivers) {
    const lat = Number(receiver.latitude);
    const lng = Number(receiver.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    activeReceivers.add(receiver.id);
    const label = receiverDisplayName(receiver.id);
    const marker = state.receiverMarkers.get(receiver.id);
    const latlng = [lat, lng];
    if (marker) {
      marker.setLatLng(latlng);
      marker.setIcon(receiverIcon(Boolean(receiver.manual_position)));
      marker.bindTooltip(label, { permanent: true, direction: "top", offset: [0, -12] });
      marker.setPopupContent(receiverPopupHtml(receiver));
    } else {
      const nextMarker = L.marker(latlng, {
        draggable: true,
        icon: receiverIcon(Boolean(receiver.manual_position)),
      })
        .addTo(state.map)
        .bindTooltip(label, { permanent: true, direction: "top", offset: [0, -12] })
        .bindPopup(receiverPopupHtml(receiver));
      nextMarker.on("dragend", () => saveReceiverPosition(receiver.id, nextMarker.getLatLng()));
      state.receiverMarkers.set(receiver.id, nextMarker);
    }
  }

  for (const [receiverId, marker] of state.receiverMarkers.entries()) {
    if (!activeReceivers.has(receiverId)) {
      marker.remove();
      state.receiverMarkers.delete(receiverId);
    }
  }

  const activeDevices = new Set();
  for (const position of positions) {
    const lat = Number(position.latitude);
    const lng = Number(position.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const key = position.badge_id;
    activeDevices.add(key);
    const latlng = [lat, lng];
    const existing = state.deviceLayers.get(key);
    if (existing) {
      existing.marker.setLatLng(latlng);
      existing.radius.setLatLng(latlng);
      existing.radius.setRadius(Number(position.confidence_radius_m) || 0);
      existing.marker.setPopupContent(devicePopupHtml(position));
      existing.marker.setStyle(deviceMarkerStyle(position));
      existing.radius.setStyle(deviceRadiusStyle(position));
    } else {
      const radius = L.circle(latlng, {
        ...deviceRadiusStyle(position),
        radius: Number(position.confidence_radius_m) || 0,
      }).addTo(state.map);
      const marker = L.circleMarker(latlng, deviceMarkerStyle(position))
        .addTo(state.map)
        .bindPopup(devicePopupHtml(position));
      state.deviceLayers.set(key, { marker, radius });
    }
  }

  for (const [deviceId, layers] of state.deviceLayers.entries()) {
    if (!activeDevices.has(deviceId)) {
      layers.marker.remove();
      layers.radius.remove();
      state.deviceLayers.delete(deviceId);
    }
  }

  window.setTimeout(() => state.map.invalidateSize(), 0);
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

function receiverIcon(manualPosition) {
  return L.divIcon({
    className: `receiver-marker${manualPosition ? " manual" : ""}`,
    html: "<span></span>",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function receiverPopupHtml(receiver) {
  const source = receiver.manual_position ? "Map saved" : "ESP32 reported";
  return `
    <strong>${escapeHtml(receiverDisplayName(receiver.id))}</strong>
    <div>${escapeHtml(receiver.id)}</div>
    <div>${numberLabel(receiver.latitude, 6)}, ${numberLabel(receiver.longitude, 6)}</div>
    <div>${source}</div>
  `;
}

function devicePopupHtml(position) {
  return `
    <strong>${escapeHtml(displayName(position))}</strong>
    <div>${escapeHtml(position.device_mac || position.badge_id || "")}</div>
    <div>${escapeHtml(position.known ? "Known" : "Unknown")} ${escapeHtml(position.stale ? "stale" : "fresh")}</div>
    <div>${numberLabel(position.latitude, 6)}, ${numberLabel(position.longitude, 6)}</div>
    <div>Confidence ${escapeHtml(position.confidence || "low")}</div>
  `;
}

function deviceMarkerStyle(position) {
  return {
    radius: 7,
    color: "#ffffff",
    weight: 2,
    fillColor: position.stale ? "#9aa6b2" : position.known ? "#1f6feb" : "#a46500",
    fillOpacity: 0.95,
  };
}

function deviceRadiusStyle(position) {
  return {
    color: position.stale ? "#9aa6b2" : position.known ? "#1f6feb" : "#a46500",
    weight: 1,
    fillOpacity: 0.12,
    opacity: 0.6,
  };
}

function deviceAgeLabel(row) {
  if (row.hasPosition) return ageLabel(row.age_seconds);
  return row.last_seen_at ? ageLabel(secondsSince(row.last_seen_at)) : "-";
}

function locationCell(row) {
  if (!row.hasPosition) return "-";
  return `
    <div>${numberLabel(row.latitude, 6)}, ${numberLabel(row.longitude, 6)}</div>
    <div class="small-muted">radius ${numberLabel(row.confidence_radius_m, 0)} m</div>
  `;
}

function deviceActions(row) {
  if (!row.known) return "-";
  return `
    <button
      class="button button-small button-danger"
      type="button"
      data-delete-device-id="${escapeHtml(row.badge_id)}"
      data-device-label="${escapeHtml(displayName(row))}"
    >Delete known</button>
  `;
}

function receiverDisplayName(receiverId) {
  if (!receiverId) return "-";
  const receiver = state.receivers.find((item) => item.id === receiverId);
  return receiver?.label || receiverId;
}

function batteryLabel(row) {
  const device = state.devices.find((item) => item.id === row.badge_id);
  const battery = row.battery_percent ?? device?.battery_percent;
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

function parseCoordinate(value, min, max, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid ${label}`);
  }
  if (number < min || number > max) {
    throw new Error(`${label} out of range`);
  }
  return number;
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
