html Dashboard for ubuntu server rigs...

- click a rig shows more details about docker containers running etc
- cpu / gpu services play, stop, restart, customisable in rigcloud_cmd.sh
- custom commands with reply, install miners, create files with tee echo etc
- index.html serves dashboard, customise colors etc
- CPU temp, CPU Utl, LA, RAM, GPU temp, GPU UTL, GPU Watts, GPU Fan, VRAM, Core, Mem, CPU/GPU service, Miner, Containers running

![Dashboard Screenshot](Screenshot.png)

![Dashboard Screenshot-popout](Screenshot-popout.png)

** most recent files in repos **
- xmrig,bzminer,rigel hashrates
- srbminer configured, not confirmed working
- api settings need to be in cmd line,
- bzminer works by default
- see api bind settings.txt

windows setup:
- install python on whatever pc you want to use as website backend
- load rigcloud_dashboard_server.py add any modules it needs, can use visual studio community
- install x64 version of mqtt broker from https://mosquitto.org/download/
- modify the mqtt conf file in 'C:\Program Files\mosquitto' see mosquitto.conf
- create a folder for password file and data 'C:\mosquitto', 'C:\mosquitto\data'
- create a login 'C:\Program Files\mosquitto\mosquitto_passwd -c C:\mosquitto\ admin'
- set mode to local near top of rigcloud_dashboard_server.py will run mqtt on start hidden

on mining/AI rigs:
- agent setup.txt has details about prerequisites
- write rigcloud_agent.py, rigcloud_telemetry.py, rigcloud_cmd.sh, 
- and rigcloud-agent.conf with your login for mqtt
- create service with rigcloud_agent-service.sh
- should see mqtt connected in logs

aws advanced setup:
- requires unique certificates on website backend pc and all the mining/AI rigs
- duckdns or similar for connecting to your public ip
- caddy handles certificates, routing

Some portions of this project were developed with assistance from ChatGPT.
