#!/usr/bin/env python3
import os
import asyncio
import json
import threading
import time
import subprocess
import psutil

from pathlib import Path
from typing import Dict, Any, List

import paho.mqtt.client as mqtt
from paho.mqtt.client import CallbackAPIVersion

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

router = APIRouter()

# ================================================================
# MQTT CONFIG ... https://mosquitto.org/download/
# ================================================================
#MQTT_MODE = "local"  # "local" or "aws"

MQTT_MODE = os.getenv("MQTT_MODE", "local")

if MQTT_MODE == "local":
    MQTT_BROKER = os.getenv("MQTT_HOST", "127.0.0.1")
    MQTT_PORT   = int(os.getenv("MQTT_PORT", "1883"))
    MQTT_USER   = os.getenv("MQTT_USER", "admin")
    MQTT_PASS   = os.getenv("MQTT_PASS", "*****")

    MQTT_CERT = None
    MQTT_KEY  = None
    MQTT_CA   = None
    BASE_PATH = os.getenv("BASE_PATH", "/dashboard")
    
elif MQTT_MODE == "pi":
    MQTT_BROKER = os.getenv("MQTT_HOST", "mosquitto")
    MQTT_PORT   = int(os.getenv("MQTT_PORT", "1883"))
    MQTT_USER   = os.getenv("MQTT_USER", "admin")
    MQTT_PASS   = os.getenv("MQTT_PASS", "*****")

    MQTT_CERT = None
    MQTT_KEY  = None
    MQTT_CA   = None
    BASE_PATH = os.getenv("BASE_PATH", "")

elif MQTT_MODE == "aws":
    MQTT_BROKER = os.getenv("AWS_MQTT_HOST")  # *.iot.<region>.amazonaws.com
    MQTT_PORT   = int(os.getenv("AWS_MQTT_PORT", "8883"))

    MQTT_CERT = os.getenv("AWS_MQTT_CERT", "/certs/device.pem.crt")
    MQTT_KEY  = os.getenv("AWS_MQTT_KEY",  "/certs/private.pem.key")
    MQTT_CA   = os.getenv("AWS_MQTT_CA",   "/certs/AmazonRootCA1.pem")

    MQTT_USER = None
    MQTT_PASS = None
    BASE_PATH = os.getenv("BASE_PATH", "")

else:
    raise RuntimeError(f"Invalid MQTT_MODE: {MQTT_MODE}")

# ================================================================
# CONFIG (env overrides)
# ================================================================

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

API_BIND = os.getenv("API_BIND", "0.0.0.0")
API_PORT = int(os.getenv("API_PORT", "8765"))

MQTT_TOPIC_FILTER = os.getenv("MQTT_TOPIC_FILTER", "rigcloud/+/+")

BROADCAST_INTERVAL = float(os.getenv("BROADCAST_INTERVAL", "10"))

MOSQUITTO_EXE = r"C:\Program Files\mosquitto\mosquitto.exe"
MOSQUITTO_CONF = r"C:\Program Files\mosquitto\mosquitto.conf"

# ================================================================
# GLOBAL STATE
# ================================================================

CMD_ALL_TOPIC = "rigcloud/all/cmd"

mqtt_client = None  # shared MQTT publisher (created in mqtt thread)

main_loop: asyncio.AbstractEventLoop | None = None

broadcast_task: asyncio.Task | None = None
broadcast_stop: asyncio.Event | None = None

last_refresh_ts = 0.0
REFRESH_TIMEOUT = 20  # seconds

last_ws_push = 0.0
WS_PUSH_MIN_INTERVAL = 0.5  # seconds

rigs: Dict[str, Dict[str, Any]] = {}
rigs_lock = threading.Lock()

connected_clients: List[WebSocket] = []
clients_lock = asyncio.Lock()

# ================================================================
# RIG REGISTRY (identity cache)
# ================================================================

known_rigs: set[str] = set()
known_rigs_lock = threading.Lock()

# ================================================================
# LOGGING
# ================================================================
def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [RigCloud] {msg}", flush=True)

# ================================================================
# MOSQUITTO START
# ================================================================

def is_mosquitto_running():
    #log("Checking if Mosquitto process is running...")

    try:
        for p in psutil.process_iter(["pid", "name"]):
            name = p.info.get("name")

            if not name:
                continue

            #log(f"Found process: pid={p.info['pid']} name={name}")

            if "mosquitto" in name.lower():
                #log("Mosquitto process detected")
                return True

        #log("Mosquitto process NOT found")
        return False

    except Exception as e:
        log(f"ERROR while checking Mosquitto process: {e}")
        return False

def start_mosquitto():
    #log("start_mosquitto() called")

    if is_mosquitto_running():
        log("Mosquitto already running — skipping startup")
        return

    #log("Mosquitto not running — attempting to start")

    try:
        log(f"Launching Mosquitto executable: {MOSQUITTO_EXE}")
        log(f"Using config file: {MOSQUITTO_CONF}")
        
        # subprocess.CREATE_NO_WINDOW
        
        DETACHED = (
            subprocess.DETACHED_PROCESS |
            subprocess.CREATE_NEW_PROCESS_GROUP |
            subprocess.CREATE_NO_WINDOW
        )
        subprocess.Popen(
            [MOSQUITTO_EXE, "-c", MOSQUITTO_CONF],
            creationflags=DETACHED,
            close_fds=True
        )

        log("Mosquitto launch command issued")

    except Exception as e:
        log(f"ERROR starting Mosquitto: {e}")

# ================================================================
# BROADCAST LOOP
# ================================================================

async def broadcast_loop():
    log("[Broadcast] Loop started")
    global last_refresh_ts

    try:
        while True:
            await asyncio.sleep(BROADCAST_INTERVAL)

            # ---- hard stop check (sleep may have completed after stop) ----
            if broadcast_stop.is_set():
                break

            # ---- ensure clients still exist ----
            async with clients_lock:
                if not connected_clients:
                    continue

            now = time.time()

            # ---- send refresh if due ----
            if now - last_refresh_ts >= BROADCAST_INTERVAL:
                mqtt_publish(
                    CMD_ALL_TOPIC,
                        {
                            "id": f"refresh-{int(time.time())}",
                            "command": "refresh"
                        }
                )
                last_refresh_ts = now
                log("[MQTT] Refresh requested")

            # ---- OFFLINE DETECTION + SNAPSHOT BUILD ----
            with rigs_lock, known_rigs_lock:
                snapshot = {}

                for rig in known_rigs:
                    info = rigs.get(rig)

                    if info:
                        last_update = info.get("updated", 0)
                        info["online"] = (now - last_update) <= REFRESH_TIMEOUT
                        snapshot[rig] = info
                    else:
                        # rig known but currently offline with no data
                        snapshot[rig] = {
                            "timestamp": 0,
                            "updated": 0,
                            "online": False,
                            "data": {},
                        }

            if not snapshot:
                continue

            async with clients_lock:
                clients = list(connected_clients)

            if not clients:
                continue

            message = {"rigs": snapshot}

            stale = []
            for ws in clients:
                try:
                    await ws.send_json(message)
                except Exception:
                    stale.append(ws)

            if stale:
                async with clients_lock:
                    for ws in stale:
                        if ws in connected_clients:
                            connected_clients.remove(ws)

    finally:
        log("[Broadcast] Loop stopped")

# ================================================================
# HTTP ROUTES
# ================================================================

@router.get("/")
def serve_root():
    index = STATIC_DIR / "index.html"
    if not index.exists():
        return {"error": "static/index.html missing in container"}
    return FileResponse(index)

@router.get("/rigs")
def get_rigs():
    """Return latest rigs snapshot (debug/API)."""
    with rigs_lock:
        snapshot = dict(rigs)
    return {"rigs": snapshot}

@router.post("/refresh")
def refresh_all():
    mqtt_publish(
        CMD_ALL_TOPIC,
        {
            "id": f"refresh-{int(time.time())}",
            "command": "refresh"
        }
    )
    return {"status": "refresh sent"}

@router.post("/reset")
def reset_known_rigs():
    global last_refresh_ts
    last_refresh_ts = time.time()

    with known_rigs_lock:
        known_rigs.clear()

    with rigs_lock:
        rigs.clear()

    mqtt_publish(
        CMD_ALL_TOPIC,
        {
            "id": f"refresh-{int(time.time())}",
            "command": "refresh"
        }
    )

    log("[Reset] Cleared known rigs and telemetry (user request)")
    return {"status": "reset complete"}

@router.post("/command")
async def send_command(payload: dict):
    rigs = payload.get("rigs", [])
    command = payload.get("command")

    if not command or not rigs:
        return {"error": "missing rigs or command"}

    cmd_id = f"cmd-{int(time.time())}"

    msg = {
        "id": cmd_id,
        "command": command
    }

    for rig in rigs:
        topic = f"rigcloud/{rig}/cmd"
        mqtt_publish(topic, msg)
        log(f"[CMD] Sent command to {rig}: {command!r}")

    return {
        "status": "sent",
        "id": cmd_id,
        "rigs": rigs
    }

# ================================================================
# WEBSOCKET ENDPOINT
# ================================================================

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    async with clients_lock:
        connected_clients.append(websocket)
        first_client = len(connected_clients) == 1

    log("[WebSocket] Client connected")

    global broadcast_task
    if first_client:
        broadcast_stop.clear()
        broadcast_task = asyncio.create_task(broadcast_loop())
        mqtt_publish(
            CMD_ALL_TOPIC,
            {
                "id": f"refresh-{int(time.time())}",
                "command": "refresh"
            }
        )

        log("[MQTT] Refresh requested (first WS client)")

    with rigs_lock:
        initial_snapshot = dict(rigs)
    if initial_snapshot:
        await websocket.send_json({"rigs": initial_snapshot})

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        log("[WebSocket] Client disconnected")
    finally:
        async with clients_lock:
            if websocket in connected_clients:
                connected_clients.remove(websocket)

            last_client = len(connected_clients) == 0

        if last_client and broadcast_task:
            broadcast_stop.set()
            broadcast_task = None

            with rigs_lock:
                for info in rigs.values():
                    info["data"] = {}
                    info["online"] = False

            log("[Prune] Cleared live rig telemetry (preserved rig list)")

# ================================================================
# FASTAPI LIFESPAN
# ================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    global main_loop, broadcast_stop, broadcast_task
    main_loop = asyncio.get_running_loop()
    broadcast_stop = asyncio.Event()
    log("[Startup] Dashboard server starting")
    yield
    log("[Shutdown] Dashboard server stopping")

    if broadcast_stop:
        broadcast_stop.set()
    broadcast_task = None

# ================================================================
# FastAPI
# ================================================================

app = FastAPI(lifespan=lifespan)

if MQTT_MODE == "local":
    app.include_router(router, prefix=BASE_PATH)
else:
    app.include_router(router)

# CORS (so dashboard can be opened from anywhere on LAN)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount(
    "/static",
    StaticFiles(directory=STATIC_DIR),
    name="static"
)

# ================================================================
# MQTT CALLBACKS
# ================================================================
def on_connect(client, userdata, flags, reason_code, properties):
    if reason_code == 0:
        log(f"[MQTT] Connected to {MQTT_BROKER}:{MQTT_PORT}")
        client.subscribe(MQTT_TOPIC_FILTER, qos=0)
        log(f"[MQTT] Subscribed to {MQTT_TOPIC_FILTER}")
    else:
        log(f"[MQTT] Connect failed with reason_code={reason_code}")

def on_message(client, userdata, msg):
    try:
        topic = msg.topic
        data = json.loads(msg.payload.decode("utf-8"))
        now = time.time()

        # =====================================================
        # COMMAND RESPONSE
        # rigcloud/<rig>/cmd_response
        # =====================================================
        if topic.endswith("/cmd_response"):
            log(f"[CMD_RESPONSE] {data.get('rig')} id={data.get('id')}")

            if main_loop:
                main_loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(
                        push_cmd_response_to_ws(data)
                    )
                )
            return

        # =====================================================
        # TELEMETRY / STATUS
        # rigcloud/<rig>/status
        # =====================================================
        rig_name = data.get("rig")
        if not rig_name:
            return  # Ignore messages without a rig identity

        # ---- register rig identity ----
        with known_rigs_lock:
            known_rigs.add(rig_name)

        # ---- update live telemetry ----
        with rigs_lock:
            rigs[rig_name] = {
                "timestamp": int(now),
                "updated": now,
                "online": True,
                "data": data,
            }

        # ---- push snapshot to WS (debounced) ----
        global last_ws_push
        if connected_clients and now - last_ws_push >= WS_PUSH_MIN_INTERVAL:
            last_ws_push = now
            if main_loop:
                main_loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(push_snapshot_to_ws())
                )

    except Exception as e:
        log(f"[MQTT] Error processing message: {e}")

async def push_cmd_response_to_ws(resp: dict):
    async with clients_lock:
        clients = list(connected_clients)

    if not clients:
        return

    message = {
        "cmd_response": resp
    }

    for ws in clients:
        try:
            await ws.send_json(message)
        except:
            pass

def mqtt_publish(topic: str, payload: dict):
    try:
        mqtt_client.publish(topic, json.dumps(payload), qos=0)
    except Exception as e:
        log(f"[MQTT] Publish error: {e}")

async def push_snapshot_to_ws():
    with rigs_lock:
        snapshot = dict(rigs)

    async with clients_lock:
        clients = list(connected_clients)

    if not clients:
        return

    message = {"rigs": snapshot}

    stale = []
    for ws in clients:
        try:
            await ws.send_json(message)
        except Exception:
            stale.append(ws)

    if stale:
        async with clients_lock:
            for ws in stale:
                if ws in connected_clients:
                    connected_clients.remove(ws)

def mqtt_thread_main():
    global mqtt_client

    log(f"[MQTT] Mode={MQTT_MODE} Connecting to {MQTT_BROKER}:{MQTT_PORT} ...")

    mqtt_client = mqtt.Client(
        client_id=f"rigcloud-dashboard-{os.getpid()}",
        protocol=mqtt.MQTTv311,
        callback_api_version=CallbackAPIVersion.VERSION2
    )

    if MQTT_MODE == "local" or MQTT_MODE == "pi":
        if MQTT_USER:
            mqtt_client.username_pw_set(MQTT_USER, MQTT_PASS)

    elif MQTT_MODE == "aws":
        mqtt_client.tls_set(
            ca_certs=MQTT_CA,
            certfile=MQTT_CERT,
            keyfile=MQTT_KEY
        )
        mqtt_client.tls_insecure_set(False)

    mqtt_client.on_connect = on_connect
    mqtt_client.on_message = on_message

    keepalive = 30 if MQTT_MODE == "aws" else 60

    while True:
        try:
            mqtt_client.connect(MQTT_BROKER, MQTT_PORT, keepalive=keepalive)
            mqtt_client.loop_forever()
        except Exception as e:
            log(f"[MQTT] Error: {e} — retrying in 3s")
            time.sleep(3)

# ================================================================
# ENTRY POINT
# ================================================================

if __name__ == "__main__":

    if MQTT_MODE == "local":
        start_mosquitto()
    
    t = threading.Thread(target=mqtt_thread_main, daemon=True)
    t.start()
    uvicorn.run(app, host=API_BIND, port=API_PORT, log_level="info")