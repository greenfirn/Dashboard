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