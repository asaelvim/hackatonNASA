import base64
import math
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from astropy.stats import sigma_clipped_stats
from scipy.ndimage import gaussian_filter, label
from scipy.optimize import linear_sum_assignment

from app import archive

MAX_SOURCES_PER_FRAME = 240
MAX_CANDIDATES = 24
MIN_MOTION_EPOCHS = 5
MIN_VARIABILITY_EPOCHS = 5
MAX_GAP_EPOCHS = 2
BASE_MATCH_RADIUS_PX = 1.7
MAX_MATCH_RADIUS_PX = 3.0
MAX_SPEED_PX_PER_YEAR = 10.0
LARGE_COST = 1e6


def _decode_frame(frame: dict) -> tuple[np.ndarray, np.ndarray]:
    shape = (int(frame["height"]), int(frame["width"]))
    pixels = np.frombuffer(base64.b64decode(frame["pixels"]), dtype="<f4")
    pixels = pixels.reshape(shape).astype(np.float64)
    flags = np.frombuffer(base64.b64decode(frame["flags"]), dtype=np.uint8)
    flags = flags.reshape(shape).astype(bool)
    return pixels, flags


def _safe_number(value, default=0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _spectral_tolerance(a: dict, b: dict) -> float:
    widths = [
        _safe_number(a.get("bandwidth_um")),
        _safe_number(b.get("bandwidth_um")),
    ]
    widths = [value for value in widths if value > 0]
    return max(0.005, min(widths) * 0.5) if widths else 0.02


def spectrally_compatible(a: dict, b: dict) -> bool:
    aw = a.get("wavelength_um")
    bw = b.get("wavelength_um")
    if aw is None or bw is None:
        return False
    return abs(float(aw) - float(bw)) <= _spectral_tolerance(a, b)


def detect_sources(
    frame: dict,
    ra: float,
    dec: float,
    fov: float,
    threshold_sigma: float = 4.5,
) -> list[dict]:
    data, bad = _decode_frame(frame)
    valid = np.isfinite(data) & ~bad
    if np.count_nonzero(valid) < 25:
        return []

    _, background, noise = sigma_clipped_stats(
        data,
        mask=~valid,
        sigma=3.0,
        maxiters=5,
        cenfunc="median",
        stdfunc="mad_std",
    )
    background = _safe_number(background)
    noise = _safe_number(noise)
    if noise <= 0:
        return []

    residual = np.where(valid, data - background, 0.0)
    smoothed = gaussian_filter(residual, sigma=0.75)
    threshold = threshold_sigma * noise
    detection_mask = (smoothed > threshold) & valid

    detection_mask[:2, :] = False
    detection_mask[-2:, :] = False
    detection_mask[:, :2] = False
    detection_mask[:, -2:] = False

    labels, count = label(
        detection_mask,
        structure=np.ones((3, 3), dtype=np.uint8),
    )
    if not count:
        return []

    target_wcs, _ = archive.output_grid(ra, dec, fov)
    sources = []

    for component in range(1, count + 1):
        yy, xx = np.nonzero(labels == component)
        if not len(xx) or len(xx) > 180:
            continue

        peak = float(np.max(smoothed[yy, xx]))
        if peak < threshold:
            continue

        component_weights = np.clip(residual[yy, xx], 0, None)
        if not np.any(component_weights > 0):
            continue

        x0 = float(np.average(xx, weights=component_weights))
        y0 = float(np.average(yy, weights=component_weights))

        radius = 2.7
        x_min = max(0, int(math.floor(x0 - 4)))
        x_max = min(data.shape[1], int(math.ceil(x0 + 5)))
        y_min = max(0, int(math.floor(y0 - 4)))
        y_max = min(data.shape[0], int(math.ceil(y0 + 5)))

        py, px = np.mgrid[y_min:y_max, x_min:x_max]
        aperture = (px - x0) ** 2 + (py - y0) ** 2 <= radius**2
        local_valid = valid[y_min:y_max, x_min:x_max]
        use = aperture & local_valid
        n_pix = int(np.count_nonzero(use))
        if n_pix < 3:
            continue

        local_residual = residual[y_min:y_max, x_min:x_max]
        positive = np.where(use, np.clip(local_residual, 0, None), 0.0)
        flux_proxy = float(np.sum(positive))
        if flux_proxy <= 0:
            continue

        weight_sum = float(np.sum(positive))
        x_centroid = float(np.sum(px * positive) / weight_sum)
        y_centroid = float(np.sum(py * positive) / weight_sum)

        bad_patch = bad[y_min:y_max, x_min:x_max]
        aperture_total = max(1, int(np.count_nonzero(aperture)))
        bad_fraction = float(np.count_nonzero(aperture & bad_patch) / aperture_total)

        snr_proxy = flux_proxy / max(noise * math.sqrt(n_pix), 1e-12)
        if snr_proxy < 5.0 or bad_fraction > 0.25:
            continue

        source_ra, source_dec = target_wcs.pixel_to_world_values(
            x_centroid,
            y_centroid,
        )
        if not (math.isfinite(source_ra) and math.isfinite(source_dec)):
            continue

        sources.append(
            {
                "x": x_centroid,
                "y": y_centroid,
                "ra": float(source_ra),
                "dec": float(source_dec),
                "flux_proxy": flux_proxy,
                "snr_proxy": float(snr_proxy),
                "bad_fraction": bad_fraction,
                "peak_sigma": float(peak / noise),
            }
        )

    sources.sort(key=lambda source: source["snr_proxy"], reverse=True)
    return sources[:MAX_SOURCES_PER_FRAME]


def _fit_xy(track: list[dict]) -> tuple[float, float, float, float, float]:
    times = np.array([point["mjd"] for point in track], dtype=float)
    x = np.array([point["x"] for point in track], dtype=float)
    y = np.array([point["y"] for point in track], dtype=float)
    center = float(np.mean(times))
    years = (times - center) / 365.25
    sx, ix = np.polyfit(years, x, 1)
    sy, iy = np.polyfit(years, y, 1)
    return float(sx), float(ix), float(sy), float(iy), center


def _predicted_position(track: list[dict], mjd: float) -> tuple[float, float]:
    if len(track) < 4:
        return track[-1]["x"], track[-1]["y"]

    recent = track[-6:]
    try:
        sx, ix, sy, iy, center = _fit_xy(recent)
    except (ValueError, np.linalg.LinAlgError):
        return track[-1]["x"], track[-1]["y"]

    years = (mjd - center) / 365.25
    return sx * years + ix, sy * years + iy


def _match_radius(track: list[dict], detection: dict) -> float:
    last = track[-1]
    gap_epochs = max(1, detection["frame_index"] - last["frame_index"])
    gap_years = max(0.0, (detection["mjd"] - last["mjd"]) / 365.25)
    radius = BASE_MATCH_RADIUS_PX + 0.30 * (gap_epochs - 1) + min(0.9, 0.9 * gap_years)
    return min(MAX_MATCH_RADIUS_PX, radius)


def _pair_cost(track: list[dict], detection: dict) -> float:
    last = track[-1]
    gap_epochs = detection["frame_index"] - last["frame_index"]
    if gap_epochs < 1 or gap_epochs > MAX_GAP_EPOCHS:
        return LARGE_COST

    px, py = _predicted_position(track, detection["mjd"])
    distance = math.hypot(detection["x"] - px, detection["y"] - py)
    radius = _match_radius(track, detection)
    if distance > radius:
        return LARGE_COST

    gap_years = (detection["mjd"] - last["mjd"]) / 365.25
    if gap_years > 0.03:
        raw_step = math.hypot(
            detection["x"] - last["x"],
            detection["y"] - last["y"],
        )
        if raw_step / gap_years > MAX_SPEED_PX_PER_YEAR:
            return LARGE_COST

    cost = distance / max(radius, 1e-6)
    cost += 0.08 * max(0, gap_epochs - 1)
    cost += 0.15 * detection["bad_fraction"]

    if spectrally_compatible(last, detection):
        a = max(last["flux_proxy"], 1e-12)
        b = max(detection["flux_proxy"], 1e-12)
        flux_penalty = min(abs(math.log(b / a)), 2.0)
        cost += 0.12 * flux_penalty

    return cost


def _associate(detections_by_epoch: list[list[dict]]) -> list[list[dict]]:
    tracks: list[list[dict]] = []

    for detections in detections_by_epoch:
        if not detections:
            continue

        current_frame = detections[0]["frame_index"]
        active_indices = [
            index
            for index, track in enumerate(tracks)
            if 0 < current_frame - track[-1]["frame_index"] <= MAX_GAP_EPOCHS
        ]

        if not active_indices:
            tracks.extend([[detection] for detection in detections])
            continue

        cost = np.full(
            (len(active_indices), len(detections)),
            LARGE_COST,
            dtype=float,
        )
        for row, track_index in enumerate(active_indices):
            for column, detection in enumerate(detections):
                cost[row, column] = _pair_cost(
                    tracks[track_index],
                    detection,
                )

        rows, columns = linear_sum_assignment(cost)
        used_detections = set()

        for row, column in zip(rows, columns, strict=True):
            pair_cost = float(cost[row, column])
            if pair_cost >= LARGE_COST or pair_cost > 1.20:
                continue
            track_index = active_indices[row]
            tracks[track_index].append(detections[column])
            used_detections.add(column)

        for index, detection in enumerate(detections):
            if index not in used_detections:
                tracks.append([detection])

    return tracks


def _compatible_variability(points: list[dict]) -> tuple[float, int]:
    groups: list[list[dict]] = []

    for point in points:
        placed = False
        for group in groups:
            if spectrally_compatible(point, group[0]):
                group.append(point)
                placed = True
                break
        if not placed:
            groups.append([point])

    best_cv = 0.0
    best_n = 0

    for group in groups:
        if len(group) < MIN_VARIABILITY_EPOCHS:
            continue
        flux = np.array([point["flux_proxy"] for point in group], dtype=float)
        median = float(np.median(flux))
        if median <= 0:
            continue
        mad = float(np.median(np.abs(flux - median)))
        robust_sigma = 1.4826 * mad
        cv = robust_sigma / median
        if cv > best_cv:
            best_cv = cv
            best_n = len(group)

    return best_cv, best_n


def _build_timeline(
    points: list[dict],
    epochs: list[dict],
    fit: tuple[float, float, float, float, float],
) -> list[dict]:
    sx, ix, sy, iy, center = fit
    by_frame = {point["frame_index"]: point for point in points}
    first = points[0]["frame_index"]
    last = points[-1]["frame_index"]
    timeline = []

    for epoch in epochs:
        frame_index = epoch["frame_index"]
        if frame_index < first or frame_index > last:
            continue

        actual = by_frame.get(frame_index)
        if actual is not None:
            x = actual["x"]
            y = actual["y"]
            detected = True
        else:
            years = (epoch["mjd"] - center) / 365.25
            x = sx * years + ix
            y = sy * years + iy
            detected = False

        if not (0 <= x < epoch["width"] and 0 <= y < epoch["height"]):
            continue

        timeline.append(
            {
                "observation_id": epoch["observation_id"],
                "date": epoch["date"],
                "mjd": epoch["mjd"],
                "frame_index": frame_index,
                "x": round(float(x), 4),
                "y": round(float(y), 4),
                "detected": detected,
            }
        )

    return timeline


def _score_track(
    track: list[dict],
    pixel_scale_arcsec: float,
    total_frames: int,
    epochs: list[dict],
) -> dict | None:
    if len(track) < MIN_MOTION_EPOCHS:
        return None

    points = sorted(track, key=lambda point: point["frame_index"])
    frame_indices = np.array(
        [point["frame_index"] for point in points],
        dtype=int,
    )
    times = np.array([point["mjd"] for point in points], dtype=float)

    baseline_days = float(times[-1] - times[0])
    if baseline_days <= 0:
        return None

    span_epochs = int(frame_indices[-1] - frame_indices[0] + 1)
    gaps = np.diff(frame_indices)
    max_gap_epochs = int(np.max(gaps)) if len(gaps) else 0
    continuity = len(points) / max(1, span_epochs)
    coverage_fraction = len(points) / max(1, total_frames)

    try:
        fit = _fit_xy(points)
    except (ValueError, np.linalg.LinAlgError):
        return None

    sx, ix, sy, iy, center = fit
    t_years = (times - center) / 365.25
    x = np.array([point["x"] for point in points], dtype=float)
    y = np.array([point["y"] for point in points], dtype=float)
    predicted_x = sx * t_years + ix
    predicted_y = sy * t_years + iy

    residuals = np.hypot(x - predicted_x, y - predicted_y)
    residual_rms_px = float(np.sqrt(np.mean(residuals**2)))

    motion_px_per_year = float(math.hypot(sx, sy))
    motion_arcsec_per_year = motion_px_per_year * pixel_scale_arcsec
    baseline_years = baseline_days / 365.25
    total_shift_arcsec = motion_arcsec_per_year * baseline_years

    centroid_floor_px = 0.25
    motion_significance_proxy = (
        motion_px_per_year
        * max(baseline_years, 0.15)
        / max(centroid_floor_px + residual_rms_px, 0.2)
    )
    linearity = float(math.exp(-residual_rms_px / 0.75))

    variability, variability_epochs = _compatible_variability(points)
    median_snr = float(np.median([point["snr_proxy"] for point in points]))
    mean_bad = float(np.mean([point["bad_fraction"] for point in points]))

    required_motion_epochs = max(
        MIN_MOTION_EPOCHS,
        math.ceil(total_frames * 0.45),
    )
    minimum_motion_arcsec = max(3.0, pixel_scale_arcsec * 0.55)

    moving = (
        len(points) >= required_motion_epochs
        and coverage_fraction >= 0.45
        and continuity >= 0.65
        and max_gap_epochs <= MAX_GAP_EPOCHS
        and total_shift_arcsec >= minimum_motion_arcsec
        and motion_significance_proxy >= 2.5
        and residual_rms_px <= 0.75
        and linearity >= 0.50
        and motion_px_per_year <= MAX_SPEED_PX_PER_YEAR
    )

    variable = (
        variability_epochs >= MIN_VARIABILITY_EPOCHS
        and variability >= 0.18
        and coverage_fraction >= 0.40
        and continuity >= 0.55
    )

    if not moving and not variable:
        return None

    motion_strength = float(
        np.clip(
            (total_shift_arcsec - minimum_motion_arcsec)
            / max(pixel_scale_arcsec * 2.0, 1.0),
            0.0,
            1.0,
        )
    )
    variability_strength = float(np.clip((variability - 0.12) / 0.38, 0.0, 1.0))
    epoch_strength = float(
        np.clip(
            (len(points) - MIN_MOTION_EPOCHS)
            / max(1, total_frames - MIN_MOTION_EPOCHS),
            0.0,
            1.0,
        )
    )
    coverage_strength = float(np.clip((coverage_fraction - 0.35) / 0.65, 0.0, 1.0))
    snr_strength = float(np.clip(median_snr / 20.0, 0.0, 1.0))
    quality_strength = float(np.clip(1.0 - mean_bad * 3.0, 0.0, 1.0))

    motion_score = 100.0 * (
        0.28 * motion_strength
        + 0.20 * linearity
        + 0.18 * epoch_strength
        + 0.14 * continuity
        + 0.08 * coverage_strength
        + 0.07 * snr_strength
        + 0.05 * quality_strength
    )
    variability_score = 100.0 * (
        0.34 * variability_strength
        + 0.20 * epoch_strength
        + 0.16 * continuity
        + 0.12 * coverage_strength
        + 0.10 * snr_strength
        + 0.08 * quality_strength
    )

    if moving and variable:
        kind = "motion+variability"
        reason = (
            "Movimiento aparente continuo y variación de brillo "
            "en épocas espectralmente compatibles."
        )
        score = min(100.0, max(motion_score, variability_score) + 8.0)
    elif moving:
        kind = "motion"
        reason = "Movimiento aparente continuo respaldado por varias épocas."
        score = motion_score
    else:
        kind = "variability"
        reason = "Variación de brillo repetida dentro de un grupo espectral compatible."
        score = variability_score

    if score >= 75:
        confidence = "high"
    elif score >= 55:
        confidence = "medium"
    else:
        confidence = "low"

    return {
        "score": round(float(np.clip(score, 0, 100)), 1),
        "confidence": confidence,
        "kind": kind,
        "reason": reason,
        "epochs": len(points),
        "baseline_days": round(baseline_days, 2),
        "coverage_fraction": round(coverage_fraction, 3),
        "continuity": round(continuity, 3),
        "max_gap_epochs": max_gap_epochs,
        "motion_arcsec": round(total_shift_arcsec, 3),
        "motion_arcsec_per_year": round(motion_arcsec_per_year, 3),
        "motion_linearity": round(linearity, 3),
        "motion_significance_proxy": round(
            motion_significance_proxy,
            2,
        ),
        "flux_variability": round(variability, 3),
        "variability_epochs": variability_epochs,
        "median_snr_proxy": round(median_snr, 2),
        "mean_bad_fraction": round(mean_bad, 4),
        "points": points,
        "timeline": _build_timeline(points, epochs, fit),
    }


def analyze_prepared(
    prepared: list[tuple[dict, dict]],
    ra: float,
    dec: float,
    fov: float,
) -> dict:
    prepared = sorted(
        prepared,
        key=lambda item: float(item[0]["mjd"]),
    )
    detections_by_epoch = []
    total_detections = 0
    epochs = []

    for frame_index, (observation, frame) in enumerate(prepared):
        epochs.append(
            {
                "observation_id": observation["id"],
                "date": observation["date"],
                "mjd": float(observation["mjd"]),
                "frame_index": frame_index,
                "width": int(frame["width"]),
                "height": int(frame["height"]),
            }
        )

        sources = detect_sources(frame, ra, dec, fov)
        detections = []
        for source in sources:
            detections.append(
                {
                    **source,
                    "observation_id": observation["id"],
                    "obs_id": observation.get("obs_id", ""),
                    "date": observation["date"],
                    "mjd": float(observation["mjd"]),
                    "frame_index": frame_index,
                    "wavelength_um": frame.get("wavelength_um"),
                    "bandwidth_um": frame.get("bandwidth_um"),
                }
            )

        detections_by_epoch.append(detections)
        total_detections += len(detections)

    tracks = _associate(detections_by_epoch)
    pixel_scale = (
        float(prepared[0][1].get("pixel_scale_arcsec", 6.2)) if prepared else 6.2
    )

    ranked = []
    for track in tracks:
        result = _score_track(
            track,
            pixel_scale,
            len(prepared),
            epochs,
        )
        if result is not None:
            ranked.append(result)

    ranked.sort(key=lambda candidate: candidate["score"], reverse=True)
    ranked = ranked[:MAX_CANDIDATES]

    for rank, candidate in enumerate(ranked, start=1):
        candidate["id"] = f"C{rank:02d}"

    return {
        "candidates": ranked,
        "diagnostics": {
            "frames_analyzed": len(prepared),
            "detections": total_detections,
            "tracks_considered": len(tracks),
            "candidate_count": len(ranked),
        },
        "method": {
            "background": ("sigma-clipped median + MAD standard deviation"),
            "threshold_sigma": 4.5,
            "minimum_motion_epochs": MIN_MOTION_EPOCHS,
            "minimum_variability_epochs": MIN_VARIABILITY_EPOCHS,
            "maximum_gap_epochs": MAX_GAP_EPOCHS,
            "assignment": "global one-to-one linear assignment",
            "note": (
                "Prototype ranking: motion_significance_proxy and "
                "snr_proxy are heuristic indicators, not formal "
                "astrometric or photometric uncertainties."
            ),
        },
    }


def analyze(
    observations: list[dict],
    ra: float,
    dec: float,
    fov: float,
) -> dict:
    prepared = []
    failures = []

    def load(item):
        return item, archive.frame(
            item["source_url"],
            ra,
            dec,
            fov,
        )

    with ThreadPoolExecutor(max_workers=min(4, max(1, len(observations)))) as pool:
        futures = [pool.submit(load, item) for item in observations]
        for future in as_completed(futures):
            try:
                prepared.append(future.result())
            except Exception as exc:
                failures.append(str(exc))

    if len(prepared) < MIN_MOTION_EPOCHS:
        raise archive.ArchiveError(
            "No hubo suficientes épocas válidas para analizar candidatos."
        )

    result = analyze_prepared(prepared, ra, dec, fov)
    result["diagnostics"]["frame_failures"] = len(failures)
    result["warnings"] = (
        [f"{len(failures)} observación(es) no pudieron entrar al análisis automático."]
        if failures
        else []
    )
    return result
