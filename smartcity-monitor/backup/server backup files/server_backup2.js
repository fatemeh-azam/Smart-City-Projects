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
  'building-a':  { label: 'Building A',    type: 'hub',          metrics: ['video_fps','audio_db','wifi_rssi'] },
  'building-b':  { label: 'Building B',    type: 'environmental', metrics: ['temperature','humidity','wifi_rssi','alerts_433'] },
  'building-c':  { label: 'Building C',    type: 'medical',      metrics: ['heart_rate','spo2','wifi_rssi'] },
  'building-d':  { label: 'Building D',    type: 'automation',   metrics: ['plug_state','wifi_rssi'] },
  'intersection':{ label: 'Intersection',  type: 'traffic',      metrics: ['light_state','wifi_rssi'] },
  'perimeter':   { label: 'Perimeter',     type: 'security',     metrics: ['motion_detected','door_open','signal_433'] },
  'gps-node':    { label: 'GPS Node',      type: 'gps',          metrics: ['satellites','snr_l1','snr_l5','lock_status','lat','lng'] },
};

// ─── Monitoring Config (adjustable via Socket.io) ─────────────────────────────
let CONFIG = {
  watchdogTimeout:    15,    // seconds before node marked offline
  rssiThreshold:     -85,   // dBm — WiFi jamming alert
  signal433Threshold:-80,   // dBm — 433 MHz degradation alert
  snrL1Threshold:     25,   // dB-Hz — GPS L1 jamming alert
  snrL5Threshold:     25,   // dB-Hz — GPS L5 jamming alert
  tempJumpThreshold:   5,   // °C — sudden temp anomaly
  rssiJumpThreshold:  15,   // dBm — sudden RSSI drop anomaly
  satDropThreshold:    4,   // satellite count drop anomaly
  heartRateMin:       40,   // bpm — medical alert low
  heartRateMax:      120,   // bpm — medical alert high
  spo2Min:           94,    // % — SpO2 alert threshold
  packetLossWindow:  30,    // seconds — window for packet loss calculation
};

// ─── In-Memory State ──────────────────────────────────────────────────────────
const nodeState = {};
const watchdogTimers = {};
const packetCounters = {};
const lastMetrics = {};

Object.keys(NODES).forEach(id => {
  nodeState[id] = { status: 'offline', metrics: {}, lastSeen: null, packetLoss: 0 };
  packetCounters[id] = { received: 0, window: [] };
  lastMetrics[id] = {};
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

// ─── Event Logger ─────────────────────────────────────────────────────────────
function logEvent(type, nodeId, message, severity = 'info') {
  dbRun(`INSERT INTO events (type, node_id, message, severity) VALUES (?, ?, ?, ?)`,
    [type, nodeId, message, severity]);
  const event = { type, nodeId, node_id: nodeId, message, severity, timestamp: new Date().toISOString() };
  io.emit('event:new', event);
  console.log(`[${severity.toUpperCase()}] ${message}`);
  return event;
}

// ─── Watchdog: marks node offline if silent ───────────────────────────────────
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
        `${NODES[nodeId].label} went silent — no data for ${CONFIG.watchdogTimeout}s`,
        'critical');
    }
  }, CONFIG.watchdogTimeout * 1000);
}

// ─── Packet Loss Tracker ──────────────────────────────────────────────────────
function trackPacket(nodeId) {
  const now = Date.now();
  const counter = packetCounters[nodeId];
  counter.received++;
  counter.window.push(now);
  // Keep only packets within the window
  const cutoff = now - CONFIG.packetLossWindow * 1000;
  counter.window = counter.window.filter(t => t > cutoff);
  // Expected packets in window at 1/sec
  const expected = CONFIG.packetLossWindow;
  const received = counter.window.length;
  const loss = Math.max(0, Math.round((1 - received / expected) * 100));
  nodeState[nodeId].packetLoss = loss;
  if (loss > 50 && nodeState[nodeId].status === 'online') {
    logEvent('packet_loss', nodeId,
      `High packet loss on ${NODES[nodeId].label}: ${loss}% in last ${CONFIG.packetLossWindow}s`,
      'warning');
  }
  return loss;
}

// ─── Anomaly Detection ────────────────────────────────────────────────────────
function detectAnomalies(nodeId, metrics) {
  const prev = lastMetrics[nodeId] || {};

  // WiFi RSSI threshold
  if (metrics.wifi_rssi !== undefined && metrics.wifi_rssi < CONFIG.rssiThreshold) {
    logEvent('jamming', nodeId,
      `Low WiFi RSSI on ${NODES[nodeId].label}: ${metrics.wifi_rssi} dBm (threshold: ${CONFIG.rssiThreshold})`,
      'warning');
  }

  // Sudden RSSI drop
  if (metrics.wifi_rssi !== undefined && prev.wifi_rssi !== undefined) {
    const drop = prev.wifi_rssi - metrics.wifi_rssi;
    if (drop > CONFIG.rssiJumpThreshold) {
      logEvent('anomaly', nodeId,
        `Sudden RSSI drop on ${NODES[nodeId].label}: ${prev.wifi_rssi} → ${metrics.wifi_rssi} dBm`,
        'warning');
    }
  }

  // 433 MHz signal degradation
  if (metrics.signal_433 !== undefined && metrics.signal_433 < CONFIG.signal433Threshold) {
    logEvent('jamming', nodeId,
      `433 MHz signal degraded on ${NODES[nodeId].label}: ${metrics.signal_433} dBm (threshold: ${CONFIG.signal433Threshold})`,
      'warning');
  }

  // GPS SNR thresholds
  if (metrics.snr_l1 !== undefined && metrics.snr_l1 < CONFIG.snrL1Threshold) {
    logEvent('jamming', nodeId,
      `GPS L1 SNR below threshold: ${metrics.snr_l1} dB-Hz (threshold: ${CONFIG.snrL1Threshold})`,
      'critical');
  }
  if (metrics.snr_l5 !== undefined && metrics.snr_l5 < CONFIG.snrL5Threshold) {
    logEvent('jamming', nodeId,
      `GPS L5 SNR below threshold: ${metrics.snr_l5} dB-Hz (threshold: ${CONFIG.snrL5Threshold})`,
      'critical');
  }

  // GPS satellite count drop
  if (metrics.satellites !== undefined && prev.satellites !== undefined) {
    const drop = prev.satellites - metrics.satellites;
    if (drop >= CONFIG.satDropThreshold) {
      logEvent('anomaly', nodeId,
        `Satellite count dropped on ${NODES[nodeId].label}: ${prev.satellites} → ${metrics.satellites}`,
        'critical');
    }
  }

  // GPS lock lost
  if (metrics.lock_status === 'lost' && prev.lock_status === 'locked') {
    logEvent('jamming', nodeId, `GPS lock lost on ${NODES[nodeId].label}`, 'critical');
  }

  // Temperature jump
  if (metrics.temperature !== undefined && prev.temperature !== undefined) {
    const jump = Math.abs(metrics.temperature - prev.temperature);
    if (jump > CONFIG.tempJumpThreshold) {
      logEvent('anomaly', nodeId,
        `Temperature spike on ${NODES[nodeId].label}: ${prev.temperature}°C → ${metrics.temperature}°C`,
        'warning');
    }
  }

  // Medical alerts
  if (metrics.heart_rate !== undefined) {
    if (metrics.heart_rate < CONFIG.heartRateMin || metrics.heart_rate > CONFIG.heartRateMax) {
      logEvent('medical', nodeId,
        `Heart rate out of range on ${NODES[nodeId].label}: ${metrics.heart_rate} bpm`,
        'critical');
    }
  }
  if (metrics.spo2 !== undefined && metrics.spo2 < CONFIG.spo2Min) {
    logEvent('medical', nodeId,
      `Low SpO2 on ${NODES[nodeId].label}: ${metrics.spo2}% (threshold: ${CONFIG.spo2Min}%)`,
      'critical');
  }

  // Store for next comparison
  lastMetrics[nodeId] = { ...lastMetrics[nodeId], ...metrics };
}

// ─── Core State Update ────────────────────────────────────────────────────────
function updateNodeState(nodeId, metrics) {
  if (!nodeState[nodeId]) return;

  resetWatchdog(nodeId);
  trackPacket(nodeId);
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
    nodeId,
    metrics,
    status: 'online',
    lastSeen: nodeState[nodeId].lastSeen,
    packetLoss: nodeState[nodeId].packetLoss,
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

// ─── UDP Stub (Crazyflie / Unity) ─────────────────────────────────────────────
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
    updateNodeState('building-a',  { video_fps: ij('building-a')  ? 0    : +(Math.random()*5+25).toFixed(1),  audio_db:  ij('building-a')  ? null : +(Math.random()*10+55).toFixed(1), wifi_rssi: ij('building-a')  ? -95 : +(Math.random()*10-60).toFixed(0) });
    updateNodeState('building-b',  { temperature: +(Math.random()*3+22).toFixed(1), humidity: +(Math.random()*10+45).toFixed(1), wifi_rssi: ij('building-b') ? -92 : +(Math.random()*10-58).toFixed(0), alerts_433: Math.random()>0.97?1:0 });
    updateNodeState('building-c',  { heart_rate: ij('building-c') ? null : Math.floor(Math.random()*20+65), spo2: ij('building-c') ? null : +(Math.random()*3+96).toFixed(1), wifi_rssi: ij('building-c') ? -94 : +(Math.random()*10-62).toFixed(0) });
    updateNodeState('building-d',  { plug_state: ij('building-d') ? 'unknown' : (Math.random()>0.3?'on':'off'), wifi_rssi: ij('building-d') ? -90 : +(Math.random()*10-55).toFixed(0) });
    updateNodeState('intersection',{ light_state: ij('intersection') ? 'green' : ['green','green','green','yellow','red','red','red'][Math.floor(tick/4)%7], wifi_rssi: ij('intersection') ? -93 : +(Math.random()*10-57).toFixed(0) });
    updateNodeState('perimeter',   { motion_detected: ij('perimeter') ? 0 : (Math.random()>0.92?1:0), door_open: ij('perimeter') ? 0 : (Math.random()>0.97?1:0), signal_433: ij('perimeter') ? -85 : +(Math.random()*10-55).toFixed(0) });
    updateNodeState('gps-node',    { satellites: ij('gps-node') ? Math.floor(Math.random()*3) : Math.floor(Math.random()*4+8), snr_l1: ij('gps-node') ? +(Math.random()*10+10).toFixed(1) : +(Math.random()*10+35).toFixed(1), snr_l5: ij('gps-node') ? +(Math.random()*8+8).toFixed(1) : +(Math.random()*8+38).toFixed(1), lock_status: ij('gps-node') ? 'lost' : 'locked' });
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
  const recentEvents = dbAll(`SELECT * FROM events ORDER BY rowid DESC LIMIT 30`).reverse();
  socket.emit('events:recent', recentEvents);

  // Live config update from frontend
  socket.on('config:update', (updates) => {
    const prev = { ...CONFIG };
    CONFIG = { ...CONFIG, ...updates };
    console.log('⚙️  Config updated:', updates);

    // Restart watchdog timers if timeout changed
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
  console.log(`⚙️  Config: http://localhost:${PORT}/api/config`);
  console.log(`📡 UDP: port ${UDP_PORT}\n`);
});
