"""Post-deploy checks through FastAPI and Nginx, without logging player tokens."""
import argparse
import asyncio
import json
import re
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

from websockets.asyncio.client import connect


def request(base, path, data=None, player=None, host_header=None):
    headers = {"Content-Type": "application/json"}
    if host_header:
        headers["Host"] = host_header
    if player:
        headers.update({"Authorization": f"Bearer {player['token']}", "X-Undercover-Player": player["player_id"]})
    req = Request(base + path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    with urlopen(req, timeout=8) as response:
        return response.read().decode(), response.headers.get("Content-Type", "")


async def check(base, revision, host_header=None):
    def fetch(path, data=None, player=None):
        return request(base, path, data, player, host_header)
    for attempt in range(20):
        try:
            health = json.loads(fetch("/health")[0])
            assert health["status"] == "ok" and health["revision"] == revision
            break
        except Exception:
            if attempt == 19:
                raise
            await asyncio.sleep(1)
    for route in ("/", "/party"):
        html, _ = fetch(route)
        assert 'dir="rtl"' in html
        assets = re.findall(r'(?:href|src)="(/undercover-assets/[^\"]+)"', html)
        assert len(assets) >= 3
        for asset in assets:
            body, content_type = fetch(asset)
            if ".css" in asset:
                assert "text/css" in content_type and "--bg: #f5f3ef" in body and "--primary: #4d6f7d" in body
            else:
                assert "javascript" in content_type and len(body) > 100
    host = json.loads(fetch("/api/rooms", {"name": "فحص المضيف"})[0])
    code = host["room_code"]
    guests = [json.loads(fetch(f"/api/rooms/{code}/join", {"name": f"فحص لاعب {i}"})[0]) for i in (1, 2)]
    for player in (host, *guests):
        snapshot = json.loads(fetch(f"/api/rooms/{code}/state", player=player)[0])
        assert snapshot["self"]["id"] == player["player_id"] and "secret" not in snapshot
    parsed = urlsplit(base)
    origin = f"{parsed.scheme}://{host_header}" if host_header else base
    ws_url = origin.replace("http://", "ws://").replace("https://", "wss://")
    transport = {"host": parsed.hostname, "port": parsed.port} if host_header else {}
    async with connect(f"{ws_url}/ws/{code}", origin=origin, open_timeout=8, **transport) as socket:
        await socket.send(json.dumps({"type": "auth", **host}))
        snapshot = json.loads(await asyncio.wait_for(socket.recv(), 8))
        assert snapshot["phase"] == "lobby" and len(snapshot["players"]) == 3
        await socket.send(json.dumps({"type": "host_action", "action": "start_game"}))
        snapshot = json.loads(await asyncio.wait_for(socket.recv(), 8))
        assert snapshot["phase"] == "reveal" and "secret" in snapshot
        guest = json.loads(fetch(f"/api/rooms/{code}/state", player=guests[0])[0])
        assert guest["phase"] == "reveal" and "undercover" not in guest
    print(f"UNDERCOVER checks passed: {base}, revision {revision}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--host-header")
    args = parser.parse_args()
    asyncio.run(check(args.url.rstrip("/"), args.revision, args.host_header))
