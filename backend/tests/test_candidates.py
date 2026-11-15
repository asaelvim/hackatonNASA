import base64
import math

import numpy as np

from app import candidates


def encoded_frame(
    stars,
    wavelength=1.0,
    size=64,
    bad_points=(),
):
    rng = np.random.default_rng(7)
    data = rng.normal(0.0, 0.03, (size, size))
    yy, xx = np.indices(data.shape)

    for x, y, amplitude in stars:
        data += amplitude * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.0**2))

    flags = np.zeros((size, size), dtype=np.uint8)
    for x, y in bad_points:
        flags[
            max(0, int(y) - 1) : int(y) + 2,
            max(0, int(x) - 1) : int(x) + 2,
        ] = 1

    return {
        "width": size,
        "height": size,
        "pixels": base64.b64encode(data.astype("<f4").tobytes()).decode(),
        "flags": base64.b64encode(flags.tobytes()).decode(),
        "unit": "MJy/sr",
        "wavelength_um": wavelength,
        "bandwidth_um": 0.04,
        "coverage": 1.0,
        "flagged_fraction": float(flags.mean()),
        "source_fraction": 0.0,
        "zodi_subtracted": True,
        "pixel_scale_arcsec": 6.2,
    }


def observation(index, mjd):
    return {
        "id": f"obs-{index}",
        "obs_id": f"synthetic-{index}",
        "source_url": "unused",
        "mjd": float(mjd),
        "date": f"2026-01-{index + 1:02d}T00:00:00Z",
    }


def test_detect_sources_finds_clean_compact_sources():
    frame = encoded_frame([(18, 20, 2.0), (44, 39, 1.6)])
    found = candidates.detect_sources(frame, 20, 30, 6)

    assert len(found) >= 2
    assert any(math.hypot(item["x"] - 18, item["y"] - 20) < 1.0 for item in found)
    assert any(math.hypot(item["x"] - 44, item["y"] - 39) < 1.0 for item in found)


def test_detect_sources_rejects_low_quality_aperture():
    frame = encoded_frame(
        [(25, 25, 2.0)],
        bad_points=[(25, 25)],
    )
    found = candidates.detect_sources(frame, 20, 30, 6)

    assert not any(math.hypot(item["x"] - 25, item["y"] - 25) < 2.0 for item in found)


def test_temporal_analysis_ranks_long_continuous_moving_source():
    prepared = []

    for index in range(8):
        mjd = 61000.0 + index * 55.0
        moving_x = 18.0 + index * 0.42
        prepared.append(
            (
                observation(index, mjd),
                encoded_frame(
                    [
                        (moving_x, 22.0, 2.2),
                        (42.0, 18.0, 1.6),
                        (47.0, 44.0, 1.4),
                    ],
                    wavelength=1.00,
                ),
            )
        )

    result = candidates.analyze_prepared(
        prepared,
        20,
        30,
        6,
    )
    moving = [
        item
        for item in result["candidates"]
        if item["kind"] in ("motion", "motion+variability")
    ]

    assert moving
    assert moving[0]["epochs"] >= 6
    assert moving[0]["continuity"] >= 0.75
    assert moving[0]["motion_arcsec"] > 5


def test_three_epoch_motion_is_not_promoted_to_candidate():
    prepared = []

    for index in range(8):
        mjd = 61100.0 + index * 55.0
        stars = [(44.0, 18.0, 1.6)]
        if index < 3:
            stars.append((15.0 + index * 1.1, 30.0, 2.2))
        prepared.append(
            (
                observation(index, mjd),
                encoded_frame(stars, wavelength=1.00),
            )
        )

    result = candidates.analyze_prepared(
        prepared,
        20,
        30,
        6,
    )

    assert not any(
        item["kind"] in ("motion", "motion+variability") and item["epochs"] <= 3
        for item in result["candidates"]
    )


def test_missing_middle_epoch_uses_predicted_timeline_marker():
    prepared = []

    for index in range(8):
        mjd = 61200.0 + index * 55.0
        stars = [(46.0, 17.0, 1.5)]
        if index != 4:
            stars.append((20.0 + index * 0.38, 31.0, 2.1))
        prepared.append(
            (
                observation(index, mjd),
                encoded_frame(stars, wavelength=1.00),
            )
        )

    result = candidates.analyze_prepared(
        prepared,
        20,
        30,
        6,
    )
    moving = [
        item
        for item in result["candidates"]
        if item["kind"] in ("motion", "motion+variability")
    ]

    assert moving
    predicted = [point for point in moving[0]["timeline"] if point["frame_index"] == 4]
    assert predicted
    assert predicted[0]["detected"] is False


def test_temporal_analysis_detects_compatible_variability():
    prepared = []
    amplitudes = [1.0, 1.1, 1.2, 2.0, 2.2, 2.4, 2.6]

    for index, amplitude in enumerate(amplitudes):
        mjd = 61300.0 + index * 40.0
        prepared.append(
            (
                observation(index, mjd),
                encoded_frame(
                    [
                        (28.0, 31.0, amplitude),
                        (48.0, 16.0, 1.5),
                    ],
                    wavelength=1.20,
                ),
            )
        )

    result = candidates.analyze_prepared(
        prepared,
        20,
        30,
        6,
    )
    variable = [
        item
        for item in result["candidates"]
        if item["kind"]
        in (
            "variability",
            "motion+variability",
        )
    ]

    assert variable
    assert variable[0]["variability_epochs"] >= 5
    assert variable[0]["flux_variability"] >= 0.18
