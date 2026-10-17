# GitHub main → UNDERCOVER VPS

The workflow is committed, but deployment remains **disabled until the one-time setup below is completed**. Codex does not have your VPS login or the deployment key. No credentials belong in this repository or in ChatGPT.

After setup, a push to `main` runs Python tests, 200 Pass & Play simulations, and complete five-round browser games through a proxy with WebSockets enabled and blocked. Only the tested commit is packaged and sent over SSH. The VPS builds a release, switches `/opt/undercover/current`, and restarts **only `undercover.service`**. Health, CSS/JS, private HTTP state, and WebSocket checks run against both ports 8011 and 8081. Nginx checks explicitly use the public Host `8.213.86.128:8081` so they reach the intended game server block. Failure restores the previous release and fails the workflow.

The receiver is a root-owned fixed program. Its SSH key cannot open a shell, use SFTP/SCP, or forward ports. The dedicated `undercover-deploy` account can write the game releases and run exactly one sudo command: `systemctl restart undercover.service`. The running game uses the separate `undercover` account. The workflow never edits Nginx, firewall rules, SSH server settings, or another application's service.

## One-time setup: use your provider's browser VPS console

This is the only VPS console setup needed for future routine game updates. Start while no game is active: restarts discard in-memory rooms. The commands assume the existing repository and virtual environment are in `/opt/undercover`, as specified.

### 1. Fetch the setup files and create a dedicated deployment key

```bash
repo_owner=$(stat -c '%U' /opt/undercover/.git)
sudo -u "$repo_owner" git -C /opt/undercover pull --ff-only origin main
sudo apt-get update
sudo apt-get install -y python3-venv
sudo install -d -m 700 /root/undercover-setup
sudo ssh-keygen -t ed25519 -N '' -C github-actions-undercover -f /root/undercover-setup/actions_key
sudo bash /opt/undercover/deploy/setup-vps.sh /root/undercover-setup/actions_key.pub
```

Use a new dedicated key. Do not overwrite an existing key if `ssh-keygen` asks. Do not use your administrator key for Actions. The setup script installs:

- `/usr/local/libexec/undercover-deploy` — restricted receiver;
- `/var/lib/undercover-deploy/.ssh/authorized_keys` — root-owned forced-command public key;
- `/etc/sudoers.d/undercover-deploy` — permission for this service restart only;
- `/etc/systemd/system/undercover.service.d/20-undercover-releases.conf` — the game runs from `current` on `127.0.0.1:8011` with **one worker**.

It preserves the original game files and uses them as the first rollback target. Future releases live under `/opt/undercover/releases/<commit>`. The active release, previous release, and up to three additional releases are retained. Once configured, do not use `git pull` in the old root checkout to update the running game; use the workflow.

### 2. Correct only the existing UNDERCOVER Nginx server block

Locate the file declaring port 8081 without printing other applications' configuration:

```bash
sudo nginx -T 2>&1 | awk '/^# configuration file/{file=$0} /listen[[:space:]]+8081/{print file; print}'
```

Open that file in your VPS console editor. Merge the four `location` blocks in `/opt/undercover/deploy/nginx-undercover-8081.conf` into the **existing UNDERCOVER `server` block**. If old versions of those locations exist, replace them instead of adding duplicate locations. Preserve any existing HTTPS/access settings. Do not replace a shared file or create a second server listening for the same host on 8081.

The example sends `/undercover-assets/`, `/api/`, `/ws/`, and `/` to `127.0.0.1:8011`. It preserves the public Host including `:8081`, upgrades WebSockets, and bypasses inherited proxy caches. The `^~` asset route takes precedence over generic CSS/JS regex locations. Do not leave an old `alias` pointing at the original checkout: releases are served by FastAPI.

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail http://127.0.0.1:8011/health
curl --fail -I -H 'Host: 8.213.86.128:8081' http://127.0.0.1:8081/undercover-assets/css/styles.css
```

The current public URL is HTTP. Add HTTPS on a dedicated UNDERCOVER hostname for public use so game tokens and secret words are encrypted. The application supports `wss://` automatically; deployment SSH is already encrypted. No new public listener is created by this workflow.

### 3. Add two secrets through GitHub's website

Go to `mohameed232/UNDERCOVER` → **Settings → Environments → New environment**, name it **production**, and restrict deployment branches to **main**. Leave required reviewers disabled if you want unattended deployments.

Add these environment secrets:

| Secret | Value |
| --- | --- |
| `UNDERCOVER_SSH_KEY` | The complete private key in `/root/undercover-setup/actions_key`, including its BEGIN/END lines. Open it privately in the VPS console and paste it directly into GitHub's secret field. Never paste it into chat, a commit, or a workflow log. |
| `UNDERCOVER_KNOWN_HOSTS` | The verified public SSH host-key line produced by the command below on your VPS console. This is the VPS identity, not the deployment public key. |

For SSH on port 22:

```bash
sudo awk '{print "8.213.86.128 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

For a different SSH port, use `[8.213.86.128]:PORT` as the first field instead. This key comes from your trusted VPS console; the workflow will refuse an unexpected server identity. Do not disable host-key checking to bypass an error.

After saving the private key securely in GitHub, you can remove its VPS copy:

```bash
sudo rm /root/undercover-setup/actions_key
```

Keep the `.pub` file. GitHub runner connectivity must be allowed to your existing SSH port, and the SSH server must allow key authentication for `undercover-deploy`. No administrator shell access is granted to this key.

### 4. Enable deployments in GitHub and run the first deployment

Go to **Settings → Secrets and variables → Actions → Variables**, and add these **repository variables**:

| Variable | Value |
| --- | --- |
| `UNDERCOVER_DEPLOY_ENABLED` | `true` — add this last, after the VPS and secrets are ready |
| `UNDERCOVER_HOST` | `8.213.86.128` (also the workflow default) |
| `UNDERCOVER_SSH_PORT` | `22`, or your actual SSH port |

Open **Actions → Test and deploy UNDERCOVER → Run workflow → main**. Tests run before deployment. Watch both the `test` and `deploy` jobs; a skipped deploy job means the enable variable is missing or not `true`.

Once successful, open `http://8.213.86.128:8081/health`. Its `revision` must match the deployed GitHub commit. Reload the game, create a room, and join from a second phone. Subsequent pushes to `main` deploy automatically; you can continue editing through Codex Cloud or GitHub without VS Code or recurring terminal commands.

## Operation and recovery

- Active rooms are lost on every deployment/restart. State is in memory, so keep **one Uvicorn worker**.
- Private HTTP polling is the fallback when WebSocket upgrades fail; it normally synchronizes within 1.5 seconds. WebSockets are still checked during deployment so proxy errors are not silently accepted.
- If tests fail, nothing is deployed. If dependency installation fails, the running release stays active. If post-restart checks fail, the receiver restores the previous symlink and restarts UNDERCOVER; inspect the failed Actions log. An OS-level service failure can still require VPS attention.
- Revert a bad application commit using GitHub's Revert/PR flow and merge to main to deploy a corrected version. No force-push is needed.
- Deployment receiver or systemd/Nginx configuration changes need a deliberate one-time console update; the restricted key cannot update its own permissions or system configuration.
- Nginx configuration, the real VPS, and the first Actions run must be verified on your server. Local tests cannot establish that these one-time steps have been completed.
