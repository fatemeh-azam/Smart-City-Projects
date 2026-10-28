"""
Piecewise-polynomial trajectories for the Crazyflie high-level commander.

The Crazyflie can store a trajectory onboard and fly it by itself: a list of
segments, each a 7th-order polynomial in time for x, y, z and yaw. This module
builds those trajectories for the delivery missions in missions.py, evaluates
and plots them, reads and writes them as CSV, and uploads them to a drone.

Each delivery route is built from smooth rest-to-rest segments: every leg
starts and ends with zero velocity, acceleration and jerk, so the drone glides
through the grid's 90-degree corners instead of snapping between straight
lines.

Segment format (the CSV layout used by Bitcraze's tools), 33 numbers:

    duration, x0..x7, y0..y7, z0..z7, yaw0..yaw7

    x(t) = x0 + x1*t + x2*t^2 + ... + x7*t^7,   0 <= t <= duration (seconds)

Yaw is in radians.

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Sequence, Tuple

from missions import CRUISE_HEIGHT, generate_grid_path

Vec3 = Tuple[float, float, float]

SEGMENT_BYTES = 132          # one segment in Crazyflie trajectory memory
SMOOTH_PEAK_RATIO = 2.1875   # peak / average speed of the rest-to-rest profile

# s(tau) = 35 tau^4 - 84 tau^5 + 70 tau^6 - 20 tau^7 rises from 0 to 1 with
# zero velocity, acceleration and jerk at both ends.
_SMOOTH = {4: 35.0, 5: -84.0, 6: 70.0, 7: -20.0}


@dataclass
class Segment:
    duration: float
    x: List[float] = field(default_factory=lambda: [0.0] * 8)
    y: List[float] = field(default_factory=lambda: [0.0] * 8)
    z: List[float] = field(default_factory=lambda: [0.0] * 8)
    yaw: List[float] = field(default_factory=lambda: [0.0] * 8)

    def position(self, t: float) -> Vec3:
        t = min(max(t, 0.0), self.duration)
        return tuple(_polyval(c, t) for c in (self.x, self.y, self.z))

    @property
    def start(self) -> Vec3:
        return self.position(0.0)

    @property
    def end(self) -> Vec3:
        return self.position(self.duration)

    def row(self) -> List[float]:
        return [self.duration] + self.x + self.y + self.z + self.yaw

    @classmethod
    def from_row(cls, row: Sequence[float]) -> "Segment":
        if len(row) < 33:
            raise ValueError(f"expected 33 values per segment, got {len(row)}")
        v = [float(n) for n in row[:33]]
        return cls(v[0], v[1:9], v[9:17], v[17:25], v[25:33])


def _polyval(coeffs: Sequence[float], t: float) -> float:
    result = 0.0
    for c in reversed(coeffs):
        result = result * t + c
    return result


# ----------------------------------------------------------------------
# Building segments
# ----------------------------------------------------------------------

def smooth_segment(p0: Vec3, p1: Vec3, duration: float) -> Segment:
    """Move from p0 to p1 in `duration` seconds, starting and ending at rest."""
    if duration <= 0:
        raise ValueError("duration must be positive")
    axes = []
    for a, b in zip(p0, p1):
        c = [float(a)] + [0.0] * 7
        for k, s in _SMOOTH.items():
            c[k] = (b - a) * s / duration ** k
        axes.append(c)
    return Segment(float(duration), *axes)


def hold_segment(p: Vec3, duration: float) -> Segment:
    """Hover at p for `duration` seconds."""
    return smooth_segment(p, p, duration)


def leg_duration(p0: Vec3, p1: Vec3, max_speed: float, min_duration: float = 1.0) -> float:
    """Time for a smooth leg whose peak speed is `max_speed` (m/s)."""
    return max(min_duration, SMOOTH_PEAK_RATIO * math.dist(p0, p1) / max_speed)


def delivery_trajectory(start: Tuple[float, float], deliveries: List[Tuple[float, float]],
                        height: float = CRUISE_HEIGHT, max_speed: float = 0.5,
                        drop_height: float = 0.3, vertical_speed: float = 0.4,
                        drop_hold: float = 1.0) -> List[Segment]:
    """Trajectory for one delivery mission, matching swarm_mission.py's route.

    Starts hovering above `start` at `height`, follows the grid route from
    missions.generate_grid_path, descends to `drop_height` and hovers for
    `drop_hold` seconds at every delivery point, then flies back above the
    start point. Take off before starting it and land after it ends.
    """
    segments: List[Segment] = []
    here: Vec3 = (start[0], start[1], height)
    targets = {(float(x), float(y)) for x, y in deliveries}

    def go(to: Vec3, speed: float) -> None:
        nonlocal here
        if math.dist(here, to) > 1e-6:
            segments.append(smooth_segment(here, to, leg_duration(here, to, speed)))
            here = to

    for x, y, z, _ in generate_grid_path(start, deliveries, height):
        go((x, y, z), max_speed)
        if (x, y) in targets:
            go((x, y, drop_height), vertical_speed)
            segments.append(hold_segment(here, drop_hold))
            go((x, y, z), vertical_speed)
    go((start[0], start[1], height), max_speed)
    return segments


# ----------------------------------------------------------------------
# Checks and sampling
# ----------------------------------------------------------------------

def total_duration(segments: Iterable[Segment]) -> float:
    return sum(s.duration for s in segments)


def max_gap(segments: Sequence[Segment]) -> float:
    """Largest jump in position between consecutive segments (0 if continuous)."""
    return max((math.dist(a.end, b.start) for a, b in zip(segments, segments[1:])), default=0.0)


def sample(segments: Sequence[Segment], dt: float = 0.05) -> List[Tuple[float, float, float, float]]:
    """(t, x, y, z) every `dt` seconds along the whole trajectory."""
    out, t0 = [], 0.0
    for seg in segments:
        n = max(1, int(math.ceil(seg.duration / dt)))
        for i in range(n):
            t = seg.duration * i / n
            out.append((t0 + t, *seg.position(t)))
        t0 += seg.duration
    if segments:
        out.append((t0, *segments[-1].end))
    return out


def peak_speed(segments: Sequence[Segment], dt: float = 0.02) -> float:
    pts = sample(segments, dt)
    return max((math.dist(a[1:], b[1:]) / (b[0] - a[0])
                for a, b in zip(pts, pts[1:]) if b[0] > a[0]), default=0.0)


# ----------------------------------------------------------------------
# CSV
# ----------------------------------------------------------------------

CSV_HEADER = (["duration"] + [f"x^{i}" for i in range(8)] + [f"y^{i}" for i in range(8)]
              + [f"z^{i}" for i in range(8)] + [f"yaw^{i}" for i in range(8)])


def save_csv(filename: str, segments: Iterable[Segment]) -> None:
    with open(filename, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(CSV_HEADER)
        for s in segments:
            w.writerow([f"{v:.6g}" for v in s.row()])


def load_csv(filename: str) -> List[Segment]:
    """Read a trajectory CSV. A header row, if present, is skipped."""
    segments = []
    with open(filename, newline="") as f:
        for row in csv.reader(f):
            if not row or row[0].strip().startswith("#"):
                continue
            try:
                segments.append(Segment.from_row([float(v) for v in row if v.strip()]))
            except ValueError:
                if segments:  # only the first row may be a header
                    raise
    return segments


# ----------------------------------------------------------------------
# Upload to a drone
# ----------------------------------------------------------------------

def upload(cf, segments: Sequence[Segment], trajectory_id: int = 1) -> float:
    """Write a trajectory to the drone's memory and register it.

    Returns the trajectory's duration in seconds. Fly it with
    `cf.high_level_commander.start_trajectory(trajectory_id)`.
    """
    from cflib.crazyflie.high_level_commander import HighLevelCommander
    from cflib.crazyflie.mem import MemoryElement, Poly4D

    if not segments:
        raise ValueError("empty trajectory")
    if max_gap(segments) > 0.01:
        raise ValueError(f"trajectory has a {max_gap(segments):.3f} m jump between segments")

    mems = cf.mem.get_mems(MemoryElement.TYPE_TRAJ)
    if not mems:
        raise RuntimeError("this Crazyflie has no trajectory memory")
    mem = mems[0]
    capacity = mem.size // SEGMENT_BYTES
    if len(segments) > capacity:
        raise ValueError(f"{len(segments)} segments, but the drone only holds {capacity}")

    mem.trajectory = [
        Poly4D(s.duration, Poly4D.Poly(s.x), Poly4D.Poly(s.y),
               Poly4D.Poly(s.z), Poly4D.Poly(s.yaw))
        for s in segments
    ]
    if not mem.write_data_sync():
        raise RuntimeError("trajectory upload failed")
    cf.high_level_commander.define_trajectory(
        trajectory_id, 0, len(segments), type=HighLevelCommander.TRAJECTORY_TYPE_POLY4D)
    return total_duration(segments)


def describe(segments: Sequence[Segment], label: Optional[str] = None) -> str:
    lines = [f"{label}: " if label else ""]
    lines[0] += (f"{len(segments)} segments, {total_duration(segments):.1f} s, "
                 f"peak speed {peak_speed(segments):.2f} m/s")
    for i, s in enumerate(segments, 1):
        a, b = s.start, s.end
        lines.append(f"  {i:2d}. {s.duration:5.2f} s  ({a[0]:.2f}, {a[1]:.2f}, {a[2]:.2f}) -> "
                     f"({b[0]:.2f}, {b[1]:.2f}, {b[2]:.2f})")
    return "\n".join(lines)
