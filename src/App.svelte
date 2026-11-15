<script lang="ts">
  import { onMount } from "svelte";
  import { search, loadFrame } from "./lib/api";
  import type { Frame, Observation } from "./lib/api";
  import {
    defaults,
    detectors,
    presets,
    readQuery,
    shareUrl,
    validateQuery,
  } from "./lib/sky";
  import type { Query } from "./lib/sky";
  import { renderPixels, sharedRange } from "./lib/render";
  import type { Mode } from "./lib/render";
  import { getSavedPreview } from "./lib/saved-preview";
  import satelliteLogo from "./img/spherex-loader.webp";

  let query = $state<Query>({ ...defaults });
  let activeQuery = $state<Query | null>(null);
  let observations = $state<Observation[]>([]);
  let frames = $state<Frame[]>([]);
  let warnings = $state<string[]>([]);
  let errors = $state<string[]>([]);
  let frameIssues = $state<string[]>([]);
  let busy = $state(false);
  let progress = $state<number | null>(null);
  let loadingTotal = $state(0);
  let loadingCompleted = $state(0);
  let theme = $state<"light" | "dark">("light");
  const themeAction = $derived(
    theme === "light" ? "Activar modo oscuro" : "Activar modo claro",
  );
  let status = $state("Iniciando consulta de observaciones reales…");
  let index = $state(0);
  let referenceIndex = $state(0);
  let playing = $state(false);
  let autoplayAllowed = $state(false);
  let previewSavedAt = $state<string | null>(null);
  const usingPreview = $derived(previewSavedAt !== null);
  let fps = $state(2);
  let mode = $state<Mode>("image");
  let contrast = $state(5);
  let hideFlags = $state(false);
  let blinkReference = $state(false);
  let canvas = $state<HTMLCanvasElement>();
  let overlayCanvas = $state<HTMLCanvasElement>();
  let imageViewport = $state<HTMLDivElement>();
  let appElement = $state<HTMLDivElement>();
  let skyContainer = $state<HTMLDivElement>();
  let regionOpen = $state(false);
  let settingsOpen = $state(false);
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let controller: AbortController | undefined;
  let generation = 0;
  const modeLabels: Record<Mode, string> = {
    image: "Serie temporal",
    blink: "Alternar A/B",
    overlay: "Superponer A/B",
    difference: "Diferencia A − B",
  };
  const range = $derived(sharedRange(frames, hideFlags));
  const shownIndex = $derived(
    mode === "blink" && blinkReference ? referenceIndex : index,
  );
  const current = $derived(frames[shownIndex]);
  const observation = $derived(observations[shownIndex]);
  const selectedPreset = $derived(
    presets.find(
      (p) =>
        Math.abs(p.ra - query.ra) < 0.000001 &&
        Math.abs(p.dec - query.dec) < 0.000001,
    ),
  );

  onMount(() => {
    query = readQuery(window.location.search);
    autoplayAllowed = !window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    const preview = getSavedPreview(query);
    if (preview) {
      observations = preview.observations;
      frames = preview.frames;
      referenceIndex = frames.length > 1 ? 1 : 0;
      previewSavedAt = preview.savedAt;
      activeQuery = { ...query };
    }
    void explore();
    return () => controller?.abort();
  });

  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });

  $effect(() => {
    if (busy || !playing || frames.length < 2) return;
    const timer = window.setInterval(() => {
      if (mode === "blink") blinkReference = !blinkReference;
      else index = (index + 1) % frames.length;
    }, 1000 / fps);
    return () => window.clearInterval(timer);
  });

  $effect(() => {
    if (!canvas || !current) return;
    paintFrame(canvas, current, frames[referenceIndex], mode);
  });

  $effect(() => {
    if (!overlayCanvas || frames.length < 2) return;
    paintFrame(overlayCanvas, frames[index], frames[referenceIndex], "overlay");
  });

  function paintFrame(
    target: HTMLCanvasElement,
    frame: Frame,
    reference: Frame,
    renderMode: Mode,
  ) {
    target.width = frame.width;
    target.height = frame.height;
    const context = target.getContext("2d");
    if (!context) return;
    const data = renderPixels(
      frame,
      reference,
      renderMode,
      range,
      contrast,
      hideFlags,
    );
    // FITS row zero is south; Canvas row zero is at the top.
    const flipped = new Uint8ClampedArray(data.length);
    const rowLength = frame.width * 4;
    for (let row = 0; row < frame.height; row++)
      flipped.set(
        data.subarray(row * rowLength, (row + 1) * rowLength),
        (frame.height - 1 - row) * rowLength,
      );
    context.putImageData(
      new ImageData(flipped, frame.width, frame.height),
      0,
      0,
    );
  }

  $effect(() => {
    if (!imageViewport) return;
    const observer = new ResizeObserver(clampPan);
    observer.observe(imageViewport);
    return () => observer.disconnect();
  });

  function clampPan() {
    if (!canvas || !imageViewport || zoom <= 1) {
      panX = 0;
      panY = 0;
      return;
    }
    const maxX = Math.max(
      0,
      (canvas.clientWidth * zoom - imageViewport.clientWidth) / 2,
    );
    const maxY = Math.max(
      0,
      (canvas.clientHeight * zoom - imageViewport.clientHeight) / 2,
    );
    panX = Math.min(maxX, Math.max(-maxX, panX));
    panY = Math.min(maxY, Math.max(-maxY, panY));
  }

  function zoomBy(delta: number) {
    zoom = Math.min(4, Math.max(1, zoom + delta));
    clampPan();
  }

  function resetZoom() {
    zoom = 1;
    panX = 0;
    panY = 0;
    dragging = false;
  }

  function startPan(event: PointerEvent) {
    if (busy || !current || zoom <= 1 || event.button !== 0 || !skyContainer)
      return;
    dragging = true;
    dragStartX = event.clientX - panX;
    dragStartY = event.clientY - panY;
    skyContainer.setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent) {
    if (!dragging) return;
    panX = event.clientX - dragStartX;
    panY = event.clientY - dragStartY;
    clampPan();
  }

  function endPan(event: PointerEvent) {
    dragging = false;
    if (skyContainer?.hasPointerCapture(event.pointerId))
      skyContainer.releasePointerCapture(event.pointerId);
  }

  function navigateImage(event: KeyboardEvent) {
    if (busy || !current) return;
    if (event.key === "+" || event.key === "=") zoomBy(0.5);
    else if (event.key === "-") zoomBy(-0.5);
    else if (event.key === "0") resetZoom();
    else if (zoom > 1 && event.key.startsWith("Arrow")) {
      if (event.key === "ArrowLeft") panX += 30;
      else if (event.key === "ArrowRight") panX -= 30;
      else if (event.key === "ArrowUp") panY += 30;
      else if (event.key === "ArrowDown") panY -= 30;
      clampPan();
    } else return;
    event.preventDefault();
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await appElement?.requestFullscreen();
    } catch {
      errors = [...errors, "No se pudo cambiar al modo de pantalla completa."];
    }
  }

  function selectPreset(value: string) {
    const preset = presets[Number(value)];
    query = { ...query, ra: preset.ra, dec: preset.dec, fov: 12 };
  }

  async function explore() {
    const validation = validateQuery(query);
    if (validation) {
      errors = [validation];
      regionOpen = true;
      return;
    }
    regionOpen = false;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const token = ++generation;
    const submitted = { ...query };
    playing = false;
    blinkReference = false;
    errors = [];
    frameIssues = [];
    warnings = [];
    progress = null;
    loadingTotal = 0;
    loadingCompleted = 0;
    busy = true;
    status = "Consultando DR1 y QR3 en NASA/IPAC IRSA…";
    try {
      const result = await search(submitted, signal);
      if (token !== generation) return;
      warnings = result.warnings;
      progress = 10;
      loadingTotal = result.observations.length;
      if (!result.observations.length) {
        status = usingPreview
          ? "IRSA no devolvió observaciones para actualizar la vista previa."
          : `No hay observaciones disponibles para estas coordenadas y detector.${frames.length ? " Se conserva la vista anterior." : ""}`;
        return;
      }
      const loaded: { observation: Observation; frame: Frame }[] = [];
      let next = 0;
      const worker = async () => {
        while (next < result.observations.length && !signal.aborted) {
          const item = result.observations[next++];
          try {
            const frame = await loadFrame(item, submitted, signal);
            if (token !== generation || signal.aborted) return;
            loaded.push({ observation: item, frame });
          } catch (error) {
            if (signal.aborted) return;
            frameIssues = [
              ...frameIssues,
              `${item.date.slice(0, 10)} · ${item.obs_id}: ${error instanceof Error ? error.message : "Error al cargar la imagen."}`,
            ];
          }
          if (token !== generation) return;
          loadingCompleted++;
          progress = 10 + Math.round((loadingCompleted / loadingTotal) * 90);
          status = `Preparando la serie: ${loadingCompleted}/${loadingTotal} observaciones procesadas · ${loaded.length} imágenes listas`;
        }
      };
      await Promise.all([worker(), worker()]);
      if (token !== generation || signal.aborted) return;
      if (!loaded.length) {
        errors = [
          "No se pudo preparar ninguna imagen de esta consulta. Puedes volver a explorar para reintentar.",
        ];
        status = usingPreview
          ? "No se pudo actualizar. Se conserva la vista previa guardada."
          : frames.length
            ? "No se pudo actualizar. Se conserva la última serie completa."
            : "No se pudo preparar ninguna imagen. Consulta los errores.";
        return;
      }
      loaded.sort((a, b) => a.observation.mjd - b.observation.mjd);
      observations = loaded.map((item) => item.observation);
      frames = loaded.map((item) => item.frame);
      activeQuery = submitted;
      previewSavedAt = null;
      index = 0;
      referenceIndex = frames.length > 1 ? 1 : 0;
      mode = "image";
      resetZoom();
      playing = autoplayAllowed && frames.length >= 2;
      window.history.replaceState(
        null,
        "",
        shareUrl(window.location.href, submitted),
      );
      status = frameIssues.length
        ? `${frames.length} de ${loadingTotal} imágenes listas · resultado parcial`
        : `${frames.length} imágenes reales listas · ${result.total} observaciones encontradas`;
      if (frames.length === 1)
        warnings = [
          ...warnings,
          "Solo hay una imagen cargada; no es posible comparar épocas.",
        ];
    } catch (error) {
      if (signal.aborted || token !== generation) return;
      errors = [
        error instanceof Error ? error.message : "No se pudo consultar IRSA.",
      ];
      status = usingPreview
        ? "La actualización falló. Se conserva la vista previa guardada."
        : frames.length
          ? "La actualización falló. Se conserva la última serie completa."
          : "La consulta no se completó.";
    } finally {
      if (token === generation) busy = false;
    }
  }

  function cancel() {
    controller?.abort();
    generation++;
    playing = false;
    autoplayAllowed = false;
    blinkReference = false;
    busy = false;
    status = frames.length
      ? `Consulta cancelada. Se conservaron ${frames.length} imágenes cargadas.`
      : "Consulta cancelada. Puedes iniciar otra búsqueda.";
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        shareUrl(window.location.href, activeQuery ?? query),
      );
      status = "Enlace de la región copiado.";
    } catch {
      errors = [
        ...errors,
        "No se pudo acceder al portapapeles. Copia la URL de la barra del navegador.",
      ];
    }
  }

  function changeMode(value: string) {
    mode = value as Mode;
    blinkReference = false;
  }

  function step(delta: number) {
    playing = false;
    autoplayAllowed = false;
    blinkReference = false;
    index = (index + delta + frames.length) % frames.length;
  }
</script>

<svelte:head>
  <title>SPHEREx Explorer · El cielo, a través del tiempo</title>
</svelte:head>

<svelte:window
  onpointerdown={(event) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest(".region-popover")) regionOpen = false;
    if (!event.target.closest(".settings-popover")) settingsOpen = false;
  }}
  onkeydown={(event) => {
    if (event.key === "Escape") {
      if (regionOpen) {
        regionOpen = false;
        document.getElementById("region-toggle")?.focus();
      }
      if (settingsOpen) {
        settingsOpen = false;
        document.getElementById("settings-toggle")?.focus();
      }
    }
  }}
/>

<div class="app" bind:this={appElement}>
  <header class="toolbar" aria-label="Controles del explorador">
    {#if busy}
      <div
        class="loading-progress"
        role="progressbar"
        aria-label="Cargando observaciones"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress ?? undefined}
        aria-valuetext={progress === null
          ? "Buscando observaciones en IRSA"
          : `Progreso de la consulta: ${progress}%`}
      >
        <span
          class:indeterminate={progress === null}
          style:transform={progress === null
            ? undefined
            : `scaleX(${progress / 100})`}
        ></span>
      </div>
    {/if}
    <a class="brand" href="/" aria-label="Inicio de SPHEREx Explorer"
      >SPHEREx <span>Explorer</span></a
    >
    <div class="instrument-controls">
      <form
        class="query-controls control-group"
        novalidate
        onsubmit={(event) => {
          event.preventDefault();
          void explore();
        }}
      >
        <details class="popover region-popover" open={regionOpen}>
          <summary
            id="region-toggle"
            onclick={(event) => {
              event.preventDefault();
              regionOpen = !regionOpen;
              settingsOpen = false;
            }}
            title="Elegir objeto, coordenadas y campo de visión"
          >
            <span class="region-name"
              >{selectedPreset?.name ?? "Coordenadas"}</span
            >
            <span class="chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="popover-content">
            <h1>Región del cielo</h1>
            <label for="preset">Objeto de referencia</label>
            <select
              id="preset"
              value={selectedPreset
                ? String(presets.indexOf(selectedPreset))
                : ""}
              onchange={(event) => selectPreset(event.currentTarget.value)}
            >
              <option value="" disabled>Coordenadas personalizadas</option>
              {#each presets as preset, i}
                <option value={String(i)}>{preset.name}</option>
              {/each}
            </select>
            <p class="hint">
              {selectedPreset?.detail ??
                "Coordenadas ICRS en grados decimales."}
            </p>
            <div class="coordinate-fields">
              <div>
                <label for="ra">Ascensión recta (°)</label>
                <input
                  id="ra"
                  type="number"
                  min="0"
                  max="359.999999"
                  step="any"
                  required
                  bind:value={query.ra}
                />
              </div>
              <div>
                <label for="dec">Declinación (°)</label>
                <input
                  id="dec"
                  type="number"
                  min="-90"
                  max="90"
                  step="any"
                  required
                  bind:value={query.dec}
                />
              </div>
            </div>
            <label for="fov">Campo de visión <span>{query.fov}′</span></label>
            <input
              id="fov"
              type="range"
              min="1"
              max="30"
              step="1"
              bind:value={query.fov}
            />
            <div class="range-labels">
              <span>1′ · detalle</span><span>30′ · contexto</span>
            </div>
            <p class="hint">
              Las coordenadas no se propagan a cada época. Usa un campo amplio
              para objetos de alto movimiento propio, como Barnard.
            </p>
            <button type="submit" class="primary" disabled={busy}
              >Explorar esta región</button
            >
          </div>
        </details>
        <label class="sr-only" for="detector">Detector infrarrojo</label>
        <select
          id="detector"
          bind:value={query.detector}
          title="Detector infrarrojo"
        >
          {#each detectors as band, i}
            <option value={i + 1}>D{i + 1} · {band}</option>
          {/each}
        </select>
        <button
          type="submit"
          class="primary"
          aria-label="Explorar región"
          disabled={busy}>Explorar</button
        >
        {#if busy}
          <button
            type="button"
            class="cancel"
            aria-label="Cancelar consulta"
            onclick={cancel}>Cancelar</button
          >
        {/if}
      </form>

      <div class="control-group playback">
        <div class="transport">
          <button
            aria-label="Imagen anterior"
            title="Imagen anterior"
            disabled={busy || frames.length < 2}
            onclick={() => step(-1)}>‹</button
          >
          <button
            class="play"
            aria-label={playing ? "Pausar" : "Reproducir"}
            title={playing ? "Pausar" : "Reproducir"}
            disabled={busy || frames.length < 2}
            onclick={() => {
              playing = !playing;
              autoplayAllowed = playing;
            }}>{playing ? "Ⅱ" : "▶"}</button
          >
          <button
            aria-label="Imagen siguiente"
            title="Imagen siguiente"
            disabled={busy || frames.length < 2}
            onclick={() => step(1)}>›</button
          >
          <span
            >{busy
              ? "— / —"
              : `${frames.length ? index + 1 : 0} / ${frames.length}`}</span
          >
        </div>
        <label class="sr-only" for="fps">Velocidad</label>
        <select id="fps" bind:value={fps} title="Velocidad de reproducción">
          <option value={1}>1 fps</option><option value={2}>2 fps</option>
          <option value={4}>4 fps</option><option value={8}>8 fps</option>
        </select>
      </div>

      <div class="control-group display-controls">
        <label class="sr-only" for="mode">Visualización</label>
        <select
          id="mode"
          value={mode}
          onchange={(event) => changeMode(event.currentTarget.value)}
          disabled={busy || !frames.length}
          title="Modo de visualización"
        >
          <option value="image">Serie temporal</option>
          <option value="blink" disabled={frames.length < 2}
            >Alternar A/B</option
          >
          <option value="overlay" disabled={frames.length < 2}
            >Superponer A/B</option
          >
          <option value="difference" disabled={frames.length < 2}
            >Diferencia A − B</option
          >
        </select>
        <label class="contrast-control" for="contrast">
          Contraste
          <input
            id="contrast"
            type="range"
            min="1"
            max="20"
            bind:value={contrast}
            aria-valuetext={String(contrast)}
          />
        </label>
      </div>

      <div class="control-group view-tools">
        <button
          aria-label="Alejar"
          title="Alejar (−)"
          onclick={() => zoomBy(-0.5)}
          disabled={busy || !current || zoom <= 1}>−</button
        >
        <button
          class="zoom-reset"
          aria-label="Restablecer vista"
          title="Restablecer vista (0)"
          onclick={resetZoom}
          disabled={busy || !current}>{Math.round(zoom * 100)}%</button
        >
        <button
          aria-label="Acercar"
          title="Acercar (+)"
          onclick={() => zoomBy(0.5)}
          disabled={busy || !current || zoom >= 4}>+</button
        >
        <button
          aria-label="Alternar pantalla completa"
          title="Pantalla completa"
          onclick={() => void toggleFullscreen()}>⛶</button
        >
      </div>
    </div>

    <div class="control-group utility-controls">
      <details class="popover settings-popover" open={settingsOpen}>
        <summary
          id="settings-toggle"
          aria-label="Ajustes"
          onclick={(event) => {
            event.preventDefault();
            settingsOpen = !settingsOpen;
            regionOpen = false;
          }}
        >
          <svg
            class="settings-icon"
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          >
            <path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10"></path>
            <circle cx="12" cy="6" r="2"></circle>
            <circle cx="16" cy="12" r="2"></circle>
            <circle cx="8" cy="18" r="2"></circle>
          </svg>
          <span class="settings-label">Ajustes</span>
          <span class="chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="popover-content">
          <h2>Comparación y datos</h2>
          <label for="reference">Referencia B</label>
          <select
            id="reference"
            bind:value={referenceIndex}
            disabled={busy || frames.length < 2}
          >
            {#each observations as item, i}
              <option value={i}
                >{i + 1} · {item.date.slice(0, 10)}
                {item.date.slice(11, 19)}</option
              >
            {/each}
          </select>
          <p class="hint">
            Superposición: A en rojo, B en cian. En modo A/B, pulsa reproducir
            para alternar.
          </p>
          <label class="checkbox">
            <input type="checkbox" bind:checked={hideFlags} />
            Ocultar píxeles con cualquier bandera de calidad
          </label>
          <p class="hint">
            Algunas banderas son informativas. Ocultarlas todas puede dejar el
            visor vacío.
          </p>
          {#if current}
            <dl class="metadata">
              <div>
                <dt>Brillo</dt>
                <dd>{current.unit}</dd>
              </div>
              <div>
                <dt>Ancho de banda</dt>
                <dd>
                  {current.bandwidth_um?.toFixed(3) ?? "No disponible"} μm
                </dd>
              </div>
              <div>
                <dt>Cobertura</dt>
                <dd>{(current.coverage * 100).toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Con banderas</dt>
                <dd>{(current.flagged_fraction * 100).toFixed(1)}%</dd>
              </div>
            </dl>
          {/if}
          <p class="hint science-note">
            Escala de brillo común a la serie. Fondo zodiacal sin sustraer. Las
            diferencias también pueden deberse a longitud de onda, PSF, ruido o
            contaminación: no confirman movimiento ni variabilidad. Cada
            detector cubre varias longitudes de onda, no una banda fija.
          </p>
          <p class="hint">
            Arrastra la imagen ampliada para desplazarte, o enfoca el visor y
            usa las flechas. + / − amplían y 0 restablece la vista.
          </p>
          <a
            href="https://irsa.ipac.caltech.edu/Missions/spherex.html"
            target="_blank"
            rel="noreferrer">Archivo NASA/IPAC ↗</a
          >
          <p class="credits">
            NASA Space Apps Challenge · Equipo Otarios<br />Instituto
            Tecnológico de La Paz<br />Datos: NASA / JPL-Caltech / IPAC ·
            Proyecto independiente
          </p>
        </div>
      </details>
      <button
        class="share"
        onclick={copyLink}
        disabled={busy || !activeQuery}
        title="Copiar enlace de la región"
      >
        Compartir ↗
      </button>
      <button
        class="theme-toggle"
        aria-label={themeAction}
        title={themeAction}
        onclick={() => (theme = theme === "light" ? "dark" : "light")}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          {#if theme === "light"}
            <path d="M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5a8.5 8.5 0 1 0 9.7 9.7Z"
            ></path>
          {:else}
            <circle cx="12" cy="12" r="4"></circle>
            <path
              d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
            ></path>
          {/if}
        </svg>
      </button>
    </div>
  </header>

  <main
    class="workspace"
    aria-label="Visor temporal de SPHEREx"
    aria-busy={busy}
  >
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The spatial viewer supports keyboard zoom and pan.) -->
    <div
      class="sky-view"
      class:has-image={!busy && !!current}
      class:zoomed={!busy && zoom > 1}
      class:dragging
      bind:this={skyContainer}
      role="application"
      aria-label="Visor astronómico. Usa + y − para ampliar, flechas para desplazar y 0 para restablecer."
      tabindex={!busy && current ? 0 : -1}
      onkeydown={navigateImage}
      onpointerdown={startPan}
      onpointermove={movePan}
      onpointerup={endPan}
      onpointercancel={endPan}
      onlostpointercapture={() => (dragging = false)}
    >
      {#if busy}
        <section class="loading-state" aria-labelledby="loading-title">
          <div class="loading-visual" aria-hidden="true">
            <span class="loading-orbit"></span>
            <svg viewBox="0 0 120 120">
              <circle class="loading-track" cx="60" cy="60" r="46"></circle>
              <circle
                class="loading-arc"
                class:searching={progress === null}
                cx="60"
                cy="60"
                r="46"
                pathLength="100"
                stroke-dasharray="100"
                stroke-dashoffset={progress === null ? 75 : 100 - progress}
              ></circle>
            </svg>
            <span
              class="loading-satellite"
              style:mask-image={`url("${satelliteLogo}")`}
            ></span>
            <span class="loading-value"
              >{progress === null ? "IRSA" : `${progress}%`}</span
            >
          </div>
          <span class="loading-kicker">SPHEREx · NASA/IPAC IRSA</span>
          <h2 id="loading-title">
            {progress === null
              ? "Buscando tu región"
              : "Construyendo la serie temporal"}
          </h2>
          <p>
            {progress === null
              ? "Consultando las observaciones disponibles en el archivo."
              : "Descargando y alineando los recortes sobre la misma cuadrícula celeste."}
          </p>
          <div class="loading-detail">
            {progress === null
              ? "Cada imagen tiene una historia. Estamos reuniéndolas."
              : `${loadingCompleted} de ${loadingTotal} observaciones procesadas`}
          </div>
          <ol class="loading-steps" aria-label="Etapas de carga">
            <li
              class:active={progress === null}
              class:done={progress !== null}
              aria-current={progress === null ? "step" : undefined}
            >
              <span>01</span>Archivo
            </li>
            <li
              class:active={progress !== null}
              aria-current={progress !== null ? "step" : undefined}
            >
              <span>02</span>Preparación
            </li>
            <li><span>03</span>Visor</li>
          </ol>
        </section>
      {:else if current}
        <div class="viewer-panes">
          <section
            class="viewer-pane series-pane"
            aria-label={modeLabels[mode]}
          >
            <h2 class="pane-title">{modeLabels[mode]}</h2>
            <div class="image-viewport" bind:this={imageViewport}>
              <canvas
                bind:this={canvas}
                style:transform="translate({panX}px, {panY}px) scale({zoom})"
                aria-label="Recorte astronómico alineado: norte arriba, este a la izquierda"
              ></canvas>
              <span class="north">N ↑</span><span class="east">E ←</span>
              <div class="image-label">
                <span>{observation.date.slice(0, 10)}</span>
                <span class="muted">{observation.date.slice(11, 19)} UTC</span>
              </div>
              <div class="image-scale">
                {activeQuery?.fov}′ × {activeQuery?.fov}′ · {current.pixel_scale_arcsec.toFixed(
                  2,
                )}″/px
              </div>
              {#if mode !== "image" && frames.length > 1}
                <div class="comparison-note">
                  A: {observations[index]?.date.slice(0, 10)} · {frames[
                    index
                  ]?.wavelength_um?.toFixed(3) ?? "?"} μm<br />
                  B: {observations[referenceIndex]?.date.slice(0, 10)} · {frames[
                    referenceIndex
                  ]?.wavelength_um?.toFixed(3) ?? "?"} μm
                  {#if index === referenceIndex}<br />A y B son la misma
                    observación.{/if}
                </div>
              {/if}
            </div>
          </section>
          <section
            class="viewer-pane overlay-pane"
            aria-label="Superposición A/B"
          >
            <h2 class="pane-title">Superponer A/B</h2>
            <div class="image-viewport">
              {#if frames.length > 1}
                <canvas
                  bind:this={overlayCanvas}
                  style:transform="translate({panX}px, {panY}px) scale({zoom})"
                  aria-label="Superposición astronómica: A en rojo, B en cian"
                ></canvas>
                <span class="north">N ↑</span><span class="east">E ←</span>
                <div class="overlay-date">
                  <span>A · {observations[index]?.date.slice(0, 10)}</span>
                  <span
                    >B · {observations[referenceIndex]?.date.slice(0, 10)}</span
                  >
                </div>
                <div class="image-scale">
                  {activeQuery?.fov}′ × {activeQuery?.fov}′
                </div>
                <div class="comparison-note">
                  A en rojo · B en cian<br />
                  A: {frames[index]?.wavelength_um?.toFixed(3) ?? "?"} μm · B: {frames[
                    referenceIndex
                  ]?.wavelength_um?.toFixed(3) ?? "?"} μm
                  {#if index === referenceIndex}<br />A y B son la misma
                    observación.{/if}
                </div>
              {:else}
                <div class="empty-state">
                  <p>
                    Se necesitan al menos dos observaciones para superponer A/B.
                  </p>
                </div>
              {/if}
            </div>
          </section>
        </div>
      {:else}
        <div class="empty-state">
          <span class="empty-symbol" aria-hidden="true">+</span>
          <h2>Una región, muchas épocas</h2>
          <p>
            Elige un objeto o introduce coordenadas en el menú de región y pulsa
            Explorar.
          </p>
        </div>
      {/if}
    </div>

    {#if !busy && (usingPreview || warnings.length || frameIssues.length || errors.length)}
      <div class="messages">
        {#if usingPreview}
          <p class="preview-note" data-testid="saved-preview">
            Vista previa guardada de Barnard · preparada el {previewSavedAt?.slice(
              0,
              10,
            )}. Observaciones reales con sus fechas originales; no es una
            consulta actualizada ni imágenes simuladas.
          </p>
        {/if}
        {#each warnings as warning}<p class="notice">{warning}</p>{/each}
        {#if frameIssues.length}
          <details class="frame-issues">
            <summary
              >{frameIssues.length} observación(es) no pudieron prepararse · Ver detalles</summary
            >
            <p>
              IRSA no permitió preparar estos recortes. Puedes volver a explorar
              para reintentar; las imágenes disponibles no se sustituyeron por
              datos simulados.
            </p>
            {#each frameIssues as issue}<p>{issue}</p>{/each}
          </details>
        {/if}
        {#if errors.length}
          <div class="error-box" role="alert">
            <strong>No se completaron algunas operaciones</strong>
            {#each errors as error}<p>{error}</p>{/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="timeline-strip">
      <span class="timeline-caption">Épocas</span>
      <div class="timeline-track">
        <label class="sr-only" for="timeline">Observación actual</label>
        <input
          id="timeline"
          class="timeline"
          type="range"
          min="0"
          max={Math.max(0, frames.length - 1)}
          bind:value={index}
          disabled={busy || !frames.length}
          oninput={() => {
            playing = false;
            autoplayAllowed = false;
            blinkReference = false;
          }}
        />
        <div class="timeline-dates">
          <span
            >{busy
              ? "Preparando la serie…"
              : (observations[0]?.date.slice(0, 10) ??
                "Primera observación")}</span
          >
          <span
            >{busy
              ? ""
              : (observations.at(-1)?.date.slice(0, 10) ??
                "Última observación")}</span
          >
        </div>
      </div>
      <span class="timeline-count"
        >{busy ? "En preparación" : `${frames.length} imágenes`}</span
      >
    </div>
  </main>

  <footer>
    <div class="status" role="status">
      <span class="live-dot" class:loading={busy}></span>{status}
    </div>
    <div class="observation-meta">
      {#if !busy && activeQuery}<span class="coordinates"
          >{activeQuery.ra.toFixed(5)}°, {activeQuery.dec.toFixed(5)}°</span
        >{/if}
      {#if !busy && current}
        <span>λ {current.wavelength_um?.toFixed(3) ?? "?"} μm</span>
        <a href={observation.source_url} target="_blank" rel="noreferrer"
          >FITS ↗</a
        >
      {/if}
      <span class="data-source">SPHEREx DR1 + QR3 · Otarios</span>
    </div>
  </footer>
</div>
