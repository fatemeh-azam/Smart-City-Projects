# ------------------------------------------------------------------------------
# Drone Grid-Based Trajectory Generation and Execution
#
# Author: Fatemeh Azam
# Email: faa5778@utulsa.edu
#
# Description:
#     This module generates grid-based delivery-style trajectories for Crazyflie
#     drones using Poly4D path segments. It supports uploading and executing
#     those trajectories using the Mellinger controller.
#
# Key Features:
#     - Grid-aligned drone path planning
#     - Delivery motion profiles (descend → hover → ascend)
#     - Swarm-compatible trajectory upload and execution
#
# Dependencies:
#     - cflib (https://github.com/bitcraze/crazyflie-lib-python)
# ------------------------------------------------------------------------------

import time
import math
import cflib.crtp
from cflib.crazyflie import high_level_commander
from cflib.crazyflie.swarm import CachedCfFactory, Swarm
from cflib.crazyflie.mem import Poly4D, MemoryElement
from cflib.crazyflie.high_level_commander import HighLevelCommander

# Constants
HEIGHT = 1.0
ROTATE_TIME = 8
TEST_TIME = 8
DELIVERY_TIME = TEST_TIME
RETURN_TIME = 10
BUFFER = 1

def activate_mellinger_controller(scf, use_mellinger):
    """Activate either the default or Mellinger controller."""
    controller = 2 if use_mellinger else 1
    scf.cf.param.set_value('stabilizer.controller', controller)
    time.sleep(0.5)

def arm(scf):
    """Send arming request to Crazyflie."""
    scf.cf.platform.send_arming_request(True)
    print("arm")
    time.sleep(1.0)

def generate_drone_trajectory(start_point, delivery_points, flight_height=HEIGHT):
    """
    Generate grid-based trajectory with delivery maneuvers.

    Args:
        start_point (tuple[float, float]): (x, y) start location.
        delivery_points (list[tuple[float, float]]): List of delivery targets.
        flight_height (float): Flight altitude (in meters).

    Returns:
        list[Poly4D]: List of trajectory segments.
    """
    if not isinstance(start_point, (tuple, list)) or len(start_point) != 2:
        raise ValueError("Start point must be a tuple of (x, y)")

    if not all(isinstance(p, (tuple, list)) and len(p) == 2 for p in delivery_points):
        raise ValueError("Delivery points must be a list of (x, y) tuples")

    trajectory = []
    current_pos = list(start_point) + [0]
    street_x = start_point[0]
    CRUISE_DURATION = 4.0
    DELIVERY_DURATION = 2.0
    current_pos[2] = flight_height

    for target_x, target_y in delivery_points:
        y_dist = abs(target_y - current_pos[1])
        x_dist = abs(target_x - street_x)

        if not math.isclose(target_y, current_pos[1]):
            move_duration = CRUISE_DURATION * (y_dist / 1.0)
            trajectory.append(_create_poly4d(move_duration, [street_x], [current_pos[1], target_y], [flight_height], 0))
            current_pos[1] = target_y

        if not math.isclose(street_x, target_x):
            move_duration = CRUISE_DURATION * (x_dist / 1.0)
            trajectory.append(_create_poly4d(move_duration, [street_x, target_x], [target_y], [flight_height], 0))

            trajectory.append(_create_poly4d(DELIVERY_DURATION, [target_x], [target_y], [flight_height, 0.3], 0))
            trajectory.append(_create_poly4d(1.0, [target_x], [target_y], [0.3], 0))
            trajectory.append(_create_poly4d(DELIVERY_DURATION, [target_x], [target_y], [0.3, flight_height], 0))
            trajectory.append(_create_poly4d(move_duration, [target_x, street_x], [target_y], [flight_height], 0))

    return trajectory

def _create_poly4d(duration, x, y, z, yaw):
    """
    Internal: Construct Poly4D object for trajectory segments.

    Args:
        duration (float): Segment duration (seconds)
        x, y, z (list): Position values (1 or 2 values)
        yaw (float): Yaw angle (degrees)

    Returns:
        Poly4D: Configured trajectory segment
    """
    class Coefficients:
        def __init__(self, values):
            self.values = values
            self.derivatives = [0.0] * 7

    def _make_coeffs(values):
        if len(values) == 1:
            return Coefficients([float(values[0])] + [0.0]*7)
        elif len(values) == 2:
            vel = float((values[1] - values[0]) / duration)
            return Coefficients([float(values[0]), vel] + [0.0]*6)
        else:
            raise ValueError("Only 1 or 2 values supported.")

    return Poly4D(
        duration=int(duration * 1000),
        x=_make_coeffs(x),
        y=_make_coeffs(y),
        z=_make_coeffs(z),
        yaw=_make_coeffs([yaw])
    )

def poly4d_to_array(trajectory):
    """
    Convert a Poly4D trajectory to a fixed 32-element array format.

    Args:
        trajectory (list[Poly4D]): Trajectory segments

    Returns:
        list[list[float]]: List of 32-element arrays
    """
    trajectory_array = []
    for segment in trajectory:
        x_coeffs = segment.x[:7]
        y_coeffs = segment.y[:7]
        z_coeffs = segment.z[:7]
        yaw_coeffs = segment.yaw[:7]
        duration = segment.duration / 1000.0
        segment_array = [duration] + x_coeffs + y_coeffs + z_coeffs + yaw_coeffs
        segment_array += [0] * (32 - len(segment_array))
        trajectory_array.append(segment_array)
    return trajectory_array

def upload_trajectory(cf, trajectory, trajectory_id=0):
    """
    Upload a Poly4D trajectory to drone memory.

    Args:
        cf (Crazyflie): Drone instance
        trajectory (list[Poly4D]): Trajectory segments
        trajectory_id (int): Trajectory ID
    """
    for seg in trajectory:
        if not isinstance(seg, Poly4D):
            raise ValueError("All segments must be Poly4D.")
        if seg.duration <= 0:
            raise ValueError("Duration must be positive.")

    mems = cf.mem.get_mems(MemoryElement.TYPE_TRAJ)
    if not mems:
        raise RuntimeError("No trajectory memory found.")

    mem = mems[0]
    mem.trajectory = []
    if not mem.write_data_sync():
        raise RuntimeError("Memory clear failed.")

    mem.poly4Ds = trajectory
    if not mem.write_data_sync():
        raise RuntimeError("Upload failed.")

    cf.high_level_commander.define_trajectory(
        trajectory_id,
        0,
        len(trajectory),
        type=HighLevelCommander.TRAJECTORY_TYPE_POLY4D
    )

def upload_trajectories(scf, start_point, targets):
    """
    Upload generated trajectory to the specified drone.

    Args:
        scf (SyncCrazyflie): Synced Crazyflie object
        start_point (tuple): Start location
        targets (list): Waypoints
    """
    trajectory_id = 0
    trajectory = generate_drone_trajectory(start_point, targets, HEIGHT)
    upload_trajectory(scf.cf, trajectory, trajectory_id)

def execute_trajectory(scf):
    """Command drone to takeoff, run trajectory, and land."""
    activate_mellinger_controller(scf, True)
    time.sleep(3)
    cf = scf.cf
    cf.high_level_commander.takeoff(1.0, 2.0)
    time.sleep(2.0)
    cf.high_level_commander.start_trajectory(0, 1, True)
    cf.high_level_commander.land(0.0, 2.0)
    time.sleep(2.0)
    cf.high_level_commander.stop()

# ------------------------------------------------------------------------------
# Mission Definitions
# ------------------------------------------------------------------------------
# Each mission is assigned to a drone URI. It contains:
#     - A start point (x, y)
#     - A list of waypoints (x, y) to deliver to
# ------------------------------------------------------------------------------
missions = {
    'radio://0/80/2M/E7E7E7E7E7': (
        (0.23, -2.13),
        [(0.8, -1.3), (0.8, -0.55), (0.8, 0.6)]
    ),
    'radio://0/80/2M/E7E7E7E7E8': (
        (-0.21, -2.1),
        [(-1.01, -0.42), (-1.01, 1.0)]
    )
}

if __name__ == '__main__':
    cflib.crtp.init_drivers()

    # Step 1: Generate and validate trajectories
    trajectories = {
        uri: generate_drone_trajectory(data[0], data[1])
        for uri, data in missions.items()
    }

    for uri, trajectory in trajectories.items():
        print(f"\n=== Trajectory for {uri} ===")
        print(f"Start: {missions[uri][0]}")
        print(f"Waypoints: {missions[uri][1]}")
        for i, segment in enumerate(trajectory):
            print(f"\nSegment {i} Duration: {segment.duration}ms")
            print(f"  X: {segment.x}")
            print(f"  Y: {segment.y}")
            print(f"  Z: {segment.z}")
            print(f"  Yaw: {segment.yaw}")

    # Step 2: Connect and execute
    factory = CachedCfFactory(rw_cache='./cache')
    with Swarm(missions.keys(), factory=factory) as swarm:
        swarm.parallel_safe(
            upload_trajectories,
            args_dict={uri: [missions[uri][0], missions[uri][1]] for uri in missions}
        )
        time.sleep(3)
        swarm.reset_estimators()
        swarm.parallel_safe(arm)
        time.sleep(3)
        swarm.parallel_safe(execute_trajectory)

