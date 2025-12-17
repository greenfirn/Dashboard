Dashboard for ubuntu rigs... click a rig to show more details

CPU temp, CPU Utl, LA, RAM, GPU temp, GPU UTL, GPU Watts, GPU Fan, VRAM, Core, Mem, CPU/GPU service active, Miner, Containers running

![Dashboard Screenshot](Screenshot.png)

rigcloud_dashboard_server.py connects to MQTT Broker, local on windows, raspberry pi, or amazon aws

'MOSQUITTO START' - remove this section if not on windows, and if from entry point

rigcloud_agent.py runs on rigs to collect stats on demand, accept commands

visual studio project files in repos to make development a little easier

setup notes for mosquitto-bridge mode in repos to use visual studio while rigs are still pointed else were

cmds received by rigs get handled by rigcloud_cmd.sh

only data hard reset and select buttons work for now


