FROM python:3.13-slim

WORKDIR /app
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
    "fastapi>=0.115,<1" \
    "uvicorn[standard]>=0.34,<1" \
    "httpx>=0.28,<1" \
    "astropy>=7,<9" \
    "numpy>=2,<3" \
    "scipy>=1.15,<2"

COPY app ./app
ENV PORT=8080
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
