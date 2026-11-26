#!/usr/bin/env bash
# Installe Gmail Drive Stat comme application personnalisée de TrueNAS SCALE (24.10 ou plus récent).
#
# À lancer dans le shell de TrueNAS (System › Shell), en root :
#   curl -fsSL https://raw.githubusercontent.com/sylis/gmail-drive-stat/main/deploy/truenas/install.sh | sudo bash
#
# Le script crée un dataset pour la base SQLite, génère la clé de chiffrement, pose les questions
# nécessaires, puis déclare l'application auprès de TrueNAS : elle apparaît ensuite dans Apps, où l'on
# peut la modifier, la mettre à jour ou la supprimer comme les autres.
set -euo pipefail

APP_NAME="${APP_NAME:-gmail-drive-stat}"
IMAGE="${IMAGE:-ghcr.io/sylis/gmail-drive-stat:latest}"
APPS_UID=568

die() { echo "Erreur : $*" >&2; exit 1; }

# Lit une réponse au clavier, même quand le script arrive par « curl | bash ».
ask() {
  local prompt="$1" default="${2:-}" answer
  if [ -n "$default" ]; then prompt="$prompt [$default]"; fi
  read -r -p "$prompt : " answer </dev/tty || true
  printf '%s' "${answer:-$default}"
}

# Entoure une valeur de guillemets simples pour le YAML.
yaml_quote() { printf "'%s'" "${1//\'/\'\'}"; }

[ "$(id -u)" -eq 0 ] || die "lancez le script en root (sudo)."
command -v midclt >/dev/null || die "midclt introuvable : ce script ne tourne que sur TrueNAS SCALE."

echo "Installation de Gmail Drive Stat sur TrueNAS SCALE"
echo

# Pool et dataset de la base.
pools=$(midclt call pool.query '[]' '{"select": ["name"]}' | python3 -c 'import json,sys; print(" ".join(p["name"] for p in json.load(sys.stdin)))')
[ -n "$pools" ] || die "aucun pool de stockage trouvé."
pool=$(ask "Pool où ranger les données (disponibles : $pools)" "${pools%% *}")
dataset=$(ask "Dataset de l'application" "$pool/apps/$APP_NAME")
mountpoint="/mnt/$dataset"

if midclt call pool.dataset.query "[[\"id\", \"=\", \"$dataset\"]]" | grep -q '"id"'; then
  echo "Le dataset $dataset existe déjà, il est réutilisé."
else
  parent="${dataset%/*}"
  if [ "$parent" != "$dataset" ] && ! midclt call pool.dataset.query "[[\"id\", \"=\", \"$parent\"]]" | grep -q '"id"'; then
    midclt call pool.dataset.create "{\"name\": \"$parent\"}" >/dev/null
  fi
  midclt call pool.dataset.create "{\"name\": \"$dataset\"}" >/dev/null
  echo "Dataset $dataset créé."
fi
chown "$APPS_UID:$APPS_UID" "$mountpoint"
chmod 750 "$mountpoint"

# Clé de chiffrement : générée une fois, conservée dans le dataset pour les réinstallations.
keyfile="$mountpoint/.encryption-key"
if [ ! -s "$keyfile" ]; then
  head -c 32 /dev/urandom | base64 | tr -d '\n' >"$keyfile"
  chmod 600 "$keyfile"
fi
encryption_key=$(cat "$keyfile")

echo
echo "Google exige une adresse en HTTPS avec un nom de domaine (pas une adresse IP), sauf pour localhost."
echo "Indiquez l'adresse publique de votre proxy inverse, par exemple https://gmailstat.mondomaine.fr."
public_url=$(ask "Adresse de l'outil (PUBLIC_URL)")
[ -n "$public_url" ] || die "PUBLIC_URL est obligatoire."
port=$(ask "Port d'écoute sur TrueNAS" "8080")
allowed=$(ask "Adresses Google autorisées, séparées par des virgules (ALLOWED_EMAILS)")
[ -n "$allowed" ] || die "ALLOWED_EMAILS est obligatoire."
echo
echo "Identifiants OAuth de votre projet Google Cloud. Laissez vides pour les ajouter plus tard :"
echo "l'outil affiche alors le guide de création à l'adresse ${public_url%/}/."
client_id=$(ask "GOOGLE_CLIENT_ID")
client_secret=$(ask "GOOGLE_CLIENT_SECRET")

compose=$(cat <<YAML
services:
  gmailstat:
    image: $IMAGE
    user: "$APPS_UID:$APPS_UID"
    environment:
      PUBLIC_URL: $(yaml_quote "$public_url")
      GOOGLE_CLIENT_ID: $(yaml_quote "$client_id")
      GOOGLE_CLIENT_SECRET: $(yaml_quote "$client_secret")
      ALLOWED_EMAILS: $(yaml_quote "$allowed")
      ENCRYPTION_KEY: $(yaml_quote "$encryption_key")
      PORT: $(yaml_quote "$port")
      DATABASE_PATH: /data/gmailstat.sqlite
    ports:
      - "$port:$port"
    volumes:
      - $mountpoint:/data
    restart: unless-stopped
YAML
)

# Une copie sans secrets à côté de la base, pour s'y retrouver plus tard.
printf '%s\n' "$compose" | sed -E 's/^(\s+(GOOGLE_CLIENT_SECRET|ENCRYPTION_KEY): ).*/\1(masqué)/' >"$mountpoint/compose.reference.yaml"

payload=$(APP_NAME="$APP_NAME" COMPOSE="$compose" python3 -c '
import json, os
print(json.dumps({"custom_app": True, "app_name": os.environ["APP_NAME"], "custom_compose_config_string": os.environ["COMPOSE"]}))
')

echo
echo "Déclaration de l'application $APP_NAME auprès de TrueNAS (téléchargement de l'image)…"
if ! midclt call -j app.create "$payload" >/dev/null; then
  echo
  echo "TrueNAS a refusé la création automatique. Collez ce YAML dans Apps › Discover Apps › ⋮ › Install via YAML :"
  echo
  printf '%s\n' "$compose"
  exit 1
fi

echo
echo "C'est installé. L'application $APP_NAME apparaît dans Apps."
echo "Faites pointer votre proxy inverse vers http://<ip-de-truenas>:$port, puis ouvrez $public_url."
echo "La clé de chiffrement est gardée dans $keyfile : sauvegardez-la avec le dataset."
