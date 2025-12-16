#!/usr/bin/env python3
import os
import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Dict, Any, List

import paho.mqtt.client as mqtt
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager

# ================================================================
# MQTT CONFIG
# ================================================================
#MQTT_MODE = "local"  # "local" or "aws"

MQTT_MODE = os.getenv("MQTT_MODE", "local")

if MQTT_MODE == "local":
    MQTT_BROKER = os.getenv("MQTT_HOST", "mosquitto")
    MQTT_PORT   = int(os.getenv("MQTT_PORT", "1883"))
    MQTT_USER   = os.getenv("MQTT_USER", "admin")
    MQTT_PASS   = os.getenv("MQTT_PASS", "")

    MQTT_CERT = None
    MQTT_KEY  = None
    MQTT_CA   = None

elif MQTT_MODE == "aws":
    MQTT_BROKER = os.getenv("AWS_MQTT_HOST")  # *.iot.<region>.amazonaws.com
    MQTT_PORT   = int(os.getenv("AWS_MQTT_PORT", "8883"))

    MQTT_CERT = os.getenv("AWS_MQTT_CERT", "/certs/device.pem.crt")
    MQTT_KEY  = os.getenv("AWS_MQTT_KEY",  "/certs/private.pem.key")
    MQTT_CA   = os.getenv("AWS_MQTT_CA",   "/certs/AmazonRootCA1.pem")

    MQTT_USER = None
    MQTT_PASS = None

else:
    raise RuntimeError(f"Invalid MQTT_MODE: {MQTT_MODE}")

# ================================================================
# CONFIG (env overrides)
# ================================================================
BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
BASE_PATH = os.getenv("BASE_PATH", "")
API_BIND = os.getenv("API_BIND", "0.0.0.0")
API_PORT = int(os.getenv("API_PORT", "8765"))

MQTT_TOPIC_FILTER = os.getenv("MQTT_TOPIC_FILTER", "rigcloud/+/status")

BROADCAST_INTERVAL = float(os.getenv("BROADCAST_INTERVAL", "10"))

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

app = FastAPI(lifespan=lifespan)

# CORS (so dashboard can be opened from anywhere on LAN)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent / "static"

app.mount(
    "/static",
    StaticFiles(directory=STATIC_DIR),
    name="static"
)

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
                mqtt_publish(CMD_ALL_TOPIC, {"cmd": "refresh"})
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
@app.get("/")
def serve_root():
    index = STATIC_DIR / "index.html"
    if not index.exists():
        return {"error": "static/index.html missing in container"}
    return FileResponse(index)

@app.get("/rigs")
def get_rigs():
    """Return latest rigs snapshot (debug/API)."""
    with rigs_lock:
        snapshot = dict(rigs)
    return {"rigs": snapshot}

@app.post("/refresh")
def refresh_all():
    mqtt_publish(CMD_ALL_TOPIC, {"cmd": "refresh"})
    return {"status": "refresh sent"}

@app.post("/reset")
def reset_known_rigs():
    global last_refresh_ts
    last_refresh_ts = time.time()

    with known_rigs_lock:
        known_rigs.clear()

    with rigs_lock:
        rigs.clear()

    mqtt_publish(CMD_ALL_TOPIC, {"cmd": "refresh"})
    log("[Reset] Cleared known rigs and telemetry (user request)")
    return {"status": "reset complete"}

# ================================================================
# WEBSOCKET ENDPOINT
# ================================================================
@app.websocket("/ws")
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
        mqtt_publish(CMD_ALL_TOPIC, {"cmd": "refresh"})
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
# MQTT CALLBACKS
# ================================================================
def on_connect(client, userdata, flags, rc):
    if rc == 0:
        log(f"[MQTT] Connected to {MQTT_BROKER}:{MQTT_PORT}")
        client.subscribe(MQTT_TOPIC_FILTER, qos=0)
        log(f"[MQTT] Subscribed to {MQTT_TOPIC_FILTER}")
    else:
        log(f"[MQTT] Connect failed with rc={rc}")

def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode("utf-8"))
        rig_name = data.get("rig") or "unknown"
        now = time.time()

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

        # ---- push to WS immediately (debounced, thread-safe) ----
        global last_ws_push
        if connected_clients and now - last_ws_push >= WS_PUSH_MIN_INTERVAL:
            last_ws_push = now

            if main_loop:
                main_loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(push_snapshot_to_ws())
                )

    except Exception as e:
        log(f"[MQTT] Error processing message: {e}")


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
        protocol=mqtt.MQTTv311
    )

    if MQTT_MODE == "local":
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
    t = threading.Thread(target=mqtt_thread_main, daemon=True)
    t.start()
    uvicorn.run(app, host=API_BIND, port=API_PORT, log_level="info")