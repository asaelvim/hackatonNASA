import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

function encodedPixels(values: number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString("base64");
}

async function mockArchive(page: Page, count: number) {
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
  await page.route("**/api/frame", (route) => {
    const second = route.request().postDataJSON().source_url.includes("test-1");
    return route.fulfill({
      json: {
        width: 2,
        height: 2,
        pixels: encodedPixels(second ? [2, 3, 4, 5] : [1, 2, 3, 4]),
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

test("carga Canvas, compara, reproduce y comparte la región", async ({
  page,
}) => {
  const exceptions: string[] = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  await mockArchive(page, 2);
  await page.goto("/");
  await expect(page.locator("canvas")).toHaveCount(0);
  await page.getByRole("button", { name: "Explorar región" }).click();
  await expect(page.locator("canvas")).toHaveAttribute("width", "2");
  await expect(page.getByRole("status")).toContainText(
    "2 imágenes reales listas",
  );
  await expect(page).toHaveURL(/ra=269.452083/);
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
  await expect(page.locator("canvas")).toBeVisible();
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
  await page.goto("/");
  await page.getByRole("button", { name: "Explorar región" }).click();
  await expect(page.getByRole("alert")).toContainText("IRSA no disponible.");
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("cancelar una consulta devuelve el control sin crear una serie", async ({
  page,
}) => {
  await page.route("**/api/observations?*", () => {});
  await page.goto("/");
  await page.getByRole("button", { name: "Explorar región" }).click();
  await page.getByRole("button", { name: "Cancelar consulta" }).click();
  await expect(page.getByRole("status")).toContainText("Consulta cancelada");
  await expect(
    page.getByRole("button", { name: "Explorar región" }),
  ).toBeEnabled();
  await expect(page.locator("canvas")).toHaveCount(0);
});
