"""
Rule-based flight monitor for the delivery testbed.

Watches the telemetry logs written by swarm_mission.py and raises two kinds
of alert:

  Off route      A drone is too far from the waypoint it should be heading
                 to, or moves faster than the mission ever flies.
  Telemetry gap  A drone has stopped sending position data. Alerts escalate
                 from warning to alarm to critical as the gap grows, and the
                 monitor records how long each outage lasted.

These are fixed-threshold rules, kept deliberately simple so they can serve
as a baseline for comparing learned detectors. A live map shows each drone's
planned route, its recent track and its status, next to a scrolling event log.

Usage:
    python flight_monitor.py                       # start before or during a mission
    python flight_monitor.py --clean               # delete old logs first
    python flight_monitor.py --path-metric segment # distance to route segment instead of to next waypoint
    python flight_monitor.py --outages-csv out.csv # save telemetry outage metrics on exit

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import os
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from missions import MISSIONS, drone_label, generate_grid_path, log_filename

NORMAL, WARNING, ALARM, CRITICAL = "NORMAL", "WARNING", "ALARM", "CRITICAL"


@dataclass
class Thresholds:
    # Telemetry gaps: seconds since the newest sample.
    gap_warning_s: float = 2.0
    gap_alarm_s: float = 4.0
    gap_critical_s: float = 8.0
    repeat_alarm_s: float = 10.0       # re-announce an ongoing alarm
    repeat_critical_s: float = 5.0     # re-announce an ongoing critical gap
    # Route checks: metres and metres per second.
    reached_m: float = 0.3             # close enough to count a waypoint as reached
    tolerance_start_m: float = 1.0     # first leg
    tolerance_end_m: float = 1.0       # last two legs
    tolerance_m: float = 0.8           # everything in between
    max_speed_mps: float = 2.0


@dataclass
class Event:
    time: float
    kind: str        # "route", "gap", "progress", "system"
    level: str       # NORMAL / WARNING / ALARM / CRITICAL / INFO
    message: str

    def line(self) -> str:
        return f"{datetime.fromtimestamp(self.time):%H:%M:%S}  {self.message}"


# ----------------------------------------------------------------------
# Reading telemetry logs
# ----------------------------------------------------------------------

class TelemetryReader:
    """Reads new position records from a growing JSONL log file.

    Remembers its offset, so each call only parses lines appended since the
    last one. Header lines, event markers and half-written lines are skipped.
    """

    def __init__(self, filename: str):
        self.filename = filename
        self.offset = 0
        self._partial = ""

    def read_new(self) -> List[dict]:
        if not os.path.exists(self.filename):
            return []
        if os.path.getsize(self.filename) < self.offset:  # file was recreated
            self.offset, self._partial = 0, ""
        with open(self.filename, "r") as f:
            f.seek(self.offset)
            chunk = f.read()
            self.offset = f.tell()
        lines = (self._partial + chunk).split("\n")
        self._partial = lines.pop()  # last piece may be incomplete
        records = []
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "event" not in rec and all(k in rec for k in ("x", "y", "z")):
                records.append(rec)
        return records


# ----------------------------------------------------------------------
# Rules
# ----------------------------------------------------------------------

def _dist(ax, ay, bx, by) -> float:
    return math.hypot(ax - bx, ay - by)


def _dist_to_segment(px, py, ax, ay, bx, by) -> float:
    vx, vy = bx - ax, by - ay
    seg2 = vx * vx + vy * vy
    if seg2 == 0:
        return _dist(px, py, ax, ay)
    t = max(0.0, min(1.0, ((px - ax) * vx + (py - ay) * vy) / seg2))
    return _dist(px, py, ax + t * vx, ay + t * vy)


class RouteCheck:
    """Off-route rule for one drone.

    Tracks which waypoint the drone should be heading to and advances when
    the drone gets within `reached_m` of it. The drone is off route when:
      - its distance exceeds the tolerance for the current leg (looser on
        the first leg and the last two), or
      - it moved faster than `max_speed_mps` between two samples.

    `metric="target"` measures distance to the next waypoint (the original
    rule). `metric="segment"` measures distance to the line between the
    previous and next waypoint, which avoids false alarms partway along
    long legs.
    """

    def __init__(self, start, path, th: Thresholds, metric: str = "target"):
        self.start = start
        self.path = path
        self.th = th
        self.metric = metric
        self.index = 0
        self.last: Optional[Tuple[float, float, float]] = None  # x, y, t
        self.off_route = False
        self.distance = 0.0
        self.speed = 0.0

    @property
    def finished(self) -> bool:
        return self.index >= len(self.path)

    def _tolerance(self) -> float:
        if self.index == 0:
            return self.th.tolerance_start_m
        if self.index >= len(self.path) - 2:
            return self.th.tolerance_end_m
        return self.th.tolerance_m

    def _distance(self, x, y) -> float:
        tx, ty = self.path[self.index][:2]
        if self.metric == "segment":
            ax, ay = (self.start if self.index == 0 else self.path[self.index - 1][:2])
            return _dist_to_segment(x, y, ax, ay, tx, ty)
        return _dist(x, y, tx, ty)

    def update(self, x: float, y: float, t: float) -> Tuple[bool, Optional[int]]:
        """Check a new sample. Returns (off_route, waypoint_just_reached)."""
        reached = None
        if self.finished:
            self.off_route = False
            return False, None

        tx, ty = self.path[self.index][:2]
        if _dist(x, y, tx, ty) < self.th.reached_m:
            reached = self.index
            self.index += 1
            if self.finished:
                self.off_route = False
                self.last = (x, y, t)
                return False, reached

        self.distance = self._distance(x, y)
        off = self.distance > self._tolerance()

        self.speed = 0.0
        if self.last is not None:
            lx, ly, lt = self.last
            if t > lt:
                self.speed = _dist(x, y, lx, ly) / (t - lt)
                if self.speed > self.th.max_speed_mps:
                    off = True
        self.last = (x, y, t)
        self.off_route = off
        return off, reached


@dataclass
class Outage:
    started: float
    critical_after_s: Optional[float] = None
    duration_s: Optional[float] = None


class GapCheck:
    """Telemetry-gap rule for one drone, with outage bookkeeping."""

    def __init__(self, th: Thresholds):
        self.th = th
        self.last_sample: Optional[float] = None
        self.level = NORMAL
        self.last_announced = 0.0
        self.outages: List[Outage] = []
        self._open: Optional[Outage] = None

    def age(self, now: float) -> Optional[float]:
        return None if self.last_sample is None else now - self.last_sample

    def update(self, now: float, newest_sample: Optional[float]) -> Tuple[str, str, bool]:
        """Returns (previous_level, new_level, should_announce)."""
        if newest_sample is not None:
            self.last_sample = max(self.last_sample or 0, newest_sample)
        age = self.age(now)
        prev = self.level
        if age is None or age <= self.th.gap_warning_s:
            level = NORMAL
        elif age <= self.th.gap_alarm_s:
            level = WARNING
        elif age <= self.th.gap_critical_s:
            level = ALARM
        else:
            level = CRITICAL
        self.level = level

        # Outage bookkeeping: an outage opens at the first warning and closes
        # when samples come back.
        if level != NORMAL and self._open is None:
            self._open = Outage(started=self.last_sample)
        if level == CRITICAL and self._open and self._open.critical_after_s is None:
            self._open.critical_after_s = age
        if level == NORMAL and self._open is not None:
            self._open.duration_s = now - self._open.started
            self.outages.append(self._open)
            self._open = None

        announce = level != prev
        if not announce and level in (ALARM, CRITICAL):
            every = self.th.repeat_critical_s if level == CRITICAL else self.th.repeat_alarm_s
            announce = now - self.last_announced >= every
        if announce:
            self.last_announced = now
        return prev, level, announce

    def close(self, now: float) -> None:
        if self._open is not None:
            self._open.duration_s = now - self._open.started
            self.outages.append(self._open)
            self._open = None


# ----------------------------------------------------------------------
# Monitor
# ----------------------------------------------------------------------

@dataclass
class DroneState:
    uri: str
    label: str
    start: Tuple[float, float]
    deliveries: list
    path: list
    reader: TelemetryReader
    route: Optional[RouteCheck]
    gap: GapCheck
    track: deque = field(default_factory=lambda: deque(maxlen=150))
    position: Optional[Tuple[float, float, float]] = None
    controller: Optional[str] = None


class FlightMonitor:
    """Applies the route and gap rules to every drone and collects events."""

    def __init__(self, missions=MISSIONS, thresholds: Thresholds = None,
                 path_metric: str = "target", route_checked: Optional[List[str]] = None,
                 log_dir: str = "."):
        self.th = thresholds or Thresholds()
        self.events: deque = deque(maxlen=500)
        self.drones: Dict[str, DroneState] = {}
        for uri, (start, deliveries) in missions.items():
            path = generate_grid_path(start, deliveries)
            check = route_checked is None or uri in route_checked
            self.drones[uri] = DroneState(
                uri=uri, label=drone_label(uri), start=start, deliveries=list(deliveries), path=path,
                reader=TelemetryReader(os.path.join(log_dir, log_filename(uri))),
                route=RouteCheck(start, path, self.th, path_metric) if check else None,
                gap=GapCheck(self.th),
            )
        self.log("system", "INFO", f"Monitoring {len(self.drones)} drones "
                                   f"(route rule: distance to {path_metric})")

    def log(self, kind: str, level: str, message: str, when: float = None) -> Event:
        ev = Event(when or time.time(), kind, level, message)
        self.events.appendleft(ev)
        print(ev.line())
        return ev

    def update(self, now: float = None) -> None:
        now = now or time.time()
        for d in self.drones.values():
            records = d.reader.read_new()
            newest = None
            for rec in records:
                t = float(rec.get("timestamp", now))
                newest = t if newest is None else max(newest, t)
                x, y, z = float(rec["x"]), float(rec["y"]), float(rec["z"])
                d.position = (x, y, z)
                d.track.append((x, y))
                self._check_controller(d, rec.get("controller"), t)
                if d.route is not None:
                    self._check_route(d, x, y, t)

            prev, level, announce = d.gap.update(now, newest)
            if announce:
                age = d.gap.age(now)
                if level == NORMAL:
                    self.log("gap", NORMAL, f"{d.label} telemetry restored", now)
                elif prev == level:
                    self.log("gap", level, f"{d.label} still no telemetry ({age:.1f} s)", now)
                else:
                    self.log("gap", level, f"{d.label} telemetry gap {level.lower()}: "
                                           f"last sample {age:.1f} s ago", now)

    def _check_controller(self, d: DroneState, controller, t: float) -> None:
        if controller and controller != d.controller:
            if d.controller is not None:
                self.log("system", WARNING,
                         f"{d.label} ground-station ID changed: {d.controller} -> {controller}", t)
            d.controller = controller

    def _check_route(self, d: DroneState, x: float, y: float, t: float) -> None:
        was_off = d.route.off_route
        off, reached = d.route.update(x, y, t)
        if reached is not None:
            done = " (route complete)" if d.route.finished else ""
            self.log("progress", "INFO", f"{d.label} reached waypoint {reached + 1}{done}", t)
        if off and not was_off:
            why = (f"moving {d.route.speed:.1f} m/s" if d.route.speed > self.th.max_speed_mps
                   else f"{d.route.distance:.2f} m from route")
            self.log("route", ALARM, f"{d.label} off route: {why}", t)
        elif was_off and not off:
            self.log("route", NORMAL, f"{d.label} back on route", t)

    def outage_report(self, now: float = None) -> List[dict]:
        now = now or time.time()
        rows = []
        for d in self.drones.values():
            d.gap.close(now)
            for o in d.gap.outages:
                rows.append({"drone": d.label, "uri": d.uri,
                             "started": datetime.fromtimestamp(o.started).isoformat(),
                             "time_to_critical_s": None if o.critical_after_s is None
                             else round(o.critical_after_s, 2),
                             "duration_s": round(o.duration_s, 2)})
        return rows


# ----------------------------------------------------------------------
# Live view
# ----------------------------------------------------------------------

DRONE_COLORS = ["#2a6f97", "#c46b2a", "#5a8f3e", "#8a4fa3", "#a33c4f", "#3c8a8a"]
LEVEL_COLORS = {NORMAL: "#2e7d32", WARNING: "#b26a00", ALARM: "#c62828",
                CRITICAL: "#8e0000", "INFO": "#37474f"}


class MonitorView:
    """Matplotlib live view: route map on the left, event log on the right.

    Keys: up / down scroll the log, home jumps to the newest events.
    """

    LOG_LINES = 22

    def __init__(self, monitor: FlightMonitor, interactive: bool = True):
        import matplotlib.pyplot as plt
        from matplotlib.lines import Line2D

        self.plt, self.monitor, self.page = plt, monitor, 0
        self.fig = plt.figure(figsize=(15, 7.5))
        gs = self.fig.add_gridspec(1, 2, width_ratios=[1.6, 1], wspace=0.08)
        self.ax = self.fig.add_subplot(gs[0])
        self.log_ax = self.fig.add_subplot(gs[1])
        self.fig.canvas.mpl_connect("key_press_event", self._on_key)

        self.artists = {}
        for i, d in enumerate(monitor.drones.values()):
            c = DRONE_COLORS[i % len(DRONE_COLORS)]
            sx, sy = d.start
            route = [(sx, sy)] + [p[:2] for p in d.path] + [(sx, sy)]
            self.ax.plot(*zip(*route), "--", color=c, alpha=0.45, lw=1.5)
            self.ax.plot(sx, sy, "o", ms=11, mfc="white", mec=c, mew=2)
            self.ax.annotate(f"{d.label} start", (sx, sy), xytext=(0, -16),
                             textcoords="offset points", ha="center", fontsize=8, color=c)
            for j, (dx, dy) in enumerate(d.deliveries):
                self.ax.plot(dx, dy, "s", ms=10, mfc="none", mec=c, mew=1.8)
                self.ax.annotate(f"D{j + 1}", (dx, dy), xytext=(8, 4),
                                 textcoords="offset points", fontsize=8, color=c)
            track, = self.ax.plot([], [], "-", color=c, lw=2, alpha=0.8)
            marker, = self.ax.plot([], [], "o", ms=11, color=c, mec="white", mew=1.5)
            self.artists[d.uri] = (track, marker, c)

        self.ax.set_aspect("equal", adjustable="datalim")
        self.ax.set_xlabel("x (m)")
        self.ax.set_ylabel("y (m)")
        self.ax.grid(True, alpha=0.25)
        legend = [Line2D([], [], color=self.artists[u][2], lw=2, label=d.label)
                  for u, d in monitor.drones.items()]
        legend += [
            Line2D([], [], ls="--", color="gray", label="Planned route"),
            Line2D([], [], marker="s", ls="", mfc="none", mec="gray", label="Delivery point"),
            Line2D([], [], marker="X", ls="", color=LEVEL_COLORS[ALARM], ms=10, label="Off route"),
            Line2D([], [], marker="D", ls="", mfc="none", mec=LEVEL_COLORS[WARNING], ms=9,
                   label="Telemetry gap"),
        ]
        self.ax.legend(handles=legend, loc="upper left", fontsize=8, framealpha=0.9)

        if interactive:
            plt.ion()
            plt.show(block=False)

    def _on_key(self, event) -> None:
        pages = max(1, math.ceil(len(self.monitor.events) / self.LOG_LINES))
        if event.key in ("up", "pageup"):
            self.page = min(self.page + 1, pages - 1)
        elif event.key in ("down", "pagedown"):
            self.page = max(self.page - 1, 0)
        elif event.key == "home":
            self.page = 0
        self._draw_log()

    def _draw_log(self) -> None:
        ax = self.log_ax
        ax.clear()
        ax.axis("off")
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        ax.text(0, 0.985, "Event log", fontsize=12, weight="bold", va="top")
        events = list(self.monitor.events)
        start = self.page * self.LOG_LINES
        y = 0.93
        for ev in events[start:start + self.LOG_LINES]:
            ax.text(0, y, ev.line(), fontsize=8, family="monospace", va="top",
                    color=LEVEL_COLORS.get(ev.level, "#37474f"))
            y -= 0.04
        pages = max(1, math.ceil(len(events) / self.LOG_LINES))
        if pages > 1:
            ax.text(0, 0.0, f"Page {self.page + 1} of {pages}   up/down to scroll, home for newest",
                    fontsize=8, color="gray")

    def draw(self) -> None:
        off = gaps = 0
        for uri, d in self.monitor.drones.items():
            track, marker, c = self.artists[uri]
            if d.track:
                track.set_data(*zip(*d.track))
            if d.position is None:
                continue
            route_off = d.route is not None and d.route.off_route
            gap = d.gap.level != NORMAL
            off += route_off
            gaps += gap
            marker.set_data([d.position[0]], [d.position[1]])
            if route_off:
                red = LEVEL_COLORS[ALARM]
                marker.set(marker="X", mfc=red, mec="white", mew=1.5)
            elif gap:
                marker.set(marker="D", mfc="none", mec=LEVEL_COLORS[d.gap.level], mew=2.5)
            else:
                marker.set(marker="o", mfc=c, mec="white", mew=1.5)
        status = f"Off route: {off}    Telemetry gaps: {gaps}"
        self.ax.set_title(f"Delivery testbed, live\n{status}", fontsize=12,
                          color=LEVEL_COLORS[ALARM] if (off or gaps) else "black")
        self._draw_log()
        self.fig.canvas.draw_idle()
        self.plt.pause(0.01)


# ----------------------------------------------------------------------
# Entry point
# ----------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser(description="Rule-based route and telemetry monitor.")
    p.add_argument("--interval", type=float, default=0.5, help="seconds between checks")
    p.add_argument("--path-metric", choices=["target", "segment"], default="target",
                   help="distance to the next waypoint (default) or to the current route segment")
    p.add_argument("--route-check", nargs="*", metavar="URI",
                   help="only apply the route rule to these drones (default: all)")
    p.add_argument("--clean", action="store_true",
                   help="delete existing drone_position_*.jsonl files before starting")
    p.add_argument("--outages-csv", help="write telemetry outage metrics here on exit")
    p.add_argument("--no-plot", action="store_true", help="console output only")
    args = p.parse_args()

    if args.clean:
        for f in glob.glob("drone_position_*.jsonl"):
            os.remove(f)
            print(f"removed {f}")

    monitor = FlightMonitor(path_metric=args.path_metric, route_checked=args.route_check)
    view = None if args.no_plot else MonitorView(monitor)
    try:
        while True:
            monitor.update()
            if view:
                view.draw()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass

    report = monitor.outage_report()
    print(f"\nTelemetry outages: {len(report)}")
    for r in report:
        print(f"  {r['drone']}: started {r['started']}, lasted {r['duration_s']} s, "
              f"critical after {r['time_to_critical_s']} s")
    if args.outages_csv and report:
        with open(args.outages_csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(report[0]))
            w.writeheader()
            w.writerows(report)
        print(f"Saved to {args.outages_csv}")


if __name__ == "__main__":
    main()
