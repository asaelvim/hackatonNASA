import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

function encodedPixels(values: number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString("base64");
}

async function selectReference(page: Page, value: string) {
  await page.locator("#settings-toggle").click();
  await page.getByLabel("Referencia B").selectOption(value);
  await page.keyboard.press("Escape");
}

async function mockArchive(
  page: Page,
  count: number,
  waitForFrame?: (index: number) => Promise<void>,
) {
  await page.route("**/api/observations?*", (route) =>
    route.fulfill({
      json: {
        total: count,
        warnings: [],
        collections: ["spherex_dr1", "spherex_qr3"],
        observations: Array.from({ length: count }, (_, i) => ({
          id: String(i),
          source_url: `https://irsa.ipac.caltech.edu/test-${i}.fits`,
          collection: "spherex_dr1",
          detector: 1,
          obs_id: `test-${i}`,
          mjd: 60000 + i * 365,
          date: `${2025 + i}-05-01T00:00:00.000Z`,
        })),
      },
    }),
  );
  await page.route("**/api/frame", async (route) => {
    const source = route.request().postDataJSON().source_url as string;
    const index = Number(source.split("test-")[1].split(".")[0]);
    if (waitForFrame) await waitForFrame(index);
    return route.fulfill({
      json: {
        width: 2,
        height: 2,
        pixels: encodedPixels([1, 2, 3, 4].map((value) => value + index)),
        flags: Buffer.alloc(4).toString("base64"),
        unit: "MJy/sr",
        wavelength_um: 1.0,
        bandwidth_um: 0.02,
        coverage: 1,
        flagged_fraction: 0,
        pixel_scale_arcsec: 6.2,
      },
    });
  });
}

test("al entrar carga y reproduce la región sin pulsar explorar", async ({
  page,
}) => {
  const exceptions: string[] = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  await mockArchive(page, 2);
  await page.goto("/");
  await expect(page.locator(".series-pane canvas")).toHaveAttribute(
    "width",
    "2",
  );
  await expect(page.getByRole("status")).toContainText(
    "2 imágenes reales listas",
  );
  await expect(page).toHaveURL(/ra=269.452083/);
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await page.locator("#timeline").focus();
  await page.keyboard.press("End");
  await selectReference(page, "0");
  await page.getByLabel("Visualización").selectOption("difference");
  const pixel = await page
    .locator(".series-pane canvas")
    .evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return [...canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data];
    });
  expect(pixel[0]).toBeGreaterThan(0);
  expect(pixel[2]).toBe(0);
  await page.getByLabel("Visualización").selectOption("blink");
  await page.getByRole("button", { name: "Reproducir", exact: true }).click();
  await expect(page.locator(".image-label")).toContainText("2025-05-01");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  expect(exceptions).toEqual([]);
});

test("solicita y prepara las 60 observaciones sin limitar la serie a 12", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const requested: number[] = [];
  await mockArchive(page, 60, async (index) => {
    requested.push(index);
  });
  const searchRequest = page.waitForRequest((request) =>
    request.url().includes("/api/observations?"),
  );
  await page.goto("/");
  expect(new URL((await searchRequest).url()).searchParams.has("limit")).toBe(
    false,
  );
  await expect(page.getByRole("status")).toContainText(
    "60 imágenes reales listas · 60 observaciones encontradas",
  );
  expect(new Set(requested).size).toBe(60);
  await expect(page.locator("#timeline")).toHaveAttribute("max", "59");
  await page.locator("#timeline").focus();
  await page.keyboard.press("End");
  await expect(page.locator(".transport > span")).toHaveText("60 / 60");
  await expect(page.locator(".image-label")).toContainText("2084-05-01");
});

test("muestra serie y superposición juntas con fechas grandes y controles compartidos", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockArchive(page, 3);
  await page.goto("/");
  const series = page.locator(".series-pane");
  const overlay = page.locator(".overlay-pane");
  await expect(series.getByRole("heading")).toHaveText("Serie temporal");
  await expect(overlay.getByRole("heading")).toHaveText("Superponer A/B");
  await expect(page.locator("canvas")).toHaveCount(2);
  await expect(overlay.locator(".overlay-date")).toContainText(
    "A · 2025-05-01",
  );
  await expect(overlay.locator(".overlay-date")).toContainText(
    "B · 2026-05-01",
  );
  const seriesBounds = await series.boundingBox();
  const overlayBounds = await overlay.boundingBox();
  expect(overlayBounds!.x).toBeGreaterThanOrEqual(
    seriesBounds!.x + seriesBounds!.width,
  );
  await expect(series.locator(".image-label > span:first-child")).toHaveCSS(
    "font-size",
    "24px",
  );
  const pixels = (selector: string) =>
    page.locator(selector).evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      return [...canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data];
    });
  const seriesPixel = await pixels(".series-pane canvas");
  const overlayPixel = await pixels(".overlay-pane canvas");
  expect(seriesPixel[0]).toBe(seriesPixel[1]);
  expect(seriesPixel[1]).toBe(seriesPixel[2]);
  expect(overlayPixel[0]).toBeLessThan(overlayPixel[1]);
  expect(overlayPixel[1]).toBe(overlayPixel[2]);
  await page.locator("#timeline").focus();
  await page.keyboard.press("End");
  await expect(series.locator(".image-label")).toContainText("2027-05-01");
  await expect(overlay.locator(".overlay-date")).toContainText(
    "A · 2027-05-01",
  );
  const laterPixel = await pixels(".overlay-pane canvas");
  expect(laterPixel[0]).toBeGreaterThan(overlayPixel[0]);
  expect(laterPixel[1]).toBe(overlayPixel[1]);
  await selectReference(page, "0");
  const changedReference = await pixels(".overlay-pane canvas");
  expect(changedReference[0]).toBe(laterPixel[0]);
  expect(changedReference[1]).toBeLessThan(laterPixel[1]);
  await page.getByRole("button", { name: "Acercar", exact: true }).click();
  await expect(series.locator("canvas")).toHaveCSS(
    "transform",
    "matrix(1.5, 0, 0, 1.5, 0, 0)",
  );
  await expect(overlay.locator("canvas")).toHaveCSS(
    "transform",
    "matrix(1.5, 0, 0, 1.5, 0, 0)",
  );
  await page.getByRole("button", { name: "Restablecer vista" }).click();
  await page.screenshot({ path: testInfo.outputPath("dual-viewers.png") });
  await page.setViewportSize({ width: 320, height: 900 });
  const mobileSeries = await series.boundingBox();
  const mobileOverlay = await overlay.boundingBox();
  expect(mobileOverlay!.y).toBeGreaterThanOrEqual(
    mobileSeries!.y + mobileSeries!.height,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await expect(series.locator("canvas")).toBeVisible();
  await expect(overlay.locator("canvas")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("dual-viewers-mobile.png"),
  });
});

test("una nueva consulta con una sola imagen sale del modo diferencia", async ({
  page,
}) => {
  await mockArchive(page, 2);
  await page.goto("/?ra=0&dec=0&fov=6&detector=1");
  await expect(page.getByRole("status")).toContainText(
    "2 imágenes reales listas",
  );
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await page.getByLabel("Visualización").selectOption("difference");
  await page.unroute("**/api/observations?*");
  await mockArchive(page, 1);
  await page.getByRole("button", { name: "Explorar región" }).click();
  await expect(page.getByRole("status")).toContainText(
    "1 imágenes reales listas",
  );
  await expect(page.getByLabel("Visualización")).toHaveValue("image");
  await expect(page.locator(".overlay-pane canvas")).toHaveCount(0);
  await expect(page.locator(".overlay-pane")).toContainText(
    "Se necesitan al menos dos observaciones",
  );
  await expect(
    page.getByRole("button", { name: "Reproducir", exact: true }),
  ).toBeDisabled();
});

test("un error del archivo no se sustituye por imágenes ficticias", async ({
  page,
}) => {
  await page.route("**/api/observations?*", (route) =>
    route.fulfill({ status: 502, json: { detail: "IRSA no disponible." } }),
  );
  await page.goto("/?ra=0&dec=0&fov=12&detector=1");
  await expect(page.getByRole("alert")).toContainText("IRSA no disponible.");
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("cancelar una consulta devuelve el control sin crear una serie", async ({
  page,
}) => {
  await page.route("**/api/observations?*", () => {});
  await page.goto("/?ra=0&dec=0&fov=12&detector=1");
  const progress = page.getByRole("progressbar", {
    name: "Cargando observaciones",
  });
  await expect(progress).toBeVisible();
  await expect(progress).not.toHaveAttribute("aria-valuenow");
  const barBounds = await progress.boundingBox();
  const headerBounds = await page.locator(".toolbar").boundingBox();
  expect(barBounds!.y).toBe(headerBounds!.y);
  expect(barBounds!.width).toBe(headerBounds!.width);
  expect(barBounds!.height).toBeLessThanOrEqual(4);
  await page.getByRole("button", { name: "Cancelar consulta" }).click();
  await expect(page.getByRole("status")).toContainText("Consulta cancelada");
  await expect(
    page.getByRole("button", { name: "Explorar región" }),
  ).toBeEnabled();
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(progress).toHaveCount(0);
});

test("los controles y desplegables caben en móviles estrechos", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await mockArchive(page, 0);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Explorar región" }),
  ).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflows).toBe(false);
  for (const toggle of ["#region-toggle", "#settings-toggle"]) {
    await page.locator(toggle).click();
    const bounds = await page
      .locator("details[open] .popover-content")
      .boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    await expect(page.locator(toggle)).toBeFocused();
    await expect(page.locator("details[open]")).toHaveCount(0);
  }
  await page.locator("#settings-toggle").click();
  await page.locator(".toolbar").click({ position: { x: 2, y: 2 } });
  await expect(page.locator("details[open]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("mobile.png") });
});

test("el visor es la superficie principal en escritorio", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await mockArchive(page, 2);
  await page.goto("/");
  await expect(page.locator(".series-pane canvas")).toHaveAttribute(
    "width",
    "2",
  );
  const layout = await page.locator(".sky-view").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      width: bounds.width,
      height: bounds.height,
      top: bounds.top,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    };
  });
  expect(layout.width).toBeGreaterThan(layout.viewportWidth * 0.95);
  expect(layout.height).toBeGreaterThan(layout.viewportHeight * 0.8);
  expect(layout.top).toBeLessThan(110);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.colorScheme).toBe("light");
  await expect(page.locator("details[open]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("desktop.png") });
});

test("muestra la carga y revela la serie ordenada solo cuando termina", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mockArchive(page, 3, async (index) => {
    if (index === 0) await pending;
  });
  try {
    await page.goto("/");
    await expect(page.locator(".loading-state")).toBeVisible();
    await expect(page.locator(".loading-detail")).toHaveText(
      "2 de 3 observaciones procesadas",
    );
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByTestId("saved-preview")).toHaveCount(0);
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "70",
    );
    await expect(page.locator(".loading-arc")).toHaveAttribute(
      "stroke-dashoffset",
      "30",
    );
    await expect(page.locator(".loading-value")).toHaveText("70%");
    await expect(
      page.getByRole("button", { name: "Explorar región" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Reproducir", exact: true }),
    ).toBeDisabled();
    await expect(page.locator("#timeline")).toBeDisabled();
    await expect(page.locator(".loading-orbit")).toHaveCSS(
      "animation-name",
      "none",
    );
    await expect(page.locator(".loading-satellite")).toHaveCSS(
      "animation-name",
      "none",
    );
    await page.screenshot({ path: testInfo.outputPath("loading-light.png") });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByRole("button", { name: "Activar modo oscuro" }).click();
    await expect(page.locator(".loading-state")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
    await page.screenshot({
      path: testInfo.outputPath("loading-dark-mobile.png"),
    });
    release();
    await expect(page.getByRole("status")).toContainText(
      "3 imágenes reales listas",
    );
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(page.locator(".loading-state")).toHaveCount(0);
    await expect(page.locator(".series-pane canvas")).toBeVisible();
    await expect(page.locator(".image-label")).toContainText("2025-05-01");
    await expect(page.locator(".transport > span")).toHaveText("1 / 3");
    await page.locator("#timeline").focus();
    await page.keyboard.press("End");
    await expect(page.locator(".image-label")).toContainText("2027-05-01");
  } finally {
    release();
  }
});

test("el logo monocromático gira dentro del progreso y respeta el movimiento reducido", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/observations?*", () => {});
  await page.goto("/");
  const satellite = page.locator(".loading-satellite");
  await expect(satellite).toBeVisible();
  await expect(satellite).not.toHaveCSS("mask-image", "none");
  const ringColor = await page
    .locator(".loading-arc")
    .evaluate((element) => getComputedStyle(element).stroke);
  await expect(satellite).toHaveCSS("background-color", ringColor);
  const initialTransform = await satellite.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await expect
    .poll(() =>
      satellite.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe(initialTransform);
  const imageBounds = await page.locator(".loading-satellite").boundingBox();
  const valueBounds = await page.locator(".loading-value").boundingBox();
  expect(valueBounds!.y).toBeGreaterThan(imageBounds!.y + imageBounds!.height);
  await page.screenshot({ path: testInfo.outputPath("satellite-light.png") });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "Activar modo oscuro" }).click();
  await expect(satellite).toBeVisible();
  const darkRingColor = await page
    .locator(".loading-arc")
    .evaluate((element) => getComputedStyle(element).stroke);
  await expect(satellite).toHaveCSS("background-color", darkRingColor);
  expect(darkRingColor).not.toBe(ringColor);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await page.screenshot({
    path: testInfo.outputPath("satellite-dark-mobile.png"),
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(satellite).toHaveCSS("animation-name", "none");
  await expect(satellite).toHaveCSS("transform", "none");
  await expect(page.locator(".loading-orbit")).toHaveCSS(
    "animation-name",
    "none",
  );
});

test("el botón de sol y luna cambia el tema sin alterar las imágenes", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockArchive(page, 2);
  await page.goto("/?ra=0&dec=0&fov=6&detector=1");
  await expect(page.getByRole("status")).toContainText(
    "2 imágenes reales listas",
  );
  const canvas = page.locator(".series-pane canvas");
  const pixels = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return [
      ...canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data,
    ];
  });
  const lightBackground = await page
    .locator(".app")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.getByRole("button", { name: "Activar modo oscuro" }).click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator(".app")).not.toHaveCSS(
    "background-color",
    lightBackground,
  );
  await page.setViewportSize({ width: 320, height: 900 });
  const button = page.getByRole("button", { name: "Activar modo claro" });
  await expect(button).toBeVisible();
  const bounds = await button.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.x + bounds!.width).toBeGreaterThan(290);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await page.locator("#settings-toggle").click();
  await page.screenshot({ path: testInfo.outputPath("dark-settings.png") });
  await page.keyboard.press("Escape");
  await button.click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await expect(page.locator(".app")).toHaveCSS(
    "background-color",
    lightBackground,
  );
  const restoredPixels = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return [
      ...canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data,
    ];
  });
  expect(restoredPixels).toEqual(pixels);
});

test("la región se configura bajo demanda y se aplica desde la barra", async ({
  page,
}) => {
  await mockArchive(page, 2);
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText(
    "2 imágenes reales listas",
  );
  await page.locator("#region-toggle").click();
  await page.getByLabel("Ascensión recta").fill("20");
  await page.getByLabel("Declinación").fill("30");
  await page.getByLabel("Campo de visión").fill("6");
  await page.getByLabel("Detector infrarrojo").selectOption("2");
  const request = page.waitForRequest(
    (request) =>
      request.url().includes("/api/observations?") &&
      new URL(request.url()).searchParams.get("ra") === "20",
  );
  await page
    .getByRole("button", { name: "Explorar región", exact: true })
    .click();
  const params = new URL((await request).url()).searchParams;
  expect(params.get("dec")).toBe("30");
  expect(params.get("detector")).toBe("2");
  await expect(page).toHaveURL(/fov=6/);
  await expect(page.locator(".region-popover")).not.toHaveAttribute("open");
  await expect(page.locator(".coordinates")).toHaveText("20.00000°, 30.00000°");
  await page.locator("#region-toggle").click();
  await page.getByLabel("Ascensión recta").fill("360");
  await page
    .getByRole("button", { name: "Explorar región", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "La ascensión recta debe estar entre 0 y menos de 360 grados.",
  );
  await expect(page.locator(".region-popover")).toHaveAttribute("open");
});

test("ampliar permite desplazar la imagen y restablecer la vista", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await mockArchive(page, 2);
  await page.goto("/");
  await expect(page.locator(".series-pane canvas")).toHaveAttribute(
    "width",
    "2",
  );
  const viewer = page.locator(".sky-view");
  const canvas = page.locator(".series-pane canvas");
  await page.getByRole("button", { name: "Acercar", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restablecer vista" }),
  ).toHaveText("150%");
  await viewer.focus();
  await page.keyboard.press("+");
  await expect(
    page.getByRole("button", { name: "Restablecer vista" }),
  ).toHaveText("200%");
  await page.keyboard.press("ArrowRight");
  await expect(canvas).toHaveCSS("transform", "matrix(2, 0, 0, 2, -30, 0)");
  const bounds = await viewer.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2 + 40,
    bounds!.y + bounds!.height / 2 + 20,
  );
  await page.mouse.up();
  await expect(canvas).toHaveCSS("transform", "matrix(2, 0, 0, 2, 10, 20)");
  await page.getByRole("button", { name: "Restablecer vista" }).click();
  await expect(canvas).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(
    page.getByRole("button", { name: "Alejar", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Alternar pantalla completa" })
    .click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.className))
    .toBe("app");
  await page
    .getByRole("button", { name: "Alternar pantalla completa" })
    .click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
});

test("cancelar descarta la carga parcial y conserva la última serie completa", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockArchive(page, 2);
  await page.goto("/?ra=0&dec=0&fov=6&detector=1");
  await expect(page.getByRole("status")).toContainText(
    "2 imágenes reales listas",
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mockArchive(page, 3, async (index) => {
    if (index === 0) await pending;
  });
  try {
    await page.getByRole("button", { name: "Explorar región" }).click();
    await expect(page.locator(".loading-detail")).toHaveText(
      "2 de 3 observaciones procesadas",
    );
    await expect(page.locator("canvas")).toHaveCount(0);
    await page.getByRole("button", { name: "Cancelar consulta" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Se conservaron 2 imágenes",
    );
    await expect(page.locator(".image-label")).toContainText("2025-05-01");
    await expect(page.locator(".transport > span")).toHaveText("1 / 2");
    await expect(page.locator(".loading-state")).toHaveCount(0);
    release();
    await page.getByRole("button", { name: "Explorar región" }).click();
    await expect(page.getByRole("status")).toContainText(
      "3 imágenes reales listas",
    );
    await expect(page.locator(".transport > span")).toHaveText("1 / 3");
  } finally {
    release();
  }
});

test("la búsqueda muestra una carga expresiva en lugar de la vista previa", async ({
  page,
}, testInfo) => {
  await page.route("**/api/observations?*", () => {});
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Buscando tu región" }),
  ).toBeVisible();
  await expect(page.getByTestId("saved-preview")).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Cancelar consulta" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("searching.png"),
  });
});

test("un fallo de IRSA se informa sin hacer pasar la vista guardada por datos nuevos", async ({
  page,
}) => {
  await page.route("**/api/observations?*", (route) =>
    route.fulfill({ status: 502, json: { detail: "IRSA no disponible." } }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("IRSA no disponible.");
  await expect(page.getByTestId("saved-preview")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "La actualización falló",
  );
  await expect(page.locator(".series-pane canvas")).toBeVisible();
});

test("un recorte fallido se informa como resultado parcial al terminar", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mockArchive(page, 3, (index) =>
    index === 0 ? pending : Promise.resolve(),
  );
  await page.route("**/api/frame", (route) => {
    const source = route.request().postDataJSON().source_url as string;
    return source.endsWith("test-1.fits")
      ? route.fulfill({
          status: 502,
          json: { detail: "No se pudo descargar la respuesta de IRSA." },
        })
      : route.fallback();
  });
  try {
    await page.goto("/?ra=0&dec=0&fov=6&detector=1");
    await expect(page.locator(".loading-detail")).toHaveText(
      "2 de 3 observaciones procesadas",
    );
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.locator(".frame-issues")).toHaveCount(0);
    release();
    await expect(page.getByRole("status")).toContainText(
      "2 de 3 imágenes listas · resultado parcial",
    );
    await expect(page.locator(".series-pane canvas")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.locator(".frame-issues summary").click();
    await expect(page.locator(".frame-issues")).toContainText("test-1");
    await expect(page.locator(".frame-issues")).toContainText(
      "No se pudo descargar la respuesta de IRSA.",
    );
    await expect(page.locator(".transport > span")).toHaveText("1 / 2");
    await page.locator("#timeline").focus();
    await page.keyboard.press("End");
    await expect(page.locator(".image-label")).toContainText("2027-05-01");
  } finally {
    release();
  }
});

test("si fallan todos los recortes conserva la serie anterior y sus coordenadas", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockArchive(page, 2);
  await page.goto("/?ra=0&dec=0&fov=6&detector=1");
  await expect(page.getByRole("status")).toContainText(
    "2 imágenes reales listas",
  );
  await page.route("**/api/frame", (route) =>
    route.fulfill({ status: 502, json: { detail: "IRSA no disponible." } }),
  );
  await page.locator("#region-toggle").click();
  await page.getByLabel("Ascensión recta").fill("20");
  await page
    .getByRole("button", { name: "Explorar región", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "No se pudo preparar ninguna imagen",
  );
  await expect(page.getByRole("status")).toContainText(
    "Se conserva la última serie completa",
  );
  await expect(page.locator(".coordinates")).toHaveText("0.00000°, 0.00000°");
  await expect(page.locator(".transport > span")).toHaveText("1 / 2");
  await expect(page.locator(".series-pane canvas")).toBeVisible();
  await expect(page.locator(".loading-state")).toHaveCount(0);
  await expect(page).toHaveURL(/ra=0&dec=0/);
});
