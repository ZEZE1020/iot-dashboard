'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.DASHBOARD_PORT || 3000;
const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const USERNAME = process.env.MQTT_USERNAME || '';
const PASSWORD = process.env.MQTT_PASSWORD || '';
const CLIENT_ID = `numeral-dashboard-${Math.random().toString(16).slice(2, 8)}`;
const LOW_BATTERY_THRESHOLD = Number(process.env.ALERT_LOW_BATTERY || 20);
const OFFLINE_SECONDS = Number(process.env.ALERT_OFFLINE_SECONDS || 120);
const NO_HEARTBEAT_SECONDS = Number(process.env.ALERT_NO_HEARTBEAT_SECONDS || 90);

// In-memory state
const deviceStore = {};
const rfidHistory = [];
const heartbeatHistory = [];
const wifiHistory = [];
const rawMessages = [];
const alertsByKey = {};
const MAX_HISTORY = 1000;

app.use(express.static(path.join(__dirname, '../public')));
app.get('/api/devices', (_req, res) => res.json(deviceStore));
app.get('/api/rfid', (_req, res) => res.json(rfidHistory.slice(0, 200)));
app.get('/api/raw', (_req, res) => res.json(rawMessages.slice(0, 200)));
app.get('/api/alerts', (_req, res) => res.json(currentAlerts()));
app.get('/api/export/:stream', (req, res) => {
  const stream = String(req.params.stream || '').toLowerCase();
  const format = String(req.query.format || 'json').toLowerCase();
  const rows = getStreamRows(stream);

  if (!rows) {
    res.status(400).json({ error: 'invalid stream. use heartbeat|wifi|rfid' });
    return;
  }

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stream}.csv"`);
    res.send(toCsv(rows));
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${stream}.json"`);
  res.send(JSON.stringify(rows, null, 2));
});

// MQTT
const mqttClient = mqtt.connect(BROKER_URL, {
  clientId: CLIENT_ID,
  clean: true,
  reconnectPeriod: 5000,
  connectTimeout: 30000,
  ...(USERNAME && { username: USERNAME }),
  ...(PASSWORD && { password: PASSWORD }),
});

const TOPICS = [
  'topic/transittag/heartbeat/#',
  '/topic/transittag/heartbeat/#',
  'topic/transittag/wifi/#',
  '/topic/transittag/wifi/#',
  'topic/transittag/rfid/#',
  '/topic/transittag/rfid/#',
  // Some devices may publish with this misspelling.
  'topic/tranisttag/heartbeat/#',
  '/topic/tranisttag/heartbeat/#',
  'topic/tranisttag/wifi/#',
  '/topic/tranisttag/wifi/#',
  'topic/tranisttag/rfid/#',
  '/topic/tranisttag/rfid/#',
];

function normalizeTopic(topic) {
  return String(topic).trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

function topicType(topic) {
  const normalized = normalizeTopic(topic);
  if (normalized.includes('transittag/heartbeat') || normalized.includes('tranisttag/heartbeat')) {
    return 'heartbeat';
  }
  if (normalized.includes('transittag/wifi') || normalized.includes('tranisttag/wifi')) {
    return 'wifi';
  }
  if (normalized.includes('transittag/rfid') || normalized.includes('tranisttag/rfid')) {
    return 'rfid';
  }
  return 'other';
}

function pushLimited(arr, value, limit = MAX_HISTORY) {
  arr.unshift(value);
  if (arr.length > limit) arr.pop();
}

function getStreamRows(stream) {
  if (stream === 'heartbeat') return heartbeatHistory;
  if (stream === 'wifi') return wifiHistory;
  if (stream === 'rfid') return rfidHistory;
  return null;
}

function flattenObject(input, prefix = '', out = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    out[prefix || 'value'] = input;
    return out;
  }

  Object.keys(input).forEach((key) => {
    const value = input[key];
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenObject(value, nextKey, out);
    } else if (Array.isArray(value)) {
      out[nextKey] = JSON.stringify(value);
    } else {
      out[nextKey] = value;
    }
  });

  return out;
}

function csvEscape(value) {
  const raw = value == null ? '' : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  if (!rows.length) return '"empty"\n"true"\n';

  const flattened = rows.map((row) => flattenObject(row));
  const headers = Array.from(
    flattened.reduce((set, row) => {
      Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set())
  );

  const lines = [headers.map(csvEscape).join(',')];
  flattened.forEach((row) => {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  });
  return `${lines.join('\n')}\n`;
}

function currentAlerts() {
  return Object.values(alertsByKey).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

function alertKey(deviceId, rule) {
  return `${deviceId}:${rule}`;
}

function upsertAlert(deviceId, rule, severity, message) {
  const key = alertKey(deviceId, rule);
  if (alertsByKey[key]) return;
  alertsByKey[key] = {
    key,
    deviceId,
    rule,
    severity,
    message,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  };
}

function clearAlert(deviceId, rule) {
  const key = alertKey(deviceId, rule);
  if (alertsByKey[key]) delete alertsByKey[key];
}

function evaluateDeviceAlerts(deviceId, device, nowMs = Date.now()) {
  const heartbeat = device.heartbeat;
  const battery = heartbeat && heartbeat.battery != null ? Number(heartbeat.battery) : null;
  const lastSeenMs = device.lastSeen ? new Date(device.lastSeen).getTime() : 0;
  const heartbeatMs = heartbeat && heartbeat.receivedAt ? new Date(heartbeat.receivedAt).getTime() : 0;

  if (battery != null && !Number.isNaN(battery) && battery <= LOW_BATTERY_THRESHOLD) {
    upsertAlert(deviceId, 'low-battery', 'high', `Battery is ${battery}%`);
  } else {
    clearAlert(deviceId, 'low-battery');
  }

  if (lastSeenMs && nowMs - lastSeenMs > OFFLINE_SECONDS * 1000) {
    upsertAlert(deviceId, 'offline', 'critical', `No data for ${Math.floor((nowMs - lastSeenMs) / 1000)}s`);
  } else {
    clearAlert(deviceId, 'offline');
  }

  if (heartbeatMs && nowMs - heartbeatMs > NO_HEARTBEAT_SECONDS * 1000) {
    upsertAlert(deviceId, 'no-heartbeat', 'critical', `No heartbeat for ${Math.floor((nowMs - heartbeatMs) / 1000)}s`);
  } else {
    clearAlert(deviceId, 'no-heartbeat');
  }
}

function evaluateAllAlerts() {
  const nowMs = Date.now();
  Object.entries(deviceStore).forEach(([deviceId, device]) => evaluateDeviceAlerts(deviceId, device, nowMs));
  io.emit('alerts:update', currentAlerts());
}

mqttClient.on('connect', () => {
  console.log(`[MQTT] Connected to ${BROKER_URL}`);
  TOPICS.forEach((topic) => {
    mqttClient.subscribe(topic, { qos: 1 }, (err) => {
      if (err) console.error(`[MQTT] Failed to subscribe to "${topic}":`, err.message);
      else console.log(`[MQTT] Subscribed: ${topic}`);
    });
  });
  io.emit('mqtt:status', { connected: true });
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] Reconnecting...');
  io.emit('mqtt:status', { connected: false, reconnecting: true });
});

mqttClient.on('offline', () => {
  console.warn('[MQTT] Offline');
  io.emit('mqtt:status', { connected: false });
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] Error:', err.message);
  io.emit('mqtt:error', { message: err.message });
});

mqttClient.on('message', (topic, payload) => {
  let data;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    data = { raw: payload.toString() };
  }

  const now = new Date().toISOString();
  const messageType = topicType(topic);
  pushLimited(rawMessages, {
    topic,
    normalizedTopic: normalizeTopic(topic),
    type: messageType,
    payload: data,
    receivedAt: now,
  });

  const deviceId =
    data.deviceId ||
    data.device_id ||
    data.id ||
    data.tag_id ||
    data.imei ||
    (data.config && data.config.imei) ||
    'unknown';

  if (!deviceStore[deviceId]) {
    deviceStore[deviceId] = {
      deviceId,
      heartbeat: null,
      wifi: null,
      rfid: [],
      batteryHistory: [],
      lastSeen: null,
    };
  }

  const device = deviceStore[deviceId];
  device.lastSeen = now;

  if (messageType === 'heartbeat') {
    device.heartbeat = { ...data, receivedAt: now };
    if (data.battery !== undefined) {
      device.batteryHistory.push({ t: now, v: Number(data.battery) });
      if (device.batteryHistory.length > 20) device.batteryHistory.shift();
    }
    pushLimited(heartbeatHistory, { ...device.heartbeat, deviceId });
    io.emit('device:heartbeat', {
      deviceId,
      data: device.heartbeat,
      batteryHistory: device.batteryHistory,
    });
  } else if (messageType === 'wifi') {
    device.wifi = { ...data, receivedAt: now };
    pushLimited(wifiHistory, { ...device.wifi, deviceId });
    io.emit('device:wifi', { deviceId, data: device.wifi });
  } else if (messageType === 'rfid') {
    const scan = { ...data, deviceId, receivedAt: now };
    device.rfid.unshift(scan);
    if (device.rfid.length > 50) device.rfid.pop();
    pushLimited(rfidHistory, scan);
    io.emit('device:rfid', { deviceId, data: scan });
  } else {
    console.log(`[MQTT] Received non-dashboard topic: ${topic}`);
  }

  evaluateDeviceAlerts(deviceId, device, Date.now());
  io.emit('alerts:update', currentAlerts());
  io.emit('mqtt:raw', rawMessages[0]);

  io.emit('device:update', { deviceId, device });
});

io.on('connection', (socket) => {
  console.log('[Dashboard] Browser connected');
  socket.emit('store:init', {
    devices: deviceStore,
    rfidHistory: rfidHistory.slice(0, 100),
    rawMessages: rawMessages.slice(0, 100),
    alerts: currentAlerts(),
  });
  socket.emit('mqtt:status', { connected: mqttClient.connected });
});

setInterval(evaluateAllAlerts, 15000);

httpServer.listen(PORT, () => {
  console.log(`[Dashboard] Running at http://localhost:${PORT}`);
});
