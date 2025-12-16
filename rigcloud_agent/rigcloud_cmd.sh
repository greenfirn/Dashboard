#!/bin/bash
# All commands dispatched from MQTT come through this script.

CMD="$1"
ARG="$2"
LOG="/home/user/rigcloud_cmd.log"

# ============================================
# SERVICE NAME VARIABLES
# ============================================
GPU_SERVICE="docker_events_gpu.service"
CPU_SERVICE="docker_events_cpu.service"
COMMON_SERVICE="docker_events.service"

echo "$(date '+%Y-%m-%d %H:%M:%S') cmd=$CMD arg=$ARG" >> "$LOG"

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
    # MODE SWITCHING (CPU / GPU / COMMON)
    ############################################################
    mode.set)
        MODE=$(echo "$ARG" | tr '[:lower:]' '[:upper:]')

        # STOP + DISABLE ALL SERVICES FIRST
        systemctl stop "$CPU_SERVICE"
        systemctl stop "$GPU_SERVICE"
        systemctl stop "$COMMON_SERVICE"

        systemctl disable "$CPU_SERVICE"
        systemctl disable "$GPU_SERVICE"
        systemctl disable "$COMMON_SERVICE"

        echo "All services stopped and disabled"

        # NOW SWITCH TO THE SELECTED MODE
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
        fi
        ;;

    ############################################################
    # SYSTEM REBOOT
    ############################################################
    reboot)
        echo "Rebooting..."
        systemctl reboot
        ;;

    ############################################################
    # UNKNOWN COMMAND
    ############################################################
    *)
        echo "Unknown command: $CMD"
        ;;
esac
