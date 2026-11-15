import json
import os
import sqlite3
import time
from contextlib import closing, contextmanager
from functools import lru_cache
from pathlib import Path


class FrameCache:
    def __init__(self, path: Path, max_bytes: int = 128 * 1024 * 1024):
        self.path = path
        self.max_bytes = max_bytes
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as connection:
            connection.execute("PRAGMA auto_vacuum = FULL")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS frames "
                "(key TEXT PRIMARY KEY, payload BLOB NOT NULL, used INTEGER NOT NULL)"
            )

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.path, timeout=10)) as connection, connection:
            yield connection

    def get(self, key: str) -> dict | None:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT payload FROM frames WHERE key = ?", (key,)
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                "UPDATE frames SET used = ? WHERE key = ?", (time.time_ns(), key)
            )
        return json.loads(row[0])

    def put(self, key: str, frame: dict):
        payload = json.dumps(frame, separators=(",", ":"), allow_nan=False).encode()
        if len(payload) > self.max_bytes:
            return
        with self.connection() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO frames VALUES (?, ?, ?)",
                (key, payload, time.time_ns()),
            )
            size = connection.execute(
                "SELECT COALESCE(SUM(length(payload)), 0) FROM frames"
            ).fetchone()[0]
            for old_key, old_size in connection.execute(
                "SELECT key, length(payload) FROM frames ORDER BY used"
            ).fetchall():
                if size <= self.max_bytes:
                    break
                connection.execute("DELETE FROM frames WHERE key = ?", (old_key,))
                size -= old_size


@lru_cache(maxsize=1)
def frame_cache() -> FrameCache:
    directory = os.environ.get("SPHEREX_CACHE_DIR")
    if directory is None:
        directory = (
            Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
            / "spherex-explorer"
        )
    return FrameCache(Path(directory) / "frames-v1.sqlite3")
