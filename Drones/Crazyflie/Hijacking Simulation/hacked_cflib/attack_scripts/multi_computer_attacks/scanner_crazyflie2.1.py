import time
from cflib import crtp

def scan_for_crazyflies():
    """
    Scan for active Crazyflies and return their URIs
    """
    # Initialize the driver
    crtp.init_drivers()
    
    print(" Scanning for Crazyflies...")
    
    # Scan for available interfaces
    available = crtp.scan_interfaces()
    
    #cflib.crtp.init_drivers()
    #available = cflib.crtp.scan_interfaces()
    for i in available:
        print ("Interface with URI [%s] found and name/comment [%s]" % (i[0], i[1]))



    if not available:
        print("❌ No Crazyflies found!")
        return []
    
    print(f"✅ Found {len(available)} Crazyflies:")
    
    crazyflies = []
    for i, (uri, interface_info) in enumerate(available):
        print(f"   {i+1}. {uri}")
        if interface_info:
            print(f"      Interface: {interface_info}")
        crazyflies.append(uri)
    
    return crazyflies

def scan_with_details():
    """
    Scan with more detailed information about each Crazyflie
    """
    crtp.init_drivers()
    
    print(" Detailed scan for Crazyflies...")
    
    available = crtp.scan_interfaces()
    
    if not available:
        print("❌ No Crazyflies detected!")
        print("   Check:")
        print("   - Crazyflie power is ON")
        print("   - Crazyradio is properly connected")
        print("   - Drivers are installed correctly")
        print("   - Radio channel/address matches :cite[10]")
        return
    
    print(f"Found {len(available)} active Crazyflies:")
    print("-" * 50)
    
    for i, (uri, interface_info) in enumerate(available):
        print(f"{i+1}. URI: {uri}")
        
        # Extract details from URI
        if 'radio://' in uri:
            parts = uri.split('/')
            if len(parts) >= 4:
                print(f"   Interface: {parts[2]}")
                print(f"   Channel: {parts[3]}")
                print(f"   Data Rate: {parts[4]}" if len(parts) > 4 else "   Data Rate: Unknown")
                if len(parts) > 5:
                    print(f"   Address: {parts[5]}")
        
        if interface_info:
            print(f"   Additional info: {interface_info}")
        
        print()

# Example usage
if __name__ == "__main__":
    # Simple scan
    crazyflies = scan_for_crazyflies()
    
    # Detailed scan
    scan_with_details()
    
    # You can use the returned URIs to connect to specific Crazyflies
    if crazyflies:
        print(" Ready to connect to detected Crazyflies!")
        print(f"Example connection URI: {crazyflies[0]}")
