<script lang="ts">
  import { onMount } from "svelte";
  import { analyzeCandidates, search, loadFrame } from "./lib/api";
  import type {
    Candidate,
    CandidateResult,
    Frame,
    Observation,
  } from "./lib/api";
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
  import { getSavedPreview, matchesSavedPreview } from "./lib/saved-preview";

  const DISPLAY_FRAME_LIMIT = 12;

  let query = $state<Query>({ ...defaults });
  let activeQuery = $state<Query | null>(null);
  let observations = $state<Observation[]>([]);
  let totalObservations = $state(0);
  let frames = $state<Frame[]>([]);
  let warnings = $state<string[]>([]);
  let errors = $state<string[]>([]);
  let frameIssues = $state<string[]>([]);
  let candidateResult = $state<CandidateResult | null>(null);
  let candidateBusy = $state(false);
  let candidateError = $state<string | null>(null);
  let selectedCandidateId = $state<string | null>(null);
  let busy = $state(false);
  let progress = $state(0);
  let progressPhase = $state<
    "idle" | "searching" | "loading" | "ready" | "partial" | "error"
  >("idle");
  let progressLabel = $state("Listo para explorar.");
  let retryAvailable = $state(false);
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
  let skyContainer = $state<HTMLDivElement>();
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let controller: AbortController | undefined;
  let candidateController: AbortController | undefined;
  let generation = 0;
  const range = $derived(sharedRange(frames, hideFlags));
  const shownIndex = $derived(
    mode === "blink" && blinkReference ? referenceIndex : index,
  );
  const current = $derived(frames[shownIndex]);
  const observation = $derived(observations[shownIndex]);
  const referenceFrame = $derived(frames[referenceIndex]);
  const wavelengthDelta = $derived(
    current?.wavelength_um != null && referenceFrame?.wavelength_um != null
      ? Math.abs(current.wavelength_um - referenceFrame.wavelength_um)
      : null,
  );
  const comparisonCompatible = $derived(
    !!current &&
      !!referenceFrame &&
      spectrallyCompatible(current, referenceFrame),
  );
  const differenceScienceReady = $derived(
    comparisonCompatible &&
      current?.zodi_subtracted === true &&
      referenceFrame?.zodi_subtracted === true,
  );
  const hasCompatibleReference = $derived(
    !!current &&
      frames.some(
        (frame, i) => i !== index && spectrallyCompatible(current, frame),
      ),
  );
  const selectedPreset = $derived(
    presets.find(
      (p) =>
        Math.abs(p.ra - query.ra) < 0.000001 &&
        Math.abs(p.dec - query.dec) < 0.000001,
    ),
  );
  const queryDirty = $derived(
    !!activeQuery &&
      (Math.abs(activeQuery.ra - query.ra) > 0.000001 ||
        Math.abs(activeQuery.dec - query.dec) > 0.000001 ||
        activeQuery.fov !== query.fov ||
        activeQuery.detector !== query.detector),
  );
  const selectedCandidate = $derived(
    candidateResult?.candidates.find(
      (candidate) => candidate.id === selectedCandidateId,
    ) ?? null,
  );
  const currentCandidateMarker = $derived(
    selectedCandidate?.timeline.find(
      (point) => point.observation_id === observation?.id,
    ) ?? null,
  );

  onMount(() => {
    query = readQuery(window.location.search);
    autoplayAllowed = !window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    const preview = getSavedPreview(query);
    if (preview) {
      observations = preview.observations;
      totalObservations = preview.observations.length;
      frames = preview.frames;
      previewSavedAt = preview.savedAt;
      activeQuery = { ...query };
      playing = autoplayAllowed;
    }
    void explore();
    return () => {
      controller?.abort();
      candidateController?.abort();
    };
  });

  $effect(() => {
    if (!playing || frames.length < 2) return;
    const timer = window.setInterval(() => {
      if (mode === "blink") blinkReference = !blinkReference;
      else index = (index + 1) % frames.length;
    }, 1000 / fps);
    return () => window.clearInterval(timer);
  });

  $effect(() => {
    if (!canvas || !current) return;
    canvas.width = current.width;
    canvas.height = current.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const data = renderPixels(
      current,
      frames[referenceIndex],
      mode,
      range,
      contrast,
      hideFlags,
    );
    // FITS row zero is south; Canvas row zero is at the top.
    const flipped = new Uint8ClampedArray(data.length);
    const rowLength = current.width * 4;
    for (let row = 0; row < current.height; row++)
      flipped.set(
        data.subarray(row * rowLength, (row + 1) * rowLength),
        (current.height - 1 - row) * rowLength,
      );
    context.putImageData(
      new ImageData(flipped, current.width, current.height),
      0,
      0,
    );

    if (currentCandidateMarker) {
      const markerX = currentCandidateMarker.x;
      const markerY = current.height - 1 - currentCandidateMarker.y;
      context.save();
      context.strokeStyle = "#67e8f9";
      context.lineWidth = 1.4;
      context.globalAlpha = currentCandidateMarker.detected ? 1 : 0.58;
      context.setLineDash(currentCandidateMarker.detected ? [] : [2.5, 2.5]);
      context.beginPath();
      context.arc(markerX, markerY, 5, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(markerX - 8, markerY);
      context.lineTo(markerX - 3, markerY);
      context.moveTo(markerX + 3, markerY);
      context.lineTo(markerX + 8, markerY);
      context.moveTo(markerX, markerY - 8);
      context.lineTo(markerX, markerY - 3);
      context.moveTo(markerX, markerY + 3);
      context.lineTo(markerX, markerY + 8);
      context.stroke();
      context.restore();
    }
  });

  function spectrallyCompatible(a: Frame, b: Frame) {
    if (a.wavelength_um == null || b.wavelength_um == null) return false;
    const widths = [a.bandwidth_um, b.bandwidth_um].filter(
      (value) => typeof value === "number" && value > 0,
    ) as number[];
    const tolerance = widths.length
      ? Math.max(0.005, Math.min(...widths) * 0.5)
      : 0.02;
    return Math.abs(a.wavelength_um - b.wavelength_um) <= tolerance;
  }

  function bestReferenceIndex() {
    if (!current || frames.length < 2) return null;

    const candidates = frames
      .map((frame, i) => ({
        frame,
        i,
        compatible: i !== index && spectrallyCompatible(current, frame),
        wavelengthDelta:
          i !== index &&
          current.wavelength_um != null &&
          frame.wavelength_um != null
            ? Math.abs(current.wavelength_um - frame.wavelength_um)
            : Number.POSITIVE_INFINITY,
        timeDelta:
          i !== index
            ? Math.abs(observations[i].mjd - observations[index].mjd)
            : -1,
      }))
      .filter(({ i }) => i !== index);

    const compatible = candidates
      .filter(({ compatible }) => compatible)
      .sort((a, b) => b.timeDelta - a.timeDelta);

    if (compatible.length) return compatible[0].i;

    candidates.sort(
      (a, b) =>
        a.wavelengthDelta - b.wavelengthDelta || b.timeDelta - a.timeDelta,
    );
    return candidates[0]?.i ?? null;
  }

  function sampleLoaded(
    items: { observation: Observation; frame: Frame }[],
    limit: number,
  ) {
    const sorted = [...items].sort(
      (a, b) => a.observation.mjd - b.observation.mjd,
    );
    if (sorted.length <= limit) return sorted;
    const indices = Array.from({ length: limit }, (_, i) =>
      Math.round((i * (sorted.length - 1)) / (limit - 1)),
    );
    return indices.map((i) => sorted[i]);
  }

  function clampPan() {
    if (!canvas || !skyContainer || zoom <= 1) {
      panX = 0;
      panY = 0;
      return;
    }

    const maxX = Math.max(
      0,
      (canvas.clientWidth * zoom - skyContainer.clientWidth) / 2,
    );
    const maxY = Math.max(
      0,
      (canvas.clientHeight * zoom - skyContainer.clientHeight) / 2,
    );

    panX = Math.min(maxX, Math.max(-maxX, panX));
    panY = Math.min(maxY, Math.max(-maxY, panY));
  }

  function zoomBy(delta: number) {
    const next = Math.min(4, Math.max(1, Number((zoom + delta).toFixed(2))));
    if (next === zoom) return;
    zoom = next;
    requestAnimationFrame(clampPan);
  }

  function resetZoom() {
    zoom = 1;
    panX = 0;
    panY = 0;
  }

  function startPan(event: PointerEvent) {
    if (zoom <= 1 || !skyContainer) return;

    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        ".viewer-tools, .image-label, .image-scale, button, select, input, a",
      )
    )
      return;

    dragging = true;
    dragStartX = event.clientX - panX;
    dragStartY = event.clientY - panY;
    skyContainer.setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent) {
    if (!dragging || zoom <= 1) return;
    panX = event.clientX - dragStartX;
    panY = event.clientY - dragStartY;
    clampPan();
  }

  function endPan(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    if (skyContainer?.hasPointerCapture(event.pointerId))
      skyContainer.releasePointerCapture(event.pointerId);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await skyContainer?.requestFullscreen();
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
      return;
    }

    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const token = ++generation;
    const submitted = { ...query };
    const retainPreview = usingPreview && matchesSavedPreview(submitted);

    // Keep the last successful view on screen until the new query has at
    // least one usable frame. This avoids a blank app when IRSA is degraded.
    playing = false;
    autoplayAllowed = !window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    blinkReference = false;
    mode = "image";
    errors = [];
    warnings = [];
    frameIssues = [];
    busy = true;
    retryAvailable = false;
    progress = 10;
    progressPhase = "searching";
    progressLabel = "Buscando observaciones en SPHEREx DR1 y QR3…";
    status = retainPreview
      ? "Vista previa guardada · buscando una actualización en IRSA…"
      : "Consultando DR1 y QR3 en NASA/IPAC IRSA…";

    try {
      const result = await search(submitted, signal);
      if (token !== generation) return;

      warnings = result.warnings;
      progress = 25;
      progressPhase = "loading";
      progressLabel = result.observations.length
        ? `${result.total} observaciones encontradas · preparando ${result.observations.length} imágenes`
        : "Consulta completada · no se encontraron observaciones para este detector";

      if (!result.observations.length) {
        status =
          "No hay observaciones disponibles para estas coordenadas y detector. La vista anterior se conserva.";
        progress = 100;
        progressPhase = "ready";
        return;
      }

      const loaded: { observation: Observation; frame: Frame }[] = [];
      let next = 0;
      let completed = 0;
      let frameFailures = 0;
      let autoplayStarted = false;
      let activated = false;

      const publish = () => {
        if (!loaded.length) return;

        const currentId = activated ? observations[index]?.id : undefined;
        const referenceId = activated
          ? observations[referenceIndex]?.id
          : undefined;

        if (!activated) {
          activated = true;
          activeQuery = submitted;
          totalObservations = result.total;
          previewSavedAt = null;
          candidateController?.abort();
          candidateResult = null;
          candidateError = null;
          selectedCandidateId = null;
          index = 0;
          referenceIndex = 0;
          zoom = 1;
          panX = 0;
          panY = 0;
          window.history.replaceState(
            null,
            "",
            shareUrl(window.location.href, submitted),
          );
        }

        const visible = sampleLoaded(loaded, DISPLAY_FRAME_LIMIT);
        observations = visible.map((item) => item.observation);
        frames = visible.map((item) => item.frame);

        if (currentId)
          index = Math.max(
            0,
            observations.findIndex((item) => item.id === currentId),
          );
        if (referenceId)
          referenceIndex = Math.max(
            0,
            observations.findIndex((item) => item.id === referenceId),
          );

        if (frames.length >= 2 && !autoplayStarted) {
          autoplayStarted = true;
          playing = autoplayAllowed;
        }
      };

      const worker = async () => {
        while (next < result.observations.length && !signal.aborted) {
          const item = result.observations[next++];
          try {
            const frame = await loadFrame(item, submitted, signal);
            if (token !== generation || signal.aborted) return;
            loaded.push({ observation: item, frame });
            publish();
          } catch (error) {
            if (signal.aborted) return;
            frameFailures++;
            if (frameIssues.length < 6)
              frameIssues = [
                ...frameIssues,
                `${item.date.slice(0, 10)} · ${item.obs_id}: ${error instanceof Error ? error.message : "Error al cargar la imagen."}`,
              ];
          }

          if (token !== generation) return;
          completed++;
          progress = Math.min(
            95,
            25 +
              Math.round(
                (completed / Math.max(1, result.observations.length)) * 70,
              ),
          );
          progressPhase = "loading";
          progressLabel = `Preparando imágenes ${completed}/${result.observations.length} · ${loaded.length} listas`;
          status = `Cargando recortes: ${completed}/${result.observations.length} · ${loaded.length} imágenes visibles`;
        }
      };

      await Promise.all([worker(), worker()]);
      if (token !== generation || signal.aborted) return;

      if (loaded.length) {
        progress = 100;
        const displayCount = frames.length;
        const completeView = displayCount >= DISPLAY_FRAME_LIMIT;

        if (completeView) {
          progressPhase = "ready";
          progressLabel = `${displayCount} imágenes listas · consulta completada`;
          status = `${displayCount} imágenes reales listas · ${result.total} observaciones encontradas`;

          // The backup pool succeeded. Internal failures are implementation
          // details when the requested 12-image series is complete.
          frameIssues = [];
          warnings = warnings.filter(
            (warning) =>
              !warning.startsWith("Se seleccionaron ") &&
              !warning.startsWith("Se muestran "),
          );
        } else {
          progressPhase = frameFailures ? "partial" : "ready";
          progressLabel = `${displayCount} de ${DISPLAY_FRAME_LIMIT} imágenes visibles · resultado parcial`;
          status = `${displayCount} imágenes reales listas · resultado parcial`;

          warnings = warnings.filter(
            (warning) =>
              !warning.startsWith("Se seleccionaron ") &&
              !warning.startsWith("Se muestran "),
          );

          if (frameFailures)
            warnings = [
              ...warnings,
              `${frameFailures} observación${frameFailures === 1 ? "" : "es"} del pool de respaldo no pudo${frameFailures === 1 ? "" : "ieron"} prepararse.`,
            ];
        }

        if (displayCount === 1)
          warnings = [
            ...warnings,
            "Solo hay una imagen cargada; no es posible comparar épocas.",
          ];
      } else {
        progress = 0;
        progressPhase = "error";
        progressLabel =
          "Las observaciones se encontraron, pero ninguna imagen pudo prepararse.";
        retryAvailable = true;
        status = frames.length
          ? "La nueva consulta no pudo prepararse. Se conserva la vista anterior."
          : "No se pudo preparar ninguna imagen.";
      }
    } catch (error) {
      if (signal.aborted || token !== generation) return;

      const message =
        error instanceof Error ? error.message : "No se pudo consultar IRSA.";
      errors = [message];
      progress = 0;
      progressPhase = "error";
      retryAvailable = true;
      progressLabel =
        "IRSA no respondió correctamente. Puedes reintentar sin perder tu última vista.";
      status = frames.length
        ? "No se pudo actualizar. Se conserva la última consulta que funcionó."
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
    retryAvailable = false;
    progress = 0;
    progressPhase = "idle";
    progressLabel = "Consulta cancelada.";
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

  async function runCandidateAnalysis() {
    if (!activeQuery || observations.length < 3 || candidateBusy) return;

    candidateController?.abort();
    candidateController = new AbortController();
    candidateBusy = true;
    candidateError = null;
    selectedCandidateId = null;

    try {
      candidateResult = await analyzeCandidates(
        activeQuery,
        observations,
        candidateController.signal,
      );
      if (candidateResult.candidates.length)
        selectedCandidateId = candidateResult.candidates[0].id;
    } catch (error) {
      if (candidateController.signal.aborted) return;
      candidateError =
        error instanceof Error
          ? error.message
          : "No se pudo completar el análisis de candidatos.";
    } finally {
      if (!candidateController.signal.aborted) candidateBusy = false;
    }
  }

  function selectCandidate(candidate: Candidate) {
    selectedCandidateId = candidate.id;
    playing = false;
    autoplayAllowed = false;
    blinkReference = false;
    mode = "image";

    const firstVisible = candidate.points
      .map((point) =>
        observations.findIndex(
          (observation) => observation.id === point.observation_id,
        ),
      )
      .find((candidateIndex) => candidateIndex >= 0);

    if (firstVisible != null) index = firstVisible;
  }

  function changeMode(value: string) {
    mode = value as Mode;
    blinkReference = false;
    if (mode !== "image") {
      const best = bestReferenceIndex();
      if (best != null) referenceIndex = best;
    }
    if (mode === "difference") hideFlags = true;
  }

  function step(delta: number) {
    playing = false;
    autoplayAllowed = false;
    blinkReference = false;
    index = (index + delta + frames.length) % frames.length;
  }
  $effect(() => {
    if (mode !== "difference" || frames.length < 2 || !current) return;
    if (referenceIndex === index) {
      const best = bestReferenceIndex();
      if (best != null && best !== referenceIndex) referenceIndex = best;
    }
  });
</script>

<svelte:head>
  <title>SPHEREx Explorer · El cielo, a través del tiempo</title>
</svelte:head>

<div class="app">
  <header>
    <a class="brand" href="/" aria-label="Inicio de SPHEREx Explorer"
      ><span>SPHEREx <strong>Explorer</strong></span></a
    >
    <span class="badge">Astronomía ciudadana</span>
    <a
      class="archive-link"
      href="https://irsa.ipac.caltech.edu/Missions/spherex.html"
      target="_blank"
      rel="noreferrer">Archivo NASA/IPAC ↗</a
    >
  </header>

  <section class="intro">
    <h1>Encuentra lo que <span>cambia.</span></h1>
    <p>
      Explora el universo infrarrojo y compara observaciones reales de SPHEREx.
      Un punto que se mueve puede contar una nueva historia.
    </p>
  </section>

  <main>
    <aside class="panel search-panel product-search">
      <div class="search-copy">
        <span class="eyebrow">Explorar el cielo</span>
        <h2>¿Qué quieres observar?</h2>
        <p>
          Elige un objeto conocido o introduce coordenadas. Nosotros reunimos
          las observaciones reales de SPHEREx y las ordenamos en el tiempo.
        </p>
      </div>

      <form
        class="search-form"
        onsubmit={(event) => {
          event.preventDefault();
          void explore();
        }}
      >
        <div class="preset-chips" aria-label="Objetos de ejemplo">
          {#each presets as preset, i}
            <button
              type="button"
              class:active={selectedPreset === preset}
              onclick={() => selectPreset(String(i))}
            >
              {preset.name}
            </button>
          {/each}
        </div>

        <div class="search-fields">
          <div>
            <label for="ra">Ascensión recta</label>
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
            <label for="dec">Declinación</label>
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
          <button type="submit" class="primary explore-button" disabled={busy}>
            {busy ? "Consultando…" : "Explorar"} <span>→</span>
          </button>
        </div>

        <div class="selected-object-note">
          <span>{selectedPreset?.detail ?? "Coordenadas personalizadas"}</span>
        </div>

        {#if queryDirty}
          <div class="pending-query" role="status">
            <span class="pending-dot"></span>
            <div>
              <strong>Cambios sin aplicar</strong>
              <small>
                El visor sigue mostrando la consulta anterior. Presiona
                “Explorar” para usar esta nueva configuración.
              </small>
            </div>
          </div>
        {:else if activeQuery}
          <div class="current-query">
            <span class="current-dot"></span>
            Configuración aplicada al visor
          </div>
        {/if}

        {#if busy}
          <button
            type="button"
            class="secondary cancel-button"
            onclick={cancel}
          >
            Cancelar consulta
          </button>
        {/if}

        <details class="advanced-search">
          <summary>Opciones avanzadas · para explorar con más precisión</summary
          >
          <div class="advanced-grid">
            <div>
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
            </div>
            <div>
              <label for="detector">Detector infrarrojo</label>
              <select id="detector" bind:value={query.detector}>
                {#each detectors as band, i}
                  <option value={i + 1}>D{i + 1} · {band}</option>
                {/each}
              </select>
            </div>
          </div>
        </details>
      </form>
    </aside>

    <section class="workspace">
      <div class="panel viewer-panel">
        <div class="viewer-heading">
          <div>
            <span class="eyebrow">Visor temporal</span>
            <h2>
              {activeQuery
                ? `${activeQuery.ra.toFixed(5)}°, ${activeQuery.dec.toFixed(5)}°`
                : "Tu ventana al universo"}
            </h2>
            {#if activeQuery}
              <p class="active-query-meta">
                Consulta actual · D{activeQuery.detector} · {activeQuery.fov}′
              </p>
            {/if}
          </div>
          <button
            class="secondary compact"
            onclick={copyLink}
            disabled={!activeQuery}>Compartir ↗</button
          >
        </div>
        <div class="status" role="status">
          <span class="live-dot"></span>{status}
        </div>
        {#if busy || progressPhase === "ready" || progressPhase === "error"}
          <div
            class="query-progress"
            class:is-error={progressPhase === "error"}
            class:is-ready={progressPhase === "ready"}
            class:is-partial={progressPhase === "partial"}
          >
            <div class="progress-copy">
              <div>
                <span class="progress-kicker">
                  {progressPhase === "searching"
                    ? "Buscando datos"
                    : progressPhase === "loading"
                      ? "Preparando imágenes"
                      : progressPhase === "ready"
                        ? "Consulta lista"
                        : progressPhase === "partial"
                          ? "Resultado parcial"
                          : "Problema temporal"}
                </span>
                <strong>{progressLabel}</strong>
              </div>
              {#if progressPhase === "loading" || progressPhase === "ready" || progressPhase === "partial"}
                <span class="progress-percent">{progress}%</span>
              {/if}
            </div>

            <div
              class="progress-track"
              class:indeterminate={progressPhase === "searching"}
              role="progressbar"
              aria-label={progressLabel}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={progressPhase === "searching"
                ? undefined
                : progress}
            >
              <span
                class="progress-fill"
                style={`width: ${progressPhase === "searching" ? 36 : progress}%`}
              ></span>
            </div>

            <div class="progress-stages" aria-hidden="true">
              <span class:active={progressPhase === "searching"}
                >1 · Buscar</span
              >
              <span class:active={progressPhase === "loading"}
                >2 · Preparar</span
              >
              <span
                class:active={progressPhase === "ready" ||
                  progressPhase === "partial"}>3 · Explorar</span
              >
            </div>

            {#if retryAvailable}
              <button
                type="button"
                class="retry-button"
                onclick={() => void explore()}
              >
                Reintentar consulta ↻
              </button>
            {/if}
          </div>
        {/if}
        <div class="observation-summary" aria-label="Resumen de la consulta">
          <div>
            <strong>{totalObservations}</strong>
            <span>observaciones encontradas</span>
          </div>
          <div>
            <strong>{frames.length}</strong>
            <span>imágenes cargadas</span>
          </div>
          <div>
            <strong>D{activeQuery?.detector ?? query.detector}</strong>
            <span>detector</span>
          </div>
          <div>
            <strong>{activeQuery?.fov ?? query.fov}′</strong>
            <span>campo de visión</span>
          </div>
        </div>
        {#if usingPreview && current && current.zodi_subtracted !== true}
          <p class="notice legacy-preview">
            Vista previa de respaldo antigua: sirve para demostrar navegación,
            Blink y Overlay, pero todavía no incluye la nueva corrección IMAGE −
            ZODI. Difference queda deshabilitado hasta regenerar esta caché.
          </p>
        {/if}
        {#if usingPreview}
          <p class="hint" data-testid="saved-preview">
            Vista previa guardada de Barnard · preparada el {previewSavedAt?.slice(
              0,
              10,
            )}. Son observaciones reales con sus fechas originales, no una
            consulta actualizada ni imágenes simuladas.
          </p>
        {/if}
        <div
          class="sky-view"
          class:has-image={!!current}
          class:is-zoomed={zoom > 1}
          class:is-dragging={dragging}
          bind:this={skyContainer}
          role="region"
          aria-label="Visor astronómico interactivo"
          onpointerdown={startPan}
          onpointermove={movePan}
          onpointerup={endPan}
          onpointercancel={endPan}
        >
          {#if current}
            <canvas
              bind:this={canvas}
              aria-label="Recorte astronómico alineado: norte arriba, este a la izquierda"
              style={`transform: translate(${panX}px, ${panY}px) scale(${zoom})`}
            ></canvas>
            <span class="north">N ↑</span><span class="east">E ←</span>
            <div class="image-label">
              <span class="live-dot"></span>{observation.date.slice(0, 10)}
              <span class="muted">{observation.date.slice(11, 19)} UTC</span>
            </div>
            <div class="image-scale">
              {activeQuery?.fov}′ × {activeQuery?.fov}′ · {current.pixel_scale_arcsec.toFixed(
                2,
              )}″/px
            </div>
            <div class="viewer-tools" aria-label="Controles del visor">
              <button
                type="button"
                onclick={() => zoomBy(-0.25)}
                disabled={zoom <= 1}
                aria-label="Alejar">−</button
              >
              <span>{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onclick={() => zoomBy(0.25)}
                disabled={zoom >= 4}
                aria-label="Acercar">+</button
              >
              <button
                type="button"
                onclick={resetZoom}
                disabled={zoom === 1 && panX === 0 && panY === 0}
              >
                Reset
              </button>
              <button
                type="button"
                onclick={toggleFullscreen}
                aria-label="Pantalla completa">⛶</button
              >
            </div>
          {:else}
            <div class="empty-state">
              <h3>
                {busy
                  ? "Recuperando un fragmento del cielo"
                  : progressPhase === "error"
                    ? "IRSA no respondió esta vez"
                    : "El siguiente hallazgo empieza mirando"}
              </h3>
              <p>
                {busy
                  ? "Estamos buscando observaciones y preparando los archivos FITS. Puedes seguir el avance arriba."
                  : progressPhase === "error"
                    ? "El servicio externo puede estar saturado. No significa que esta región no tenga datos; usa Reintentar cuando quieras."
                    : "Elige uno de los cinco objetos de referencia o introduce tus propias coordenadas."}
              </p>
              <span class="badge"
                >{busy
                  ? "DATOS REALES · PROCESANDO"
                  : progressPhase === "error"
                    ? "SERVICIO TEMPORALMENTE NO DISPONIBLE"
                    : "SIN DATOS CARGADOS"}</span
              >
            </div>
          {/if}
        </div>
        <div class="playback">
          <div class="transport">
            <button
              aria-label="Imagen anterior"
              disabled={frames.length < 2}
              onclick={() => step(-1)}>‹</button
            >
            <button
              class="play"
              aria-label={playing ? "Pausar" : "Reproducir"}
              disabled={frames.length < 2}
              onclick={() => {
                playing = !playing;
                autoplayAllowed = playing;
              }}>{playing ? "Ⅱ" : "▶"}</button
            >
            <button
              aria-label="Imagen siguiente"
              disabled={frames.length < 2}
              onclick={() => step(1)}>›</button
            >
            <span>{frames.length ? index + 1 : 0} / {frames.length}</span>
          </div>
          <label class="speed" for="fps"
            >Velocidad<select id="fps" bind:value={fps}
              ><option value={1}>1 fps</option><option value={2}>2 fps</option
              ><option value={4}>4 fps</option><option value={8}>8 fps</option
              ></select
            ></label
          >
        </div>
        <label class="sr-only" for="timeline">Observación actual</label>
        <input
          id="timeline"
          class="timeline"
          type="range"
          min="0"
          max={Math.max(0, frames.length - 1)}
          bind:value={index}
          disabled={!frames.length}
          oninput={() => {
            playing = false;
            autoplayAllowed = false;
            blinkReference = false;
          }}
        />
        <div class="timeline-dates">
          <span
            >{observations[0]?.date.slice(0, 10) ?? "Primera observación"}</span
          ><span
            >{observations.at(-1)?.date.slice(0, 10) ??
              "Última observación"}</span
          >
        </div>
        {#if frames.length && totalObservations > frames.length}
          <div class="sampling-note">
            <span>Serie temporal muestreada</span>
            <strong>{frames.length} imágenes visibles</strong>
            <p>
              Se encontraron {totalObservations} observaciones para esta región y
              detector. El visor usa una muestra distribuida en el tiempo; no representa
              todas las observaciones disponibles.
            </p>
          </div>
        {/if}
      </div>

      <div class="panel analysis-panel">
        <div class="analysis-heading">
          <div>
            <span class="eyebrow">Herramientas de comparación</span>
            <h3>Compara cómo cambia esta región</h3>
          </div>
          <span class="analysis-badge">SPHEREx real</span>
        </div>

        <div class="mode-buttons" aria-label="Modo de visualización">
          <button
            class:active={mode === "image"}
            onclick={() => changeMode("image")}
            disabled={!frames.length}
          >
            <strong>Normal</strong>
            <span>Recorre las épocas</span>
          </button>
          <button
            class:active={mode === "blink"}
            onclick={() => changeMode("blink")}
            disabled={frames.length < 2}
          >
            <strong>Blink</strong>
            <span>Alterna A / B</span>
          </button>
          <button
            class:active={mode === "overlay"}
            onclick={() => changeMode("overlay")}
            disabled={frames.length < 2}
          >
            <strong>Overlay</strong>
            <span>Rojo / cian</span>
          </button>
          <button
            class:active={mode === "difference"}
            onclick={() => changeMode("difference")}
            disabled={frames.length < 2}
          >
            <strong>Diferencia</strong>
            <span
              >{hasCompatibleReference
                ? "Par compatible disponible"
                : "Exploración visual"}</span
            >
          </button>
        </div>

        <div class="analysis-settings">
          {#if mode !== "image"}
            <div>
              <label for="reference">Observación de referencia B</label>
              <select
                id="reference"
                bind:value={referenceIndex}
                disabled={frames.length < 2}
              >
                {#each observations as item, i}
                  <option value={i} disabled={i === index}>
                    {i + 1} · {item.date.slice(0, 10)} · {frames[
                      i
                    ]?.wavelength_um?.toFixed(3) ?? "?"} μm
                    {i !== index &&
                    spectrallyCompatible(frames[index], frames[i])
                      ? " · compatible"
                      : i === index
                        ? " · imagen A"
                        : " · exploratoria"}
                  </option>
                {/each}
              </select>
            </div>
          {/if}
          <div>
            <label for="contrast">Contraste <span>{contrast}</span></label>
            <input
              id="contrast"
              type="range"
              min="1"
              max="20"
              bind:value={contrast}
            />
          </div>
        </div>

        <label class="quality-toggle">
          <input type="checkbox" bind:checked={hideFlags} />
          <span>
            <strong>Ocultar píxeles con calidad baja</strong>
            <small>
              Las banderas de SPHEREx también pueden ser informativas; un píxel
              marcado no significa automáticamente que sea inválido.
            </small>
          </span>
        </label>

        {#if current}
          <div class="metadata-cards">
            <div
              title="Longitud de onda central de esta observación infrarroja."
            >
              <span>λ central · ?</span>
              <strong>{current.wavelength_um?.toFixed(3) ?? "—"} μm</strong>
            </div>
            <div
              title="Porcentaje del recorte solicitado que contiene datos válidos."
            >
              <span>Cobertura · ?</span>
              <strong>{(current.coverage * 100).toFixed(1)}%</strong>
            </div>
            <div
              title="Porcentaje de píxeles con flags que el procesamiento oficial de mosaicos considera problemáticos. SOURCE no se cuenta como píxel malo."
            >
              <span>Píxeles con calidad baja · ?</span>
              <strong>{(current.flagged_fraction * 100).toFixed(1)}%</strong>
            </div>
            <div
              title="Unidad física usada para representar el brillo superficial en la imagen."
            >
              <span>Procesamiento · ?</span>
              <strong
                >{current.zodi_subtracted === true
                  ? "IMAGE − ZODI"
                  : "IMAGE"}</strong
              >
            </div>
          </div>

          <a
            class="fits-link"
            href={observation.source_url}
            target="_blank"
            rel="noreferrer"
          >
            Ver archivo FITS original ↗
          </a>
        {/if}

        {#if mode !== "image" && frames.length > 1}
          <div
            class="comparison-card"
            class:comparison-warning={!comparisonCompatible}
          >
            <span>Comparando A / B</span>
            <strong>
              A · {observations[index]?.date.slice(0, 10)} · {current?.wavelength_um?.toFixed(
                3,
              ) ?? "?"} μm
              <br />
              B · {observations[referenceIndex]?.date.slice(0, 10)} · {referenceFrame?.wavelength_um?.toFixed(
                3,
              ) ?? "?"} μm
            </strong>

            {#if comparisonCompatible}
              <div class="compatibility-ok">
                ✓ Longitudes de onda compatibles para comparación
              </div>
            {:else}
              <div class="compatibility-warning">
                ⚠ Diferencia espectral de {wavelengthDelta?.toFixed(3) ?? "?"} μm.
                Un cambio visual puede deberse al color/espectro del objeto y no al
                tiempo.
              </div>
            {/if}

            {#if mode === "difference"}
              <div
                class="difference-grade"
                class:science-grade={differenceScienceReady}
                class:exploratory-grade={!differenceScienceReady}
              >
                <strong>
                  {differenceScienceReady
                    ? "Comparación científicamente compatible"
                    : "Diferencia visual exploratoria"}
                </strong>
                <span>
                  {differenceScienceReady
                    ? "A y B tienen longitudes de onda compatibles, IMAGE − ZODI y máscara de calidad."
                    : "Puedes inspeccionarla, pero no debe interpretarse como variabilidad temporal confirmada."}
                </span>
              </div>
            {/if}

            <p>
              {mode === "blink"
                ? "Blink alterna las dos épocas para inspección visual."
                : mode === "difference"
                  ? "El mapa A − B resalta cambios visuales. El análisis automático futuro solo usará pares científicamente compatibles."
                  : "Overlay usa rojo para A y cian para B. Si las longitudes de onda no coinciden, úsalo solo como inspección visual."}
            </p>
          </div>
        {/if}

        <div class="candidate-tool">
          <div class="candidate-heading">
            <div>
              <span class="eyebrow">Análisis automático</span>
              <strong>Candidatos en esta región</strong>
            </div>
            <button
              type="button"
              class="candidate-run"
              onclick={() => void runCandidateAnalysis()}
              disabled={frames.length < 3 || candidateBusy || busy}
            >
              {candidateBusy
                ? "Analizando…"
                : candidateResult
                  ? "Analizar de nuevo"
                  : "Buscar candidatos"}
            </button>
          </div>

          <p class="candidate-intro">
            Detecta fuentes compactas, las asocia entre épocas y prioriza
            movimiento aparente o variabilidad. Es un ranking de revisión, no
            una confirmación de descubrimiento.
          </p>

          {#if candidateBusy}
            <div class="candidate-loading" role="status">
              <span class="live-dot"></span>
              Reutilizando las imágenes cargadas y construyendo trayectorias…
            </div>
          {/if}

          {#if candidateError}
            <div class="candidate-error" role="alert">
              <strong>Análisis no completado</strong>
              <span>{candidateError}</span>
            </div>
          {/if}

          {#if candidateResult}
            <div class="candidate-diagnostics">
              <span
                ><strong>{candidateResult.diagnostics.frames_analyzed}</strong>
                épocas</span
              >
              <span
                ><strong>{candidateResult.diagnostics.detections}</strong>
                detecciones</span
              >
              <span
                ><strong>{candidateResult.candidates.length}</strong>
                candidatos</span
              >
            </div>

            {#each candidateResult.warnings as candidateWarning}
              <p class="candidate-warning">{candidateWarning}</p>
            {/each}

            {#if candidateResult.candidates.length}
              <div class="candidate-list" aria-label="Lista de candidatos">
                {#each candidateResult.candidates as candidate, candidateIndex}
                  <button
                    type="button"
                    class="candidate-row"
                    class:active={candidate.id === selectedCandidateId}
                    onclick={() => selectCandidate(candidate)}
                  >
                    <span class="candidate-rank"
                      >{String(candidateIndex + 1).padStart(2, "0")}</span
                    >
                    <span class="candidate-copy">
                      <strong
                        >{candidate.id} · {candidate.kind === "motion"
                          ? "Movimiento"
                          : candidate.kind === "variability"
                            ? "Variabilidad"
                            : "Movimiento + variabilidad"}</strong
                      >
                      <small
                        >{candidate.epochs} épocas · {candidate.reason}</small
                      >
                    </span>
                    <span class="candidate-score">{candidate.score}</span>
                  </button>
                {/each}
              </div>

              {#if selectedCandidate}
                <div class="candidate-details">
                  <div class="candidate-detail-heading">
                    <div>
                      <span>Candidato seleccionado</span>
                      <strong>{selectedCandidate.id}</strong>
                    </div>
                    <span
                      class="confidence"
                      class:high={selectedCandidate.confidence === "high"}
                      class:medium={selectedCandidate.confidence === "medium"}
                      >{selectedCandidate.confidence === "high"
                        ? "alta prioridad"
                        : selectedCandidate.confidence === "medium"
                          ? "prioridad media"
                          : "prioridad baja"}</span
                    >
                  </div>

                  <div class="candidate-metrics">
                    <div>
                      <span>Score</span>
                      <strong>{selectedCandidate.score}/100</strong>
                    </div>
                    <div>
                      <span>Épocas</span>
                      <strong>{selectedCandidate.epochs}</strong>
                    </div>
                    <div>
                      <span>Desplazamiento</span>
                      <strong
                        >{selectedCandidate.motion_arcsec.toFixed(2)}″</strong
                      >
                    </div>
                    <div>
                      <span>Movimiento/año</span>
                      <strong
                        >{selectedCandidate.motion_arcsec_per_year.toFixed(
                          2,
                        )}″/año</strong
                      >
                    </div>
                    <div>
                      <span>Linealidad</span>
                      <strong
                        >{Math.round(
                          selectedCandidate.motion_linearity * 100,
                        )}%</strong
                      >
                    </div>
                    <div>
                      <span>Variabilidad</span>
                      <strong
                        >{Math.round(
                          selectedCandidate.flux_variability * 100,
                        )}%</strong
                      >
                    </div>
                    <div>
                      <span>Cobertura temporal</span>
                      <strong
                        >{Math.round(
                          selectedCandidate.coverage_fraction * 100,
                        )}%</strong
                      >
                    </div>
                    <div>
                      <span>Continuidad</span>
                      <strong
                        >{Math.round(
                          selectedCandidate.continuity * 100,
                        )}%</strong
                      >
                    </div>
                  </div>

                  <p class="candidate-caveat">
                    Marcador cian continuo = detección asociada. Marcador cian
                    punteado = posición predicha durante un hueco corto del
                    track. El score es heurístico: sirve para priorizar revisión
                    humana, no para declarar un objeto nuevo.
                  </p>
                </div>
              {/if}
            {:else}
              <div class="candidate-empty">
                No se encontraron candidatos que superen los criterios mínimos
                en esta muestra temporal. Eso no significa que la región carezca
                de fuentes interesantes.
              </div>
            {/if}
          {/if}
        </div>
      </div>
      {#each warnings as warning}<p class="notice">{warning}</p>{/each}
      {#if frameIssues.length && frames.length < DISPLAY_FRAME_LIMIT}
        <details class="partial-details">
          <summary>
            {frameIssues.length} observación{frameIssues.length === 1
              ? ""
              : "es"} no pudo{frameIssues.length === 1 ? "" : "ieron"} descargarse
          </summary>
          <p>
            El visor utilizó las observaciones que sí estuvieron disponibles.
            Puedes reintentar la consulta más tarde.
          </p>
          <ul>
            {#each frameIssues as issue}<li>{issue}</li>{/each}
          </ul>
        </details>
      {/if}
      {#if errors.length}<div class="error-box" role="alert">
          <strong>No se completaron algunas operaciones</strong
          >{#each errors as error}<p>{error}</p>{/each}
        </div>{/if}
    </section>
  </main>

  <footer>
    <span
      >SPHEREx Explorer · NASA Space Apps Challenge<br />
      Equipo Otarios · Instituto Tecnológico de La Paz</span
    ><span>Datos: NASA / JPL-Caltech / IPAC · Proyecto independiente</span>
  </footer>
</div>
