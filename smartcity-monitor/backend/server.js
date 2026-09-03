const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const dgram = require('dgram');
const Database = require('better-sqlite3');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─── Layout file path ─────────────────────────────────────────────────────────
const LAYOUT_FILE = path.join(__dirname, 'layout.json');

// ─── Database — better-sqlite3 (persistent file, survives restarts) ───────────
const DB_DIR  = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'smartcity.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // better write performance
db.pragma('synchronous = NORMAL'); // safe but fast

db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_readings (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id   TEXT NOT NULL,
    metric    TEXT NOT NULL,
    value     REAL,
    unit      TEXT,
    timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sr_node_metric_ts
    ON sensor_readings (node_id, metric, timestamp);

  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    node_id   TEXT,
    message   TEXT,
    severity  TEXT DEFAULT 'info',
    timestamp TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS rf_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id    TEXT NOT NULL,
    event_type TEXT NOT NULL,
    detail     TEXT,
    timestamp  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Jamming sessions — one row per controlled trial
  CREATE TABLE IF NOT EXISTS jamming_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    node_target  TEXT,
    frequency    TEXT,
    distance_m   REAL,
    gain_db      INTEGER,
    notes        TEXT,
    created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

console.log(`✅ Database ready: ${DB_PATH}`);

// ─── Auto-cleanup — delete sensor readings older than 7 days ──────────────────
function cleanupOldData() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(
    `DELETE FROM sensor_readings WHERE timestamp < ?`
  ).run(cutoff);
  if (result.changes > 0)
    console.log(`🧹 Cleaned up ${result.changes} sensor readings older than 7 days`);
}
// Run cleanup on start and every 6 hours
cleanupOldData();
setInterval(cleanupOldData, 6 * 60 * 60 * 1000);

// ─── DB helpers ───────────────────────────────────────────────────────────────
function dbRun(sql, params = []) {
  try { db.prepare(sql).run(...params); }
  catch (e) { console.warn('DB run error:', e.message); }
}
function dbAll(sql, params = []) {
  try { return db.prepare(sql).all(...params); }
  catch (e) { console.warn('DB query error:', e.message); return []; }
}
function dbGet(sql, params = []) {
  try { return db.prepare(sql).get(...params); }
  catch (e) { console.warn('DB get error:', e.message); return null; }
}

// ─── Default node definitions (fallback if no layout.json) ────────────────────
const DEFAULT_NODES = {
  'building-a':   { label: 'Building A',   type: 'hub',          metrics: ['video_fps','audio_db','wifi_rssi'],                        rfFrequency: '2.4ghz', publishIntervalMs: 1000, thresholds: {} },
  'building-b':   { label: 'Building B',   type: 'environmental', metrics: ['temperature','humidity','wifi_rssi','alerts_433'],         rfFrequency: '2.4ghz', publishIntervalMs: 1000, thresholds: {} },
  'building-c':   { label: 'Building C',   type: 'medical',      metrics: ['heart_rate','spo2','wifi_rssi'],                           rfFrequency: '2.4ghz', publishIntervalMs: 1000, thresholds: {} },
  'building-d':   { label: 'Building D',   type: 'automation',   metrics: ['plug_state','wifi_rssi'],                                  rfFrequency: '2.4ghz', publishIntervalMs: 1000, thresholds: {} },
  'intersection': { label: 'Intersection', type: 'traffic',      metrics: ['light_state','wifi_rssi'],                                 rfFrequency: '2.4ghz', publishIntervalMs: 1000, thresholds: {} },
  'perimeter':    { label: 'Perimeter',    type: 'security',     metrics: ['motion_detected','door_open','signal_433'],                rfFrequency: '433mhz', publishIntervalMs: 500,  thresholds: {} },
  'gps-node':     { label: 'GPS Node',     type: 'gps',          metrics: ['satellites','snr_l1','snr_l5','lock_status','lat','lng'],  rfFrequency: 'gps-l1l5', publishIntervalMs: 1000, thresholds: {} },
  'cf-e9':        { label: 'Crazyflie E9', type: 'drone',        metrics: ['x','y','z','yaw','battery','rssi'],                        rfFrequency: '2.4ghz',   publishIntervalMs: 600,  thresholds: {} },
  'cf-e8':        { label: 'Crazyflie E8', type: 'drone',        metrics: ['x','y','z','yaw','battery','rssi'],                        rfFrequency: '2.4ghz',   publishIntervalMs: 600,  thresholds: {} },
};

// ─── Global config (adjustable via Socket.io Settings tab) ───────────────────
let CONFIG = {
  watchdogTimeout:     15,
  rssiThreshold:      -85,
  signal433Threshold: -80,
  snrL1Threshold:      25,
  snrL5Threshold:      25,
  tempJumpThreshold:    5,
  rssiJumpThreshold:   15,
  satDropThreshold:     4,
  heartRateMin:        40,
  heartRateMax:       120,
  spo2Min:             94,
  packetLossWindow:    30,
  expectedIntervalMs: 1000,
  bulkSendThreshold:    3,
  gapThresholdMs:    2000,
  rssiVarianceWindow:  10,
};

// ─── Live node registry (dynamic — rebuilt from layout) ───────────────────────
let NODES = { ...DEFAULT_NODES };
let currentLayout = null;

// ─── In-memory state ──────────────────────────────────────────────────────────
let nodeState = {};
let watchdogTimers = {};
let packetCounters = {};
let lastMetrics = {};
let rfHealth = {};
let timestampHistory = {};
let mqttClient = null;
let demoInterval = null;

// ─── Drone state (separate from sensor nodes — full telemetry object) ─────────
let droneState = {};  // keyed by drone id e.g. "cf-e9"

// ─── Init node state for a given NODES object ─────────────────────────────────
function initNodeState(nodes) {
  Object.keys(nodes).forEach(id => {
    if (!nodeState[id]) {
      nodeState[id] = { status: 'offline', metrics: {}, lastSeen: null, packetLoss: 0 };
    }
    if (!packetCounters[id]) packetCounters[id] = { received: 0, window: [] };
    if (!lastMetrics[id]) lastMetrics[id] = {};
    if (!rfHealth[id]) {
      rfHealth[id] = {
        packetLossRate: 0, bulkSendCount: 0, gapCount: 0,
        rssiVariance: 0, rssiHistory: [], lastGapDuration: 0,
        disruptionType: 'none', lastRecoveryMs: null, transmissionRhythm: [],
      };
    }
    if (!timestampHistory[id]) timestampHistory[id] = [];
  });
  // Remove state for nodes no longer in layout
  Object.keys(nodeState).forEach(id => {
    if (!nodes[id]) {
      delete nodeState[id];
      delete rfHealth[id];
      delete packetCounters[id];
      delete lastMetrics[id];
      delete timestampHistory[id];
      if (watchdogTimers[id]) { clearTimeout(watchdogTimers[id]); delete watchdogTimers[id]; }
    }
  });
}

// ─── Layout: load from file ────────────────────────────────────────────────────
function loadLayoutFromFile() {
  if (!fs.existsSync(LAYOUT_FILE)) {
    console.log('📋 No layout.json found — using default node definitions');
    NODES = { ...DEFAULT_NODES };
    initNodeState(NODES);
    return;
  }
  try {
    const raw = fs.readFileSync(LAYOUT_FILE, 'utf8');
    const layout = JSON.parse(raw);
    applyLayout(layout, false);
    console.log(`✅ Layout loaded from layout.json — ${Object.keys(NODES).length} nodes`);
  } catch (e) {
    console.warn('⚠️  Failed to load layout.json:', e.message, '— using defaults');
    NODES = { ...DEFAULT_NODES };
    initNodeState(NODES);
  }
}

// ─── Layout: apply (from file or API push) ────────────────────────────────────
function applyLayout(layout, broadcast = true) {
  currentLayout = layout;

  // Build NODES from layout sensors
  const newNodes = {};
  (layout.sensors || []).forEach(s => {
    newNodes[s.id] = {
      label:             s.label,
      building:          s.building     || null,
      buildingId:        s.buildingId   || null,
      buildingType:      s.buildingType || null,
      type:              s.type,
      sensor:            s.sensor || '',
      metrics:           s.metrics || [],
      mqttTopic:         s.mqttTopic || `smartcity/${s.id}`,
      rfFrequency:       s.rfFrequency || '2.4ghz',
      publishIntervalMs: s.publishIntervalMs || 1000,
      thresholds:        s.thresholds || {},
      position:          s.position || { mx: 0, my: 0 },
    };
  });

  if (Object.keys(newNodes).length === 0) {
    console.warn('⚠️  Layout has no sensors — keeping existing nodes');
    return;
  }

  NODES = newNodes;
  initNodeState(NODES);

  // Restart watchdog timers for all nodes
  Object.keys(watchdogTimers).forEach(id => clearTimeout(watchdogTimers[id]));
  watchdogTimers = {};

  // Re-subscribe MQTT if connected
  if (mqttClient && mqttClient.connected) {
    mqttClient.unsubscribe('smartcity/#');
    mqttClient.subscribe('smartcity/#');
    console.log('🔄 MQTT resubscribed for new layout');
  }

  logEvent('system', null, `Layout applied — ${Object.keys(NODES).length} nodes loaded`, 'info');

  if (broadcast) {
    io.emit('state:full', { nodes: nodeState, nodeDefinitions: NODES });
    io.emit('layout:applied', { nodeCount: Object.keys(NODES).length, timestamp: new Date().toISOString() });
    console.log(`✅ Layout hot-reloaded — ${Object.keys(NODES).length} nodes active`);
  }
}

// ─── Helper: get effective threshold (per-sensor override > global config) ────
function getThreshold(nodeId, key) {
  const nodeThresholds = NODES[nodeId]?.thresholds || {};
  if (nodeThresholds[key] !== undefined) return nodeThresholds[key];
  return CONFIG[key];
}

function getUnit(metric) {
  const units = {
    temperature: '°C', humidity: '%', heart_rate: 'bpm', spo2: '%',
    wifi_rssi: 'dBm', video_fps: 'fps', audio_db: 'dB',
    snr_l1: 'dB-Hz', snr_l5: 'dB-Hz', satellites: 'count',
    lat: 'deg', lng: 'deg', signal_433: 'dBm',
  };
  return units[metric] || '';
}

// ─── Event logger ─────────────────────────────────────────────────────────────
function logEvent(type, nodeId, message, severity = 'info') {
  dbRun(`INSERT INTO events (type, node_id, message, severity) VALUES (?, ?, ?, ?)`,
    [type, nodeId, message, severity]);
  const event = { type, nodeId, node_id: nodeId, message, severity, timestamp: new Date().toISOString() };
  io.emit('event:new', event);
  if (severity !== 'info') console.log(`[${severity.toUpperCase()}] ${message}`);
  return event;
}

function logRfEvent(nodeId, eventType, detail) {
  dbRun(`INSERT INTO rf_events (node_id, event_type, detail) VALUES (?, ?, ?)`,
    [nodeId, eventType, JSON.stringify(detail)]);
  io.emit('rf:event', { nodeId, eventType, detail, timestamp: new Date().toISOString() });
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────
function resetWatchdog(nodeId) {
  if (watchdogTimers[nodeId]) clearTimeout(watchdogTimers[nodeId]);
  const timeout = getThreshold(nodeId, 'watchdogTimeout') || CONFIG.watchdogTimeout;
  watchdogTimers[nodeId] = setTimeout(() => {
    if (nodeState[nodeId] && nodeState[nodeId].status !== 'offline') {
      nodeState[nodeId].status = 'offline';
      io.emit('node:update', {
        nodeId, metrics: nodeState[nodeId]?.metrics || {},
        status: 'offline', lastSeen: nodeState[nodeId]?.lastSeen
      });
      logEvent('watchdog', nodeId,
        `${NODES[nodeId]?.label || nodeId} went silent — no data for ${timeout}s`, 'critical');
    }
  }, timeout * 1000);
}

// ─── Packet loss ──────────────────────────────────────────────────────────────
function trackPacket(nodeId) {
  const now = Date.now();
  const counter = packetCounters[nodeId];
  if (!counter) return 0;
  counter.received++;
  counter.window.push(now);
  const cutoff = now - CONFIG.packetLossWindow * 1000;
  counter.window = counter.window.filter(t => t > cutoff);
  const loss = Math.max(0, Math.round((1 - counter.window.length / CONFIG.packetLossWindow) * 100));
  nodeState[nodeId].packetLoss = loss;
  rfHealth[nodeId].packetLossRate = loss;
  return loss;
}

// ─── RF disruption analysis ───────────────────────────────────────────────────
function analyzeTransmissionRhythm(nodeId, metrics) {
  // Event-driven sensors don't have a regular publish interval
  // Gap detection is meaningless for them — silence = nothing happened
  const nodeType = NODES[nodeId]?.type;
  if (nodeType === 'security') return;
  const receiveTime = Date.now();
  const hist   = timestampHistory[nodeId];
  const health = rfHealth[nodeId];
  if (!hist || !health) return;

  // using collected_ms (ESP32 collection time) when available
  // collected_ms is millis() at the moment the sensor read the value.
  // When the ESP32 buffers data during jamming and flushes later, consecutive
  // readings will have very different collected_ms values even if they arrive
  // at the backend at the same time. This reveals the real gap.
  //
  // Without collected_ms: all buffered readings arrive together → no gap visible
  // With collected_ms:    collected_ms deltas show the actual transmission gap
  const hasCollectedMs = metrics._collected_ms !== undefined && metrics._received_ms !== undefined;
  const effectiveTime  = hasCollectedMs
    ? metrics._received_ms - (metrics._received_ms - receiveTime)  // normalize to wall clock
    : receiveTime;

  // For collected_ms-based analysis, use the collection time offset
  // If two readings have collected_ms values far apart but arrived together → bulk send / gap
  const collectedMs = hasCollectedMs ? metrics._collected_ms : null;

  // Track collection times separately when available for gap analysis
  if (!health.collectedMsHistory) health.collectedMsHistory = [];
  if (collectedMs !== null) {
    health.collectedMsHistory.push(collectedMs);
    if (health.collectedMsHistory.length > 200) health.collectedMsHistory.shift();
  }

  hist.push(receiveTime);
  if (hist.length > 200) hist.shift();

  if (hist.length >= 2) {
    // Primary: using collected_ms delta if we have consecutive collection timestamps
    // This catches buffering — readings collected far apart but received together
    let delta;
    let usingCollectionTime = false;

    if (collectedMs !== null && health.collectedMsHistory.length >= 2) {
      const len = health.collectedMsHistory.length;
      const collectedDelta = health.collectedMsHistory[len-1] - health.collectedMsHistory[len-2];
      // Sanity check — collected_ms delta should be positive and reasonable
      if (collectedDelta > 0 && collectedDelta < 300000) {
        delta = collectedDelta;
        usingCollectionTime = true;
      }
    }

    // Fallback to receive time delta (legacy sensors without collected_ms)
    if (!usingCollectionTime) {
      delta = receiveTime - hist[hist.length - 2];
    }

    let rhythmType = 'normal';

    if (delta < CONFIG.expectedIntervalMs * 0.2) {
      rhythmType = 'bulk';
      health.bulkSendCount++;
      logRfEvent(nodeId, 'bulk_send', { deltaMs: delta, source: usingCollectionTime ? 'collected_ms' : 'receive_time' });
    } else if (delta > CONFIG.gapThresholdMs) {
      rhythmType = 'gap';
      health.gapCount++;
      health.lastGapDuration = delta;
      logRfEvent(nodeId, 'gap', { gapMs: delta, source: usingCollectionTime ? 'collected_ms' : 'receive_time' });
      logEvent('rf_disruption', nodeId,
        `Data gap on ${NODES[nodeId]?.label || nodeId}: ${(delta/1000).toFixed(1)}s silence`, 'warning');
    } else if (health.transmissionRhythm.length > 0 &&
               health.transmissionRhythm[health.transmissionRhythm.length - 1].type === 'gap') {
      health.lastRecoveryMs = delta;
      logRfEvent(nodeId, 'recovery', { recoveryMs: delta });
      logEvent('rf_disruption', nodeId,
        `${NODES[nodeId]?.label || nodeId} recovered — transmission resumed`, 'info');
    }

    health.transmissionRhythm.push({
      t: receiveTime, intervalMs: delta, type: rhythmType,
      source: usingCollectionTime ? 'collected_ms' : 'receive_time'
    });
    if (health.transmissionRhythm.length > 60) health.transmissionRhythm.shift();
  }

  // RSSI / SNR tracking
  if (metrics.wifi_rssi !== undefined) {
    health.rssiHistory.push(metrics.wifi_rssi);
    if (health.rssiHistory.length > CONFIG.rssiVarianceWindow) health.rssiHistory.shift();
    if (health.rssiHistory.length >= 3) {
      const mean     = health.rssiHistory.reduce((a,b) => a+b, 0) / health.rssiHistory.length;
      const variance = health.rssiHistory.reduce((a,b) => a + Math.pow(b-mean, 2), 0) / health.rssiHistory.length;
      health.rssiVariance = +Math.sqrt(variance).toFixed(2);
    }
  }

  const recent = health.transmissionRhythm.slice(-20);
  const gaps   = recent.filter(r => r.type === 'gap').length;
  const bulks  = recent.filter(r => r.type === 'bulk').length;
  health.disruptionType = gaps === 0 && bulks === 0 ? 'none'
    : gaps > 0 && bulks > 0 ? 'intermittent'
    : gaps >= 3 ? 'severe' : 'partial';
}

// ─── Anomaly detection (uses per-sensor thresholds with global fallback) ───────
function detectAnomalies(nodeId, metrics) {
  const prev = lastMetrics[nodeId] || {};
  const gt = key => getThreshold(nodeId, key);

  if (metrics.wifi_rssi !== undefined && metrics.wifi_rssi < gt('rssiThreshold')) {
    logEvent('jamming', nodeId,
      `Low WiFi RSSI on ${NODES[nodeId]?.label}: ${metrics.wifi_rssi} dBm (threshold: ${gt('rssiThreshold')})`, 'warning');
  }
  if (metrics.wifi_rssi !== undefined && prev.wifi_rssi !== undefined) {
    if ((prev.wifi_rssi - metrics.wifi_rssi) > gt('rssiJumpThreshold')) {
      logEvent('anomaly', nodeId,
        `Sudden RSSI drop on ${NODES[nodeId]?.label}: ${prev.wifi_rssi} → ${metrics.wifi_rssi} dBm`, 'warning');
    }
  }
  if (metrics.signal_433 !== undefined && metrics.signal_433 < gt('signal433Threshold')) {
    logEvent('jamming', nodeId,
      `433 MHz signal degraded on ${NODES[nodeId]?.label}: ${metrics.signal_433} dBm`, 'warning');
  }
  if (metrics.snr_l1 !== undefined && metrics.snr_l1 < gt('snrL1Threshold')) {
    logEvent('jamming', nodeId, `GPS L1 SNR below threshold: ${metrics.snr_l1} dB-Hz`, 'critical');
  }
  if (metrics.snr_l5 !== undefined && metrics.snr_l5 < gt('snrL5Threshold')) {
    logEvent('jamming', nodeId, `GPS L5 SNR below threshold: ${metrics.snr_l5} dB-Hz`, 'critical');
  }
  if (metrics.satellites !== undefined && prev.satellites !== undefined) {
    if ((prev.satellites - metrics.satellites) >= gt('satDropThreshold')) {
      logEvent('anomaly', nodeId,
        `Satellite count dropped: ${prev.satellites} → ${metrics.satellites}`, 'critical');
    }
  }
  if (metrics.lock_status === 'lost' && prev.lock_status === 'locked') {
    logEvent('jamming', nodeId, `GPS lock lost on ${NODES[nodeId]?.label}`, 'critical');
  }

  // Per-sensor threshold overrides for environmental
  const nodeThresholds = NODES[nodeId]?.thresholds || {};
  if (metrics.temperature !== undefined && prev.temperature !== undefined) {
    const jump = Math.abs(metrics.temperature - prev.temperature);
    const jumpThresh = nodeThresholds.temp_jump || gt('tempJumpThreshold');
    if (jump > jumpThresh) {
      logEvent('anomaly', nodeId,
        `Temperature spike on ${NODES[nodeId]?.label}: ${prev.temperature}°C → ${metrics.temperature}°C`, 'warning');
    }
    if (nodeThresholds.temp_min !== undefined && metrics.temperature < nodeThresholds.temp_min)
      logEvent('anomaly', nodeId, `Temperature below minimum: ${metrics.temperature}°C`, 'warning');
    if (nodeThresholds.temp_max !== undefined && metrics.temperature > nodeThresholds.temp_max)
      logEvent('anomaly', nodeId, `Temperature above maximum: ${metrics.temperature}°C`, 'warning');
  }

  // Medical thresholds
  if (metrics.heart_rate !== undefined) {
    const hrMin = nodeThresholds.heart_rate_min || gt('heartRateMin');
    const hrMax = nodeThresholds.heart_rate_max || gt('heartRateMax');
    if (metrics.heart_rate < hrMin || metrics.heart_rate > hrMax) {
      logEvent('medical', nodeId, `Heart rate out of range: ${metrics.heart_rate} bpm`, 'critical');
    }
  }
  if (metrics.spo2 !== undefined) {
    const spo2Min = nodeThresholds.spo2_min || gt('spo2Min');
    if (metrics.spo2 < spo2Min) {
      logEvent('medical', nodeId, `Low SpO2: ${metrics.spo2}%`, 'critical');
    }
  }

  // Hub thresholds
  if (metrics.video_fps !== undefined && nodeThresholds.video_fps_min !== undefined) {
    if (metrics.video_fps < nodeThresholds.video_fps_min) {
      logEvent('anomaly', nodeId, `Video FPS below minimum: ${metrics.video_fps} fps`, 'warning');
    }
  }

  lastMetrics[nodeId] = { ...lastMetrics[nodeId], ...metrics };
}

// ─── Core state update ────────────────────────────────────────────────────────
function updateNodeState(nodeId, metrics, collectedAt = null) {
  if (!NODES[nodeId]) return;
  if (!nodeState[nodeId]) nodeState[nodeId] = { status: 'offline', metrics: {}, lastSeen: null, packetLoss: 0 };

  resetWatchdog(nodeId);
  trackPacket(nodeId);
  analyzeTransmissionRhythm(nodeId, metrics);
  detectAnomalies(nodeId, metrics);

  nodeState[nodeId].status  = 'online';
  nodeState[nodeId].lastSeen = new Date().toISOString();
  nodeState[nodeId].metrics  = { ...nodeState[nodeId].metrics, ...metrics };

  // Use collection timestamp when available, otherwise receive time
  const dbTimestamp = collectedAt || new Date().toISOString();

  Object.entries(metrics).forEach(([metric, value]) => {
    // Skip internal fields prefixed with _ (collected_ms, received_ms, etc.)
    if (metric.startsWith('_')) return;
    if (typeof value === 'number') {
      dbRun(
        `INSERT INTO sensor_readings (node_id, metric, value, unit, timestamp) VALUES (?, ?, ?, ?, ?)`,
        [nodeId, metric, value, getUnit(metric), dbTimestamp]
      );
    }
  });

  io.emit('node:update', {
    nodeId, metrics, status: 'online',
    lastSeen:    nodeState[nodeId].lastSeen,
    packetLoss:  nodeState[nodeId].packetLoss,
    collectedAt,
    rfHealth: {
      disruptionType: rfHealth[nodeId]?.disruptionType,
      packetLossRate: rfHealth[nodeId]?.packetLossRate,
      rssiVariance:   rfHealth[nodeId]?.rssiVariance,
      gapCount:       rfHealth[nodeId]?.gapCount,
      bulkSendCount:  rfHealth[nodeId]?.bulkSendCount,
    },
  });
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';

function connectMQTT() {
  try {
    mqttClient = mqtt.connect(MQTT_BROKER, { reconnectPeriod: 5000, connectTimeout: 3000 });
    mqttClient.on('connect', () => {
      console.log('✅ MQTT connected:', MQTT_BROKER);
      mqttClient.subscribe('smartcity/#');
      logEvent('system', null, 'MQTT broker connected', 'info');
    });
    mqttClient.on('error', (err) => {
      console.warn('⚠️  MQTT unavailable (demo mode active):', err.message);
      mqttClient.end();
    });
    mqttClient.on('message', (topic, payload) => {
      const parts = topic.split('/');
      if (parts.length < 3 || parts[0] !== 'smartcity') return;
      const nodeId = parts[1];
      const metric = parts[2];

      // ── Drone telemetry — full JSON object on smartcity/{droneId}/telemetry ──
      if (metric === 'telemetry') {
        try {
          const data = JSON.parse(payload.toString());
          const droneId = data.id || nodeId;

          // Store full drone state
          droneState[droneId] = {
            ...data,
            lastSeen: new Date().toISOString(),
            status: 'online',
          };

          // Keep drone node state in sync so watchdog and dashboard work
          if (NODES[droneId]) {
            updateNodeState(droneId, {
              x:       data.x,
              y:       data.y,
              z:       data.z,
              yaw:     data.yaw,
              battery: data.battery,
              rssi:    data.rssi,
              vx:      data.vx,
              vy:      data.vy,
              vz:      data.vz,
              roll:    data.roll,
              pitch:   data.pitch,
            }, data.timestamp);
          }

          // Emit full telemetry for live map rendering
          io.emit('drone:telemetry', droneState[droneId]);

          // Alert on low battery
          if (data.battery !== null && data.battery < 3.5) {
            logEvent('drone', droneId,
              `${NODES[droneId]?.label || droneId} low battery: ${data.battery}V`, 'warning');
          }

          // Alert on halt flag (attack detected by Python script)
          if (data.halt) {
            logEvent('drone', droneId,
              `${NODES[droneId]?.label || droneId} attack signal received — mission halted`, 'critical');
          }
        } catch (e) {
          console.warn('Drone telemetry parse error:', e.message);
        }
        return;
      }

      // ── Regular sensor message ─────────────────────────────────────────────
      if (!NODES[nodeId]) return;

      let metrics = {};
      let collectedAt = null;

      try {
        const parsed = JSON.parse(payload.toString());

        if (typeof parsed === 'object' && parsed !== null && 'value' in parsed) {
          metrics = { [metric]: parsed.value };
          if (parsed.collected_ms !== undefined) {
            metrics._collected_ms = parsed.collected_ms;
            metrics._received_ms  = Date.now();
          }
          if (parsed.collected_at) {
            collectedAt = parsed.collected_at;
          }
          if (parsed.timestamp_source) {
            metrics._timestamp_source = parsed.timestamp_source;
          }
        } else if (typeof parsed === 'object' && parsed !== null) {
          metrics = parsed;
        } else {
          metrics = { [metric]: parseFloat(payload.toString()) || payload.toString() };
        }
      } catch {
        metrics = { [metric]: parseFloat(payload.toString()) || payload.toString() };
      }

      updateNodeState(nodeId, metrics, collectedAt);
    });
  } catch (e) {
    console.warn('⚠️  MQTT unavailable');
  }
}

// ─── UDP stub (Crazyflie / Unity) ─────────────────────────────────────────────
const UDP_PORT = process.env.UDP_PORT || 9870;
const udpSocket = dgram.createSocket('udp4');
udpSocket.on('message', msg => {
  try {
    const data = JSON.parse(msg.toString());
    io.emit('drone:telemetry', { ...data, timestamp: new Date().toISOString() });
  } catch (e) { console.warn('UDP parse error:', e.message); }
});
udpSocket.on('error', err => console.warn('UDP error:', err.message));
udpSocket.bind(UDP_PORT, () => console.log(`📡 UDP stub on port ${UDP_PORT}`));

// ─── Demo mode ────────────────────────────────────────────────────────────────
const DEMO_MODE = process.env.DEMO_MODE !== 'false';

function startDemoMode() {
  if (demoInterval) { clearInterval(demoInterval); demoInterval = null; }
  if (!DEMO_MODE) return;

  console.log('🎮 Demo mode active');
  let tick = 0, jammingActive = false, jammingNode = null;

  demoInterval = setInterval(() => {
    tick++;
    const nodeIds = Object.keys(NODES);
    if (!nodeIds.length) return;

    if (tick % 60 === 0 && !jammingActive) {
      jammingNode = nodeIds[Math.floor(Math.random() * nodeIds.length)];
      jammingActive = true;
      setTimeout(() => { jammingActive = false; jammingNode = null; }, 15000);
    }
    if (tick % 43 === 0) {
      const secNode = nodeIds.find(id => NODES[id]?.type === 'security') || nodeIds[0];
      logEvent('security', secNode, '433 MHz motion sensor triggered', 'warning');
    }

    const ij = id => jammingActive && jammingNode === id;

    nodeIds.forEach(id => {
      const type = NODES[id]?.type;
      const jammed = ij(id);
      let metrics = {};

      switch (type) {
        case 'environmental':
          metrics = {
            temperature: +(Math.random()*3+22).toFixed(1),
            humidity:    +(Math.random()*10+45).toFixed(1),
            wifi_rssi:   jammed ? -95 : +(Math.random()*10-60).toFixed(0),
            alerts_433:  Math.random() > 0.97 ? 1 : 0,
          }; break;
        case 'medical':
          metrics = {
            heart_rate: jammed ? null : Math.floor(Math.random()*20+65),
            spo2:       jammed ? null : +(Math.random()*3+96).toFixed(1),
            wifi_rssi:  jammed ? -94  : +(Math.random()*10-62).toFixed(0),
          }; break;
        case 'hub':
          metrics = {
            video_fps: jammed ? 0 : +(Math.random()*5+25).toFixed(1),
            audio_db:  jammed ? null : +(Math.random()*10+55).toFixed(1),
            wifi_rssi: jammed ? -95 : +(Math.random()*10-60).toFixed(0),
          }; break;
        case 'automation':
          metrics = {
            plug_state: jammed ? 'unknown' : (Math.random()>0.3?'on':'off'),
            wifi_rssi:  jammed ? -90 : +(Math.random()*10-55).toFixed(0),
          }; break;
        case 'traffic':
          metrics = {
            light_state: jammed ? 'green' : ['green','green','green','yellow','red','red','red'][Math.floor(tick/4)%7],
            wifi_rssi:   jammed ? -93 : +(Math.random()*10-57).toFixed(0),
          }; break;
        case 'security':
          metrics = {
            motion_detected: jammed ? 0 : (Math.random()>0.92?1:0),
            door_open:       jammed ? 0 : (Math.random()>0.97?1:0),
            signal_433:      jammed ? -85 : +(Math.random()*10-55).toFixed(0),
          }; break;
        case 'gps':
          metrics = {
            satellites:  jammed ? Math.floor(Math.random()*3) : Math.floor(Math.random()*4+8),
            snr_l1:      jammed ? +(Math.random()*10+10).toFixed(1) : +(Math.random()*10+35).toFixed(1),
            snr_l5:      jammed ? +(Math.random()*8+8).toFixed(1)   : +(Math.random()*8+38).toFixed(1),
            lock_status: jammed ? 'lost' : 'locked',
          }; break;
        default:
          metrics = { wifi_rssi: +(Math.random()*10-60).toFixed(0) };
      }
      updateNodeState(id, metrics);
    });
  }, 1000);
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// GET current layout
app.get('/api/layout', (req, res) => {
  res.json(currentLayout || { sensors: Object.entries(NODES).map(([id, n]) => ({ id, ...n })) });
});

// POST new layout from Tactical Mapper — hot-reloads everything
app.post('/api/layout', (req, res) => {
  const layout = req.body;
  if (!layout || !Array.isArray(layout.sensors)) {
    return res.status(400).json({ error: 'Invalid layout — expected { sensors: [...] }' });
  }
  if (layout.sensors.length === 0) {
    return res.status(400).json({ error: 'Layout has no sensors' });
  }

  try {
    // Save to disk
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2), 'utf8');
    console.log(`💾 Layout saved to layout.json`);

    // Apply live
    applyLayout(layout, true);

    // Restart demo mode with new node set
    if (DEMO_MODE) startDemoMode();

    res.json({
      success: true,
      message: `Layout applied — ${Object.keys(NODES).length} nodes active`,
      nodes: Object.keys(NODES),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Layout apply error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/nodes', (req, res) => {
  res.json(Object.entries(NODES).map(([id, def]) => ({ id, ...def, ...nodeState[id] })));
});

app.get('/api/nodes/:id/history', (req, res) => {
  const { id } = req.params;
  const { metric, limit = 100 } = req.query;
  let sql = `SELECT metric, value, unit, timestamp FROM sensor_readings WHERE node_id = ?`;
  const params = [id];
  if (metric) { sql += ` AND metric = ?`; params.push(metric); }
  sql += ` ORDER BY rowid DESC LIMIT ?`;
  params.push(parseInt(limit));
  res.json(dbAll(sql, params).reverse());
});

app.get('/api/nodes/:id/rf-health', (req, res) => {
  const { id } = req.params;
  if (!rfHealth[id]) return res.status(404).json({ error: 'Node not found' });
  res.json(rfHealth[id]);
});

app.get('/api/events', (req, res) => {
  const { limit = 50, severity } = req.query;
  let sql = `SELECT * FROM events`;
  const params = [];
  if (severity) { sql += ` WHERE severity = ?`; params.push(severity); }
  sql += ` ORDER BY rowid DESC LIMIT ?`;
  params.push(parseInt(limit));
  res.json(dbAll(sql, params).reverse());
});

app.get('/api/state', (req, res) => {
  res.json({ nodes: nodeState, nodeDefinitions: NODES });
});

app.get('/api/config', (req, res) => res.json(CONFIG));

app.get('/api/drones', (req, res) => res.json(droneState));

// ─── Jamming session API ───────────────────────────────────────────────────────

// POST — log a new jamming session (called from any machine on the network)
// Body: { started_at, ended_at, node_target, frequency, distance_m, gain_db, notes }
app.post('/api/jamming-sessions', (req, res) => {
  const { started_at, ended_at, node_target, frequency, distance_m, gain_db, notes } = req.body;
  if (!started_at) return res.status(400).json({ error: 'started_at is required' });
  try {
    const result = db.prepare(`
      INSERT INTO jamming_sessions (started_at, ended_at, node_target, frequency, distance_m, gain_db, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(started_at, ended_at || null, node_target || null, frequency || null,
           distance_m || null, gain_db || null, notes || null);
    const session = dbGet(`SELECT * FROM jamming_sessions WHERE id = ?`, [result.lastInsertRowid]);
    console.log(`📡 Jamming session logged: id=${result.lastInsertRowid} node=${node_target} dist=${distance_m}m gain=${gain_db}dB`);
    res.json({ success: true, session });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET — list all jamming sessions, newest first
app.get('/api/jamming-sessions', (req, res) => {
  const { limit = 50 } = req.query;
  res.json(dbAll(`SELECT * FROM jamming_sessions ORDER BY id DESC LIMIT ?`, [parseInt(limit)]));
});

// GET — get sensor readings that overlap with a specific jamming session
// Returns readings from all nodes during the session window + 30s pre/post buffer
app.get('/api/jamming-sessions/:id/data', (req, res) => {
  const session = dbGet(`SELECT * FROM jamming_sessions WHERE id = ?`, [req.params.id]);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { node_target, started_at, ended_at } = session;
  const endTime = ended_at || new Date().toISOString();

  // 30-second buffer before and after for baseline comparison
  const bufferMs   = 30 * 1000;
  const windowFrom = new Date(new Date(started_at).getTime() - bufferMs).toISOString();
  const windowTo   = new Date(new Date(endTime).getTime()   + bufferMs).toISOString();

  let sql = `SELECT * FROM sensor_readings WHERE timestamp >= ? AND timestamp <= ?`;
  const params = [windowFrom, windowTo];

  // If node_target specified, return that node first, then others
  const readings = dbAll(sql, params);
  const targeted = readings.filter(r => r.node_id === node_target);
  const others   = readings.filter(r => r.node_id !== node_target);

  res.json({
    session,
    window: { from: windowFrom, to: windowTo, buffer_sec: 30 },
    targeted_node:  targeted,
    other_nodes:    others,
    total_readings: readings.length,
  });
});

// GET — summary table for sigmoid curve fitting
// Returns one computed row per session with packet loss, baseline RSSI, disruption metrics
app.get('/api/jamming-sessions/summary', (req, res) => {
  const sessions = dbAll(`SELECT * FROM jamming_sessions WHERE ended_at IS NOT NULL ORDER BY distance_m, gain_db`);

  const summary = sessions.map(session => {
    const { id, started_at, ended_at, node_target, distance_m, gain_db, frequency } = session;

    // Pre-jam baseline: 30s before jamming started
    const baselineFrom = new Date(new Date(started_at).getTime() - 30000).toISOString();
    const baseline = dbAll(`
      SELECT value FROM sensor_readings
      WHERE node_id = ? AND metric = 'wifi_rssi'
      AND timestamp >= ? AND timestamp < ?
    `, [node_target, baselineFrom, started_at]);

    // During jam
    const during = dbAll(`
      SELECT value FROM sensor_readings
      WHERE node_id = ? AND metric = 'wifi_rssi'
      AND timestamp >= ? AND timestamp <= ?
    `, [node_target, started_at, ended_at]);

    const avg = arr => arr.length ? +(arr.reduce((s,r) => s + r.value, 0) / arr.length).toFixed(2) : null;

    // Packet loss: count expected vs received at 2s interval
    const durationMs = new Date(ended_at) - new Date(started_at);
    const expected   = Math.round(durationMs / 2000) + 1;
    const received   = during.length;
    const packetLoss = +(Math.max(0, (expected - received) / expected) * 100).toFixed(1);

    return {
      session_id:         id,
      started_at,
      ended_at,
      node_target,
      distance_m,
      gain_db,
      frequency,
      baseline_rssi:      avg(baseline),
      avg_rssi_during:    avg(during),
      expected_readings:  expected,
      received_readings:  received,
      packet_loss_pct:    packetLoss,
    };
  });

  res.json(summary);
});

// DELETE — remove a bad or failed jamming session
app.delete('/api/jamming-sessions/:id', (req, res) => {
  const session = dbGet(`SELECT * FROM jamming_sessions WHERE id = ?`, [req.params.id]);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  db.prepare(`DELETE FROM jamming_sessions WHERE id = ?`).run(req.params.id);
  console.log(`🗑️  Jamming session ${req.params.id} deleted`);
  res.json({ success: true, deleted: session });
});

// PATCH — correct session data (wrong distance, gain, timestamps, etc.)
app.patch('/api/jamming-sessions/:id', (req, res) => {
  const session = dbGet(`SELECT * FROM jamming_sessions WHERE id = ?`, [req.params.id]);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const allowed = ['started_at','ended_at','node_target','frequency','distance_m','gain_db','notes'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: `No valid fields. Allowed: ${allowed.join(', ')}` });
  const sets   = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), req.params.id];
  db.prepare(`UPDATE jamming_sessions SET ${sets} WHERE id = ?`).run(...values);
  const updated = dbGet(`SELECT * FROM jamming_sessions WHERE id = ?`, [req.params.id]);
  console.log(`✏️  Jamming session ${req.params.id} updated: ${Object.keys(updates).join(', ')}`);
  res.json({ success: true, session: updated });
});

// GET — time window query (useful for ad-hoc queries from Data Explorer)
app.get('/api/history', (req, res) => {
  const { node, metric, from, to, limit = 1000 } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to timestamps required (ISO 8601)' });
  let sql = `SELECT * FROM sensor_readings WHERE timestamp >= ? AND timestamp <= ?`;
  const params = [from, to];
  if (node)   { sql += ` AND node_id = ?`;  params.push(node); }
  if (metric) { sql += ` AND metric = ?`;   params.push(metric); }
  sql += ` ORDER BY timestamp ASC LIMIT ?`;
  params.push(parseInt(limit));
  res.json(dbAll(sql, params));
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
  socket.emit('state:full', { nodes: nodeState, nodeDefinitions: NODES, droneState });
  socket.emit('config:current', CONFIG);
  socket.emit('rfhealth:full', rfHealth);
  socket.emit('layout:current', currentLayout);
  socket.emit('drone:state', droneState);
  const recentEvents = dbAll(`SELECT * FROM events ORDER BY rowid DESC LIMIT 30`).reverse();
  socket.emit('events:recent', recentEvents);

  socket.on('config:update', updates => {
    CONFIG = { ...CONFIG, ...updates };
    console.log('⚙️  Config updated:', Object.keys(updates).join(', '));
    if (updates.watchdogTimeout) {
      Object.keys(NODES).forEach(id => {
        if (nodeState[id]?.status === 'online') resetWatchdog(id);
      });
    }
    io.emit('config:current', CONFIG);
    logEvent('system', null, `Config updated: ${Object.keys(updates).join(', ')}`, 'info');
  });

  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 Smart City Monitor on http://localhost:${PORT}`);
  console.log(`📊 API:    http://localhost:${PORT}/api/nodes`);
  console.log(`📋 Layout: http://localhost:${PORT}/api/layout`);
  console.log(`📡 UDP:    port ${UDP_PORT}\n`);

  loadLayoutFromFile();
  connectMQTT();
  startDemoMode();
});
