import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { io } from "socket.io-client";  


// ─── Mock Socket for standalone demo ──────────────────────────────────────────
function createDemoSocket() {
  const listeners = {};
  const on = (evt, cb) => { if (!listeners[evt]) listeners[evt] = []; listeners[evt].push(cb); };
  const off = (evt, cb) => { if (listeners[evt]) listeners[evt] = listeners[evt].filter(f => f !== cb); };
  const emit = (evt, data) => { if (listeners[evt]) listeners[evt].forEach(cb => cb(data)); };

  const NODES = {
    "building-a":  { label: "Building A",   type: "hub",         metrics: { video_fps: 29.4, audio_db: 62.1, wifi_rssi: -58 } },
    "building-b":  { label: "Building B",   type: "environmental",metrics: { temperature: 23.4, humidity: 51.2, wifi_rssi: -61, alerts_433: 0 } },
    "building-c":  { label: "Building C",   type: "medical",     metrics: { heart_rate: 74, spo2: 98.2, wifi_rssi: -63 } },
    "building-d":  { label: "Building D",   type: "automation",  metrics: { plug_state: "on", wifi_rssi: -55 } },
    "intersection":{ label: "Intersection", type: "traffic",     metrics: { light_state: "green", wifi_rssi: -57 } },
    "perimeter":   { label: "Perimeter",    type: "security",    metrics: { motion_detected: 0, door_open: 0, signal_433: -58 } },
    "gps-node":    { label: "GPS Node",     type: "gps",         metrics: { satellites: 10, snr_l1: 38.5, snr_l5: 41.2, lock_status: "locked", lat: 36.154, lng: -95.992 } },
  };

  let tick = 0;
  let jammingActive = false;
  let jammingNode = null;
  let jammingBand = "";
  const history = {};
  Object.keys(NODES).forEach(id => { history[id] = []; });

  const isJammed = id => jammingActive && jammingNode === id;

  const initialEvents = [
    { id: 1, type: "system", node_id: null, message: "Monitoring system initialized", severity: "info", timestamp: new Date(Date.now()-120000).toISOString() },
    { id: 2, type: "security", node_id: "perimeter", message: "433 MHz motion sensor triggered at North Gate", severity: "warning", timestamp: new Date(Date.now()-60000).toISOString() },
    { id: 3, type: "system", node_id: null, message: "All nodes online", severity: "info", timestamp: new Date(Date.now()-30000).toISOString() },
  ];

  setTimeout(() => emit("state:full", {
    nodes: Object.fromEntries(Object.entries(NODES).map(([id, n]) => [id, { status: "online", metrics: n.metrics, lastSeen: new Date().toISOString() }])),
    nodeDefinitions: NODES,
  }), 100);
  setTimeout(() => emit("events:recent", initialEvents), 150);

  const interval = setInterval(() => {
    tick++;
    if (tick % 55 === 0 && !jammingActive) {
      const ids = Object.keys(NODES);
      jammingNode = ids[Math.floor(Math.random() * ids.length)];
      jammingActive = true;
      const bands = ["2.4 GHz Wi-Fi", "433 MHz", "GPS L1", "GPS L5"];
      jammingBand = bands[Math.floor(Math.random() * bands.length)];
      emit("event:new", { type: "jamming", node_id: jammingNode, message: `Jamming detected — ${jammingBand} band — ${NODES[jammingNode].label} degraded`, severity: "critical", timestamp: new Date().toISOString() });
      setTimeout(() => { jammingActive = false; jammingNode = null; }, 15000);
    }
    if (tick % 43 === 0) {
      emit("event:new", { type: "security", node_id: "perimeter", message: "433 MHz motion sensor triggered at East Gate", severity: "warning", timestamp: new Date().toISOString() });
    }

    const updates = {
      "building-a":  { video_fps: isJammed("building-a")  ? 0    : +(Math.random()*5+25).toFixed(1),   audio_db: isJammed("building-a")  ? null : +(Math.random()*10+55).toFixed(1), wifi_rssi: isJammed("building-a")  ? -95 : +(Math.random()*10-60).toFixed(0) },
      "building-b":  { temperature: +(Math.random()*3+22).toFixed(1), humidity: +(Math.random()*10+45).toFixed(1), wifi_rssi: isJammed("building-b") ? -92 : +(Math.random()*10-58).toFixed(0), alerts_433: isJammed("perimeter") ? 0 : (Math.random()>0.97?1:0) },
      "building-c":  { heart_rate: isJammed("building-c") ? null : Math.floor(Math.random()*20+65), spo2: isJammed("building-c") ? null : +(Math.random()*3+96).toFixed(1), wifi_rssi: isJammed("building-c") ? -94 : +(Math.random()*10-62).toFixed(0) },
      "building-d":  { plug_state: isJammed("building-d") ? "unknown" : (Math.random()>0.3?"on":"off"), wifi_rssi: isJammed("building-d") ? -90 : +(Math.random()*10-55).toFixed(0) },
      "intersection":{ light_state: isJammed("intersection") ? "green" : ["green","green","green","yellow","red","red","red"][Math.floor(tick/4)%7], wifi_rssi: isJammed("intersection") ? -93 : +(Math.random()*10-57).toFixed(0) },
      "perimeter":   { motion_detected: isJammed("perimeter") ? 0 : (Math.random()>0.92?1:0), door_open: isJammed("perimeter") ? 0 : (Math.random()>0.97?1:0), signal_433: isJammed("perimeter") ? -85 : +(Math.random()*10-55).toFixed(0) },
      "gps-node":    { satellites: isJammed("gps-node") ? Math.floor(Math.random()*3) : Math.floor(Math.random()*4+8), snr_l1: isJammed("gps-node") ? +(Math.random()*10+10).toFixed(1) : +(Math.random()*10+35).toFixed(1), snr_l5: isJammed("gps-node") ? +(Math.random()*8+8).toFixed(1) : +(Math.random()*8+38).toFixed(1), lock_status: isJammed("gps-node") ? "lost" : "locked" },
    };

    Object.entries(updates).forEach(([id, metrics]) => {
      const status = (isJammed(id) && Object.values(metrics).some(v => v === null || v === "unknown" || v === "lost" || v === 0)) ? "degraded" : "online";
      emit("node:update", { nodeId: id, metrics, status, lastSeen: new Date().toISOString() });
      if (!history[id]) history[id] = [];
      history[id].push({ t: tick, ...metrics });
      if (history[id].length > 60) history[id].shift();
    });
  }, 1000);

  return { on, off, connected: true, disconnect: () => clearInterval(interval) };
}

// ─── Constants ────────────────────────────────────────────────────────────────
const NODE_ICONS = {
  hub: "▣", environmental: "◈", medical: "♥", automation: "◉", traffic: "◐", security: "◆", gps: "◎"
};
const NODE_COLORS = {
  hub: "#378ADD", environmental: "#1D9E75", medical: "#E24B4A", automation: "#BA7517", traffic: "#7F77DD", security: "#D85A30", gps: "#0F6E56"
};
const SEVERITY_COLOR = { info: "#378ADD", warning: "#BA7517", critical: "#E24B4A", success: "#1D9E75" };
const SEVERITY_BG = { info: "#E6F1FB", warning: "#FAEEDA", critical: "#FCEBEB", success: "#EAF3DE" };
const TRAFFIC_COLOR = { green: "#1D9E75", yellow: "#BA7517", red: "#E24B4A", unknown: "#888780" };

// ─── Hooks ────────────────────────────────────────────────────────────────────
//function useSocket(url) {
//  const [socket, setSocket] = useState(null);
//  useEffect(() => {
//    // In production: const s = io(url); setSocket(s);
//    const s = createDemoSocket();
//    setSocket(s);
//    return () => s.disconnect?.();
//  }, []);
//  return socket;
//}
function useSocket(url) {
  const [socket, setSocket] = useState(null);
  useEffect(() => {
    const s = io(url);
    setSocket(s);
    return () => s.disconnect();
  }, []);
  return socket;
}

function useHistory(nodeId, metric, maxPoints = 40) {
  const [data, setData] = useState([]);
  return { data, push: useCallback((val) => {
    setData(prev => {
      const next = [...prev, { v: val, t: Date.now() }];
      return next.length > maxPoints ? next.slice(-maxPoints) : next;
    });
  }, []) };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Sparkline({ data, color = "#378ADD", height = 36 }) {
  if (!data || data.length < 2) return <div style={{ height }} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`g${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.25} />
            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#g${color.replace("#","")})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function StatusDot({ status }) {
  const colors = { online: "#1D9E75", offline: "#888780", degraded: "#E24B4A", jammed: "#E24B4A" };
  return (
    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: colors[status] || "#888", marginRight: 6, flexShrink: 0 }} />
  );
}

function Badge({ text, severity = "info" }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 20, background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity], letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
      {text}
    </span>
  );
}

function MetricRow({ label, value, unit, color, sparkData }) {
  const display = value === null || value === undefined ? "—" : `${value}`;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
      <span style={{ fontSize: 12, color: "var(--color-text-secondary)", width: 100, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 500, color: value === null ? "var(--color-text-tertiary)" : "var(--color-text-primary)", minWidth: 52 }}>{display}<span style={{ fontSize: 11, color: "var(--color-text-secondary)", marginLeft: 2 }}>{unit}</span></span>
      {sparkData && <div style={{ flex: 1 }}><Sparkline data={sparkData} color={color} height={28} /></div>}
    </div>
  );
}

function TrafficLight({ state }) {
  const lights = ["red", "yellow", "green"];
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {lights.map(c => (
        <div key={c} style={{ width: 12, height: 12, borderRadius: "50%", background: state === c ? TRAFFIC_COLOR[c] : "var(--color-border-tertiary)", transition: "background 0.3s" }} />
      ))}
      <span style={{ fontSize: 12, marginLeft: 4, color: state === "unknown" ? "var(--color-text-tertiary)" : TRAFFIC_COLOR[state], fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {state || "—"}
      </span>
    </div>
  );
}

function GPSPanel({ metrics }) {
  const lockOk = metrics?.lock_status === "locked";
  const sats = metrics?.satellites ?? 0;
  const snrL1 = metrics?.snr_l1;
  const snrL5 = metrics?.snr_l5;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
      <div style={{ padding: "8px 12px", background: lockOk ? "#EAF3DE" : "#FCEBEB", borderRadius: 8, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: lockOk ? "#3B6D11" : "#A32D2D", marginBottom: 2 }}>Lock Status</div>
        <div style={{ fontSize: 15, fontWeight: 500, color: lockOk ? "#1D9E75" : "#E24B4A" }}>{metrics?.lock_status ?? "—"}</div>
      </div>
      <div style={{ padding: "8px 12px", background: "var(--color-background-secondary)", borderRadius: 8, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>Satellites</div>
        <div style={{ fontSize: 15, fontWeight: 500 }}>{sats}</div>
      </div>
      <div style={{ padding: "8px 12px", background: "var(--color-background-secondary)", borderRadius: 8, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>SNR L1</div>
        <div style={{ fontSize: 15, fontWeight: 500, color: snrL1 < 25 ? "#E24B4A" : "var(--color-text-primary)" }}>{snrL1 ?? "—"}<span style={{ fontSize: 11 }}> dB-Hz</span></div>
      </div>
      <div style={{ padding: "8px 12px", background: "var(--color-background-secondary)", borderRadius: 8, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 2 }}>SNR L5</div>
        <div style={{ fontSize: 15, fontWeight: 500, color: snrL5 < 25 ? "#E24B4A" : "var(--color-text-primary)" }}>{snrL5 ?? "—"}<span style={{ fontSize: 11 }}> dB-Hz</span></div>
      </div>
    </div>
  );
}

function NodeCard({ id, def, state, histories }) {
  const color = NODE_COLORS[def.type] || "#888";
  const m = state?.metrics || {};
  const status = state?.status || "offline";

  const renderMetrics = () => {
    switch (def.type) {
      case "hub": return (<>
        <MetricRow label="Video" value={m.video_fps} unit="fps" color={color} sparkData={histories?.video_fps} />
        <MetricRow label="Audio" value={m.audio_db} unit="dB" color={color} sparkData={histories?.audio_db} />
        <MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} />
      </>);
      case "environmental": return (<>
        <MetricRow label="Temperature" value={m.temperature} unit="°C" color={color} sparkData={histories?.temperature} />
        <MetricRow label="Humidity" value={m.humidity} unit="%" color={color} sparkData={histories?.humidity} />
        <MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} />
        <MetricRow label="433 Alerts" value={m.alerts_433} unit="" color={color} />
      </>);
      case "medical": return (<>
        <MetricRow label="Heart Rate" value={m.heart_rate} unit="bpm" color={color} sparkData={histories?.heart_rate} />
        <MetricRow label="SpO2" value={m.spo2} unit="%" color={color} sparkData={histories?.spo2} />
        <MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} />
      </>);
      case "automation": return (<>
        <div style={{ padding: "8px 0" }}>
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>Smart Plug — </span>
          <span style={{ fontSize: 13, fontWeight: 500, color: m.plug_state === "on" ? "#1D9E75" : m.plug_state === "off" ? "#E24B4A" : "#888" }}>{m.plug_state ?? "—"}</span>
        </div>
        <MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} />
      </>);
      case "traffic": return (<>
        <div style={{ padding: "8px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
          <TrafficLight state={m.light_state} />
        </div>
        <MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} />
      </>);
      case "security": return (<>
        <MetricRow label="Motion" value={m.motion_detected ? "DETECTED" : "clear"} unit="" color={color} />
        <MetricRow label="Door" value={m.door_open ? "OPEN" : "closed"} unit="" color={color} />
        <MetricRow label="433 Signal" value={m.signal_433} unit="dBm" color={color} sparkData={histories?.signal_433} />
      </>);
      case "gps": return <GPSPanel metrics={m} />;
      default: return null;
    }
  };

  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, borderTop: `2px solid ${color}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, color, lineHeight: 1 }}>{NODE_ICONS[def.type]}</span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{def.label}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <StatusDot status={status} />
          <span style={{ fontSize: 11, color: "var(--color-text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{status}</span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{def.type}</div>
      {renderMetrics()}
    </div>
  );
}

function EventFeed({ events }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [events.length]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, overflowY: "auto", maxHeight: 320 }}>
      {events.length === 0 && <div style={{ padding: 16, color: "var(--color-text-tertiary)", fontSize: 13 }}>No events yet</div>}
      {events.map((e, i) => (
        <div key={i} style={{ display: "flex", gap: 10, padding: "8px 12px", borderBottom: "0.5px solid var(--color-border-tertiary)", alignItems: "flex-start" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: SEVERITY_COLOR[e.severity] || "#888", marginTop: 5, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "var(--color-text-primary)", lineHeight: 1.4 }}>{e.message}</div>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>
              {e.node_id ? <span style={{ marginRight: 6, color: NODE_COLORS[e.node_id] }}>{e.node_id}</span> : null}
              {new Date(e.timestamp).toLocaleTimeString()}
            </div>
          </div>
          <Badge text={e.severity} severity={e.severity} />
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function SectionHeader({ title, subtitle, right }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
      <div>
        <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--color-text-secondary)" }}>{title}</span>
        {subtitle && <span style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginLeft: 8 }}>{subtitle}</span>}
      </div>
      {right}
    </div>
  );
}

function DroneStub() {
  return (
    <div style={{ background: "var(--color-background-secondary)", border: "0.5px dashed var(--color-border-secondary)", borderRadius: 12, padding: "20px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 20, marginBottom: 6, opacity: 0.4 }}>◎</div>
      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 4 }}>Drone Telemetry</div>
      <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>UDP/Unity integration ready — up to 3 Crazyflie units</div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function SmartCityMonitor() {
  const socket = useSocket("http://localhost:3001");
  const [nodes, setNodes] = useState({});
  const [nodeDefs, setNodeDefs] = useState({});
  const [events, setEvents] = useState([]);
  const [activeTab, setActiveTab] = useState("overview");
  const [ticker, setTicker] = useState(0);
  const historyRef = useRef({});

  const pushHistory = useCallback((nodeId, metrics) => {
    if (!historyRef.current[nodeId]) historyRef.current[nodeId] = {};
    Object.entries(metrics).forEach(([k, v]) => {
      if (typeof v !== "number") return;
      if (!historyRef.current[nodeId][k]) historyRef.current[nodeId][k] = [];
      historyRef.current[nodeId][k].push({ v, t: Date.now() });
      if (historyRef.current[nodeId][k].length > 50) historyRef.current[nodeId][k].shift();
    });
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onFull = ({ nodes: n, nodeDefinitions: d }) => { setNodes(n); setNodeDefs(d); };
    const onUpdate = ({ nodeId, metrics, status, lastSeen }) => {
      setNodes(prev => ({ ...prev, [nodeId]: { ...prev[nodeId], metrics: { ...prev[nodeId]?.metrics, ...metrics }, status, lastSeen } }));
      pushHistory(nodeId, metrics);
      setTicker(t => t + 1);
    };
    const onEvent = (e) => setEvents(prev => [...prev.slice(-99), e]);
    const onRecent = (evts) => setEvents(evts);
    socket.on("state:full", onFull);
    socket.on("node:update", onUpdate);
    socket.on("event:new", onEvent);
    socket.on("events:recent", onRecent);
    return () => { socket.off?.("state:full", onFull); socket.off?.("node:update", onUpdate); socket.off?.("event:new", onEvent); socket.off?.("events:recent", onRecent); };
  }, [socket, pushHistory]);

  const onlineCount = Object.values(nodes).filter(n => n.status === "online").length;
  const criticalCount = events.filter(e => e.severity === "critical").length;
  const jammingActive = events.slice(-10).some(e => e.type === "jamming" && Date.now() - new Date(e.timestamp).getTime() < 20000);

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "sensors", label: "Sensors" },
    { id: "gps", label: "GPS" },
    { id: "events", label: `Events ${events.length > 0 ? `(${events.length})` : ""}` },
  ];

  const nodeIds = Object.keys(nodeDefs);

  return (
    <div style={{ fontFamily: "'DM Mono', 'Fira Code', 'Courier New', monospace", padding: "16px 20px", minHeight: 600 }}>
      <h2 className="sr-only">Smart City RF Monitoring System</h2>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, paddingBottom: 14, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em" }}>Smart City Monitor</div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2, letterSpacing: "0.04em" }}>RF TESTBED · LIVE</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {jammingActive && <Badge text="JAMMING ACTIVE" severity="critical" />}
          <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", background: "var(--color-background-secondary)", borderRadius: 20, fontSize: 12 }}>
            <StatusDot status="online" />
            <span style={{ color: "var(--color-text-secondary)" }}>{onlineCount}/{nodeIds.length} nodes</span>
          </div>
        </div>
      </div>

      {/* Stat Bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 20 }}>
        {[
          { label: "Online", value: onlineCount, total: nodeIds.length, color: "#1D9E75" },
          { label: "Offline", value: nodeIds.length - onlineCount, total: nodeIds.length, color: "#888780" },
          { label: "Critical Events", value: criticalCount, total: null, color: "#E24B4A" },
          { label: "Total Events", value: events.length, total: null, color: "#378ADD" },
        ].map(s => (
          <div key={s.label} style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 4, letterSpacing: "0.03em" }}>{s.label}</div>
            <div style={{ fontSize: 22, fontWeight: 500, color: s.color }}>{s.value}<span style={{ fontSize: 12, color: "var(--color-text-tertiary)", fontWeight: 400 }}>{s.total !== null ? `/${s.total}` : ""}</span></div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{ background: "none", border: "none", borderBottom: activeTab === t.id ? "2px solid var(--color-text-primary)" : "2px solid transparent", padding: "8px 14px", fontSize: 12, fontWeight: activeTab === t.id ? 500 : 400, color: activeTab === t.id ? "var(--color-text-primary)" : "var(--color-text-secondary)", cursor: "pointer", letterSpacing: "0.03em", marginBottom: -1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Overview */}
      {activeTab === "overview" && (
        <div>
          <SectionHeader title="Node Grid" subtitle={`${nodeIds.length} nodes`} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {nodeIds.map(id => (
              <NodeCard key={id} id={id} def={nodeDefs[id] || {}} state={nodes[id]} histories={historyRef.current[id] || {}} />
            ))}
            <DroneStub />
          </div>
        </div>
      )}

      {/* Tab: Sensors */}
      {activeTab === "sensors" && (
        <div>
          <SectionHeader title="Sensor Feeds" subtitle="Live sparklines" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
            {nodeIds.filter(id => nodeDefs[id]?.type !== "gps").map(id => {
              const def = nodeDefs[id] || {};
              const color = NODE_COLORS[def.type] || "#888";
              const m = nodes[id]?.metrics || {};
              const hist = historyRef.current[id] || {};
              return (
                <div key={id} style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 14, color }}>{NODE_ICONS[def.type]}</span>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{def.label}</span>
                    <StatusDot status={nodes[id]?.status || "offline"} />
                  </div>
                  {def.type === "hub" && <>
                    <MetricRow label="Video FPS" value={m.video_fps} unit="fps" color={color} sparkData={hist.video_fps} />
                    <MetricRow label="Audio" value={m.audio_db} unit="dB" color={color} sparkData={hist.audio_db} />
                    <MetricRow label="RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={hist.wifi_rssi} />
                  </>}
                  {def.type === "environmental" && <>
                    <MetricRow label="Temp" value={m.temperature} unit="°C" color={color} sparkData={hist.temperature} />
                    <MetricRow label="Humidity" value={m.humidity} unit="%" color={color} sparkData={hist.humidity} />
                    <MetricRow label="RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={hist.wifi_rssi} />
                  </>}
                  {def.type === "medical" && <>
                    <MetricRow label="Heart Rate" value={m.heart_rate} unit="bpm" color={color} sparkData={hist.heart_rate} />
                    <MetricRow label="SpO2" value={m.spo2} unit="%" color={color} sparkData={hist.spo2} />
                    <MetricRow label="RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={hist.wifi_rssi} />
                  </>}
                  {def.type === "automation" && <>
                    <MetricRow label="Plug" value={m.plug_state} unit="" color={color} />
                    <MetricRow label="RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={hist.wifi_rssi} />
                  </>}
                  {def.type === "traffic" && <>
                    <div style={{ padding: "8px 0" }}><TrafficLight state={m.light_state} /></div>
                    <MetricRow label="RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={hist.wifi_rssi} />
                  </>}
                  {def.type === "security" && <>
                    <MetricRow label="Motion" value={m.motion_detected ? "DETECTED" : "clear"} unit="" color={color} />
                    <MetricRow label="Door" value={m.door_open ? "OPEN" : "closed"} unit="" color={color} />
                    <MetricRow label="433 Signal" value={m.signal_433} unit="dBm" color={color} sparkData={hist.signal_433} />
                  </>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab: GPS */}
      {activeTab === "gps" && (
        <div>
          <SectionHeader title="GPS / GNSS Node" subtitle="SparkFun NEO-F10N · L1/L5" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "16px" }}>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em" }}>Lock & Satellites</div>
              <GPSPanel metrics={nodes["gps-node"]?.metrics} />
            </div>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "16px" }}>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em" }}>SNR History</div>
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: "#0F6E56" }}>● L1 </span>
                <span style={{ fontSize: 11, color: "#378ADD" }}>● L5</span>
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={(historyRef.current["gps-node"]?.snr_l1 || []).map((d, i) => ({ t: i, l1: d.v, l5: (historyRef.current["gps-node"]?.snr_l5 || [])[i]?.v }))}>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 50]} tick={{ fontSize: 10 }} width={28} />
                  <Tooltip formatter={(v) => v?.toFixed(1)} labelFormatter={() => ""} contentStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="l1" stroke="#0F6E56" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="l5" stroke="#378ADD" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "16px", gridColumn: "span 2" }}>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em" }}>Satellite Count History</div>
              <ResponsiveContainer width="100%" height={100}>
                <AreaChart data={historyRef.current["gps-node"]?.satellites || []}>
                  <defs>
                    <linearGradient id="satGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0F6E56" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#0F6E56" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 14]} tick={{ fontSize: 10 }} width={24} />
                  <Tooltip formatter={(v) => Math.round(v)} labelFormatter={() => ""} contentStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="v" stroke="#0F6E56" strokeWidth={1.5} fill="url(#satGrad)" dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Events */}
      {activeTab === "events" && (
        <div>
          <SectionHeader title="Event Log" subtitle={`${events.length} total`} right={
            <button onClick={() => setEvents([])} style={{ fontSize: 11, background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 6, padding: "3px 10px", cursor: "pointer", color: "var(--color-text-secondary)" }}>Clear</button>
          } />
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden" }}>
            <EventFeed events={events} />
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: 24, paddingTop: 12, borderTop: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>MQTT · Socket.io · SQLite · UDP stub ready</span>
        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>◎ Crazyflie/Unity slot reserved</span>
      </div>
    </div>
  );
}
