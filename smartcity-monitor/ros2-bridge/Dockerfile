FROM ros:humble-ros-base

# Install dependencies
RUN apt-get update && apt-get install -y \
    python3-pip \
    ros-humble-geometry-msgs \
    ros-humble-sensor-msgs \
    ros-humble-std-msgs \
    ros-humble-ros2bag \
    ros-humble-rosbag2-storage-default-plugins \
    ros-humble-rosbag2-storage-mcap \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install paho-mqtt

WORKDIR /app
COPY crazyflie_ros2_bridge_mqtt.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Bags folder — mounted from Windows host in docker-compose
RUN mkdir -p /bags

ENTRYPOINT ["/app/entrypoint.sh"]
