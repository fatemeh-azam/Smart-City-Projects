const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const dgram = require('dgram');
const initSqlJs = require('sql.js');
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

// ─── Database ─────────────────────────────────────────────────────────────────
let db;
initSqlJs().then(SQL => {
  db = new SQL.Database();
  db.run(`
    CREATE TABLE IF NOT EXISTS sensor_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL,
      unit TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      node_id TEXT,
      message TEXT,
      severity TEXT DEFAULT 'info',
      timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rf_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      detail TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );
  `);
  console.log('✅ Database ready (sql.js)');
}).catch(err => console.error('❌ Database init failed:', err.message));

function dbRun(sql, params = []) {
  try { if (db) db.run(sql, params); } catch (e) { console.warn('DB run error:', e.message); }
}
function dbAll(sql, params = []) {
  try {
    if (!db) return [];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) { console.warn('DB query error:', e.message); return []; }
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
  const now = Date.now();
  const hist = timestampHistory[nodeId];
  const health = rfHealth[nodeId];
  if (!hist || !health) return;

  hist.push(now);
  if (hist.length > 200) hist.shift();

  if (hist.length >= 2) {
    const delta = now - hist[hist.length - 2];
    let rhythmType = 'normal';

    if (delta < CONFIG.expectedIntervalMs * 0.2) {
      rhythmType = 'bulk';
      health.bulkSendCount++;
      logRfEvent(nodeId, 'bulk_send', { deltaMs: delta });
    } else if (delta > CONFIG.gapThresholdMs) {
      rhythmType = 'gap';
      health.gapCount++;
      health.lastGapDuration = delta;
      logRfEvent(nodeId, 'gap', { gapMs: delta });
      logEvent('rf_disruption', nodeId,
        `Data gap on ${NODES[nodeId]?.label || nodeId}: ${(delta/1000).toFixed(1)}s silence`, 'warning');
    } else if (health.transmissionRhythm.length > 0 &&
               health.transmissionRhythm[health.transmissionRhythm.length - 1].type === 'gap') {
      health.lastRecoveryMs = delta;
      logRfEvent(nodeId, 'recovery', { recoveryMs: delta });
      logEvent('rf_disruption', nodeId,
        `${NODES[nodeId]?.label || nodeId} recovered — transmission resumed`, 'info');
    }

    health.transmissionRhythm.push({ t: now, intervalMs: delta, type: rhythmType });
    if (health.transmissionRhythm.length > 60) health.transmissionRhythm.shift();
  }

  if (metrics.wifi_rssi !== undefined) {
    health.rssiHistory.push(metrics.wifi_rssi);
    if (health.rssiHistory.length > CONFIG.rssiVarianceWindow) health.rssiHistory.shift();
    if (health.rssiHistory.length >= 3) {
      const mean = health.rssiHistory.reduce((a,b) => a+b, 0) / health.rssiHistory.length;
      const variance = health.rssiHistory.reduce((a,b) => a + Math.pow(b-mean, 2), 0) / health.rssiHistory.length;
      health.rssiVariance = +Math.sqrt(variance).toFixed(2);
    }
  }

  const recent = health.transmissionRhythm.slice(-20);
  const gaps = recent.filter(r => r.type === 'gap').length;
  const bulks = recent.filter(r => r.type === 'bulk').length;
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
function updateNodeState(nodeId, metrics) {
  if (!NODES[nodeId]) return;
  if (!nodeState[nodeId]) nodeState[nodeId] = { status: 'offline', metrics: {}, lastSeen: null, packetLoss: 0 };

  resetWatchdog(nodeId);
  trackPacket(nodeId);
  analyzeTransmissionRhythm(nodeId, metrics);
  detectAnomalies(nodeId, metrics);

  nodeState[nodeId].status = 'online';
  nodeState[nodeId].lastSeen = new Date().toISOString();
  nodeState[nodeId].metrics = { ...nodeState[nodeId].metrics, ...metrics };

  Object.entries(metrics).forEach(([metric, value]) => {
    if (typeof value === 'number') {
      dbRun(`INSERT INTO sensor_readings (node_id, metric, value, unit) VALUES (?, ?, ?, ?)`,
        [nodeId, metric, value, getUnit(metric)]);
    }
  });

  io.emit('node:update', {
    nodeId, metrics, status: 'online',
    lastSeen: nodeState[nodeId].lastSeen,
    packetLoss: nodeState[nodeId].packetLoss,
    rfHealth: {
      disruptionType:  rfHealth[nodeId]?.disruptionType,
      packetLossRate:  rfHealth[nodeId]?.packetLossRate,
      rssiVariance:    rfHealth[nodeId]?.rssiVariance,
      gapCount:        rfHealth[nodeId]?.gapCount,
      bulkSendCount:   rfHealth[nodeId]?.bulkSendCount,
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
      if (!NODES[nodeId]) return;
      let value;
      try {
        const parsed = JSON.parse(payload.toString());
        value = typeof parsed === 'object' ? parsed : { [parts[2]]: parsed };
      } catch {
        value = { [parts[2]]: parseFloat(payload.toString()) || payload.toString() };
      }
      updateNodeState(nodeId, value);
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

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
  socket.emit('state:full', { nodes: nodeState, nodeDefinitions: NODES });
  socket.emit('config:current', CONFIG);
  socket.emit('rfhealth:full', rfHealth);
  socket.emit('layout:current', currentLayout);
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
