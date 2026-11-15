import { describe, expect, it } from "vitest";
import { getSavedPreview } from "./saved-preview";
import { defaults } from "./sky";

describe("vista previa científica local", () => {
  it("no muestra Barnard para otras coordenadas, detectores o tamaños de campo", () => {
    expect(getSavedPreview({ ...defaults, ra: 0, dec: 0 })).toBeNull();
    expect(getSavedPreview({ ...defaults, detector: 6 })).toBeNull();
    expect(getSavedPreview({ ...defaults, fov: 6 })).toBeNull();
  });

  it("recupera fotogramas alineados con sus fechas y píxeles científicos", () => {
    const preview = getSavedPreview(defaults);
    expect(preview).not.toBeNull();
    expect(preview!.observations[0].mjd).toBeLessThan(
      preview!.observations[1].mjd,
    );
    for (const frame of preview!.frames) {
      expect(frame.pixels.length).toBe(frame.width * frame.height);
      expect(frame.flags.length).toBe(frame.pixels.length);
      expect(frame.pixels.some(Number.isFinite)).toBe(true);
    }
  });
});
