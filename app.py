import asyncio
import hashlib
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from undercover.rooms import GameError, RoomManager


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
ASSET_VERSION = hashlib.sha256(b"".join(
    path.read_bytes() for path in sorted(STATIC_DIR.rglob("*")) if path.is_file()
)).hexdigest()[:12]
REVISION = (BASE_DIR / "REVISION").read_text().strip() if (BASE_DIR / "REVISION").exists() else "development"
HTTP_PRESENCE_SECONDS = 35
rooms = RoomManager()
connections: dict[str, dict[str, WebSocket]] = {}
http_presence: dict[tuple[str, str], float] = {}
broadcast_locks: dict[str, asyncio.Lock] = {}


def expire_http_presence(room_code: str | None = None) -> set[str]:
    changed = set()
    for (code, player_id), seen in list(http_presence.items()):
        if room_code is not None and code != room_code:
            continue
        if time.monotonic() - seen <= HTTP_PRESENCE_SECONDS:
            continue
        del http_presence[code, player_id]
        room = rooms.rooms.get(code)
        if room and player_id in room.players and player_id not in connections.get(code, {}):
            room.players[player_id].connected = False
            room.touch()
            changed.add(code)
    return changed


@asynccontextmanager
async def lifespan(_app: FastAPI):
    async def monitor_presence():
        while True:
            await asyncio.sleep(5)
            for code in expire_http_presence():
                await broadcast(code)
    monitor = asyncio.create_task(monitor_presence())
    try:
        yield
    finally:
        monitor.cancel()
        with suppress(asyncio.CancelledError):
            await monitor


app = FastAPI(title="UNDERCOVER", docs_url=None, redoc_url=None, lifespan=lifespan)
app.mount("/undercover-assets", StaticFiles(directory=STATIC_DIR), name="undercover-assets")


@app.middleware("http")
async def cache_policy(request: Request, call_next):
    response = await call_next(request)
    # Revalidate assets after updates; never cache private room snapshots or HTML.
    response.headers["Cache-Control"] = "no-cache" if request.url.path.startswith("/undercover-assets/") else "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


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


def page(name: str) -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / name).read_text(encoding="utf-8").replace("__ASSET_VERSION__", ASSET_VERSION))


@app.get("/", include_in_schema=False)
async def index() -> HTMLResponse:
    return page("index.html")


@app.get("/party", include_in_schema=False)
async def party() -> HTMLResponse:
    return page("party.html")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "revision": REVISION}


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


def http_player(request: Request, code: str):
    try:
        room = rooms.get(code)
    except GameError as error:
        raise HTTPException(404, str(error)) from error
    authorization = request.headers.get("authorization", "")
    token = authorization.removeprefix("Bearer ") if authorization.startswith("Bearer ") else ""
    try:
        player = room.authenticate(request.headers.get("x-undercover-player", ""), token)
    except GameError as error:
        raise HTTPException(401, str(error)) from error
    expired = expire_http_presence(room.code)
    presence_changed = bool(expired) or not player.connected
    http_presence[room.code, player.id] = time.monotonic()
    player.connected = True
    return room, player, presence_changed


@app.get("/api/rooms/{code}/state")
async def room_state(request: Request, code: str) -> dict[str, Any]:
    room, player, presence_changed = http_player(request, code)
    if presence_changed:
        await broadcast(room.code)
    return room.state_for(player.id)


@app.post("/api/rooms/{code}/actions")
async def room_action(request: Request, code: str, message: dict[str, Any]) -> dict[str, Any]:
    room, player, _presence_changed = http_player(request, code)
    await apply_action(room, player.id, message)
    return room.state_for(player.id)


async def apply_action(room: Any, player_id: str, message: dict[str, Any]) -> None:
    message_type = message.get("type")
    if message_type == "ready":
        room.mark_ready(player_id)
    elif message_type == "vote":
        room.vote(player_id, str(message.get("target_id", "")))
    elif message_type == "guess":
        room.guess(player_id, str(message.get("word", "")))
    elif message_type == "host_action":
        action = str(message.get("action", ""))
        removed_id = str(message.get("player_id", "")) if action == "remove_player" else ""
        room.handle_host_action(player_id, action, message)
        if removed_id:
            http_presence.pop((room.code, removed_id), None)
            removed_socket = connections.get(room.code, {}).pop(removed_id, None)
            if removed_socket is not None:
                await removed_socket.close(code=4003, reason="تمت إزالتك من الغرفة.")
    else:
        raise GameError("نوع الرسالة غير معروف.")
    await broadcast(room.code)


async def broadcast(code: str) -> None:
    # Serialize broadcasts so a slow send cannot deliver an older phase last.
    async with broadcast_locks.setdefault(code, asyncio.Lock()):
        room = rooms.rooms.get(code)
        if room is None:
            return
        for player_id, websocket in list(connections.get(code, {}).items()):
            if player_id not in room.players:
                continue
            try:
                await asyncio.wait_for(websocket.send_json(room.state_for(player_id)), timeout=3)
            except Exception:
                if connections.get(code, {}).get(player_id) is websocket:
                    connections[code].pop(player_id, None)
                    room.players[player_id].connected = (code, player_id) in http_presence
                    room.touch()


def valid_origin(origin: str | None, host: str | None) -> bool:
    if not origin:
        return True
    try:
        source = urlsplit(origin)
        target = urlsplit(f"//{host}") if host else None
        port = source.port or (443 if source.scheme == "https" else 80)
        # Nginx $host can omit :8081; $http_host preserves the public authority.
        return bool(source.scheme in {"http", "https"} and source.hostname and target
                    and source.hostname == target.hostname
                    and (target.port is None or target.port == port))
    except ValueError:
        return False


@app.websocket("/ws/{code}")
async def room_socket(websocket: WebSocket, code: str) -> None:
    if not valid_origin(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=4403)
        return
    # Accept first so browsers receive meaningful room/auth close codes.
    await websocket.accept()
    try:
        room = rooms.get(code)
    except GameError:
        await websocket.close(code=4404)
        return
    try:
        auth = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        if not isinstance(auth, dict) or auth.get("type") != "auth":
            raise GameError("يلزم تسجيل الاتصال أولًا.")
        player = room.authenticate(str(auth.get("player_id", "")), str(auth.get("token", "")))
    except WebSocketDisconnect:
        return
    except (GameError, asyncio.TimeoutError, ValueError):
        await websocket.close(code=4403)
        return
    room_connections = connections.setdefault(room.code, {})
    previous = room_connections.get(player.id)
    # Register the replacement before closing the old socket.
    room_connections[player.id] = websocket
    if previous is not None:
        with suppress(Exception):
            await previous.close(code=4001, reason="تم فتح الجلسة في نافذة أخرى.")
    player.connected = True
    room.touch()
    await broadcast(room.code)

    try:
        while True:
            message = await websocket.receive_json()
            if connections.get(room.code, {}).get(player.id) is not websocket:
                break
            try:
                if not isinstance(message, dict):
                    raise GameError("رسالة غير صالحة.")
                if message.get("type") == "ping":
                    room.touch()
                    await websocket.send_json({"type": "pong"})
                else:
                    await apply_action(room, player.id, message)
            except GameError as error:
                await websocket.send_json({"type": "error", "message": str(error)})
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        if connections.get(room.code, {}).get(player.id) is websocket:
            connections[room.code].pop(player.id, None)
            player.connected = (room.code, player.id) in http_presence
            room.touch()
            await broadcast(room.code)
