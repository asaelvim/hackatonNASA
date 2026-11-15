import { decodeFrame } from "./api";
import type { Frame, Observation } from "./api";
import type { Query } from "./sky";
import saved from "./previews/barnard.json";

interface SavedPreview {
  savedAt: string;
  observations: Observation[];
  frames: Frame[];
}

export function matchesSavedPreview(query: Query): boolean {
  return (["ra", "dec", "fov", "detector"] as const).every(
    (key) => query[key] === saved.query[key],
  );
}

export function getSavedPreview(query: Query): SavedPreview | null {
  if (!matchesSavedPreview(query)) return null;
  return {
    savedAt: saved.saved_at,
    observations: saved.observations,
    frames: saved.frames.map(decodeFrame),
  };
}
