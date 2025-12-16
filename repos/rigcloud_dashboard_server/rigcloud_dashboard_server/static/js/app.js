let rigsState = {};
let popoverState = {};
let lastUpdateTs = 0;
let resetInProgress = false;
let selectedRigs = new Set();

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("btn-toggle-select")?.addEventListener("click", () => {
        toggleSelectAll();
    });
});

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

            if (msg.rigs) {
                rigsState = msg.rigs;
                lastUpdateTs = Date.now() / 1000;
                render();
                return;
            }

            if (msg.rig && msg.data) {
                rigsState[msg.rig] = {
                    timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
                    data: msg.data
                };
                lastUpdateTs = Date.now() / 1000;
                render();
                return;
            }

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
    const rigNames = Object.keys(rigsState);

    if (rigNames.length === 0) {
        return;
    }

    // If ALL rigs are selected → clear
    if (selectedRigs.size === rigNames.length) {
        selectedRigs.clear();
    } 
    // Otherwise → select all
    else {
        selectedRigs.clear();
        rigNames.forEach(name => selectedRigs.add(name));
    }

    render();
}

function updateSelectButton() {
    const btn = document.getElementById("btn-toggle-select");
    if (!btn) return;

    const total = Object.keys(rigsState).length;

    btn.textContent =
        selectedRigs.size === total && total > 0 ? "☑" : "☐";
}


/* -------------------- Render -------------------- */
function render() {
    if (resetInProgress) return;

    const container = document.getElementById("rig-container");
    container.innerHTML = "";

    const rigNames = Object.keys(rigsState).sort();

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
            ramStr = `${(d.memory.used_mb / 1024).toFixed(1)} / ${(d.memory.total_mb / 1024).toFixed(1)} GB`;
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
            vramGB = `${(gpu.vram_used / 1024).toFixed(1)} / ${(gpu.vram_total / 1024).toFixed(1)} GB`;
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
        const bz = d.miner_bzminer;
        const xm = d.miner_xmrig;

        let minerRight = "";
        if (bz || xm) minerRight += `<div class="docker-header">Miners</div>`;

        if (bz) {
            minerRight += `
                <div class="miner-row">
                    <b>BzMiner</b> — ${bz.total_mhs?.toFixed(2) ?? "--"} MH/s
                    <span style="float:right;color:#aaa">${fmtUptime(bz.uptime_s)}</span>
                </div>`;
        }

        if (xm) {
            const rate =
                xm.total_khs ? `${xm.total_khs.toFixed(2)} kH/s` :
                xm.total_hs ? `${xm.total_hs} H/s` : "--";

            minerRight += `
                <div class="miner-row">
                    <b>XMRig</b> — ${rate}
                    <span style="float:right;color:#aaa">${fmtUptime(xm.uptime_s)}</span>
                </div>`;
        }

        /* ---------------- Summary ---------------- */
        const minerSummary = [
            bz?.total_mhs > 0 ? `${bz.total_mhs.toFixed(1)} MH/s BzMiner` : null,
            xm?.total_khs > 0 ? `${xm.total_khs.toFixed(1)} kH/s XMrig` :
            xm?.total_hs > 0 ? `${xm.total_hs.toFixed(0)} H/s XMrig` : null
        ].filter(Boolean).join(" | ");

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
            <div class="metric"><span class="${cpuTempClass}">${cpuTempStr}°C</span></div>
            <div class="metric">${cpuUtil}%</div>
            <div class="metric">${load1} / ${load5} / ${load15}</div>
            <div class="metric">${ramStr}</div>
            <div class="metric"><span class="${gpuTempClass}">${gpuTempStr}°C</span></div>
            <div class="metric">${gpuUtil}%</div>
            <div class="metric">${gpuPower}W</div>
            <div class="metric"><span class="${fanClass}">${gpuFan}%</span></div>
            <div class="metric">${vramGB}</div>
            <div class="metric">${coreMHz} MHz</div>
            <div class="metric">${memMHz} MHz</div>
            <div class="metric"><span class="${cpuServiceClass}">CPU</span></div>
            <div class="metric"><span class="${gpuServiceClass}">GPU</span></div>
            <div class="metric metric-left">${minerSummary}</div>
            <div class="metric">${dockerList.length}</div>
        `);

        row.appendChild(main);

        /* ----- Popover ----- */
        const pop = document.createElement("div");
        pop.id = `docker-${safeId}`;
        pop.className = "docker-popover";
        pop.style.display = open ? "flex" : "none";

        pop.addEventListener("click", ev => ev.stopPropagation());

        pop.innerHTML = `
            <div class="pop-left">${dockerLeft}</div>
            <div class="pop-right">${minerRight}</div>
        `;

        row.appendChild(pop);
        container.appendChild(row);
    });

    updateSelectButton();
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

function setResetButtonDisabled(disabled) {
    const btn = document.querySelector(".reset-btn");
    if (!btn) return;
    btn.classList.toggle("disabled", disabled);
    btn.style.pointerEvents = disabled ? "none" : "auto";
}

/* -------------------- UI helpers -------------------- */
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
