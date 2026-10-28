# Quick test script
import time

import cflib.crtp
from cflib.crazyflie.swarm import CachedCfFactory
from cflib.crazyflie.swarm import Swarm
from cflib.crazyflie import Crazyflie

def arm(scf):
    scf.cf.platform.send_arming_request(True)
    time.sleep(1.0)

def test_swarm_commander(scf):
    """Test if your commander works in swarm context with symmetric attack"""
    #from high_level_commander import HackedHighLevelCommander
    from cflib.crazyflie.high_level_commander import HackedHighLevelCommander
   
    uri = scf.cf.link_uri
    commander = HackedHighLevelCommander(scf.cf)
    time.sleep(2)
    # Determine which drone is which for symmetric attack
    # Drone 1 (E7E7E7E7E9) goes to +Y, Drone 2 (E7E7E7E7E8) goes to -Y
    if "E7E7E7E7E9" in uri:
        # Drone 1: Go to (1.0, +1.0, 1.0)
        target_x, target_y, target_z = 1.0, 1.0, 1.0
        print(f"✅ Drone 1 ({uri}): Commanding to (+Y) position (1.0, 1.0, 1.0)")
    else:
        # Drone 2: Go to (1.0, -1.0, 1.0) 
        target_x, target_y, target_z = 1.0, -1.0, 1.0
        print(f"✅ Drone 2 ({uri}): Commanding to (-Y) position (1.0, -1.0, 1.0)")
    
    # Test a simple command - SAME X coordinate, OPPOSITE Y coordinates
    commander.go_to(target_x, target_y, target_z, 0, 3.0)
    time.sleep(4)
    commander.land(0,3)
    time.sleep(4)
    return True
# Run test
if __name__ == "__main__":
    uris = ["radio://1/80/2M/E7E7E7E7E9", "radio://1/80/2M/E7E7E7E7E8"]
    cflib.crtp.init_drivers()
    factory = CachedCfFactory(rw_cache='./cache')
    with Swarm(uris, factory=factory) as swarm:
        swarm.reset_estimators()
        swarm.parallel_safe(arm)
        swarm.parallel_safe(test_swarm_commander)
    
    print("Swarm test complete!")
