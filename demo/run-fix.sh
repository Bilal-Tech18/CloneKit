#!/usr/bin/env bash
# Démo de la boucle de correction : l'original tourne, le clone (demo/clone) est corrigé par un agent.
set -euo pipefail
cd "$(dirname "$0")/.."
node demo/original/app.mjs & P1=$!
trap 'kill $P1 2>/dev/null' EXIT
sleep 1
npx tsx src/cli.ts fix --original http://localhost:4001 --clone http://localhost:4002 \
  --source demo/clone --serve "node app.mjs" --scenarios scenarios --reset-path /__reset \
  --out out/demo-fix "$@"
