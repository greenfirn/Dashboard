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

def collect_gpu_stats():
    """Collect detailed GPU statistics including driver info"""
    cmd = (
        "nvidia-smi --query-gpu=index,uuid,temperature.gpu,"
        "utilization.gpu,utilization.memory,power.draw,"
        "clocks.sm,clocks.mem,fan.speed,"
        "memory.total,memory.used,driver_version,"
        "name,pci.bus_id --format=csv,noheader,nounits"
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
        if len(fields) < 13:  # Adjust for driver_version and name fields
            continue

        try:
            (
                idx, uuid, temp, util, memutil, watts,
                smclk, memclk, fan, memtotal, memused,
                driver_version, name
            ) = fields[:13]
            
            # Get PCI bus ID if available
            pci_bus = fields[13] if len(fields) > 13 else ""
            
            gpus.append({
                "index": int(idx),
                "uuid": uuid,
                "name": name,
                "temp": int(temp),
                "util": int(util),
                "mem_util": int(memutil),
                "power_watts": float(watts),
                "fan_percent": int(fan),
                "sm_clock": int(smclk),
                "mem_clock": int(memclk),
                "vram_used": int(memused),
                "vram_total": int(memtotal),
                "driver_version": driver_version,
                "pci_bus_id": pci_bus
            })
        except ValueError as e:
            continue

    return gpus

def has_nvidia_gpu():
    """Check if NVIDIA GPU is present and driver is loaded"""
    try:
        rc = subprocess.run(
            ["nvidia-smi", "-L"],
            capture_output=True,
            text=True,
            timeout=2.0
        )
        if rc.returncode == 0 and "GPU" in rc.stdout:
            return True
    except Exception:
        pass
    
    # Alternative check via lspci
    try:
        rc = subprocess.run(
            ["lspci", "|", "grep", "-i", "nvidia"],
            shell=True,
            capture_output=True,
            text=True,
            timeout=1.0
        )
        if rc.returncode == 0 and "NVIDIA" in rc.stdout.upper():
            return True
    except Exception:
        pass
    
    return False

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
    
    # Get the method to ensure it's fullstatus
    method = data.get("method", "")
    if method != "fullstatus":
        # Try to get basic status if available
        return {"status": "unexpected_format", "data": data}
    
    pools = data.get("pools") or []
    devices = data.get("devices") or []
    
    algorithms = []
    
    # Process each pool
    for pool in pools:
        pool_id = pool.get("id", -1)
        
        # Find algorithm name for this pool
        pool_algo = pool.get("algorithm", "unknown")
        
        # Get pool URL
        pool_url = ""
        current_url = pool.get("current_url", "")
        if current_url:
            # Extract host from URL
            url_parts = current_url.split("://")
            if len(url_parts) > 1:
                host_part = url_parts[1].split(":")[0]
                pool_url = host_part.split(".")[-2] if "." in host_part else host_part
        
        # Calculate total hashrate for this pool from all devices
        total_hashrate = 0
        
        for device in devices:
            device_pools = device.get("pool", [])
            device_hr = device.get("hashrate", [])
            
            if isinstance(device_pools, list) and isinstance(device_hr, list):
                # Find if this device mines on this pool
                for i, p_id in enumerate(device_pools):
                    if p_id == pool_id and i < len(device_hr):
                        total_hashrate += device_hr[i]
        
        # Only include active pools (with hashrate > 0)
        if total_hashrate > 0 or pool.get("status", 0) > 0:
            algo_data = {
                "algorithm": pool_algo,
                "pool": pool_url,
                "hashrate_hs": total_hashrate if total_hashrate > 0 else None,
                "accepted_shares": pool.get("valid_solutions"),
                "rejected_shares": pool.get("rejected_solutions"),
                "stale_shares": pool.get("stale_solutions"),
                "workers": None
            }
            algorithms.append(algo_data)
    
    return {
        "status": "ok",
        "miner": "bzminer",
        "miner_version": data.get("bzminer_version"),
        "rig_name": data.get("rig_name"),
        "uptime_s": data.get("uptime_s"),
        "total_devices": len(devices),
        "cuda_driver_version": data.get("cuda_driver_version"),
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
        "miner": "rigel",
        "miner_version": data.get("version"),
        "cuda_driver": data.get("cuda_driver"),
        "uptime_s": data.get("uptime"),
        "algorithms": algorithms
    }

def collect_srbminer_stats():
    host = os.environ.get("SRB_API_HOST", "127.0.0.1")
    main_port = int(os.environ.get("SRB_API_PORT", "21550"))
    cpu_port = 21551
    
    # Check main port (21550)
    main_data = {}
    main_status = "offline"
    try:
        main_url = f"http://{host}:{main_port}"
        with urllib.request.urlopen(main_url, timeout=1.0) as resp:
            main_data = json.loads(resp.read().decode("utf-8"))
        main_status = "ok"
    except Exception as e:
        main_data = {}
        main_status = "offline"
    
    # Check CPU port (21551) for separate instance
    cpu_data = {}
    cpu_status = "offline"
    try:
        cpu_url = f"http://{host}:{cpu_port}"
        with urllib.request.urlopen(cpu_url, timeout=1.0) as resp:
            cpu_data = json.loads(resp.read().decode("utf-8"))
        cpu_status = "ok"
    except Exception:
        # CPU port not active, that's okay
        pass
    
    # If both are offline, return error
    if main_status == "offline" and cpu_status == "offline":
        return {
            "status": "offline",
            "error": "Both main and CPU ports unavailable"
        }
    
    algorithms = []
    
    # Process GPU mining from main port
    if main_status == "ok":
        main_algos = main_data.get("algorithms", [])
        for algo_data in main_algos:
            name = algo_data.get("name")
            if not name:
                continue
                
            hr = algo_data.get("hashrate", {})
            gpu_block = hr.get("gpu", {}) if isinstance(hr, dict) else {}
            gpu_hs = gpu_block.get("total")
            
            # If there's GPU hashrate, add as GPU entry
            if gpu_hs and gpu_hs > 0:
                shares = algo_data.get("shares", {})
                
                algo_info = {
                    "algorithm": name,
                    "cpu_hashrate_hs": 0,
                    "gpu_hashrate_hs": gpu_hs,
                    "hashrate_hs": gpu_hs,
                    "accepted_shares": shares.get("accepted"),
                    "rejected_shares": shares.get("rejected"),
                    "cpu_workers": 0,
                    "gpu_workers": main_data.get("total_gpu_workers"),
                    "thread_hashrates": None,  # No thread data for GPU
                    "mining_type": "GPU"
                }
                algorithms.append(algo_info)
    
    # Process CPU mining from main port
    if main_status == "ok":
        main_algos = main_data.get("algorithms", [])
        for algo_data in main_algos:
            name = algo_data.get("name")
            if not name:
                continue
                
            hr = algo_data.get("hashrate", {})
            cpu_block = hr.get("cpu", {}) if isinstance(hr, dict) else {}
            cpu_hs = cpu_block.get("total")
            
            # If there's CPU hashrate, add as CPU entry
            if cpu_hs and cpu_hs > 0:
                # Collect per-thread hashrates
                thread_hashrates = {}
                if isinstance(cpu_block, dict):
                    for key, value in cpu_block.items():
                        if key.startswith("thread") and isinstance(value, (int, float)):
                            thread_hashrates[key] = value
                
                shares = algo_data.get("shares", {})
                
                algo_info = {
                    "algorithm": name,
                    "cpu_hashrate_hs": cpu_hs,
                    "gpu_hashrate_hs": 0,
                    "hashrate_hs": cpu_hs,
                    "accepted_shares": shares.get("accepted"),
                    "rejected_shares": shares.get("rejected"),
                    "cpu_workers": main_data.get("total_cpu_workers"),
                    "gpu_workers": 0,
                    "thread_hashrates": thread_hashrates if thread_hashrates else None,
                    "mining_type": "CPU"
                }
                algorithms.append(algo_info)
    
    # Process separate CPU port data
    if cpu_status == "ok":
        cpu_algos = cpu_data.get("algorithms", [])
        for algo_data in cpu_algos:
            name = algo_data.get("name")
            if not name:
                continue
                
            hr = algo_data.get("hashrate", {})
            cpu_block = hr.get("cpu", {}) if isinstance(hr, dict) else {}
            cpu_hs = cpu_block.get("total")
            
            # If there's CPU hashrate, add as CPU entry
            if cpu_hs and cpu_hs > 0:
                # Collect per-thread hashrates
                thread_hashrates = {}
                if isinstance(cpu_block, dict):
                    for key, value in cpu_block.items():
                        if key.startswith("thread") and isinstance(value, (int, float)):
                            thread_hashrates[key] = value
                
                shares = algo_data.get("shares", {})
                
                algo_info = {
                    "algorithm": name,
                    "cpu_hashrate_hs": cpu_hs,
                    "gpu_hashrate_hs": 0,
                    "hashrate_hs": cpu_hs,
                    "accepted_shares": shares.get("accepted"),
                    "rejected_shares": shares.get("rejected"),
                    "cpu_workers": cpu_data.get("total_cpu_workers"),
                    "gpu_workers": 0,
                    "thread_hashrates": thread_hashrates if thread_hashrates else None,
                    "mining_type": "CPU",
                    "source_port": "21551"  # Mark as from separate CPU port
                }
                algorithms.append(algo_info)
    
    # Determine overall status
    overall_status = "ok" if algorithms else "offline"
    
    # Use main data for version/uptime, fallback to CPU data
    source_data = main_data if main_status == "ok" else cpu_data
    
    return {
        "status": overall_status,
        "miner": "srbminer",
        "miner_version": source_data.get("miner_version"),
        "cpu_port_active": cpu_status == "ok",
        "gpu_port_active": main_status == "ok",
        "uptime_s": source_data.get("mining_time") or source_data.get("uptime") or source_data.get("uptime_s"),
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
        hr = data.get("hashrate", {})
        total_hr = hr.get("total")
        threads_hr = hr.get("threads")
        
        # WildRig reports in H/s
        hashrate_hs = total_hr[0] if isinstance(total_hr, list) and len(total_hr) > 0 else None
        
        # Collect per-thread hashrates
        thread_hashrates = {}
        if isinstance(threads_hr, list):
            for i, thread_hr in enumerate(threads_hr):
                if isinstance(thread_hr, list) and len(thread_hr) > 0:
                    thread_hashrates[f"thread_{i}"] = thread_hr[0]
        
        results = data.get("results", {})
        acc = results.get("shares_accepted")
        rej = results.get("shares_rejected")
        
        accepted = acc[0] if isinstance(acc, list) and acc else None
        rejected = rej[0] if isinstance(rej, list) and rej else None
        
        algo_data = {
            "algorithm": algo,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": accepted,
            "rejected_shares": rejected,
            "thread_hashrates": thread_hashrates if thread_hashrates else None
        }
        algorithms.append(algo_data)

    return {
        "status": "ok",
        "miner": "wildrig",
        "miner_version": data.get("version"),
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
        
        # Get per-worker performance for thread breakdown
        worker_perf = algo_data.get("Worker_Performance", [])
        thread_hashrates = {}
        if isinstance(worker_perf, list):
            for i, perf in enumerate(worker_perf):
                if isinstance(perf, (int, float)):
                    thread_hashrates[f"worker_{i}"] = perf * factor
        
        algo_info = {
            "algorithm": algo_name,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": algo_data.get("Total_Accepted"),
            "rejected_shares": algo_data.get("Total_Rejected"),
            "pool": algo_data.get("Pool"),
            "thread_hashrates": thread_hashrates if thread_hashrates else None
        }
        algorithms.append(algo_info)

    return {
        "status": "ok",
        "miner": "lolminer",
        "miner_version": data.get("Software"),
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
        
        # Get per-device hashrates
        device_hr = algo_data.get("hashrates", [])
        thread_hashrates = {}
        if isinstance(device_hr, list):
            for i, hr_value in enumerate(device_hr):
                if isinstance(hr_value, (int, float)):
                    thread_hashrates[f"device_{i}"] = hr_value
        
        algo_info = {
            "algorithm": name,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": algo_data.get("total_accepted_shares"),
            "rejected_shares": algo_data.get("total_rejected_shares"),
            "pool": algo_data.get("pool"),
            "thread_hashrates": thread_hashrates if thread_hashrates else None
        }
        algorithms.append(algo_info)

    return {
        "status": "ok",
        "miner": "onezerominer",
        "miner_version": data.get("version"),
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
        
        # Collect per-device hashrates
        thread_hashrates = {}
        
        if isinstance(devices, list):
            for i, d in enumerate(devices):
                speed = d.get("speed")
                if isinstance(speed, (int, float)):
                    total_hs += speed
                    thread_hashrates[f"gpu_{i}"] = speed
        
        # GMiner reports in H/s
        hashrate_hs = total_hs if total_hs > 0 else None
        
        algo_data = {
            "algorithm": algo,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": data.get("total_accepted_shares"),
            "rejected_shares": data.get("total_rejected_shares"),
            "pool": data.get("pool"),
            "thread_hashrates": thread_hashrates if thread_hashrates else None
        }
        algorithms.append(algo_data)

    return {
        "status": "ok",
        "miner": "gminer",
        "miner_version": data.get("miner"),
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

        # XMRig doesn't provide per-thread hashrate in the API
        # but we can include CPU info
        cpu_info = data.get("cpu", {})
        threads = cpu_info.get("threads", 0)
        
        algo_data = {
            "algorithm": algo,
            "hashrate_hs": hashrate_hs,
            "accepted_shares": shares_good,
            "rejected_shares": rejected_shares,
            "pool": pool_url,
            "cpu_threads": threads
        }
        algorithms.append(algo_data)

    return {
        "status": "ok",
        "miner": "xmrig",
        "miner_version": data.get("version"),
        "uptime_s": data.get("uptime"),
        "algorithms": algorithms
    }

def collect_full_stats():
    gpu_present = has_nvidia_gpu()

    stats = {
        "rig": RIG_NAME,
        "timestamp": int(time.time()),
        "cpu_temp": collect_cpu_temp(),
        "cpu_usage": collect_cpu_usage(),
        "load": collect_load(),
        "memory": collect_memory(),
        "gpu_present": gpu_present,
        "gpus": collect_gpu_stats() if gpu_present else [],
    }
    
    # Add miner stats
    stats.update({
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
    })
    
    return stats
EOF
sudo systemctl restart rigcloud-agent
sudo systemctl is-active rigcloud-agent