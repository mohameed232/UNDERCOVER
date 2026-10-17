#!/usr/bin/env bash
set -euo pipefail
# One-time setup for this game only. No Nginx files are edited.
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ $# == 1 && -f "$1" ]] || { echo 'Usage: sudo bash deploy/setup-vps.sh /path/to/public-key.pub' >&2; exit 1; }
base=/opt/undercover
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -f "$base/app.py" && -x "$base/.venv/bin/python" ]] || { echo 'Existing /opt/undercover installation and .venv are required.' >&2; exit 1; }
[[ -f "$script_dir/receive.py" ]] || exit 1
[[ ! -L "$base/releases" ]] || { echo 'releases must be a directory inside UNDERCOVER.' >&2; exit 1; }
[[ ! -L "$base" ]] || { echo '/opt/undercover must be its own directory.' >&2; exit 1; }
if [[ -e "$base/current" || -L "$base/current" ]]; then
  [[ -L "$base/current" ]] || { echo 'current must be a symlink.' >&2; exit 1; }
  previous=$(readlink -f "$base/current")
  [[ "$previous" == "$base" || "$previous" == "$base/releases/"* ]] || { echo 'current points outside UNDERCOVER.' >&2; exit 1; }
fi
getent passwd undercover >/dev/null || useradd --system --user-group --home-dir /opt/undercover --shell /usr/sbin/nologin undercover
getent passwd undercover-deploy >/dev/null || useradd --system --user-group --create-home --home-dir /var/lib/undercover-deploy --shell /bin/bash undercover-deploy
[[ $(getent passwd undercover-deploy | cut -d: -f6) == /var/lib/undercover-deploy ]] || { echo 'Unexpected deploy account home; stopping.' >&2; exit 1; }
ssh-keygen -l -f "$1" >/dev/null
[[ $(wc -l < "$1") == 1 && $(cut -d' ' -f1 "$1") == ssh-ed25519 ]] || { echo 'Provide one Ed25519 public key.' >&2; exit 1; }
# Only the dedicated deploy account can write releases. The game process reads them.
chown undercover-deploy:undercover-deploy "$base"
chmod 755 "$base"
install -d -o undercover-deploy -g undercover-deploy -m 755 "$base/releases"
mkdir -p /usr/local/libexec
install -d -o root -g root -m 755 /var/lib/undercover-deploy/.ssh
chown root:root /var/lib/undercover-deploy
chmod 755 /var/lib/undercover-deploy
install -o root -g root -m 755 "$script_dir/receive.py" /usr/local/libexec/undercover-deploy
printf 'restrict,command="/usr/local/libexec/undercover-deploy" %s\n' "$(cat "$1")" > /var/lib/undercover-deploy/.ssh/authorized_keys
chown root:root /var/lib/undercover-deploy/.ssh/authorized_keys
chmod 644 /var/lib/undercover-deploy/.ssh/authorized_keys
sudoers=$(mktemp)
trap 'rm -f "$sudoers"' EXIT
printf '%s\n' 'undercover-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart undercover.service' > "$sudoers"
visudo -cf "$sudoers"
install -o root -g root -m 440 "$sudoers" /etc/sudoers.d/undercover-deploy
# Preserve the running legacy installation as the first rollback target.
if [[ ! -e "$base/current" && ! -L "$base/current" ]]; then
  sudo -u undercover-deploy ln -s "$base" "$base/current"
fi
[[ -L "$base/current" ]] || { echo '/opt/undercover/current must be a symlink.' >&2; exit 1; }
install -d -m 755 /etc/systemd/system/undercover.service.d
cat > /etc/systemd/system/undercover.service.d/20-undercover-releases.conf <<'UNIT'
[Service]
User=undercover
Group=undercover
WorkingDirectory=/opt/undercover/current
ExecStart=
ExecStart=/opt/undercover/current/.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8011 --workers 1 --proxy-headers --forwarded-allow-ips=127.0.0.1
Environment=PYTHONDONTWRITEBYTECODE=1
UNIT
systemctl daemon-reload
systemctl restart undercover.service
for attempt in {1..20}; do
  if curl --fail --silent http://127.0.0.1:8011/health; then
    echo
    echo 'UNDERCOVER deployment account is ready. Configure its Nginx block and GitHub environment next.'
    exit 0
  fi
  sleep 1
done
echo 'UNDERCOVER health check failed. Inspect: journalctl -u undercover.service -n 50' >&2
exit 1
