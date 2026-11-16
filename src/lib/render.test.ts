import { describe, expect, it } from "vitest";
import { decodeFloats } from "./api";
import type { Frame } from "./api";
import { renderPixels, sharedRange } from "./render";

function frame(pixels: number[], flags = pixels.map(() => 0)): Frame {
  return {
    width: pixels.length,
    height: 1,
    pixels: Float32Array.from(pixels),
    flags: Uint8Array.from(flags),
    unit: "MJy/sr",
    wavelength_um: 1,
    bandwidth_um: 0.02,
    coverage: 1,
    flagged_fraction: 0,
    pixel_scale_arcsec: 6.2,
  };
}

describe("comparación científica en Canvas", () => {
  it("decodifica valores little-endian y conserva píxeles sin cobertura", () => {
    const bytes = new ArrayBuffer(8);
    const view = new DataView(bytes);
    view.setFloat32(0, 2.5, true);
    view.setFloat32(4, NaN, true);
    const encoded = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const result = decodeFloats(encoded);
    expect(result[0]).toBe(2.5);
    expect(result[1]).toBeNaN();
  });

  it("usa una escala común sin renormalizar cada observación", () => {
    const a = frame([1, 2, 3]);
    const b = frame([1, 2, 8]);
    const range = sharedRange([a, b], false);
    const first = renderPixels(a, a, "image", range, 5, false);
    const second = renderPixels(b, b, "image", range, 5, false);
    expect(first.slice(0, 8)).toEqual(second.slice(0, 8));
    expect(second[8]).toBeGreaterThan(first[8]);
  });

  it("representa diferencias positivas en rojo y negativas en azul", () => {
    const result = renderPixels(
      frame([2, 0]),
      frame([1, 1]),
      "difference",
      [0, 2],
      1,
      false,
    );
    expect(result[0]).toBeGreaterThan(0);
    expect(result[2]).toBe(0);
    expect(result[4]).toBe(0);
    expect(result[6]).toBeGreaterThan(0);
  });

  it("enmascara la unión de banderas y cobertura en comparaciones", () => {
    const result = renderPixels(
      frame([2, NaN]),
      frame([1, 1], [1, 0]),
      "overlay",
      [0, 2],
      1,
      true,
    );
    expect([...result]).toEqual([15, 20, 32, 255, 15, 20, 32, 255]);
  });

  it("resalta las anomalías sobre la imagen original", () => {
    const result = renderPixels(
      frame([1, 2]),
      frame([1, 2]),
      "anomaly",
      [0, 2],
      1,
      false,
      Uint8Array.from([0, 1]),
    );

    expect([...result.slice(4, 8)]).toEqual([255, 202, 80, 255]);
  });
});
