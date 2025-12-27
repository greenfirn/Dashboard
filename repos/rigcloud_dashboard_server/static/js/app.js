let rigsState = {};
let popoverState = {};
let lastUpdateTs = 0;
let resetInProgress = false;
let selectedRigs = new Set();
let currentActionMode = localStorage.getItem("actionMode") || "all";
let isSavingFlightsheet = false;

let flightsheets = [];
let selectedFlightsheetId = null;

let hiddenColumns = new Set(); // Tracks hidden column indices


let API = "";

// Determine base path (e.g. "", "/dashboard")
const BASE_PATH = location.pathname.replace(/\/$/, "");


// =====================================================
// INITIALIZATION & EVENT LISTENERS
// =====================================================

async function loadConfig() {
    const res = await fetch(`${BASE_PATH}/api/config`);
    if (!res.ok) {
        throw new Error("Failed to load app config");
    }

    const cfg = await res.json();
    API = cfg.basePath || "";
}

document.addEventListener("DOMContentLoaded", async () => {
    
    // Add click handlers for mode buttons
    document.querySelectorAll(".action-tab").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const mode = e.target.dataset.mode;
            if (mode) setActionMode(mode);
        });
    });

    // Add header click functionality
    setupHeaderClickHandlers();

    // Load saved hidden columns state
    loadColumnState();

    // Apply hidden state to existing DOM
    applyHiddenColumnsToDOM();
    
    // Toggle select all
    document.getElementById("btn-toggle-select")?.addEventListener("click", toggleSelectAll);

    // Open command modal
    document.getElementById("btn-send-cmd")?.addEventListener("click", openCmdModal);

    // Open flightsheets modal
    document.getElementById("btn-flightsheets")?.addEventListener("click", openFlightsheetsModal);

    // Action buttons
    document.getElementById("btn-action-start")?.addEventListener("click", actionStart);
    document.getElementById("btn-action-stop")?.addEventListener("click", actionStop);
    document.getElementById("btn-action-restart")?.addEventListener("click", actionRestart);

    // Command modal buttons
    document.getElementById("btn-cmd-send")?.addEventListener("click", submitCmd);
    document.getElementById("btn-cmd-cancel")?.addEventListener("click", closeCmdModal);
	document.getElementById('btn-cmd-clear').addEventListener('click', function() {
        document.getElementById('cmd-input').value = '';
        document.getElementById('cmd-output').textContent = '';
    });

    // Flightsheets modal buttons
    document.getElementById('btn-clear-fs').addEventListener('click', function() {
		document.getElementById("fs-raw").value = '';
            // Reset any active states
        document.querySelectorAll('.selected').forEach(item => {
            item.classList.remove('active');
			item.classList.remove('selected');
			item.removeAttribute('aria-selected');
        });
		document.getElementById("fs-name").value = '';
    });

	document.getElementById("btn-new-fs")?.addEventListener("click", newFlightsheet);
	document.getElementById("btn-save-fs")?.addEventListener("click", saveFlightsheetFromDialog);
    document.getElementById("btn-apply-fs")?.addEventListener("click", applyFlightsheet);
    document.getElementById("btn-delete-fs")?.addEventListener("click", deleteFlightsheet);
    document.getElementById("btn-close-fs")?.addEventListener("click", closeFlightsheetsModal);

    // Reset button
    document.getElementById("btn-reset")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hardReset(ev);
    });

    // Modal close on backdrop click
    //document.getElementById("cmd-modal")?.addEventListener("click", (e) => {
    //    if (e.target.id === "cmd-modal") closeCmdModal();
    //});

    //document.getElementById("fs-modal")?.addEventListener("click", (e) => {
    //    if (e.target.id === "fs-modal") closeFlightsheetsModal();
    //});

    // Escape key to close modals
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeCmdModal();
            closeFlightsheetsModal();
        }
    });

    // Expand / collapse action status box
    const actionBox = document.getElementById("action-output");
    if (actionBox) {
        actionBox.addEventListener("focus", () => {
            actionBox.classList.remove("collapsed");
            actionBox.classList.add("expanded");
        });

        actionBox.addEventListener("blur", () => {
            actionBox.classList.remove("expanded");
            actionBox.classList.add("collapsed");
        });
    }

    // 👇 restore last mode
    setActionMode(currentActionMode);

    // ✅ MUST be async
    await loadConfig();

    // Now API is guaranteed to be set
    initWebSocket();
    //fetchRigsOnce();
});
// =====================================================
// COMPREHENSIVE DATA ACCESS HELPER
// =====================================================

const DataHelper = {
    // ================= SYSTEM DATA =================
    
    // Get CPU temperature
    getCpuTemp: (data) => {
        return data.cpu_temp !== null ? Number(data.cpu_temp) : null;
    },
    
    // Get CPU usage percentage
    getCpuUsage: (data) => {
        return data.cpu_usage !== undefined ? data.cpu_usage : "--";
    },
    
    // Get load averages
    getLoad: (data, interval = "1m") => {
        return data.load?.[interval] ?? "--";
    },
    
    // Get memory usage
    getMemory: (data) => {
        if (data.memory?.total_mb && data.memory.used_mb !== undefined) {
            return {
                used_gb: (data.memory.used_mb / 1024).toFixed(1),
                total_gb: (data.memory.total_mb / 1024).toFixed(1),
                string: `${(data.memory.used_mb / 1024).toFixed(1)} / ${(data.memory.total_mb / 1024).toFixed(1)}`
            };
        }
        return { used_gb: "--", total_gb: "--", string: "--" };
    },
    
    // ================= GPU DATA =================
    
    // Get all GPUs
    getGpus: (data) => {
        return Array.isArray(data.gpus) ? data.gpus : [];
    },
    
    // Get primary/first GPU
    getPrimaryGpu: (data) => {
        const gpus = DataHelper.getGpus(data);
        return gpus[0] || {};
    },
    
    // Get GPU temperature
    getGpuTemp: (gpu) => {
        return gpu.temp !== undefined ? Number(gpu.temp) : null;
    },
    
    // Get GPU utilization
    getGpuUtil: (gpu) => {
        return gpu.util ?? "--";
    },
    
    // Get GPU power
    getGpuPower: (gpu) => {
        return gpu.power_watts !== undefined ? gpu.power_watts.toFixed(1) : "--";
    },
    
    // Get GPU fan speed
    getGpuFan: (gpu) => {
        return gpu.fan_percent ?? "--";
    },
    
    // Get GPU core clock
    getGpuCoreClock: (gpu) => {
        return gpu.sm_clock ?? "--";
    },
    
    // Get GPU memory clock
    getGpuMemClock: (gpu) => {
        return gpu.mem_clock ?? "--";
    },
    
    // Get GPU VRAM
    getGpuVram: (gpu) => {
        if (gpu.vram_used !== undefined && gpu.vram_total !== undefined) {
            return {
                used_gb: (gpu.vram_used / 1024).toFixed(1),
                total_gb: (gpu.vram_total / 1024).toFixed(1),
                string: `${(gpu.vram_used / 1024).toFixed(1)} / ${(gpu.vram_total / 1024).toFixed(1)}`
            };
        }
        return { used_gb: "--", total_gb: "--", string: "--" };
    },
    
    // Get GPU driver version
    getGpuDriverVersion: (gpu) => {
        return gpu.driver_version || "--";
    },
    
    // Get NVIDIA driver version from first GPU
    getNvidiaDriverVersion: (data) => {
        const gpus = DataHelper.getGpus(data);
        if (gpus.length > 0 && gpus[0].driver_version) {
            return gpus[0].driver_version;
        }
        return "--";
    },
    
    // Get GPU name
    getGpuName: (gpu) => {
        return gpu.name || "Unknown GPU";
    },
    
    // Get total GPU power consumption
    getTotalGpuPower: (data) => {
        const gpus = DataHelper.getGpus(data);
        return gpus.reduce((total, gpu) => {
            return total + (typeof gpu.power_watts === "number" ? gpu.power_watts : 0);
        }, 0);
    },
    
    // ================= SERVICE DATA =================
    
    // Get service status
    getServiceStatus: (data, service) => {
        const serviceData = data[service];
        return {
            state: serviceData?.state || "unknown",
            isActive: serviceData?.state === "active",
            uptime: serviceData?.uptime || 0
        };
    },
    
    // ================= DOCKER DATA =================
    
    // Get docker containers
    getDockerContainers: (data) => {
        return Array.isArray(data.docker) ? data.docker : [];
    },
    
    // ================= MINER DATA =================
    
    // Miner key to display name mapping
    MINER_NAMES: {
        "miner_bzminer": "BzMiner",
        "miner_xmrig": "XMRig", 
        "miner_rigel": "Rigel",
        "miner_lolminer": "lolMiner",
        "miner_srbminer": "SRBMiner",
        "miner_wildrig": "WildRig",
        "miner_onezerominer": "OneZeroMiner",
        "miner_gminer": "GMiner"
    },
    
    // All miner keys
    ALL_MINER_KEYS: [
        "miner_bzminer", "miner_xmrig", "miner_rigel", 
        "miner_lolminer", "miner_srbminer", "miner_wildrig",
        "miner_onezerominer", "miner_gminer"
    ],
    
    // Get miner display name
    getMinerDisplayName: (minerKey) => {
        return DataHelper.MINER_NAMES[minerKey] || minerKey;
    },
    
    // Get miner data
    getMiner: (data, minerKey) => {
        return data[minerKey] || null;
    },
    
    // Check if miner is active
    isMinerActive: (data, minerKey) => {
        const miner = DataHelper.getMiner(data, minerKey);
        return miner && miner.status === "ok" && miner.algorithms && miner.algorithms.length > 0;
    },
    
    // Get all active miners
    getActiveMiners: (data) => {
        return DataHelper.ALL_MINER_KEYS
            .filter(key => DataHelper.isMinerActive(data, key))
            .map(key => ({
                key: key,
                name: DataHelper.getMinerDisplayName(key),
                data: DataHelper.getMiner(data, key)
            }));
    },
    
    // Get miner algorithms
    getMinerAlgorithms: (data, minerKey) => {
        const miner = DataHelper.getMiner(data, minerKey);
        if (!miner || miner.status !== "ok") return [];
        return miner.algorithms || [];
    },
    
    // Get all algorithms from all miners
    getAllAlgorithms: (data) => {
        const algorithms = [];
        const activeMiners = DataHelper.getActiveMiners(data);
        activeMiners.forEach(miner => {
            if (miner.data.algorithms) {
                miner.data.algorithms.forEach(algo => {
                    algorithms.push({
                        ...algo,
                        minerKey: miner.key,
                        minerName: miner.name,
                        minerUptime: miner.data.uptime_s,
                        minerVersion: miner.data.miner_version,
                        cudaDriver: miner.data.cuda_driver || miner.data.cuda_driver_version
                    });
                });
            }
        });
        return algorithms;
    },
    
    // ================= ALGORITHM DATA =================
    
    // Get algorithm name
    getAlgorithmName: (algo) => {
        return algo.algorithm || "--";
    },
    
    // Get hashrate in H/s
    getHashrateHS: (algo) => {
        return algo.hashrate_hs || 0;
    },
    
    // Get CPU hashrate (for SRBMiner)
    getCpuHashrateHS: (algo) => {
        return algo.cpu_hashrate_hs || 0;
    },
    
    // Get GPU hashrate (for SRBMiner)
    getGpuHashrateHS: (algo) => {
        return algo.gpu_hashrate_hs || 0;
    },
    
    // Get total hashrate (CPU + GPU for SRBMiner)
    getTotalHashrateHS: (algo) => {
        const baseHashrate = DataHelper.getHashrateHS(algo);
        if (baseHashrate > 0) return baseHashrate;
        
        // Fallback: sum CPU and GPU for SRBMiner
        const cpuHashrate = DataHelper.getCpuHashrateHS(algo);
        const gpuHashrate = DataHelper.getGpuHashrateHS(algo);
        return cpuHashrate + gpuHashrate;
    },
    
    // Get accepted shares
    getAcceptedShares: (algo) => {
        return algo.accepted_shares;
    },
    
    // Get rejected shares
    getRejectedShares: (algo) => {
        return algo.rejected_shares;
    },
    
    // Get pool
    getPool: (algo) => {
        return algo.pool || "";
    },
    
    // Get workers
    getWorkers: (algo) => {
        return algo.workers;
    },
    
    // Get CPU workers (SRBMiner)
    getCpuWorkers: (algo) => {
        return algo.cpu_workers;
    },
    
    // Get GPU workers (SRBMiner)
    getGpuWorkers: (algo) => {
        return algo.gpu_workers;
    },
    
    // Get pool hashrate (Rigel)
    getPoolHashrateHS: (algo) => {
        return algo.pool_hashrate_hs || 0;
    },
    
    // Get CPU threads (XMRig)
    getCpuThreads: (algo) => {
        return algo.cpu_threads || 0;
    },
    
    // Get per-thread hashrates
    getThreadHashrates: (algo) => {
        return algo.thread_hashrates || {};
    },
    
    // ================= MINER VERSION AND DRIVER INFO =================
    
    // Get miner version
    getMinerVersion: (minerData) => {
        return minerData?.miner_version || "--";
    },
    
    // Get miner version for a specific miner key
    getMinerVersionByKey: (data, minerKey) => {
        const miner = DataHelper.getMiner(data, minerKey);
        return DataHelper.getMinerVersion(miner);
    },
    
    // Get CUDA driver version
    getCudaDriverVersion: (minerData) => {
        return minerData?.cuda_driver_version || minerData?.cuda_driver || "--";
    },
    
    // Get rig name (BzMiner)
    getMinerRigName: (minerData) => {
        return minerData?.rig_name || "--";
    },
    
    // Get total devices (BzMiner)
    getMinerTotalDevices: (minerData) => {
        return minerData?.total_devices || 0;
    },
    
    // ================= STATISTICS =================
    
    // Get total hashrate for all miners
    getTotalHashrateAllMiners: (data) => {
        return DataHelper.getAllAlgorithms(data).reduce((total, algo) => {
            return total + DataHelper.getTotalHashrateHS(algo);
        }, 0);
    },
    
    // Get hashrate by algorithm
    getHashrateByAlgorithm: (data) => {
        const algoMap = {};
        DataHelper.getAllAlgorithms(data).forEach(algo => {
            const algoName = DataHelper.getAlgorithmName(algo);
            const hashrate = DataHelper.getTotalHashrateHS(algo);
            
            if (!algoMap[algoName]) {
                algoMap[algoName] = {
                    totalHashrate: 0,
                    miners: [],
                    perThreadData: []
                };
            }
            
            algoMap[algoName].totalHashrate += hashrate;
            
            // Add miner details with version
            const minerName = algo.minerName;
            const minerVersion = algo.minerVersion || "--";
            
            // For SRBMiner, break down CPU/GPU
            if (algo.minerKey === "miner_srbminer") {
                const cpuHashrate = DataHelper.getCpuHashrateHS(algo);
                const gpuHashrate = DataHelper.getGpuHashrateHS(algo);
                
                if (cpuHashrate > 0) {
                    algoMap[algoName].miners.push(`CPU ${fmtRateHs(cpuHashrate, "")} ${minerName} v${minerVersion}`);
                    
                    // Add per-thread data for CPU
                    const threadHashrates = DataHelper.getThreadHashrates(algo);
                    Object.entries(threadHashrates).forEach(([threadName, threadRate]) => {
                        algoMap[algoName].perThreadData.push({
                            thread: threadName,
                            hashrate: threadRate,
                            type: "CPU",
                            miner: minerName
                        });
                    });
                }
                if (gpuHashrate > 0) {
                    algoMap[algoName].miners.push(`GPU ${fmtRateHs(gpuHashrate, "")} ${minerName} v${minerVersion}`);
                }
            } else {
                const displayText = `${fmtRateHs(hashrate, "")} ${minerName} v${minerVersion}`;
                algoMap[algoName].miners.push(displayText);
                
                // Add per-thread data if available
                const threadHashrates = DataHelper.getThreadHashrates(algo);
                Object.entries(threadHashrates).forEach(([threadName, threadRate]) => {
                    algoMap[algoName].perThreadData.push({
                        thread: threadName,
                        hashrate: threadRate,
                        type: algo.minerKey === "miner_xmrig" ? "CPU" : "GPU",
                        miner: minerName
                    });
                });
            }
        });
        
        return algoMap;
    },

    // Get miner summary with versions
    getMinerSummary: (data) => {
        const summary = [];
        DataHelper.getActiveMiners(data).forEach(miner => {
            const minerData = miner.data;
            const algorithms = DataHelper.getMinerAlgorithms(data, miner.key);
            
            algorithms.forEach(algo => {
                const totalHashrate = DataHelper.getTotalHashrateHS(algo);
                const pool = DataHelper.getPool(algo);
                const accepted = DataHelper.getAcceptedShares(algo) || 0;
                const rejected = DataHelper.getRejectedShares(algo) || 0;
                
                summary.push({
                    miner: miner.name,
                    version: DataHelper.getMinerVersion(minerData),
                    algorithm: DataHelper.getAlgorithmName(algo),
                    hashrate: totalHashrate,
                    pool: pool,
                    accepted: accepted,
                    rejected: rejected,
                    uptime: minerData.uptime_s || 0,
                    threadCount: DataHelper.getCpuThreads(algo) || Object.keys(DataHelper.getThreadHashrates(algo)).length,
                    cudaDriver: DataHelper.getCudaDriverVersion(minerData)
                });
            });
        });
        return summary;
    },
    
    // ================= THREAD ANALYSIS =================
    
    // Get CPU thread analysis (for CPU miners)
    getCpuThreadAnalysis: (data) => {
        const analysis = [];
        const algorithms = DataHelper.getAllAlgorithms(data);
        
        algorithms.forEach(algo => {
            const threadHashrates = DataHelper.getThreadHashrates(algo);
            if (Object.keys(threadHashrates).length > 0) {
                Object.entries(threadHashrates).forEach(([threadName, threadRate]) => {
                    analysis.push({
                        algorithm: DataHelper.getAlgorithmName(algo),
                        miner: algo.minerName,
                        thread: threadName,
                        hashrate: threadRate,
                        formatted: fmtRateHs(threadRate, "")
                    });
                });
            } else if (DataHelper.getCpuThreads(algo) > 0) {
                // For XMRig which gives thread count but not per-thread rates
                analysis.push({
                    algorithm: DataHelper.getAlgorithmName(algo),
                    miner: algo.minerName,
                    thread: `${DataHelper.getCpuThreads(algo)} threads`,
                    hashrate: DataHelper.getTotalHashrateHS(algo),
                    formatted: fmtRateHs(DataHelper.getTotalHashrateHS(algo), "")
                });
            }
        });
        
        return analysis;
    },
    
    // Get per-thread statistics
    getThreadStatistics: (data) => {
        const threadData = DataHelper.getCpuThreadAnalysis(data);
        if (threadData.length === 0) return null;
        
        const rates = threadData.map(t => t.hashrate);
        const total = rates.reduce((sum, rate) => sum + rate, 0);
        const avg = total / rates.length;
        
        return {
            totalThreads: threadData.length,
            totalHashrate: total,
            avgPerThread: avg,
            minPerThread: Math.min(...rates),
            maxPerThread: Math.max(...rates)
        };
    },
    
    // ================= FORMATTING HELPERS =================
    
    // Get formatted temperature with CSS class
    getFormattedTemp: (temp, type = "cpu") => {
        if (temp === null || temp === undefined) return { value: "--", class: "status-good" };
        
        const value = temp.toFixed(0);
        let className = "status-good";
        
        if (type === "cpu" || type === "gpu") {
            if (temp >= 75) className = "status-hot";
            else if (temp >= 60) className = "status-warm";
        }
        
        return { value, class: className };
    },
    
    // Get formatted fan speed with CSS class
    getFormattedFan: (fanPercent) => {
        if (fanPercent === "--" || fanPercent === undefined) {
            return { value: "--", class: "status-good" };
        }
        
        let className = "status-good";
        if (fanPercent >= 80) className = "status-hot";
        else if (fanPercent >= 50) className = "status-warm";
        
        return { value: fanPercent, class: className };
    },
    
    // Get service status with CSS class
    getFormattedService: (serviceStatus, serviceType = "cpu") => {
        return {
            text: serviceType.toUpperCase(), // "CPU" or "GPU"
            class: serviceStatus.isActive ? "service-ok" : "service-bad"
        };
    },
    
    // Get formatted miner version
    getFormattedVersion: (version) => {
        if (!version || version === "--") return "Unknown";
        
        // Extract version number
        const match = version.match(/(\d+\.\d+(\.\d+)*)/);
        if (match) {
            return `v${match[1]}`;
        }
        
        return version;
    },
    
    // Get formatted driver version
    getFormattedDriver: (driverVersion) => {
        if (!driverVersion || driverVersion === "--") return "Unknown";
        
        // Convert to string if it's not already
        const driverStr = String(driverVersion);
        
        // Clean up driver version
        let clean = driverStr.replace(/\.0$/, '');
        
        // Check if it's a CUDA driver format
        if (/^\d+\.\d+$/.test(clean)) {
            return `CUDA ${clean}`;
        }
        
        return clean;
    }
};

// =====================================================
// ADD CIRCULAR DEPENDENCY METHODS AFTER OBJECT IS DEFINED
// =====================================================

// Now that DataHelper is defined, we can safely reference it
DataHelper.getCpuShares = (data) => {
    let accepted = 0;
    let rejected = 0;
    
    const algorithms = DataHelper.getAllAlgorithms(data);
    algorithms.forEach(algo => {
        // Check if this is a CPU miner or CPU portion
        if (algo.minerKey === "miner_xmrig" || 
            algo.minerKey === "miner_srbminer" || 
            (algo.minerKey === "miner_srbminer" && DataHelper.getCpuHashrateHS(algo) > 0)) {
            accepted += DataHelper.getAcceptedShares(algo) || 0;
            rejected += DataHelper.getRejectedShares(algo) || 0;
        }
    });
    
    return {
        accepted: accepted,
        rejected: rejected,
        ratio: rejected > 0 ? (rejected / (accepted + rejected)).toFixed(2) : 0,
        string: `${accepted}/${rejected}`
    };
};

DataHelper.getGpuShares = (data) => {
    let accepted = 0;
    let rejected = 0;
    
    const algorithms = DataHelper.getAllAlgorithms(data);
    algorithms.forEach(algo => {
        // Check if this is a GPU miner or GPU portion
        if (algo.minerKey !== "miner_xmrig" && 
            !(algo.minerKey === "miner_srbminer" && DataHelper.getCpuHashrateHS(algo) > 0 && DataHelper.getGpuHashrateHS(algo) === 0)) {
            accepted += DataHelper.getAcceptedShares(algo) || 0;
            rejected += DataHelper.getRejectedShares(algo) || 0;
        }
    });
    
    return {
        accepted: accepted,
        rejected: rejected,
        ratio: rejected > 0 ? (rejected / (accepted + rejected)).toFixed(2) : 0,
        string: `${accepted}/${rejected}`
    };
};

DataHelper.getSharesClass = (sharesData) => {
    if (!sharesData || sharesData.accepted === 0) return "status-unknown";
    
    const rejectionRate = sharesData.ratio || 0;
    
    if (rejectionRate === 0) return "shares-perfect";        // 0% rejected
    if (rejectionRate < 0.01) return "shares-good";         // < 1% rejected
    if (rejectionRate < 0.03) return "shares-warning";      // < 3% rejected
    return "shares-bad";                                    // >= 3% rejected
};

DataHelper.getFormattedShares = (sharesData, type = "cpu") => {
    if (!sharesData || (sharesData.accepted === 0 && sharesData.rejected === 0)) {
        return {
            value: "0/0",
            class: "status-unknown"
        };
    }
    
    const sharesClass = DataHelper.getSharesClass(sharesData);
    return {
        value: `${sharesData.accepted}/${sharesData.rejected}`,
        class: sharesClass
    };
};

DataHelper.getCpuColumnContent = (data) => {
    const cpuShares = DataHelper.getCpuShares(data);
    if (cpuShares.accepted > 0 || cpuShares.rejected > 0) {
        const formatted = DataHelper.getFormattedShares(cpuShares, "cpu");
        return {
            html: `<span class="${formatted.class}" title="CPU Shares (Accepted/Rejected)">${formatted.value}</span>`,
            class: formatted.class
        };
    }
    // Fallback to service status
    const cpuService = DataHelper.getServiceStatus(data, "cpu_service");
    const formattedService = DataHelper.getFormattedService(cpuService, "cpu");
    return {
        html: `<span class="${formattedService.class}">CPU</span>`,
        class: formattedService.class
    };
};

DataHelper.getGpuColumnContent = (data) => {
    const gpuShares = DataHelper.getGpuShares(data);
    if (gpuShares.accepted > 0 || gpuShares.rejected > 0) {
        const formatted = DataHelper.getFormattedShares(gpuShares, "gpu");
        return {
            html: `<span class="${formatted.class}" title="GPU Shares (Accepted/Rejected)">${formatted.value}</span>`,
            class: formatted.class
        };
    }
    // Fallback to service status
    const gpuService = DataHelper.getServiceStatus(data, "gpu_service");
    const formattedService = DataHelper.getFormattedService(gpuService, "gpu");
    return {
        html: `<span class="${formattedService.class}">GPU</span>`,
        class: formattedService.class
    };
};

// Also check if getAllAlgorithms has circular dependencies - if it does, move it too
// But looking at your code, getAllAlgorithms calls getActiveMiners which calls other methods
// So let's move it as well to be safe:

// First, remove it from the main object (if it's there) and redefine it:
DataHelper.getAllAlgorithms = (data) => {
    const algorithms = [];
    const activeMiners = DataHelper.getActiveMiners(data);
    activeMiners.forEach(miner => {
        if (miner.data.algorithms) {
            miner.data.algorithms.forEach(algo => {
                algorithms.push({
                    ...algo,
                    minerKey: miner.key,
                    minerName: miner.name,
                    minerUptime: miner.data.uptime_s,
                    minerVersion: miner.data.miner_version,
                    cudaDriver: miner.data.cuda_driver || miner.data.cuda_driver_version
                });
            });
        }
    });
    return algorithms;
};

// =====================================================
// NETWORK COMMUNICATION (HTTP/WebSocket)
// =====================================================

function getWebSocketUrl() {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    return proto + location.host + `${API}/ws`;
}

function initWebSocket() {
    const ws = new WebSocket(getWebSocketUrl());

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);

            /* =====================================================
               COMMAND RESPONSE
               ===================================================== */
            if (msg.cmd_response) {
                const out = document.getElementById("cmd-output");
                if (!out) return;

                const r = msg.cmd_response;

                out.textContent += `\n[${r.rig}] returncode=${r.returncode}\n`;
                if (r.stdout) out.textContent += r.stdout + "\n";
                if (r.stderr) out.textContent += r.stderr + "\n";

                out.scrollTop = out.scrollHeight;
                return;
            }

            /* =====================================================
               FULL RIG SNAPSHOT
               ===================================================== */
            if (msg.rigs) {
                rigsState = msg.rigs;
                lastUpdateTs = Date.now() / 1000;
                render();
                return;
            }

            /* =====================================================
               SINGLE RIG UPDATE
               ===================================================== */
            if (msg.rig && msg.data) {
                rigsState[msg.rig] = {
                    timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
                    data: msg.data
                };
                lastUpdateTs = Date.now() / 1000;
                render();
                return;
            }

            /* =====================================================
               LEGACY PAYLOAD
               ===================================================== */
            if (msg.payload && msg.payload.rig) {
                const r = msg.payload.rig;
                rigsState[r] = {
                    timestamp: msg.payload.timestamp || Math.floor(Date.now() / 1000),
                    data: msg.payload
                };
                lastUpdateTs = Date.now() / 1000;
                render();
                return;
            }

        } catch (e) {
            console.error("WS parse error", e);
        }
    };

    ws.onclose = () => setTimeout(initWebSocket, 5000);
}


/*
async function fetchRigsOnce() {
    const res = await fetch(`${API}/rigs`);
    if (!res.ok) return;
    rigsState = await res.json();
    lastUpdateTs = Date.now() / 1000;
    render();
}
*/

// =====================================================
// FORMATTING UTILITIES
// =====================================================

function hasPositiveRate(hs) {
    return typeof hs === "number" && hs > 0;
}

function fmtRateHs(totalHs, label) {
    if (!totalHs || totalHs <= 0) {
        return null;
    }

    if (totalHs >= 1e6) {
        return `${(totalHs / 1e6).toFixed(2)} MH/s ${label}`;
    }
    if (totalHs >= 1e3) {
        return `${(totalHs / 1e3).toFixed(2)} kH/s ${label}`;
    }
    return `${totalHs.toFixed(0)} H/s ${label}`;
}

function fmtShares(accepted, rejected) {
    if (accepted === undefined && rejected === undefined) return "--";
    
    if (accepted !== undefined && rejected !== undefined) {
        return `${accepted}/${rejected}`;
    }
    
    if (accepted !== undefined) {
        return accepted.toString();
    }
    
    return "--";
}

function fmtXmrig(hs) {
    return hs > 0
        ? `${(hs / 1e3).toFixed(1)} kH/s`
        : null;
}

function fmtUptime(sec) {
    if (!sec || sec <= 0) return "--";
    sec = Math.floor(sec);

    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);

    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// =====================================================
// Simple Column Hiding System
// =====================================================

function setupHeaderClickHandlers() {
    const headerGrid = document.querySelector('.rig-header-grid');
    if (!headerGrid) return;
    
    // 1. Make "Name" header clickable to reset hidden columns
    const nameHeader = headerGrid.children[0];
    if (nameHeader) {
        // Find the text part of the Name header (not the reset button)
        const nameText = nameHeader.textContent.replace('⟳', '').trim();
        nameHeader.innerHTML = `
            <span class="reset-btn" id="btn-reset" title="Hard reset rigs">⟳</span>
            <span class="name-header-text">${nameText}</span>
        `;
        
        const nameTextSpan = nameHeader.querySelector('.name-header-text');
        if (nameTextSpan) {
            nameTextSpan.style.cursor = 'pointer';
            nameTextSpan.title = 'Click to show all hidden columns';
            nameTextSpan.addEventListener('click', (e) => {
                e.stopPropagation();
                resetAllHiddenColumns();
            });
        }
    }
    
    // 2. Make all other metric headers clickable to hide/show
    Array.from(headerGrid.children).forEach((cell, index) => {
        if (index > 0 && index < headerGrid.children.length - 1) {
            cell.style.cursor = 'pointer';
            cell.title = 'Click to hide/show column';
            cell.addEventListener('click', () => toggleColumnVisibility(index));
            
            // Visual indicator for hidden columns
            if (hiddenColumns.has(index)) {
                cell.classList.add('column-hidden');
                cell.style.opacity = '0.5';
            }
        }
    });
}

function resetAllHiddenColumns() {
    if (hiddenColumns.size === 0) return; // Nothing to reset
    
    // Clear all hidden columns
    hiddenColumns.clear();
    
    // Show all columns
    const headerGrid = document.querySelector('.rig-header-grid');
    const rigRows = document.querySelectorAll('.rig-row .rig-main');
    
    if (headerGrid) {
        // Show all header columns
        Array.from(headerGrid.children).forEach((cell, index) => {
            cell.classList.remove('column-hidden');
            cell.style.opacity = '1';
        });
    }
    
    // Show all data columns
    rigRows.forEach(row => {
        Array.from(row.children).forEach(cell => {
            cell.classList.remove('column-hidden');
        });
    });
    
    // Clear saved state
    localStorage.removeItem('hiddenColumns');
    
    console.log('All columns reset');
}

function toggleColumnVisibility(columnIndex) {
    const headerGrid = document.querySelector('.rig-header-grid');
    if (!headerGrid) return;
    
    if (hiddenColumns.has(columnIndex)) {
        // Show the column
        hiddenColumns.delete(columnIndex);
        showColumn(columnIndex);
    } else {
        // Hide the column
        hiddenColumns.add(columnIndex);
        hideColumn(columnIndex);
    }
    
    saveColumnState();
}

function saveColumnState() {
    localStorage.setItem('hiddenColumns', JSON.stringify(Array.from(hiddenColumns)));
}

function loadColumnState() {
    const saved = localStorage.getItem('hiddenColumns');
    if (saved) {
        try {
            const state = JSON.parse(saved);
            // Clear current set and add saved columns
            hiddenColumns.clear();
            state.forEach(col => {
                // Only add valid column indices (1-15 for data columns)
                if (col >= 1 && col <= 15) {
                    hiddenColumns.add(col);
                }
            });
            console.log('Loaded hidden columns:', Array.from(hiddenColumns));
        } catch(e) {
            console.error('Failed to load column state:', e);
            // Clear invalid storage
            localStorage.removeItem('hiddenColumns');
        }
    }
}

function applyHiddenColumnsToDOM() {
    const headerGrid = document.querySelector('.rig-header-grid');
    const rigRows = document.querySelectorAll('.rig-row .rig-main');
    
    if (!headerGrid) return;
    
    // Apply to header
    Array.from(headerGrid.children).forEach((cell, index) => {
        if (hiddenColumns.has(index)) {
            cell.classList.add('column-hidden');
            cell.style.opacity = '0.5';
        } else {
            cell.classList.remove('column-hidden');
            cell.style.opacity = '1';
        }
    });
    
    // Apply to all existing data rows
    rigRows.forEach(row => {
        Array.from(row.children).forEach((cell, index) => {
            if (hiddenColumns.has(index)) {
                cell.classList.add('column-hidden');
            } else {
                cell.classList.remove('column-hidden');
            }
        });
    });
    
    console.log('Hidden columns applied:', Array.from(hiddenColumns));
}

function applyHeaderVisibility() {
    const headerGrid = document.querySelector('.rig-header-grid');
    if (!headerGrid) return;
    
    // Apply hidden state to header cells
    Array.from(headerGrid.children).forEach((cell, index) => {
        if (hiddenColumns.has(index)) {
            cell.classList.add('column-hidden');
            cell.style.opacity = '0.5';
        } else {
            cell.classList.remove('column-hidden');
            cell.style.opacity = '1';
        }
    });
}

function showColumn(columnIndex) {
    // Show header
    const headerGrid = document.querySelector('.rig-header-grid');
    if (headerGrid && headerGrid.children[columnIndex]) {
        headerGrid.children[columnIndex].classList.remove('column-hidden');
        headerGrid.children[columnIndex].style.opacity = '1';
    }
    
    // Show in all data rows
    document.querySelectorAll('.rig-row .rig-main').forEach(row => {
        if (row.children[columnIndex]) {
            row.children[columnIndex].classList.remove('column-hidden');
        }
    });
}

function hideColumn(columnIndex) {
    // Hide header
    const headerGrid = document.querySelector('.rig-header-grid');
    if (headerGrid && headerGrid.children[columnIndex]) {
        headerGrid.children[columnIndex].classList.add('column-hidden');
        headerGrid.children[columnIndex].style.opacity = '0.5'; // Visual feedback
    }
    
    // Hide in all data rows
    document.querySelectorAll('.rig-row .rig-main').forEach(row => {
        if (row.children[columnIndex]) {
            row.children[columnIndex].classList.add('column-hidden');
        }
    });
}

// =====================================================
// FLIGHTSHEET MANAGEMENT
// =====================================================

const v = id => document.querySelector(id)?.value ?? "";
const c = id => document.querySelector(id)?.checked ?? false;

function getFlightsheetName() {
    const el = document.getElementById("fs-name");
    if (!el) return "";

    return el.value
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9\-]/g, "");
}

function collectFlightsheetEntries() {
    const cmd = document.getElementById("fs-raw").value.trim();

    // 🔴 ADD VALIDATION
    if (!cmd) {
        alert("Cannot save empty flightsheet! Please enter a command in the flightsheet editor.");
        throw new Error("Empty command");
    }

    console.log("Saving flightsheet with command length:", cmd.length);
    
    return [
        { key: "RAW_COMMAND", gpu: 0, value: cmd }
    ];
}

async function loadFlightsheets() {
    const res = await fetch(`${API}/api/flightsheets`);
    if (!res.ok) {
        alert("Failed to load flightsheets");
        return;
    }

    flightsheets = await res.json();
    renderFlightsheets();
}

function renderFlightsheets() {
    const list = document.getElementById("fs-list");
    list.innerHTML = "";

    // Natural sort (handles numbers in names)
    const sortedFlightsheets = [...flightsheets].sort((a, b) => {
        return naturalCompare(a.FlightsheetId, b.FlightsheetId);
    });

    for (const fs of sortedFlightsheets) {
        const row = document.createElement("div");
        row.className = "fs-item";
        row.textContent = fs.FlightsheetId;
        
        // Store data for easy access
        row.dataset.id = fs.FlightsheetId;
        row.dataset.value = fs.Value || "";

        row.addEventListener("click", () => {
            // Clear previous selection
            document
                .querySelectorAll("#fs-list .fs-item.selected")
                .forEach(e => e.classList.remove("selected"));

            row.classList.add("selected");
            selectedFlightsheetId = fs.FlightsheetId;

            // Populate form fields
            document.getElementById("fs-name").value = fs.FlightsheetId;
            document.getElementById("fs-raw").value = fs.Value || "";
        });

        list.appendChild(row);
    }
}

// Helper function for natural sorting (numbers in strings)
function naturalCompare(a, b) {
    const ax = [], bx = [];
    
    a.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
        ax.push([$1 || Infinity, $2 || ""]);
    });
    
    b.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
        bx.push([$1 || Infinity, $2 || ""]);
    });
    
    while (ax.length && bx.length) {
        const an = ax.shift();
        const bn = bx.shift();
        const nn = (an[0] - bn[0]) || an[1].localeCompare(bn[1]);
        if (nn) return nn;
    }
    
    return ax.length - bx.length;
}

async function saveFlightsheet(flightsheetId, entries) {
    // No showAlert parameter - never shows alerts
    if (!flightsheetId) {
        throw new Error("Flightsheet name is required");
    }

    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error("Flightsheet has no entries to save");
    }

    const res = await fetch(
        `${API}/api/flightsheets/${encodeURIComponent(flightsheetId)}`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ entries })
        }
    );

    if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const errorMsg = errorData.detail || errorData.message || "Failed to save flightsheet";
        throw new Error(errorMsg);
    }

    return await res.json();
}

async function saveFlightsheetFromDialog() {
    const flightsheetId = getFlightsheetName();
    
    try {
        const entries = collectFlightsheetEntries();
        await saveFlightsheet(flightsheetId, entries);
        
		loadFlightsheets(); // Refresh list        
        alert(`Flightsheet "${flightsheetId}" saved successfully!`);
        
    } catch (err) {
        alert(`Error saving flightsheet: ${err.message}`);
    }
}

function newFlightsheet() {
    const raw = document.getElementById("fs-raw").value.trim();

    if (raw) {
        alert("Flightsheet is not empty");
        return;
    }

    let finalText = "";

    function buildBlock(mode) {
        const firstLine =
            mode === "cpu"
                ? "tee /home/user/rig-cpu.conf > /dev/null <<'EOF'"
                : "tee /home/user/rig-gpu.conf > /dev/null <<'EOF'";

        const cmdLine =
            mode === "cpu"
                ? "sudo systemctl restart docker_events_cpu"
                : "sudo systemctl restart docker_events_gpu";

        const configLines = [
            'TARGET_IMAGE 0 "ubuntu:24.04"',
            'TARGET_NAME 0 ""',
            'RESET_OC 0 "false"',
            `SCREEN_NAME 0 "${mode}"`,
            'CUSTOM_MINER 0 ""',
            'MINER 0 ""',
            'ALGO 0 ""',
            'POOL 0 ""',
            'WALLET 0 ""',
            'PASS 0 "x"',
            'ARGS 0 ""'
        ];

        return [
            firstLine,
            ...configLines,
            "EOF",
            cmdLine
        ].join("\n");
    }

    switch (currentActionMode) {
        case "all":
            finalText += buildBlock("cpu");
            finalText += "\n\n";
            finalText += buildBlock("gpu");
            break;

        case "cpu":
            finalText = buildBlock("cpu");
            break;

        case "gpu":
        default:
            finalText = buildBlock("gpu");
            break;
    }

    document.getElementById("fs-raw").value = finalText;
}

function applyFlightsheet() {
    const raw = document.getElementById("fs-raw").value.trim();

    if (!raw) {
        alert("Flightsheet is empty");
        return;
    }

    // ---- wrappers (different commands based on mode) ----
    /*
	let firstLine, lastLine, cmdLine;
    
    switch(currentActionMode) {
        case "all":
            // Apply to both CPU and GPU
            firstLine = "tee /home/user/rig-all.conf > /dev/null <<'EOF'";
            lastLine = "EOF";
            cmdLine = "sudo systemctl restart docker_events_all";
            break;
            
        case "cpu":
            // Apply only to CPU
            firstLine = "tee /home/user/rig-cpu.conf > /dev/null <<'EOF'";
            lastLine = "EOF";
            cmdLine = "sudo systemctl restart docker_events_cpu";
            break;
            
        case "gpu":
            // Apply only to GPU (original behavior)
            firstLine = "tee /home/user/rig-gpu.conf > /dev/null <<'EOF'";
            lastLine = "EOF";
            cmdLine = "sudo systemctl restart docker_events_gpu";
            break;
            
        default:
            // Fallback to GPU mode
            firstLine = "tee /home/user/rig-gpu.conf > /dev/null <<'EOF'";
            lastLine = "EOF";
            cmdLine = "sudo systemctl restart docker_events_gpu";
    }

    const finalText = [
        firstLine,
        raw,
        lastLine,
        cmdLine
    ].join("\n");
    */
	
    document.getElementById("cmd-input").value = raw;

    closeFlightsheetsModal();
    openCmdModal();
}

async function deleteFlightsheet() {
    if (!selectedFlightsheetId) {
        alert("No flightsheet selected");
        return;
    }
    
    if (!confirm(`Delete flightsheet "${selectedFlightsheetId}"?`)) {
        return;
    }
    
    try {
        const res = await fetch(
            `${API}/api/flightsheets/${encodeURIComponent(selectedFlightsheetId)}`,
            { method: "DELETE" }
        );
        
        if (!res.ok) throw new Error("Failed to delete");
        
		loadFlightsheets(); // Refresh list        
        alert("Flightsheet deleted");
       
        // Clear form
        document.getElementById("fs-name").value = "";
        document.getElementById("fs-raw").value = "";
        selectedFlightsheetId = null;
        
    } catch (err) {
        alert(err.message);
    }
}

// =====================================================
// RENDER FUNCTIONS (UI UPDATES)
// =====================================================

function render() {
    if (resetInProgress) return;

    const container = document.getElementById("rig-container");
    container.innerHTML = "";

    const rigNames = Object.keys(rigsState)
        .filter(name => name !== "rigs")
        .sort();

    rigNames.forEach(rigName => {
        const entry = rigsState[rigName];
        const d = entry.data ?? {};
        const safeId = rigName.replace(/[^a-zA-Z0-9_-]/g, "_");
        const open = popoverState[safeId] === true;
		
		// Get all active miners
        const activeMiners = DataHelper.getActiveMiners(d);

        /* ---------------- CPU ---------------- */
        const cpuTemp = DataHelper.getCpuTemp(d);
        const cpuTempFormatted = DataHelper.getFormattedTemp(cpuTemp, "cpu");
        const cpuTempStr = cpuTempFormatted.value;
        const cpuTempClass = cpuTempFormatted.class;
        
        const cpuUtil = DataHelper.getCpuUsage(d);
        const load1 = DataHelper.getLoad(d, "1m");
        const load5 = DataHelper.getLoad(d, "5m");
        const load15 = DataHelper.getLoad(d, "15m");
        
        /* ---------------- RAM ---------------- */
        const memory = DataHelper.getMemory(d);
        const ramStr = memory.string;
        
        /* ---------------- GPU ---------------- */
        const primaryGpu = DataHelper.getPrimaryGpu(d);
        const gpuTemp = DataHelper.getGpuTemp(primaryGpu);
        const gpuTempFormatted = DataHelper.getFormattedTemp(gpuTemp, "gpu");
        const gpuTempStr = gpuTempFormatted.value;
        const gpuTempClass = gpuTempFormatted.class;
        
        const gpuUtil = DataHelper.getGpuUtil(primaryGpu);
        const gpuPower = DataHelper.getGpuPower(primaryGpu);
        const gpuFan = DataHelper.getGpuFan(primaryGpu);
        const fanFormatted = DataHelper.getFormattedFan(gpuFan);
        const fanClass = fanFormatted.class;
        
        const coreMHz = DataHelper.getGpuCoreClock(primaryGpu);
        const memMHz = DataHelper.getGpuMemClock(primaryGpu);
        
        const vram = DataHelper.getGpuVram(primaryGpu);
        const vramGB = vram.string;
        
        /* ---------------- Services ---------------- */
        const cpuService = DataHelper.getServiceStatus(d, "cpu_service");
        const cpuServiceFormatted = DataHelper.getFormattedService(cpuService);
        const cpuServiceClass = cpuServiceFormatted.class;
        
        const gpuService = DataHelper.getServiceStatus(d, "gpu_service");
        const gpuServiceFormatted = DataHelper.getFormattedService(gpuService);
        const gpuServiceClass = gpuServiceFormatted.class;
        
        /* ---------------- Docker ---------------- */
        const dockerList = DataHelper.getDockerContainers(d);
        
        let dockerLeft = `<div class="docker-header">Docker Containers (${dockerList.length})</div>`;
        
        if (dockerList.length === 0) {
            dockerLeft += "<div style='padding: 10px; color: var(--text-muted); font-style: italic;'>No containers</div>";
        } else {
            dockerList.forEach(container => {
                dockerLeft += `
                    <div class="docker-container">
                        <div class="docker-name-row">${container.name}</div>
                        <div class="docker-details-grid">
                            <div class="docker-detail-item">
                                <div class="docker-detail-label">Image</div>
                                <div class="docker-detail-value image">${container.image}</div>
                            </div>
                            <div class="docker-detail-item">
                                <div class="docker-detail-label">Uptime</div>
                                <div class="docker-detail-value uptime">${fmtUptime(container.uptime_seconds)}</div>
                            </div>
                        </div>
                    </div>`;
            });
        }

        /* ---------------- Miners ---------------- */
        let minerRight = "";
        
        // Process each miner
        activeMiners.forEach(miner => {
            const minerData = miner.data;
            const minerVersion = DataHelper.getMinerVersion(minerData);
            const cudaDriver = DataHelper.getCudaDriverVersion(minerData);
            const algorithms = DataHelper.getMinerAlgorithms(d, miner.key);
            
            algorithms.forEach(algo => {
                const totalHashrate = DataHelper.getTotalHashrateHS(algo);
                if (totalHashrate > 0) {
                    const algoName = DataHelper.getAlgorithmName(algo);
                    const pool = DataHelper.getPool(algo);
                    const shares = fmtShares(
                        DataHelper.getAcceptedShares(algo),
                        DataHelper.getRejectedShares(algo)
                    );
                    
                    // Format miner name with version
                    const minerDisplayName = `${miner.name} ${DataHelper.getFormattedVersion(minerVersion)}`;
                    
                    // Special handling for SRBMiner
                    if (miner.key === "miner_srbminer") {
                        const cpuHashrate = DataHelper.getCpuHashrateHS(algo);
                        const gpuHashrate = DataHelper.getGpuHashrateHS(algo);
                        const cpuWorkers = DataHelper.getCpuWorkers(algo);
                        const gpuWorkers = DataHelper.getGpuWorkers(algo);
                        
                        const cpuRate = cpuHashrate > 0 ? fmtRateHs(cpuHashrate, "") : null;
                        const gpuRate = gpuHashrate > 0 ? fmtRateHs(gpuHashrate, "") : null;
                        const totalRate = totalHashrate > 0 ? fmtRateHs(totalHashrate, "") : null;
                        
                        // Get per-thread data if available
                        const threadHashrates = DataHelper.getThreadHashrates(algo);
                        let threadInfo = "";
                        if (Object.keys(threadHashrates).length > 0) {
                            const threadCount = Object.keys(threadHashrates).length;
                            threadInfo = `<div class="miner-stat-item">
                                <div class="stat-label">CPU THREADS</div>
                                <div class="stat-value">${threadCount} threads</div>
                            </div>`;
                        } else if (cpuWorkers) {
                            threadInfo = `<div class="miner-stat-item">
                                <div class="stat-label">CPU THREADS</div>
                                <div class="stat-value">${cpuWorkers} workers</div>
                            </div>`;
                        }
                        
                        minerRight += `
                            <div class="miner-row-horizontal">
                                <div class="miner-name-row">${minerDisplayName}</div>
                                <div class="miner-details-compact">
                                    <div class="miner-stat-item">
                                        <div class="stat-label">ALGORITHM</div>
                                        <div class="stat-value">${algoName}</div>
                                    </div>
                                    ${cpuRate ? `
                                    <div class="miner-stat-item">
                                        <div class="stat-label">CPU HASHRATE</div>
                                        <div class="stat-value">${cpuRate}</div>
                                    </div>
                                    ` : ""}
                                    ${gpuRate ? `
                                    <div class="miner-stat-item">
                                        <div class="stat-label">GPU HASHRATE</div>
                                        <div class="stat-value">${gpuRate}</div>
                                    </div>
                                    ` : ""}
                                    ${totalRate ? `
                                    <div class="miner-stat-item">
                                        <div class="stat-label">TOTAL HASHRATE</div>
                                        <div class="stat-value">${totalRate}</div>
                                    </div>
                                    ` : ""}
                                    ${threadInfo}
                                    <div class="miner-stat-item">
                                        <div class="stat-label">SHARES</div>
                                        <div class="stat-value">${shares}</div>
                                    </div>
                                    <div class="miner-stat-item">
                                        <div class="stat-label">UPTIME</div>
                                        <div class="stat-value">${fmtUptime(miner.data.uptime_s)}</div>
                                    </div>
                                    ${pool ? `
                                    <div class="miner-stat-item">
                                        <div class="stat-label">POOL</div>
                                        <div class="stat-value">${pool}</div>
                                    </div>
                                    ` : ""}
                                </div>
                            </div>`;
                    }
                    // Special handling for Rigel miner
                    else if (miner.key === "miner_rigel") {
                        const poolHashrate = DataHelper.getPoolHashrateHS(algo);
                        const rate = fmtRateHs(totalHashrate, "");
                        const poolRate = poolHashrate > 0 ? fmtRateHs(poolHashrate, "") : null;
                        
                        minerRight += `
                            <div class="miner-row-horizontal">
                                <div class="miner-name-row">${minerDisplayName}</div>
                                <div class="miner-details-compact">
                                    <div class="miner-stat-item">
                                        <div class="stat-label">ALGORITHM</div>
                                        <div class="stat-value">${algoName}</div>
                                    </div>
                                    <div class="miner-stat-item">
                                        <div class="stat-label">LOCAL HASHRATE</div>
                                        <div class="stat-value">${rate}</div>
                                    </div>
                                    ${poolRate ? `
                                    <div class="miner-stat-item">
                                        <div class="stat-label">POOL HASHRATE</div>
                                        <div class="stat-value">${poolRate}</div>
                                    </div>
                                    ` : ""}
                                    <div class="miner-stat-item">
                                        <div class="stat-label">SHARES</div>
                                        <div class="stat-value">${shares}</div>
                                    </div>
                                    <div class="miner-stat-item">
                                        <div class="stat-label">UPTIME</div>
                                        <div class="stat-value">${fmtUptime(miner.data.uptime_s)}</div>
                                    </div>
                                    ${pool ? `
                                    <div class="miner-stat-item">
                                        <div class="stat-label">POOL</div>
                                        <div class="stat-value">${pool}</div>
                                    </div>
                                    ` : ""}
                                </div>
                            </div>`;
                    }
                    // Special handling for BzMiner
                    else if (miner.key === "miner_bzminer") {
                        const rate = fmtRateHs(totalHashrate, "");
                        const totalDevices = DataHelper.getMinerTotalDevices(minerData);
                        
                        let deviceInfo = "";
                        if (totalDevices > 0) {
                            deviceInfo = `<div class="miner-stat-item">
                                <div class="stat-label">DEVICES</div>
                                <div class="stat-value">${totalDevices}</div>
                            </div>`;
                        }
                        
                        let bzCudaInfo = "";
                        const bzCudaDriver = DataHelper.getCudaDriverVersion(minerData);
                        if (bzCudaDriver && bzCudaDriver !== "--") {
                            bzCudaInfo = `<div class="miner-stat-item">
                                <div class="stat-label">CUDA</div>
                                <div class="stat-value">${DataHelper.getFormattedDriver(bzCudaDriver)}</div>
                            </div>`;
                        }
                        
                        minerRight += `
                            <div class="miner-row-horizontal">
                                <div class="miner-name-row">${minerDisplayName}</div>
                                <div class="miner-details-compact">
                                    <div class="miner-stat-item">
                                        <div class="stat-label">ALGORITHM</div>
                                        <div class="stat-value">${algoName}</div>
                                    </div>
                                    <div class="miner-stat-item">
                                        <div class="stat-label">HASHRATE</div>
                                        <div class="stat-value">${rate}</div>
                                    </div>
                                    ${deviceInfo}
                                    ${bzCudaInfo}
                                    <div class="miner-stat-item">
                                        <div class="stat-label">SHARES</div>
                                        <div class="stat-value">${shares}</div>
                                    </div>
                                    <div class="miner-stat-item">
                                        <div class="stat-label">UPTIME</div>
                                        <div class="stat-value">${fmtUptime(miner.data.uptime_s)}</div>
                                    </div>
                                    ${pool ? `
                                    <div class="miner-stat-item">
                                        <div class="stat-label">POOL</div>
                                        <div class="stat-value">${pool}</div>
                                    </div>
                                    ` : ""}
                                </div>
                            </div>`;
                    }
                    // Standard miner display
                    else {
                        const rate = miner.key === "miner_xmrig" 
                            ? fmtXmrig(totalHashrate)
                            : fmtRateHs(totalHashrate, "");
                        
                        // For XMRig, show thread count
                        let xmrigThreadInfo = "";
                        if (miner.key === "miner_xmrig") {
                            const cpuThreads = DataHelper.getCpuThreads(algo);
                            if (cpuThreads > 0) {
                                xmrigThreadInfo = `<div class="miner-stat-item">
                                    <div class="stat-label">CPU THREADS</div>
                                    <div class="stat-value">${cpuThreads}</div>
                                </div>`;
                            }
                        }
                        
                        minerRight += `
                            <div class="miner-row-horizontal">
                                <div class="miner-name-row">${minerDisplayName}</div>
                                <div class="miner-details-compact">
                                    <div class="miner-stat-item">
                                        <div class="stat-label">ALGORITHM</div>
                                        <div class="stat-value">${algoName}</div>
                                    </div>
                                    <div class="miner-stat-item">
                                        <div class="stat-label">HASHRATE</div>
                                        <div class="stat-value">${rate}</div>
                                    </div>
                                    ${xmrigThreadInfo}
                                    <div class="miner-stat-item">
                                        <div class="stat-label">SHARES</div>
                                        <div class="stat-value">${shares}</div>
                                    </div>
                                    <div class="miner-stat-item">
                                        <div class="stat-label">UPTIME</div>
                                        <div class="stat-value">${fmtUptime(miner.data.uptime_s)}</div>
                                    </div>
                                    ${pool ? `
                                    <div class="miner-stat-item">
                                        <div class="stat-label">POOL</div>
                                        <div class="stat-value">${pool}</div>
                                    </div>
                                    ` : ""}
                                </div>
                            </div>`;
                    }
                }
            });
        });
		
		// Display NVIDIA driver version if available
        const nvidiaDriver = DataHelper.getNvidiaDriverVersion(d);
        if (nvidiaDriver && nvidiaDriver !== "--") {
            /* ----- Header only if something rendered ----- */
            if (minerRight !== "") {
            minerRight =
                `<div class="docker-header">Miners - NVIDIA DRIVER ${DataHelper.getFormattedDriver(nvidiaDriver)}</div>` +
                minerRight;
            }
        }
		else{
            /* ----- Header only if something rendered ----- */
            if (minerRight !== "") {
            minerRight =
                `<div class="docker-header">Miners</div>` +
                minerRight;
            }
		}		


        /* ---------------- Row Summary ---------------- */
        const minerSummary = [];
        
        activeMiners.forEach(miner => {
                const algorithms = DataHelper.getMinerAlgorithms(d, miner.key);
                
                algorithms.forEach(algo => {
                        const totalHashrate = DataHelper.getTotalHashrateHS(algo);
                        
                        if (totalHashrate > 0) {
                                if (miner.key === "miner_srbminer") {
                                        const cpuHashrate = DataHelper.getCpuHashrateHS(algo);
                                        const gpuHashrate = DataHelper.getGpuHashrateHS(algo);
                                        
                                        const parts = [];
                                        if (cpuHashrate > 0) {
                                                parts.push(`CPU ${fmtRateHs(cpuHashrate, "")}`);
                                        }
                                        if (gpuHashrate > 0) {
                                                parts.push(`GPU ${fmtRateHs(gpuHashrate, "")}`);
                                        }
                                        if (parts.length > 0) {
                                                minerSummary.push(`SRBMiner ${parts.join(" | ")}`);
                                        }
                                } else if (miner.key === "miner_xmrig") {
                                        minerSummary.push(`${fmtXmrig(totalHashrate)} XMRig`);
                                } else {
                                        minerSummary.push(`${fmtRateHs(totalHashrate, miner.name)}`);
                                }
                        }
                });
        });
        
        const finalMinerSummary = minerSummary.filter(Boolean).join(" | ");

        /* ================= ROW BUILD ================= */

        const row = document.createElement("div");
        row.className = "rig-row";

        if (selectedRigs.has(rigName)) {
            row.classList.add("selected");
        }

        /* ----- Main grid (popover toggle) ----- */
        const main = document.createElement("div");
        main.className = "rig-main";

        main.addEventListener("click", () => {
            popoverState[safeId] = !popoverState[safeId];
            render();
        });

        /* ----- Rig name (selection ONLY) ----- */
        const nameEl = document.createElement("div");
        nameEl.className = "rig-name";
        nameEl.textContent = rigName;

        nameEl.addEventListener("click", (ev) => {
            ev.stopPropagation();

            if (ev.shiftKey || ev.ctrlKey) {
                // Multi-select toggle
                if (selectedRigs.has(rigName)) {
                    selectedRigs.delete(rigName);
                } else {
                    selectedRigs.add(rigName);
                }
            } else {
                // Single-select toggle
                if (selectedRigs.has(rigName)) {
                    selectedRigs.delete(rigName); // unselect on second click
                } else {
                    selectedRigs.clear();
                    selectedRigs.add(rigName);
                }
            }

            render();
        });

        main.appendChild(nameEl);
		
        const cpuColumn = DataHelper.getCpuColumnContent(d);
        const gpuColumn = DataHelper.getGpuColumnContent(d);

        // Create column HTML strings
        const columnHTMLs = [
            `<div class="metric"><span class="${cpuTempClass}">${cpuTempStr}</span></div>`,
            `<div class="metric">${cpuUtil}</div>`,
            `<div class="metric">${load1} / ${load5} / ${load15}</div>`,
            `<div class="metric">${ramStr}</div>`,
            `<div class="metric"><span class="${gpuTempClass}">${gpuTempStr}</span></div>`,
            `<div class="metric">${gpuUtil}</div>`,
            `<div class="metric">${gpuPower}</div>`,
            `<div class="metric"><span class="${fanClass}">${gpuFan}</span></div>`,
            `<div class="metric">${vramGB}</div>`,
            `<div class="metric">${coreMHz}</div>`,
            `<div class="metric">${memMHz}</div>`,
            `<div class="metric">${cpuColumn.html}</div>`,
            `<div class="metric">${gpuColumn.html}</div>`,
            `<div class="metric">${dockerList.length}</div>`,
            `<div class="metric metric-left">${finalMinerSummary}</div>`
        ];

        // Insert all columns at once
        main.insertAdjacentHTML("beforeend", columnHTMLs.join(''));

        // Apply hidden state to each column immediately
        // Column indices: 0 is rig name, 1-15 are the metrics
        for (let colIndex = 1; colIndex <= 15; colIndex++) {
            const cell = main.children[colIndex];
            if (cell && hiddenColumns.has(colIndex)) {
                cell.classList.add('column-hidden');
            }
        }

        row.appendChild(main);

        /* ----- Popover ----- */
        const pop = document.createElement("div");
        pop.id = `docker-${safeId}`;
        pop.className = "docker-popover";
        pop.style.display = open ? "flex" : "none";

        pop.addEventListener("click", ev => ev.stopPropagation());
        pop.innerHTML = `
            <div class="pop-content">
                <div class="pop-docker">
                    ${dockerLeft}
                </div>
                <div class="pop-miners">
                    ${minerRight}
                </div>
            </div>
        `;

        row.appendChild(pop);
        container.appendChild(row);
    });
    
    updateSelectButton();
    updateActionStats();
    
    // Apply hidden state to headers
    applyHeaderVisibility();
    
    console.log('✅ Render complete ' + Date.now());
}

function updateActionStats() {
    const wattsEl = document.getElementById("stat-gpu-watts");
    const hashEl = document.getElementById("stat-hashrate");

    if (!wattsEl || !hashEl) return;

    let totalWatts = 0;
    const algoTotals = {};

    const rigNames = selectedRigs.size > 0
        ? Array.from(selectedRigs)
        : Object.keys(rigsState).filter(n => n !== "rigs");

    rigNames.forEach(name => {
        const d = rigsState[name]?.data;
        if (!d) return;

        /* ---------------- GPU watts ---------------- */
        totalWatts += DataHelper.getTotalGpuPower(d);

        /* ---------------- Miners ---------------- */
        const algorithms = DataHelper.getAllAlgorithms(d);
        
        algorithms.forEach(algo => {
            const algoName = DataHelper.getAlgorithmName(algo);
            const hashrate = DataHelper.getTotalHashrateHS(algo);
            
            if (hashrate > 0) {
                if (!algoTotals[algoName]) {
                    algoTotals[algoName] = 0;
                }
                algoTotals[algoName] += hashrate;
            }
        });
    });

    /* ---------------- Render GPU watts ---------------- */
    wattsEl.textContent =
        totalWatts > 0
            ? `GPU W: ${Math.round(totalWatts)}`
            : "GPU W: --";

    /* ---------------- Render algorithm totals ---------------- */
    const hashParts = [];
    const sortedAlgos = Object.keys(algoTotals).sort((a, b) => algoTotals[b] - algoTotals[a]);
    
    sortedAlgos.forEach(algoName => {
        const totalHashrate = algoTotals[algoName];
        if (totalHashrate > 0) {
            hashParts.push(`${algoName}: ${fmtRateHs(totalHashrate, "")}`);
        }
    });

    hashEl.textContent =
        hashParts.length > 0
            ? hashParts.join(" | ")
            : "--";
}

// =====================================================
// UI HELPER FUNCTIONS
// =====================================================

function updateSelectButton() {
    const btn = document.getElementById("btn-toggle-select");
    if (!btn) return;

    const total = Object.keys(rigsState).length;

    btn.textContent =
        selectedRigs.size === total && total > 0 ? "☑" : "☐";
}

function setActionMode(mode) {
    if (!["all", "cpu", "gpu"].includes(mode)) return;

    currentActionMode = mode;
    localStorage.setItem("actionMode", mode);

    document.querySelectorAll(".action-tab").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === mode);
    });

    setActionOutput(`Mode: ${mode.toUpperCase()}`);
}

function setActionOutput(text) {
    const el = document.getElementById("action-output");
    if (!el) return;

    el.value = text;
}

function getActionsForMode() {
    switch (currentActionMode) {
        case "cpu":
            return ["cpu"];

        case "gpu":
            return ["gpu"];

        case "all":
            return ["cpu", "gpu"];

        default:
            return [];
    }
}

function toggleSelectAll() {

    const rigNames = Object.keys(rigsState)
        .filter(name => name !== "rigs");

    if (rigNames.length === 0) return;

    const eligible = rigNames.filter(name => {
        const d = rigsState[name]?.data ?? {};
        const cpuActive = d.cpu_service?.state === "active";
        const gpuActive = d.gpu_service?.state === "active";

        if (currentActionMode === "all") return true;

        if (currentActionMode === "cpu") {
            return cpuActive;
        }

        if (currentActionMode === "gpu") {
            return gpuActive;
        }
    });

    if (eligible.length === 0) return;

    const allSelected = eligible.every(name => selectedRigs.has(name));

    if (allSelected) {
        eligible.forEach(name => selectedRigs.delete(name));
    } else {
        eligible.forEach(name => selectedRigs.add(name));
    }

    render();
}

function confirmAction(actionLabel) {
    const count = selectedRigs.size;

    if (count === 0) {
        alert("No rigs selected");
        return false;
    }

    return window.confirm(
        `${actionLabel} on ${count} selected rig${count !== 1 ? "s" : ""}?`
    );
}

function setResetButtonDisabled(disabled) {
    const btn = document.querySelector(".reset-btn");
    if (!btn) return;
    btn.classList.toggle("disabled", disabled);
    btn.style.pointerEvents = disabled ? "none" : "auto";
}

function toggleDocker(id) {
    popoverState[id] = !popoverState[id];
    render();
}

function stopClick(ev) { ev.stopPropagation(); }

// =====================================================
// MODAL MANAGEMENT
// =====================================================

function openCmdModal() {
    document.getElementById("cmd-target-count").textContent =
        selectedRigs.size;

    const modal = document.getElementById("cmd-modal");
    const input = document.getElementById("cmd-input");

    const out = document.getElementById("cmd-output");
    if (out) out.textContent = "";

    modal.classList.remove("hidden");
    //input.value = "";
    input.focus();
}

function closeCmdModal() {
    document.getElementById("cmd-modal").classList.add("hidden");
}

function openFlightsheetsModal() {
    closeCmdModal(); // safety
    document.getElementById("fs-modal").classList.remove("hidden");

    document.getElementById("fs-name").value = "";
    document.getElementById("fs-raw").value = "";

    loadFlightsheets();
}

function closeFlightsheetsModal() {
    document.getElementById("fs-modal").classList.add("hidden");
    selectedFlightsheetId = null;
}

// =====================================================
// ACTION FUNCTIONS (COMMAND SENDING)
// =====================================================

async function sendCommandToSelectedRigs(command) {
    if (selectedRigs.size === 0) {
        alert("No rigs selected");
        return;
    }

    return fetch(`${API}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            rigs: Array.from(selectedRigs),
            command
        })
    });
}

function submitCmd() {
    const cmd = document.getElementById("cmd-input").value.trim();
    if (!cmd) return;

    sendCommandToSelectedRigs(cmd).catch(err => {
        console.error("Command send failed", err);
        alert("Failed to send command");
    });
}

function actionStart() {
    const label =
        currentActionMode === "cpu" ? "Start CPU miners" :
            currentActionMode === "gpu" ? "Start GPU miners" :
                "Start ALL miners";

    if (!confirmAction(label)) return;

    setActionOutput(label + "…");

    if (currentActionMode === "cpu") {
        cpuStart();
    } else if (currentActionMode === "gpu") {
        gpuStart();
    } else if (currentActionMode === "all") {
        cpuStart();             // ✅ ALL = CPU + GPU
        gpuStart();
    }
}

function actionStop() {
    const label =
        currentActionMode === "cpu" ? "Stop CPU miners" :
            currentActionMode === "gpu" ? "Stop GPU miners" :
                "Stop ALL miners";

    if (!confirmAction(label)) return;

    setActionOutput(label + "…");

    if (currentActionMode === "cpu") {
        cpuStop();
    } else if (currentActionMode === "gpu") {
        gpuStop();
    } else if (currentActionMode === "all") {
        cpuStop();
        gpuStop();
    }
}

function actionRestart() {
    const label =
        currentActionMode === "cpu" ? "Restart CPU miners" :
            currentActionMode === "gpu" ? "Restart GPU miners" :
                "Restart ALL miners";

    if (!confirmAction(label)) return;

    setActionOutput(label + "…");

    if (currentActionMode === "cpu") {
        cpuRestart();
    } else if (currentActionMode === "gpu") {
        gpuRestart();
    } else if (currentActionMode === "all") {
        cpuRestart();
        gpuRestart();
    }
}

function gpuStart() {
    sendCommandToSelectedRigs("gpu.start");
}

function gpuStop() {
    sendCommandToSelectedRigs("gpu.stop");
}

function gpuRestart() {
    sendCommandToSelectedRigs("gpu.restart");
}

function cpuStart() {
    sendCommandToSelectedRigs("cpu.start");
}

function cpuStop() {
    sendCommandToSelectedRigs("cpu.stop");
}

function cpuRestart() {
    sendCommandToSelectedRigs("cpu.restart");
}

function setModeCPU() {
    sendCommandToSelectedRigs("mode.set CPU");
}

function setModeGPU() {
    sendCommandToSelectedRigs("mode.set GPU");
}

function rebootSystem() {
    if (!confirm("Reboot selected rigs?")) return;
    sendCommandToSelectedRigs("reboot");
}

function runRawShell(commandText) {
    if (!commandText || !commandText.trim()) return;
    sendCommandToSelectedRigs(commandText);
}

// =====================================================
// SYSTEM ACTIONS
// =====================================================

async function hardReset(ev) {
    ev.preventDefault();
    ev.stopPropagation();

    resetInProgress = true;
    setResetButtonDisabled(true);

    if (!window.confirm("Clear all known rigs and reload fresh data?")) {
        resetInProgress = false;
        setResetButtonDisabled(false);
        return;
    }

    try {
        await fetch(`${API}/reset`, { method: "POST" });
    } finally {
        resetInProgress = false;
        setResetButtonDisabled(false);
    }
}


// =====================================================
// ADDITIONAL EVENT HANDLERS & KEYBOARD SHORTCUTS
// =====================================================

// Add keyboard shortcuts
document.addEventListener("keydown", (e) => {
    // Ctrl/Cmd + Enter to send command
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        const cmdModal = document.getElementById("cmd-modal");
        if (cmdModal && !cmdModal.classList.contains("hidden")) {
            submitCmd();
            e.preventDefault();
        }
    }
    
    // Ctrl/Cmd + S to save flightsheet
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        const fsModal = document.getElementById("fs-modal");
        if (fsModal && !fsModal.classList.contains("hidden")) {
            saveFlightsheetFromDialog();
        }
    }
    
    // Ctrl/Cmd + A to select all (when not in input/textarea)
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        const activeElement = document.activeElement;
        if (activeElement.tagName !== "INPUT" && activeElement.tagName !== "TEXTAREA") {
            e.preventDefault();
            toggleSelectAll();
        }
    }
});

// =====================================================
// POLLING / AUTO-REFRESH
// =====================================================
/*
setInterval(() => {
    if (Date.now() / 1000 - lastUpdateTs > 30) fetchRigsOnce();
}, 10000);
*/