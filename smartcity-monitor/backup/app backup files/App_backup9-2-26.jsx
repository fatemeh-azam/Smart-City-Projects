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

// ─── Socket Hook ──────────────────────────────────────────────────────────────
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

function MetricRow({ label, value, unit, color, sparkData }) {
  const display = value === null || value === undefined ? "—" : `${value}`;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, padding:"5px 0",
      borderBottom:"0.5px solid var(--color-border-tertiary)" }}>
      <span style={{ fontSize:12, color:"var(--color-text-secondary)", width:100, flexShrink:0 }}>{label}</span>
      <span style={{ fontSize:13, fontWeight:500, minWidth:52,
        color: value === null ? "var(--color-text-tertiary)" : "var(--color-text-primary)" }}>
        {display}<span style={{ fontSize:11, color:"var(--color-text-secondary)", marginLeft:2 }}>{unit}</span>
      </span>
      {sparkData && <div style={{ flex:1 }}><Sparkline data={sparkData} color={color} height={28} /></div>}
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

function NodeCard({ id, def, state, histories, rfHealth }) {
  const color  = NODE_COLORS[def.type] || "#888";
  const m      = state?.metrics || {};
  const status = state?.status  || "offline";
  const loss   = state?.packetLoss;
  const rf     = rfHealth || {};

  const renderMetrics = () => {
    switch (def.type) {
      case "hub":          return (<><MetricRow label="Video"      value={m.video_fps}  unit="fps" color={color} sparkData={histories?.video_fps} /><MetricRow label="Audio"      value={m.audio_db}   unit="dB"  color={color} sparkData={histories?.audio_db}  /><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi}  unit="dBm" color={color} sparkData={histories?.wifi_rssi} /></>);
      case "environmental":return (<><MetricRow label="Temperature" value={m.temperature} unit="°C" color={color} sparkData={histories?.temperature} /><MetricRow label="Humidity"    value={m.humidity}    unit="%" color={color} sparkData={histories?.humidity}    /><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi}  unit="dBm" color={color} sparkData={histories?.wifi_rssi} /><MetricRow label="433 Alerts"  value={m.alerts_433}  unit=""  color={color} /></>);
      case "medical":      return (<><MetricRow label="Heart Rate"  value={m.heart_rate}  unit="bpm" color={color} sparkData={histories?.heart_rate}  /><MetricRow label="SpO2"       value={m.spo2}        unit="%" color={color} sparkData={histories?.spo2}        /><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi}  unit="dBm" color={color} sparkData={histories?.wifi_rssi} /></>);
      case "automation":   return (<><div style={{ padding:"8px 0" }}><span style={{ fontSize:12, color:"var(--color-text-secondary)" }}>Smart Plug — </span><span style={{ fontSize:13, fontWeight:500, color: m.plug_state==="on"?"#1D9E75":m.plug_state==="off"?"#E24B4A":"#888" }}>{m.plug_state ?? "—"}</span></div><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} /></>);
      case "traffic":      return (<><div style={{ padding:"8px 0", borderBottom:"0.5px solid var(--color-border-tertiary)" }}><TrafficLight state={m.light_state} /></div><MetricRow label="Wi-Fi RSSI" value={m.wifi_rssi} unit="dBm" color={color} sparkData={histories?.wifi_rssi} /></>);
      case "security":     return (<><MetricRow label="Motion"      value={m.motion_detected ? "DETECTED" : "clear"} unit="" color={color} /><MetricRow label="Door"        value={m.door_open       ? "OPEN"     : "closed"} unit="" color={color} /><MetricRow label="433 Signal"  value={m.signal_433}  unit="dBm" color={color} sparkData={histories?.signal_433} /></>);
      case "gps":          return <GPSPanel metrics={m} />;
      default:             return null;
    }
  };

  return (
    <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
      borderRadius:12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:4,
      borderTop:`2px solid ${color}` }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:16, color, lineHeight:1 }}>{NODE_ICONS[def.type]}</span>
          <span style={{ fontSize:13, fontWeight:500 }}>{def.label}</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <StatusDot status={status} />
          <span style={{ fontSize:11, color:"var(--color-text-secondary)", textTransform:"uppercase", letterSpacing:"0.05em" }}>{status}</span>
        </div>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4, flexWrap:"wrap", gap:4 }}>
        <span style={{ fontSize:11, color:"var(--color-text-tertiary)", textTransform:"uppercase", letterSpacing:"0.06em" }}>{def.type}</span>
        <div style={{ display:"flex", gap:4, alignItems:"center" }}>
          {loss !== undefined && loss > 0 &&
            <span style={{ fontSize:10, color: loss > 50 ? "#E24B4A" : "#BA7517", fontWeight:500 }}>
              PKT {loss}%
            </span>}
          <DisruptionBadge type={rf.disruptionType} />
        </div>
      </div>
      {renderMetrics()}
      {/* RF health mini-summary, only shows if there's something to report */}
      {rf.disruptionType && rf.disruptionType !== "none" && (
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

// ─── ApiRow ──────────────────────────────────────────────────────────────────
function ApiRow({ label, path, compact }) {
  const base = "http://localhost:3001";
  const url  = base + path;
  return (
    <div onClick={() => window.open(url, "_blank")} style={{
      display:"flex", alignItems:"center", justifyContent:"space-between",
      padding: compact ? "3px 0" : "7px 0",
      borderBottom: compact ? "none" : "0.5px solid var(--color-border-tertiary)",
      cursor:"pointer", gap:8,
    }}
    onMouseEnter={e => e.currentTarget.style.opacity="0.7"}
    onMouseLeave={e => e.currentTarget.style.opacity="1"}>
      <span style={{ fontSize: compact ? 11 : 12, color:"var(--color-text-secondary)" }}>{label}</span>
      <code style={{ fontSize:10, color:"var(--color-text-tertiary)",
        background:"var(--color-background-secondary)", padding:"2px 6px",
        borderRadius:4, fontFamily:"'DM Mono','Fira Code',monospace",
        whiteSpace:"nowrap", flexShrink:0 }}>
        {path.length > 50 ? path.slice(0, 47) + "…" : path}
      </code>
    </div>
  );
}

// ─── EventFeed ───────────────────────────────────────────────────────────────
// ─── Timestamp utilities ─────────────────────────────────────────────────────
function parseEventTime(ts) {
  if (!ts) return new Date();
  const s = String(ts);
  if (!s.endsWith("Z") && !s.includes("+") && !s.match(/[+-]\d{2}:\d{2}$/)) {
    return new Date(s + "Z");
  }
  return new Date(s);
}
function formatEventTime(ts) { return parseEventTime(ts).toLocaleTimeString(); }
function eventAgeMs(ts) { return Date.now() - parseEventTime(ts).getTime(); }
function getDataState(lastSeen, watchdogTimeoutSec = 15) {
  if (!lastSeen) return "absent";
  const ageMs = Date.now() - parseEventTime(lastSeen).getTime();
  if (ageMs < watchdogTimeoutSec * 1000) return "live";
  return "stale";
}
function formatAge(lastSeen) {
  if (!lastSeen) return null;
  const ageMs = Date.now() - parseEventTime(lastSeen).getTime();
  if (ageMs < 60000)   return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m ago`;
  return `${Math.floor(ageMs / 3600000)}h ago`;
}

// ─── Event category helpers ───────────────────────────────────────────────────
function getEventCategory(e) {
  const t = e?.type || "";
  if (t.startsWith("drone")) return "drone";
  if (["jamming","rf_disruption","anomaly"].includes(t)) return "rf";
  if (t === "gps" || e?.node_id === "gps-node") return "gps";
  if (t === "medical") return "sensor";
  if (t === "watchdog") return "sensor";
  return "sensor";
}

const CATEGORY_COLORS = {
  sensor: "#378ADD", drone: "#0F6E56", gps: "#0F6E56", rf: "#D85A30"
};
const CATEGORY_LABELS = {
  sensor: "Sensor", drone: "Drone", gps: "GPS", rf: "RF"
};

// ─── EventFeed — deduplicated stream with severity + category filters ─────────
function EventFeed({ events, nodes, config }) {
  const [sevFilter, setSevFilter]   = useState("all");
  const [catFilter, setCatFilter]   = useState("all");
  const [showHistorical, setShowHistorical] = useState(false);
  const watchdog = config?.watchdogTimeout || 15;

  const tagged = events.map(e => {
    const age        = eventAgeMs(e.timestamp);
    const nodeState  = e.node_id ? nodes?.[e.node_id] : null;
    const nodeOnline = nodeState ? getDataState(nodeState.lastSeen, watchdog) === "live" : false;
    const isHistorical = !nodeOnline && age > 30000 &&
      ["jamming","anomaly","rf_disruption","medical","watchdog"].includes(e.type);
    const category = getEventCategory(e);
    return { ...e, age, nodeOnline, isHistorical, category };
  });

  // Deduplicate active events
  const dedupMap = new Map();
  tagged.filter(e => !e.isHistorical).forEach(e => {
    const key = `${e.type}:${e.node_id}:${e.message}`;
    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, { ...e, count: 1 });
    } else {
      if (parseEventTime(e.timestamp) > parseEventTime(existing.timestamp)) {
        dedupMap.set(key, { ...e, count: existing.count + 1 });
      } else { existing.count += 1; }
    }
  });

  const stream = [...dedupMap.values()]
    .sort((a, b) => parseEventTime(b.timestamp) - parseEventTime(a.timestamp));

  // Apply both filters
  const filtered = stream
    .filter(e => sevFilter === "all" || e.severity === sevFilter)
    .filter(e => catFilter === "all" || e.category === catFilter);

  const historical = tagged.filter(e => e.isHistorical);

  const sevCounts = {
    critical: stream.filter(e => e.severity === "critical").length,
    warning:  stream.filter(e => e.severity === "warning").length,
    info:     stream.filter(e => e.severity === "info").length,
  };
  const catCounts = {
    sensor: stream.filter(e => e.category === "sensor").length,
    drone:  stream.filter(e => e.category === "drone").length,
    gps:    stream.filter(e => e.category === "gps").length,
    rf:     stream.filter(e => e.category === "rf").length,
  };

  const FilterBtn = ({ value, active, onClick, color, count, label }) => (
    <button onClick={onClick} style={{
      background: "none", border: "none",
      borderBottom: active ? `2px solid ${color || "var(--color-text-primary)"}` : "2px solid transparent",
      padding: "6px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit",
      fontWeight: active ? 500 : 400, textTransform: "capitalize",
      color: active ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
      marginBottom: -1,
    }}>
      {label || value}
      {count > 0 && (
        <span style={{ marginLeft: 4, fontSize: 10, color: color || "var(--color-text-tertiary)", fontWeight: 500 }}>
          {count}
        </span>
      )}
    </button>
  );

  const EventRow = ({ e }) => (
    <div style={{ display:"flex", gap:10, padding:"8px 12px", alignItems:"flex-start",
      borderBottom:"0.5px solid var(--color-border-tertiary)",
      background: e.severity==="critical" ? "rgba(226,75,74,0.02)" : "transparent" }}>
      <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0, marginTop:5,
        background: SEVERITY_COLOR[e.severity] || "#888",
        boxShadow: e.severity==="critical" ? `0 0 4px ${SEVERITY_COLOR.critical}` : "none" }} />
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:12, lineHeight:1.4 }}>{e.message}</div>
        <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2, display:"flex", gap:6, alignItems:"center" }}>
          {e.node_id && (
            <span style={{ color: CATEGORY_COLORS[e.category] || "#888", fontWeight:500 }}>{e.node_id}</span>
          )}
          <span style={{ fontSize:9, textTransform:"uppercase", letterSpacing:"0.04em",
            color: CATEGORY_COLORS[e.category] || "#888", opacity:0.7 }}>
            {CATEGORY_LABELS[e.category]}
          </span>
          <span>{formatEventTime(e.timestamp)}</span>
        </div>
      </div>
      <div style={{ display:"flex", gap:4, alignItems:"center", flexShrink:0 }}>
        {e.count > 1 && (
          <span style={{ fontSize:10, color:"var(--color-text-tertiary)",
            background:"var(--color-background-secondary)", borderRadius:20,
            padding:"1px 7px", fontWeight:500 }}>×{e.count}</span>
        )}
        <Badge text={e.severity} severity={e.severity} />
      </div>
    </div>
  );

  return (
    <div>
      {/* Severity filter row */}
      <div style={{ display:"flex", borderBottom:"0.5px solid var(--color-border-tertiary)", padding:"0 12px" }}>
        <FilterBtn value="all" label="All" active={sevFilter==="all"} onClick={() => setSevFilter("all")} count={0} />
        <FilterBtn value="critical" active={sevFilter==="critical"} onClick={() => setSevFilter("critical")}
          color={SEVERITY_COLOR.critical} count={sevCounts.critical} />
        <FilterBtn value="warning" active={sevFilter==="warning"} onClick={() => setSevFilter("warning")}
          color={SEVERITY_COLOR.warning} count={sevCounts.warning} />
        <FilterBtn value="info" active={sevFilter==="info"} onClick={() => setSevFilter("info")}
          color={SEVERITY_COLOR.info} count={sevCounts.info} />
        <span style={{ marginLeft:"auto", fontSize:11, color:"var(--color-text-tertiary)",
          alignSelf:"center", paddingRight:4 }}>
          {filtered.length} event{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Category filter row */}
      <div style={{ display:"flex", borderBottom:"0.5px solid var(--color-border-tertiary)",
        padding:"0 12px", background:"var(--color-background-secondary)" }}>
        <FilterBtn value="all" label="All sources" active={catFilter==="all"} onClick={() => setCatFilter("all")}
          color="var(--color-text-secondary)" count={0} />
        {(["sensor","drone","gps","rf"]).map(cat => (
          catCounts[cat] > 0 && (
            <FilterBtn key={cat} value={cat} label={CATEGORY_LABELS[cat]}
              active={catFilter===cat} onClick={() => setCatFilter(cat)}
              color={CATEGORY_COLORS[cat]} count={catCounts[cat]} />
          )
        ))}
      </div>

      {/* Event stream */}
      <div style={{ overflowY:"auto", maxHeight:480 }}>
        {filtered.length === 0 && (
          <div style={{ padding:"20px 12px", color:"var(--color-text-tertiary)", fontSize:13, textAlign:"center" }}>
            {sevFilter === "all" && catFilter === "all" ? "No events yet" : "No matching events"}
          </div>
        )}
        {filtered.map((e, i) => <EventRow key={i} e={e} />)}
      </div>

      {/* Historical collapsed */}
      {historical.length > 0 && (
        <div style={{ borderTop:"0.5px solid var(--color-border-tertiary)" }}>
          <button onClick={() => setShowHistorical(v => !v)} style={{
            width:"100%", background:"none", border:"none", cursor:"pointer",
            padding:"8px 12px", textAlign:"left", fontFamily:"inherit",
            fontSize:11, color:"var(--color-text-tertiary)", display:"flex",
            alignItems:"center", justifyContent:"space-between" }}>
            <span>{showHistorical ? "▾" : "▸"} Historical — node offline ({historical.length})</span>
            <span style={{ fontSize:10 }}>click to {showHistorical ? "collapse" : "expand"}</span>
          </button>
          {showHistorical && historical.map((e, i) => (
            <div key={i} style={{ display:"flex", gap:10, padding:"6px 12px",
              borderBottom:"0.5px solid var(--color-border-tertiary)",
              opacity:0.45, alignItems:"flex-start" }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:"#888", marginTop:5, flexShrink:0 }} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, color:"var(--color-text-tertiary)" }}>{e.message}</div>
                <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:1 }}>
                  {e.node_id && <span style={{ marginRight:6 }}>{e.node_id}</span>}
                  {formatEventTime(e.timestamp)} · node offline
                </div>
              </div>
              <Badge text="historical" severity="info" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─── LiveEventRail — scrollable side rail for active events ──────────────────
function LiveEventRail({ events }) {
  const recentEvents = [...events]
    .filter(e => eventAgeMs(e.timestamp) < 300000) // last 5 min
    .sort((a, b) => parseEventTime(b.timestamp) - parseEventTime(a.timestamp))
    .slice(0, 20);

  const getCategoryColor = (type) => {
    if (!type) return "#888";
    if (type.startsWith("drone")) return "#0F6E56";
    if (["jamming","rf_disruption","anomaly"].includes(type)) return "#D85A30";
    if (type === "gps") return "#0F6E56";
    if (type === "medical") return "#E24B4A";
    if (type === "watchdog") return "#888";
    return "#378ADD";
  };

  return (
    <div style={{
      width: 220, flexShrink: 0,
      background: "var(--color-background-primary)",
      border: "0.5px solid var(--color-border-tertiary)",
      borderRadius: 12, overflow: "hidden",
      display: "flex", flexDirection: "column",
      maxHeight: "100%",
    }}>
      <div style={{
        padding: "10px 12px",
        borderBottom: "0.5px solid var(--color-border-tertiary)",
        fontSize: 10, fontWeight: 500, textTransform: "uppercase",
        letterSpacing: "0.06em", color: "var(--color-text-tertiary)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <span>Live events</span>
        {recentEvents.filter(e => e.severity === "critical").length > 0 && (
          <span style={{
            background: SEVERITY_BG.critical, color: SEVERITY_COLOR.critical,
            fontSize: 10, fontWeight: 500, padding: "1px 6px", borderRadius: 10
          }}>
            {recentEvents.filter(e => e.severity === "critical").length} critical
          </span>
        )}
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {recentEvents.length === 0 ? (
          <div style={{
            padding: "20px 12px", textAlign: "center",
            fontSize: 11, color: "var(--color-text-tertiary)"
          }}>
            <div style={{ fontSize: 16, marginBottom: 6, opacity: 0.3 }}>✓</div>
            All clear
          </div>
        ) : (
          recentEvents.map((e, i) => (
            <div key={i} style={{
              padding: "7px 10px",
              borderBottom: "0.5px solid var(--color-border-tertiary)",
              background: e.severity === "critical" ? "rgba(226,75,74,0.03)" : "transparent",
            }}>
              <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                <div style={{
                  width: 6, height: 6, borderRadius: "50%", flexShrink: 0, marginTop: 4,
                  background: SEVERITY_COLOR[e.severity] || "#888",
                  boxShadow: e.severity === "critical" ? `0 0 4px ${SEVERITY_COLOR.critical}` : "none",
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 11, lineHeight: 1.35,
                    color: "var(--color-text-primary)",
                    overflow: "hidden", textOverflow: "ellipsis",
                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                  }}>
                    {e.message}
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 2, alignItems: "center", flexWrap: "wrap" }}>
                    {e.node_id && (
                      <span style={{
                        fontSize: 9, color: getCategoryColor(e.type),
                        fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em",
                      }}>{e.node_id}</span>
                    )}
                    <span style={{ fontSize: 9, color: "var(--color-text-tertiary)" }}>
                      {formatEventTime(e.timestamp)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
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

function RfAnalysisTab({ nodeIds, nodeDefs, nodes, rfHealthMap, selectedNode, setSelectedNode }) {
  const node = selectedNode || nodeIds[0];
  const def  = nodeDefs[node] || {};
  const rf   = rfHealthMap[node] || {};
  const color = NODE_COLORS[def.type] || "#888";
  const isEventDriven = def.type === "security";

  const disruptionLabel = {
    none:         "No disruption detected",
    partial:      "Partial disruption",
    intermittent: "Intermittent disruption — buffering and gaps",
    severe:       "Severe disruption",
  }[rf.disruptionType || "none"];

  return (
    <div>
      <SectionHeader title="RF Disruption Analysis"
        subtitle={isEventDriven ? "Event-driven sensor — signal quality at event time" : "Transmission rhythm · packet loss · signal stability"} />

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

      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderRadius:12, marginBottom:16,
        background: isEventDriven ? "var(--color-background-secondary)" : (DISRUPTION_BG[rf.disruptionType] || "var(--color-background-secondary)") }}>
        <span style={{ width:10, height:10, borderRadius:"50%",
          background: isEventDriven ? "#D85A30" : (DISRUPTION_COLOR[rf.disruptionType] || "#888") }} />
        <div>
          <div style={{ fontSize:13, fontWeight:500,
            color: isEventDriven ? "var(--color-text-primary)" : (DISRUPTION_COLOR[rf.disruptionType] || "var(--color-text-primary)") }}>
            {isEventDriven ? "Event-driven sensor — transmits only on motion or door state change" : disruptionLabel}
          </div>
          <div style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>{def.label} · {node}</div>
        </div>
      </div>

      {isEventDriven ? (
        <div>
          <div style={{ background:"var(--color-background-secondary)", borderRadius:12,
            padding:"14px 16px", marginBottom:16, fontSize:12, color:"var(--color-text-secondary)",
            lineHeight:1.6, borderLeft:"3px solid #D85A30" }}>
            Transmission rhythm and packet loss analysis do not apply to this sensor.
            Silence between events means nothing happened — it is not a gap or packet loss.
            RF health is assessed from signal strength at the moment events fire.
          </div>
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, padding:"14px 16px", marginBottom:16 }}>
            <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
              color:"var(--color-text-tertiary)", marginBottom:8 }}>433 MHz signal at last event</div>
            {(rf.rssiHistory||[]).length > 1 ? (
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={(rf.rssiHistory || []).map((v, i) => ({ i, v }))}>
                  <XAxis dataKey="i" hide />
                  <YAxis domain={[dataMin => Math.min(dataMin - 5, -90), dataMax => Math.max(dataMax + 5, -60)]}
                    tick={{ fontSize:10 }} width={36} />
                  <Tooltip formatter={v => `${v} dBm`} labelFormatter={() => ""} contentStyle={{ fontSize:11 }} />
                  <ReferenceLine y={-80} stroke="#E24B4A" strokeDasharray="3 3" strokeWidth={1}
                    label={{ value:"poor signal threshold", position:"insideTopRight", fontSize:9, fill:"#E24B4A" }} />
                  <Line type="monotone" dataKey="v" name="433 MHz signal" stroke={color}
                    strokeWidth={1.5} dot={{ r:3 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div style={{ padding:"24px 0", textAlign:"center", color:"var(--color-text-tertiary)", fontSize:12 }}>
                No events recorded yet — signal data appears when motion or door events fire
              </div>
            )}
          </div>
          <div style={{ background:"var(--color-background-secondary)", borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
              color:"var(--color-text-tertiary)", marginBottom:10 }}>Signal quality</div>
            <div style={{ display:"flex", flexDirection:"column", gap:8, fontSize:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"var(--color-text-secondary)" }}>433 MHz variance</span>
                <span style={{ fontWeight:500, color: (rf.rssiVariance||0) > 3 ? "#BA7517" : "var(--color-text-tertiary)" }}>
                  {(rf.rssiVariance||0) > 3 ? `σ ${rf.rssiVariance} dBm — fluctuating between events` : "Stable"}
                </span>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"var(--color-text-secondary)" }}>Transmission rhythm analysis</span>
                <span style={{ fontWeight:500, color:"var(--color-text-tertiary)" }}>Not applicable — event-driven sensor</span>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between" }}>
                <span style={{ color:"var(--color-text-secondary)" }}>Packet loss analysis</span>
                <span style={{ fontWeight:500, color:"var(--color-text-tertiary)" }}>Not applicable — no expected publish interval</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:16 }}>
            {[
              { label:"Packet loss",   value:`${rf.packetLossRate ?? 0}%`, color: (rf.packetLossRate||0) > 30 ? "#E24B4A" : "#1D9E75" },
              { label:"Gap events",    value: rf.gapCount ?? 0,            color: (rf.gapCount||0) > 0 ? "#E24B4A" : "var(--color-text-primary)" },
              { label:"Bulk sends",    value: rf.bulkSendCount ?? 0,       color: (rf.bulkSendCount||0) > 0 ? "#BA7517" : "var(--color-text-primary)" },
              { label:"RSSI variance", value: rf.rssiVariance ?? 0,        color: (rf.rssiVariance||0) > 3 ? "#BA7517" : "var(--color-text-primary)" },
            ].map(s => (
              <div key={s.label} style={{ background:"var(--color-background-secondary)", borderRadius:8, padding:"10px 12px" }}>
                <div style={{ fontSize:10, color:"var(--color-text-secondary)", marginBottom:4 }}>{s.label}</div>
                <div style={{ fontSize:20, fontWeight:500, color:s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, padding:"14px 16px", marginBottom:16 }}>
            <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
              color:"var(--color-text-tertiary)", marginBottom:8 }}>Transmission rhythm</div>
            <div style={{ display:"flex", gap:14, marginBottom:8, fontSize:10, color:"var(--color-text-tertiary)" }}>
              <span><span style={{ display:"inline-block", width:8, height:8, background:"#1D9E75", borderRadius:2, marginRight:4 }} />Normal</span>
              <span><span style={{ display:"inline-block", width:8, height:8, background:"#BA7517", borderRadius:2, marginRight:4 }} />Bulk send (buffered)</span>
              <span><span style={{ display:"inline-block", width:8, height:8, background:"#E24B4A", borderRadius:2, marginRight:4 }} />Gap (packet loss)</span>
            </div>
            <TransmissionTimeline rhythm={rf.transmissionRhythm} />
            <div style={{ fontSize:10, color:"var(--color-text-tertiary)", marginTop:6 }}>
              Bar height = interval since previous reading. Tall red bars indicate transmission gaps.
            </div>
          </div>
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, padding:"14px 16px", marginBottom:16 }}>
            <div style={{ fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.04em",
              color:"var(--color-text-tertiary)", marginBottom:8 }}>WiFi RSSI stability</div>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={(rf.rssiHistory || []).map((v, i) => ({ i, v }))}>
                <XAxis dataKey="i" hide />
                <YAxis domain={[dataMin => Math.min(dataMin - 5, -90), dataMax => Math.max(dataMax + 5, -60)]}
                  tick={{ fontSize:10 }} width={36} />
                <Tooltip formatter={v => `${v} dBm`} labelFormatter={() => ""} contentStyle={{ fontSize:11 }} />
                <ReferenceLine y={-85} stroke="#E24B4A" strokeDasharray="3 3" strokeWidth={1}
                  label={{ value:"poor signal threshold", position:"insideTopRight", fontSize:9, fill:"#E24B4A" }} />
                <Line type="monotone" dataKey="v" name="WiFi RSSI" stroke={color}
                  strokeWidth={1.5} dot={{ r:2 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
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
      )}
    </div>
  );
}

// ─── DroneCard (overview tile) ───────────────────────────────────────────────
function DroneCard({ id, drone }) {
  if (!drone) return null;
  const color   = "#0F6E56";
  const ageMs   = drone.lastSeen ? Date.now() - new Date(drone.lastSeen).getTime() : Infinity;
  const isLive  = ageMs < 3000;
  const batColor = !drone.battery ? "#888"
    : drone.battery < 3.2 ? "#E24B4A"
    : drone.battery < 3.5 ? "#BA7517" : "#1D9E75";

  return (
    <div style={{ background:"var(--color-background-primary)",
      border:"0.5px solid var(--color-border-tertiary)", borderRadius:12,
      padding:"14px 16px", display:"flex", flexDirection:"column", gap:4,
      borderTop:`2px solid ${isLive ? color : "var(--color-border-tertiary)"}`,
      opacity: isLive ? 1 : 0.7 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:16, color: isLive ? color : "var(--color-text-tertiary)" }}>⬡</span>
          <span style={{ fontSize:13, fontWeight:500 }}>{id}</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <StatusDot status={isLive ? "online" : "offline"} />
          <span style={{ fontSize:11, color:"var(--color-text-secondary)",
            textTransform:"uppercase", letterSpacing:"0.05em" }}>
            {isLive ? "airborne" : "offline"}
          </span>
        </div>
      </div>
      <div style={{ fontSize:11, color:"#0F6E56", fontWeight:500, marginBottom:4 }}>
        drone · Crazyflie (Lighthouse)
      </div>
      {isLive ? (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, marginBottom:4 }}>
            {[["X", drone.x], ["Y", drone.y], ["Z", drone.z]].map(([label, val]) => (
              <div key={label} style={{ background:"var(--color-background-secondary)",
                borderRadius:6, padding:"5px 8px" }}>
                <div style={{ fontSize:10, color:"var(--color-text-tertiary)" }}>{label}</div>
                <div style={{ fontSize:12, fontWeight:500, color }}>
                  {val != null ? val.toFixed(2) : "—"}<span style={{ fontSize:10, color:"var(--color-text-tertiary)" }}>m</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:10, fontSize:11, flexWrap:"wrap",
            borderTop:"0.5px solid var(--color-border-tertiary)", paddingTop:6 }}>
            <span style={{ color:"var(--color-text-secondary)" }}>
              Battery <strong style={{ color: batColor }}>
                {drone.battery != null ? `${drone.battery.toFixed(2)}V` : "—"}
              </strong>
            </span>
            {drone.halt && <span style={{ color:"#E24B4A", fontWeight:500 }}>⚠ HALTED</span>}
          </div>
        </>
      ) : (
        <div style={{ fontSize:12, color:"var(--color-text-tertiary)", padding:"8px 0" }}>
          No telemetry — not flying
        </div>
      )}
    </div>
  );
}

// ─── DroneTab — live flight monitoring ───────────────────────────────────────

// ─── DroneTab — live flight monitoring ───────────────────────────────────────
function DroneTab({ droneState, dronePathRef, events }) {
    const canvasRef = useRef(null);
    const droneIds    = Object.keys(droneState);
    const droneEvents = (events || []).filter(e => e.type === "drone_battery" || e.type === "drone_attack");
    const [layoutData, setLayoutData] = useState(null);
    const [layoutLoading, setLayoutLoading] = useState(true);
    const [clearPathTrigger, setClearPathTrigger] = useState(0);
    const prevDroneStatus = useRef({});
    const prevPositionRef = useRef({});

    // ─── Zoom state ─────────────────────────────────────────────────────────────
    const [zoomLevel, setZoomLevel] = useState(1);
    const MIN_ZOOM = 0.5;
    const MAX_ZOOM = 4;
    const ZOOM_STEP = 0.25;

    // ─── Fetch layout from backend ──────────────────────────────────────────────
    useEffect(() => {
        const fetchLayout = async () => {
            try {
                const response = await fetch("http://localhost:3001/api/layout");
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                setLayoutData(data);
                console.log("📐 Layout loaded:", data.sensors?.length || 0, "sensors,", data.buildings?.length || 0, "buildings");
            } catch (err) {
                console.warn("Failed to load layout:", err.message);
                setLayoutData({ sensors: [], buildings: [], router: { mx: 0, my: 0 } });
            } finally {
                setLayoutLoading(false);
            }
        };
        fetchLayout();
    }, []);

    // ─── Auto-clear path when drone takes off ──────────────────────────────────
    useEffect(() => {
        Object.keys(droneState).forEach(id => {
            const drone = droneState[id];
            if (!drone || drone.x === undefined || drone.y === undefined) return;

            const prevPos = prevPositionRef.current[id];
            const currentPos = { x: drone.x, y: drone.y, z: drone.z || 0 };

            if (prevPos && prevPos.z !== undefined && currentPos.z !== undefined) {
                if (prevPos.z < 0.1 && currentPos.z > 0.3) {
                    if (dronePathRef.current[id]) {
                        dronePathRef.current[id] = [];
                        setClearPathTrigger(prev => prev + 1);
                        console.log(`🔄 Cleared path for ${id} — new flight detected (takeoff)`);
                    }
                }
            }

            prevPositionRef.current[id] = currentPos;
        });
    }, [droneState, dronePathRef]);

    // ─── Auto-clear path when drone comes back online ──────────────────────────
    useEffect(() => {
        Object.keys(droneState).forEach(id => {
            const prev = prevDroneStatus.current[id];
            const current = droneState[id]?.status || "offline";

            if (prev === "offline" && current === "online") {
                if (dronePathRef.current[id]) {
                    dronePathRef.current[id] = [];
                    setClearPathTrigger(prev => prev + 1);
                    console.log(`🔄 Cleared path for ${id} — reconnected`);
                }
            }
            prevDroneStatus.current[id] = current;
        });
    }, [droneState, dronePathRef]);

    // ─── Clear path manually ────────────────────────────────────────────────────
    const clearAllPaths = () => {
        Object.keys(dronePathRef.current).forEach(id => {
            dronePathRef.current[id] = [];
        });
        setClearPathTrigger(prev => prev + 1);
    };

    // ─── Zoom controls ──────────────────────────────────────────────────────────
    const zoomIn = () => {
        setZoomLevel(prev => Math.min(MAX_ZOOM, prev + ZOOM_STEP));
    };

    const zoomOut = () => {
        setZoomLevel(prev => Math.max(MIN_ZOOM, prev - ZOOM_STEP));
    };

    const resetZoom = () => {
        setZoomLevel(1);
    };

    // ─── Get view bounds based on zoom level ───────────────────────────────────
    const getViewBounds = useCallback(() => {
        // Base view (zoom = 1) — tighter bounds so city fills canvas
        const baseMinX = -1.4;
        const baseMaxX = 1.4;
        const baseMinY = -2.4;
        const baseMaxY = 1.8;

        const centerX = (baseMinX + baseMaxX) / 2;
        const centerY = (baseMinY + baseMaxY) / 2;
        const halfRangeX = (baseMaxX - baseMinX) / 2 / zoomLevel;
        const halfRangeY = (baseMaxY - baseMinY) / 2 / zoomLevel;

        return {
            minX: centerX - halfRangeX,
            maxX: centerX + halfRangeX,
            minY: centerY - halfRangeY,
            maxY: centerY + halfRangeY
        };
    }, [zoomLevel]);

    // ─── Get transform ──────────────────────────────────────────────────────────
    const getTransform = useCallback((W, H) => {
        const bounds = getViewBounds();
        const rangeX = bounds.maxX - bounds.minX;
        const rangeY = bounds.maxY - bounds.minY;
        const scale = Math.min(W / rangeX, H / rangeY);
        const offX = (W - rangeX * scale) / 2 - bounds.minX * scale;
        const offY = (H - rangeY * scale) / 2 - bounds.minY * scale;

        return {
            scale,
            offX,
            offY,
            bounds,
            toCanvas: (x, y) => ({
                x: x * scale + offX,
                y: H - (y * scale + offY)
            })
        };
    }, [getViewBounds]);

    // ─── Draw map with layout ──────────────────────────────────────────────────
    const drawMap = useCallback((ctx, W, H) => {
        if (!layoutData || layoutLoading) return;

        const { toCanvas, bounds } = getTransform(W, H);

        // ─── Background ──────────────────────────────────────────────────────────
        ctx.fillStyle = "#0c0c0e";
        ctx.fillRect(0, 0, W, H);

        // ─── Grid ──────────────────────────────────────────────────────────────────
        ctx.strokeStyle = "rgba(255,255,255,0.03)";
        ctx.lineWidth = 0.5;
        const gridStep = 0.25;
        for (let x = Math.ceil(bounds.minX / gridStep) * gridStep; x <= bounds.maxX; x += gridStep) {
            const p1 = toCanvas(x, bounds.minY);
            const p2 = toCanvas(x, bounds.maxY);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }
        for (let y = Math.ceil(bounds.minY / gridStep) * gridStep; y <= bounds.maxY; y += gridStep) {
            const p1 = toCanvas(bounds.minX, y);
            const p2 = toCanvas(bounds.maxX, y);
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }

        // ─── Main road ────────────────────────────────────────────────────────────
        const roadCenter = layoutData.router?.mx || 0;
        const roadHalfWidth = 0.30;

        ctx.fillStyle = "rgba(60, 60, 70, 0.15)";
        const roadLeft = toCanvas(roadCenter - roadHalfWidth, 0).x;
        const roadRight = toCanvas(roadCenter + roadHalfWidth, 0).x;
        const roadTop = toCanvas(0, bounds.maxY).y;
        const roadBottom = toCanvas(0, bounds.minY).y;
        ctx.fillRect(roadLeft, roadBottom, roadRight - roadLeft, roadTop - roadBottom);

        ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 8]);
        ctx.beginPath();
        ctx.moveTo(toCanvas(roadCenter, bounds.minY).x, toCanvas(0, bounds.minY).y);
        ctx.lineTo(toCanvas(roadCenter, bounds.maxY).x, toCanvas(0, bounds.maxY).y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.lineWidth = 0.5;
        for (let offset of [-roadHalfWidth, roadHalfWidth]) {
            const x = toCanvas(roadCenter + offset, 0).x;
            ctx.beginPath();
            ctx.moveTo(x, toCanvas(0, bounds.minY).y);
            ctx.lineTo(x, toCanvas(0, bounds.maxY).y);
            ctx.stroke();
        }

        // ─── Buildings ──────────────────────────────────────────────────────────
        const buildingColors = {
            'story1': 'rgba(100, 150, 200, 0.18)',
            'story3': 'rgba(150, 200, 100, 0.18)',
            'hospital': 'rgba(200, 100, 100, 0.18)',
            'flat': 'rgba(150, 150, 200, 0.12)',
        };
        const buildingBorders = {
            'story1': 'rgba(100, 150, 200, 0.35)',
            'story3': 'rgba(150, 200, 100, 0.35)',
            'hospital': 'rgba(200, 100, 100, 0.35)',
            'flat': 'rgba(150, 150, 200, 0.25)',
        };
        const buildingIcons = {
            'story1': '🏢',
            'story3': '🏢',
            'hospital': '🏥',
            'flat': '🏗️',
        };

        (layoutData.buildings || []).forEach(b => {
            const cx = b.mx || 0;
            const cy = b.my || 0;
            const w = b.w || 0.35;
            const h = b.h || 0.35;

            if (cx < bounds.minX - 0.5 || cx > bounds.maxX + 0.5 || cy < bounds.minY - 0.5 || cy > bounds.maxY + 0.5) return;

            const p1 = toCanvas(cx - w / 2, cy - h / 2);
            const p2 = toCanvas(cx + w / 2, cy + h / 2);

            const bw = p2.x - p1.x;
            const bh = p2.y - p1.y;

            ctx.shadowColor = "rgba(0,0,0,0.3)";
            ctx.shadowBlur = 6;
            ctx.shadowOffsetX = 1;
            ctx.shadowOffsetY = 1;

            ctx.fillStyle = buildingColors[b.btype] || 'rgba(255,255,255,0.08)';
            ctx.fillRect(p1.x, p1.y, bw, bh);

            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;

            ctx.strokeStyle = buildingBorders[b.btype] || 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 0.5;
            ctx.strokeRect(p1.x, p1.y, bw, bh);

            ctx.fillStyle = "rgba(255,255,255,0.20)";
            ctx.font = "7px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const label = b.label || b.id || '';
            ctx.fillText(label.length > 12 ? label.slice(0, 10) + '…' : label, p1.x + bw / 2, p1.y + bh / 2 - 6);

            ctx.font = "10px sans-serif";
            ctx.fillStyle = "rgba(255,255,255,0.15)";
            ctx.fillText(buildingIcons[b.btype] || '🏢', p1.x + bw / 2, p1.y + bh / 2 + 10);
        });

        // ─── Sensors ──────────────────────────────────────────────────────────────
        const sensorColors = {
            'environmental': 'rgba(29, 158, 117, 0.6)',
            'medical': 'rgba(226, 75, 74, 0.6)',
            'hub': 'rgba(55, 138, 221, 0.6)',
            'traffic': 'rgba(127, 119, 221, 0.6)',
            'security': 'rgba(216, 90, 48, 0.6)',
            'gps': 'rgba(15, 110, 86, 0.6)',
        };
        const sensorIcons = {
            'environmental': '🌡️',
            'medical': '❤️',
            'hub': '📹',
            'traffic': '🚦',
            'security': '🔒',
            'gps': '🛰️',
        };

        (layoutData.sensors || []).forEach(s => {
            const pos = s.position;
            if (!pos || pos.mx === undefined || pos.my === undefined) return;

            if (pos.mx < bounds.minX - 0.5 || pos.mx > bounds.maxX + 0.5 || pos.my < bounds.minY - 0.5 || pos.my > bounds.maxY + 0.5) return;

            const p = toCanvas(pos.mx, pos.my);
            const color = sensorColors[s.type] || 'rgba(255,255,255,0.3)';

            const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 10);
            gradient.addColorStop(0, color.replace('0.6', '0.12'));
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 10, 0, 2 * Math.PI);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.15)";
            ctx.lineWidth = 0.5;
            ctx.stroke();

            ctx.font = "9px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillStyle = "rgba(255,255,255,0.35)";
            ctx.fillText(sensorIcons[s.type] || '●', p.x, p.y - 6);

            ctx.font = "5px monospace";
            ctx.fillStyle = "rgba(255,255,255,0.15)";
            ctx.textBaseline = "top";
            const label = s.label || s.id || '';
            ctx.fillText(label.length > 8 ? label.slice(0, 6) + '…' : label, p.x, p.y + 6);
        });

        // ─── Router ──────────────────────────────────────────────────────────────
        if (layoutData.router) {
            const r = toCanvas(layoutData.router.mx, layoutData.router.my);

            const gradient = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, 16);
            gradient.addColorStop(0, 'rgba(255, 215, 0, 0.12)');
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(r.x, r.y, 16, 0, 2 * Math.PI);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(r.x, r.y, 5, 0, 2 * Math.PI);
            ctx.fillStyle = "rgba(255, 215, 0, 0.35)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 215, 0, 0.5)";
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = "rgba(255, 215, 0, 0.4)";
            ctx.font = "6px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillText("📍 ROUTER", r.x, r.y - 8);
        }

        // ─── Start markers ──────────────────────────────────────────────────────
        const startY = layoutData.router?.my !== undefined ? layoutData.router.my - 0.15 : -2.18;
        const startPositions = [
            { x: -0.25, label: 'cf-e8', color: 'rgba(55, 138, 221, 0.35)' },
            { x: 0.25, label: 'cf-e9', color: 'rgba(15, 110, 86, 0.35)' }
        ];

        startPositions.forEach(({ x, label, color }) => {
            if (x < bounds.minX || x > bounds.maxX || startY < bounds.minY || startY > bounds.maxY) return;
            const p = toCanvas(x, startY);

            const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 12);
            gradient.addColorStop(0, color.replace('0.35', '0.12'));
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 12, 0, 2 * Math.PI);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.15)";
            ctx.lineWidth = 0.5;
            ctx.stroke();

            ctx.fillStyle = "rgba(255,255,255,0.20)";
            ctx.font = "5px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText("START", p.x, p.y + 5);
            ctx.fillStyle = "rgba(255,255,255,0.12)";
            ctx.font = "4px monospace";
            ctx.fillText(label, p.x, p.y + 12);
        });

        // ─── Bounds labels ──────────────────────────────────────────────────────
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.font = "7px monospace";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(`X: ${bounds.minX.toFixed(1)} → ${bounds.maxX.toFixed(1)}`, 6, H - 4);
        ctx.textAlign = "right";
        ctx.fillText(`Zoom: ${(zoomLevel * 100).toFixed(0)}%`, W - 6, H - 4);

    }, [layoutData, layoutLoading, getTransform, zoomLevel]);

    // ─── Draw drone paths ──────────────────────────────────────────────────────
    const drawDronePaths = useCallback((ctx, W, H) => {
        if (!layoutData) return;

        const { toCanvas } = getTransform(W, H);
        const COLORS = ["#0F6E56", "#378ADD", "#BA7517", "#E24B4A"];

        droneIds.forEach((id, idx) => {
            const path = dronePathRef.current[id] || [];
            if (path.length < 2) return;

            const color = COLORS[idx % COLORS.length];
            const drone = droneState[id];
            const ageMs = drone?.lastSeen ? Date.now() - new Date(drone.lastSeen).getTime() : Infinity;
            const isLive = ageMs < 3000;

            if (!isLive) return;

            // ─── Draw trail ──────────────────────────────────────────────────────
            for (let i = 1; i < path.length; i++) {
                const a = toCanvas(path[i - 1].x, path[i - 1].y);
                const b = toCanvas(path[i].x, path[i].y);
                const alpha = 0.2 + 0.8 * (i / path.length);
                ctx.beginPath();
                ctx.strokeStyle = color + Math.round(alpha * 255).toString(16).padStart(2, "0");
                ctx.lineWidth = 1.5;
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
            }

            // ─── Current position ────────────────────────────────────────────────
            if (path.length > 0) {
                const pos = toCanvas(path[path.length - 1].x, path[path.length - 1].y);

                const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 18);
                gradient.addColorStop(0, color + '33');
                gradient.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, 18, 0, 2 * Math.PI);
                ctx.fill();

                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI / 3) * i - Math.PI / 6;
                    const px = pos.x + 8 * Math.cos(angle);
                    const py = pos.y + 8 * Math.sin(angle);
                    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.fillStyle = color + "44";
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5;
                ctx.fill();
                ctx.stroke();

                ctx.fillStyle = color;
                ctx.font = "8px monospace";
                ctx.textAlign = "center";
                ctx.textBaseline = "bottom";
                ctx.fillText(id.toUpperCase(), pos.x, pos.y - 12);

                if (drone?.z != null) {
                    ctx.fillStyle = "rgba(255,255,255,0.4)";
                    ctx.font = "6px monospace";
                    ctx.textBaseline = "top";
                    ctx.fillText(`z:${drone.z.toFixed(2)}m`, pos.x, pos.y + 10);
                }

                if (drone?.battery != null) {
                    const batColor = drone.battery < 3.2 ? "#E24B4A" : drone.battery < 3.5 ? "#BA7517" : "#1D9E75";
                    ctx.fillStyle = batColor + "77";
                    ctx.font = "6px monospace";
                    ctx.textBaseline = "top";
                    ctx.fillText(`🔋${drone.battery.toFixed(2)}V`, pos.x, pos.y + 18);
                }
            }
        });
    }, [droneState, dronePathRef, droneIds, layoutData, getTransform]);

    // ─── Main canvas render ────────────────────────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;

        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);

        const W = rect.width;
        const H = rect.height;

        drawMap(ctx, W, H);
        drawDronePaths(ctx, W, H);

    }, [drawMap, drawDronePaths, clearPathTrigger, zoomLevel]);

    // ─── Handle resize ──────────────────────────────────────────────────────────
    useEffect(() => {
        const handleResize = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            canvas.width  = rect.width  * dpr;
            canvas.height = rect.height * dpr;
            const ctx = canvas.getContext("2d");
            ctx.scale(dpr, dpr);
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // ─── Mouse wheel zoom — most natural way to zoom a map ────────────────────
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const onWheel = (e) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
            setZoomLevel(prev => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +(prev + delta).toFixed(2))));
        };
        canvas.addEventListener("wheel", onWheel, { passive: false });
        return () => canvas.removeEventListener("wheel", onWheel);
    }, []);

    return (
        <div>
            <SectionHeader
                title="Drone Flight Monitor"
                subtitle={`${droneIds.length} drone${droneIds.length !== 1 ? "s" : ""} · Crazyflie Lighthouse`}
                right={
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <button
                            onClick={zoomIn}
                            style={{
                                fontSize: 14,
                                background: "none",
                                border: "0.5px solid var(--color-border-secondary)",
                                borderRadius: 4,
                                padding: "2px 10px",
                                cursor: "pointer",
                                color: "var(--color-text-secondary)",
                                fontFamily: "inherit",
                                fontWeight: 500,
                                minWidth: 28
                            }}
                            title="Zoom in"
                        >
                            +
                        </button>
                        <button
                            onClick={zoomOut}
                            style={{
                                fontSize: 14,
                                background: "none",
                                border: "0.5px solid var(--color-border-secondary)",
                                borderRadius: 4,
                                padding: "2px 10px",
                                cursor: "pointer",
                                color: "var(--color-text-secondary)",
                                fontFamily: "inherit",
                                fontWeight: 500,
                                minWidth: 28
                            }}
                            title="Zoom out"
                        >
                            −
                        </button>
                        <button
                            onClick={resetZoom}
                            style={{
                                fontSize: 10,
                                background: "none",
                                border: "0.5px solid var(--color-border-secondary)",
                                borderRadius: 4,
                                padding: "2px 8px",
                                cursor: "pointer",
                                color: "var(--color-text-secondary)",
                                fontFamily: "inherit"
                            }}
                            title="Reset zoom"
                        >
                            ↺
                        </button>
                        <span style={{
                            fontSize: 10,
                            color: "var(--color-text-tertiary)",
                            minWidth: 36,
                            textAlign: "center"
                        }}>
                            {(zoomLevel * 100).toFixed(0)}%
                        </span>
                        <button
                            onClick={clearAllPaths}
                            style={{
                                fontSize: 11,
                                background: "none",
                                border: "0.5px solid var(--color-border-secondary)",
                                borderRadius: 6,
                                padding: "4px 12px",
                                cursor: "pointer",
                                color: "var(--color-text-secondary)",
                                fontFamily: "inherit",
                                transition: "all 0.2s"
                            }}
                            onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                            onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                        >
                            Clear path
                        </button>
                    </div>
                }
            />

            {droneIds.length === 0 ? (
                <div style={{
                    background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)",
                    borderRadius: 12, padding: "40px 20px", textAlign: "center"
                }}>
                    <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.3 }}>⬡</div>
                    <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>No drones online</div>
                    <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 4 }}>
                        Start the Crazyflie mission script to see live telemetry
                    </div>
                </div>
            ) : (
                <>
                    {/* Telemetry cards */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 10, marginBottom: 16 }}>
                        {droneIds.map(id => <DroneCard key={id} id={id} drone={droneState[id]} />)}
                    </div>

                    {/* Path trace canvas with layout overlay */}
                    <div style={{
                        background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)",
                        borderRadius: 12, padding: "14px 16px", marginBottom: 16
                    }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                            <div style={{ fontSize: 11, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.04em",
                                color: "var(--color-text-tertiary)" }}>
                                Flight path — scroll to zoom
                            </div>
                            <div style={{ display: "flex", gap: 10, fontSize: 10, color: "var(--color-text-tertiary)", alignItems: "center" }}>
                                <span><span style={{ display:"inline-block", width:8, height:8, background:"#0F6E56",
                                    clipPath:"polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)", marginRight:4 }} />Drone</span>
                                <span><span style={{ display:"inline-block", width:8, height:8, background:"rgba(100,150,200,0.18)",
                                    borderRadius:2, border:"0.5px solid rgba(100,150,200,0.35)", marginRight:4 }} />Building</span>
                                <span><span style={{ display:"inline-block", width:8, height:8, background:"rgba(255,215,0,0.35)",
                                    borderRadius:"50%", marginRight:4 }} />Router</span>
                                <span><span style={{ display:"inline-block", width:8, height:8, background:"rgba(255,255,255,0.3)",
                                    borderRadius:"50%", marginRight:4 }} />Sensor</span>
                            </div>
                        </div>
                        <canvas ref={canvasRef}
                            style={{ width:"100%", height:"560px", background:"#0c0c0e", borderRadius:8, display:"block", cursor:"crosshair" }} />
                        <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"var(--color-text-tertiary)", marginTop:6 }}>
                            <span>Trail fades oldest → newest · Hexagon = current position · z altitude below marker</span>
                            <span>Scroll to zoom · auto-clears on takeoff</span>
                        </div>
                    </div>

                    {/* Drone events — uses unified events stream with ISO timestamps */}
                    <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
                        borderRadius:12, overflow:"hidden" }}>
                        <div style={{ padding:"10px 14px", borderBottom:"0.5px solid var(--color-border-tertiary)",
                            display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                            <span style={{ fontSize:11, fontWeight:500, textTransform:"uppercase",
                                letterSpacing:"0.04em", color:"var(--color-text-tertiary)" }}>Drone events</span>
                            <span style={{ fontSize:11, color:"var(--color-text-tertiary)" }}>
                                {droneEvents.length} event{droneEvents.length!==1?"s":""}
                                {droneEvents.filter(e=>e.severity==="critical").length > 0 &&
                                    ` · ${droneEvents.filter(e=>e.severity==="critical").length} critical`}
                            </span>
                        </div>
                        {droneEvents.length === 0 ? (
                            <div style={{ padding:"20px 14px", fontSize:12, color:"var(--color-text-tertiary)", textAlign:"center" }}>
                                No events — normal operation
                            </div>
                        ) : (
                            [...droneEvents]
                                .sort((a,b) => parseEventTime(b.timestamp) - parseEventTime(a.timestamp))
                                .map((e, i) => (
                                <div key={i} style={{ display:"flex", gap:10, padding:"8px 14px",
                                    alignItems:"flex-start", borderBottom:"0.5px solid var(--color-border-tertiary)",
                                    background: e.severity==="critical" ? "rgba(226,75,74,0.03)" : "transparent" }}>
                                    <div style={{ width:8, height:8, borderRadius:"50%", marginTop:5, flexShrink:0,
                                        background: SEVERITY_COLOR[e.severity] || "#888",
                                        boxShadow: e.severity==="critical" ? `0 0 4px ${SEVERITY_COLOR.critical}` : "none" }} />
                                    <div style={{ flex:1 }}>
                                        <div style={{ fontSize:12 }}>{e.message}</div>
                                        <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2, display:"flex", gap:6 }}>
                                            <span style={{ color:"#0F6E56", fontWeight:500 }}>{e.node_id}</span>
                                            <span>{formatEventTime(e.timestamp)}</span>
                                        </div>
                                    </div>
                                    <Badge text={e.severity} severity={e.severity} />
                                </div>
                            ))
                        )}
                    </div>
                </>
            )}
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
  const [droneState, setDroneState] = useState({});
  const dronePathRef   = useRef({});
  const prevDroneZRef  = useRef({});   // track z for takeoff detection
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

    const onDroneTelem = (data) => {
      const id = data.id;
      if (!id) return;

      setDroneState(prev => ({ ...prev, [id]: { ...data, lastSeen: new Date().toISOString() } }));

      // Path — auto-clear on takeoff (z crosses 0.1 → 0.3)
      if (!dronePathRef.current[id]) dronePathRef.current[id] = [];
      const prevZ = prevDroneZRef.current[id];
      if (prevZ !== undefined && prevZ < 0.1 && (data.z || 0) > 0.3) {
        dronePathRef.current[id] = [];
      }
      prevDroneZRef.current[id] = data.z || 0;
      if (data.x != null) {
        dronePathRef.current[id].push({ x: data.x, y: data.y, z: data.z, t: Date.now() });
        if (dronePathRef.current[id].length > 500) dronePathRef.current[id].shift();
      }

      const ts = new Date().toISOString();

      // Attack/halt — into unified events as drone_attack
      if (data.halt) {
        setEvents(prev => {
          if (prev.some(e => e.node_id === id && e.type === "drone_attack" &&
            eventAgeMs(e.timestamp) < 5000)) return prev;
          return [...prev.slice(-199), {
            type: "drone_attack", node_id: id, severity: "critical",
            message: `${id} attack signal received — mission halted`, timestamp: ts
          }];
        });
      }

      // Battery three-tier — into unified events as drone_battery
      const bat = data.battery;
      if (bat != null) {
        let sev = null, msg = null;
        if      (bat < 3.2) { sev = "critical"; msg = `${id} battery critical: ${bat.toFixed(2)}V — landing imminent`; }
        else if (bat < 3.5) { sev = "warning";  msg = `${id} battery low: ${bat.toFixed(2)}V`; }
        else if (bat < 3.7) { sev = "info";     msg = `${id} battery at ${bat.toFixed(2)}V — monitor`; }
        if (sev) {
          setEvents(prev => {
            if (prev.some(e => e.node_id === id && e.type === "drone_battery" &&
              e.severity === sev && eventAgeMs(e.timestamp) < 15000)) return prev;
            return [...prev.slice(-199), {
              type: "drone_battery", node_id: id, severity: sev, message: msg, timestamp: ts
            }];
          });
        }
      }
    };
    const onDroneState = (ds) => setDroneState(ds);
    const onFull   = ({ nodes: n, nodeDefinitions: d, droneState: ds }) => {
      setNodes(n); setNodeDefs(d);
      if (ds) setDroneState(ds);
    };

    socket.on("state:full",      onFull);
    socket.on("node:update",     onUpdate);
    socket.on("event:new",       onEvent);
    socket.on("events:recent",   onRecent);
    socket.on("config:current",  onConfig);
    socket.on("rfhealth:full",   onRfFull);
    socket.on("drone:telemetry", onDroneTelem);
    socket.on("drone:state",     onDroneState);

    return () => {
      socket.off("state:full",      onFull);
      socket.off("node:update",     onUpdate);
      socket.off("event:new",       onEvent);
      socket.off("events:recent",   onRecent);
      socket.off("config:current",  onConfig);
      socket.off("rfhealth:full",   onRfFull);
      socket.off("drone:telemetry", onDroneTelem);
      socket.off("drone:state",     onDroneState);
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
    eventAgeMs(e.timestamp) < 20000 &&
    nodes[e.node_id]?.status === "online"
  );
  const nodeIds = Object.keys(nodeDefs);

  const droneIds = Object.keys(droneState);

  // Active alerts — critical + warning from last 2 min, deduplicated
  const activeAlerts = [...events]
    .filter(e => (e.severity==="critical" || e.severity==="warning") && eventAgeMs(e.timestamp) < 120000)
    .reduce((acc, e) => {
      const key = `${e.type}:${e.node_id}:${e.message}`;
      if (!acc.find(x => `${x.type}:${x.node_id}:${x.message}` === key)) acc.push(e);
      return acc;
    }, [])
    .sort((a,b) => parseEventTime(b.timestamp) - parseEventTime(a.timestamp))
    .slice(0, 5);

  const tabs = [
    { id:"overview",  label:"Overview" },
    { id:"sensors",   label:"Sensors" },
    { id:"gps",       label:"GPS" },
    { id:"drone",     label:`Drone${droneIds.length > 0 ? ` (${droneIds.length})` : ""}` },
    { id:"rf",        label:`RF Analysis${disruptedCount > 0 ? ` (${disruptedCount})` : ""}` },
    { id:"events",    label:`Events${events.length > 0 ? ` (${events.length})` : ""}` },
    { id:"mapper",    label:"RF Interference Mapper" },
    { id:"explorer",  label:"Data Explorer" },
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
        <div style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
          {/* Main content */}
          <div style={{ flex:1, minWidth:0 }}>
            <SectionHeader title="Node Grid"
              subtitle={`${nodeIds.length} sensors${droneIds.length > 0 ? ` · ${droneIds.length} drone${droneIds.length!==1?"s":""}` : ""}`} />
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))", gap:10 }}>
              {nodeIds.map(id => (
                <NodeCard key={id} id={id} def={nodeDefs[id]||{}} state={nodes[id]}
                  histories={historyRef.current[id]||{}} rfHealth={rfHealthMap[id]} />
              ))}
              {droneIds.map(id => (
                <DroneCard key={id} id={id} drone={droneState[id]} />
              ))}
            </div>
          </div>
          {/* Live event rail */}
          <LiveEventRail events={events} />
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
          selectedNode={selectedRfNode} setSelectedNode={setSelectedRfNode} />
      )}

      {/* Tab: Events */}
      {activeTab === "events" && (
        <div>
          <SectionHeader title="Event Log" subtitle={`${events.length} total · ${events.filter(e=>e.severity==="critical").length} critical`} right={
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

      {/* Tab: RF Interference Mapper */}
      {activeTab === "mapper" && (
        <div>
          <SectionHeader title="RF Interference Mapper"/>
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, overflow:"hidden" }}>
            <iframe
              src="/tactical-mapper.html"
              style={{ width:"100%", height:"820px", border:"none", display:"block" }}
              title="RF Interference Mapper"
            />
          </div>
        </div>
      )}

      {/* Tab: Data Explorer */}
      {activeTab === "explorer" && (
        <div>
          <SectionHeader title="Data Explorer"
            subtitle="Query the monitoring API — click any endpoint to open it" />

          {/* Node endpoints */}
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, padding:"14px 16px", marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:500, color:"var(--color-text-tertiary)",
              textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>
              Node data
            </div>
            {[
              { label:"All nodes — current state",        path:"/api/nodes" },
              { label:"Full system state",                path:"/api/state" },
              { label:"Current layout definition",        path:"/api/layout" },
            ].map(e => (
              <ApiRow key={e.path} label={e.label} path={e.path} />
            ))}

            {/* Per-node history endpoints */}
            <div style={{ fontSize:11, color:"var(--color-text-tertiary)", margin:"10px 0 6px",
              paddingTop:8, borderTop:"0.5px solid var(--color-border-tertiary)" }}>
              Per-node history — click a node then a metric:
            </div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:8 }}>
              {nodeIds.map(id => (
                <div key={id} style={{ background:"var(--color-background-secondary)",
                  border:"0.5px solid var(--color-border-tertiary)", borderRadius:8, padding:"6px 10px" }}>
                  <div style={{ fontSize:11, fontWeight:500, color:"var(--color-text-primary)",
                    marginBottom:4 }}>{nodeDefs[id]?.label || id}</div>
                  {(nodeDefs[id]?.metrics || ["wifi_rssi"]).map(metric => (
                    <ApiRow key={metric} label={metric}
                      path={`/api/nodes/${id}/history?metric=${metric}&limit=200`}
                      compact />
                  ))}
                  <ApiRow label="RF health" path={`/api/nodes/${id}/rf-health`} compact />
                </div>
              ))}
            </div>
          </div>

          {/* Events */}
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, padding:"14px 16px", marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:500, color:"var(--color-text-tertiary)",
              textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>
              Events
            </div>
            {[
              { label:"All recent events (last 50)",       path:"/api/events" },
              { label:"Critical events only",              path:"/api/events?severity=critical" },
              { label:"Warning events only",               path:"/api/events?severity=warning" },
              { label:"Jamming events only",               path:"/api/events?type=jamming" },
            ].map(e => (
              <ApiRow key={e.path} label={e.label} path={e.path} />
            ))}
          </div>

          {/* Config */}
          <div style={{ background:"var(--color-background-primary)", border:"0.5px solid var(--color-border-tertiary)",
            borderRadius:12, padding:"14px 16px" }}>
            <div style={{ fontSize:11, fontWeight:500, color:"var(--color-text-tertiary)",
              textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>
              System
            </div>
            {[
              { label:"Current monitoring config",         path:"/api/config" },
            ].map(e => (
              <ApiRow key={e.path} label={e.label} path={e.path} />
            ))}
          </div>
        </div>
      )}

      {/* Tab: Drone */}
      {activeTab === "drone" && (
        <div style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
          <div style={{ flex:1, minWidth:0 }}>
            <DroneTab
              droneState={droneState}
              dronePathRef={dronePathRef}
              events={events}
            />
          </div>
          <LiveEventRail events={events.filter(e => e.type==="drone_battery" || e.type==="drone_attack")} />
        </div>
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
