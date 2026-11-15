import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

function encodedPixels(values: number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString("base64");
}

function exploreButton(page: Page) {
  return page.getByRole("button", { name: /^Explorar/ });
}

function modeButton(page: Page, name: string) {
  return page.getByRole("button", { name: new RegExp(`^${name}`) });
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
        source_fraction: 0,
        zodi_subtracted: true,
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

  await expect(page.locator("canvas")).toHaveAttribute("width", "2");
  await expect(page.getByRole("status")).toContainText(
    "2 imágenes reales listas",
  );
  await expect(page).toHaveURL(/ra=269.452083/);

  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await page.locator("#timeline").focus();
  await page.keyboard.press("End");

  await modeButton(page, "Diferencia").click();
  await page.locator("#reference").selectOption("0");

  const pixel = await page.locator("canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return [...canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data];
  });

  expect(pixel[0]).toBeGreaterThan(0);
  expect(pixel[2]).toBe(0);

  await modeButton(page, "Blink").click();
  await page.getByRole("button", { name: "Reproducir", exact: true }).click();
  await expect(page.locator(".image-label")).toContainText("2025-05-01");
  await page.getByRole("button", { name: "Pausar", exact: true }).click();

  expect(exceptions).toEqual([]);
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
  await modeButton(page, "Diferencia").click();

  await page.unroute("**/api/observations?*");
  await mockArchive(page, 1);
  await exploreButton(page).click();

  await expect(page.getByRole("status")).toContainText(
    "1 imágenes reales listas",
  );
  await expect(modeButton(page, "Normal")).toHaveClass(/active/);
  await expect(modeButton(page, "Diferencia")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Reproducir", exact: true }),
  ).toBeDisabled();
});

test("un error del archivo no se sustituye por imágenes ficticias", async ({
  page,
}) => {
  await page.route("**/api/observations?*", (route) =>
    route.fulfill({
      status: 502,
      json: { detail: "IRSA no disponible." },
    }),
  );

  await page.goto("/?ra=0&dec=0&fov=12&detector=1");

  await expect(page.getByRole("alert")).toContainText("IRSA no disponible.");
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("cancelar una consulta devuelve el control sin crear una serie", async ({
  page,
}) => {
  await page.route("**/api/observations?*", () => {});
  await page.goto("/?ra=0&dec=0&fov=12&detector=1");

  await page.getByRole("button", { name: "Cancelar consulta" }).click();

  await expect(page.getByRole("status")).toContainText("Consulta cancelada");
  await expect(exploreButton(page)).toBeEnabled();
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("los controles no desbordan la pantalla en móviles estrechos", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await mockArchive(page, 0);
  await page.goto("/");

  await expect(exploreButton(page)).toBeVisible();

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflows).toBe(false);
});

test("el contenido aprovecha el ancho de las pantallas grandes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await mockArchive(page, 0);
  await page.goto("/");

  const layout = await page.locator("main").evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    viewport: window.innerWidth,
  }));

  expect(layout.width).toBeGreaterThan(layout.viewport * 0.8);
});

test("muestra imágenes durante la carga y conserva la selección al ordenar épocas", async ({
  page,
}) => {
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

    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.getByRole("status")).toContainText("2 imágenes visibles");
    await expect(page.locator(".explore-button")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Reproducir", exact: true }),
    ).toBeEnabled();

    await page.locator("#timeline").focus();
    await page.keyboard.press("End");

    await modeButton(page, "Overlay").click();
    await page.locator("#reference").selectOption("0");

    await expect(page.locator(".image-label")).toContainText("2027-05-01");

    release();

    await expect(page.getByRole("status")).toContainText(
      "3 imágenes reales listas",
    );
    await expect(page.locator(".image-label")).toContainText("2027-05-01");
    await expect(page.locator("#reference")).toHaveValue("1");
  } finally {
    release();
  }
});

test("cancelar conserva las imágenes que ya se mostraban", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  await mockArchive(page, 2, async (index) => {
    if (index === 1) await pending;
  });

  try {
    await page.goto("/");

    await expect(page.locator("canvas")).toHaveAttribute("width", "2");
    await page.getByRole("button", { name: "Cancelar consulta" }).click();

    await expect(page.getByRole("status")).toContainText(
      "Se conservaron 1 imágenes",
    );
    await expect(page.locator(".image-label")).toContainText("2025-05-01");
    await expect(page.locator(".transport > span")).toHaveText("1 / 1");
  } finally {
    release();
  }
});

test("muestra la vista previa real sin esperar respuesta del archivo", async ({
  page,
}) => {
  await page.route("**/api/observations?*", () => {});
  await page.goto("/");

  await expect(page.getByTestId("saved-preview")).toContainText(
    "Vista previa guardada de Barnard",
  );
  await expect(page.locator("canvas")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancelar consulta" }),
  ).toBeVisible();

  const levels = await page.locator("canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return new Set(
      canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
        .data,
    ).size;
  });

  expect(levels).toBeGreaterThan(10);
});

test("un fallo de IRSA se informa sin hacer pasar la vista guardada por datos nuevos", async ({
  page,
}) => {
  await page.route("**/api/observations?*", (route) =>
    route.fulfill({
      status: 502,
      json: { detail: "IRSA no disponible." },
    }),
  );

  await page.goto("/");

  await expect(page.getByRole("alert")).toContainText("IRSA no disponible.");
  await expect(page.getByTestId("saved-preview")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "No se pudo actualizar. Se conserva la última consulta que funcionó.",
  );
  await expect(page.locator("canvas")).toBeVisible();
});

test("actualizar la vista previa no reinicia la reproducción si el usuario la pausó", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });

  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  await mockArchive(page, 2, () => pending);

  try {
    await page.goto("/");

    await expect(page.getByTestId("saved-preview")).toBeVisible();

    // La consulta en curso pausa la vista previa. Simulamos que el usuario
    // decide reproducirla y luego la pausa explícitamente antes de que IRSA
    // entregue las nuevas imágenes.
    await page.getByRole("button", { name: "Reproducir", exact: true }).click();
    await page.getByRole("button", { name: "Pausar", exact: true }).click();

    release();

    await expect(page.getByRole("status")).toContainText(
      "2 imágenes reales listas",
    );
    await expect(page.getByTestId("saved-preview")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Reproducir", exact: true }),
    ).toBeEnabled();
  } finally {
    release();
  }
});

test("el análisis automático muestra y selecciona candidatos", async ({
  page,
}) => {
  await mockArchive(page, 6);

  await page.route("**/api/candidates", (route) =>
    route.fulfill({
      json: {
        candidates: [
          {
            id: "C01",
            score: 62.5,
            confidence: "medium",
            kind: "motion",
            reason:
              "Movimiento aparente continuo respaldado por varias épocas.",
            epochs: 5,
            baseline_days: 1460,
            coverage_fraction: 5 / 6,
            continuity: 1,
            max_gap_epochs: 1,
            motion_arcsec: 8.2,
            motion_arcsec_per_year: 2.05,
            motion_linearity: 0.91,
            motion_significance_proxy: 3.4,
            flux_variability: 0,
            variability_epochs: 0,
            median_snr_proxy: 14,
            mean_bad_fraction: 0,
            points: Array.from({ length: 5 }, (_, i) => ({
              observation_id: String(i),
              obs_id: `test-${i}`,
              date: `${2025 + i}-05-01T00:00:00.000Z`,
              mjd: 60000 + i * 365,
              frame_index: i,
              x: 0.8 + i * 0.05,
              y: 1.1,
              ra: 269.45,
              dec: 4.69,
              flux_proxy: 10,
              snr_proxy: 14,
              bad_fraction: 0,
              peak_sigma: 8,
              wavelength_um: 1,
              bandwidth_um: 0.02,
            })),
            timeline: Array.from({ length: 5 }, (_, i) => ({
              observation_id: String(i),
              date: `${2025 + i}-05-01T00:00:00.000Z`,
              mjd: 60000 + i * 365,
              frame_index: i,
              x: 0.8 + i * 0.05,
              y: 1.1,
              detected: true,
            })),
          },
        ],
        diagnostics: {
          frames_analyzed: 6,
          frame_failures: 0,
          detections: 30,
          tracks_considered: 8,
          candidate_count: 1,
        },
        warnings: [],
        method: {
          background: "sigma-clipped median + MAD standard deviation",
          threshold_sigma: 4.5,
          minimum_motion_epochs: 5,
          minimum_variability_epochs: 5,
          maximum_gap_epochs: 2,
          assignment: "global one-to-one linear assignment",
          note: "Test fixture",
        },
      },
    }),
  );

  await page.goto("/");
  await expect(page.getByRole("status")).toContainText(
    "6 imágenes reales listas",
  );

  await page.getByRole("button", { name: "Buscar candidatos" }).click();

  await expect(page.locator(".candidate-diagnostics")).toContainText("6");
  await expect(page.locator(".candidate-diagnostics")).toContainText("30");
  await expect(page.locator(".candidate-row")).toContainText("C01");
  await expect(page.locator(".candidate-row")).toContainText("62.5");
  await expect(page.locator(".candidate-details")).toContainText(
    "Cobertura temporal",
  );
  await expect(page.locator(".candidate-details")).toContainText("Continuidad");
});
