#!/bin/bash
# All commands dispatched from MQTT come through this script.
#
# user ALL=(ALL) NOPASSWD: /home/user/rigcloud_cmd.sh

set -e

LOG="/home/user/rigcloud_cmd.log"

GPU_SERVICE="docker_events_gpu.service"
CPU_SERVICE="docker_events_cpu.service"
COMMON_SERVICE="docker_events.service"

# --------------------------------------------------
# Read entire command from STDIN (multi-line safe)
# --------------------------------------------------
RAW_CMD="$(cat)"

if [[ -z "$RAW_CMD" ]]; then
    echo "No command received"
    exit 1
fi

echo "==================================================" >> "$LOG"
echo "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
echo "$RAW_CMD" >> "$LOG"

# --------------------------------------------------
# Parse first line for structured commands
# --------------------------------------------------
FIRST_LINE="$(echo "$RAW_CMD" | head -n1)"
CMD="$(echo "$FIRST_LINE" | awk '{print $1}')"
ARG="$(echo "$FIRST_LINE" | cut -d' ' -f2-)"

case "$CMD" in

    ############################################################
    # GPU Miner Controls
    ############################################################
    gpu.start)
        systemctl start "$GPU_SERVICE"
        echo "Started $GPU_SERVICE"
        ;;

    gpu.stop)
        systemctl stop "$GPU_SERVICE"
        echo "Stopped $GPU_SERVICE"
        ;;

    gpu.restart)
        systemctl restart "$GPU_SERVICE"
        echo "Restarted $GPU_SERVICE"
        ;;

    ############################################################
    # CPU Miner Controls
    ############################################################
    cpu.start)
        systemctl start "$CPU_SERVICE"
        echo "Started $CPU_SERVICE"
        ;;

    cpu.stop)
        systemctl stop "$CPU_SERVICE"
        echo "Stopped $CPU_SERVICE"
        ;;

    cpu.restart)
        systemctl restart "$CPU_SERVICE"
        echo "Restarted $CPU_SERVICE"
        ;;

    ############################################################
    # COMMON Service Controls
    ############################################################
    common.start)
        systemctl start "$COMMON_SERVICE"
        echo "Started $COMMON_SERVICE"
        ;;

    common.stop)
        systemctl stop "$COMMON_SERVICE"
        echo "Stopped $COMMON_SERVICE"
        ;;

    common.restart)
        systemctl restart "$COMMON_SERVICE"
        echo "Restarted $COMMON_SERVICE"
        ;;

    ############################################################
    # MODE SWITCHING
    ############################################################
    mode.set)
        MODE="$(echo "$ARG" | tr '[:lower:]' '[:upper:]')"

        systemctl stop "$CPU_SERVICE" "$GPU_SERVICE" "$COMMON_SERVICE"
        systemctl disable "$CPU_SERVICE" "$GPU_SERVICE" "$COMMON_SERVICE"

        if [[ "$MODE" == "CPU" ]]; then
            systemctl enable "$CPU_SERVICE"
            systemctl start "$CPU_SERVICE"
            echo "Mode changed → CPU"

        elif [[ "$MODE" == "GPU" ]]; then
            systemctl enable "$GPU_SERVICE"
            systemctl start "$GPU_SERVICE"
            echo "Mode changed → GPU"

        elif [[ "$MODE" == "COMMON" ]]; then
            systemctl enable "$COMMON_SERVICE"
            systemctl start "$COMMON_SERVICE"
            echo "Mode changed → COMMON"

        else
            echo "Invalid mode: $ARG"
            exit 1
        fi
        ;;

    ############################################################
    # SYSTEM REBOOT
    ############################################################
    reboot)
        echo "Rebooting system..."
        systemctl reboot
        ;;

    ############################################################
    # RAW MULTI-LINE SHELL COMMAND (DEFAULT)
    ############################################################
    *)
        echo "[RAW EXECUTION]"
        bash -c "$RAW_CMD"
        ;;
esac
