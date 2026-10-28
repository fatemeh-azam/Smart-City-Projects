# victim.py - Run on the first computer
import time
import logging
from cflib.crazyflie import Crazyflie
from cflib import crtp

logging.basicConfig(level=logging.INFO)

def legitimate_control():
    """Normal user controlling the drone"""
    normal_uri = "radio://0/80/2M/E7E7E7E7E7"
    
    cf_normal = Crazyflie(rw_cache='./cache')
    try:
        cf_normal.open_link(normal_uri)
        time.sleep(2)
        cf_normal.platform.send_arming_request(True)
        time.sleep(1.0)
        
        print("Legitimate user: Taking off...")
        from cflib.positioning.motion_commander import HackedMotionCommander
        mc = HackedMotionCommander(cf_normal, default_height=0.5)
        mc.take_off(0.5)
        time.sleep(2)
        print("✅ Legitimate user: Drone airborne")
        
        # Just keep flying - attacker will take over whenever they connect
        print("Flying normally... (waiting for potential attack)")
        time.sleep(20)  # Fly for 20 seconds
        
        # Land normally if no attack happens
        print("No attack detected - landing normally")
        mc.land()
        time.sleep(2)
        
    except Exception as e:
        print(f"❌ Legitimate control error: {e}")
    finally:
        if cf_normal.is_connected():
            cf_normal.close_link()

if __name__ == "__main__":
    print("VICTIM COMPUTER - Legitimate Control")
    print("=======================================")
    crtp.init_drivers()
    legitimate_control()
