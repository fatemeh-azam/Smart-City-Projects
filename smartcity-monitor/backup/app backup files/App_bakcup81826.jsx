import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { io } from "socket.io-client";

// ─── Constants ────────────────────────────────────────────────────────────────
const NODE_ICONS = {
  hub: "▣", environmental: "◈", medical: "♥", automation: "◉", traffic: "◐", security: "◆", gps: "◎"
};
const NODE_COLORS = {
  hub: "#378ADD", environmental: "#1D9E75", medical: "#E24B4A", automation: "#BA7517",
  traffic: "#7F77DD", security: "#D85A30", gps: "#0F6E56"
};
const SEVERITY_COLOR = { info: "#378ADD", warning: "#BA7517", critical: "#E24B4A", success: "#1D9E75" };
const SEVERITY_BG    = { info: "#E6F1FB", warning: "#FAEEDA", critical: "#FCEBEB", success: "#EAF3DE" };
const TRAFFIC_COLOR  = { green: "#1D9E75", yellow: "#BA7517", red: "#E24B4A", unknown: "#888780" };
const DISRUPTION_COLOR = { none: "#1D9E75", partial: "#BA7517", intermittent: "#D85A30", severe: "#E24B4A" };
const DISRUPTION_BG    = { none: "#EAF3DE", partial: "#FAEEDA", intermittent: "#FAECE7", severe: "#FCEBEB" };

const DEFAULT_CONFIG = {
  watchdogTimeout: 15, rssiThreshold: -85, signal433Threshold: -80,
  snrL1Threshold: 25, snrL5Threshold: 25, tempJumpThreshold: 5,
  rssiJumpThreshold: 15, satDropThreshold: 4, heartRateMin: 40,
  heartRateMax: 120, spo2Min: 94, packetLossWindow: 30,
};

// ─── Staleness utilities ──────────────────────────────────────────────────────
// LIVE: data arrived within expected interval
// STALE: data exists but is older than watchdog timeout
// ABSENT: no data at all

function getDataState(lastSeen, watchdogTimeoutSec = 15) {
  if (!lastSeen) return "absent";
  const ageMs = Date.now() - new Date(lastSeen).getTime();
  if (ageMs < watchdogTimeoutSec * 1000) return "live";
  return "stale";
}

function formatAge(lastSeen) {
  if (!lastSeen) return null;
  const ageMs = Date.now() - new Date(lastSeen).getTime();
  if (ageMs < 60000)  return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m ago`;
  return `${Math.floor(ageMs / 3600000)}h ago`;
}

// Returns null when offline — prevents stale values being displayed as live
function liveValue(value, dataState) {
  if (dataState === "absent") return null;
  if (dataState === "stale")  return null; // show nothing, not stale data
  return value ?? null;
}

function isEventFresh(event, maxAgeMs = 30000) {
  return Date.now() - new Date(event.timestamp).getTime() < maxAgeMs;
}
function useSocket(url) {
  const [socket, setSocket] = useState(null);
  useEffect(() => {
    const s = io(url);
    setSocket(s);
    return () => s.disconnect();
  }, []);
  return socket;
}

// ─── Shared Sub-components ─────────────────────────────────────────────────────
function Sparkline({ data, color = "#378ADD", height = 36 }) {
  if (!data || data.length < 2) return <div style={{ height }} />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`g${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.25} />
            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
          fill={`url(#g${color.replace("#","")})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function StatusDot({ status }) {
  const colors = { online: "#1D9E75", offline: "#888780", degraded: "#E24B4A" };
  return <span style={{ display:"inline-block", width:8, height:8, borderRadius:"50%",
    background: colors[status] || "#888", marginRight:6, flexShrink:0 }} />;
}

function Badge({ text, severity = "info" }) {
  return <span style={{ fontSize:11, fontWeight:500, padding:"2px 8px", borderRadius:20,
    background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity],
    letterSpacing:"0.02em", whiteSpace:"nowrap" }}>{text}</span>;
}

function DisruptionBadge({ type }) {
  if (!type || type === "none") return null;
  const labels = { partial: "RF PARTIAL", intermittent: "RF INTERMITTENT", severe: "RF SEVERE" };
  return <span style={{ fontSize:10, fontWeight:500, padding:"2px 7px", borderRadius:20,
    background: DISRUPTION_BG[type], color: DISRUPTION_COLOR[type], letterSpacing:"0.03em" }}>
    {labels[type]}
  </span>;
}

function MetricRow({ label, value, unit, color, sparkData, dataState }) {
  const isOffline = dataState === "absent" || dataState === "stale";
  const display = isOffline ? "—" : (value === null || value === undefined ? "—" : `${value}`);
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 0",
      borderBottom:"0.5px solid var(--color-border-tertiary)" }}>
      <span style={{ fontSize:12, color:"var(--color-text-secondary)", width:100, flexShrink:0 }}>{label}</span>
      <span style={{ fontSize:13, fontWeight:500, minWidth:52,
        color: isOffline ? "var(--color-text-tertiary)" : value === null ? "var(--color-text-tertiary)" : "var(--color-text-primary)" }}>
        {display}<span style={{ fontSize:11, color:"var(--color-text-secondary)", marginLeft:2 }}>{!isOffline && unit}</span>
      </span>
      {/* Only show sparkline when live — stale sparklines are misleading */}
      {sparkData && !isOffline && <div style={{ flex:1 }}><Sparkline data={sparkData} color={color} height={28} /></div>}
      {sparkData && isOffline && <div style={{ flex:1 }} />}
    </div>
  );
}

function TrafficLight({ state }) {
  return (
    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
      {["red","yellow","green"].map(c => (
        <div key={c} style={{ width:12, height:12, borderRadius:"50%",
          background: state === c ? TRAFFIC_COLOR[c] : "var(--color-border-tertiary)",
          transition:"background 0.3s" }} />
      ))}
      <span style={{ fontSize:12, marginLeft:4, fontWeight:500, textTransform:"uppercase",
        letterSpacing:"0.05em", color: TRAFFIC_COLOR[state] || "var(--color-text-tertiary)" }}>
        {state || "—"}
      </span>
    </div>
  );
}

function GPSPanel({ metrics }) {
  const lockOk = metrics?.lock_status === "locked";
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:8 }}>
      <div style={{ padding:"8px 12px", background: lockOk ? "#EAF3DE" : "#FCEBEB", borderRadius:8, textAlign:"center" }}>
        <div style={{ fontSize:11, color: lockOk ? "#3B6D11" : "#A32D2D", marginBottom:2 }}>Lock Status</div>
        <div style={{ fontSize:15, fontWeight:500, color: lockOk ? "#1D9E75" : "#E24B4A" }}>{metrics?.lock_status ?? "—"}</div>
      </div>
      <div style={{ padding:"8px 12px", background:"var(--color-background-secondary)", borderRadius:8, textAlign:"center" }}>
        <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginBottom:2 }}>Satellites</div>
        <div style={{ fontSize:15, fontWeight:500 }}>{metrics?.satellites ?? 0}</div>
      </div>
      {[["SNR L1", metrics?.snr_l1, 25], ["SNR L5", metrics?.snr_l5, 25]].map(([lbl, val, thresh]) => (
        <div key={lbl} style={{ padding:"8px 12px", background:"var(--color-background-secondary)", borderRadius:8, textAlign:"center" }}>
          <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginBottom:2 }}>{lbl}</div>
          <div style={{ fontSize:15, fontWeight:500, color: val < thresh ? "#E24B4A" : "var(--color-text-primary)" }}>
            {val ?? "—"}<span style={{ fontSize:11 }}> dB-Hz</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function NodeCard({ id, def, state, histories, rfHealth, watchdogTimeout = 15 }) {
  const color  = NODE_COLORS[def.type] || "#888";
  const m      = state?.metrics || {};
  const status = state?.status  || "offline";
  const loss   = state?.packetLoss;
  const rf     = rfHealth || {};
  const lastSeen = state?.lastSeen;

  // Determine data state — drives all display decisions
  const dataState = getDataState(lastSeen, watchdogTimeout);
  const isLive    = dataState === "live";
  const age       = formatAge(lastSeen);

  const renderMetrics = () => {
    // When offline or stale — pass dataState so MetricRow shows — not stale values
    const ds = dataState;
    switch (def.type) {
      case "hub":          return (<><MetricRow label="Video"      value={m.video_fps}   unit="fps" color={color} sparkData={histories?.video_fps}   dataState={ds} /><MetricRow label="Audio"      value={m.audio_db}    unit="dB"  color={color} sparkData={histories?.audio_db}    dataState={ds} /><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi}   unit="dBm" color={color} sparkData={histories?.wifi_rssi}   dataState={ds} /></>);
      case "environmental":return (<><MetricRow label="Temperature" value={m.temperature}  unit="°C"  color={color} sparkData={histories?.temperature} dataState={ds} /><MetricRow label="Humidity"    value={m.humidity}     unit="%"   color={color} sparkData={histories?.humidity}    dataState={ds} /><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi}   unit="dBm" color={color} sparkData={histories?.wifi_rssi}   dataState={ds} /><MetricRow label="433 Alerts"  value={m.alerts_433}  unit=""    color={color}                                     dataState={ds} /></>);
      case "medical":      return (<><MetricRow label="Heart Rate"  value={m.heart_rate}   unit="bpm" color={color} sparkData={histories?.heart_rate}  dataState={ds} /><MetricRow label="SpO2"       value={m.spo2}         unit="%"   color={color} sparkData={histories?.spo2}        dataState={ds} /><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi}   unit="dBm" color={color} sparkData={histories?.wifi_rssi}   dataState={ds} /></>);
      case "automation":   return (<><div style={{ padding:"8px 0" }}><span style={{ fontSize:12, color:"var(--color-text-secondary)" }}>Smart Plug — </span><span style={{ fontSize:13, fontWeight:500, color: !isLive ? "var(--color-text-tertiary)" : m.plug_state==="on"?"#1D9E75":m.plug_state==="off"?"#E24B4A":"#888" }}>{!isLive ? "—" : m.plug_state ?? "—"}</span></div><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} dataState={ds} /></>);
      case "traffic":      return (<><div style={{ padding:"8px 0", borderBottom:"0.5px solid var(--color-border-tertiary)" }}>{isLive ? <TrafficLight state={m.light_state} /> : <span style={{ fontSize:12, color:"var(--color-text-tertiary)" }}>— offline</span>}</div><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} dataState={ds} /></>);
      case "security":     return (<><MetricRow label="Motion"      value={isLive ? (m.motion_detected ? "DETECTED" : "clear") : null} unit="" color={color} dataState={ds} /><MetricRow label="Door" value={isLive ? (m.door_open ? "OPEN" : "closed") : null} unit="" color={color} dataState={ds} /><MetricRow label="433 Signal" value={m.signal_433} unit="dBm" color={color} sparkData={histories?.signal_433} dataState={ds} /></>);
      case "gps":          return isLive ? <GPSPanel metrics={m} /> : <div style={{ padding:"16px 0", textAlign:"center", color:"var(--color-text-tertiary)", fontSize:12 }}>GPS offline — no current fix data</div>;
      default:             return null;
    }
  };

  return (
    <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
      borderRadius:12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:4,
      borderTop:`2px solid ${isLive ? color : "var(--color-border-tertiary)"}`,
      opacity: isLive ? 1 : 0.7 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:16, color: isLive ? color : "var(--color-text-tertiary)", lineHeight:1 }}>{NODE_ICONS[def.type]}</span>
          <span style={{ fontSize:13, fontWeight:500 }}>{def.label}</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <StatusDot status={status} />
          <span style={{ fontSize:11, color:"var(--color-text-secondary)", textTransform:"uppercase", letterSpacing:"0.05em" }}>{status}</span>
        </div>
      </div>

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4, flexWrap:"wrap", gap:4 }}>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <span style={{ fontSize:11, color:"var(--color-text-tertiary)", textTransform:"uppercase", letterSpacing:"0.06em" }}>{def.type}</span>
          {def.building && (
            <span style={{ fontSize:11, color:"#BA7517", fontWeight:500 }}>· {def.building}</span>
          )}
        </div>
        <div style={{ display:"flex", gap:4, alignItems:"center" }}>
          {/* PKT = Packet Loss — % of expected transmissions that did not arrive */}
          {isLive && loss !== undefined && loss > 0 &&
            <span title="Packet Loss — percentage of expected transmissions that did not arrive in the monitoring window"
              style={{ fontSize:10, color: loss > 50 ? "#E24B4A" : "#BA7517", fontWeight:500, cursor:"help" }}>
              PKT {loss}%
            </span>}
          {isLive && <DisruptionBadge type={rf.disruptionType} />}
        </div>
      </div>

      {/* Last seen — shown when offline or stale */}
      {!isLive && age && (
        <div style={{ fontSize:10, color:"var(--color-text-tertiary)", marginBottom:4,
          padding:"3px 8px", background:"var(--color-background-secondary)", borderRadius:6,
          display:"inline-flex", alignItems:"center", gap:4, alignSelf:"flex-start" }}>
          <span>⏱</span><span>Last seen {age}</span>
        </div>
      )}

      {renderMetrics()}

      {/* RF health mini-summary — only when live and disrupted */}
      {isLive && rf.disruptionType && rf.disruptionType !== "none" && (
        <div style={{ marginTop:6, paddingTop:6, borderTop:"0.5px dashed var(--color-border-tertiary)",
          display:"flex", gap:10, fontSize:10, color:"var(--color-text-tertiary)" }}>
          {rf.gapCount > 0 && <span>Gaps: <strong style={{ color:"var(--color-text-secondary)" }}>{rf.gapCount}</strong></span>}
          {rf.bulkSendCount > 0 && <span>Bulk sends: <strong style={{ color:"var(--color-text-secondary)" }}>{rf.bulkSendCount}</strong></span>}
          {rf.rssiVariance > 0 && <span>RSSI σ: <strong style={{ color:"var(--color-text-secondary)" }}>{rf.rssiVariance}</strong></span>}
        </div>
      )}
    </div>
  );
}

function EventFeed({ events, nodes, config }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior:"smooth" }); }, [events.length]);

  // Tag each event with freshness
  const taggedEvents = events.map(e => {
    const ageMs = Date.now() - new Date(e.timestamp).getTime();
    const isFresh = ageMs < 30000; // fresh if under 30s

    // Check if the source node is currently offline — if so, flag the event as stale
    const nodeState = e.node_id ? nodes?.[e.node_id] : null;
    const nodeDataState = nodeState ? getDataState(nodeState.lastSeen, config?.watchdogTimeout || 15) : "absent";
    const nodeOffline = nodeDataState !== "live";

    // Jamming/anomaly alerts from offline nodes are stale — node went offline, alert is historical
    const isStaleAlert = nodeOffline && ["jamming","anomaly","rf_disruption","medical"].includes(e.type) && !isFresh;

    return { ...e, ageMs, isFresh, nodeOffline, isStaleAlert };
  });

  return (
    <div style={{ display:"flex", flexDirection:"column", overflowY:"auto", maxHeight:320 }}>
      {taggedEvents.length === 0 && <div style={{ padding:16, color:"var(--color-text-tertiary)", fontSize:13 }}>No events yet</div>}
      {taggedEvents.map((e, i) => (
        <div key={i} style={{ display:"flex", gap:10, padding:"8px 12px",
          borderBottom:"0.5px solid var(--color-border-tertiary)", alignItems:"flex-start",
          opacity: e.isStaleAlert ? 0.45 : 1,
          background: e.isStaleAlert ? "var(--color-background-secondary)" : "transparent" }}>
          <div style={{ width:8, height:8, borderRadius:"50%",
            background: e.isStaleAlert ? "#888" : (SEVERITY_COLOR[e.severity] || "#888"),
            marginTop:5, flexShrink:0 }} />
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:12, lineHeight:1.4,
              color: e.isStaleAlert ? "var(--color-text-tertiary)" : "var(--color-text-primary)" }}>
              {e.message}
            </div>
            <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2, display:"flex", gap:6 }}>
              {e.node_id && <span style={{ color: e.isStaleAlert ? "#888" : (NODE_COLORS[e.node_id] || "#888") }}>{e.node_id}</span>}
              <span>{new Date(e.timestamp).toLocaleTimeString()}</span>
              {e.isStaleAlert && <span style={{ color:"#555", fontStyle:"italic" }}>· node offline — historical</span>}
            </div>
          </div>
          <Badge text={e.isStaleAlert ? "historical" : e.severity} severity={e.isStaleAlert ? "info" : e.severity} />
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function SectionHeader({ title, subtitle, right }) {
  return (
    <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:12 }}>
      <div>
        <span style={{ fontSize:13, fontWeight:500, letterSpacing:"0.04em", textTransform:"uppercase",
          color:"var(--color-text-secondary)" }}>{title}</span>
        {subtitle && <span style={{ fontSize:12, color:"var(--color-text-tertiary)", marginLeft:8 }}>{subtitle}</span>}
      </div>
      {right}
    </div>
  );
}

// ─── RF Analysis Tab ────────────────────────────────────────────────────────────
function TransmissionTimeline({ rhythm }) {
  if (!rhythm || rhythm.length < 2) {
    return <div style={{ padding:24, textAlign:"center", color:"var(--color-text-tertiary)", fontSize:12 }}>
      Waiting for transmission data...
    </div>;
  }
  const W = 600, H = 70, barW = Math.max(2, W / rhythm.length - 2);
  const maxInterval = Math.max(...rhythm.map(r => r.intervalMs), 2000);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H }}>
      {rhythm.map((r, i) => {
        const x = (i / rhythm.length) * W;
        const h = Math.min(H - 10, (r.intervalMs / maxInterval) * (H - 10));
        const color = r.type === "gap" ? "#E24B4A" : r.type === "bulk" ? "#BA7517" : "#1D9E75";
        return <rect key={i} x={x} y={H - h} width={barW} height={h} fill={color} opacity={0.8} rx={1} />;
      })}
      <line x1={0} y1={H-1} x2={W} y2={H-1} stroke="var(--color-border-tertiary)" strokeWidth={0.5} />
    </svg>
  );
}

function RfAnalysisTab({ nodeIds, nodeDefs, nodes, rfHealthMap, selectedNode, setSelectedNode, config }) {
  const node = selectedNode || nodeIds[0];
  const def = nodeDefs[node] || {};
  const rf = rfHealthMap[node] || {};
  const state = nodes[node] || {};
  const color = NODE_COLORS[def.type] || "#888";

  // Gate all RF analysis panels on data freshness
  const dataState = getDataState(state.lastSeen, config?.watchdogTimeout || 15);
  const isLive = dataState === "live";
  const age = formatAge(state.lastSeen);

  const disruptionLabel = {
    none: "No disruption detected",
    partial: "Partial disruption",
    intermittent: "Intermittent disruption — buffering and gaps",
    severe: "Severe disruption",
  }[rf.disruptionType || "none"];

  const OfflineGate = ({ children, label }) => {
    if (isLive) return children;
    return (
      <div style={{ padding:"20px 16px", textAlign:"center", color:"var(--color-text-tertiary)",
        fontSize:12, background:"var(--color-background-secondary)", borderRadius:8 }}>
        <div style={{ marginBottom:4 }}>— {label} unavailable</div>
        <div style={{ fontSize:11 }}>
          {dataState === "stale" ? `Last data ${age} — node offline` : "No data received from this node"}
        </div>
      </div>
    );
  };

  return (
    <div>
      <SectionHeader title="RF Disruption Analysis" subtitle="Transmission rhythm · packet loss · signal stability" />

      {/* Node selector */}
      <div style={{ display:"flex", gap:6, marginBottom:16, flexWrap:"wrap" }}>
        {nodeIds.map(id => (
          <button key={id} onClick={() => setSelectedNode(id)} style={{
            fontSize:11, padding:"5px 12px", borderRadius:20, cursor:"pointer", fontFamily:"inherit",
            border: node===id ? `1px solid ${NODE_COLORS[nodeDefs[id]?.type]||"#888"}` : "0.5px solid var(--color-border-tertiary)",
            background: node===id ? (DISRUPTION_BG[rfHealthMap[id]?.disruptionType] || "var(--color-background-secondary)") : "var(--color-background-primary)",
            color: node===id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            fontWeight: node===id ? 500 : 400 }}>
            {nodeDefs[id]?.label || id}
          </button>
        ))}
      </div>

      {/* Status banner */}
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderRadius:12, marginBottom:16,
        background: !isLive ? "var(--color-background-secondary)" : (DISRUPTION_BG[rf.disruptionType] || "var(--color-background-secondary)") }}>
        <span style={{ width:10, height:10, borderRadius:"50%",
          background: !isLive ? "#888" : (DISRUPTION_COLOR[rf.disruptionType] || "#888") }} />
        <div>
          <div style={{ fontSize:13, fontWeight:500,
            color: !isLive ? "var(--color-text-tertiary)" : (DISRUPTION_COLOR[rf.disruptionType] || "var(--color-text-primary)") }}>
            {!isLive
              ? `Node offline${age ? ` — last seen ${age}` : ""} — RF data is historical`
              : disruptionLabel}
          </div>
          <div style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>{def.label} · {node}</div>
        </div>
      </div>

      {/* Summary stat cards — dim when offline */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:16,
        opacity: isLive ? 1 : 0.4 }}>
        {[
          { label:"Packet loss",   value:`${rf.packetLossRate ?? 0}%`, color: (rf.packetLossRate||0) > 30 ? "#E24B4A" : "#1D9E75" },
          { label:"Gap events",    value: rf.gapCount ?? 0,            color: (rf.gapCount||0) > 0 ? "#E24B4A" : "var(--color-text-primary)" },
          { label:"Bulk sends",    value: rf.bulkSendCount ?? 0,       color: (rf.bulkSendCount||0) > 0 ? "#BA7517" : "var(--color-text-primary)" },
          { label:"RSSI variance", value: rf.rssiVariance ?? 0,        color: (rf.rssiVariance||0) > 3 ? "#BA7517" : "var(--color-text-primary)" },
        ].map(s => (
          <div key={s.label} style={{ background:"var(--color-background-secondary)", borderRadius:8, padding:"10px 12px" }}>
            <div style={{ fontSize:10, color:"var(--color-text-secondary)", marginBottom:4 }}>{s.label}</div>
            <div style={{ fontSize:20, fontWeight:500, color: isLive ? s.color : "var(--color-text-tertiary)" }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Transmission rhythm — only meaningful when live */}
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
        borderRadius:12, padding:"14px 16px", marginBottom:16 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
          color:"var(--color-text-tertiary)", marginBottom:8 }}>Transmission rhythm</div>
        {isLive ? <>
          <div style={{ display:"flex", gap:14, marginBottom:8, fontSize:10, color:"var(--color-text-tertiary)" }}>
            <span><span style={{ display:"inline-block", width:8, height:8, background:"#1D9E75", borderRadius:2, marginRight:4 }} />Normal</span>
            <span><span style={{ display:"inline-block", width:8, height:8, background:"#BA7517", borderRadius:2, marginRight:4 }} />Bulk send (buffered)</span>
            <span><span style={{ display:"inline-block", width:8, height:8, background:"#E24B4A", borderRadius:2, marginRight:4 }} />Gap (packet loss)</span>
          </div>
          <TransmissionTimeline rhythm={rf.transmissionRhythm} />
          <div style={{ fontSize:10, color:"var(--color-text-tertiary)", marginTop:6 }}>
            Bar height = interval since previous reading. Tall red bars indicate transmission gaps.
          </div>
        </> : <OfflineGate label="Transmission rhythm">null</OfflineGate>}
      </div>

      {/* RSSI stability — only meaningful when live */}
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
        borderRadius:12, padding:"14px 16px", marginBottom:16 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
          color:"var(--color-text-tertiary)", marginBottom:8 }}>WiFi RSSI stability</div>
        {isLive && (rf.rssiHistory||[]).length > 1 ? <>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={(rf.rssiHistory || []).map((v, i) => ({ i, v }))}>
              <XAxis dataKey="i" hide />
              <YAxis domain={['dataMin - 5', 'dataMax + 5']} tick={{ fontSize:10 }} width={36} />
              <Tooltip formatter={v => `${v} dBm`} labelFormatter={() => ""} contentStyle={{ fontSize:11 }} />
              <ReferenceLine y={-85} stroke="#E24B4A" strokeDasharray="3 3" strokeWidth={1} />
              <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={{ r:2 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ fontSize:10, color:"var(--color-text-tertiary)", marginTop:4 }}>
            Dashed red line = poor signal threshold ({-85} dBm)
          </div>
        </> : <OfflineGate label="RSSI stability chart">null</OfflineGate>}
      </div>

      {/* Disruption pattern explanation, matches the jamming test doc structure */}
      <div style={{ background:"var(--color-background-secondary)", borderRadius:12, padding:"14px 16px" }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
          color:"var(--color-text-tertiary)", marginBottom:10 }}>Pattern interpretation</div>
        <div style={{ display:"flex", flexDirection:"column", gap:8, fontSize:12 }}>
          <div style={{ display:"flex", justifyContent:"space-between" }}>
            <span style={{ color:"var(--color-text-secondary)" }}>Data buffering</span>
            <span style={{ fontWeight:500, color: (rf.bulkSendCount||0) > 0 ? "#BA7517" : "var(--color-text-tertiary)" }}>
              {(rf.bulkSendCount||0) > 0 ? "Detected — device queuing under interference" : "Not observed"}
            </span>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between" }}>
            <span style={{ color:"var(--color-text-secondary)" }}>Packet loss</span>
            <span style={{ fontWeight:500, color: (rf.gapCount||0) > 0 ? "#E24B4A" : "var(--color-text-tertiary)" }}>
              {(rf.gapCount||0) > 0 ? `Confirmed — ${rf.gapCount} gap(s) observed` : "Not observed"}
            </span>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between" }}>
            <span style={{ color:"var(--color-text-secondary)" }}>Signal instability</span>
            <span style={{ fontWeight:500, color: (rf.rssiVariance||0) > 3 ? "#BA7517" : "var(--color-text-tertiary)" }}>
              {(rf.rssiVariance||0) > 3 ? `RSSI σ ${rf.rssiVariance} dBm — fluctuating` : "Stable"}
            </span>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between" }}>
            <span style={{ color:"var(--color-text-secondary)" }}>Last recovery time</span>
            <span style={{ fontWeight:500 }}>
              {rf.lastRecoveryMs ? `${(rf.lastRecoveryMs/1000).toFixed(1)}s` : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DroneStub() {
  return (
    <div style={{ background:"var(--color-background-secondary)", border:"0.5px dashed var(--color-border-secondary)",
      borderRadius:12, padding:"20px 16px", textAlign:"center" }}>
      <div style={{ fontSize:20, marginBottom:6, opacity:0.4 }}>◎</div>
      <div style={{ fontSize:12, fontWeight:500, color:"var(--color-text-secondary)", marginBottom:4 }}>Drone Telemetry</div>
      <div style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>UDP/Unity integration ready for Crazyflie units</div>
    </div>
  );
}

function SettingsPanel({ config, onUpdate }) {
  const [local, setLocal] = useState(config);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setLocal(config); }, [config]);
  const set = (key, val) => setLocal(prev => ({ ...prev, [key]: val }));
  const save = () => { onUpdate(local); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  const reset = () => { setLocal(DEFAULT_CONFIG); onUpdate(DEFAULT_CONFIG); };

  const Row = ({ label, desc, k, min, max, step = 1, unit = "" }) => (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 140px 80px", gap:12, alignItems:"center",
      padding:"10px 0", borderBottom:"0.5px solid var(--color-border-tertiary)" }}>
      <div>
        <div style={{ fontSize:13, fontWeight:500 }}>{label}</div>
        <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2 }}>{desc}</div>
      </div>
      <input type="range" min={min} max={max} step={step} value={local[k]}
        onChange={e => set(k, parseFloat(e.target.value))} style={{ width:"100%", accentColor:"#378ADD" }} />
      <div style={{ fontSize:13, fontWeight:500, textAlign:"right", color:"#378ADD" }}>{local[k]}{unit}</div>
    </div>
  );

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
        <SectionHeader title="Monitoring Parameters" subtitle="Applied live to backend detection" />
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={reset} style={{ fontSize:11, background:"none",
            border:"0.5px solid var(--color-border-secondary)", borderRadius:6,
            padding:"5px 12px", cursor:"pointer", color:"var(--color-text-secondary)", fontFamily:"inherit" }}>
            Reset defaults
          </button>
          <button onClick={save} style={{ fontSize:11, background: saved ? "#1D9E75" : "#378ADD", color:"#fff",
            border:"none", borderRadius:6, padding:"5px 14px", cursor:"pointer", fontFamily:"inherit",
            transition:"background 0.3s", fontWeight:500 }}>
            {saved ? "✓ Saved" : "Apply"}
          </button>
        </div>
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>Network & watchdog</div>
        <Row label="Watchdog timeout" desc="Seconds of silence before node marked offline" k="watchdogTimeout" min={5} max={60} unit="s" />
        <Row label="Packet loss window" desc="Time window for packet loss calculation" k="packetLossWindow" min={10} max={120} unit="s" />
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>RF & WiFi</div>
        <Row label="RSSI threshold" desc="Alert when WiFi RSSI drops below this" k="rssiThreshold" min={-100} max={-50} unit=" dBm" />
        <Row label="RSSI jump alert" desc="Alert on sudden RSSI drop larger than this" k="rssiJumpThreshold" min={5} max={40} unit=" dB" />
        <Row label="433 MHz threshold" desc="Alert when 433 signal drops below this" k="signal433Threshold" min={-100} max={-40} unit=" dBm" />
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>GPS / GNSS</div>
        <Row label="SNR L1 threshold" desc="GPS L1 jamming alert below this" k="snrL1Threshold" min={5} max={50} unit=" dB-Hz" />
        <Row label="SNR L5 threshold" desc="GPS L5 jamming alert below this" k="snrL5Threshold" min={5} max={50} unit=" dB-Hz" />
        <Row label="Satellite drop alert" desc="Alert when sat count drops by this many" k="satDropThreshold" min={1} max={10} unit=" sats" />
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>Environmental</div>
        <Row label="Temp jump alert" desc="Alert on temperature spike larger than this" k="tempJumpThreshold" min={1} max={20} unit="°C" />
      </div>
      <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 18px", marginBottom:12 }}>
        <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.06em", color:"var(--color-text-tertiary)", marginBottom:8 }}>Medical</div>
        <Row label="Heart rate min" desc="Alert when heart rate drops below this" k="heartRateMin" min={20} max={60} unit=" bpm" />
        <Row label="Heart rate max" desc="Alert when heart rate exceeds this" k="heartRateMax" min={80} max={200} unit=" bpm" />
        <Row label="SpO2 minimum" desc="Alert when blood oxygen drops below this" k="spo2Min" min={85} max={99} unit="%" />
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function SmartCityMonitor() {
  const socket = useSocket("http://localhost:3001");
  const [nodes, setNodes]         = useState({});
  const [nodeDefs, setNodeDefs]   = useState({});
  const [events, setEvents]       = useState([]);
  const [config, setConfig]       = useState(DEFAULT_CONFIG);
  const [rfHealthMap, setRfHealthMap] = useState({});
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedRfNode, setSelectedRfNode] = useState(null);
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
    const onFull   = ({ nodes: n, nodeDefinitions: d }) => { setNodes(n); setNodeDefs(d); };
    const onUpdate = ({ nodeId, metrics, status, lastSeen, packetLoss, rfHealth }) => {
      setNodes(prev => ({ ...prev, [nodeId]: {
        ...prev[nodeId], metrics: { ...prev[nodeId]?.metrics, ...metrics }, status, lastSeen, packetLoss
      }}));
      if (rfHealth) setRfHealthMap(prev => ({ ...prev, [nodeId]: { ...prev[nodeId], ...rfHealth } }));
      pushHistory(nodeId, metrics);
    };
    const onEvent   = (e)    => setEvents(prev => [...prev.slice(-99), e]);
    const onRecent  = (evts) => setEvents(evts);
    const onConfig  = (cfg)  => setConfig(cfg);
    const onRfFull  = (rfMap)=> setRfHealthMap(rfMap);

    socket.on("state:full",    onFull);
    socket.on("node:update",   onUpdate);
    socket.on("event:new",     onEvent);
    socket.on("events:recent", onRecent);
    socket.on("config:current",onConfig);
    socket.on("rfhealth:full", onRfFull);

    return () => {
      socket.off("state:full",    onFull);
      socket.off("node:update",   onUpdate);
      socket.off("event:new",     onEvent);
      socket.off("events:recent", onRecent);
      socket.off("config:current",onConfig);
      socket.off("rfhealth:full", onRfFull);
    };
  }, [socket, pushHistory]);

  const handleConfigUpdate = useCallback((updates) => {
    setConfig(updates);
    socket?.emit("config:update", updates);
  }, [socket]);

  const onlineCount   = Object.values(nodes).filter(n => n.status === "online").length;
  const criticalCount = events.filter(e => e.severity === "critical").length;
  const disruptedCount= Object.values(rfHealthMap).filter(r => r.disruptionType && r.disruptionType !== "none").length;
  const jammingActive = events.slice(-10).some(e =>
    e.type === "jamming" &&
    Date.now() - new Date(e.timestamp).getTime() < 20000 &&
    nodes[e.node_id]?.status === "online" // only flag if source node is still online
  );
  const nodeIds = Object.keys(nodeDefs);

  const tabs = [
    { id:"overview",  label:"Overview" },
    { id:"sensors",   label:"Sensors" },
    { id:"gps",       label:"GPS" },
    { id:"rf",        label:`RF Analysis${disruptedCount > 0 ? ` (${disruptedCount})` : ""}` },
    { id:"events",    label:`Events${events.length > 0 ? ` (${events.length})` : ""}` },
    { id:"settings",  label:"⚙ Settings" },
  ];

  return (
    <div style={{ fontFamily:"'DM Mono','Fira Code','Courier New',monospace", padding:"16px 20px", minHeight:600 }}>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
        marginBottom:20, paddingBottom:14, borderBottom:"0.5px solid var(--color-border-tertiary)" }}>
        <div>
          <div style={{ fontSize:16, fontWeight:500, letterSpacing:"-0.01em" }}>Smart City Monitor</div>
          <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2, letterSpacing:"0.04em" }}>RF TESTBED · LIVE</div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {jammingActive && <Badge text="JAMMING ACTIVE" severity="critical" />}
          {disruptedCount > 0 && <Badge text={`${disruptedCount} RF DISRUPTED`} severity="warning" />}
          <div style={{ display:"flex", alignItems:"center", gap:5, padding:"4px 10px",
            background:"var(--color-background-secondary)", borderRadius:20, fontSize:12 }}>
            <StatusDot status="online" />
            <span style={{ color:"var(--color-text-secondary)" }}>{onlineCount}/{nodeIds.length} nodes</span>
          </div>
        </div>
      </div>

      {/* Stat Bar */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:20 }}>
        {[
          { label:"Online",         value:onlineCount,                total:nodeIds.length, color:"#1D9E75" },
          { label:"RF Disrupted",   value:disruptedCount,             total:nodeIds.length, color:"#D85A30" },
          { label:"Critical Events",value:criticalCount,              total:null,            color:"#E24B4A" },
          { label:"Total Events",   value:events.length,              total:null,            color:"#378ADD" },
        ].map(s => (
          <div key={s.label} style={{ background:"var(--color-background-secondary)", borderRadius:8, padding:"10px 12px" }}>
            <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginBottom:4 }}>{s.label}</div>
            <div style={{ fontSize:22, fontWeight:500, color:s.color }}>
              {s.value}<span style={{ fontSize:12, color:"var(--color-text-tertiary)", fontWeight:400 }}>
                {s.total !== null ? `/${s.total}` : ""}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", marginBottom:16, borderBottom:"0.5px solid var(--color-border-tertiary)", flexWrap:"wrap" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            background:"none", border:"none",
            borderBottom: activeTab===t.id ? "2px solid var(--color-text-primary)" : "2px solid transparent",
            padding:"8px 14px", fontSize:12, cursor:"pointer", fontFamily:"inherit",
            fontWeight: activeTab===t.id ? 500 : 400,
            color: activeTab===t.id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            letterSpacing:"0.03em", marginBottom:-1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Overview */}
      {activeTab === "overview" && (
        <div>
          <SectionHeader title="Node Grid" subtitle={`${nodeIds.length} nodes`} />
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))", gap:10 }}>
            {nodeIds.map(id => (
              <NodeCard key={id} id={id} def={nodeDefs[id]||{}} state={nodes[id]}
                histories={historyRef.current[id]||{}} rfHealth={rfHealthMap[id]}
                watchdogTimeout={config.watchdogTimeout} />
            ))}
            <DroneStub />
          </div>
        </div>
      )}

      {/* Tab: Sensors */}
      {activeTab === "sensors" && (
        <div>
          <SectionHeader title="Sensor Feeds" subtitle="Live sparklines" />
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:16 }}>
            {nodeIds.filter(id => nodeDefs[id]?.type !== "gps").map(id => {
              const def   = nodeDefs[id] || {};
              const color = NODE_COLORS[def.type] || "#888";
              const m     = nodes[id]?.metrics || {};
              const hist  = historyRef.current[id] || {};
              return (
                <div key={id} style={{ background:"var(--color-background-primary)",
                  border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:"14px 16px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                    <span style={{ fontSize:14, color }}>{NODE_ICONS[def.type]}</span>
                    <span style={{ fontSize:13, fontWeight:500 }}>{def.label}</span>
                    <StatusDot status={nodes[id]?.status || "offline"} />
                  </div>
                  {def.type==="hub"          && <><MetricRow label="Video FPS"  value={m.video_fps}  unit="fps" color={color} sparkData={hist.video_fps}  /><MetricRow label="Audio"      value={m.audio_db}   unit="dB"  color={color} sparkData={hist.audio_db}   /><MetricRow label="RSSI"       value={m.wifi_rssi}  unit="dBm" color={color} sparkData={hist.wifi_rssi}  /></>}
                  {def.type==="environmental"&& <><MetricRow label="Temp"       value={m.temperature} unit="°C" color={color} sparkData={hist.temperature}/><MetricRow label="Humidity"   value={m.humidity}   unit="%"   color={color} sparkData={hist.humidity}    /><MetricRow label="RSSI"       value={m.wifi_rssi}  unit="dBm" color={color} sparkData={hist.wifi_rssi}  /></>}
                  {def.type==="medical"      && <><MetricRow label="Heart Rate" value={m.heart_rate} unit="bpm" color={color} sparkData={hist.heart_rate} /><MetricRow label="SpO2"      value={m.spo2}       unit="%"   color={color} sparkData={hist.spo2}        /><MetricRow label="RSSI"       value={m.wifi_rssi}  unit="dBm" color={color} sparkData={hist.wifi_rssi}  /></>}
                  {def.type==="automation"   && <><MetricRow label="Plug"       value={m.plug_state}  unit=""   color={color} /><MetricRow label="RSSI"        value={m.wifi_rssi}  unit="dBm" color={color} sparkData={hist.wifi_rssi}  /></>}
                  {def.type==="traffic"      && <><div style={{ padding:"8px 0" }}><TrafficLight state={m.light_state} /></div><MetricRow label="RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={hist.wifi_rssi} /></>}
                  {def.type==="security"     && <><MetricRow label="Motion"     value={m.motion_detected?"DETECTED":"clear"} unit="" color={color} /><MetricRow label="Door" value={m.door_open?"OPEN":"closed"} unit="" color={color} /><MetricRow label="433 Signal" value={m.signal_433} unit="dBm" color={color} sparkData={hist.signal_433} /></>}
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
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:16 }}>
              <div style={{ fontSize:12, color:"var(--color-text-secondary)", marginBottom:12, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em" }}>Lock & Satellites</div>
              <GPSPanel metrics={nodes["gps-node"]?.metrics} />
            </div>
            <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:16 }}>
              <div style={{ fontSize:12, color:"var(--color-text-secondary)", marginBottom:8, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em" }}>SNR History</div>
              <div style={{ marginBottom:4 }}>
                <span style={{ fontSize:11, color:"#0F6E56" }}>● L1 </span>
                <span style={{ fontSize:11, color:"#378ADD" }}>● L5</span>
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={(historyRef.current["gps-node"]?.snr_l1||[]).map((d,i) => ({
                  t:i, l1:d.v, l5:(historyRef.current["gps-node"]?.snr_l5||[])[i]?.v }))}>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0,50]} tick={{ fontSize:10 }} width={28} />
                  <Tooltip formatter={v => v?.toFixed(1)} labelFormatter={() => ""} contentStyle={{ fontSize:11 }} />
                  <Line type="monotone" dataKey="l1" stroke="#0F6E56" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="l5" stroke="#378ADD" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, padding:16, gridColumn:"span 2" }}>
              <div style={{ fontSize:12, color:"var(--color-text-secondary)", marginBottom:8, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em" }}>Satellite Count History</div>
              <ResponsiveContainer width="100%" height={100}>
                <AreaChart data={historyRef.current["gps-node"]?.satellites||[]}>
                  <defs>
                    <linearGradient id="satGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#0F6E56" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#0F6E56" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0,14]} tick={{ fontSize:10 }} width={24} />
                  <Tooltip formatter={v => Math.round(v)} labelFormatter={() => ""} contentStyle={{ fontSize:11 }} />
                  <Area type="monotone" dataKey="v" stroke="#0F6E56" strokeWidth={1.5} fill="url(#satGrad)" dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Tab: RF Analysis */}
      {activeTab === "rf" && (
        <RfAnalysisTab nodeIds={nodeIds} nodeDefs={nodeDefs} nodes={nodes} rfHealthMap={rfHealthMap}
          selectedNode={selectedRfNode} setSelectedNode={setSelectedRfNode} config={config} />
      )}

      {/* Tab: Events */}
      {activeTab === "events" && (
        <div>
          <SectionHeader title="Event Log" subtitle={`${events.length} total`} right={
            <button onClick={() => setEvents([])} style={{ fontSize:11, background:"none",
              border:"0.5px solid var(--color-border-secondary)", borderRadius:6,
              padding:"3px 10px", cursor:"pointer", color:"var(--color-text-secondary)", fontFamily:"inherit" }}>
              Clear
            </button>} />
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)", borderRadius:12, overflow:"hidden" }}>
            <EventFeed events={events} nodes={nodes} config={config} />
          </div>
        </div>
      )}

      {/* Tab: Settings */}
      {activeTab === "settings" && (
        <SettingsPanel config={config} onUpdate={handleConfigUpdate} />
      )}

      {/* Footer */}
      <div style={{ marginTop:24, paddingTop:12, borderTop:"0.5px solid var(--color-border-tertiary)",
  display:"flex", justifyContent:"flex-end" }}>
  <span style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>
    Smart City RF Testbed · OCII · {new Date().getFullYear()}
  </span>
</div>
    </div>
  );
}
