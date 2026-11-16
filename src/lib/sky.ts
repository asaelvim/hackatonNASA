export interface Query {
  ra: number;
  dec: number;
  fov: number;
  detector: number;
}

export const presets = [
  {
    name: "Barnard's Star",
    ra: 269.452083,
    dec: 4.693364,
    detail: "Proper motion · reference coordinates",
  },
  {
    name: "Epsilon Indi B",
    ra: 331.044167,
    dec: -56.782844,
    detail: "Brown dwarfs · unresolved pair in SPHEREx",
  },
  {
    name: "WISE 0855−0714",
    ra: 133.795129,
    dec: -7.245147,
    detail: "Faint source · a single exposure may not detect it",
  },
  {
    name: "RW Aurigae",
    ra: 76.956542,
    dec: 30.401439,
    detail: "Variable star · brightness changes",
  },
  {
    name: "R Draconis",
    ra: 248.167625,
    dec: 66.754981,
    detail: "Variable star · brightness changes",
  },
];

export const detectors = [
  "0.75–1.09 μm",
  "1.10–1.62 μm",
  "1.63–2.41 μm",
  "2.42–3.82 μm",
  "3.83–4.41 μm",
  "4.42–5.00 μm",
];

export const defaults: Query = {
  ra: presets[0].ra,
  dec: presets[0].dec,
  fov: 12,
  detector: 1,
};

export function validateQuery(query: Query): string | null {
  if (!Number.isFinite(query.ra) || query.ra < 0 || query.ra >= 360)
    return "Right ascension must be between 0 and less than 360 degrees.";
  if (!Number.isFinite(query.dec) || Math.abs(query.dec) > 90)
    return "Declination must be between −90 and 90 degrees.";
  if (!Number.isFinite(query.fov) || query.fov < 1 || query.fov > 30)
    return "Field of view must be between 1 and 30 arcminutes.";
  if (
    !Number.isInteger(query.detector) ||
    query.detector < 1 ||
    query.detector > 6
  )
    return "Select a detector from 1 to 6.";
  return null;
}

export function readQuery(search: string): Query {
  const params = new URLSearchParams(search);
  const query = { ...defaults };
  for (const key of ["ra", "dec", "fov", "detector"] as const) {
    const raw = params.get(key);
    if (raw !== null) query[key] = raw.trim() === "" ? NaN : Number(raw);
  }
  return query;
}

export function shareUrl(base: string, query: Query): string {
  const url = new URL(base);
  for (const key of ["ra", "dec", "fov", "detector"] as const)
    url.searchParams.set(key, String(query[key]));
  return url.toString();
}
