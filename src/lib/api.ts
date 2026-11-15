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

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json();
    throw new Error(
      typeof body.detail === "string"
        ? body.detail
        : `Solicitud inválida (${response.status}).`,
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
    limit: "12",
  });
  return json(await fetch(`/api/observations?${params}`, { signal }));
}

export function decodeFloats(encoded: string): Float32Array {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (bytes.length % 4 !== 0)
    throw new Error("Recorte con datos de píxeles inválidos.");
  const view = new DataView(bytes.buffer);
  return Float32Array.from({ length: bytes.length / 4 }, (_, i) =>
    view.getFloat32(i * 4, true),
  );
}

export async function loadFrame(
  observation: Observation,
  query: Query,
  signal: AbortSignal,
): Promise<Frame> {
  const result = await json<
    Omit<Frame, "pixels" | "flags"> & { pixels: string; flags: string }
  >(
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
  const pixels = decodeFloats(result.pixels);
  const flags = Uint8Array.from(atob(result.flags), (c) => c.charCodeAt(0));
  if (
    pixels.length !== result.width * result.height ||
    flags.length !== pixels.length
  )
    throw new Error("El tamaño del recorte no coincide con sus metadatos.");
  return { ...result, pixels, flags };
}
