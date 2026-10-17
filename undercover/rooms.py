from __future__ import annotations

import secrets
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from .data import WORD_PAIRS, WordPair


ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
MAX_PLAYERS = 12
TOTAL_ROUNDS = 5


class GameError(ValueError):
    """A safe, user-facing game error."""


def normalize_name(value: str) -> str:
    name = " ".join(value.strip().split())
    if not 1 <= len(name) <= 24:
        raise GameError("يجب أن يكون الاسم بين حرف واحد و24 حرفًا.")
    if any(unicodedata.category(char).startswith("C") for char in name):
        raise GameError("الاسم يحتوي على محارف غير صالحة.")
    return name


def normalize_code(value: str) -> str:
    code = value.strip().upper()
    if len(code) != 5 or any(char not in ROOM_ALPHABET for char in code):
        raise GameError("رمز الغرفة غير صالح.")
    return code


def secure_shuffle(items: list[Any]) -> list[Any]:
    result = list(items)
    for index in range(len(result) - 1, 0, -1):
        other = secrets.randbelow(index + 1)
        result[index], result[other] = result[other], result[index]
    return result


@dataclass
class Player:
    id: str
    token: str
    name: str
    score: int = 0
    connected: bool = False


@dataclass
class RoundState:
    pair: WordPair
    undercover_id: str
    majority_secret: dict[str, str]
    undercover_secret: dict[str, str]
    assignments: list[tuple[str, str]]
    final_options: list[str]
    ready: set[str] = field(default_factory=set)
    votes: dict[str, str] = field(default_factory=dict)
    gains: dict[str, int] = field(default_factory=dict)
    question_index: int = 0
    final_guess: str | None = None
    final_guess_correct: bool | None = None


class Room:
    def __init__(self, code: str, host_name: str, hints_enabled: bool = False) -> None:
        host = self._new_player(host_name)
        self.code = code
        self.host_id = host.id
        self.players: dict[str, Player] = {host.id: host}
        self.hints_enabled = hints_enabled
        self.phase = "lobby"
        self.round_number = 0
        self.used_pair_ids: set[int] = set()
        self.round: RoundState | None = None
        self.created_at = time.time()
        self.updated_at = self.created_at
        self.version = 0

    @staticmethod
    def _new_player(name: str) -> Player:
        return Player(
            id=secrets.token_hex(8),
            token=secrets.token_urlsafe(24),
            name=normalize_name(name),
        )

    @property
    def host(self) -> Player:
        return self.players[self.host_id]

    def touch(self) -> None:
        self.updated_at = time.time()
        self.version += 1

    def authenticate(self, player_id: str, token: str) -> Player:
        player = self.players.get(player_id)
        if player is None or not secrets.compare_digest(player.token.encode(), token.encode()):
            raise GameError("تعذر التحقق من جلسة اللاعب.")
        return player

    def require_host(self, player_id: str) -> None:
        if player_id != self.host_id:
            raise GameError("هذا الإجراء متاح للمضيف فقط.")

    def join(self, name: str) -> Player:
        if self.phase != "lobby":
            raise GameError("بدأت هذه الغرفة بالفعل.")
        if len(self.players) >= MAX_PLAYERS:
            raise GameError("الغرفة مكتملة.")
        clean_name = normalize_name(name)
        if any(player.name.casefold() == clean_name.casefold() for player in self.players.values()):
            raise GameError("هذا الاسم مستخدم في الغرفة.")
        player = self._new_player(clean_name)
        self.players[player.id] = player
        self.touch()
        return player

    def remove_lobby_player(self, host_id: str, target_id: str) -> None:
        self.require_host(host_id)
        if self.phase != "lobby":
            raise GameError("لا يمكن حذف لاعب بعد بدء الجلسة.")
        if target_id == self.host_id:
            raise GameError("لا يمكن للمضيف حذف نفسه.")
        if target_id not in self.players:
            raise GameError("اللاعب غير موجود.")
        del self.players[target_id]
        self.touch()

    def start_game(self, host_id: str) -> None:
        self.require_host(host_id)
        if self.phase != "lobby":
            raise GameError("بدأت الجلسة بالفعل.")
        if not 3 <= len(self.players) <= MAX_PLAYERS:
            raise GameError("يجب أن تضم الغرفة من 3 إلى 12 لاعبًا.")
        if sum(player.connected for player in self.players.values()) < 3:
            raise GameError("يجب أن يكون ثلاثة لاعبين على الأقل متصلين.")
        self._start_round()

    def _start_round(self) -> None:
        if self.round_number >= TOTAL_ROUNDS:
            raise GameError("انتهت الجلسة.")
        available = [pair for pair in WORD_PAIRS if pair["id"] not in self.used_pair_ids]
        pair = available[secrets.randbelow(len(available))]
        self.used_pair_ids.add(pair["id"])
        player_ids = list(self.players)
        previous_undercover_id = self.round.undercover_id if self.round else None
        eligible_ids = [player_id for player_id in player_ids if player_id != previous_undercover_id]
        undercover_id = eligible_ids[secrets.randbelow(len(eligible_ids))]
        majority_uses_a = bool(secrets.randbelow(2))
        majority = pair["a"] if majority_uses_a else pair["b"]
        undercover = pair["b"] if majority_uses_a else pair["a"]
        order = secure_shuffle(player_ids)
        assignments = [(asker, order[(index + 1) % len(order)]) for index, asker in enumerate(order)]
        current_words = {pair["a"]["word"], pair["b"]["word"]}
        candidates = [
            secret["word"]
            for other in WORD_PAIRS
            if other["category"] == pair["category"] and other["id"] != pair["id"]
            for secret in (other["a"], other["b"])
            if secret["word"] not in current_words
        ]
        incorrect = secure_shuffle(list(dict.fromkeys(candidates)))[:4]
        self.round = RoundState(
            pair=pair,
            undercover_id=undercover_id,
            majority_secret=majority,
            undercover_secret=undercover,
            assignments=assignments,
            final_options=secure_shuffle([majority["word"], *incorrect]),
            gains={player_id: 0 for player_id in player_ids},
        )
        self.round_number += 1
        self.phase = "reveal"
        self.touch()

    def mark_ready(self, player_id: str) -> None:
        if self.phase != "reveal" or self.round is None:
            raise GameError("مرحلة عرض الكلمات انتهت.")
        self.round.ready.add(player_id)
        self.touch()

    def start_questions(self, host_id: str) -> None:
        self.require_host(host_id)
        if self.phase != "reveal" or self.round is None:
            raise GameError("لا يمكن بدء الأسئلة الآن.")
        if self.round.ready != set(self.players):
            raise GameError("انتظر حتى يؤكد جميع اللاعبين استلام كلماتهم.")
        self.phase = "questions"
        self.touch()

    def next_question(self, host_id: str) -> None:
        self.require_host(host_id)
        if self.phase != "questions" or self.round is None:
            raise GameError("مرحلة الأسئلة غير نشطة.")
        if self.round.question_index + 1 < len(self.round.assignments):
            self.round.question_index += 1
        else:
            self.phase = "discussion"
        self.touch()

    def start_voting(self, host_id: str) -> None:
        self.require_host(host_id)
        if self.phase != "discussion" or self.round is None:
            raise GameError("لا يمكن بدء التصويت الآن.")
        self.phase = "voting"
        self.touch()

    def vote(self, voter_id: str, target_id: str) -> None:
        if self.phase != "voting" or self.round is None:
            raise GameError("التصويت غير متاح الآن.")
        if voter_id in self.round.votes:
            raise GameError("تم تسجيل تصويتك بالفعل.")
        if target_id not in self.players:
            raise GameError("اختيار غير صالح.")
        self.round.votes[voter_id] = target_id
        if len(self.round.votes) == len(self.players):
            self._finish_voting()
        self.touch()

    def close_voting(self, host_id: str) -> None:
        self.require_host(host_id)
        if self.phase != "voting" or self.round is None:
            raise GameError("التصويت غير متاح الآن.")
        if len(self.round.votes) < 2:
            raise GameError("يجب انتظار تصويت لاعبين اثنين على الأقل.")
        self._finish_voting()
        self.touch()

    def _finish_voting(self) -> None:
        assert self.round is not None
        for voter_id, target_id in self.round.votes.items():
            if target_id == self.round.undercover_id:
                self.players[voter_id].score += 1
                self.round.gains[voter_id] += 1
        self.phase = "undercover_guess"

    def guess(self, player_id: str, word: str) -> None:
        if self.phase != "undercover_guess" or self.round is None:
            raise GameError("التخمين النهائي غير متاح الآن.")
        if player_id != self.round.undercover_id:
            raise GameError("التخمين النهائي للمتخفي فقط.")
        if self.round.final_guess is not None:
            raise GameError("تم تسجيل التخمين النهائي.")
        if word not in self.round.final_options:
            raise GameError("اختيار غير صالح.")
        self._finish_guess(word)

    def skip_guess(self, host_id: str) -> None:
        self.require_host(host_id)
        if self.phase != "undercover_guess" or self.round is None:
            raise GameError("التخمين النهائي غير متاح الآن.")
        self._finish_guess("")

    def _finish_guess(self, word: str) -> None:
        assert self.round is not None
        correct = word == self.round.majority_secret["word"]
        self.round.final_guess = word
        self.round.final_guess_correct = correct
        if correct:
            undercover = self.players[self.round.undercover_id]
            undercover.score += 1
            self.round.gains[undercover.id] += 1
        self.phase = "scores"
        self.touch()

    def next_round(self, host_id: str) -> None:
        self.require_host(host_id)
        if self.phase != "scores":
            raise GameError("لا يمكن الانتقال الآن.")
        if self.round_number == TOTAL_ROUNDS:
            self.phase = "finished"
            self.touch()
        else:
            self._start_round()

    def handle_host_action(self, player_id: str, action: str, data: dict[str, Any]) -> None:
        actions = {
            "start_game": lambda: self.start_game(player_id),
            "start_questions": lambda: self.start_questions(player_id),
            "next_question": lambda: self.next_question(player_id),
            "start_voting": lambda: self.start_voting(player_id),
            "close_voting": lambda: self.close_voting(player_id),
            "skip_guess": lambda: self.skip_guess(player_id),
            "next_round": lambda: self.next_round(player_id),
            "remove_player": lambda: self.remove_lobby_player(player_id, str(data.get("player_id", ""))),
        }
        if action not in actions:
            raise GameError("إجراء غير معروف.")
        actions[action]()

    def state_for(self, viewer_id: str) -> dict[str, Any]:
        viewer = self.players[viewer_id]
        payload: dict[str, Any] = {
            "type": "state",
            "version": self.version,
            "code": self.code,
            "phase": self.phase,
            "round": self.round_number,
            "total_rounds": TOTAL_ROUNDS,
            "hints_enabled": self.hints_enabled,
            "is_host": viewer_id == self.host_id,
            "self": {"id": viewer.id, "name": viewer.name, "score": viewer.score},
            "host_id": self.host_id,
            "players": [
                {
                    "id": player.id,
                    "name": player.name,
                    "score": player.score,
                    "connected": player.connected,
                }
                for player in self.players.values()
            ],
        }
        if self.round is None:
            return payload

        round_state = self.round
        payload.update({
            "ready_count": len(round_state.ready),
            "vote_count": len(round_state.votes),
            "player_count": len(self.players),
        })
        if self.phase == "reveal":
            secret = round_state.undercover_secret if viewer_id == round_state.undercover_id else round_state.majority_secret
            payload["secret"] = {
                "word": secret["word"],
                "hint": secret["hint"] if self.hints_enabled else None,
            }
            payload["is_ready"] = viewer_id in round_state.ready
        elif self.phase == "questions":
            asker_id, target_id = round_state.assignments[round_state.question_index]
            payload["question"] = {
                "index": round_state.question_index + 1,
                "total": len(round_state.assignments),
                "asker": self.players[asker_id].name,
                "target": self.players[target_id].name,
            }
        elif self.phase == "voting":
            payload["has_voted"] = viewer_id in round_state.votes
            payload["candidates"] = [
                {"id": player.id, "name": player.name} for player in self.players.values()
            ]
        elif self.phase == "undercover_guess":
            payload["undercover"] = {
                "id": round_state.undercover_id,
                "name": self.players[round_state.undercover_id].name,
                "word": round_state.undercover_secret["word"],
            }
            if viewer_id == round_state.undercover_id:
                payload["guess_options"] = round_state.final_options
        elif self.phase in {"scores", "finished"}:
            scores = sorted(self.players.values(), key=lambda player: (-player.score, player.name))
            payload.update({
                "undercover": {
                    "id": round_state.undercover_id,
                    "name": self.players[round_state.undercover_id].name,
                    "word": round_state.undercover_secret["word"],
                },
                "majority_word": round_state.majority_secret["word"],
                "final_guess_correct": round_state.final_guess_correct,
                "scoreboard": [
                    {"id": player.id, "name": player.name, "gain": round_state.gains[player.id], "score": player.score}
                    for player in scores
                ],
            })
            if self.phase == "finished":
                best = scores[0].score
                payload["winners"] = [player.name for player in scores if player.score == best]
        return payload


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}

    def create(self, host_name: str, hints_enabled: bool = False) -> Room:
        self.cleanup()
        for _ in range(100):
            code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(5))
            if code not in self.rooms:
                room = Room(code, host_name, hints_enabled)
                self.rooms[code] = room
                return room
        raise RuntimeError("Could not allocate a room code.")

    def get(self, code: str) -> Room:
        normalized = normalize_code(code)
        room = self.rooms.get(normalized)
        if room is None:
            raise GameError("الغرفة غير موجودة أو انتهت صلاحيتها.")
        room.touch()
        return room

    def cleanup(self, max_age_seconds: int = 12 * 60 * 60) -> None:
        cutoff = time.time() - max_age_seconds
        expired = [code for code, room in self.rooms.items() if room.updated_at < cutoff]
        for code in expired:
            del self.rooms[code]
