import numpy as np

from app.motion import moving_source_masks


def source(x: int, y: int) -> np.ndarray:
    grid_y, grid_x = np.indices((25, 25))
    return 1 + 20 * np.exp(-((grid_x - x) ** 2 + (grid_y - y) ** 2) / 2)


def test_marks_a_compact_source_that_moves_between_frames():
    images = [source(8, 12), source(10, 12), source(12, 12)]
    flags = [np.zeros((25, 25), dtype=bool) for _ in images]

    masks, counts = moving_source_masks(images, flags)

    assert counts == [9, 9, 9]
    assert masks[0][12, 8]
    assert masks[1][12, 10]
    assert masks[2][12, 12]


def test_ignores_a_stationary_source():
    images = [source(10, 12) for _ in range(3)]
    flags = [np.zeros((25, 25), dtype=bool) for _ in images]

    masks, counts = moving_source_masks(images, flags)

    assert counts == [0, 0, 0]
    assert not any(mask.any() for mask in masks)


def test_marks_a_source_that_appears_in_one_observation():
    images = [np.ones((25, 25)), source(12, 12), np.ones((25, 25))]
    flags = [np.zeros((25, 25), dtype=bool) for _ in images]

    masks, counts = moving_source_masks(images, flags)

    assert counts == [0, 9, 0]
    assert masks[1][12, 12]
