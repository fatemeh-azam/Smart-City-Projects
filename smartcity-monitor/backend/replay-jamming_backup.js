#!/usr/bin/env node
/**
 * replay-jamming.js
 * Replays a jamming test dataset through MQTT at real-time speed.
 * The monitoring dashboard responds exactly as it would during a live jamming event.
 *
 * Usage:
 *   node replay-jamming.js
 *   node replay-jamming.js --speed 2      (2x speed)
 *   node replay-jamming.js --speed 0.5    (half speed, slower for demos)
 *   node replay-jamming.js --node building-a
 *   node replay-jamming.js --file my-data.json
 *
 * Data file format: array of { metric, value, unit, timestamp }
 * Timestamp format: "YYYY-MM-DD HH:MM:SS" or ISO 8601
 */

const mqtt  = require('mqtt');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const DEFAULT_NODE = 'building-a';  // XIAO ESP32-S3 node ID — match your layout
const DEFAULT_FILE = path.join(__dirname, 'jamming_xiao.json');
const DEFAULT_SPEED = 1.0;  // 1.0 = real time, 2.0 = 2x speed

// ── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf('--' + name);
  return i !== -1 ? args[i + 1] : def;
}
const nodeId   = getArg('node', DEFAULT_NODE);
const dataFile = getArg('file', DEFAULT_FILE);
const speed    = parseFloat(getArg('speed', DEFAULT_SPEED));

// ── Load data ─────────────────────────────────────────────────────────────────
let data;
try {
  const raw = fs.readFileSync(dataFile, 'utf8');
  data = JSON.parse(raw);
} catch (e) {
  console.error(`Cannot read data file: ${dataFile}`);
  console.error(e.message);
  process.exit(1);
}

if (!Array.isArray(data) || data.length === 0) {
  console.error('Data file must be a non-empty JSON array');
  process.exit(1);
}

// ── Parse timestamps ──────────────────────────────────────────────────────────
function parseTs(ts) {
  if (!ts) return NaN;
  const s = String(ts);
  // Handle "YYYY-MM-DD HH:MM:SS" without timezone — treat as local time for ordering
  return new Date(s.replace(' ', 'T')).getTime();
}

// Sort by timestamp and compute inter-event delays
const sorted = [...data]
  .map(d => ({ ...d, _ts: parseTs(d.timestamp) }))
  .filter(d => !isNaN(d._ts))
  .sort((a, b) => a._ts - b._ts);

if (sorted.length === 0) {
  console.error('No valid timestamps found in data');
  process.exit(1);
}

// ── Connect MQTT ──────────────────────────────────────────────────────────────
const client = mqtt.connect(MQTT_BROKER);

client.on('error', err => {
  console.error('MQTT error:', err.message);
  process.exit(1);
});

client.on('connect', () => {
  console.log(`\n✓ Connected to MQTT: ${MQTT_BROKER}`);
  console.log(`  Node:  ${nodeId}`);
  console.log(`  File:  ${dataFile}`);
  console.log(`  Speed: ${speed}x`);
  console.log(`  Events: ${sorted.length}`);
  console.log(`  Duration: ${((sorted[sorted.length-1]._ts - sorted[0]._ts) / 1000).toFixed(0)}s of test data`);

  // Identify the gap for display
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i]._ts - sorted[i-1]._ts;
    if (delta > 5000) gaps.push({ at: sorted[i-1].timestamp, durationMs: delta });
  }
  if (gaps.length > 0) {
    console.log(`\n  Detected gaps in data:`);
    gaps.forEach(g => console.log(`    ${g.at} → ${(g.durationMs/1000).toFixed(0)}s silence`));
  }

  console.log(`\nStarting replay in 3 seconds...\n`);
  setTimeout(() => replay(sorted), 3000);
});

// ── Replay ────────────────────────────────────────────────────────────────────
function replay(events) {
  let index = 0;

  function sendNext() {
    if (index >= events.length) {
      console.log('\n✓ Replay complete');
      client.end();
      return;
    }

    const event = events[index];
    const topic = `smartcity/${nodeId}/${event.metric}`;

    // Build payload in the current format with collected_ms
    const payload = JSON.stringify({
      value:        event.value,
      unit:         event.unit || '',
      collected_ms: Date.now(),  // use current time as collected_ms for live replay
    });

    client.publish(topic, payload);

    // Progress indicator
    const pct = Math.round((index / events.length) * 100);
    const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
    const ts  = event.timestamp.toString().slice(11, 19);  // HH:MM:SS
    process.stdout.write(`\r  [${bar}] ${pct}%  ${ts}  ${event.metric}: ${event.value} ${event.unit || ''}  `);

    index++;

    if (index >= events.length) {
      sendNext();
      return;
    }

    // Delay to next event — scaled by speed factor
    const rawDelay = events[index]._ts - event._ts;
    const delay    = Math.max(0, rawDelay / speed);

    // Cap delay at 65 seconds — gaps longer than that replay as 65s
    // (prevents waiting 62 real seconds at 1x speed — cap at 10s for usability)
    const cappedDelay = Math.min(delay, 10000 / speed);

    if (rawDelay > 5000) {
      const gapSec = (rawDelay / 1000).toFixed(0);
      process.stdout.write(`\n  ⚠ Gap: ${gapSec}s silence in original data `);
      if (delay > cappedDelay) {
        process.stdout.write(`(replaying as ${(cappedDelay/1000).toFixed(1)}s at ${speed}x speed)\n  `);
      } else {
        process.stdout.write(`\n  `);
      }
    }

    setTimeout(sendNext, cappedDelay);
  }

  sendNext();
}
