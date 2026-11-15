import type { Frame } from "./api";

export type Mode = "image" | "blink" | "overlay" | "difference";

export function sharedRange(
  frames: Frame[],
  hideFlags: boolean,
): [number, number] {
  const values: number[] = [];
  for (const frame of frames)
    for (let i = 0; i < frame.pixels.length; i++)
      if (Number.isFinite(frame.pixels[i]) && (!hideFlags || !frame.flags[i]))
        values.push(frame.pixels[i]);
  if (!values.length) return [0, 1];
  values.sort((a, b) => a - b);
  const low = values[Math.floor((values.length - 1) * 0.01)];
  const high = values[Math.ceil((values.length - 1) * 0.995)];
  return [low, high > low ? high : low + 1];
}

export function renderPixels(
  current: Frame,
  reference: Frame,
  mode: Mode,
  range: [number, number],
  contrast: number,
  hideFlags: boolean,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(current.pixels.length * 4);
  const [low, high] = range;
  const span = Math.max(high - low, 1e-12);
  const stretch = (v: number) =>
    Math.max(
      0,
      Math.min(
        1,
        Math.asinh(Math.max(0, (v - low) / span) * contrast) /
          Math.asinh(contrast),
      ),
    );
  for (let i = 0; i < current.pixels.length; i++) {
    const a = current.pixels[i];
    const b = reference.pixels[i];
    const compare = mode === "overlay" || mode === "difference";
    const valid =
      Number.isFinite(a) &&
      (!hideFlags || !current.flags[i]) &&
      (!compare || (Number.isFinite(b) && (!hideFlags || !reference.flags[i])));
    const offset = i * 4;
    if (!valid) {
      result.set([15, 20, 32, 255], offset);
    } else if (mode === "difference") {
      const delta = Math.max(-1, Math.min(1, ((a - b) * contrast) / span));
      result.set(
        [
          delta > 0 ? delta * 255 : 0,
          Math.abs(delta) * 65,
          delta < 0 ? -delta * 255 : 0,
          255,
        ],
        offset,
      );
    } else if (mode === "overlay") {
      result.set(
        [stretch(a) * 255, stretch(b) * 255, stretch(b) * 255, 255],
        offset,
      );
    } else {
      const value = stretch(a) * 255;
      result.set([value, value, value, 255], offset);
    }
  }
  return result;
}
