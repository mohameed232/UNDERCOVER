import asyncio
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from undercover.rooms import GameError, RoomManager


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="UNDERCOVER", docs_url=None, redoc_url=None)
app.mount("/undercover-assets", StaticFiles(directory=STATIC_DIR), name="undercover-assets")
rooms = RoomManager()
connections: dict[str, dict[str, WebSocket]] = {}


class CreateRoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    hints_enabled: bool = False


class JoinRoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)


@app.exception_handler(GameError)
async def game_error_handler(_request: Request, error: GameError) -> JSONResponse:
    return JSONResponse({"detail": str(error)}, status_code=400)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, _error: RequestValidationError) -> JSONResponse:
    return JSONResponse({"detail": "البيانات المدخلة غير صالحة."}, status_code=422)


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/party", include_in_schema=False)
async def party() -> FileResponse:
    return FileResponse(STATIC_DIR / "party.html")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def player_credentials(room: Any, player: Any) -> dict[str, str]:
    return {"room_code": room.code, "player_id": player.id, "token": player.token}


@app.post("/api/rooms", status_code=201)
async def create_room(payload: CreateRoomRequest) -> dict[str, str]:
    room = rooms.create(payload.name, payload.hints_enabled)
    return player_credentials(room, room.host)


@app.post("/api/rooms/{code}/join", status_code=201)
async def join_room(code: str, payload: JoinRoomRequest) -> dict[str, str]:
    room = rooms.get(code)
    player = room.join(payload.name)
    await broadcast(room.code)
    return player_credentials(room, player)


async def send_error(websocket: WebSocket, message: str) -> None:
    await websocket.send_json({"type": "error", "message": message})


async def broadcast(code: str) -> None:
    room = rooms.rooms.get(code)
    if room is None:
        return
    stale: list[str] = []
    for player_id, websocket in list(connections.get(code, {}).items()):
        try:
            await websocket.send_json(room.state_for(player_id))
        except Exception:
            stale.append(player_id)
    for player_id in stale:
        connections.get(code, {}).pop(player_id, None)
        if player_id in room.players:
            room.players[player_id].connected = False


@app.websocket("/ws/{code}")
async def room_socket(websocket: WebSocket, code: str) -> None:
    origin = websocket.headers.get("origin")
    host = websocket.headers.get("host")
    # A reverse proxy may omit the public port from Host (for example :8081).
    # Keep the hostname check; player tokens are still required after the handshake.
    try:
        origin_parts = urlsplit(origin) if origin else None
        host_parts = urlsplit(f"//{host}") if host else None
        origin_host = origin_parts.hostname if origin_parts else None
        request_host = host_parts.hostname if host_parts else None
        origin_port = (
            origin_parts.port or (443 if origin_parts.scheme == "https" else 80)
            if origin_parts else None
        )
        host_port = host_parts.port if host_parts else None
    except ValueError:
        await websocket.close(code=4403)
        return
    if origin and (
        not origin_host or not request_host or origin_host.lower() != request_host.lower()
        or (host_port is not None and host_port != origin_port)
    ):
        await websocket.close(code=4403)
        return
    try:
        room = rooms.get(code)
    except GameError:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    try:
        auth = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        if not isinstance(auth, dict) or auth.get("type") != "auth":
            raise GameError("يلزم تسجيل الاتصال أولًا.")
        player = room.authenticate(str(auth.get("player_id", "")), str(auth.get("token", "")))
    except (GameError, asyncio.TimeoutError, ValueError):
        await websocket.close(code=4403)
        return
    room_connections = connections.setdefault(room.code, {})
    previous = room_connections.get(player.id)
    if previous is not None:
        try:
            await previous.close(code=4001, reason="تم فتح الجلسة على جهاز آخر.")
        except Exception:
            pass
    room_connections[player.id] = websocket
    player.connected = True
    room.touch()
    await broadcast(room.code)

    try:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                raise GameError("رسالة غير صالحة.")
            message_type = message.get("type")
            try:
                if message_type == "ready":
                    room.mark_ready(player.id)
                elif message_type == "vote":
                    room.vote(player.id, str(message.get("target_id", "")))
                elif message_type == "guess":
                    room.guess(player.id, str(message.get("word", "")))
                elif message_type == "host_action":
                    action = str(message.get("action", ""))
                    removed_id = str(message.get("player_id", "")) if action == "remove_player" else ""
                    room.handle_host_action(player.id, action, message)
                    if removed_id:
                        removed_socket = connections.get(room.code, {}).pop(removed_id, None)
                        if removed_socket is not None:
                            await removed_socket.close(code=4003, reason="تمت إزالتك من الغرفة.")
                else:
                    raise GameError("نوع الرسالة غير معروف.")
            except GameError as error:
                await send_error(websocket, str(error))
                continue
            await broadcast(room.code)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        if connections.get(room.code, {}).get(player.id) is websocket:
            connections[room.code].pop(player.id, None)
            player.connected = False
            room.touch()
            await broadcast(room.code)
