sudo tee /usr/local/bin/rigcloud_agent.py > /dev/null <<'EOF'
#!/usr/bin/env python3
import rigcloud_telemetry as telemetry
import asyncio
import json
import socket
import subprocess
import time
import urllib.request
import os
import datetime
from aiomqtt import Client, MqttError
# ================================================================
# GLOBAL SETTINGS
# ================================================================

BROKER_HOST = "127.0.0.1"
BROKER_PORT = 1883

BROKER_USER = None
BROKER_PASS = None

# Command dispatcher script
CMD_SCRIPT = "/home/user/rigcloud_cmd.sh"

# ================================================================
# LOGGING
# ================================================================
def log(msg):
    print(f"[RigCloud] {msg}", flush=True)

# ================================================================
# CONFIG - load
# ================================================================
def load_broker_config():
    path = "/home/user/rigcloud-agent.conf"
    cfg = {}

    if not os.path.isfile(path):
        return cfg

    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    cfg[k.strip().upper()] = v.strip()
    except Exception as e:
        log(f"Config load error: {e}")

    return cfg

# ================================================================
# CONFIG - LOCAL MQTT OR AWS
# ================================================================
cfg = load_broker_config()

# Override only if present
#if "TELEMETRY_INTERVAL" in cfg:
#    TELEMETRY_INTERVAL = int(cfg["TELEMETRY_INTERVAL"])

USE_AWS = "AWS_MQTT_HOST" in cfg

if USE_AWS:
    BROKER_HOST = cfg["AWS_MQTT_HOST"]
    BROKER_PORT = int(cfg.get("AWS_MQTT_PORT", 8883))

    AWS_CERT = cfg["AWS_MQTT_CERT"]
    AWS_KEY  = cfg["AWS_MQTT_KEY"]
    AWS_CA   = cfg["AWS_MQTT_CA"]

    log("[Config] MQTT Mode = AWS IoT Core")
    log(f"[Config] Endpoint = {BROKER_HOST}:{BROKER_PORT}")

else:
    BROKER_HOST = cfg.get("BROKER_HOST", BROKER_HOST)
    BROKER_PORT = int(cfg.get("BROKER_PORT", BROKER_PORT))
    BROKER_USER = cfg.get("BROKER_USER")
    BROKER_PASS = cfg.get("BROKER_PASS")

    log("[Config] MQTT Mode = LOCAL")
    log(f"[Config] Broker = {BROKER_HOST}:{BROKER_PORT}")

# ================================================================
# TOPICS
# ================================================================

TOPIC_PREFIX = "rigcloud"
RIG_NAME = socket.gethostname()

STATUS_TOPIC = f"{TOPIC_PREFIX}/{RIG_NAME}/status"

# Command topics
CMD_TOPIC_DIRECT = f"{TOPIC_PREFIX}/{RIG_NAME}/cmd"
CMD_TOPIC_ALL = f"{TOPIC_PREFIX}/all/cmd"

# Check topics
CHECK_TOPIC_DIRECT = f"{TOPIC_PREFIX}/{RIG_NAME}/check"
CHECK_TOPIC_ALL = f"{TOPIC_PREFIX}/all/check"

RESP_TOPIC   = f"{TOPIC_PREFIX}/{RIG_NAME}/cmd_response"

# ================================================================
# RUN SHELL HELPERS (unchanged)
# ================================================================
def run(cmd):
    proc = subprocess.run(cmd, shell=True, text=True,
                          stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


# TELEMETRY SECTION goes here !


# ================================================================
# ASYNC PUBLISH
# ================================================================
async def publish_status(mqtt, reason="periodic"):
    payload = await asyncio.to_thread(
        telemetry.collect_full_stats
    )
    payload["event"] = reason
    await mqtt.publish(STATUS_TOPIC, json.dumps(payload))
    log(f"Telemetry sent ({reason})")


# ================================================================
# ASYNC COMMAND HANDLER (EXTERNAL SCRIPT)
# ================================================================

async def handle_command(raw, mqtt):
    log(f"Command received RAW: {raw}")

    try:
        data = json.loads(raw)
    except Exception:
        log("Invalid JSON received")
        return

    cmd_id  = data.get("id", "unknown")
    command = data.get("command")

    if not command:
        log("Command missing 'command'")
        return

    # ---- DASHBOARD REFRESH (optional legacy support) ----
    if command.strip() == "refresh":
        await publish_status(mqtt, "refresh-request")
        return

    try:
        # Execute via external script, pass command via STDIN
        proc = await asyncio.to_thread(
            subprocess.run,
            [CMD_SCRIPT],
            input=command,
            capture_output=True,
            text=True
        )

        response = {
            "id": cmd_id,
            "rig": RIG_NAME,
            "timestamp": int(time.time()),
            "returncode": proc.returncode,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
        }

        await mqtt.publish(RESP_TOPIC, json.dumps(response))
        log(f"Command executed ({cmd_id})")

        # Optional telemetry refresh
        await publish_status(mqtt, "cmd-run")

    except Exception as e:
        log(f"Command execution error: {e}")


# ================================================================
# Publish check
# ================================================================
async def publish_check(mqtt):
    payload = {
        "rig": RIG_NAME,
        "type": "check",
        "timestamp": int(time.time()),
        "uptime": int(time.monotonic()),
        "state": "online"
    }

    await mqtt.publish(STATUS_TOPIC, json.dumps(payload))

# ================================================================
# MQTT LOOP (LOCAL BROKER, AUTH OPTIONAL)
# ================================================================
async def mqtt_loop():
    while True:
        try:
            log(f"Connecting to MQTT {BROKER_HOST}:{BROKER_PORT}")

            client_kwargs = {
                "hostname": BROKER_HOST,
                "port": BROKER_PORT,
            }

            if USE_AWS:
                client_kwargs["tls_params"] = {
                    "ca_certs": AWS_CA,
                    "certfile": AWS_CERT,
                    "keyfile": AWS_KEY,
                }
            else:
                if BROKER_USER:
                    client_kwargs["username"] = BROKER_USER
                    client_kwargs["password"] = BROKER_PASS

            async with Client(**client_kwargs) as mqtt:

                # ---- subscribe to command topics ----
                await mqtt.subscribe(CMD_TOPIC_ALL)
                await mqtt.subscribe(CMD_TOPIC_DIRECT)

                # ---- subscribe to check topics ----
                await mqtt.subscribe(CHECK_TOPIC_ALL)
                await mqtt.subscribe(CHECK_TOPIC_DIRECT)

                log(f"Subscribed → {CMD_TOPIC_ALL}")
                log(f"Subscribed → {CMD_TOPIC_DIRECT}")
                log(f"Subscribed → {CHECK_TOPIC_ALL}")
                log(f"Subscribed → {CHECK_TOPIC_DIRECT}")

                async for msg in mqtt.messages:
                    topic = str(msg.topic)
                    payload = msg.payload.decode(errors="ignore")

                    # ---- CHECK requests ----
                    if topic.endswith("/check"):
                        asyncio.create_task(publish_check(mqtt))
                        continue

                    # ---- COMMAND requests ----
                    if topic.endswith("/cmd"):
                        asyncio.create_task(handle_command(payload, mqtt))
                        continue

                    log(f"Ignoring message on unexpected topic: {topic}")

        except MqttError as e:
            log(f"MQTT error: {e} — retrying in 3s")
            await asyncio.sleep(3)

# ================================================================
# MAIN
# ================================================================
async def main():
    await asyncio.gather(
        mqtt_loop()
    )


if __name__ == "__main__":
    asyncio.run(main())

EOF