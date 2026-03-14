'use strict';

const socket = io();

const deviceStore = {};
const rfidHistory = [];
const rawMessages = [];
const alerts = [];
const charts = {};
const fleetCharts = {
  battery: null,
  signal: null,
  throughput: null,
};
let rfidTodayCount = 0;

// ── CLOCK ──────────────────────────────────────────────
function tickClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString();
}
setInterval(tickClock, 1000);
tickClock();

// ── MQTT STATUS ────────────────────────────────────────
socket.on('mqtt:status', ({ connected, reconnecting }) => {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  dot.className = 'status-dot';
  if (connected) {
    dot.classList.add('online');
    txt.textContent = 'Broker Connected';
  } else if (reconnecting) {
    dot.classList.add('reconnecting');
    txt.textContent = 'Reconnecting…';
  } else {
    dot.classList.add('offline');
    txt.textContent = 'Disconnected';
  }
});

// ── INITIAL STORE ──────────────────────────────────────
socket.on('store:init', ({ devices, rfidHistory: hist, rawMessages: rawHist, alerts: alertHist }) => {
  Object.assign(deviceStore, devices);
  if (hist && hist.length) {
    rfidHistory.push(...hist);
    rfidTodayCount = rfidHistory.length;
  }
  if (rawHist && rawHist.length) rawMessages.push(...rawHist);
  if (alertHist && alertHist.length) alerts.push(...alertHist);
  renderAll();
});

// ── LIVE UPDATES ───────────────────────────────────────
socket.on('device:update', ({ deviceId, device }) => {
  deviceStore[deviceId] = device;
  renderDeviceCard(deviceId, device);
  updateStats();
});

socket.on('device:rfid', ({ data }) => {
  rfidTodayCount++;
  rfidHistory.unshift(data);
  if (rfidHistory.length > 500) rfidHistory.pop();
  prependRfidRow(data);
  document.getElementById('rfidCount').textContent = rfidHistory.length;
  document.getElementById('statRfidToday').textContent = rfidTodayCount;
});

socket.on('mqtt:raw', (row) => {
  rawMessages.unshift(row);
  if (rawMessages.length > 500) rawMessages.pop();
  prependRawRow(row);
  document.getElementById('rawCount').textContent = rawMessages.length;
});

socket.on('alerts:update', (list) => {
  alerts.length = 0;
  alerts.push(...list);
  renderAlerts();
  document.getElementById('statAlerts').textContent = alerts.length;
  document.getElementById('alertCount').textContent = alerts.length;
});

// ── RENDER ALL ─────────────────────────────────────────
function renderAll() {
  const ids = Object.keys(deviceStore);
  if (ids.length) {
    document.getElementById('devicesGrid').innerHTML = '';
    ids.forEach((id) => renderDeviceCard(id, deviceStore[id]));
  }
  renderRfidTable();
  renderRawTable();
  renderAlerts();
  renderFleetMatrix();
  updateStats();
}

// ── STATS ──────────────────────────────────────────────
function updateStats() {
  const ids = Object.keys(deviceStore);
  const now = Date.now();
  const onlineIds = ids.filter((id) => {
    const ls = deviceStore[id].lastSeen;
    return ls && now - new Date(ls).getTime() < 60_000;
  });
  const bats = ids
    .map((id) => deviceStore[id]?.heartbeat?.battery)
    .filter((b) => b != null && !Number.isNaN(b));
  const avgBat =
    bats.length ? Math.round(bats.reduce((a, b) => a + b, 0) / bats.length) : null;
  const onlineRatio = ids.length ? Math.round((onlineIds.length / ids.length) * 100) : 0;
  const alertPressure = ids.length ? Math.min(100, Math.round((alerts.length / ids.length) * 100)) : 0;

  document.getElementById('statTotal').textContent = ids.length;
  document.getElementById('statOnline').textContent = onlineIds.length;
  document.getElementById('statAvgBattery').textContent =
    avgBat != null ? `${avgBat}%` : '—';
  document.getElementById('deviceCount').textContent = ids.length;
  document.getElementById('statAlerts').textContent = alerts.length;

  updateHealthBars(onlineRatio, avgBat || 0, alertPressure);
  updateFleetOverview(ids);
}

function updateHealthBars(onlineRatio, avgBattery, alertPressure) {
  document.getElementById('healthOnlineValue').textContent = `${onlineRatio}%`;
  document.getElementById('healthBatteryValue').textContent = `${avgBattery}%`;
  document.getElementById('healthAlertValue').textContent = `${alertPressure}%`;
  document.getElementById('healthOnlineBar').style.width = `${onlineRatio}%`;
  document.getElementById('healthBatteryBar').style.width = `${avgBattery}%`;
  document.getElementById('healthAlertBar').style.width = `${alertPressure}%`;
}

function updateFleetOverview(ids) {
  const batteryBuckets = [0, 0, 0]; // low, med, high
  const signalBuckets = [0, 0, 0, 0]; // poor, fair, good, excellent

  ids.forEach((id) => {
    const hb = deviceStore[id] && deviceStore[id].heartbeat ? deviceStore[id].heartbeat : {};

    const battery = hb.battery != null ? Number(hb.battery) : null;
    if (battery != null && !Number.isNaN(battery)) {
      if (battery < 30) batteryBuckets[0] += 1;
      else if (battery < 70) batteryBuckets[1] += 1;
      else batteryBuckets[2] += 1;
    }

    const rssi = hb.rssi ?? hb.signal ?? null;
    if (rssi != null && !Number.isNaN(Number(rssi))) {
      const n = Number(rssi);
      if (n < -85) signalBuckets[0] += 1;
      else if (n < -75) signalBuckets[1] += 1;
      else if (n < -65) signalBuckets[2] += 1;
      else signalBuckets[3] += 1;
    }
  });

  renderFleetDonut(
    'battery',
    document.getElementById('fleetBatteryChart'),
    ['Low', 'Medium', 'High'],
    batteryBuckets,
    ['#ef4444', '#f59e0b', '#22c55e']
  );

  renderFleetDonut(
    'signal',
    document.getElementById('fleetSignalChart'),
    ['Poor', 'Fair', 'Good', 'Excellent'],
    signalBuckets,
    ['#ef4444', '#f59e0b', '#38bdf8', '#22c55e']
  );

  renderThroughputChart();
}

function renderThroughputChart() {
  const canvas = document.getElementById('throughputChart');
  if (!canvas) return;

  const bucketSizeMs = 60 * 1000;
  const now = Date.now();
  const buckets = [];
  for (let i = 14; i >= 0; i--) {
    buckets.push({
      start: now - i * bucketSizeMs,
      count: 0,
    });
  }

  rawMessages.forEach((row) => {
    const ts = row && row.receivedAt ? new Date(row.receivedAt).getTime() : 0;
    if (!ts || now - ts > 15 * bucketSizeMs) return;
    const index = Math.floor((now - ts) / bucketSizeMs);
    const bucketIdx = buckets.length - 1 - index;
    if (bucketIdx >= 0 && bucketIdx < buckets.length) buckets[bucketIdx].count += 1;
  });

  const labels = buckets.map((b) => new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const values = buckets.map((b) => b.count);

  if (fleetCharts.throughput) {
    fleetCharts.throughput.data.labels = labels;
    fleetCharts.throughput.data.datasets[0].data = values;
    fleetCharts.throughput.update();
    return;
  }

  fleetCharts.throughput = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Messages/min',
        data: values,
        borderColor: '#00c2ff',
        backgroundColor: 'rgba(0,194,255,0.18)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      }],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          ticks: { color: '#93a1b8', maxTicksLimit: 8 },
          grid: { color: 'rgba(147,161,184,0.12)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#93a1b8', precision: 0 },
          grid: { color: 'rgba(147,161,184,0.12)' },
        },
      },
    },
  });
}

function renderFleetDonut(key, canvas, labels, values, colors) {
  if (!canvas) return;
  const total = values.reduce((a, b) => a + b, 0);
  const dataValues = total ? values : values.map(() => 1);

  if (fleetCharts[key]) {
    fleetCharts[key].data.labels = labels;
    fleetCharts[key].data.datasets[0].data = dataValues;
    fleetCharts[key].data.datasets[0].backgroundColor = colors;
    fleetCharts[key].update();
    return;
  }

  fleetCharts[key] = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: dataValues,
        backgroundColor: colors,
        borderColor: '#111827',
        borderWidth: 2,
      }],
    },
    options: {
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#93a1b8', boxWidth: 10, boxHeight: 10, font: { size: 11 } },
        },
      },
      maintainAspectRatio: false,
      cutout: '64%',
      animation: false,
    },
  });
}

// Keep "last seen" text fresh every 20s without full re-render
setInterval(() => {
  document.querySelectorAll('[data-last-seen]').forEach((el) => {
    el.textContent = timeAgo(el.dataset.lastSeen);
  });
}, 20_000);

// ── DEVICE CARD ────────────────────────────────────────
function renderDeviceCard(deviceId, device) {
  const grid = document.getElementById('devicesGrid');
  const placeholder = grid.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  // Destroy stale chart before wiping innerHTML
  if (charts[deviceId]) {
    charts[deviceId].destroy();
    delete charts[deviceId];
  }

  const isOnline =
    device.lastSeen && Date.now() - new Date(device.lastSeen).getTime() < 60_000;
  const hb = device.heartbeat || {};
  const wifi = device.wifi || {};
  const safe = sanitizeId(deviceId);

  let card = document.getElementById(`card-${safe}`);
  if (!card) {
    card = document.createElement('div');
    card.id = `card-${safe}`;
    grid.appendChild(card);
  }
  card.className = `device-card ${isOnline ? 'online' : 'offline'}`;

  const bat = hb.battery != null ? Number(hb.battery) : null;
  const batClass = bat == null ? '' : bat >= 60 ? 'high' : bat >= 30 ? 'med' : 'low';
  const batColor = bat == null ? '' : bat >= 60 ? 'green' : bat >= 30 ? 'yellow' : 'red';

  const rssi = hb.rssi ?? hb.signal ?? null;
  const ignition = hb.acc != null ? String(hb.acc) : '—';
  const speed = hb.speed ?? hb.gps_speed ?? null;
  const gsm = hb.gsm ?? null;
  const satellites = hb.satelites ?? hb.satellites ?? null;
  const lat = hb.lat ?? hb.latitude ?? null;
  const lng = hb.lng ?? hb.longitude ?? null;
  const mapLink = lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : null;
  const wifiSsid = wifi.ssid ?? (wifi.config && wifi.config.ssid) ?? null;
  const wifiIp = wifi.ip ?? null;
  const wifiRssi = wifi.rssi ?? null;
  const wifiChannel = wifi.channel ?? (wifi.config && wifi.config.channel) ?? null;
  const wifiBssid = wifi.bssid ?? (wifi.config && wifi.config.macaddr) ?? null;
  const wifiConnected =
    wifi.connected != null ? Boolean(wifi.connected) : (wifi.clients_num != null ? Number(wifi.clients_num) >= 0 : null);
  const wifiClients = wifi.clients_num ?? (Array.isArray(wifi.clients_info) ? wifi.clients_info.length : null);
  const bars = rssiToBars(rssi);

  card.innerHTML = `
    <div class="card-header">
      <div class="device-id">${esc(deviceId)}</div>
      <span class="online-badge ${isOnline ? 'online' : 'offline'}">
        ${isOnline ? 'Online' : 'Offline'}
      </span>
    </div>

    <div class="metrics">
      <div class="metric">
        <div class="metric-label">Last Seen</div>
        <div class="metric-value sm"
             data-last-seen="${device.lastSeen || ''}">${device.lastSeen ? timeAgo(device.lastSeen) : '—'}</div>
      </div>

      <div class="metric">
        <div class="metric-label">Signal (RSSI)</div>
        <div class="metric-value sm ${rssi ? 'blue' : ''}">${rssi != null ? `${rssi} dBm` : '—'}</div>
        <div style="margin-top:5px">${badgeBars(bars)}</div>
      </div>

      ${hb.uptime != null ? `
      <div class="metric">
        <div class="metric-label">Uptime</div>
        <div class="metric-value sm">${formatUptime(hb.uptime)}</div>
      </div>` : ''}

      ${hb.firmware ? `
      <div class="metric">
        <div class="metric-label">Firmware</div>
        <div class="metric-value sm" style="color:var(--muted)">${esc(hb.firmware)}</div>
      </div>` : ''}

      <div class="metric">
        <div class="metric-label">Ignition</div>
        <div class="metric-value sm">${esc(ignition)}</div>
      </div>

      <div class="metric">
        <div class="metric-label">Speed</div>
        <div class="metric-value sm ${speed != null ? 'blue' : ''}">${speed != null ? `${speed} km/h` : '—'}</div>
      </div>

      <div class="metric">
        <div class="metric-label">GSM</div>
        <div class="metric-value sm">${gsm != null ? esc(gsm) : '—'}</div>
      </div>

      <div class="metric">
        <div class="metric-label">Satellites</div>
        <div class="metric-value sm">${satellites != null ? esc(satellites) : '—'}</div>
      </div>
    </div>

    ${bat != null ? `
    <div class="battery-wrap">
      <div class="battery-label">
        <span>Battery</span>
        <span class="${batColor}">${bat}%</span>
      </div>
      <div class="battery-track">
        <div class="battery-fill ${batClass}" style="width:${bat}%"></div>
      </div>
    </div>` : ''}

    ${lat != null && lng != null ? `
    <div class="divider"></div>
    <div class="metric-label">Location</div>
    <div class="coords">
      <span class="coord-chip">Lat: ${lat}</span>
      <span class="coord-chip">Lng: ${lng}</span>
      ${mapLink ? `<a class="map-link" href="${mapLink}" target="_blank" rel="noopener">Open Map</a>` : ''}
    </div>` : ''}

    ${wifiSsid ? `
    <div class="divider"></div>
    <div class="metric-label">WiFi</div>
    <div class="wifi-rows">
      <div class="wifi-row">
        <span class="wifi-key">SSID</span>
        <span class="wifi-val">${esc(wifiSsid)}</span>
      </div>
      ${wifiIp ? `<div class="wifi-row"><span class="wifi-key">IP</span><span class="wifi-val">${esc(wifiIp)}</span></div>` : ''}
      ${wifiRssi != null ? `<div class="wifi-row"><span class="wifi-key">WiFi RSSI</span><span class="wifi-val">${wifiRssi} dBm</span></div>` : ''}
      ${wifiChannel != null ? `<div class="wifi-row"><span class="wifi-key">Channel</span><span class="wifi-val">${wifiChannel}</span></div>` : ''}
      ${wifiBssid ? `<div class="wifi-row"><span class="wifi-key">BSSID</span><span class="wifi-val mono">${esc(wifiBssid)}</span></div>` : ''}
      ${wifiClients != null ? `<div class="wifi-row"><span class="wifi-key">Clients</span><span class="wifi-val">${wifiClients}</span></div>` : ''}
      ${wifiConnected != null ? `<div class="wifi-row"><span class="wifi-key">Status</span>
        <span class="wifi-val" style="color:${wifiConnected ? 'var(--green)' : 'var(--red)'}">
          ${wifiConnected ? 'Connected' : 'Disconnected'}
        </span></div>` : ''}
    </div>` : ''}

    ${device.batteryHistory && device.batteryHistory.length > 1 ? `
    <div class="divider"></div>
    <div class="metric-label" style="margin-bottom:8px">Battery History</div>
    <div class="chart-wrap">
      <canvas id="chart-${safe}"></canvas>
    </div>` : ''}
  `;

  if (device.batteryHistory && device.batteryHistory.length > 1) {
    renderBatteryChart(deviceId, device.batteryHistory);
  }
}

// ── ALERTS ────────────────────────────────────────────
function renderAlerts() {
  const root = document.getElementById('alertsList');
  if (!alerts.length) {
    root.innerHTML = '<div class="placeholder">No active alerts</div>';
    return;
  }

  root.innerHTML = alerts.slice(0, 30).map((alert) => `
    <div class="alert-item ${esc(alert.severity || 'medium')}">
      <div>
        <div class="alert-title">${esc(alert.rule)} · ${esc(alert.deviceId)}</div>
        <div class="alert-meta">${esc(alert.message || '')}</div>
      </div>
      <div class="alert-time">${timeAgo(alert.createdAt)}</div>
    </div>
  `).join('');
}

function renderFleetMatrix() {
  const tbody = document.getElementById('fleetMatrixBody');
  const ids = Object.keys(deviceStore);
  document.getElementById('matrixCount').textContent = ids.length;

  if (!ids.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-row">No devices yet</td></tr>';
    return;
  }

  const alertsByDevice = alerts.reduce((acc, alert) => {
    const k = alert.deviceId || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  tbody.innerHTML = ids.map((id) => {
    const d = deviceStore[id] || {};
    const hb = d.heartbeat || {};
    const wifi = d.wifi || {};
    const isOnline = d.lastSeen && Date.now() - new Date(d.lastSeen).getTime() < 60_000;
    const battery = hb.battery != null ? Number(hb.battery) : null;
    const signal = hb.rssi ?? hb.signal ?? null;
    const ignition = hb.acc || '—';
    const speed = hb.speed ?? hb.gps_speed;
    const sat = hb.satelites ?? hb.satellites;
    const ssid = wifi.ssid ?? (wifi.config && wifi.config.ssid) ?? '—';
    const alertCount = alertsByDevice[id] || 0;

    const batteryPct = battery == null || Number.isNaN(battery) ? 0 : Math.max(0, Math.min(100, battery));
    const batteryClass = batteryPct >= 60 ? 'good' : batteryPct >= 30 ? 'warn' : 'bad';

    return `
      <tr>
        <td>${esc(id)}</td>
        <td><span class="status-pill ${isOnline ? 'online' : 'offline'}">${isOnline ? 'Online' : 'Offline'}</span></td>
        <td>${d.lastSeen ? esc(timeAgo(d.lastSeen)) : '—'}</td>
        <td>
          <span class="mini-bar"><span class="mini-fill ${batteryClass}" style="width:${batteryPct}%"></span></span>
          ${battery != null && !Number.isNaN(battery) ? `${battery}%` : '—'}
        </td>
        <td>${signal != null ? `${signal} dBm` : '—'}</td>
        <td>${esc(String(ignition))}</td>
        <td>${speed != null ? `${speed} km/h` : '—'}</td>
        <td>${sat != null ? sat : '—'}</td>
        <td><span class="matrix-chip">${esc(String(ssid))}</span></td>
        <td>${alertCount ? `<span class="matrix-chip alert">${alertCount}</span>` : '<span class="matrix-chip">0</span>'}</td>
      </tr>
    `;
  }).join('');
}

// ── RAW MQTT TABLE ────────────────────────────────────
function renderRawTable() {
  const tbody = document.getElementById('rawTableBody');
  if (!rawMessages.length) return;
  tbody.innerHTML = '';
  rawMessages.slice(0, 80).forEach((row) => tbody.appendChild(buildRawRow(row)));
  document.getElementById('rawCount').textContent = rawMessages.length;
}

function prependRawRow(row) {
  const tbody = document.getElementById('rawTableBody');
  const empty = tbody.querySelector('.empty-row');
  if (empty) empty.closest('tr').remove();
  tbody.insertBefore(buildRawRow(row), tbody.firstChild);
  while (tbody.rows.length > 80) tbody.deleteRow(tbody.rows.length - 1);
}

function buildRawRow(row) {
  const tr = document.createElement('tr');
  const payload = row && row.payload ? JSON.stringify(row.payload) : '{}';
  const deviceId =
    (row && row.payload && (row.payload.deviceId || row.payload.device_id || row.payload.imei)) || '—';
  tr.innerHTML = `
    <td>${esc(row && row.receivedAt ? new Date(row.receivedAt).toLocaleTimeString() : '—')}</td>
    <td>${esc(row && row.topic ? row.topic : '—')}</td>
    <td>${esc(row && row.type ? row.type : '—')}</td>
    <td>${esc(deviceId)}</td>
    <td class="payload-cell" title="${esc(payload)}">${esc(shorten(payload, 140))}</td>
  `;
  return tr;
}

// ── BATTERY SPARKLINE ──────────────────────────────────
function renderBatteryChart(deviceId, history) {
  const canvas = document.getElementById(`chart-${sanitizeId(deviceId)}`);
  if (!canvas) return;
  charts[deviceId] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: history.map((p) => new Date(p.t).toLocaleTimeString()),
      datasets: [{
        data: history.map((p) => p.v),
        borderColor: '#6c63ff',
        backgroundColor: 'rgba(108,99,255,0.12)',
        borderWidth: 2,
        pointRadius: 2,
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { min: 0, max: 100, display: false },
      },
      animation: false,
    },
  });
}

// ── RFID TABLE ─────────────────────────────────────────
function renderRfidTable() {
  const tbody = document.getElementById('rfidTableBody');
  if (!rfidHistory.length) return;
  tbody.innerHTML = '';
  rfidHistory.slice(0, 50).forEach((scan) => tbody.appendChild(buildRfidRow(scan)));
  document.getElementById('rfidCount').textContent = rfidHistory.length;
}

function prependRfidRow(scan) {
  const tbody = document.getElementById('rfidTableBody');
  const empty = tbody.querySelector('.empty-row');
  if (empty) empty.closest('tr').remove();
  const row = buildRfidRow(scan);
  row.classList.add('new-row');
  tbody.insertBefore(row, tbody.firstChild);
  while (tbody.rows.length > 50) tbody.deleteRow(tbody.rows.length - 1);
}

function buildRfidRow(scan) {
  const tr = document.createElement('tr');
  const time = scan.receivedAt
    ? new Date(scan.receivedAt).toLocaleTimeString()
    : '—';
  tr.innerHTML = `
    <td>${esc(time)}</td>
    <td>${esc(scan.deviceId || '—')}</td>
    <td class="tag-id">${esc(scan.tagId || scan.tag_id || '—')}</td>
    <td>${esc(scan.readerName || scan.reader || '—')}</td>
    <td>${esc(scan.location || '—')}</td>
  `;
  return tr;
}

// ── HELPERS ────────────────────────────────────────────
function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 5)    return 'Just now';
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function rssiToBars(rssi) {
  if (rssi == null) return 0;
  if (rssi >= -50) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  if (rssi >= -85) return 1;
  return 0;
}

function badgeBars(count) {
  const heights = [4, 7, 10, 14];
  return `<div class="signal-bars">${heights
    .map((h, i) => `<div class="signal-bar${i < count ? ' lit' : ''}" style="height:${h}px"></div>`)
    .join('')}</div>`;
}

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, '_');
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shorten(str, maxLen) {
  return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
}
