sudo tee /usr/local/bin/rigcloud_telemetry.py > /dev/null <<'EOF'
# ========== TELEMETRY ===================================
# rigcloud_telemetry.py
import os
import subprocess
import datetime
import urllib.request
import json
import time
import socket

RIG_NAME = socket.gethostname()

def run(cmd: str):
    proc = subprocess.run(
        cmd,
        shell=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def service_status(service):
    rc, out, _ = run(f"systemctl is-active {service}")
    return out.strip() if rc == 0 else "unknown"

def has_nvidia_gpu():
    try:
        rc = subprocess.run(
            ["nvidia-smi", "-L"],
            capture_output=True,
            text=True,
            timeout=1.0
        )
        return rc.returncode == 0 and rc.stdout.strip() != ""
    except Exception:
        return False

def collect_gpu_stats():
    cmd = (
        "nvidia-smi --query-gpu=index,uuid,temperature.gpu,"
        "utilization.gpu,utilization.memory,power.draw,"
        "clocks.sm,clocks.mem,fan.speed,"
        "memory.total,memory.used "
        "--format=csv,noheader,nounits"
    )

    rc = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if rc.returncode != 0:
        return []

    lines = rc.stdout.strip().split("\n")
    if not lines:
        return []

    gpus = []
    for line in lines:
        fields = [x.strip() for x in line.split(",")]
        if len(fields) != 11:
            continue

        (
            idx, uuid, temp, util, memutil, watts,
            smclk, memclk, fan, memtotal, memused
        ) = fields

        try:
            gpus.append({
                "index": int(idx),
                "uuid": uuid,
                "temp": int(temp),
                "util": int(util),
                "mem_util": int(memutil),
                "power_watts": float(watts),
                "fan_percent": int(fan),
                "sm_clock": int(smclk),
                "mem_clock": int(memclk),
                "vram_used": int(memused),
                "vram_total": int(memtotal),
            })
        except ValueError:
            continue

    return gpus


def collect_cpu_temp():
    # 1) Try Intel-style hwmon sensors ("coretemp")
    try:
        hwmon_base = "/sys/class/hwmon"
        for hw in os.listdir(hwmon_base):
            name_path = os.path.join(hwmon_base, hw, "name")
            if not os.path.isfile(name_path):
                continue

            with open(name_path, "r") as f:
                name = f.read().strip().lower()

            if "coretemp" in name or "pch" in name:
                # look for temp sensors
                for file in os.listdir(os.path.join(hwmon_base, hw)):
                    if file.startswith("temp") and file.endswith("_input"):
                        temp_path = os.path.join(hwmon_base, hw, file)
                        try:
                            with open(temp_path, "r") as t:
                                return int(t.read().strip()) / 1000.0
                        except:
                            continue
    except:
        pass

    # 2) Try AMD Ryzen ("k10temp")
    try:
        hwmon_base = "/sys/class/hwmon"
        for hw in os.listdir(hwmon_base):
            name_path = os.path.join(hwmon_base, hw, "name")
            if not os.path.isfile(name_path):
                continue

            with open(name_path, "r") as f:
                name = f.read().strip().lower()

            if name == "k10temp":
                temp_path = os.path.join(hwmon_base, hw, "temp1_input")
                if os.path.isfile(temp_path):
                    with open(temp_path, "r") as t:
                        return int(t.read().strip()) / 1000.0
    except:
        pass

    # 3) Last fallback — thermal zones (works on Intel laptops, servers, some desktops)
    try:
        thermal_base = "/sys/class/thermal"
        for zone in os.listdir(thermal_base):
            if not zone.startswith("thermal_zone"):
                continue

            temp_path = os.path.join(thermal_base, zone, "temp")
            if os.path.isfile(temp_path):
                with open(temp_path, "r") as t:
                    value = int(t.read().strip())
                    if value > 0:
                        return value / 1000.0
    except:
        pass

    # Nothing found
    return None

def collect_cpu_usage():
    with open("/proc/stat") as f:
        s1 = f.readline().split()
    idle1 = int(s1[4])
    total1 = sum(map(int, s1[1:]))

    time.sleep(0.1)

    with open("/proc/stat") as f:
        s2 = f.readline().split()
    idle2 = int(s2[4])
    total2 = sum(map(int, s2[1:]))

    if total2 == total1:
        return 0.0

    return round(100 * (1 - (idle2 - idle1) / (total2 - total1)), 1)


def collect_load():
    with open("/proc/loadavg") as f:
        l1, l5, l15, *_ = f.read().split()
    return {"1m": float(l1), "5m": float(l5), "15m": float(l15)}


def collect_memory():
    mem = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":")
            mem[k] = int(v.strip().split()[0])

    total = mem.get("MemTotal", 0)
    avail = mem.get("MemAvailable", 0)
    used = total - avail if total and avail else 0

    return {
        "total_mb": total // 1024,
        "used_mb": used // 1024,
        "free_mb": avail // 1024,
        "percent": round((used / total * 100), 1) if total else 0.0
    }


def collect_docker_containers():
    containers = []

    rc, out, err = run(
        'docker ps --filter "status=running" --filter "status=paused" '
        '--format "{{.Names}}|{{.Image}}|{{.ID}}|{{.Status}}"'
    )

    if rc != 0 or not out.strip():
        return containers

    for line in out.strip().splitlines():
        try:
            name, image, cid, status = line.split("|", 3)
            state = "paused" if "Paused" in status else "running"

            rc2, started_raw, _ = run(
                f'docker inspect -f "{{{{.State.StartedAt}}}}" {cid}'
            )

            uptime_seconds = None

            if rc2 == 0 and started_raw.strip():
                ts = started_raw.strip()
                clean = ts.replace("Z", "")

                if "." in clean:
                    base, frac = clean.split(".", 1)
                    frac = (frac + "000000")[:6]
                    clean = f"{base}.{frac}"

                clean += "+00:00"

                try:
                    dt = datetime.datetime.fromisoformat(clean)
                    now = datetime.datetime.now(datetime.timezone.utc)
                    uptime_seconds = int((now - dt).total_seconds())
                except:
                    uptime_seconds = None

            containers.append({
                "name": name,
                "image": image,
                "state": state,
                "uptime_seconds": uptime_seconds
            })

        except:
            continue

    return containers


def collect_service_uptime(service):
    try:
        rc, out, _ = run(f"systemctl is-active {service}")
        state = out.strip().lower()
        if state != "active":
            return {"state": state, "uptime_seconds": 0}

        rc, ts, _ = run(
            f"systemctl show {service} -p ExecMainStartTimestamp --value"
        )
        ts = ts.strip()
        if not ts:
            return {"state": state, "uptime_seconds": 0}

        rc2, start_unix_txt, _ = run(f"date -u -d \"{ts}\" +\"%s\"")
        start_unix = int(start_unix_txt.strip())

        rc3, now_txt, _ = run("date -u +\"%s\"")
        now_unix = int(now_txt.strip())

        return {
            "state": state,
            "uptime_seconds": max(0, now_unix - start_unix)
        }

    except:
        return {"state": "unknown", "uptime_seconds": 0}

def collect_bzminer_stats():
    API_URL = "http://127.0.0.1:4014/status"
    try:
        req = urllib.request.Request(API_URL, method="GET")
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"status": "offline", "error": str(e)}

    pools = data.get("pools") or []
    pool0 = pools[0] if pools else {}

    raw_hash = pool0.get("hashrate")
    total_mhs = float(raw_hash) / 1_000_000 if raw_hash else None

    return {
        "status": "ok",
        "uptime_s": pool0.get("uptime_s") or data.get("uptime_s"),
        "total_mhs": total_mhs,
        "accepted": pool0.get("valid_solutions"),
        "rejected": pool0.get("rejected_solutions")
    }

def collect_rigel_stats():
    host = os.environ.get("RIGEL_API_HOST", "127.0.0.1")
    port = int(os.environ.get("RIGEL_API_PORT", "5000"))
    url = f"http://{host}:{port}"

    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"status": "offline", "error": str(e)}

    algo = data.get("algorithm")
    uptime_s = data.get("uptime")

    total_hs = None
    pool_hs = None

    # Rigel reports hashrate per-algorithm
    hr = data.get("hashrate", {})
    phr = data.get("pool_hashrate", {})

    if algo and isinstance(hr, dict):
        total_hs = hr.get(algo)

    if algo and isinstance(phr, dict):
        pool_hs = phr.get(algo)

    # Shares (global)
    accepted = None
    rejected = None

    sol = data.get("solution_stat", {}).get(algo)
    if isinstance(sol, dict):
        accepted = sol.get("accepted")
        rejected = sol.get("rejected")

    return {
        "status": "ok",
        "algo": algo,
        "uptime_s": uptime_s,
        "total_hs": total_hs,
        "pool_hs": pool_hs,
        "accepted": accepted,
        "rejected": rejected
    }

def collect_srbminer_stats():
    host = os.environ.get("SRB_API_HOST", "127.0.0.1")
    port = int(os.environ.get("SRB_API_PORT", "21550"))
    url = f"http://{host}:{port}"

    try:
        with urllib.request.urlopen(url, timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {
            "status": "offline",
            "error": str(e)
        }

    algos = data.get("algorithms", [])
    if not algos:
        return {
            "status": "ok",
            "note": "no algorithms running"
        }

    a0 = algos[0]

    # -------------------------------
    # Hashrates
    # -------------------------------
    hr = a0.get("hashrate", {})

    cpu_block = hr.get("cpu", {}) if isinstance(hr, dict) else {}
    gpu_block = hr.get("gpu", {}) if isinstance(hr, dict) else {}

    cpu_hs = cpu_block.get("total")
    gpu_hs = gpu_block.get("total")

    # Compute combined total only when values exist
    total_hs = 0.0
    if isinstance(cpu_hs, (int, float)):
        total_hs += cpu_hs
    if isinstance(gpu_hs, (int, float)):
        total_hs += gpu_hs

    # -------------------------------
    # Shares
    # -------------------------------
    shares = a0.get("shares", {})
    accepted = shares.get("accepted")
    rejected = shares.get("rejected")

    # -------------------------------
    # Workers
    # -------------------------------
    cpu_workers = data.get("total_cpu_workers")
    gpu_workers = data.get("total_gpu_workers")

    # -------------------------------
    # Uptime
    # -------------------------------
    uptime_s = (
        data.get("mining_time")
        or data.get("uptime")
        or data.get("uptime_s")
    )

    return {
        "status": "ok",
        "miner": "srbminer",
        "algo": a0.get("name"),
        "uptime_s": uptime_s,

        # Workers
        "cpu_workers": cpu_workers,
        "gpu_workers": gpu_workers,

        # Hashrates (H/s)
        "cpu_hs": cpu_hs,
        "gpu_hs": gpu_hs,
        "total_hs": total_hs if total_hs > 0 else None,

        # Shares
        "accepted": accepted,
        "rejected": rejected,
    }

def collect_wildrig_stats():
    host = os.environ.get("WILDRIG_API_HOST", "127.0.0.1")
    port = int(os.environ.get("WILDRIG_API_PORT", "4000"))
    url = f"http://{host}:{port}"

    try:
        with urllib.request.urlopen(url, timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"status": "offline", "error": str(e)}

    # -------------------------------
    # Basic fields
    # -------------------------------
    algo = data.get("algo")
    uptime_s = data.get("uptime")

    # -------------------------------
    # Hashrate (H/s)
    # -------------------------------
    total_hs = None
    hr = data.get("hashrate", {}).get("total")

    if isinstance(hr, list) and len(hr) > 0:
        total_hs = hr[0]

    # -------------------------------
    # Shares
    # -------------------------------
    accepted = None
    rejected = None

    results = data.get("results", {})
    acc = results.get("shares_accepted")
    rej = results.get("shares_rejected")

    if isinstance(acc, list) and acc:
        accepted = acc[0]

    if isinstance(rej, list) and rej:
        rejected = rej[0]

    return {
        "status": "ok",
        "algo": algo,
        "uptime_s": uptime_s,
        "total_hs": total_hs,
        "accepted": accepted,
        "rejected": rejected
    }

def collect_lolminer_stats():
    host = os.environ.get("LOLMINER_API_HOST", "127.0.0.1")
    port = int(os.environ.get("LOLMINER_API_PORT", "8020"))
    url = f"http://{host}:{port}/summary"

    try:
        with urllib.request.urlopen(url, timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"status": "offline", "error": str(e)}

    # -------------------------------
    # Uptime
    # -------------------------------
    uptime_s = data.get("Session", {}).get("Uptime")

    algos = data.get("Algorithms", [])
    if not algos:
        return {"status": "ok", "note": "no algorithms"}

    a0 = algos[0]

    # -------------------------------
    # Algorithm
    # -------------------------------
    algo = a0.get("Algorithm")

    # -------------------------------
    # Hashrate (convert to H/s)
    # -------------------------------
    total_perf = a0.get("Total_Performance")
    factor = a0.get("Performance_Factor", 1)

    total_hs = None
    if isinstance(total_perf, (int, float)):
        total_hs = total_perf * factor

    # -------------------------------
    # Shares
    # -------------------------------
    accepted = a0.get("Total_Accepted")
    rejected = a0.get("Total_Rejected")

    return {
        "status": "ok",
        "algo": algo,
        "uptime_s": uptime_s,
        "total_hs": total_hs,
        "accepted": accepted,
        "rejected": rejected
    }



def collect_xmrig_stats():
    host = os.environ.get("XMRIG_HTTP_HOST", "127.0.0.1")
    port = int(os.environ.get("XMRIG_HTTP_PORT", "18080"))
    url = f"http://{host}:{port}/2/summary"

    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"status": "offline", "error": str(e)}

    algo = data.get("algo")
    uptime_s = data.get("uptime")

    hashrate = data.get("hashrate", {})
    total = hashrate.get("total") or [0]
    total_hs = float(total[0]) if total else 0

    shares_good = data.get("results", {}).get("shares_good")
    shares_total = data.get("results", {}).get("shares_total")

    return {
        "status": "ok",
        "algo": algo,
        "uptime_s": uptime_s,
        "total_hs": total_hs,
        "shares_good": shares_good,
        "shares_total": shares_total
    }


def collect_full_stats():
    gpu_present = has_nvidia_gpu()
    return {
        "rig": RIG_NAME,
        "timestamp": int(time.time()),
        "cpu_temp": collect_cpu_temp(),
        "cpu_usage": collect_cpu_usage(),
        "load": collect_load(),
        "memory": collect_memory(),
        "gpu_present": gpu_present,
        "gpus": collect_gpu_stats() if gpu_present else [],
        "miner_rigel": collect_rigel_stats(),
        "miner_bzminer": collect_bzminer_stats(),
        "miner_lolminer": collect_lolminer_stats(),
        "miner_srbminer": collect_srbminer_stats(),
        "miner_wildrig": collect_wildrig_stats(),
        "miner_xmrig": collect_xmrig_stats(),
        "docker": collect_docker_containers(),
        "cpu_service": collect_service_uptime("docker_events_cpu.service"),
        "gpu_service": collect_service_uptime("docker_events_gpu.service"),
    }

EOF
sudo systemctl restart rigcloud-agent
sudo systemctl is-active rigcloud-agent