import json
from pathlib import Path
from typing import TypedDict


class SecretWord(TypedDict):
    word: str
    hint: str


class WordPair(TypedDict):
    id: int
    category: str
    a: SecretWord
    b: SecretWord


DATA_PATH = Path(__file__).resolve().parent.parent / "static" / "data" / "word_pairs.json"


def load_word_pairs() -> list[WordPair]:
    pairs: list[WordPair] = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    if len(pairs) < 5:
        raise RuntimeError("The word library must contain at least five pairs.")
    return pairs


WORD_PAIRS = load_word_pairs()
