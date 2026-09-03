const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const dgram = require('dgram');
const initSqlJs = require('sql.js');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ─── Database Setup ───────────────────────────────────────────────────────────
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

// ─── Node Definitions ─────────────────────────────────────────────────────────
const NODES = {
  'building-a':  { label: 'Building A',    type: 'hub',           metrics: ['video_fps','audio_db','wifi_rssi'] },
  'building-b':  { label: 'Building B',    type: 'environmental', metrics: ['temperature','humidity','wifi_rssi','alerts_433'] },
  'building-c':  { label: 'Building C',    type: 'medical',       metrics: ['heart_rate','spo2','wifi_rssi'] },
  'building-d':  { label: 'Building D',    type: 'automation',    metrics: ['plug_state','wifi_rssi'] },
  'intersection':{ label: 'Intersection',  type: 'traffic',       metrics: ['light_state','wifi_rssi'] },
  'perimeter':   { label: 'Perimeter',     type: 'security',      metrics: ['motion_detected','door_open','signal_433'] },
  'gps-node':    { label: 'GPS Node',      type: 'gps',           metrics: ['satellites','snr_l1','snr_l5','lock_status','lat','lng'] },
};

// ─── Monitoring Config ─────────────────────────────────────────────────────────
let CONFIG = {
  watchdogTimeout:    15,
  rssiThreshold:     -85,
  signal433Threshold:-80,
  snrL1Threshold:     25,
  snrL5Threshold:     25,
  tempJumpThreshold:   5,
  rssiJumpThreshold:  15,
  satDropThreshold:    4,
  heartRateMin:       40,
  heartRateMax:      120,
  spo2Min:            94,
  packetLossWindow:   30,
  // RF disruption detection
  expectedIntervalMs: 1000,  // expected time between readings
  bulkSendThreshold:    3,   // readings within 200ms = bulk send
  gapThresholdMs:     2000,  // missing time = gap event
  rssiVarianceWindow:   10,  // readings to calc RSSI variance over
};

// ─── In-Memory State ──────────────────────────────────────────────────────────
const nodeState = {};
const watchdogTimers = {};
const packetCounters = {};
const lastMetrics = {};
const rfHealth = {};       // per-node RF disruption tracking
const timestampHistory = {}; // raw arrival timestamps per node, for rhythm analysis

Object.keys(NODES).forEach(id => {
  nodeState[id] = { status: 'offline', metrics: {}, lastSeen: null, packetLoss: 0 };
  packetCounters[id] = { received: 0, window: [] };
  lastMetrics[id] = {};
  rfHealth[id] = {
    packetLossRate: 0,
    bulkSendCount: 0,
    gapCount: 0,
    rssiVariance: 0,
    rssiHistory: [],
    lastGapDuration: 0,
    disruptionType: 'none',   // none | intermittent | partial | severe
    lastRecoveryMs: null,
    transmissionRhythm: [],   // array of { t, intervalMs, type: 'normal'|'bulk'|'gap' }
  };
  timestampHistory[id] = [];
});

function getUnit(metric) {
  const units = {
    temperature:'°C', humidity:'%', heart_rate:'bpm', spo2:'%',
    wifi_rssi:'dBm', video_fps:'fps', audio_db:'dB',
    snr_l1:'dB-Hz', snr_l5:'dB-Hz', satellites:'count', lat:'deg', lng:'deg',
    signal_433:'dBm'
  };
  return units[metric] || '';
}

function logEvent(type, nodeId, message, severity = 'info') {
  dbRun(`INSERT INTO events (type, node_id, message, severity) VALUES (?, ?, ?, ?)`,
    [type, nodeId, message, severity]);
  const event = { type, nodeId, node_id: nodeId, message, severity, timestamp: new Date().toISOString() };
  io.emit('event:new', event);
  console.log(`[${severity.toUpperCase()}] ${message}`);
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
  watchdogTimers[nodeId] = setTimeout(() => {
    if (nodeState[nodeId].status !== 'offline') {
      nodeState[nodeId].status = 'offline';
      io.emit('node:update', {
        nodeId, metrics: nodeState[nodeId].metrics,
        status: 'offline', lastSeen: nodeState[nodeId].lastSeen
      });
      logEvent('watchdog', nodeId,
        `${NODES[nodeId].label} went silent — no data for ${CONFIG.watchdogTimeout}s`, 'critical');
    }
  }, CONFIG.watchdogTimeout * 1000);
}

// ─── Packet Loss Tracker ──────────────────────────────────────────────────────
function trackPacket(nodeId) {
  const now = Date.now();
  const counter = packetCounters[nodeId];
  counter.received++;
  counter.window.push(now);
  const cutoff = now - CONFIG.packetLossWindow * 1000;
  counter.window = counter.window.filter(t => t > cutoff);
  const expected = CONFIG.packetLossWindow;
  const received = counter.window.length;
  const loss = Math.max(0, Math.round((1 - received / expected) * 100));
  nodeState[nodeId].packetLoss = loss;
  rfHealth[nodeId].packetLossRate = loss;
  return loss;
}

// ─── RF Disruption / Transmission Rhythm Analysis ─────────────────────────────
// This is the core logic implementing what was observed in the jamming test doc:
// bulk sends (multiple readings same/near timestamp), gaps (missing expected reading),
// and RSSI instability (variance over rolling window).
function analyzeTransmissionRhythm(nodeId, metrics) {
  const now = Date.now();
  const hist = timestampHistory[nodeId];
  const health = rfHealth[nodeId];

  hist.push(now);
  if (hist.length > 200) hist.shift();

  if (hist.length >= 2) {
    const delta = now - hist[hist.length - 2];

    let rhythmType = 'normal';

    // Bulk send detection — readings arriving much faster than expected
    if (delta < CONFIG.expectedIntervalMs * 0.2) {
      rhythmType = 'bulk';
      health.bulkSendCount++;
      logRfEvent(nodeId, 'bulk_send', { deltaMs: delta, count: health.bulkSendCount });
    }
    // Gap detection — readings arriving much slower than expected
    else if (delta > CONFIG.gapThresholdMs) {
      rhythmType = 'gap';
      health.gapCount++;
      health.lastGapDuration = delta;
      logRfEvent(nodeId, 'gap', { gapMs: delta });
      logEvent('rf_disruption', nodeId,
        `Data gap on ${NODES[nodeId].label}: ${(delta/1000).toFixed(1)}s with no transmission`,
        'warning');
    }
    // Recovery — previous event was a gap, this one is back to normal
    else if (health.transmissionRhythm.length > 0 &&
             health.transmissionRhythm[health.transmissionRhythm.length-1].type === 'gap') {
      health.lastRecoveryMs = delta;
      logRfEvent(nodeId, 'recovery', { recoveryMs: delta });
      logEvent('rf_disruption', nodeId,
        `${NODES[nodeId].label} recovered — transmission resumed normally`, 'info');
    }

    health.transmissionRhythm.push({ t: now, intervalMs: delta, type: rhythmType });
    if (health.transmissionRhythm.length > 60) health.transmissionRhythm.shift();
  }

  // RSSI variance / instability tracking
  if (metrics.wifi_rssi !== undefined) {
    health.rssiHistory.push(metrics.wifi_rssi);
    if (health.rssiHistory.length > CONFIG.rssiVarianceWindow) health.rssiHistory.shift();
    if (health.rssiHistory.length >= 3) {
      const mean = health.rssiHistory.reduce((a,b) => a+b, 0) / health.rssiHistory.length;
      const variance = health.rssiHistory.reduce((a,b) => a + Math.pow(b-mean,2), 0) / health.rssiHistory.length;
      health.rssiVariance = +Math.sqrt(variance).toFixed(2);
    }
  }

  // Classify overall disruption type based on recent activity
  const recentWindow = health.transmissionRhythm.slice(-20);
  const gaps = recentWindow.filter(r => r.type === 'gap').length;
  const bulks = recentWindow.filter(r => r.type === 'bulk').length;

  if (gaps === 0 && bulks === 0) {
    health.disruptionType = 'none';
  } else if (gaps > 0 && bulks > 0) {
    health.disruptionType = 'intermittent';  // matches your test doc — buffering + gaps
  } else if (gaps >= 3) {
    health.disruptionType = 'severe';
  } else {
    health.disruptionType = 'partial';
  }
}

// ─── Anomaly Detection ────────────────────────────────────────────────────────
function detectAnomalies(nodeId, metrics) {
  const prev = lastMetrics[nodeId] || {};

  if (metrics.wifi_rssi !== undefined && metrics.wifi_rssi < CONFIG.rssiThreshold) {
    logEvent('jamming', nodeId,
      `Low WiFi RSSI on ${NODES[nodeId].label}: ${metrics.wifi_rssi} dBm (threshold: ${CONFIG.rssiThreshold})`, 'warning');
  }
  if (metrics.wifi_rssi !== undefined && prev.wifi_rssi !== undefined) {
    const drop = prev.wifi_rssi - metrics.wifi_rssi;
    if (drop > CONFIG.rssiJumpThreshold) {
      logEvent('anomaly', nodeId,
        `Sudden RSSI drop on ${NODES[nodeId].label}: ${prev.wifi_rssi} → ${metrics.wifi_rssi} dBm`, 'warning');
    }
  }
  if (metrics.signal_433 !== undefined && metrics.signal_433 < CONFIG.signal433Threshold) {
    logEvent('jamming', nodeId,
      `433 MHz signal degraded on ${NODES[nodeId].label}: ${metrics.signal_433} dBm`, 'warning');
  }
  if (metrics.snr_l1 !== undefined && metrics.snr_l1 < CONFIG.snrL1Threshold) {
    logEvent('jamming', nodeId, `GPS L1 SNR below threshold: ${metrics.snr_l1} dB-Hz`, 'critical');
  }
  if (metrics.snr_l5 !== undefined && metrics.snr_l5 < CONFIG.snrL5Threshold) {
    logEvent('jamming', nodeId, `GPS L5 SNR below threshold: ${metrics.snr_l5} dB-Hz`, 'critical');
  }
  if (metrics.satellites !== undefined && prev.satellites !== undefined) {
    const drop = prev.satellites - metrics.satellites;
    if (drop >= CONFIG.satDropThreshold) {
      logEvent('anomaly', nodeId, `Satellite count dropped: ${prev.satellites} → ${metrics.satellites}`, 'critical');
    }
  }
  if (metrics.lock_status === 'lost' && prev.lock_status === 'locked') {
    logEvent('jamming', nodeId, `GPS lock lost on ${NODES[nodeId].label}`, 'critical');
  }
  if (metrics.temperature !== undefined && prev.temperature !== undefined) {
    const jump = Math.abs(metrics.temperature - prev.temperature);
    if (jump > CONFIG.tempJumpThreshold) {
      logEvent('anomaly', nodeId, `Temperature spike: ${prev.temperature}°C → ${metrics.temperature}°C`, 'warning');
    }
  }
  if (metrics.heart_rate !== undefined) {
    if (metrics.heart_rate < CONFIG.heartRateMin || metrics.heart_rate > CONFIG.heartRateMax) {
      logEvent('medical', nodeId, `Heart rate out of range: ${metrics.heart_rate} bpm`, 'critical');
    }
  }
  if (metrics.spo2 !== undefined && metrics.spo2 < CONFIG.spo2Min) {
    logEvent('medical', nodeId, `Low SpO2: ${metrics.spo2}%`, 'critical');
  }

  lastMetrics[nodeId] = { ...lastMetrics[nodeId], ...metrics };
}

// ─── Core State Update ────────────────────────────────────────────────────────
function updateNodeState(nodeId, metrics) {
  if (!nodeState[nodeId]) return;

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
      disruptionType: rfHealth[nodeId].disruptionType,
      packetLossRate: rfHealth[nodeId].packetLossRate,
      rssiVariance: rfHealth[nodeId].rssiVariance,
      gapCount: rfHealth[nodeId].gapCount,
      bulkSendCount: rfHealth[nodeId].bulkSendCount,
    }
  });
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
try {
  const mqttClient = mqtt.connect(MQTT_BROKER, { reconnectPeriod: 5000, connectTimeout: 3000 });
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
    if (!NODES[nodeId]) return;
    let value;
    try {
      const parsed = JSON.parse(payload.toString());
      value = typeof parsed === 'object' ? parsed : { [metric]: parsed };
    } catch {
      value = { [metric]: parseFloat(payload.toString()) || payload.toString() };
    }
    updateNodeState(nodeId, value);
  });
} catch (e) {
  console.warn('⚠️  MQTT unavailable');
}

// ─── UDP Stub ─────────────────────────────────────────────────────────────────
const UDP_PORT = process.env.UDP_PORT || 9870;
const udpSocket = dgram.createSocket('udp4');
udpSocket.on('message', (msg) => {
  try {
    const data = JSON.parse(msg.toString());
    io.emit('drone:telemetry', { ...data, timestamp: new Date().toISOString() });
  } catch (e) { console.warn('UDP parse error:', e.message); }
});
udpSocket.on('error', (err) => console.warn('UDP error:', err.message));
udpSocket.bind(UDP_PORT, () => console.log(`📡 UDP stub on port ${UDP_PORT}`));

// ─── Demo Mode ────────────────────────────────────────────────────────────────
const DEMO_MODE = process.env.DEMO_MODE !== 'false';
if (DEMO_MODE) {
  console.log('🎮 Demo mode active');
  let tick = 0;
  let jammingActive = false;
  let jammingNode = null;

  setInterval(() => {
    tick++;
    if (tick % 60 === 0 && !jammingActive) {
      const ids = Object.keys(NODES);
      jammingNode = ids[Math.floor(Math.random() * ids.length)];
      jammingActive = true;
      setTimeout(() => { jammingActive = false; jammingNode = null; }, 15000);
    }
    if (tick % 43 === 0) {
      logEvent('security', 'perimeter', '433 MHz motion sensor triggered at East Gate', 'warning');
    }
    const ij = id => jammingActive && jammingNode === id;

    // Simulate jamming pattern matching the real test doc: bulk sends + gaps + RSSI bounce
    const simulateJammedReading = (id, baseMetrics) => {
      if (!ij(id)) { updateNodeState(id, baseMetrics); return; }
      const roll = Math.random();
      if (roll < 0.3) {
        // Gap — skip this tick entirely (simulates missing transmission)
        return;
      } else if (roll < 0.5) {
        // Bulk send — fire multiple updates rapidly
        for (let i = 0; i < 4; i++) {
          setTimeout(() => updateNodeState(id, {
            ...baseMetrics,
            wifi_rssi: -88 + Math.floor(Math.random()*6-3)
          }), i * 50);
        }
      } else {
        updateNodeState(id, { ...baseMetrics, wifi_rssi: -80 + Math.floor(Math.random()*10-5) });
      }
    };

    simulateJammedReading('building-a',  { video_fps: +(Math.random()*5+25).toFixed(1), audio_db: +(Math.random()*10+55).toFixed(1), wifi_rssi: +(Math.random()*10-60).toFixed(0) });
    simulateJammedReading('building-b',  { temperature: +(Math.random()*3+22).toFixed(1), humidity: +(Math.random()*10+45).toFixed(1), wifi_rssi: +(Math.random()*10-58).toFixed(0), alerts_433: Math.random()>0.97?1:0 });
    simulateJammedReading('building-c',  { heart_rate: Math.floor(Math.random()*20+65), spo2: +(Math.random()*3+96).toFixed(1), wifi_rssi: +(Math.random()*10-62).toFixed(0) });
    simulateJammedReading('building-d',  { plug_state: Math.random()>0.3?'on':'off', wifi_rssi: +(Math.random()*10-55).toFixed(0) });
    simulateJammedReading('intersection',{ light_state: ['green','green','green','yellow','red','red','red'][Math.floor(tick/4)%7], wifi_rssi: +(Math.random()*10-57).toFixed(0) });
    simulateJammedReading('perimeter',   { motion_detected: Math.random()>0.92?1:0, door_open: Math.random()>0.97?1:0, signal_433: +(Math.random()*10-55).toFixed(0) });
    simulateJammedReading('gps-node',    { satellites: Math.floor(Math.random()*4+8), snr_l1: +(Math.random()*10+35).toFixed(1), snr_l5: +(Math.random()*8+38).toFixed(1), lock_status: 'locked' });
  }, 1000);
}

// ─── REST API ─────────────────────────────────────────────────────────────────
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
app.get('/api/nodes/:id/rf-events', (req, res) => {
  const { id } = req.params;
  const { limit = 50 } = req.query;
  res.json(dbAll(
    `SELECT * FROM rf_events WHERE node_id = ? ORDER BY rowid DESC LIMIT ?`,
    [id, parseInt(limit)]
  ).reverse());
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
app.get('/api/state', (req, res) => res.json({ nodes: nodeState, nodeDefinitions: NODES }));
app.get('/api/config', (req, res) => res.json(CONFIG));

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.emit('state:full', { nodes: nodeState, nodeDefinitions: NODES });
  socket.emit('config:current', CONFIG);
  socket.emit('rfhealth:full', rfHealth);
  const recentEvents = dbAll(`SELECT * FROM events ORDER BY rowid DESC LIMIT 30`).reverse();
  socket.emit('events:recent', recentEvents);

  socket.on('config:update', (updates) => {
    const prev = { ...CONFIG };
    CONFIG = { ...CONFIG, ...updates };
    console.log('⚙️  Config updated:', updates);
    if (updates.watchdogTimeout && updates.watchdogTimeout !== prev.watchdogTimeout) {
      Object.keys(NODES).forEach(id => {
        if (nodeState[id].status === 'online') resetWatchdog(id);
      });
    }
    io.emit('config:current', CONFIG);
    logEvent('system', null, `Monitoring config updated: ${Object.keys(updates).join(', ')}`, 'info');
  });

  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 Smart City Monitor on http://localhost:${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api/nodes`);
  console.log(`📡 RF Health: http://localhost:${PORT}/api/nodes/building-b/rf-health`);
  console.log(`📡 UDP: port ${UDP_PORT}\n`);
});
