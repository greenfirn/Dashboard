sudo tee /etc/systemd/system/rigcloud-agent.service > /dev/null <<'EOF'
[Unit]
Description=RigCloud MQTT Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/bin/rigcloud_agent.py
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

# let daemon know about update
sudo systemctl daemon-reload

# enable the service so it starts on boot
sudo systemctl enable rigcloud-agent.service

# start service
sudo systemctl start rigcloud-agent.service

# watch logs
sudo journalctl -u rigcloud-agent.service -f

# to remove
# sudo systemctl stop rigcloud-agent.service
# sudo systemctl disable rigcloud-agent.service
