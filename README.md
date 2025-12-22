html Dashboard for ubuntu server rigs...

- added save/delete/apply 'flightsheet' using aws dynamodb
- create a iam profile with db access and save accessKeys.cvs in root of app
- click a row shows more details about docker containers running etc
- hold ctrl click rigname to select individual rows
- cpu / gpu services start, stop, restart, customisable in rigcloud_cmd.sh
- see run-a-miner-services.sh and run-a-miner-script.sh or
- https://github.com/greenfirn/Docker-Events/tree/main/source
- custom commands with reply, install miners, create files with tee echo etc
- index.html serves dashboard, customise colors etc in .css file
- working on more capabilities, design is just what chatgpt suggested for dark theme
- CPU temp, CPU Utl, LA, RAM, GPU temp, GPU UTL, GPU Watts, GPU Fan, VRAM, Core, Mem, CPU/GPU service, Containers running, Miners

![Dashboard Screenshot](Screenshot.png)

** most recent files in repos **
- hashrates shown in dashboard:
- xmrig, bzminer, rigel, srbminer, lolminer, wildrig, onezerominer, gminer
- only first algo atm
- api settings need to be in cmd line,
- bzminer works by default
- see api-settings.txt
- in rigcloud_cmd.sh 'Both' is meant to start, stop, restart
- a 3rd CPU and GPU service but not using it

windows setup:
- for best compadability install python v3.11.x see python-setup.txt
- on whatever pc you want to use as website host/backend see python-setup.txt
- load rigcloud_dashboard_server.py, I use visual studio community for developement
- install x64 version of mqtt broker from https://mosquitto.org/download/ see mosquitto-setup.txt
- set mode to local near top of rigcloud_dashboard_server.py will run mqtt on start hidden
- if not running on windows or dont want mosquitto to start with the server
- remove the mosquitto start functions and if statement near bottom of .py

on mining/AI rigs:
- agent-setup.txt has details about prerequisites
- write rigcloud_agent.py, rigcloud_telemetry.py, rigcloud_cmd.sh, 
- and rigcloud-agent.conf with your login for mqtt
- create service with rigcloud_agent-service.sh
- should see mqtt connected in logs

raspberry pi:
- mqtt, website host/backend
- some notes, config files in raspberry pi - docker

aws advanced setup:
- amazon web services has its own free tier mqtt service, in iot section
- requires unique certificates on website backend and all the mining/AI rigs
- duckdns or similar for connecting to your public ip
- caddy handles certificates, routing
- running server.py on aws lambda might be possible havnt looked into it yet

server start, client connect, disconnect...
- rig names are preserved on browser restarts
- stats are collected on rigs only when webpage is active

![Dashboard connect](Screenshot-client-connect-disconnect.png)

- created a server client mqtt setup before in c# for a Alexa app that could send controls to my local PC
- already familiar with the general setup, python is new to me though

developed with assistance from ChatGPT.
