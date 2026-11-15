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
from app.main import app

URL = (
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/"
    "2025W33_2C/l2b-v27-2026-228/1/"
    "level2_2025W33_2C_0321_1D1_spx_l2b-v27-2026-228.fits"
)


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
