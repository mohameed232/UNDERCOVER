import time

import pytest
from fastapi.testclient import TestClient

from app import app, http_presence, rooms


client = TestClient(app)


def headers(player):
    return {"Authorization": f"Bearer {player['token']}", "X-Undercover-Player": player["player_id"]}


def state(player):
    result = client.get(f"/api/rooms/{player['room_code']}/state", headers=headers(player))
    assert result.status_code == 200
    assert result.headers["cache-control"] == "no-store"
    return result.json()


def action(player, **message):
    return client.post(f"/api/rooms/{player['room_code']}/actions", headers=headers(player), json=message)


def players_in_room(count):
    host = client.post("/api/rooms", json={"name": "المضيف"}).json()
    players = [host]
    for i in range(1, count):
        players.append(client.post(f"/api/rooms/{host['room_code']}/join", json={"name": f"لاعب {i}"}).json())
    for player in players:
        state(player)
    return players


@pytest.mark.parametrize("count", [3, 6, 12])
def test_complete_http_sessions_with_private_state_and_scoring(count):
    players = players_in_room(count)
    host = players[0]
    assert action(host, type="host_action", action="start_game").status_code == 200
    used = set()
    totals = {player["player_id"]: 0 for player in players}
    for round_number in range(1, 6):
        snapshots = [state(player) for player in players]
        words = [snapshot["secret"]["word"] for snapshot in snapshots]
        minority = next(word for word in words if words.count(word) == 1)
        majority = next(word for word in words if words.count(word) == count - 1)
        undercover = players[words.index(minority)]
        pair = tuple(sorted((minority, majority)))
        assert pair not in used
        used.add(pair)
        assert all("undercover" not in snapshot and snapshot["secret"]["hint"] is None for snapshot in snapshots)
        for player in players:
            assert player["token"] not in str(snapshots)
            assert action(player, type="ready").status_code == 200
        assert action(host, type="host_action", action="start_questions").status_code == 200
        askers = set()
        for _ in players:
            question = state(players[-1])["question"]
            assert question["asker"] != question["target"]
            askers.add(question["asker"])
            assert action(host, type="host_action", action="next_question").status_code == 200
        assert len(askers) == count
        assert state(host)["phase"] == "discussion"
        assert action(host, type="host_action", action="start_voting").status_code == 200
        for i, player in enumerate(players):
            snapshot = state(player)
            assert "undercover" not in snapshot and "votes" not in snapshot
            # Alternate correct guesses and self-votes, including incorrect guesses.
            target = undercover["player_id"] if i % 2 == 0 else player["player_id"]
            assert action(player, type="vote", target_id=target).status_code == 200
            totals[player["player_id"]] += int(target == undercover["player_id"])
            assert action(player, type="vote", target_id=target).status_code == 400
        guess = state(undercover)
        assert guess["phase"] == "undercover_guess"
        other = next(player for player in players if player != undercover)
        assert "guess_options" not in state(other)
        word = majority if round_number % 2 else next(word for word in guess["guess_options"] if word != majority)
        assert action(undercover, type="guess", word=word).status_code == 200
        totals[undercover["player_id"]] += int(word == majority)
        assert {row["id"]: row["score"] for row in state(host)["scoreboard"]} == totals
        assert action(host, type="host_action", action="next_round").status_code == 200
    assert state(host)["phase"] == "finished"


def test_http_auth_invalid_room_and_host_permissions():
    host, guest, _ = players_in_room(3)
    path = f"/api/rooms/{host['room_code']}"
    assert client.get(path + "/state").status_code == 401
    assert client.get(path + "/state", headers={**headers(host), "Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/rooms/INVALID/state", headers=headers(host)).status_code == 404
    assert action(guest, type="host_action", action="start_game").status_code == 400
    assert client.post(path + "/actions", headers=headers(host), json=[]).status_code == 422
    assert action(host, type="unknown").status_code == 400


def test_http_disconnect_expiry_reconnect_and_mixed_websocket():
    host, guest, _ = players_in_room(3)
    code = host["room_code"]
    with client.websocket_connect(f"/ws/{code}") as socket:
        socket.send_json({"type": "auth", **host})
        assert socket.receive_json()["phase"] == "lobby"
        assert action(guest, type="host_action", action="start_game").status_code == 400
        http_presence[code, guest["player_id"]] = time.monotonic() - 60
        snapshot = state(host)
        assert next(player for player in snapshot["players"] if player["id"] == guest["player_id"])["connected"] is False
        socket.receive_json()
        assert state(guest)["self"]["id"] == guest["player_id"]
        assert next(player for player in socket.receive_json()["players"] if player["id"] == guest["player_id"])["connected"] is True
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}
        assert action(host, type="host_action", action="start_game").status_code == 200
        assert socket.receive_json()["phase"] == "reveal"
        assert "secret" in state(guest)


def test_html_versions_assets_and_revalidates_css():
    import re
    page = client.get("/")
    assert page.headers["cache-control"] == "no-store"
    assert "__ASSET_VERSION__" not in page.text
    asset = re.search(r'href="(/undercover-assets/css/styles.css\?v=[0-9a-f]+)"', page.text).group(1)
    response = client.get(asset)
    assert response.headers["content-type"].startswith("text/css")
    assert response.headers["cache-control"] == "no-cache"
    assert "--bg: #f5f3ef" in response.text
