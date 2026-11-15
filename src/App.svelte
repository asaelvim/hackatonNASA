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

  let query = $state<Query>({ ...defaults });
  let activeQuery = $state<Query | null>(null);
  let observations = $state<Observation[]>([]);
  let frames = $state<Frame[]>([]);
  let warnings = $state<string[]>([]);
  let errors = $state<string[]>([]);
  let busy = $state(false);
  let status = $state("Elige una región para consultar observaciones reales.");
  let index = $state(0);
  let referenceIndex = $state(0);
  let playing = $state(false);
  let fps = $state(2);
  let mode = $state<Mode>("image");
  let contrast = $state(5);
  let hideFlags = $state(false);
  let blinkReference = $state(false);
  let canvas = $state<HTMLCanvasElement>();
  let controller: AbortController | undefined;
  let generation = 0;
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
    if (window.location.search) void explore();
    return () => controller?.abort();
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
  });

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
    playing = false;
    blinkReference = false;
    mode = "image";
    frames = [];
    observations = [];
    errors = [];
    warnings = [];
    index = 0;
    referenceIndex = 0;
    busy = true;
    activeQuery = submitted;
    status = "Consultando DR1 y QR3 en NASA/IPAC IRSA…";
    window.history.replaceState(
      null,
      "",
      shareUrl(window.location.href, submitted),
    );
    try {
      const result = await search(submitted, signal);
      if (token !== generation) return;
      warnings = result.warnings;
      if (!result.observations.length) {
        status =
          "No hay observaciones disponibles para estas coordenadas y detector.";
        return;
      }
      const loaded: { observation: Observation; frame: Frame }[] = [];
      let next = 0;
      let completed = 0;
      const worker = async () => {
        while (next < result.observations.length && !signal.aborted) {
          const item = result.observations[next++];
          try {
            const frame = await loadFrame(item, submitted, signal);
            loaded.push({ observation: item, frame });
          } catch (error) {
            if (signal.aborted) return;
            errors = [
              ...errors,
              `${item.date.slice(0, 10)} · ${item.obs_id}: ${error instanceof Error ? error.message : "Error al cargar la imagen."}`,
            ];
          }
          if (token !== generation) return;
          completed++;
          status = `Preparando recortes y alineación WCS: ${completed}/${result.observations.length}`;
        }
      };
      await Promise.all([worker(), worker()]);
      if (token !== generation || signal.aborted) return;
      loaded.sort((a, b) => a.observation.mjd - b.observation.mjd);
      observations = loaded.map((item) => item.observation);
      frames = loaded.map((item) => item.frame);
      index = frames.length > 1 ? 1 : 0;
      status = frames.length
        ? `${frames.length} imágenes reales listas · ${result.total} observaciones encontradas`
        : "No se pudo preparar ninguna imagen. Consulta los errores.";
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
      status = "La consulta no se completó.";
    } finally {
      if (token === generation) busy = false;
    }
  }

  function cancel() {
    controller?.abort();
    generation++;
    busy = false;
    status = "Consulta cancelada. Puedes iniciar otra búsqueda.";
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
    blinkReference = false;
    index = (index + delta + frames.length) % frames.length;
  }
</script>

<svelte:head>
  <title>SPHEREx Explorer · El cielo, a través del tiempo</title>
</svelte:head>

<div class="app">
  <header>
    <a class="brand" href="/" aria-label="Inicio de SPHEREx Explorer"
      ><span class="brand-mark">✦</span><span
        >SPHEREx <strong>Explorer</strong></span
      ></a
    >
    <span class="badge">ASTRONOMÍA CIUDADANA</span>
    <a
      class="archive-link"
      href="https://irsa.ipac.caltech.edu/Missions/spherex.html"
      target="_blank"
      rel="noreferrer">Archivo NASA/IPAC ↗</a
    >
  </header>

  <section class="intro">
    <span class="eyebrow">UN MISMO CIELO. DIFERENTES MOMENTOS.</span>
    <h1>Encuentra lo que <span>cambia.</span></h1>
    <p>
      Explora el universo infrarrojo y compara observaciones reales de SPHEREx.
      Un punto que se mueve puede contar una nueva historia.
    </p>
  </section>

  <main>
    <aside class="panel search-panel">
      <div class="panel-title">
        <span>01 / REGIÓN DEL CIELO</span><span class="live-dot"></span>
      </div>
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void explore();
        }}
      >
        <label for="preset">Empieza con un objeto</label>
        <select
          id="preset"
          value={selectedPreset ? String(presets.indexOf(selectedPreset)) : ""}
          onchange={(event) => selectPreset(event.currentTarget.value)}
        >
          <option value="" disabled>Coordenadas personalizadas</option>
          {#each presets as preset, i}<option value={String(i)}
              >{preset.name}</option
            >{/each}
        </select>
        <p class="hint">
          {selectedPreset?.detail ??
            "Introduce coordenadas ICRS en grados decimales."}
        </p>
        <p class="hint">
          Las coordenadas de referencia no se propagan a cada época. Usa un
          campo amplio para objetos de alto movimiento propio, especialmente
          Barnard.
        </p>
        <div class="coordinate-fields">
          <div>
            <label for="ra">Ascensión recta <small>°</small></label><input
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
            <label for="dec">Declinación <small>°</small></label><input
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
        <label for="detector">Detector infrarrojo</label>
        <select id="detector" bind:value={query.detector}>
          {#each detectors as band, i}<option value={i + 1}
              >D{i + 1} · {band}</option
            >{/each}
        </select>
        <p class="hint">
          Cada detector cubre varias longitudes de onda, no una banda fija.
          Consulta la longitud central de cada imagen.
        </p>
        <button type="submit" class="primary" disabled={busy}
          >Explorar región <span>→</span></button
        >
        {#if busy}<button type="button" class="secondary" onclick={cancel}
            >Cancelar consulta</button
          >{/if}
      </form>
      <div class="source-note">
        <span class="eyebrow">FUENTE CIENTÍFICA</span><strong
          >SPHEREx DR1 + QR3</strong
        >
        <p>
          Observaciones individuales, no imágenes sintéticas. Hasta 12 recortes
          por consulta, sobre una cuadrícula celeste común.
        </p>
      </div>
    </aside>

    <section class="workspace">
      <div class="panel viewer-panel">
        <div class="viewer-heading">
          <div>
            <span class="eyebrow">02 / VISOR TEMPORAL</span>
            <h2>
              {activeQuery
                ? `${activeQuery.ra.toFixed(5)}°, ${activeQuery.dec.toFixed(5)}°`
                : "Tu ventana al universo"}
            </h2>
          </div>
          <button
            class="secondary compact"
            onclick={copyLink}
            disabled={!activeQuery}>Compartir ↗</button
          >
        </div>
        <div class="sky-view" class:has-image={!!current}>
          {#if current}
            <canvas
              bind:this={canvas}
              aria-label="Recorte astronómico alineado: norte arriba, este a la izquierda"
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
          {:else}
            <div class="empty-state">
              <div class="orbit" class:loading={busy}><span>✦</span></div>
              <h3>
                {busy
                  ? "Recuperando un fragmento del cielo"
                  : "El siguiente hallazgo empieza mirando"}
              </h3>
              <p>
                {busy
                  ? "IRSA puede tardar en preparar los archivos FITS. Las imágenes se alinean antes de mostrarse."
                  : "Elige uno de los cinco objetos de referencia o introduce tus propias coordenadas."}
              </p>
              <span class="badge"
                >{busy
                  ? "DATOS REALES · PROCESANDO"
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
              onclick={() => (playing = !playing)}>{playing ? "Ⅱ" : "▶"}</button
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
      </div>

      <div class="panel analysis-panel">
        <span class="eyebrow">03 / COMPARA Y EXPLORA</span>
        <div class="analysis-controls">
          <div>
            <label for="mode">Visualización</label><select
              id="mode"
              value={mode}
              onchange={(event) => changeMode(event.currentTarget.value)}
              disabled={!frames.length}
              ><option value="image">Serie temporal</option><option
                value="blink"
                disabled={frames.length < 2}>Alternar A/B</option
              ><option value="overlay" disabled={frames.length < 2}
                >Superponer · A rojo / B cian</option
              ><option value="difference" disabled={frames.length < 2}
                >Diferencia · A − B</option
              ></select
            >
          </div>
          <div>
            <label for="reference">Referencia B</label><select
              id="reference"
              bind:value={referenceIndex}
              disabled={frames.length < 2}
              >{#each observations as item, i}<option value={i}
                  >{i + 1} · {item.date.slice(0, 10)}
                  {item.date.slice(11, 19)}</option
                >{/each}</select
            >
          </div>
          <div>
            <label for="contrast">Contraste <span>{contrast}</span></label
            ><input
              id="contrast"
              type="range"
              min="1"
              max="20"
              bind:value={contrast}
            />
          </div>
        </div>
        <label class="checkbox"
          ><input type="checkbox" bind:checked={hideFlags} /> Ocultar píxeles con
          cualquier bandera de calidad</label
        >
        <p class="hint">
          Algunas banderas son informativas: un píxel marcado no es
          necesariamente inválido. Ocultarlas todas puede dejar el visor vacío.
        </p>
        {#if current}
          <div class="metadata">
            <span
              >λ central <strong
                >{current.wavelength_um?.toFixed(3) ?? "No disponible"} μm</strong
              ></span
            ><span>Brillo <strong>{current.unit}</strong></span><span
              >Cobertura <strong>{(current.coverage * 100).toFixed(1)}%</strong
              ></span
            ><span
              >Con banderas <strong
                >{(current.flagged_fraction * 100).toFixed(1)}%</strong
              ></span
            ><a href={observation.source_url} target="_blank" rel="noreferrer"
              >FITS original ↗</a
            >
          </div>
        {/if}
        <p class="hint">
          Escala de brillo común a la serie. Fondo zodiacal sin sustraer. Las
          diferencias también pueden deberse a longitud de onda, PSF, ruido o
          contaminación: no confirman movimiento ni variabilidad.
        </p>
        {#if mode !== "image" && frames.length > 1}
          <p class="comparison-note">
            A: {observations[index]?.date.slice(0, 10)} · {frames[
              index
            ]?.wavelength_um?.toFixed(3) ?? "?"} μm — B: {observations[
              referenceIndex
            ]?.date.slice(0, 10)} · {frames[
              referenceIndex
            ]?.wavelength_um?.toFixed(3) ?? "?"} μm. {index === referenceIndex
              ? "A y B son la misma observación."
              : ""}
            {mode === "blink" ? "Pulsa reproducir para alternar." : ""}
          </p>
        {/if}
      </div>
      <div class="status" role="status">
        <span class="live-dot" class:pulse={busy}></span>{status}
      </div>
      {#each warnings as warning}<p class="notice">{warning}</p>{/each}
      {#if errors.length}<div class="error-box" role="alert">
          <strong>No se completaron algunas operaciones</strong
          >{#each errors as error}<p>{error}</p>{/each}
        </div>{/if}
    </section>
  </main>

  <footer>
    <span>SPHEREx Explorer · NASA Space Apps Challenge</span><span
      >Datos: NASA / JPL-Caltech / IPAC · Proyecto independiente</span
    >
  </footer>
</div>
