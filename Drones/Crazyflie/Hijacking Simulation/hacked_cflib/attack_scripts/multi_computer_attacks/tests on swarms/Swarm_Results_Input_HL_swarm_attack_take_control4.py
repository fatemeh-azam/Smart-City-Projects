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
import cflib.crtp

logging.basicConfig(level=logging.INFO)
max_attempts=10
# Import your hacked commander
try:
    from cflib.crazyflie.high_level_commander import HackedHighLevelCommander
except ImportError:
    import sys
    import os
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from high_level_commander import HackedHighLevelCommander

# ==================== CONFIGURATION ====================
SWARM_URIS = [
    "radio://1/80/2M/E7E7E7E7E9",
    "radio://1/80/2M/E7E7E7E7E8"
]

VICTIM_IP = "172.16.151.168"
VICTIM_PORT = 9999

# Global containers for swarm
active_commanders = {}  # uri -> HackedHighLevelCommander
current_swarm = None

# ==================== SWARM CALLBACKS ====================
def initialize_drone(scf):
    """Initialize a single drone in the swarm"""
    uri = scf.cf.link_uri
    print(f"[SWARM] {uri}: Initializing...")
    
    try:
        # Arm the drone
        scf.cf.platform.send_arming_request(True)
        time.sleep(1.0)
        
        # Create hacked commander
        commander = HackedHighLevelCommander(scf.cf)
        active_commanders[uri] = commander
        
        print(f"[SWARM] {uri}: Initialized and armed")
        return True
    except Exception as e:
        print(f"[ERROR] {uri}: Initialization failed - {e}")
        return False

def takeoff_drone(scf):
    """Takeoff a single drone"""
    uri = scf.cf.link_uri
    commander = active_commanders.get(uri)
    
    if not commander:
        print(f"[ERROR] {uri}: No commander found")
        return
    
    print(f"[SWARM] {uri}: Taking off...")
    commander.takeoff(1.0, 3.0)
    time.sleep(3.5)

def execute_attack_sequence(scf, target_x, target_y, max_attempts):
    """Execute attack sequence on a single drone"""
    uri = scf.cf.link_uri
    commander = active_commanders.get(uri)
    
    if not commander:
        print(f"[ERROR] {uri}: No commander for attack")
        return
    # This function doesn't ask for input - it will be controlled from main loop
    duration = 4.0
    commander.go_to(target_x, target_y, 1.0, 0, duration)
    return duration
    
    #print(f"\n[ATTACK] {uri}: Starting attack to ({target_x:.2f}, {target_y:.2f})")
    
    # Multiple go_to attempts
    for attempt in range(1, max_attempts + 1):
        print(f"[ATTACK] {uri}: Attempt {attempt}/{max_attempts}")
        
        # Variable durations
        duration = 4.0 if attempt > 1 else 6.0
        
        # Forceful go_to command
        commander.go_to(target_x, target_y, 1.0, 0, duration)
        time.sleep(duration + 0.5)
        
        # Send victim signal
        if attempt == 2:
            send_victim_signal(f"ATTACK_{uri[-4:]}")
    
    print(f"[ATTACK] {uri}: Attack sequence complete")
def coordinated_interactive_attack(scf, target_x, target_y, max_attempts):
    """Coordinated attack with single user input controlling all drones"""
    uri = scf.cf.link_uri
    commander = active_commanders.get(uri)
    
    if not commander:
        return
def land_drone(scf):
    """Land a single drone"""
    uri = scf.cf.link_uri
    commander = active_commanders.get(uri)
    
    if not commander:
        print(f"[WARNING] {uri}: No commander for landing")
        try:
            scf.cf.platform.send_arming_request(False)
        except:
            pass
        return
    
    print(f"[SWARM] {uri}: Landing...")
    commander.land(0.0, 3.0)
    time.sleep(3.5)
    
    # Disarm
    try:
        scf.cf.platform.send_arming_request(False)
        time.sleep(0.5)
    except:
        pass

# ==================== HELPER FUNCTIONS ====================
def send_victim_signal(message):
    """Send UDP signal to victim"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.sendto(message.encode(), (VICTIM_IP, VICTIM_PORT))
        print(f"[SIGNAL] {message}")
        sock.close()
        return True
    except Exception as e:
        print(f"[SIGNAL] Failed: {e}")
        return False

def emergency_stop(sig=None, frame=None):
    """Emergency stop"""
    print("\n🛑 EMERGENCY STOP!")
    
    if current_swarm:
        try:
            current_swarm.parallel_safe(land_drone)
            time.sleep(2)
            current_swarm.close_links()
        except:
            pass
    
    send_victim_signal("EMERGENCY_STOP")
    sys.exit(0)

# ==================== SWARM ATTACK CONTROL ====================
def run_swarm_attack():
    """Main swarm attack execution"""
    global current_swarm
    
    print("\n" + "="*60)
    print("SWARM ATTACK CONTROLLER - HACKED COMMANDER EDITION")
    print("="*60)
    
    # Get target coordinates
    print("\nSpecify attack coordinates:")
    try:
        target_x = float(input("Enter X coordinate (meters): "))
        target_y = float(input("Enter Y coordinate (meters): "))
    except:
        print("[ERROR] Invalid input, using defaults (1.0, 0.0)")
        target_x = 1.0
        target_y = 0.0
    
    # Define different parameters for each drone
    #swarm_params = {
    #    SWARM_URIS[0]: {
    #        'target_x': target_x,
    #        'target_y': target_y,
    #        'max_attempts': 3
    #    },
    #    SWARM_URIS[1]: {
    #        'target_x': -target_x,  # Opposite direction
    #        'target_y': target_y,
    #        'max_attempts': 3
    #    }
    #}
    swarm_params = {
        SWARM_URIS[0]:[target_x,target_y,15],
        SWARM_URIS[1]:[(-1)*target_x,target_y,15] 
    }


    
    print(f"\n🎯 Target coordinates set")
    print(f"📡 Attacking {len(SWARM_URIS)} drones")
    
    # Send initial signal
    send_victim_signal("SWARM_ATTACK_INITIATED")
    
    # Initialize drivers
    print("\n[INIT] Initializing Crazyflie drivers...")
    cflib.crtp.init_drivers()
    
    # Reduce logging noise
    logging.getLogger('cflib.crazyflie').setLevel(logging.WARNING)
    
    
    # Create factory
    factory = CachedCfFactory(rw_cache='./cache')
        
    # Open swarm connection
    with Swarm(SWARM_URIS, factory=factory) as current_swarm:
        print("\n[SWARM] Connecting to drones...")
            
        # Reset estimators
        #current_swarm.reset_estimators()
        #time.sleep(1.0)
            
        # Step 1: Initialize commanders
        print("[SWARM] Step 1: Initializing hacked commanders...")
        current_swarm.parallel_safe(initialize_drone)
        time.sleep(2.0)
            
        # Step 2: Takeoff
        #print("[SWARM] Step 2: Taking off...")
        #current_swarm.parallel_safe(takeoff_drone)
        #time.sleep(4.0)
            
        # Step 3: Execute coordinated attack
        #print("[SWARM] Step 3: Executing coordinated attack...")
        #current_swarm.parallel_safe(execute_attack_sequence, args_dict=swarm_params)
        #time.sleep(2.0)
        attempt = 1
        while attempt <= max_attempts:
            print(f"\n{'='*60}")
            print(f"COORDINATED ATTACK - ATTEMPT {attempt}/{max_attempts}")
            print(f"{'='*60}")
        
            print("Press ENTER to send command to ALL drones, 'q' to quit, 'l' to land: ")
            user_input = input().strip().lower()
        
            if user_input == 'q':
                break
            elif user_input == 'l':
                current_swarm.parallel_safe(land_drone)
                break
        
            # Send command to all drones
            print(f"\n[COORDINATED] Sending command to all drones...")
            durations = current_swarm.parallel_safe(coordinated_interactive_attack, args_dict=swarm_params)
        
            # Wait for the longest movement to complete
            max_duration = max(durations.values()) if durations else 5.0
            print(f"[COORDINATED] Waiting {max_duration + 1.0}s for movements...")
            time.sleep(max_duration + 1.0)
        
            attempt += 1
        # Step 4: Land all drones
        #print("[SWARM] Step 4: Landing all drones...")
        #current_swarm.parallel_safe(land_drone)
        #time.sleep(3.0)

    
    # Send completion signal
    send_victim_signal("ATTACK_COMPLETE")
    print("\n✅ Swarm attack completed successfully!")

# ==================== MAIN ====================
if __name__ == "__main__":
    print("SWARM ATTACKER v3.0 - HACKED COMMANDER EDITION")
    print("="*60)
    print(f"Target Drones: {', '.join(SWARM_URIS)}")
    print("="*60)
    print("⚠  Press Ctrl+C for emergency stop")
    print("⚠  Using HackedHighLevelCommander - All safety checks disabled")
    
    # Register emergency handler
    signal.signal(signal.SIGINT, emergency_stop)
    
    # Run attack
    run_swarm_attack()

