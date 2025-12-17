Dashboard for ubuntu rigs...

rigcloud_dashboard_server.py connects to MQTT Broker, local on windows, raspberry pi, or amazon aws
'MOSQUITTO START' - remove this section if not on windows

rigcloud_agent.py runs on rigs to collect stats on demand, accept commands

added visual studio project files in repos to make development a little easier

added setup notes for mosquitto-bridge mode in repos to use visual studio while rigs are still pointed at pi mqtt

cmds received by rigs get handled by rigcloud_cmd.sh

only data hard reset and select butons work for now
