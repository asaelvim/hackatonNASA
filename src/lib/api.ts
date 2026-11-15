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
  source_fraction?: number;
  zodi_subtracted?: boolean;
  pixel_scale_arcsec: number;
}

export type EncodedFrame = Omit<Frame, "pixels" | "flags"> & {
  pixels: string;
  flags: string;
};

export interface CandidateTimelinePoint {
  observation_id: string;
  date: string;
  mjd: number;
  frame_index: number;
  x: number;
  y: number;
  detected: boolean;
}

export interface CandidatePoint {
  observation_id: string;
  obs_id: string;
  date: string;
  mjd: number;
  frame_index: number;
  x: number;
  y: number;
  ra: number;
  dec: number;
  flux_proxy: number;
  snr_proxy: number;
  bad_fraction: number;
  peak_sigma: number;
  wavelength_um: number | null;
  bandwidth_um: number | null;
}

export interface Candidate {
  id: string;
  score: number;
  confidence: "high" | "medium" | "low";
  kind: "motion" | "variability" | "motion+variability";
  reason: string;
  epochs: number;
  baseline_days: number;
  coverage_fraction: number;
  continuity: number;
  max_gap_epochs: number;
  motion_arcsec: number;
  motion_arcsec_per_year: number;
  motion_linearity: number;
  motion_significance_proxy: number;
  flux_variability: number;
  variability_epochs: number;
  median_snr_proxy: number;
  mean_bad_fraction: number;
  points: CandidatePoint[];
  timeline: CandidateTimelinePoint[];
}

export interface CandidateResult {
  candidates: Candidate[];
  diagnostics: {
    frames_analyzed: number;
    frame_failures: number;
    detections: number;
    tracks_considered: number;
    candidate_count: number;
  };
  warnings: string[];
  method: {
    background: string;
    threshold_sigma: number;
    minimum_motion_epochs: number;
    minimum_variability_epochs: number;
    maximum_gap_epochs: number;
    assignment: string;
    note: string;
  };
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
    limit: "16",
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

export function decodeFrame(result: EncodedFrame): Frame {
  const pixels = decodeFloats(result.pixels);
  const flags = Uint8Array.from(atob(result.flags), (c) => c.charCodeAt(0));
  if (
    pixels.length !== result.width * result.height ||
    flags.length !== pixels.length
  )
    throw new Error("El tamaño del recorte no coincide con sus metadatos.");
  return { ...result, pixels, flags };
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

export async function analyzeCandidates(
  query: Query,
  observations: Observation[],
  signal: AbortSignal,
): Promise<CandidateResult> {
  return json<CandidateResult>(
    await fetch("/api/candidates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ra: query.ra,
        dec: query.dec,
        fov: query.fov,
        observations: observations.map((observation) => ({
          id: observation.id,
          source_url: observation.source_url,
          obs_id: observation.obs_id,
          mjd: observation.mjd,
          date: observation.date,
        })),
      }),
      signal,
    }),
  );
}
