import base64
import logging
import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from xml.etree.ElementTree import ParseError

import httpx
import numpy as np
from astropy.wcs import NoConvergence
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from app import archive, motion

logger = logging.getLogger("spherex")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        yield
    finally:
        archive.close_client()


app = FastAPI(title="SPHEREx Explorer", version="0.1.0", lifespan=lifespan)
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
            raise ValueError("The URL must be an IRSA DR1 or QR3 Level 2 FITS file.")
        return value


class MotionFrameRequest(BaseModel):
    width: int = Field(ge=10, le=300)
    height: int = Field(ge=10, le=300)
    pixels: str = Field(max_length=600000)
    flags: str = Field(max_length=150000)


class MotionRequest(BaseModel):
    frames: list[MotionFrameRequest] = Field(min_length=2, max_length=60)


class AnomalyReportRequest(BaseModel):
    observation_id: str = Field(min_length=1, max_length=128)
    date: str = Field(min_length=1, max_length=64)
    x: int = Field(ge=0, le=299)
    y: int = Field(ge=0, le=299)
    category: str = Field(pattern="^(position|brightness|appearance|shape|other)$")
    detail: str = Field(min_length=1, max_length=256)
    confidence: str = Field(pattern="^(very|somewhat|unsure)$")



@app.exception_handler(archive.ArchiveError)
async def archive_error_handler(request: Request, exc: archive.ArchiveError):
    logger.warning("Error de archivo en %s: %s", request.url.path, exc)
    return JSONResponse(status_code=502, content={"detail": str(exc)})


def upstream(operation, *args):
    try:
        return operation(*args)
    except httpx.TimeoutException as exc:
        logger.exception("Tiempo de espera agotado consultando IRSA")
        raise HTTPException(504, "IRSA took too long; please try again.") from exc
    except httpx.HTTPError as exc:
        logger.exception("Error HTTP consultando IRSA")
        raise HTTPException(502, "Could not download the response from IRSA.") from exc
    except (ValueError, OSError, KeyError, ParseError, NoConvergence) as exc:
        logger.exception("No se pudo interpretar o alinear el producto de IRSA")
        raise HTTPException(
            502, "The IRSA product could not be interpreted or aligned."
        ) from exc


@app.get("/api/health")
def health():
    return {"status": "ok", "collections": list(archive.COLLECTIONS)}


@app.get("/api/observations")
def observations(
    ra: float = Query(ge=0, lt=360, allow_inf_nan=False),
    dec: float = Query(ge=-90, le=90, allow_inf_nan=False),
    detector: int = Query(default=1, ge=1, le=6),
    limit: int | None = Query(default=None, ge=2, le=24),
):
    return upstream(archive.search, ra, dec, detector, limit)


@app.post("/api/frame")
def get_frame(body: FrameRequest):
    return upstream(archive.frame, body.source_url, body.ra, body.dec, body.fov)


@app.post("/api/moving-sources")
def moving_sources(body: MotionRequest):
    images = []
    flags = []
    try:
        for frame in body.frames:
            pixels = base64.b64decode(frame.pixels, validate=True)
            quality = base64.b64decode(frame.flags, validate=True)
            expected = frame.width * frame.height
            if len(pixels) != expected * 4 or len(quality) != expected:
                raise ValueError(
                    "Cutout size does not match its metadata."
                )
            images.append(
                np.frombuffer(pixels, dtype="<f4").reshape(frame.height, frame.width)
            )
            flags.append(
                np.frombuffer(quality, dtype=np.uint8).reshape(
                    frame.height, frame.width
                )
                != 0
            )
        masks, counts = motion.moving_source_masks(images, flags)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {
        "masks": [base64.b64encode(mask.tobytes()).decode() for mask in masks],
        "counts": counts,
    }


@app.post("/api/anomaly-reports", status_code=201)
def save_anomaly_report(body: AnomalyReportRequest):
    database = Path(os.getenv("SPHEREX_REPORTS_DB", "anomaly-reports.sqlite3"))
    try:
        with sqlite3.connect(database) as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS anomaly_reports (
                    id INTEGER PRIMARY KEY,
                    observation_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    x INTEGER NOT NULL,
                    y INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    confidence TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )"""
            )
            connection.execute(
                """INSERT INTO anomaly_reports
                (observation_id, date, x, y, category, detail, confidence)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    body.observation_id,
                    body.date,
                    body.x,
                    body.y,
                    body.category,
                    body.detail,
                    body.confidence,
                ),
            )
    except sqlite3.Error as exc:
        logger.exception("No se pudo guardar el reporte de anomalía")
        raise HTTPException(500, "Could not save the report.") from exc
    return {"status": "saved"}


dist = Path(__file__).resolve().parents[2] / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
