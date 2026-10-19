#!/usr/bin/env bash
# Démo complète : lance l'original et le clone, capture l'original, puis diff de parité.
set -euo pipefail
cd "$(dirname "$0")/.."
node demo/original/app.mjs & P1=$!
node demo/clone/app.mjs & P2=$!
trap 'kill $P1 $P2 2>/dev/null' EXIT
sleep 1
echo "── 1/2 Capture de l'original ──────────────────────────"
npx tsx src/cli.ts capture http://localhost:4001 --reset-path /__reset --out out/demo-capture
echo
echo "── 2/2 Diff de parité original ↔ clone ────────────────"
npx tsx src/cli.ts diff --original http://localhost:4001 --clone http://localhost:4002 --reset-path /__reset --out out/demo-diff
