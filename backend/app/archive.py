import atexit
import base64
import hashlib
import io
import json
import logging
import math
import re
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from xml.etree import ElementTree

import httpx
import numpy as np
from astropy import units as u
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.time import Time
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

from app.cache import frame_cache

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
COLLECTIONS = ("spherex_dr1", "spherex_qr3")
MAX_RECORDS = 20000
logger = logging.getLogger("spherex")
_client: httpx.Client | None = None
_client_lock = Lock()
SOURCE_PATTERN = re.compile(
    r"https://irsa\.ipac\.caltech\.edu/ibe/data/spherex/(dr1|qr3)/level2/"
    r"\d{4}W\d{2}_[A-Z0-9]+/l2b(?:_retry)?-v\d+-\d{4}-\d{3}/[1-6]/"
    r"level2_\d{4}W\d{2}_[A-Z0-9]+_\d{4}_[1-4]D[1-6]_"
    r"spx_l2b(?:_retry)?-v\d+-\d{4}-\d{3}\.fits"
)


class ArchiveError(Exception):
    pass


def valid_source(url: str) -> bool:
    return SOURCE_PATTERN.fullmatch(url) is not None


def http_client() -> httpx.Client:
    global _client
    with _client_lock:
        if _client is None:
            _client = httpx.Client(
                timeout=120,
                follow_redirects=False,
                limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
            )
        return _client


def close_client():
    global _client
    with _client_lock:
        if _client is not None:
            _client.close()
            _client = None


atexit.register(close_client)


def download(url: str, params: dict, max_bytes: int) -> bytes:
    for attempt in range(3):
        try:
            with http_client().stream("GET", url, params=params) as response:
                response.raise_for_status()
                content = bytearray()
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > max_bytes:
                        raise ArchiveError("IRSA returned a file that is too large.")
                return bytes(content)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code not in (429, 502, 503, 504) or attempt == 2:
                raise
            logger.warning("IRSA devolvió %s; reintentando", exc.response.status_code)
        except httpx.TransportError:
            if attempt == 2:
                raise
            logger.warning("Conexión con IRSA interrumpida; reintentando")
        time.sleep(2**attempt)
    raise ArchiveError("The IRSA download did not complete.")


def query_collection(collection: str, ra: float, dec: float) -> tuple[list, bool]:
    content = download(
        SIA_URL,
        {
            "COLLECTION": collection,
            "POS": f"CIRCLE {ra} {dec} 0.0001",
            "MAXREC": MAX_RECORDS,
        },
        64 * 1024 * 1024,
    )
    root = ElementTree.fromstring(content)
    statuses = [node for node in root.iter() if node.get("name") == "QUERY_STATUS"]
    if any(node.get("value") == "ERROR" for node in statuses):
        raise ArchiveError(f"IRSA rejected the query for {collection}.")
    truncated = any(node.get("value") == "OVERFLOW" for node in statuses)
    table = parse_single_table(io.BytesIO(content)).to_table(use_names_over_ids=True)
    observations = []
    for row in table:
        source = str(row["access_url"])
        if not valid_source(source):
            raise ArchiveError("IRSA returned an unrecognized FITS URL.")
        detector_match = re.search(r"D([1-6])_", source)
        mjd = float(row["t_min"])
        if not math.isfinite(mjd):
            raise ArchiveError("An IRSA observation does not have a valid date.")
        observations.append(
            {
                "id": hashlib.sha256(source.encode()).hexdigest()[:20],
                "source_url": source,
                "collection": collection,
                "detector": int(detector_match[1]),
                "obs_id": str(row["obs_id"]),
                "mjd": mjd,
                "date": Time(mjd, format="mjd").isot + "Z",
            }
        )
    return observations, truncated


def search(ra: float, dec: float, detector: int, limit: int | None = None) -> dict:
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda collection: query_collection(collection, ra, dec), COLLECTIONS
            )
        )
    warnings = []
    observations = {}
    for collection, (rows, truncated) in zip(COLLECTIONS, results, strict=True):
        if truncated:
            warnings.append(
                f"{collection}: query truncated by IRSA; "
                "the sample does not represent the full available range."
            )
        for row in rows:
            if row["detector"] == detector:
                observations[row["id"]] = row
    ordered = sorted(observations.values(), key=lambda row: row["mjd"])
    count = len(ordered)
    if limit is not None and count > limit:
        indices = np.linspace(0, count - 1, limit, dtype=int)
        ordered = [ordered[index] for index in indices]
        warnings.append(
            f"Showing {limit} of {count} observations, "
            "sampled in chronological order; this is not a complete series."
        )
    return {
        "observations": ordered,
        "total": count,
        "warnings": warnings,
        "collections": list(COLLECTIONS),
    }


def output_grid(ra: float, dec: float, fov: float) -> tuple[WCS, int]:
    size = max(10, math.ceil(fov * 60 / 6.2))
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(size + 1) / 2, (size + 1) / 2]
    wcs.wcs.cdelt = [-fov / (60 * size), fov / (60 * size)]
    return wcs, size


def prepare_frame(content: bytes, ra: float, dec: float, fov: float) -> dict:
    target, size = output_grid(ra, dec, fov)
    with fits.open(io.BytesIO(content), memmap=False) as hdus:
        image = hdus["IMAGE"]
        data = np.asarray(image.data, dtype=np.float64)
        source_wcs = WCS(image.header, fobj=hdus).celestial
        y, x = np.indices((size, size))
        world = target.pixel_to_world_values(x, y)
        sx, sy = source_wcs.world_to_pixel_values(*world)
        coordinates = np.array([sy, sx])
        coordinates[~np.isfinite(coordinates)] = -1
        aligned = map_coordinates(
            data, coordinates, order=1, mode="constant", cval=np.nan
        ).astype("<f4")
        flag_data = np.asarray(hdus["FLAGS"].data != 0, dtype=float)
        flagged = (
            map_coordinates(flag_data, coordinates, order=1, mode="constant", cval=0)
            > 0
        )
        valid = np.isfinite(aligned)
        if not valid.any():
            raise ArchiveError("The cutout contains no valid pixels in this field.")
        spectral_wcs = WCS(image.header, fobj=hdus, key="W")
        spectral_wcs.sip = None
        cx, cy = source_wcs.world_to_pixel_values(ra, dec)
        wavelength, bandwidth = spectral_wcs.pixel_to_world(cx, cy)
        central_wave = float(wavelength.to_value(u.um))
        central_band = float(bandwidth.to_value(u.um))
        return {
            "width": size,
            "height": size,
            "pixels": base64.b64encode(aligned.tobytes()).decode(),
            "flags": base64.b64encode(flagged.astype(np.uint8).tobytes()).decode(),
            "unit": str(image.header["BUNIT"]),
            "wavelength_um": central_wave if math.isfinite(central_wave) else None,
            "bandwidth_um": central_band if math.isfinite(central_band) else None,
            "coverage": float(np.mean(valid)),
            "flagged_fraction": float(np.mean(flagged[valid])),
            "pixel_scale_arcsec": fov * 60 / size,
        }


def frame(source_url: str, ra: float, dec: float, fov: float) -> dict:
    if not valid_source(source_url):
        raise ArchiveError("Observation URL is not allowed.")
    key = hashlib.sha256(
        json.dumps([1, source_url, float(ra), float(dec), float(fov)]).encode()
    ).hexdigest()
    try:
        cached = frame_cache().get(key)
        if cached is not None:
            return cached
    except (OSError, sqlite3.Error, ValueError):
        logger.warning("No se pudo leer la caché; se consultará IRSA", exc_info=True)
    # A rotated output square needs a larger input cutout, plus an edge margin.
    content = download(
        source_url,
        {"center": f"{ra},{dec}", "size": fov / 60 * math.sqrt(2) + 0.01},
        32 * 1024 * 1024,
    )
    prepared = prepare_frame(content, ra, dec, fov)
    try:
        frame_cache().put(key, prepared)
    except (OSError, sqlite3.Error, ValueError):
        logger.warning("No se pudo guardar el recorte en caché", exc_info=True)
    return prepared
