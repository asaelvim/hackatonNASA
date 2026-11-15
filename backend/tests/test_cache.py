import json
from concurrent.futures import ThreadPoolExecutor

from app.cache import FrameCache


def test_cache_evicts_least_recently_used_and_obeys_byte_limit(tmp_path):
    frame = {"pixels": "abc"}
    size = len(json.dumps(frame, separators=(",", ":")).encode())
    cache = FrameCache(tmp_path / "frames.sqlite3", max_bytes=2 * size)
    cache.put("a", frame)
    cache.put("b", frame)
    assert cache.get("a") == frame
    cache.put("c", frame)
    assert cache.get("b") is None
    assert cache.get("a") == frame
    assert cache.get("c") == frame
    cache.put("oversized", {"pixels": "x" * (3 * size)})
    assert cache.get("oversized") is None
    assert cache.get("a") == frame
    assert cache.get("c") == frame


def test_cache_handles_concurrent_writes_from_independent_instances(tmp_path):
    path = tmp_path / "frames.sqlite3"
    first = FrameCache(path)
    second = FrameCache(path)

    def write(index):
        cache = first if index % 2 else second
        cache.put(str(index), {"pixels": str(index)})
        assert cache.get(str(index)) == {"pixels": str(index)}

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(write, range(60)))
    reopened = FrameCache(path)
    for index in range(60):
        assert reopened.get(str(index)) == {"pixels": str(index)}
