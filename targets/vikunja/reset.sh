#!/usr/bin/env bash
# Restaure le snapshot de l'instance correspondant à l'URL donnée (appelé par clonekit via --reset-cmd).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
vk_reset "$(vk_name "$1")"
