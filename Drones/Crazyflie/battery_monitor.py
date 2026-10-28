"""
Battery monitoring for Crazyflie drones.

Reads the Crazyflie's power-management (PM) telemetry and turns it into a
flight decision: keep flying, return to base, or land now. It can also record
a discharge run and use it to estimate remaining flight time from voltage.

Typical use inside a mission:

    monitor = BatteryMonitor(cf)
    monitor.start()
    if not monitor.wait_for_data():
        raise RuntimeError("no battery telemetry")

    decision = monitor.flight_decision()
    if decision is FlightDecision.LAND:
        ...
    elif decision is FlightDecision.RETURN_TO_BASE:
        ...

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""

from __future__ import annotations

import csv
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from enum import IntEnum
from typing import Dict, List, Optional, Tuple

try:  # cflib is only needed when talking to a real drone
    from cflib.crazyflie.log import LogConfig
except ImportError:  # pragma: no cover - lets the pure logic run in tests
    LogConfig = None


class FlightDecision(IntEnum):
    """What the battery says the drone should do next.

    Values are ordered by urgency, so `decision > FlightDecision.CONTINUE`
    means "something other than carry on".
    """
    CONTINUE = 0
    LAND = 1
    RETURN_TO_BASE = 2


class Health:
    NORMAL = "NORMAL"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"
    LOW_POWER = "LOW_POWER"
    SHUTDOWN = "SHUTDOWN"
    NO_DATA = "NO_DATA"


# pm.state values reported by the Crazyflie firmware.
PM_STATES = {0: "BATTERY", 1: "CHARGING", 2: "CHARGED", 3: "LOW_POWER", 4: "SHUTDOWN"}

# Log variables -> internal field names. 20 bytes total, inside the
# 26-byte limit for one Crazyflie log block.
PM_LOG_VARIABLES = [
    ("pm.vbat", "float", "vbat"),
    ("pm.vbatMV", "uint16_t", "vbat_mv"),
    ("pm.state", "int8_t", "state"),
    ("pm.batteryLevel", "uint8_t", "battery_level"),
    ("pm.chargeCurrent", "float", "charge_current"),
    ("pm.extVbat", "float", "ext_vbat"),
    ("pm.extCurr", "float", "ext_curr"),
]


@dataclass
class BatteryStatus:
    voltage: float
    percentage: int
    state: str
    charging: bool
    health: str
    suggested_action: Optional[str]


class BatteryMonitor:
    """Battery telemetry, health checks, and flight decisions for one drone.

    Args:
        cf: A connected `cflib` Crazyflie object.
        period_ms: How often the drone sends battery telemetry.
        low_voltage / critical_voltage: Thresholds in volts. If omitted they
            are read from the drone's `pm.lowVoltage` and
            `pm.criticalLowVoltage` parameters.
        max_discharge_current: External current (A) above which the load is
            flagged as too high. Only meaningful with an external battery
            board (e.g. BigQuad) that reports `pm.extCurr`.
    """

    def __init__(self, cf, period_ms: int = 500,
                 low_voltage: Optional[float] = None,
                 critical_voltage: Optional[float] = None,
                 max_discharge_current: float = 2.0):
        self.cf = cf
        self.period_ms = period_ms
        self.max_discharge_current = max_discharge_current

        if low_voltage is None:
            low_voltage = float(cf.param.get_value("pm.lowVoltage"))
        if critical_voltage is None:
            critical_voltage = float(cf.param.get_value("pm.criticalLowVoltage"))
        self.low_voltage = low_voltage
        self.critical_voltage = critical_voltage

        self.data: Dict[str, float] = {name: 0 for _, _, name in PM_LOG_VARIABLES}
        self.last_update: Optional[float] = None
        self.landing_initiated = False

        self._log_conf = None
        self._has_data = threading.Event()
        self._lookup: Dict[float, float] = {}
        self._recording = None

    # ------------------------------------------------------------------
    # Telemetry
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start streaming battery telemetry from the drone."""
        if LogConfig is None:
            raise RuntimeError("cflib is required to stream telemetry")
        conf = LogConfig(name="Battery", period_in_ms=self.period_ms)
        for var, var_type, _ in PM_LOG_VARIABLES:
            conf.add_variable(var, var_type)
        conf.data_received_cb.add_callback(self._on_log_data)
        self.cf.log.add_config(conf)
        conf.start()
        self._log_conf = conf

    def stop(self) -> None:
        """Stop streaming battery telemetry."""
        if self._log_conf is not None:
            self._log_conf.stop()
            self._log_conf = None

    def wait_for_data(self, timeout: float = 3.0) -> bool:
        """Block until the first telemetry sample arrives. Returns False on timeout.

        Call this before the first flight decision; until a sample arrives the
        voltage reads as 0 V, which would look like a dead battery.
        """
        return self._has_data.wait(timeout)

    def _on_log_data(self, timestamp, data, logconf) -> None:
        self.update({name: data[var] for var, _, name in PM_LOG_VARIABLES if var in data})

    def update(self, values: Dict[str, float]) -> None:
        """Feed a telemetry sample in directly (used by the log callback and tests)."""
        self.data.update(values)
        self.last_update = time.time()
        self._has_data.set()

    # ------------------------------------------------------------------
    # Health and decisions
    # ------------------------------------------------------------------

    @property
    def voltage(self) -> float:
        return float(self.data["vbat"])

    def status(self) -> BatteryStatus:
        """Current battery health and the action it suggests."""
        state = int(self.data["state"])
        charging = state in (1, 2)
        health, action = self._health_and_action(state, charging)
        return BatteryStatus(
            voltage=self.voltage,
            percentage=int(self.data["battery_level"]),
            state=PM_STATES.get(state, "UNKNOWN"),
            charging=charging,
            health=health,
            suggested_action=action,
        )

    def _health_and_action(self, state: int, charging: bool) -> Tuple[str, Optional[str]]:
        if not self._has_data.is_set():
            return Health.NO_DATA, "DO_NOT_FLY"
        if state == 4:
            return Health.SHUTDOWN, "LAND_IMMEDIATELY"
        if self.voltage <= self.critical_voltage:
            return Health.CRITICAL, "LAND_IMMEDIATELY"
        if state == 3:
            return Health.LOW_POWER, "RETURN_TO_BASE"
        if self.voltage <= self.low_voltage:
            return Health.WARNING, "RETURN_TO_BASE"
        if not charging and self.data["ext_curr"] > self.max_discharge_current:
            return Health.WARNING, "REDUCE_LOAD"
        return Health.NORMAL, None

    def flight_decision(self) -> FlightDecision:
        """Continue, return to base, or land now.

        No telemetry yet is treated as LAND, so a pre-flight check with
        `decision > FlightDecision.CONTINUE` refuses to take off.
        """
        action = self.status().suggested_action
        if action in ("LAND_IMMEDIATELY", "DO_NOT_FLY"):
            return FlightDecision.LAND
        if action == "RETURN_TO_BASE":
            return FlightDecision.RETURN_TO_BASE
        return FlightDecision.CONTINUE

    # ------------------------------------------------------------------
    # Remaining flight time
    # ------------------------------------------------------------------

    def record_discharge(self, filename: str = "discharge_log.csv",
                         duration_s: float = 360, interval_ms: int = 1000,
                         on_done=None) -> None:
        """Record voltage over time to build a remaining-time lookup table.

        Run this during a hover or a representative mission that lasts until
        the battery reaches the low-voltage cutoff; remaining time is measured
        back from the end of the recording. Recording runs in the background;
        when it finishes the CSV is written and the lookup table is loaded.
        """
        if LogConfig is None:
            raise RuntimeError("cflib is required to record telemetry")
        conf = LogConfig(name="VoltageRecorder", period_in_ms=interval_ms)
        conf.add_variable("pm.vbat", "float")
        start = time.time()
        self._recording = {"conf": conf, "start": start, "end": start + duration_s,
                           "filename": filename, "rows": [], "on_done": on_done}
        conf.data_received_cb.add_callback(self._on_recording_data)
        self.cf.log.add_config(conf)
        conf.start()

    def _on_recording_data(self, timestamp, data, logconf) -> None:
        rec = self._recording
        if rec is None:
            return
        now = time.time()
        rec["rows"].append((round(now - rec["start"], 3), float(data.get("pm.vbat", 0.0))))
        if now >= rec["end"]:
            self._recording = None
            try:
                rec["conf"].stop()
            except Exception:
                pass
            save_discharge_csv(rec["filename"], rec["rows"])
            self.load_lookup_from_discharge(rec["filename"])
            if rec["on_done"]:
                rec["on_done"](rec["filename"])

    def load_lookup_from_discharge(self, filename: str,
                                   save_table_to: Optional[str] = "voltage_lookup_table.csv") -> Dict[float, float]:
        """Build the voltage -> remaining-seconds table from a discharge CSV."""
        self._lookup = build_lookup_table(read_discharge_csv(filename))
        if save_table_to:
            save_lookup_csv(save_table_to, self._lookup)
        return self._lookup

    def load_lookup_table(self, filename: str) -> Dict[float, float]:
        """Load a lookup table saved earlier by `load_lookup_from_discharge`."""
        with open(filename, newline="") as f:
            self._lookup = {float(r["voltage_v"]): float(r["remaining_s"]) for r in csv.DictReader(f)}
        return self._lookup

    def estimate_remaining_time(self, voltage: Optional[float] = None) -> Optional[float]:
        """Estimated seconds of flight left at `voltage` (defaults to the current reading).

        Uses the nearest voltage in the lookup table. Returns None if no table
        has been loaded.
        """
        if not self._lookup:
            return None
        v = self.voltage if voltage is None else voltage
        nearest = min(self._lookup, key=lambda k: abs(k - v))
        return self._lookup[nearest]

    # ------------------------------------------------------------------
    # Landing
    # ------------------------------------------------------------------

    def land(self, emergency: bool = False, duration_s: float = 3.0) -> None:
        """Land the drone using the high-level commander.

        A normal landing descends over `duration_s`. An emergency landing
        descends over one second. Neither cuts the motors mid-air.
        """
        if self.landing_initiated:
            return
        self.landing_initiated = True
        hlc = self.cf.high_level_commander
        d = 1.0 if emergency else duration_s
        hlc.land(0.0, d)
        time.sleep(d + 0.5)
        hlc.stop()

    def auto_land_if_needed(self, reserve_s: float = 30.0) -> bool:
        """Standalone safety check: land if the battery calls for it.

        Lands immediately on a critical battery. On a low battery it lands
        when the estimated remaining time drops under `reserve_s` (or right
        away if no lookup table is loaded). Returns True if a landing started.
        """
        if self.landing_initiated:
            return False
        decision = self.flight_decision()
        if decision is FlightDecision.LAND:
            self.land(emergency=True)
            return True
        if decision is FlightDecision.RETURN_TO_BASE:
            remaining = self.estimate_remaining_time()
            if remaining is None or remaining < reserve_s:
                self.land()
                return True
        return False


# ----------------------------------------------------------------------
# Lookup table helpers (pure functions, no drone needed)
# ----------------------------------------------------------------------

def build_lookup_table(rows: List[Tuple[float, float]], resolution_v: float = 0.01) -> Dict[float, float]:
    """Map voltage bins to average seconds remaining until the end of the run.

    `rows` are (elapsed_seconds, voltage) pairs from a full discharge run.
    """
    if not rows:
        return {}
    end = max(t for t, _ in rows)
    digits = max(0, len(str(resolution_v).split(".")[-1]))
    bins: Dict[float, List[float]] = defaultdict(list)
    for t, v in rows:
        bins[round(round(v / resolution_v) * resolution_v, digits)].append(end - t)
    return {v: sum(ts) / len(ts) for v, ts in sorted(bins.items(), reverse=True)}


def save_discharge_csv(filename: str, rows: List[Tuple[float, float]]) -> None:
    with open(filename, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["elapsed_s", "voltage_v"])
        w.writerows(rows)


def read_discharge_csv(filename: str) -> List[Tuple[float, float]]:
    with open(filename, newline="") as f:
        reader = csv.DictReader(f)
        # Also accept the column names used by older recordings.
        t_col = "elapsed_s" if "elapsed_s" in reader.fieldnames else "Elapsed Time (s)"
        v_col = "voltage_v" if "voltage_v" in reader.fieldnames else "Voltage (V)"
        return [(float(r[t_col]), float(r[v_col])) for r in reader]


def save_lookup_csv(filename: str, lookup: Dict[float, float]) -> None:
    with open(filename, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["voltage_v", "remaining_s"])
        for v, s in lookup.items():
            w.writerow([f"{v:.2f}", f"{s:.1f}"])
