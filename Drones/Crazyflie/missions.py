"""
Mission definitions shared by the mission runner and the flight monitor.

Both scripts import from here, so the route a drone flies and the route the
monitor checks it against always come from the same source.

Coordinates are metres in the Loco Positioning System (LPS) frame of the
testbed. Each drone flies along a fixed "street" (its start X coordinate) and
only leaves the street to reach a delivery point that sits off it.

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""

from typing import Dict, List, Tuple

Point2D = Tuple[float, float]
Waypoint = Tuple[float, float, float, float]  # x, y, z, yaw

# Cruise height for the whole mission (m).
CRUISE_HEIGHT = 1.0

# Drone radio URI -> (start point, [delivery points])
MISSIONS: Dict[str, Tuple[Point2D, List[Point2D]]] = {
    "radio://0/80/2M/E7E7E7E7E9": (
        (0.4, -1.85),
        [(0.85, -1.24), (0.85, -0.78), (0.85, 0.95)],
    ),
    "radio://0/80/2M/E7E7E7E7E8": (
        (-0.5, -1.85),
        [(-1.04, -0.93), (-1.04, 1.09)],
    ),
}


def generate_grid_path(start: Point2D, deliveries: List[Point2D],
                       height: float = CRUISE_HEIGHT) -> List[Waypoint]:
    """Turn a list of delivery points into a grid-aligned route.

    For each delivery the drone flies along its street (fixed X) to the
    delivery's Y coordinate. If the delivery is off the street, it turns,
    flies to the delivery point, and comes back to the street before the
    next leg. Yaw is fixed at 0 for the whole route.

    >>> generate_grid_path((0.0, 0.0), [(0.0, 1.0), (0.5, 2.0)], height=1.0)
    [(0.0, 1.0, 1.0, 0), (0.0, 2.0, 1.0, 0), (0.5, 2.0, 1.0, 0), (0.0, 2.0, 1.0, 0)]
    """
    street_x = start[0]
    path: List[Waypoint] = []
    for dx, dy in deliveries:
        path.append((street_x, dy, height, 0))
        if dx != street_x:
            path.append((dx, dy, height, 0))
            path.append((street_x, dy, height, 0))
    return path


def is_delivery_point(uri: str, x: float, y: float) -> bool:
    """True if (x, y) is one of this drone's delivery points."""
    _, deliveries = MISSIONS.get(uri, (None, []))
    return any(x == dx and y == dy for dx, dy in deliveries)


def drone_label(uri: str) -> str:
    """Human-friendly name ("Drone 1") based on order in MISSIONS."""
    uris = list(MISSIONS)
    return f"Drone {uris.index(uri) + 1}" if uri in uris else uri


def log_filename(uri: str) -> str:
    """Telemetry log file the mission runner writes and the monitor reads."""
    return f"drone_position_{uri.replace('://', '_').replace('/', '_')}.jsonl"
