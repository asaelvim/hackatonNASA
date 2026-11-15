import logging
from pathlib import Path
from xml.etree.ElementTree import ParseError

import httpx
from astropy.wcs import NoConvergence
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from app import archive, candidates

logger = logging.getLogger("spherex")
app = FastAPI(title="SPHEREx Explorer", version="0.1.0")
app.add_middleware(GZipMiddleware, minimum_size=1000)


class FrameRequest(BaseModel):
    source_url: str = Field(max_length=512)
    ra: float = Field(ge=0, lt=360, allow_inf_nan=False)
    dec: float = Field(ge=-90, le=90, allow_inf_nan=False)
    fov: float = Field(ge=1, le=30, allow_inf_nan=False)

    @field_validator("source_url")
    @classmethod
    def validate_source(cls, value: str) -> str:
        if not archive.valid_source(value):
            raise ValueError("La URL debe ser un FITS Level 2 de IRSA DR1 o QR3.")
        return value


class CandidateObservation(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    source_url: str = Field(max_length=512)
    obs_id: str = Field(default="", max_length=128)
    mjd: float = Field(allow_inf_nan=False)
    date: str = Field(min_length=10, max_length=40)

    @field_validator("source_url")
    @classmethod
    def validate_source(cls, value: str) -> str:
        if not archive.valid_source(value):
            raise ValueError("La URL debe ser un FITS Level 2 de IRSA DR1 o QR3.")
        return value


class CandidateRequest(BaseModel):
    ra: float = Field(ge=0, lt=360, allow_inf_nan=False)
    dec: float = Field(ge=-90, le=90, allow_inf_nan=False)
    fov: float = Field(ge=1, le=30, allow_inf_nan=False)
    observations: list[CandidateObservation] = Field(
        min_length=3,
        max_length=24,
    )


@app.exception_handler(archive.ArchiveError)
async def archive_error_handler(request: Request, exc: archive.ArchiveError):
    logger.warning("Error de archivo en %s: %s", request.url.path, exc)
    return JSONResponse(status_code=502, content={"detail": str(exc)})


def upstream(operation, *args):
    try:
        return operation(*args)
    except httpx.TimeoutException as exc:
        logger.exception("Tiempo de espera agotado consultando IRSA")
        raise HTTPException(504, "IRSA tardó demasiado; vuelve a intentarlo.") from exc
    except httpx.HTTPError as exc:
        logger.exception("Error HTTP consultando IRSA")
        raise HTTPException(502, "No se pudo descargar la respuesta de IRSA.") from exc
    except (ValueError, OSError, KeyError, ParseError, NoConvergence) as exc:
        logger.exception("No se pudo interpretar o alinear el producto de IRSA")
        raise HTTPException(
            502, "El producto de IRSA no pudo interpretarse o alinearse."
        ) from exc


@app.get("/api/health")
def health():
    return {"status": "ok", "collections": list(archive.COLLECTIONS)}


@app.get("/api/observations")
def observations(
    ra: float = Query(ge=0, lt=360, allow_inf_nan=False),
    dec: float = Query(ge=-90, le=90, allow_inf_nan=False),
    detector: int = Query(default=1, ge=1, le=6),
    limit: int = Query(default=12, ge=2, le=24),
):
    return upstream(archive.search, ra, dec, detector, limit)


@app.post("/api/frame")
def get_frame(body: FrameRequest):
    return upstream(archive.frame, body.source_url, body.ra, body.dec, body.fov)


@app.post("/api/candidates")
def get_candidates(body: CandidateRequest):
    observations = [item.model_dump() for item in body.observations]
    return upstream(
        candidates.analyze,
        observations,
        body.ra,
        body.dec,
        body.fov,
    )


dist = Path(__file__).resolve().parents[2] / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
