import pytest

from app import connections, rooms


@pytest.fixture(autouse=True)
def clean_rooms() -> None:
    rooms.rooms.clear()
    connections.clear()
