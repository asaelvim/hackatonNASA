import base64
import io

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.io.votable import from_table, writeto
from astropy.table import Table
from astropy.wcs import WCS
from fastapi.testclient import TestClient

from app import archive
from app.cache import frame_cache
from app.main import app

URL = (
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/"
    "2025W33_2C/l2b-v27-2026-228/1/"
    "level2_2025W33_2C_0321_1D1_spx_l2b-v27-2026-228.fits"
)


@pytest.fixture(autouse=True)
def isolate_resources(tmp_path, monkeypatch):
    monkeypatch.setenv("SPHEREX_CACHE_DIR", str(tmp_path))
    frame_cache.cache_clear()
    archive.close_client()
    yield
    archive.close_client()
    frame_cache.cache_clear()


def synthetic_fits(shift=0, all_invalid=False):
    wcs, size = archive.output_grid(20, 30, 2)
    wcs.wcs.crpix += [shift, 0]
    header = wcs.to_header()
    spectral = WCS(naxis=2)
    spectral.wcs.ctype = ["WAVE", "LINEAR"]
    spectral.wcs.cunit = ["m", "m"]
    spectral.wcs.crval = [1e-6, 1e-8]
    spectral.wcs.cdelt = [1e-12, 1e-12]
    header.update(spectral.to_header(key="W"))
    header["BUNIT"] = "MJy/sr"
    y, x = np.indices((size, size))
    center = (size - 1) / 2
    data = np.exp(-((x - center - shift) ** 2 + (y - center) ** 2) / 8)
    if all_invalid:
        data[:] = np.nan
    flags = np.zeros_like(data, dtype=np.int32)
    flags[size // 2, size // 2 + shift] = 1
    hdus = fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(data, header=header, name="IMAGE"),
            fits.ImageHDU(flags, name="FLAGS"),
        ]
    )
    content = io.BytesIO()
    hdus.writeto(content)
    return content.getvalue()


def test_wcs_aligns_shifted_observations_and_propagates_flags():
    first = archive.prepare_frame(synthetic_fits(), 20, 30, 2)
    second = archive.prepare_frame(synthetic_fits(shift=2), 20, 30, 2)
    a = np.frombuffer(base64.b64decode(first["pixels"]), dtype="<f4")
    b = np.frombuffer(base64.b64decode(second["pixels"]), dtype="<f4")
    valid = np.isfinite(a) & np.isfinite(b)
    np.testing.assert_allclose(a[valid], b[valid], atol=1e-6)
    assert first["unit"] == "MJy/sr"
    assert first["wavelength_um"] == pytest.approx(1.0, abs=0.001)
    assert base64.b64decode(second["flags"]).count(1) > 0
    assert second["coverage"] < 1


def test_invalid_cutout_is_an_error():
    with pytest.raises(archive.ArchiveError, match="píxeles válidos"):
        archive.prepare_frame(synthetic_fits(all_invalid=True), 20, 30, 2)


def test_query_uses_column_names_instead_of_votable_ids(monkeypatch):
    table = from_table(
        Table(
            {
                "access_url": [URL],
                "t_min": [60902.0],
                "obs_id": ["2025W33_2C_0321_1"],
            }
        )
    )
    for index, field in enumerate(table.get_first_table().fields):
        field.ID = f"col_{index}"
    content = io.BytesIO()
    writeto(table, content)
    monkeypatch.setattr(archive, "download", lambda *args: content.getvalue())
    observations, truncated = archive.query_collection("spherex_dr1", 20, 30)
    assert observations[0]["source_url"] == URL
    assert observations[0]["detector"] == 1
    assert observations[0]["date"].endswith("Z")
    assert not truncated


def test_search_samples_full_time_range_and_filters_detector(monkeypatch):
    rows = [{"id": str(i), "mjd": float(i), "detector": 1} for i in range(10)] + [
        {"id": "other", "mjd": 20.0, "detector": 2}
    ]
    monkeypatch.setattr(
        archive, "query_collection", lambda *args: (list(reversed(rows)), True)
    )
    result = archive.search(20, 30, 1, 3)
    assert [row["mjd"] for row in result["observations"]] == [0, 4, 9]
    assert result["total"] == 10
    assert len(result["warnings"]) == 3


@pytest.mark.parametrize(
    "limit,truncated,expected_count",
    [(None, False, 60), (None, True, 60), (12, False, 12)],
)
def test_api_returns_all_observations_unless_sampling_is_requested(
    monkeypatch, limit, truncated, expected_count
):
    rows = [{"id": str(i), "mjd": float(i), "detector": 1} for i in range(60)]
    monkeypatch.setattr(
        archive, "query_collection", lambda *args: (list(reversed(rows)), truncated)
    )
    client = TestClient(app)
    query = "/api/observations?ra=20&dec=30"
    if limit is not None:
        query += f"&limit={limit}"
    response = client.get(query)
    assert response.status_code == 200
    result = response.json()
    assert result["total"] == 60
    assert len(result["observations"]) == expected_count
    assert result["observations"][0]["mjd"] == 0
    assert result["observations"][-1]["mjd"] == 59
    assert len(result["warnings"]) == (2 if truncated else int(limit is not None))


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/secret.fits",
        URL + "?center=0,0",
        URL.replace("irsa.ipac.caltech.edu", "example.com"),
        URL.replace("/level2/", "/../../"),
    ],
)
def test_api_rejects_untrusted_sources(url):
    client = TestClient(app)
    response = client.post(
        "/api/frame", json={"source_url": url, "ra": 20, "dec": 30, "fov": 6}
    )
    assert response.status_code == 422


def test_api_reports_timeout_and_archive_errors(monkeypatch):
    client = TestClient(app)

    def timeout(*args):
        raise httpx.ReadTimeout("Timed out")

    monkeypatch.setattr(archive, "search", timeout)
    assert client.get("/api/observations?ra=20&dec=30").status_code == 504

    def failed(*args):
        raise archive.ArchiveError("Recorte sin cobertura.")

    monkeypatch.setattr(archive, "frame", failed)
    response = client.post(
        "/api/frame", json={"source_url": URL, "ra": 20, "dec": 30, "fov": 6}
    )
    assert response.status_code == 502
    assert response.json()["detail"] == "Recorte sin cobertura."


def test_api_rejects_invalid_coordinates():
    client = TestClient(app)
    assert client.get("/api/observations?ra=360&dec=30").status_code == 422
    assert client.get("/api/observations?ra=20&dec=-91").status_code == 422


def test_reprocessed_retry_products_are_allowed():
    assert archive.valid_source(URL.replace("l2b-v", "l2b_retry-v"))


def test_download_retries_transient_errors_but_not_invalid_requests(monkeypatch):
    client_class = httpx.Client
    calls = []
    clients = []

    def handler(request):
        calls.append(request)
        return httpx.Response(503 if len(calls) == 1 else 200, content=b"FITS")

    def create_client(**kwargs):
        client = client_class(transport=httpx.MockTransport(handler), **kwargs)
        clients.append(client)
        return client

    monkeypatch.setattr(archive.httpx, "Client", create_client)
    monkeypatch.setattr(archive.time, "sleep", lambda _: None)
    assert archive.download(URL, {}, 100) == b"FITS"
    assert len(calls) == 2
    assert archive.download(URL, {}, 100) == b"FITS"
    assert len(clients) == 1
    archive.close_client()
    assert clients[0].is_closed

    def invalid(request):
        calls.append(request)
        return httpx.Response(400)

    monkeypatch.setattr(
        archive.httpx,
        "Client",
        lambda **kwargs: client_class(transport=httpx.MockTransport(invalid), **kwargs),
    )
    calls.clear()
    with pytest.raises(httpx.HTTPStatusError):
        archive.download(URL, {}, 100)
    assert len(calls) == 1


def test_frame_cache_survives_restart_and_distinguishes_cutouts(monkeypatch):
    calls = []
    monkeypatch.setattr(
        archive, "download", lambda *args: calls.append(args) or b"FITS"
    )
    monkeypatch.setattr(
        archive, "prepare_frame", lambda content, ra, dec, fov: {"fov": fov}
    )
    for fov in range(1, 25):
        archive.frame(URL, 20, 30, fov)
    assert len(calls) == 24
    frame_cache.cache_clear()
    assert archive.frame(URL, 20.0, 30.0, 1.0) == {"fov": 1}
    assert len(calls) == 24
    archive.frame(URL, 21, 30, 1)
    archive.frame(URL, 20, 31, 1)
    archive.frame(URL.replace("l2b-v", "l2b_retry-v"), 20, 30, 1)
    assert len(calls) == 27


def test_failed_download_is_not_cached(monkeypatch):
    calls = []

    def download(*args):
        calls.append(args)
        if len(calls) == 1:
            raise httpx.ReadTimeout("Timed out")
        return b"FITS"

    monkeypatch.setattr(archive, "download", download)
    monkeypatch.setattr(archive, "prepare_frame", lambda *args: {"pixels": "real"})
    with pytest.raises(httpx.ReadTimeout):
        archive.frame(URL, 20, 30, 2)
    assert archive.frame(URL, 20, 30, 2) == {"pixels": "real"}
    assert archive.frame(URL, 20, 30, 2) == {"pixels": "real"}
    assert len(calls) == 2


def test_unavailable_cache_logs_warning_and_still_loads(monkeypatch, caplog):
    def unavailable():
        raise OSError("Cache directory is read-only")

    monkeypatch.setattr(archive, "frame_cache", unavailable)
    monkeypatch.setattr(archive, "download", lambda *args: b"FITS")
    monkeypatch.setattr(archive, "prepare_frame", lambda *args: {"pixels": "real"})
    assert archive.frame(URL, 20, 30, 2) == {"pixels": "real"}
    assert "No se pudo leer la caché" in caplog.text
    assert "No se pudo guardar el recorte" in caplog.text
