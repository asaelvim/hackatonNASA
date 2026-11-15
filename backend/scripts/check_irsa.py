import json

from app.archive import frame, search

OBJECTS = [
    ("Estrella de Barnard", 269.452083, 4.693364, 1),
    ("Epsilon Indi B", 331.044167, -56.782844, 6),
    ("WISE 0855-0714", 133.795129, -7.245147, 6),
    ("RW Aurigae", 76.956542, 30.401439, 1),
    ("R Draconis", 248.167625, 66.754981, 1),
]


def main():
    for name, ra, dec, detector in OBJECTS:
        result = search(ra, dec, detector, limit=2)
        if len(result["observations"]) < 2:
            raise RuntimeError(f"{name}: faltan observaciones para comparar épocas.")
        cutouts = []
        for observation in result["observations"]:
            prepared = frame(observation["source_url"], ra, dec, fov=12)
            cutouts.append(
                {
                    "observation": observation,
                    "metadata": {
                        key: value
                        for key, value in prepared.items()
                        if key not in ("pixels", "flags")
                    },
                }
            )
        print(
            json.dumps(
                {
                    "object": name,
                    "total": result["total"],
                    "warnings": result["warnings"],
                    "cutouts": cutouts,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
