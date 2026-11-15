import base64
import hashlib
import io
import logging
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from xml.etree import ElementTree

import httpx
import numpy as np
from astropy import units as u
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.time import Time
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
COLLECTIONS = ("spherex_dr1", "spherex_qr3")
MAX_RECORDS = 20000
logger = logging.getLogger("spherex")

# SPHEREx Explanatory Supplement v2.1, Mosaic preprocessing:
# these bits are masked as problematic pixels. OVERFLOW, OUTLIER and SOURCE
# are intentionally not part of this bad-pixel mask because the official
# mosaic pipeline propagates them rather than masking them as generic bad data.
BAD_PIXEL_BITS = (
    0,   # TRANSIENT
    2,   # SUR_ERROR
    6,   # NONFUNC
    7,   # DICHROIC
    9,   # MISSING_DATA
    10,  # HOT
    11,  # COLD
    14,  # PHANMISS
    15,  # NONLINEAR
    17,  # PERSIST
    20,  # CROSSTALK
    22,  # GHOST
    23,  # GHOST_FPA
    24,  # GHOST_EXT
    25,  # STREAK
    26,  # BLOOM
    27,  # SNOWBALL
    28,  # HALO
    29,  # SATELLITE_HALO
)
BAD_PIXEL_MASK = sum(1 << bit for bit in BAD_PIXEL_BITS)
SOURCE_FLAG = 1 << 21
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


def download(url: str, params: dict, max_bytes: int, timeout: float = 120) -> bytes:
    for attempt in range(3):
        try:
            with httpx.Client(timeout=timeout, follow_redirects=False) as client:
                with client.stream("GET", url, params=params) as response:
                    response.raise_for_status()
                    content = bytearray()
                    for chunk in response.iter_bytes():
                        content.extend(chunk)
                        if len(content) > max_bytes:
                            raise ArchiveError(
                                "IRSA devolvió un archivo demasiado grande."
                            )
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
    raise ArchiveError("La descarga de IRSA no se completó.")


def query_collection(collection: str, ra: float, dec: float) -> tuple[list, bool]:
    content = download(
        SIA_URL,
        {
            "COLLECTION": collection,
            "POS": f"CIRCLE {ra} {dec} 0.0001",
            "MAXREC": MAX_RECORDS,
        },
        64 * 1024 * 1024,
        timeout=45,
    )
    root = ElementTree.fromstring(content)
    statuses = [node for node in root.iter() if node.get("name") == "QUERY_STATUS"]
    if any(node.get("value") == "ERROR" for node in statuses):
        raise ArchiveError(f"IRSA rechazó la consulta de {collection}.")
    truncated = any(node.get("value") == "OVERFLOW" for node in statuses)
    table = parse_single_table(io.BytesIO(content)).to_table(use_names_over_ids=True)
    observations = []
    for row in table:
        source = str(row["access_url"])
        if not valid_source(source):
            raise ArchiveError("IRSA devolvió una URL FITS no reconocida.")
        detector_match = re.search(r"D([1-6])_", source)
        mjd = float(row["t_min"])
        if not math.isfinite(mjd):
            raise ArchiveError("Una observación de IRSA no tiene fecha válida.")
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


def search(ra: float, dec: float, detector: int, limit: int) -> dict:
    warnings = []
    successful = []
    failures = []

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            collection: pool.submit(query_collection, collection, ra, dec)
            for collection in COLLECTIONS
        }
        for collection, future in futures.items():
            try:
                rows, truncated = future.result()
                successful.append((collection, rows, truncated))
            except (
                httpx.HTTPError,
                ArchiveError,
                ValueError,
                OSError,
                KeyError,
                ElementTree.ParseError,
            ) as exc:
                logger.warning(
                    "No se pudo consultar %s; se continuará con las otras colecciones: %s",
                    collection,
                    exc,
                )
                failures.append((collection, exc))
                warnings.append(
                    f"{collection}: no respondió correctamente; "
                    "se muestran los datos disponibles de las otras colecciones."
                )

    if not successful:
        # Keep the original exception type so FastAPI returns 504 for a timeout
        # and 502 for other upstream problems.
        raise failures[0][1]

    observations = {}
    used_collections = []
    for collection, rows, truncated in successful:
        used_collections.append(collection)
        if truncated:
            warnings.append(
                f"{collection}: consulta truncada por IRSA; "
                "la muestra no representa todo el intervalo disponible."
            )
        for row in rows:
            if row["detector"] == detector:
                observations[row["id"]] = row

    ordered = sorted(observations.values(), key=lambda row: row["mjd"])
    count = len(ordered)
    if count > limit:
        indices = np.linspace(0, count - 1, limit, dtype=int)
        ordered = [ordered[index] for index in indices]
        warnings.append(
            f"Se seleccionaron {limit} de {count} observaciones como muestra temporal; "
            "no es una serie completa."
        )

    return {
        "observations": ordered,
        "total": count,
        "warnings": warnings,
        "collections": used_collections,
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
        raw_image = np.asarray(image.data, dtype=np.float64)
        zodi_subtracted = "ZODI" in hdus
        if zodi_subtracted:
            zodi = np.asarray(hdus["ZODI"].data, dtype=np.float64)
            data = raw_image - zodi
        else:
            data = raw_image

        source_wcs = WCS(image.header, fobj=hdus).celestial
        y, x = np.indices((size, size))
        world = target.pixel_to_world_values(x, y)
        sx, sy = source_wcs.world_to_pixel_values(*world)
        coordinates = np.array([sy, sx])
        coordinates[~np.isfinite(coordinates)] = -1

        # Science image: bilinear interpolation is appropriate for continuous flux.
        aligned = map_coordinates(
            data, coordinates, order=1, mode="constant", cval=np.nan
        ).astype("<f4")

        # FLAGS is a bit mask, not a continuous image. Never bilinearly interpolate it.
        raw_flags = np.asarray(hdus["FLAGS"].data, dtype=np.uint64)
        bad_flag_data = ((raw_flags & BAD_PIXEL_MASK) != 0).astype(np.uint8)
        source_flag_data = ((raw_flags & SOURCE_FLAG) != 0).astype(np.uint8)

        flagged = (
            map_coordinates(
                bad_flag_data,
                coordinates,
                order=0,
                mode="constant",
                cval=0,
                prefilter=False,
            )
            > 0
        )
        source_flagged = (
            map_coordinates(
                source_flag_data,
                coordinates,
                order=0,
                mode="constant",
                cval=0,
                prefilter=False,
            )
            > 0
        )

        valid = np.isfinite(aligned)
        if not valid.any():
            raise ArchiveError("El recorte no contiene píxeles válidos en este campo.")
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
            "source_fraction": float(np.mean(source_flagged[valid])),
            "zodi_subtracted": zodi_subtracted,
            "pixel_scale_arcsec": fov * 60 / size,
        }


@lru_cache(maxsize=16)
def frame(source_url: str, ra: float, dec: float, fov: float) -> dict:
    if not valid_source(source_url):
        raise ArchiveError("URL de observación no permitida.")
    # A rotated output square needs a larger input cutout, plus an edge margin.
    content = download(
        source_url,
        {"center": f"{ra},{dec}", "size": fov / 60 * math.sqrt(2) + 0.01},
        32 * 1024 * 1024,
    )
    return prepare_frame(content, ra, dec, fov)
