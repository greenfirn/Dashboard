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

def normalize_to_hs(value, unit=None):
    """Convert any hash rate unit to H/s"""
    if value is None:
        return None
    
    try:
        val = float(value)
        
        if unit is None:
            # Try to guess from magnitude
            if val >= 1e12:
                return val  # Assume already H/s if huge
            elif val >= 1e9:
                return val * 1e9  # GH/s to H/s
            elif val >= 1e6:
                return val * 1e6  # MH/s to H/s
            elif val >= 1e3:
                return val * 1e3  # kH/s to H/s
            else:
                return val  # Assume H/s
        
        unit = unit.lower().strip()
        if unit in ['h/s', 'hs', 'hash', 'hashes']:
            return val
        elif unit in ['kh/s', 'khs', 'kilo']:
            return val * 1e3
        elif unit in ['mh/s', 'mhs', 'mega']:
            return val * 1e6
        elif unit in ['gh/s', 'ghs', 'giga']:
            return val * 1e9
        elif unit in ['th/s', 'ths', 'tera']:
            return val * 1e12
        elif unit in ['ph/s', 'phs', 'peta']:
            return val * 1e15
        else:
            return val  # Default to H/s
    except (ValueError, TypeError):
        return None

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
    algorithms = []
    
    # Collect data per algorithm from each pool
    for pool in pools:
        algo = pool.get("algorithm")
        if not algo:
            continue
            
        pool_url = pool.get("url", "").split("://")[-1].split(":")[0]
        raw_hash = pool.get("hashrate")
        
        # BzMiner reports in H/s directly
        hashrate_hs = float(raw_hash) if raw_hash else None
        
        algo_data = {
            "algorithm": algo,
            "pool": pool_url,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": pool.get("valid_solutions"),
            "rejected_shares": pool.get("rejected_solutions"),
            "workers": pool.get("workers")
        }
        
        algorithms.append(algo_data)

    return {
        "status": "ok",
        "uptime_s": data.get("uptime_s") or (pools[0].get("uptime_s") if pools else None),
        "algorithms": algorithms
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

    # Get algorithms from hashrate
    hr = data.get("hashrate", {})
    pool_hr = data.get("pool_hashrate", {})
    sol = data.get("solution_stat", {})
    pool_data = data.get("pool", {})
    
    algorithms = []
    
    # Collect all unique algorithms
    all_algos = set()
    if isinstance(hr, dict):
        all_algos.update(hr.keys())
    if isinstance(pool_hr, dict):
        all_algos.update(pool_hr.keys())
    if isinstance(sol, dict):
        all_algos.update(sol.keys())
    
    for algo in all_algos:
        algo_sol = sol.get(algo, {}) if isinstance(sol, dict) else {}
        
        # Rigel reports in H/s
        hashrate_hs = hr.get(algo) if isinstance(hr, dict) else None
        
        algo_data = {
            "algorithm": algo,
            "hashrate_hs": hashrate_hs,
            "pool_hashrate_hs": pool_hr.get(algo) if isinstance(pool_hr, dict) else None,
            "accepted_shares": algo_sol.get("accepted") if isinstance(algo_sol, dict) else None,
            "rejected_shares": algo_sol.get("rejected") if isinstance(algo_sol, dict) else None,
            "pool": pool_data.get("url", "").split("://")[-1].split(":")[0] if algo == list(all_algos)[0] else None
        }
        algorithms.append(algo_data)

    return {
        "status": "ok",
        "uptime_s": data.get("uptime"),
        "algorithms": algorithms
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
    algorithms = []
    
    for algo_data in algos:
        name = algo_data.get("name")
        if not name:
            continue
            
        hr = algo_data.get("hashrate", {})
        cpu_block = hr.get("cpu", {}) if isinstance(hr, dict) else {}
        gpu_block = hr.get("gpu", {}) if isinstance(hr, dict) else {}
        
        # SRBMiner reports in H/s
        cpu_hs = cpu_block.get("total")
        gpu_hs = gpu_block.get("total")
        hashrate_hs = (cpu_hs or 0) + (gpu_hs or 0)
        
        shares = algo_data.get("shares", {})
        
        algo_info = {
            "algorithm": name,
            "cpu_hashrate_hs": cpu_hs,
            "gpu_hashrate_hs": gpu_hs,
            "hashrate_hs": hashrate_hs if hashrate_hs > 0 else None,
            "accepted_shares": shares.get("accepted"),
            "rejected_shares": shares.get("rejected"),
            "cpu_workers": data.get("total_cpu_workers"),
            "gpu_workers": data.get("total_gpu_workers")
        }
        algorithms.append(algo_info)

    return {
        "status": "ok",
        "miner": "srbminer",
        "uptime_s": data.get("mining_time") or data.get("uptime") or data.get("uptime_s"),
        "algorithms": algorithms
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

    algo = data.get("algo")
    algorithms = []
    
    if algo:
        hr = data.get("hashrate", {}).get("total")
        # WildRig reports in H/s
        hashrate_hs = hr[0] if isinstance(hr, list) and len(hr) > 0 else None
        
        results = data.get("results", {})
        acc = results.get("shares_accepted")
        rej = results.get("shares_rejected")
        
        accepted = acc[0] if isinstance(acc, list) and acc else None
        rejected = rej[0] if isinstance(rej, list) and rej else None
        
        algo_data = {
            "algorithm": algo,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": accepted,
            "rejected_shares": rejected
        }
        algorithms.append(algo_data)

    return {
        "status": "ok",
        "uptime_s": data.get("uptime"),
        "algorithms": algorithms
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

    algos = data.get("Algorithms", [])
    algorithms = []
    
    for algo_data in algos:
        algo_name = algo_data.get("Algorithm")
        if not algo_name:
            continue
            
        total_perf = algo_data.get("Total_Performance")
        factor = algo_data.get("Performance_Factor", 1)
        
        # lolMiner: Total_Performance is in H/s, multiply by factor
        hashrate_hs = total_perf * factor if isinstance(total_perf, (int, float)) else None
        
        algo_info = {
            "algorithm": algo_name,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": algo_data.get("Total_Accepted"),
            "rejected_shares": algo_data.get("Total_Rejected"),
            "pool": algo_data.get("Pool")
        }
        algorithms.append(algo_info)

    return {
        "status": "ok",
        "uptime_s": data.get("Session", {}).get("Uptime"),
        "algorithms": algorithms
    }

def collect_onezerominer_stats():
    host = os.environ.get("ONEZEROMINER_API_HOST", "127.0.0.1")
    port = int(os.environ.get("ONEZEROMINER_API_PORT", "3001"))
    url = f"http://{host}:{port}"

    try:
        with urllib.request.urlopen(url, timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"status": "offline", "error": str(e)}

    algos = data.get("algos", [])
    algorithms = []
    
    for algo_data in algos:
        name = algo_data.get("name")
        if not name:
            continue
            
        # OneZeroMiner reports in H/s
        hashrate_hs = algo_data.get("total_hashrate")
        
        algo_info = {
            "algorithm": name,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": algo_data.get("total_accepted_shares"),
            "rejected_shares": algo_data.get("total_rejected_shares"),
            "pool": algo_data.get("pool")
        }
        algorithms.append(algo_info)

    return {
        "status": "ok",
        "uptime_s": data.get("uptime_seconds"),
        "algorithms": algorithms
    }

def collect_gminer_stats():
    host = os.environ.get("GMINER_API_HOST", "127.0.0.1")
    port = int(os.environ.get("GMINER_API_PORT", "10050"))
    url = f"http://{host}:{port}/stat"

    try:
        with urllib.request.urlopen(url, timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"status": "offline", "error": str(e)}

    algo = data.get("algorithm")
    algorithms = []
    
    if algo:
        total_hs = 0
        devices = data.get("devices", [])

        if isinstance(devices, list):
            for d in devices:
                speed = d.get("speed")
                if isinstance(speed, (int, float)):
                    total_hs += speed
        
        # GMiner reports in H/s
        hashrate_hs = total_hs if total_hs > 0 else None
        
        algo_data = {
            "algorithm": algo,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": data.get("total_accepted_shares"),
            "rejected_shares": data.get("total_rejected_shares"),
            "pool": data.get("pool")
        }
        algorithms.append(algo_data)

    return {
        "status": "ok",
        "uptime_s": data.get("uptime"),
        "algorithms": algorithms
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
    algorithms = []
    
    if algo:
        hashrate = data.get("hashrate", {})
        total = hashrate.get("total") or [0]
        # XMRig reports in H/s
        hashrate_hs = float(total[0]) if total else 0

        shares_good = data.get("results", {}).get("shares_good")
        shares_total = data.get("results", {}).get("shares_total")
        
        rejected_shares = None
        if shares_total is not None and shares_good is not None:
            rejected_shares = shares_total - shares_good
        
        connection = data.get("connection", {})
        pool_url = connection.get("url", "").split("://")[-1].split(":")[0] if connection else None

        algo_data = {
            "algorithm": algo,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": shares_good,
            "rejected_shares": rejected_shares,
            "pool": pool_url
        }
        algorithms.append(algo_data)

    return {
        "status": "ok",
        "uptime_s": data.get("uptime"),
        "algorithms": algorithms
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
        "miner_onezerominer": collect_onezerominer_stats(),
        "miner_gminer": collect_gminer_stats(),
        "miner_xmrig": collect_xmrig_stats(),
        "docker": collect_docker_containers(),
        "cpu_service": collect_service_uptime("docker_events_cpu.service"),
        "gpu_service": collect_service_uptime("docker_events_gpu.service"),
    }

EOF
sudo systemctl restart rigcloud-agent
sudo systemctl is-active rigcloud-agent