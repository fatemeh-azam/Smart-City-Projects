"""
Plot Crazyflie polynomial trajectories: top view, 3D view, and height over time.

Usage:
    python plot_trajectory.py                          # the delivery missions in missions.py
    python plot_trajectory.py examples/figure8.csv     # any trajectory CSV (see trajectories.py)
    python plot_trajectory.py a.csv b.csv --save out.png

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""

from __future__ import annotations

import argparse
import os
from typing import Dict, List, Optional, Sequence, Tuple

from trajectories import Segment, describe, load_csv, sample

COLORS = ["#2a6f97", "#c46b2a", "#5a8f3e", "#8a4fa3", "#a33c4f", "#3c8a8a"]


def plot(trajectories: Dict[str, Sequence[Segment]],
         starts: Optional[Dict[str, Tuple[float, float]]] = None,
         deliveries: Optional[Dict[str, List[Tuple[float, float]]]] = None,
         title: str = "Trajectories", save: Optional[str] = None, show: bool = True):
    import matplotlib.pyplot as plt

    starts, deliveries = starts or {}, deliveries or {}
    fig = plt.figure(figsize=(16, 5.5))
    top = fig.add_subplot(1, 3, 1)
    view3d = fig.add_subplot(1, 3, 2, projection="3d")
    height = fig.add_subplot(1, 3, 3)

    for i, (name, segs) in enumerate(trajectories.items()):
        c = COLORS[i % len(COLORS)]
        pts = sample(segs, 0.05)
        t, x, y, z = zip(*pts)
        top.plot(x, y, color=c, lw=2, label=name)
        view3d.plot(x, y, z, color=c, lw=1.8)
        height.plot(t, z, color=c, lw=2, label=name)

        joints = [s.start for s in segs[1:]]  # where one segment hands over to the next
        if joints:
            top.plot([p[0] for p in joints], [p[1] for p in joints], ".", color=c, ms=5)
        if name in starts:
            sx, sy = starts[name]
            top.plot(sx, sy, "o", ms=11, mfc="white", mec=c, mew=2)
        for dx, dy in deliveries.get(name, []):
            top.plot(dx, dy, "s", ms=11, mfc="none", mec=c, mew=1.8)

    top.set(title="Top view", xlabel="x (m)", ylabel="y (m)")
    top.set_aspect("equal", adjustable="datalim")
    top.grid(True, alpha=0.25)
    top.legend(fontsize=8, loc="best")
    view3d.set(title="3D", xlabel="x (m)", ylabel="y (m)", zlabel="z (m)")
    height.set(title="Height over time", xlabel="time (s)", ylabel="z (m)")
    height.grid(True, alpha=0.25)
    fig.suptitle(title, fontsize=13)
    fig.tight_layout()

    if save:
        fig.savefig(save, dpi=120, bbox_inches="tight")
        print(f"saved {save}")
    if show:
        plt.show()
    return fig


def main() -> None:
    p = argparse.ArgumentParser(description="Plot Crazyflie polynomial trajectories.")
    p.add_argument("csv", nargs="*", help="trajectory CSV files; default is the missions in missions.py")
    p.add_argument("--save", help="save the figure to this file")
    p.add_argument("--no-show", action="store_true", help="don't open a window")
    args = p.parse_args()

    if args.csv:
        trajs = {os.path.splitext(os.path.basename(f))[0]: load_csv(f) for f in args.csv}
        starts, dels, title = {}, {}, "Trajectory files"
    else:
        from missions import MISSIONS, drone_label
        from trajectories import delivery_trajectory
        trajs = {drone_label(u): delivery_trajectory(s, d) for u, (s, d) in MISSIONS.items()}
        starts = {drone_label(u): MISSIONS[u][0] for u in MISSIONS}
        dels = {drone_label(u): MISSIONS[u][1] for u in MISSIONS}
        title = "Delivery missions as smooth trajectories"

    for name, segs in trajs.items():
        print(describe(segs, name).split("\n")[0])
    plot(trajs, starts, dels, title, save=args.save, show=not args.no_show)


if __name__ == "__main__":
    main()
