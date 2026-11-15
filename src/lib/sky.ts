export interface Query {
  ra: number;
  dec: number;
  fov: number;
  detector: number;
}

export const presets = [
  {
    name: "Estrella de Barnard",
    ra: 269.452083,
    dec: 4.693364,
    detail: "Movimiento propio · coordenadas de referencia",
  },
  {
    name: "Epsilon Indi B",
    ra: 331.044167,
    dec: -56.782844,
    detail: "Enanas marrones · par no resuelto por SPHEREx",
  },
  {
    name: "WISE 0855−0714",
    ra: 133.795129,
    dec: -7.245147,
    detail: "Fuente débil · una exposición puede no detectarla",
  },
  {
    name: "RW Aurigae",
    ra: 76.956542,
    dec: 30.401439,
    detail: "Estrella variable · cambios de brillo",
  },
  {
    name: "R Draconis",
    ra: 248.167625,
    dec: 66.754981,
    detail: "Estrella variable · cambios de brillo",
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
    return "La ascensión recta debe estar entre 0 y menos de 360 grados.";
  if (!Number.isFinite(query.dec) || Math.abs(query.dec) > 90)
    return "La declinación debe estar entre −90 y 90 grados.";
  if (!Number.isFinite(query.fov) || query.fov < 1 || query.fov > 30)
    return "El campo de visión debe estar entre 1 y 30 minutos de arco.";
  if (
    !Number.isInteger(query.detector) ||
    query.detector < 1 ||
    query.detector > 6
  )
    return "Selecciona un detector entre 1 y 6.";
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
