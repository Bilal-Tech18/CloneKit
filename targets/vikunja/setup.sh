#!/usr/bin/env bash
# Lance deux instances Vikunja peuplées à l'identique : original (:3456) et "clone" (:3457).
# Usage : targets/vikunja/setup.sh 2.7.0 2.6.0
set -euo pipefail
source "$(dirname "$0")/lib.sh"
for side in orig clone; do
  version=$([ $side = orig ] && echo "${1:-2.7.0}" || echo "${2:-2.7.0}")
  echo "→ $side : vikunja $version sur :$(vk_port $side)"
  vk_start $side "$version"
  node "$VK_DIR/seed.mjs" "http://localhost:$(vk_port $side)" "$VK_DIR/data/$side/auth.json"
  vk_snapshot $side
done
