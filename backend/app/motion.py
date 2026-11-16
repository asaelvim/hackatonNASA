import numpy as np
from scipy.ndimage import gaussian_filter, maximum_filter


def _sources(image: np.ndarray, flags: np.ndarray) -> list[tuple[float, float]]:
    valid = np.isfinite(image) & ~flags
    if valid.sum() < 9:
        return []
    fill = float(np.median(image[valid]))
    prepared = np.where(valid, image, fill)
    background = gaussian_filter(prepared, sigma=3)
    matched = gaussian_filter(prepared - background, sigma=1)
    noise = 1.4826 * np.median(np.abs(matched[valid] - np.median(matched[valid])))
    if not np.isfinite(noise) or noise <= 0:
        return []
    peaks = (
        valid
        & (matched == maximum_filter(matched, size=3, mode="nearest"))
        & (matched > noise * 4)
    )
    detections = []
    for y, x in np.argwhere(peaks):
        y0, y1 = max(0, y - 1), min(image.shape[0], y + 2)
        x0, x1 = max(0, x - 1), min(image.shape[1], x + 2)
        weights = np.maximum(matched[y0:y1, x0:x1], 0)
        total = weights.sum()
        if total <= 0:
            continue
        grid_y, grid_x = np.indices(weights.shape)
        detections.append(
            (
                float(x0 + (grid_x * weights).sum() / total),
                float(y0 + (grid_y * weights).sum() / total),
            )
        )
    return detections


def moving_source_masks(
    images: list[np.ndarray], flags: list[np.ndarray]
) -> tuple[list[np.ndarray], list[int]]:
    if len(images) != len(flags):
        raise ValueError("Las imágenes y sus banderas no coinciden.")
    if len(images) < 2:
        return [np.zeros(image.shape, dtype=np.uint8) for image in images], [0] * len(
            images
        )
    if any(image.shape != images[0].shape for image in images):
        raise ValueError("Todas las imágenes deben tener el mismo tamaño.")

    detections = [
        _sources(image, flag) for image, flag in zip(images, flags, strict=True)
    ]
    masks = [np.zeros(image.shape, dtype=np.uint8) for image in images]
    for frame_index, sources in enumerate(detections):
        for x, y in sources:
            stationary_in_every_frame = all(
                any(
                    np.hypot(other_x - x, other_y - y) <= 1.5
                    for other_x, other_y in other_sources
                )
                for other_index, other_sources in enumerate(detections)
                if other_index != frame_index
            )
            if stationary_in_every_frame:
                continue
            px, py = round(x), round(y)
            masks[frame_index][max(0, py - 1) : py + 2, max(0, px - 1) : px + 2] = 1
    return masks, [int(mask.sum()) for mask in masks]
