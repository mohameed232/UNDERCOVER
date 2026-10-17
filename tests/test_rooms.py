import pytest

from undercover.data import WORD_PAIRS
from undercover.rooms import GameError, RoomManager


def connected_room(player_count: int = 3, hints: bool = False):
    manager = RoomManager()
    room = manager.create("المضيف", hints)
    for index in range(1, player_count):
        room.join(f"لاعب {index}")
    for player in room.players.values():
        player.connected = True
    return room


def finish_round(room, correct_votes: set[str] | None = None, correct_guess: bool = True):
    assert room.round is not None
    round_state = room.round
    for player_id in room.players:
        room.mark_ready(player_id)
    room.start_questions(room.host_id)
    for _ in room.players:
        room.next_question(room.host_id)
    assert room.phase == "discussion"
    room.start_voting(room.host_id)
    correct_votes = correct_votes if correct_votes is not None else set(room.players)
    wrong_target = next(player_id for player_id in room.players if player_id != round_state.undercover_id)
    for player_id in room.players:
        target = round_state.undercover_id if player_id in correct_votes else wrong_target
        room.vote(player_id, target)
    assert room.phase == "undercover_guess"
    guess = round_state.majority_secret["word"] if correct_guess else next(
        word for word in round_state.final_options if word != round_state.majority_secret["word"]
    )
    room.guess(round_state.undercover_id, guess)
    assert room.phase == "scores"
    return round_state


@pytest.mark.parametrize("player_count", range(3, 13))
def test_complete_five_round_session_for_all_player_counts(player_count: int) -> None:
    room = connected_room(player_count, hints=True)
    room.start_game(room.host_id)
    used_pairs: set[int] = set()
    expected = {player_id: 0 for player_id in room.players}
    previous_undercover_id = None

    for round_number in range(1, 6):
        assert room.round is not None
        round_state = room.round
        assert round_state.undercover_id != previous_undercover_id
        previous_undercover_id = round_state.undercover_id
        assert round_state.pair["id"] not in used_pairs
        used_pairs.add(round_state.pair["id"])
        assert len({asker for asker, _ in round_state.assignments}) == player_count
        assert all(asker != target for asker, target in round_state.assignments)

        secrets = [room.state_for(player_id)["secret"]["word"] for player_id in room.players]
        assert secrets.count(round_state.undercover_secret["word"]) == 1
        assert secrets.count(round_state.majority_secret["word"]) == player_count - 1

        finish_round(room)
        for player_id in expected:
            expected[player_id] += 1
        expected[round_state.undercover_id] += 1
        assert {player.id: player.score for player in room.players.values()} == expected
        assert room.round_number == round_number
        room.next_round(room.host_id)

    assert room.phase == "finished"
    assert len(used_pairs) == 5
    final = room.state_for(room.host_id)
    assert len(final["scoreboard"]) == player_count
    assert final["winners"]


def test_undercover_draw_excludes_previous_player_even_if_random_draw_repeats(monkeypatch) -> None:
    monkeypatch.setattr("undercover.rooms.secrets.randbelow", lambda _maximum: 0)
    room = connected_room()
    room.start_game(room.host_id)
    previous_undercover_id = None
    for _ in range(5):
        assert room.round is not None
        assert room.round.undercover_id != previous_undercover_id
        previous_undercover_id = room.round.undercover_id
        finish_round(room)
        room.next_round(room.host_id)
    assert room.phase == "finished"


def test_secret_and_vote_privacy() -> None:
    room = connected_room(4, hints=False)
    room.start_game(room.host_id)
    assert room.round is not None
    undercover_id = room.round.undercover_id

    for player_id in room.players:
        state = room.state_for(player_id)
        assert "undercover" not in state
        assert state["secret"]["hint"] is None
        expected = room.round.undercover_secret if player_id == undercover_id else room.round.majority_secret
        assert state["secret"]["word"] == expected["word"]

    for player_id in room.players:
        room.mark_ready(player_id)
    room.start_questions(room.host_id)
    for _ in room.players:
        room.next_question(room.host_id)
    room.start_voting(room.host_id)
    first, second = list(room.players)[:2]
    room.vote(first, first)
    private_state = room.state_for(second)
    assert "votes" not in private_state
    assert private_state["vote_count"] == 1
    assert private_state["has_voted"] is False


def test_duplicate_votes_and_non_host_control_are_rejected() -> None:
    room = connected_room()
    room.start_game(room.host_id)
    for player_id in room.players:
        room.mark_ready(player_id)
    non_host = next(player_id for player_id in room.players if player_id != room.host_id)
    with pytest.raises(GameError, match="للمضيف"):
        room.start_questions(non_host)
    room.start_questions(room.host_id)
    for _ in room.players:
        room.next_question(room.host_id)
    room.start_voting(room.host_id)
    room.vote(non_host, non_host)
    with pytest.raises(GameError, match="بالفعل"):
        room.vote(non_host, room.host_id)


def test_self_vote_is_valid_and_scores_individually() -> None:
    room = connected_room()
    room.start_game(room.host_id)
    assert room.round is not None
    undercover_id = room.round.undercover_id
    round_state = finish_round(room, correct_votes={undercover_id}, correct_guess=False)
    assert room.players[undercover_id].score == 1
    assert round_state.gains[undercover_id] == 1
    assert sum(player.score for player in room.players.values()) == 1


def test_reconnection_keeps_identity_and_progress() -> None:
    room = connected_room()
    player = next(iter(room.players.values()))
    player.score = 3
    player.connected = False
    restored = room.authenticate(player.id, player.token)
    restored.connected = True
    assert restored is player
    assert restored.score == 3
    with pytest.raises(GameError):
        room.authenticate(player.id, "wrong-token")


def test_names_room_capacity_and_word_data_quality() -> None:
    room = connected_room(12)
    with pytest.raises(GameError, match="مكتملة"):
        room.join("إضافي")
    with pytest.raises(GameError, match="مستخدم"):
        room = connected_room(3)
        room.join("المضيف")

    pair_keys = [tuple(sorted((pair["a"]["word"], pair["b"]["word"]))) for pair in WORD_PAIRS]
    words = [word for pair in WORD_PAIRS for word in (pair["a"]["word"], pair["b"]["word"])]
    assert len(WORD_PAIRS) == 140
    assert len(pair_keys) == len(set(pair_keys))
    assert len(words) == len(set(words))
    assert all(pair["a"]["hint"] and pair["b"]["hint"] for pair in WORD_PAIRS)
