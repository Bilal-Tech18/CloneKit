# Fonctions partagées : une instance Vikunja = un conteneur + un dossier de données.
VK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# :4100 = front régénéré (targets/vikunja/front), branché sur le back « clone »
vk_name() { case "$1" in *:3456*) echo orig ;; *:3457*|*:4100*) echo clone ;; *) echo "port inconnu: $1" >&2; return 1 ;; esac; }
vk_port() { [ "$1" = orig ] && echo 3456 || echo 3457; }

vk_wait() {
  for _ in $(seq 1 60); do curl -sf "localhost:$1/api/v1/info" >/dev/null && return 0; sleep 0.25; done
  echo "Vikunja :$1 ne répond pas" >&2; return 1
}

vk_start() { # nom version
  local name=$1 version=$2 port; port=$(vk_port "$1")
  docker rm -f "ck-vk-$name" >/dev/null 2>&1 || true
  rm -rf "$VK_DIR/data/$name"; mkdir -p "$VK_DIR/data/$name/db"
  docker run -d --name "ck-vk-$name" -p "$port:3456" \
    -e VIKUNJA_SERVICE_PUBLICURL="http://localhost:$port/" -e VIKUNJA_SERVICE_SECRET=clonekit-secret \
    -e VIKUNJA_SERVICE_TIMEZONE=UTC -e VIKUNJA_FILES_BASEPATH=/db/files \
    -v "$VK_DIR/data/$name/db:/db" "vikunja/vikunja:$version" >/dev/null
  vk_wait "$port"
}

# SQLite en mode WAL : la base = vikunja.db + vikunja.db-wal (+ -shm). On copie les trois.
# Dates figées : l'UI de Vikunja dérive des choses de user.created (ex. le message d'accueil),
# deux instances seedées à quelques secondes d'écart ne sont donc pas identiques sans ça.
FROZEN_AT='2026-10-01 09:00:00'

vk_snapshot() { # nom
  docker stop "ck-vk-$1" >/dev/null
  for t in users projects tasks labels; do
    sqlite3 "$VK_DIR/data/$1/db/vikunja.db" "UPDATE $t SET created='$FROZEN_AT', updated='$FROZEN_AT';"
  done
  rm -rf "$VK_DIR/data/$1/seed"; mkdir -p "$VK_DIR/data/$1/seed"
  cp "$VK_DIR/data/$1/db/"vikunja.db* "$VK_DIR/data/$1/seed/"
  docker start "ck-vk-$1" >/dev/null && vk_wait "$(vk_port "$1")"
}

vk_reset() { # nom
  docker stop -t 1 "ck-vk-$1" >/dev/null
  rm -f "$VK_DIR/data/$1/db/"vikunja.db*
  cp "$VK_DIR/data/$1/seed/"vikunja.db* "$VK_DIR/data/$1/db/"
  docker start "ck-vk-$1" >/dev/null && vk_wait "$(vk_port "$1")"
}
