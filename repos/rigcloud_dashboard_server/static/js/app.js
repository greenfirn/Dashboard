let rigsState = {};
let popoverState = {};
let lastUpdateTs = 0;
let resetInProgress = false;
let selectedRigs = new Set();
let currentActionMode = localStorage.getItem("actionMode") || "all";

document.addEventListener("DOMContentLoaded", () => {
    // Toggle select all
    document
        .getElementById("btn-toggle-select")
        ?.addEventListener("click", toggleSelectAll);

    // Open command modal
    document
        .getElementById("btn-send-cmd")
        ?.addEventListener("click", openCmdModal);

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

	// 👇 THIS is what makes GPU stick
    setActionMode(currentActionMode);
});

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


function fmtXmrig(hs) {
    return hs > 0
        ? `${(hs / 1e3).toFixed(1)} kH/s`
        : null;
}

/* -------------------- Uptime Formatter -------------------- */
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

/* -------------------- WebSocket -------------------- */
function getWebSocketUrl() {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    return proto + location.host + "/dashboard/ws";
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

/* -------------------- HTTP Fallback -------------------- */
async function fetchRigsOnce() {
    try {
        const res = await fetch("/dashboard/rigs");
        if (!res.ok) return;
        rigsState = await res.json();
        lastUpdateTs = Date.now() / 1000;
        render();
    } catch {}
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

function hasPositiveRate(hs) {
    return typeof hs === "number" && hs > 0;
}

function updateActionStats() {
    const wattsEl = document.getElementById("stat-gpu-watts");
    const hashEl  = document.getElementById("stat-hashrate");

    if (!wattsEl || !hashEl) return;

    let totalWatts = 0;

    // Per-miner totals (H/s)
    const minerTotals = {
        bzminer: 0,
        xmrig: 0,
        rigel: 0,
		lolminer: 0,
        srb_gpu: 0,
        srb_cpu: 0,
		wildrig: 0,
		onezerominer: 0,
    };

    // Scope:
    // - selected rigs if any
    // - otherwise all rigs
    const rigNames =
        selectedRigs.size > 0
            ? Array.from(selectedRigs)
            : Object.keys(rigsState).filter(n => n !== "rigs");

    rigNames.forEach(name => {
        const d = rigsState[name]?.data;
        if (!d) return;

        /* ---------------- GPU watts ---------------- */
        if (Array.isArray(d.gpus)) {
            d.gpus.forEach(gpu => {
                if (typeof gpu.power_watts === "number") {
                    totalWatts += gpu.power_watts;
                }
            });
        }

        /* ---------------- Miners ---------------- */

        // BzMiner
        if (d.miner_bzminer) {
            if (typeof d.miner_bzminer.total_hs === "number") {
                minerTotals.bzminer += d.miner_bzminer.total_hs;
            } else if (typeof d.miner_bzminer.total_mhs === "number") {
                minerTotals.bzminer += d.miner_bzminer.total_mhs * 1e6;
            }
        }

        // XMRig
        if (typeof d.miner_xmrig?.total_hs === "number") {
            minerTotals.xmrig += d.miner_xmrig.total_hs;
        }

        // Rigel
        if (typeof d.miner_rigel?.total_hs === "number") {
            minerTotals.rigel += d.miner_rigel.total_hs;
        }

		// lolMiner
        if (typeof d.miner_lolminer?.total_hs === "number") {
            minerTotals.lolminer += d.miner_lolminer.total_hs;
        }

        // SRBMiner (split)
        if (typeof d.miner_srbminer?.gpu_hs === "number") {
            minerTotals.srb_gpu += d.miner_srbminer.gpu_hs;
        }
        if (typeof d.miner_srbminer?.cpu_hs === "number") {
            minerTotals.srb_cpu += d.miner_srbminer.cpu_hs;
        }
		// wildrig
        if (typeof d.miner_wildrig?.total_hs === "number") {
            minerTotals.wildrig += d.miner_wildrig.total_hs;
        }
        // onezerominer
        if (typeof d.miner_onezerominer?.total_hs === "number") {
            minerTotals.onezerominer += d.miner_onezerominer.total_hs;
        }
    });

    /* ---------------- Render GPU watts ---------------- */
    wattsEl.textContent =
        totalWatts > 0
            ? `GPU W: ${Math.round(totalWatts)}`
            : "GPU W: --";

    /* ---------------- Render miner totals ---------------- */
    const minerParts = [];

    if (minerTotals.bzminer > 0) {
        minerParts.push(`BzMiner ${fmtRateHs(minerTotals.bzminer, "")}`);
    }

    if (minerTotals.xmrig > 0) {
        minerParts.push(`XMRig ${fmtRateHs(minerTotals.xmrig, "")}`);
    }

    if (minerTotals.rigel > 0) {
        minerParts.push(`Rigel ${fmtRateHs(minerTotals.rigel, "")}`);
    }

	if (minerTotals.lolminer > 0) {
        minerParts.push(`lolMiner ${fmtRateHs(minerTotals.lolminer, "")}`);
    }

    if (minerTotals.srb_gpu > 0 || minerTotals.srb_cpu > 0) {
        const parts = [];

        if (minerTotals.srb_gpu > 0) {
            parts.push(`GPU ${fmtRateHs(minerTotals.srb_gpu, "")}`);
        }
        if (minerTotals.srb_cpu > 0) {
            parts.push(`CPU ${fmtRateHs(minerTotals.srb_cpu, "")}`);
        }

        minerParts.push(`SRBMiner ${parts.join(" | ")}`);
    }
	
	if (minerTotals.wildrig > 0) {
        minerParts.push(`Wildrig ${fmtRateHs(minerTotals.wildrig, "")}`);
    }
	
	if (minerTotals.onezerominer > 0) {
        minerParts.push(`OneZeroMiner ${fmtRateHs(minerTotals.onezerominer, "")}`);
    }

    hashEl.textContent =
        minerParts.length > 0
            ? minerParts.join(" | ")
            : "--";
}


/* -------------------- Render -------------------- */
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

        /* ---------------- CPU ---------------- */
        const cpuTemp = d.cpu_temp !== null ? Number(d.cpu_temp) : null;
        const cpuTempStr = cpuTemp !== null ? cpuTemp.toFixed(0) : "--";

        let cpuTempClass = "status-good";
        if (cpuTemp !== null) {
            if (cpuTemp >= 75) cpuTempClass = "status-hot";
            else if (cpuTemp >= 60) cpuTempClass = "status-warm";
        }

        const cpuUtil = d.cpu_usage !== undefined ? d.cpu_usage.toFixed(0) : "--";
        const load1  = d.load?.["1m"]  ?? "--";
        const load5  = d.load?.["5m"]  ?? "--";
        const load15 = d.load?.["15m"] ?? "--";

        /* ---------------- RAM ---------------- */
        let ramStr = "--";
        if (d.memory?.total_mb && d.memory.used_mb !== undefined) {
            ramStr = `${(d.memory.used_mb / 1024).toFixed(1)} / ${(d.memory.total_mb / 1024).toFixed(1)}`;
        }

        /* ---------------- GPU ---------------- */
        const gpu = d.gpus?.[0] ?? {};
        const gpuTemp = gpu.temp !== undefined ? Number(gpu.temp) : null;
        const gpuTempStr = gpuTemp !== null ? gpuTemp.toFixed(0) : "--";

        let gpuTempClass = "status-good";
        if (gpuTemp !== null) {
            if (gpuTemp >= 75) gpuTempClass = "status-hot";
            else if (gpuTemp >= 60) gpuTempClass = "status-warm";
        }

        const gpuUtil  = gpu.util ?? "--";
        const gpuPower = gpu.power_watts !== undefined ? gpu.power_watts.toFixed(1) : "--";
        const gpuFan   = gpu.fan_percent ?? "--";
        const coreMHz  = gpu.sm_clock ?? "--";
        const memMHz   = gpu.mem_clock ?? "--";

        let vramGB = "--";
        if (gpu.vram_used !== undefined && gpu.vram_total !== undefined) {
            vramGB = `${(gpu.vram_used / 1024).toFixed(1)} / ${(gpu.vram_total / 1024).toFixed(1)}`;
        }

        let fanClass = "status-good";
        if (gpuFan !== "--") {
            if (gpuFan >= 80) fanClass = "status-hot";
            else if (gpuFan >= 50) fanClass = "status-warm";
        }

        /* ---------------- Services ---------------- */
        const cpuServiceClass = d.cpu_service?.state === "active" ? "service-ok" : "service-bad";
        const gpuServiceClass = d.gpu_service?.state === "active" ? "service-ok" : "service-bad";

        /* ---------------- Docker ---------------- */
        const dockerList = d.docker ?? [];

        let dockerLeft = `<div class="docker-header">Docker Containers (${dockerList.length})</div>`;
        dockerLeft += dockerList.length === 0
            ? "<i>No containers</i>"
            : dockerList.map(c => `
                <div>
                    <b>${c.name}</b><br>
                    <span>${c.image}</span><br>
                    <span style="color:#aaa">state: ${c.state}, up: ${fmtUptime(c.uptime_seconds)}</span>
                </div>
            `).join("");

        /* ---------------- Miners ---------------- */
        const rg  = d.miner_rigel;
        const srb = d.miner_srbminer;
        const bz  = d.miner_bzminer;
        const xm  = d.miner_xmrig;
		const lm  = d.miner_lolminer;
		const wr  = d.miner_wildrig;
		const oz  = d.miner_onezerominer;
		
        let minerRight = "";

        /* ----- BzMiner ----- */
        if (
            bz &&
            hasPositiveRate(
                bz.total_hs ??
                    (bz.total_mhs ? bz.total_mhs * 1e6 : 0)
            )
        ) {
            const rate = fmtRateHs(
                bz.total_hs ??
                    (bz.total_mhs ? bz.total_mhs * 1e6 : null),
                ""
            );

            minerRight += `
                <div class="miner-row">
                    <b>BzMiner</b> — ${rate}
                    <span style="float:right;color:#aaa">
                        ${fmtUptime(bz.uptime_s)}
                    </span>
                </div>`;
        }

        /* ----- XMRig ----- */
        if (xm && hasPositiveRate(xm.total_hs)) {
            const rate = fmtXmrig(xm.total_hs);

            minerRight += `
                <div class="miner-row">
                    <b>XMRig</b> — ${rate}
                    <span style="float:right;color:#aaa">
                        ${fmtUptime(xm.uptime_s)}
                    </span>
                </div>`;
        }

        /* ----- Rigel ----- */
        if (rg && hasPositiveRate(rg.total_hs)) {
            const rate = fmtRateHs(rg.total_hs, "");

            minerRight += `
                <div class="miner-row">
                    <b>Rigel</b> — ${rate}
                    <span style="float:right;color:#aaa">
                        ${fmtUptime(rg.uptime_s)}
                    </span>
                </div>`;
        }

        /* ----- lolMiner ----- */
        if (lm && hasPositiveRate(lm.total_hs)) {
            const rate = fmtRateHs(lm.total_hs, "");

            minerRight += `
                <div class="miner-row">
                    <b>lolMiner</b> — ${rate}
                    <span style="float:right;color:#aaa">
                        ${fmtUptime(lm.uptime_s)}
                    </span>
                </div>`;
        }

        /* ----- SRBMiner ----- */
        if (srb) {
                let parts = [];

                if (hasPositiveRate(srb.gpu_hs)) {
                        parts.push(`GPU ${fmtRateHs(srb.gpu_hs, "")}`);
                }

                if (hasPositiveRate(srb.cpu_hs)) {
                        parts.push(`CPU ${fmtRateHs(srb.cpu_hs, "")}`);
                }

                if (parts.length > 0) {
                        minerRight += `
                <div class="miner-row">
                        <b>SRBMiner</b> — ${parts.join(" | ")}
                        <span style="float:right;color:#aaa">
                                ${fmtUptime(srb.uptime_s)}
                        </span>
                </div>`;
                }
        }

        /* ----- WildRig ----- */
        if (wr && hasPositiveRate(wr.total_hs)) {
            const rate = fmtRateHs(wr.total_hs, "");

            minerRight += `
                <div class="miner-row">
                    <b>WildRig</b> — ${rate}
                    <span style="float:right;color:#aaa">
                        ${fmtUptime(wr.uptime_s)}
                    </span>
                </div>`;
        }

        /* ----- OneZeroMiner ----- */
        if (oz && hasPositiveRate(oz.total_hs)) {
            const rate = fmtRateHs(oz.total_hs, "");

            minerRight += `
                <div class="miner-row">
                    <b>OneZeroMiner</b> — ${rate}
                    <span style="float:right;color:#aaa">
                        ${fmtUptime(oz.uptime_s)}
                    </span>
                </div>`;
        }

        /* ----- Header only if something rendered ----- */
        if (minerRight !== "") {
            minerRight =
                `<div class="docker-header">Miners</div>` +
                minerRight;
        }

        /* ---------------- Row Summary ---------------- */
        const minerSummary = [
            bz
                ? fmtRateHs(
                    bz.total_hs ??
                        (bz.total_mhs ? bz.total_mhs * 1e6 : null),
                    "BzMiner"
                )
                : null,

            xm?.total_hs > 0
                ? `${fmtXmrig(xm.total_hs)} XMRig`
                : null,

            rg?.total_hs > 0
                ? fmtRateHs(rg.total_hs, "Rigel")
                : null,

            lm?.total_hs > 0
                ? fmtRateHs(lm.total_hs, "lolMiner")
                : null,

            srb
                ? [
                        hasPositiveRate(srb.gpu_hs)
                            ? `GPU ${fmtRateHs(srb.gpu_hs, "")} SRBMiner`
                            : null,

                        hasPositiveRate(srb.cpu_hs)
                            ? `CPU ${fmtRateHs(srb.cpu_hs, "")} SRBMiner`
                            : null
                  ]
                        .filter(Boolean)
                        .join(" | ")
                : null,
			
			wr?.total_hs > 0
                ? fmtRateHs(wr.total_hs, "Wildrig")
                : null,
            
			oz?.total_hs > 0
                ? fmtRateHs(oz.total_hs, "Onezerominer")
                : null,
        ]
            .filter(Boolean)
            .join(" | ");


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

        main.insertAdjacentHTML("beforeend", `
            <div class="metric"><span class="${cpuTempClass}">${cpuTempStr}</span></div>
            <div class="metric">${cpuUtil}</div>
            <div class="metric">${load1} / ${load5} / ${load15}</div>
            <div class="metric">${ramStr}</div>
            <div class="metric"><span class="${gpuTempClass}">${gpuTempStr}</span></div>
            <div class="metric">${gpuUtil}</div>
            <div class="metric">${gpuPower}</div>
            <div class="metric"><span class="${fanClass}">${gpuFan}</span></div>
            <div class="metric">${vramGB}</div>
            <div class="metric">${coreMHz}</div>
            <div class="metric">${memMHz}</div>
            <div class="metric"><span class="${cpuServiceClass}">CPU</span></div>
            <div class="metric"><span class="${gpuServiceClass}">GPU</span></div>
            <div class="metric">${dockerList.length}</div>
            <div class="metric metric-left">${minerSummary}</div>
        `);

        row.appendChild(main);

        /* ----- Popover ----- */
        const pop = document.createElement("div");
        pop.id = `docker-${safeId}`;
        pop.className = "docker-popover";
        pop.style.display = open ? "flex" : "none";

        pop.addEventListener("click", ev => ev.stopPropagation());
		pop.innerHTML = `
    <div class="pop-content">
        <div class="pop-left"></div>

        <div class="pop-right">
            <div class="pop-row">
                <div class="pop-section pop-docker">
                    ${dockerLeft}
                </div>

                <div class="pop-section pop-miners">
                    ${minerRight}
                </div>
            </div>
        </div>
    </div>
`;



        row.appendChild(pop);
        container.appendChild(row);
    });

    updateSelectButton();
	updateActionStats();
}

/* -------------------- Actions -------------------- */

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
        await fetch("/dashboard/reset", { method: "POST" });
    } finally {
        resetInProgress = false;
        setResetButtonDisabled(false);
    }
}

async function sendCommandToSelectedRigs(command) {
    if (selectedRigs.size === 0) {
        alert("No rigs selected");
        return;
    }

    return fetch("/dashboard/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            rigs: Array.from(selectedRigs),
            command: command
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

/* -------------------- UI helpers -------------------- */

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

function actionStart() {
    const label =
        currentActionMode === "cpu"    ? "Start CPU miners" :
        currentActionMode === "gpu"    ? "Start GPU miners" :
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
        currentActionMode === "cpu"    ? "Stop CPU miners" :
        currentActionMode === "gpu"    ? "Stop GPU miners" :
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
        currentActionMode === "cpu"    ? "Restart CPU miners" :
        currentActionMode === "gpu"    ? "Restart GPU miners" :
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


function updateSelectButton() {
    const btn = document.getElementById("btn-toggle-select");
    if (!btn) return;

    const total = Object.keys(rigsState).length;

    btn.textContent =
        selectedRigs.size === total && total > 0 ? "☑" : "☐";
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


function openCmdModal() {
    if (selectedRigs.size === 0) {
        alert("No rigs selected");
        return;
    }

    document.getElementById("cmd-target-count").textContent =
        selectedRigs.size;

    const modal = document.getElementById("cmd-modal");
    const input = document.getElementById("cmd-input");

    const out = document.getElementById("cmd-output");
    if (out) out.textContent = "";

    modal.classList.remove("hidden");
    input.value = "";
    input.focus();
}

function closeCmdModal() {
    document.getElementById("cmd-modal").classList.add("hidden");
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

/* -------------------- Init -------------------- */
initWebSocket();
fetchRigsOnce();

setInterval(() => {
    if (Date.now() / 1000 - lastUpdateTs > 30) fetchRigsOnce();
}, 10000);
