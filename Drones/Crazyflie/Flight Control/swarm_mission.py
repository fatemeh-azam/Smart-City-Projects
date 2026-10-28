"""
Smart City Drone Delivery Simulation

Each drone is assigned a mission with a start point and target delivery waypoints.
A grid-based path is generated for each drone prior to flight.

System assumptions:
- The Crazyflie Loco Positioning System (LPS) is used for localization.
- Multiple drones are supported, but each drone's mission must be defined individually.
- No obstacle avoidance is implemented; start points and waypoints must be carefully
  defined using the local coordinate system.

Mission behavior:
- Each drone starts at a fixed X-coordinate aligned with the street grid.
- Drones move only along the Y-axis to reach delivery waypoints.
- At each waypoint, the drone stops, descends for delivery, then continues.
- After completing all deliveries, the drone returns to its start point.

Author: Fatemeh Azam <faa5778@utulsa.edu>
"""


import time
import cflib.crtp
from cflib.crazyflie.swarm import CachedCfFactory, Swarm
from cflib.crazyflie import high_level_commander
from cflib.crazyflie.log import LogConfig
import math
import signal
import sys
import socket
import threading
from battery_Monitoring import BatteryMonitor
import json
from datetime import datetime
import queue

# Global variables
emergency_stop_triggered = False
active_drones = {}  # Dictionary to track active drone objects
position_loggers = {}  # Track position loggers
position_files = {}
halt = False
log_running = True

# Buffered logging system
log_queues = {}
log_threads = {}
log_stats = {}

height = 1
rotateTime = 8  # Time for movement commands (no rotation needed)
testTime = 8
deliveryTime = testTime  # testing different values for deliveryTime to ensure the drone has time to execute a flight command
returnTime = 10  # time to return to the start point
buffer = 1.5
controller = "CTR-7F3A9C"

def log_writer_worker(uri, filename):
    """Dedicated thread for writing logs to file"""
    buffer = []
    buffer_size = 5  # Write every 50 messages
    last_flush = time.time()
    flush_interval = 0.2  # Maximum time between flushes
    
    # Write header
    with open(filename, 'w') as f:
        header_info = {
            'drone_uri': uri,
            'start_time': datetime.now().isoformat(),
            'controller': 'victim',
            'mission': missions.get(uri, ('unknown', []))[1],
            'log_type': 'buffered_async'
        }
        f.write(f"#HEADER: {json.dumps(header_info)}\n")
    
    # Main writing loop
    with open(filename, 'a') as f:
        while log_running or not log_queues[uri].empty():
            try:
                # Non-blocking get with timeout
                log_data = log_queues[uri].get(timeout=1.0)
                buffer.append(log_data)
                
                # Flush if buffer is full or flush_interval seconds passed
                current_time = time.time()
                if (len(buffer) >= buffer_size or 
                    current_time - last_flush >= flush_interval):
                    for data in buffer:
                        f.write(data + '\n')
                    f.flush()  # Force write to disk
                    buffer.clear()
                    last_flush = current_time
                    
                log_queues[uri].task_done()
                
            except queue.Empty:
                # Flush any remaining buffer on timeout
                if buffer:
                    for data in buffer:
                        f.write(data + '\n')
                    f.flush()
                    buffer.clear()
                    last_flush = time.time()
                    
        # Final flush when stopping
        if buffer:
            for data in buffer:
                f.write(data + '\n')
            f.flush()
    
    print(f"📝 Log writer stopped for {uri}")

def setup_position_logging(cf, uri):
    """Set up position logging with buffered writer"""
    # Initialize stats for this URI
    stats = {
        'message_count': 0,
        'dropped_count': 0,
        'last_report': time.time(),
        'last_timestamp': time.time()
    }
    
    def log_pos_callback(timestamp, data, logconf):
        # Use the stats dictionary from outer scope
        current_time = time.time()
        stats['message_count'] += 1
        
        # Report performance every 30 seconds
        if current_time - stats['last_report'] > 30:
            time_since_last = current_time - stats['last_timestamp']
            print(f"📊 {uri} logging: {stats['message_count']} msgs, "
                  f"{stats['dropped_count']} dropped, "
                  f"interval: {time_since_last:.3f}s")
            stats['message_count'] = 0
            stats['dropped_count'] = 0
            stats['last_report'] = current_time
        
        stats['last_timestamp'] = current_time
        
        try:
            x = data['stateEstimate.x']
            y = data['stateEstimate.y']
            z = data['stateEstimate.z']
            
            position_data = {
                'timestamp': current_time,
                'datetime': datetime.now().isoformat(),
                'x': float(x),
                'y': float(y),
                'z': float(z),
                'controller': controller
            }
            
            # NON-BLOCKING: Just add to queue
            if uri in log_queues:
                try:
                    log_queues[uri].put_nowait(json.dumps(position_data))
                except queue.Full:
                    stats['dropped_count'] += 1
                    if stats['dropped_count'] % 10 == 0:  # Report every 10 drops
                        print(f"⚠️  Log queue full for {uri}, dropped {stats['dropped_count']} messages")
            
        except KeyError as e:
            print(f"Position data missing for {uri}: {e}")
        except Exception as e:
            print(f"Error in log callback for {uri}: {e}")
    
    # Store stats in global dictionary for access later
    log_stats[uri] = stats
    
    log_conf = LogConfig(name='Position', period_in_ms=600)
    log_conf.add_variable('stateEstimate.x', 'float')
    log_conf.add_variable('stateEstimate.y', 'float')
    log_conf.add_variable('stateEstimate.z', 'float')
    
    try:
        cf.log.add_config(log_conf)
        log_conf.data_received_cb.add_callback(log_pos_callback)
        log_conf.start()
        position_loggers[uri] = log_conf
        
        # Create log file
        filename = f"drone_position_{uri.replace('://', '_').replace('/', '_')}.jsonl"
        position_files[uri] = filename
        
        # Create queue and start writer thread
        log_queues[uri] = queue.Queue(maxsize=200)  # Buffer up to 200 messages
        log_thread = threading.Thread(
            target=log_writer_worker, 
            args=(uri, filename),
            daemon=True
        )
        log_thread.start()
        log_threads[uri] = log_thread
        
        print(f"✅ Buffered position logging started for {uri} -> {filename}")
        return log_conf
        
    except Exception as e:
        print(f"❌ Failed to start position logging for {uri}: {e}")
        return None
def stop_position_logging(uri):
    """Stop position logging gracefully"""
    if uri in position_loggers:
        try:
            position_loggers[uri].stop()
            
            # Wait for queue to empty (NO TIMEOUT parameter)
            if uri in log_queues:
                print(f"🔄 Flushing log queue for {uri}...")
                log_queues[uri].join()  # Just join(), no timeout
                
            # Write end marker
            if uri in position_files:
                try:
                    end_marker = {
                        'timestamp': time.time(),
                        'datetime': datetime.now().isoformat(),
                        'event': 'logging_stopped',
                        'controller': controller,
                        'final_stats': log_stats.get(uri, {})
                    }
                    with open(position_files[uri], 'a') as f:
                        f.write(json.dumps(end_marker) + '\n')
                except Exception as e:
                    print(f"Error writing end marker for {uri}: {e}")
                    
            print(f"✅ Position logging stopped for {uri}")
            
        except Exception as e:
            print(f"Error stopping position logger for {uri}: {e}")
def ___stop_position_logging(uri):
    """Stop position logging gracefully"""
    if uri in position_loggers:
        try:
            position_loggers[uri].stop()
            
            # Wait for queue to empty (with timeout)
            if uri in log_queues:
                print(f"🔄 Flushing log queue for {uri}...")
                try:
                    log_queues[uri].join(timeout=5.0)  # Wait max 5 seconds
                except Exception as e:
                    print(f"Queue join timeout for {uri}: {e}")
                
            # Write end marker
            if uri in position_files:
                try:
                    end_marker = {
                        'timestamp': time.time(),
                        'datetime': datetime.now().isoformat(),
                        'event': 'logging_stopped',
                        'controller': controller,
                        'final_stats': log_stats.get(uri, {})
                    }
                    with open(position_files[uri], 'a') as f:
                        f.write(json.dumps(end_marker) + '\n')
                except Exception as e:
                    print(f"Error writing end marker for {uri}: {e}")
                    
            # Clean up
            if uri in log_queues:
                del log_queues[uri]
            if uri in log_threads:
                del log_threads[uri]
            if uri in log_stats:
                del log_stats[uri]
            del position_loggers[uri]
                
            print(f"✅ Position logging stopped for {uri}")
        except Exception as e:
            print(f"Error stopping position logger for {uri}: {e}")

def victim_network_listener():
    """Listen for signals from attacker"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('0.0.0.0', 9999))
    global halt   
    print("📡 Victim listening for attacker signals...")
    
    while True:
        try:
            data, addr = sock.recvfrom(1024)
            message = data.decode()
            print(f"📡 Received signal: {message}")
            target_uri = list(missions.keys())[0]  
            target_cf = active_drones[target_uri]
            
            if message == "ATTACK":
                halt = True
                print("🛑 Attacker first signal received - halt activated")

            if message == "ATTACKER_READY":
                print("🛑 Attacker ready - preparing to disconnect...")
                
                try:
                    print(f"Closing link for {target_uri}")
                    target_cf.close_link()
                except Exception as e:
                    print(f"Error closing link for {target_uri}: {e}")
                
            elif message == "TAKEOVER_IMMINENT":
                print("🛑 Takeover imminent - emergency disconnect!")
                
        except Exception as e:
            print(f"❌ Network listener error: {e}")

# Start the listener in a separate thread
network_thread = threading.Thread(target=victim_network_listener, daemon=True)
network_thread.start()

def configure_lps_priority(scf):
    """Configure EKF to prioritize LPS over flow deck"""
    cf = scf.cf
    
    try:
        print(" Disabling Flow Deck Z-ranger influence...")
        cf.param.set_value('kalman.pNAcc_z', '0.5')
        cf.param.set_value('kalman.mNBaro', '4.0')
        cf.param.set_value('kalman.resetEstimation', '1')
        time.sleep(4)
    except KeyError:
        print(f"Parameter not found for {scf._link_uri}")
    
    # Reset estimator to apply new settings
    try:
        cf.param.set_value('kalman.resetEstimation', '1')
        time.sleep(0.1)
        cf.param.set_value('kalman.resetEstimation', '0')
    except KeyError:
        pass

def emergency_stop(sig=None, frame=None):
    """Emergency stop function that stops all drones immediately"""
    global emergency_stop_triggered, log_running
    print("🛑 EMERGENCY STOP TRIGGERED! Stopping all drones...")
    emergency_stop_triggered = True
    log_running = False  # Signal log threads to stop
    
    # Stop all position loggers
    for uri in list(position_loggers.keys()):
        print(f"Stopping logger for {uri}")
        stop_position_logging(uri)
    
    # Immediately stop all active drones
    for uri, cf in active_drones.items():
        try:
            print(f"Stopping motors for {uri}")
            cf.commander.send_stop_setpoint()  # Stop motors immediately
        except Exception as e:
            print(f"Error stopping {uri}: {e}")
    
    # Give log threads a moment to flush
    print("🔄 Final log flush...")
    time.sleep(2.0)
    
    sys.exit(0)  # Exit the entire program

# catch Ctrl+C
signal.signal(signal.SIGINT, emergency_stop)

def activate_mellinger_controller(scf, use_mellinger):
    controller = 1
    if use_mellinger:
        controller = 2
    scf.cf.param.set_value('stabilizer.controller', controller)

def arm(scf):
    scf.cf.platform.send_arming_request(True)
    time.sleep(1.0)

def generate_grid_path_test(start, waypoints):
    """Convert waypoints into grid-aligned segments with fixed yaw (0)"""
    path = []
    streetX = start[0]  # Fixed X-coordinate for entire mission

    for target in waypoints:
        # Fixed yaw (0) for all movements
        yaw = 0
        
        # Move vertically along street path to target Y-coordinate
        # Only change Y-coordinate, keep X fixed at streetX
        path.append((streetX, target[1], height, yaw))
    
    print(f"Generated path: {path}")
    return path

def generate_grid_path(start, waypoints):
    """Convert waypoints into grid-aligned segments with fixed yaw (0)"""
    path = []
    streetX = start[0]

    for target in waypoints:
        yaw = 0
        path.append((streetX, target[1], height, yaw))
        
        if streetX != target[0]:                              
            path.append((target[0], target[1], height, yaw))
            path.append((streetX, target[1], height, yaw))
    
    print(f"Generated path: {path}")
    return path

#get the street X-coordinate per drone
def getStreetX(key):
    if key not in missions:
        raise ValueError(f"Mission key '{key}' not found.")
    start_point = missions[key][0]
    return start_point[0]  # x-coordinate

#check if x,y are target waypoints for uri==key
def check_position(key, x, y):
    targets = missions.get(key, (None, []))[1]  # get only the targets
    return any((x == mx and y == my) for mx, my in targets)

# Simplified function to check for emergency stop
def check_emergency_stop(cf, commander):
    global emergency_stop_triggered
    if emergency_stop_triggered:
        print("Emergency stop - stopping motors")
        commander.send_stop_setpoint()  # Immediately stop motors
        time.sleep(0.1)  # Ensure command is sent
        return True
    return False

#this is done in parallel for all drones, based on their specific path
def execute_grid_path(scf, path, start_point):
    global emergency_stop_triggered, active_drones, halt 
    
    cf = scf.cf
    commander = cf.high_level_commander
    uri = scf._link_uri
     
    # Register this drone as active
    active_drones[uri] = cf
    
    # Start position logging with buffered system
    pos_log = setup_position_logging(cf, uri)
    if not pos_log:
        print(f"❌ Failed to start position logging for {uri}")
    
    # Check for emergency stop before starting
    if check_emergency_stop(cf, commander):
        #stop_position_logging(uri)
        return
    
    monitor = BatteryMonitor(cf)
    monitor.setup_logging()
    time.sleep(1) 

    descend = 0.7
    
    # Check for emergency stop before takeoff
    if check_emergency_stop(cf, commander):
        #stop_position_logging(uri)
        return
        
    # Takeoff
    decision = monitor.flight_decision() 
    if decision > 0:
        print("Takeoff Aborted")
        #stop_position_logging(uri)
        return

    commander.takeoff(1.0, 2.0)
    time.sleep(3)
    
    # Execute grid path with fixed yaw (0)
    for point in path:
        #print("Debug")
        #print(uri)
        #print(halt)
        #print(list(missions.keys())[0])
        if uri == list(missions.keys())[0] and halt:
            print("🛑 Attack detected - pausing execution...")
            continue
            
        # Check for emergency stop before each movement
        if check_emergency_stop(cf, commander):
            #stop_position_logging(uri)
            return
            
        x, y, z, yaw = point
        
        print(f" Moving to: {point}"+uri)

        decision = monitor.flight_decision()
        if decision == 1:
            # Land
            commander.land(0.0, 3.0)
            time.sleep(4)
            #stop_position_logging(uri)
            return
        elif decision == 2:
            #return to station
            print(uri + " returning to station")
            if start_point:
                x, y = start_point[0], start_point[1]  # Get only x,y coordinates
                commander.go_to(x, y, height, 0, returnTime)  
                time.sleep(returnTime + 1)
                # Land
                commander.land(0.0, 6.0)
                time.sleep(9)
                #stop_position_logging(uri)
                return
            else:
                #stop_position_logging(uri)
                return

        commander.go_to(x, y, z, 0, rotateTime)  # X,Y,Z,Yaw=0,Time(s)
        time.sleep(rotateTime + buffer)  # Includes movement + stabilization
        
        # Check for emergency stop after movement
        if check_emergency_stop(cf, commander):
            #stop_position_logging(uri)
            return
            
        decision = monitor.flight_decision()
        if decision == 1:
            # Land
            commander.land(0.0, 3.0)
            time.sleep(4)
            #stop_position_logging(uri)
            return
        elif decision == 2:
            #return to station
            print(uri + " returning to station")
            if start_point:
                x, y = start_point[0], start_point[1]  # Get only x,y coordinates
                commander.go_to(x, y, height, 0, returnTime)  # X,Y,Z,Yaw=0,Time(s)
                time.sleep(returnTime + 1)
                # Land
                commander.land(0.0, 6.0)
                time.sleep(9)
                #stop_position_logging(uri)
                return
            else:
                #stop_position_logging(uri)
                return

        #Check if delivery point
        if check_position(uri, x, y):
            # Check for emergency stop before delivery
            if check_emergency_stop(cf, commander):
                #stop_position_logging(uri)
                return
                
            #Delivery simulation_descend
            commander.go_to(x, y, z - descend, 0, testTime)  # X,Y,Z,Yaw=0,Time(s)
            time.sleep(testTime + buffer)  # Includes movement + stabilization
            
            # Check for emergency stop during delivery
            if check_emergency_stop(cf, commander):
                #stop_position_logging(uri)
                return
                
            #Delivery simulation_ascend
            commander.go_to(x, y, z, 0, testTime)  # X,Y,Z,Yaw=0,Time(s)
            time.sleep(testTime + buffer)

    # Check for emergency stop before return
    if check_emergency_stop(cf, commander):
        #stop_position_logging(uri)
        return
        
    # Return to start with fixed yaw (0)
    if uri == list(missions.keys())[0] and halt:
        print("🛑 Attack detected - pausing execution...")
        

    elif start_point:
        x, y = start_point[0], start_point[1]  # Get only x,y coordinates
        commander.go_to(x, y, height, 0, returnTime)  # X,Y,Z,Yaw=0,Time(s)
        time.sleep(returnTime + 1)
    
         # Land
        commander.land(0.0, 6.0)
        time.sleep(9)
    
    # Stop position logging and remove from active list
    #stop_position_logging(uri)
        if uri in active_drones:
            del active_drones[uri]

# Drone missions (URI: (start, waypoints))
missions = {
    'radio://0/80/2M/E7E7E7E7E9': (
        (0.4, -1.85),
        [(0.85, -1.24), (0.85, -0.78), (0.85, 0.95)]  
    ),
    'radio://0/80/2M/E7E7E7E7E8': (
        (-0.5, -1.85),
        [(-1.04, -0.93), (-1.04, 1.09)] 
    )
}

if __name__ == '__main__':
    cflib.crtp.init_drivers()

    print(" Starting victim mission with BUFFERED position logging...")
    print(" Position data will be saved with async buffered writing")
    print(" Performance monitoring enabled - will report every 30 seconds")
    
    # Generate paths for a swarm of drones
    swarm_paths = {
        uri: generate_grid_path(data[0], data[1])
        for uri, data in missions.items()
    }
    
    # Execute all paths in parallel
    factory = CachedCfFactory(rw_cache='./cache')
    with Swarm(missions.keys(), factory=factory) as swarm:
        # Check for emergency stop before starting
        if emergency_stop_triggered:
            print("Emergency stop triggered before flight")
            sys.exit(0)

        swarm.reset_estimators() 
        swarm.parallel_safe(arm)
        time.sleep(1)
        
        # Check for emergency stop after arming
        if emergency_stop_triggered:
            print("Emergency stop triggered after arming")
            # Stop all drones immediately
            for scf in swarm._cfs.values():
                try:
                    scf.cf.commander.send_stop_setpoint()
                except:
                    pass
            sys.exit(0)
            
        print("🎯 Victim mission started - buffered logging active")
        print("Logs are buffered and written asynchronously to prevent slowdowns")
        swarm.parallel_safe(execute_grid_path, args_dict={
            uri: [swarm_paths[uri], missions[uri][0]] for uri in swarm_paths
        })
    
    # Signal log threads to stop
    #log_running = False
    #time.sleep(2.0)  # Give threads time to flush
    
    #print("✅ Victim mission complete! Position files:")
    #for uri, filename in position_files.items():
    #    print(f"   {uri} -> {filename}")
    
    #print("📊 Final log statistics:")
    #for uri, stats in log_stats.items():
    #    print(f"   {uri}: {stats}")
