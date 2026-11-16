import type { Query } from "./sky";

export interface Observation {
  id: string;
  source_url: string;
  collection: string;
  detector: number;
  obs_id: string;
  mjd: number;
  date: string;
}

export interface SearchResult {
  observations: Observation[];
  total: number;
  warnings: string[];
  collections: string[];
}

export interface Frame {
  width: number;
  height: number;
  pixels: Float32Array;
  flags: Uint8Array;
  unit: string;
  wavelength_um: number | null;
  bandwidth_um: number | null;
  coverage: number;
  flagged_fraction: number;
  pixel_scale_arcsec: number;
}

export interface MovingSourceAnalysis {
  masks: Uint8Array[];
  counts: number[];
}

export interface AnomalyReport {
  observation_id: string;
  date: string;
  x: number;
  y: number;
  category: string;
  detail: string;
  confidence: string;
}

export type EncodedFrame = Omit<Frame, "pixels" | "flags"> & {
  pixels: string;
  flags: string;
};

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json();
    throw new Error(
      typeof body.detail === "string"
        ? body.detail
        : `Invalid request (${response.status}).`,
    );
  }
  return response.json();
}

export async function search(
  query: Query,
  signal: AbortSignal,
): Promise<SearchResult> {
  const params = new URLSearchParams({
    ra: String(query.ra),
    dec: String(query.dec),
    detector: String(query.detector),
  });
  return json(await fetch(`/api/observations?${params}`, { signal }));
}

export function decodeFloats(encoded: string): Float32Array {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (bytes.length % 4 !== 0)
    throw new Error("Cutout contains invalid pixel data.");
  const view = new DataView(bytes.buffer);
  return Float32Array.from({ length: bytes.length / 4 }, (_, i) =>
    view.getFloat32(i * 4, true),
  );
}

export function decodeFrame(result: EncodedFrame): Frame {
  const pixels = decodeFloats(result.pixels);
  const flags = Uint8Array.from(atob(result.flags), (c) => c.charCodeAt(0));
  if (
    pixels.length !== result.width * result.height ||
    flags.length !== pixels.length
  )
    throw new Error("Cutout size does not match its metadata.");
  return { ...result, pixels, flags };
}

function encodeBytes(values: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < values.length; offset += 0x8000)
    encoded += String.fromCharCode(...values.subarray(offset, offset + 0x8000));
  return btoa(encoded);
}

export async function detectMovingSources(
  frames: Frame[],
  signal: AbortSignal,
): Promise<MovingSourceAnalysis> {
  const result = await json<{ masks: string[]; counts: number[] }>(
    await fetch("/api/moving-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frames: frames.map((frame) => ({
          width: frame.width,
          height: frame.height,
          pixels: encodeBytes(
            new Uint8Array(
              frame.pixels.buffer,
              frame.pixels.byteOffset,
              frame.pixels.byteLength,
            ),
          ),
          flags: encodeBytes(frame.flags),
        })),
      }),
      signal,
    }),
  );
  if (
    result.masks.length !== frames.length ||
    result.counts.length !== frames.length
  )
    throw new Error("The detector returned an incomplete anomaly series.");
  const masks = result.masks.map((encoded, index) => {
    const mask = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
    if (mask.length !== frames[index].pixels.length)
      throw new Error("The detector returned a mask with an invalid size.");
    return mask;
  });
  return { masks, counts: result.counts };
}

export async function saveAnomalyReport(report: AnomalyReport): Promise<void> {
  await json(
    await fetch("/api/anomaly-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    }),
  );
}

export async function loadFrame(
  observation: Observation,
  query: Query,
  signal: AbortSignal,
): Promise<Frame> {
  const result = await json<EncodedFrame>(
    await fetch("/api/frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_url: observation.source_url,
        ra: query.ra,
        dec: query.dec,
        fov: query.fov,
      }),
      signal,
    }),
  );
  return decodeFrame(result);
}
