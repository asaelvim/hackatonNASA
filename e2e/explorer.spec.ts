import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

function encodedPixels(values: number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString("base64");
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
  await expect(page.locator("canvas")).toHaveAttribute("width", "2");
  await expect(page.getByRole("status")).toContainText(
    "2 imágenes reales listas",
  );
  await expect(page).toHaveURL(/ra=269.452083/);
  await page.getByRole("button", { name: "Pausar", exact: true }).click();
  await page.locator("#timeline").focus();
  await page.keyboard.press("End");
  await page.getByLabel("Referencia B").selectOption("0");
  await page.getByLabel("Visualización").selectOption("difference");
  const pixel = await page.locator("canvas").evaluate((element) => {
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
});

test("cancelar una consulta devuelve el control sin crear una serie", async ({
  page,
}) => {
  await page.route("**/api/observations?*", () => {});
  await page.goto("/?ra=0&dec=0&fov=12&detector=1");
  await page.getByRole("button", { name: "Cancelar consulta" }).click();
  await expect(page.getByRole("status")).toContainText("Consulta cancelada");
  await expect(
    page.getByRole("button", { name: "Explorar región" }),
  ).toBeEnabled();
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("los controles no desbordan la pantalla en móviles estrechos", async ({
  page,
}) => {
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
  expect(layout.width).toBeGreaterThan(layout.viewport * 0.9);
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
    await expect(
      page.getByRole("button", { name: "Explorar región" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Reproducir", exact: true }),
    ).toBeEnabled();
    await page.locator("#timeline").focus();
    await page.keyboard.press("End");
    await page.getByLabel("Referencia B").selectOption("0");
    await expect(page.locator(".image-label")).toContainText("2027-05-01");
    release();
    await expect(page.getByRole("status")).toContainText(
      "3 imágenes reales listas",
    );
    await expect(page.locator(".image-label")).toContainText("2027-05-01");
    await expect(page.getByLabel("Referencia B")).toHaveValue("1");
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
    route.fulfill({ status: 502, json: { detail: "IRSA no disponible." } }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("IRSA no disponible.");
  await expect(page.getByTestId("saved-preview")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "La actualización falló",
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
