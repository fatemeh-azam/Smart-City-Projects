"""Tests that run without a drone or radio: python -m pytest"""

import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from battery_monitor import (BatteryMonitor, FlightDecision, build_lookup_table,  # noqa: E402
                             read_discharge_csv, save_discharge_csv)
from flight_monitor import (ALARM, CRITICAL, NORMAL, WARNING, FlightMonitor,  # noqa: E402
                            GapCheck, RouteCheck, TelemetryReader, Thresholds)
from missions import generate_grid_path, is_delivery_point, MISSIONS  # noqa: E402


# --- missions ------------------------------------------------------------

def test_grid_path_detours_to_off_street_delivery_and_back():
    path = generate_grid_path((0.0, 0.0), [(0.0, 1.0), (0.5, 2.0)], height=1.0)
    assert path == [(0.0, 1.0, 1.0, 0), (0.0, 2.0, 1.0, 0), (0.5, 2.0, 1.0, 0), (0.0, 2.0, 1.0, 0)]


def test_delivery_points_are_recognised_on_the_generated_path():
    uri, (start, deliveries) = next(iter(MISSIONS.items()))
    hits = [p for p in generate_grid_path(start, deliveries) if is_delivery_point(uri, p[0], p[1])]
    assert [h[:2] for h in hits] == deliveries


# --- battery monitor -----------------------------------------------------

class FakeParams:
    def get_value(self, name):
        return {"pm.lowVoltage": "3.2", "pm.criticalLowVoltage": "3.0"}[name]


class FakeHLC:
    def __init__(self):
        self.calls = []

    def land(self, h, d):
        self.calls.append(("land", h, d))

    def stop(self):
        self.calls.append(("stop",))


class FakeCf:
    def __init__(self):
        self.param = FakeParams()
        self.high_level_commander = FakeHLC()


@pytest.fixture
def monitor():
    return BatteryMonitor(FakeCf())


def test_thresholds_come_from_drone_parameters(monitor):
    assert (monitor.low_voltage, monitor.critical_voltage) == (3.2, 3.0)


def test_no_telemetry_means_do_not_fly(monitor):
    assert monitor.flight_decision() is FlightDecision.LAND
    assert monitor.status().health == "NO_DATA"


@pytest.mark.parametrize("vbat,state,expected", [
    (3.9, 0, FlightDecision.CONTINUE),
    (3.15, 0, FlightDecision.RETURN_TO_BASE),
    (2.95, 0, FlightDecision.LAND),
    (3.9, 3, FlightDecision.RETURN_TO_BASE),   # firmware says low power
    (3.9, 4, FlightDecision.LAND),             # firmware says shutting down
])
def test_flight_decision(monitor, vbat, state, expected):
    monitor.update({"vbat": vbat, "state": state})
    assert monitor.flight_decision() is expected


def test_high_external_current_does_not_mask_critical_voltage(monitor):
    monitor.update({"vbat": 2.9, "ext_curr": 5.0})
    assert monitor.status().suggested_action == "LAND_IMMEDIATELY"


def test_lookup_table_and_estimate(monitor, tmp_path):
    rows = [(t, round(4.1 - 0.002 * t, 3)) for t in range(0, 300, 5)]
    csv_path = tmp_path / "discharge.csv"
    save_discharge_csv(str(csv_path), rows)
    table = monitor.load_lookup_from_discharge(str(csv_path), save_table_to=None)
    assert table and max(table.values()) <= 295
    est = monitor.estimate_remaining_time(3.6)
    assert est == pytest.approx(45, abs=5)  # 3.6 V is reached ~250 s into a 295 s run


def test_reads_old_discharge_column_names(tmp_path):
    f = tmp_path / "old.csv"
    f.write_text("Elapsed Time (s),Voltage (V)\n0,4.1\n10,4.0\n")
    assert read_discharge_csv(str(f)) == [(0.0, 4.1), (10.0, 4.0)]
    assert build_lookup_table([(0.0, 4.1), (10.0, 4.0)]) == {4.1: 10.0, 4.0: 0.0}


def test_auto_land_on_critical_uses_high_level_commander(monitor, monkeypatch):
    monkeypatch.setattr("time.sleep", lambda s: None)
    monitor.update({"vbat": 2.9})
    assert monitor.auto_land_if_needed() is True
    assert monitor.cf.high_level_commander.calls[0][0] == "land"
    assert monitor.auto_land_if_needed() is False  # only once


# --- route rule ----------------------------------------------------------

PATH = [(0.0, 1.0, 1, 0), (0.0, 3.0, 1, 0), (0.0, 4.0, 1, 0), (0.0, 5.0, 1, 0)]


def fly(check, points, dt=0.6):
    return [check.update(x, y, i * dt)[0] for i, (x, y) in enumerate(points)]


def test_on_route_flight_raises_no_alarm_with_segment_metric():
    check = RouteCheck((0.0, 0.0), PATH, Thresholds(), metric="segment")
    ys = [i * 0.15 for i in range(0, 35)]
    assert not any(fly(check, [(0.0, y) for y in ys]))
    assert check.finished


def test_sideways_drift_is_off_route():
    check = RouteCheck((0.0, 0.0), PATH, Thresholds())
    flags = fly(check, [(0.0, 0.2), (0.0, 0.5), (0.6, 0.7), (1.2, 0.8)])
    assert flags[-1] is True


def test_jump_faster_than_max_speed_is_off_route():
    check = RouteCheck((0.0, 0.0), PATH, Thresholds())
    assert fly(check, [(0.0, 0.5), (0.0, 0.99)], dt=0.1)[-1] is True  # 4.9 m/s


def test_segment_metric_avoids_false_alarm_on_long_leg():
    # Midway along the 2 m leg the drone is 1 m from the next waypoint
    # (over the 0.8 m tolerance) but right on the route.
    target = RouteCheck((0.0, 0.0), PATH, Thresholds(), metric="target")
    segment = RouteCheck((0.0, 0.0), PATH, Thresholds(), metric="segment")
    pts = [(0.0, 0.5), (0.0, 1.0), (0.0, 1.5), (0.0, 2.0)]
    assert fly(target, pts)[-1] is True
    assert fly(segment, pts)[-1] is False


# --- telemetry gap rule --------------------------------------------------

def test_gap_escalates_and_records_outage():
    gap = GapCheck(Thresholds())
    gap.update(100.0, 100.0)
    levels = [gap.update(t, None)[1] for t in (101, 103, 105, 109)]
    assert levels == [NORMAL, WARNING, ALARM, CRITICAL]
    gap.update(112.0, 111.9)
    assert gap.level == NORMAL
    (outage,) = gap.outages
    assert outage.critical_after_s == pytest.approx(9.0)
    assert outage.duration_s == pytest.approx(12.0)


# --- log reading and end-to-end -----------------------------------------

def test_reader_skips_headers_events_and_partial_lines(tmp_path):
    f = tmp_path / "log.jsonl"
    f.write_text('#HEADER: {}\n{"timestamp": 1, "x": 0, "y": 0, "z": 1}\n{"timestamp": 2, "x"')
    r = TelemetryReader(str(f))
    assert len(r.read_new()) == 1
    with open(f, "a") as fh:
        fh.write(': 0, "y": 0.1, "z": 1}\n{"event": "logging_stopped"}\n')
    assert [rec["timestamp"] for rec in r.read_new()] == [2]


def test_monitor_end_to_end(tmp_path):
    mon = FlightMonitor(log_dir=str(tmp_path))
    uri = next(iter(MISSIONS))
    log = tmp_path / os.path.basename(mon.drones[uri].reader.filename)
    start = MISSIONS[uri][0]
    with open(log, "w") as f:
        f.write("#HEADER: {}\n")
        for i in range(3):
            f.write(json.dumps({"timestamp": 1000 + i * 0.6, "x": start[0],
                                "y": start[1] + i * 0.05, "z": 1, "controller": "A"}) + "\n")
        f.write(json.dumps({"timestamp": 1002.0, "x": start[0] + 1.5,
                            "y": start[1] + 0.2, "z": 1, "controller": "A"}) + "\n")
    mon.update(now=1002.1)
    kinds = [(e.kind, e.level) for e in mon.events]
    assert ("route", ALARM) in kinds
    mon.update(now=1011.0)  # 9 s of silence
    assert mon.drones[uri].gap.level == CRITICAL


def test_mission_dry_run_needs_no_radio():
    out = subprocess.run([sys.executable, "swarm_mission.py", "--dry-run"], cwd=ROOT,
                         capture_output=True, text=True, check=True).stdout
    assert "Drone 1" in out and "delivery" in out

