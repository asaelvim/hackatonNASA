import { describe, expect, it } from "vitest";
import { defaults, readQuery, shareUrl, validateQuery } from "./sky";

describe("coordenadas compartibles", () => {
  it("conserva coordenadas, detector y campo de visión en la URL", () => {
    const query = { ra: 133.795129, dec: -7.245147, detector: 6, fov: 12 };
    const url = new URL(shareUrl("https://example.org/", query));
    expect(readQuery(url.search)).toEqual(query);
    expect(validateQuery(query)).toBeNull();
  });

  it.each([
    "?ra=",
    "?ra=abc",
    "?ra=360",
    "?dec=-91",
    "?fov=0",
    "?detector=2.5",
  ])(
    "rechaza parámetros inválidos sin sustituirlos por coordenadas por defecto: %s",
    (search) => expect(validateQuery(readQuery(search))).not.toBeNull(),
  );

  it("permite coordenadas cero y usa valores iniciales solo para parámetros ausentes", () => {
    expect(readQuery("?ra=0&dec=0")).toEqual({ ...defaults, ra: 0, dec: 0 });
  });
});
