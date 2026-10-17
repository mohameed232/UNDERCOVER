import pytest

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import app, rooms


client = TestClient(app)


def create_three_players():
    host = client.post("/api/rooms", json={"name": "ليان", "hints_enabled": True})
    assert host.status_code == 201
    host_data = host.json()
    code = host_data["room_code"]
    second = client.post(f"/api/rooms/{code}/join", json={"name": "سارة"}).json()
    third = client.post(f"/api/rooms/{code}/join", json={"name": "عمر"}).json()
    return code, host_data, second, third


def authenticate(socket, credentials):
    socket.send_json({"type": "auth", "player_id": credentials["player_id"], "token": credentials["token"]})
    return socket.receive_json()


def test_pages_health_and_rtl() -> None:
    assert client.get("/health").json()["status"] == "ok"
    assert 'dir="rtl"' in client.get("/").text
    assert 'dir="rtl"' in client.get("/party").text
    assert '/undercover-assets/css/styles.css' in client.get("/").text
    assert '/undercover-assets/css/styles.css' in client.get("/party").text
    assert "@media (min-width: 640px)" in client.get("/undercover-assets/css/styles.css").text
    assert client.get("/undercover-assets/js/app.js").status_code == 200


def test_invalid_room_codes_and_duplicate_names() -> None:
    assert client.post("/api/rooms/WRONG/join", json={"name": "سارة"}).status_code == 400
    created = client.post("/api/rooms", json={"name": "ليان"}).json()
    response = client.post(f"/api/rooms/{created['room_code']}/join", json={"name": "ليان"})
    assert response.status_code == 400
    assert "مستخدم" in response.json()["detail"]


def test_websocket_auth_reconnection_and_host_authorization() -> None:
    code, host, second, _third = create_three_players()
    with client.websocket_connect(f"/ws/{code}") as socket:
        state = authenticate(socket, second)
        assert state["self"]["name"] == "سارة"
        socket.send_json({"type": "host_action", "action": "start_game"})
        error = socket.receive_json()
        assert error["type"] == "error"
        assert "للمضيف" in error["message"]

    assert rooms.get(code).players[second["player_id"]].connected is False
    with client.websocket_connect(f"/ws/{code}") as socket:
        state = authenticate(socket, second)
        assert state["self"]["id"] == second["player_id"]

    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect(f"/ws/{code}") as socket:
            socket.send_json({"type": "auth", "player_id": host["player_id"], "token": "invalid"})
            socket.receive_json()
    assert error.value.code == 4403


def test_credentials_are_not_exposed_in_public_state() -> None:
    code, host, _second, _third = create_three_players()
    with client.websocket_connect(f"/ws/{code}") as socket:
        state = authenticate(socket, host)
        serialized = str(state)
        assert host["token"] not in serialized
        assert "token" not in serialized


def test_websocket_accepts_public_port_when_proxy_omits_it_from_host() -> None:
    code, host, second, _third = create_three_players()
    headers = {"host": "party.example.com", "origin": "http://party.example.com:8081"}
    with client.websocket_connect(f"/ws/{code}", headers=headers) as host_socket:
        host_state = authenticate(host_socket, host)
        assert host_state["phase"] == "lobby"
        with client.websocket_connect(f"/ws/{code}", headers=headers) as player_socket:
            player_state = authenticate(player_socket, second)
            assert player_state["self"]["name"] == "سارة"
            assert player_state["players"][0]["connected"] is True


def test_websocket_rejects_foreign_origin() -> None:
    code, host, _second, _third = create_three_players()
    headers = {"host": "party.example.com", "origin": "http://other.example.com:8081"}
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect(f"/ws/{code}", headers=headers) as socket:
            authenticate(socket, host)
    assert error.value.code == 4403


def test_websocket_rejects_wrong_public_port_when_host_includes_port() -> None:
    code, host, _second, _third = create_three_players()
    headers = {"host": "party.example.com:8081", "origin": "http://party.example.com:8082"}
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect(f"/ws/{code}", headers=headers) as socket:
            authenticate(socket, host)
    assert error.value.code == 4403


def test_missing_room_close_code_and_malformed_message():
    with pytest.raises(WebSocketDisconnect) as error:
        with client.websocket_connect("/ws/AAAAA") as socket:
            socket.receive_json()
    assert error.value.code == 4404
    code, host, _second, _third = create_three_players()
    with client.websocket_connect(f"/ws/{code}") as socket:
        authenticate(socket, host)
        socket.send_json([])
        assert socket.receive_json()["type"] == "error"
        socket.send_json({"type": "ping"})
        assert socket.receive_json() == {"type": "pong"}
