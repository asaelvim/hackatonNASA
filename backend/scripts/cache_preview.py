import json
from datetime import UTC, datetime
from pathlib import Path

from app.archive import frame, search


def main():
    query = {"ra": 269.452083, "dec": 4.693364, "fov": 12, "detector": 1}
    result = search(query["ra"], query["dec"], query["detector"], limit=2)
    observations = result["observations"]
    if len(observations) != 2:
        raise RuntimeError("IRSA no devolvió dos observaciones para la vista previa.")
    frames = [
        frame(observation["source_url"], query["ra"], query["dec"], query["fov"])
        for observation in observations
    ]
    output = Path(__file__).resolve().parents[2] / "src/lib/previews/barnard.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "query": query,
                "saved_at": datetime.now(UTC).isoformat(),
                "observations": observations,
                "frames": frames,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Vista previa real guardada: {output} ({output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
