<script lang="ts">
  import { onMount, tick } from "svelte";
  import { loadFrame, saveAnomalyReport, search } from "./lib/api";
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
    theme === "light" ? "Enable dark mode" : "Enable light mode",
  );
  let status = $state("Starting real-observation query…");
  let index = $state(0);
  let referenceIndex = $state(0);
  let secondaryReferenceIndex = $state(0);
  let playing = $state(false);
  let autoplayAllowed = $state(false);
  let previewSavedAt = $state<string | null>(null);
  let previewMessageDismissed = $state(false);
  let tutorialPrompt = $state(false);
  let tutorialStep = $state(-1);
  let tutorialHighlight = $state<DOMRect | null>(null);
  let tutorialCardPosition = $state({ left: 16, top: 16 });
  let markingAnomaly = $state(false);
  let reportedPixel = $state<{ x: number; y: number } | null>(null);
  let anomalyCategory = $state("");
  let anomalyDetail = $state("");
  let anomalyConfidence = $state("");
  let anomalyQuestion = $state(1);
  let anomalyReportSaved = $state(false);
  let skipTutorialPrompt = $state(false);
  const usingPreview = $derived(previewSavedAt !== null);
  let fps = $state(1);
  let mode = $state<Mode>("image");
  let secondaryMode = $state<Mode>("overlay");
  let dualView = $state(false);
  let contrast = $state(5);
  let hideFlags = $state(false);
  let blinkReference = $state(false);
  let secondaryBlinkReference = $state(false);
  let canvas = $state<HTMLCanvasElement>();
  let secondaryCanvas = $state<HTMLCanvasElement>();
  let imageViewport = $state<HTMLDivElement>();
  let appElement = $state<HTMLDivElement>();
  let skyContainer = $state<HTMLDivElement>();
  let regionOpen = $state(false);
  let settingsOpen = $state(false);
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let dragging = $state(false);
  let focusedViewer = $state<1 | 2 | null>(null);
  let cursorHidden = $state(false);
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  let dragStartX = 0;
  let dragStartY = 0;
  let controller: AbortController | undefined;
  let generation = 0;
  const availableModes: Mode[] = [
    "image",
    "blink",
    "overlay",
    "difference",
  ];
  const modeLabels: Record<Mode, string> = {
    image: "Time series",
    blink: "Blink images",
    overlay: "Overlay images",
    difference: "Difference",
    anomaly: "Anomalies",
  };
  const modeHelp: Record<Mode, string> = {
    image: "",
    blink:
      "Press play to alternate between the current image and the reference.",
    overlay: "Combines the current image in red with the reference in cyan.",
    difference:
      "Highlights what changes between the current image and the reference.",
    anomaly: "Highlights in yellow pixels that differ from the series median.",
  };
  const tutorialSteps = [
    {
      selector: ".toolbar",
      title: "Control bar",
      text: "Use this bar to choose the region and detector. The D1–D6 selector changes the queried SPHEREx detector: each observes the same region in a different spectral band. You can then adjust contrast, change the theme, share the query, and control zoom or full screen.",
    },
    {
      selector: ".region-popover .popover-content",
      title: "Choose a region",
      text: "Choose a reference object from the list or use custom coordinates: enter right ascension (RA) and declination (Dec) in degrees. Adjust the field of view to set the cutout size, then press Explore.",
    },
    {
      selector: "#mode",
      title: "Change the view",
      text: "Compare epochs, overlay images, or show moving sources.",
    },
    {
      selector: "#mode",
      title: "Detect anomalies",
      text: "Choose Overlay images: the current epoch appears in red and the reference in cyan. A red point without a matching cyan point is a candidate you can mark with the target button. Compare it with nearby epochs before reporting it.",
    },
    {
      selector: "#timeline",
      title: "Explore time",
      text: "Move the timeline slider to view each observation and detect changes.",
    },
    {
      selector: ".view-tools",
      title: "Examine the details",
      text: "Zoom in, zoom out, or reset the view to inspect a region.",
    },
  ];
  const range = $derived(sharedRange(frames, hideFlags));
  const shownIndex = $derived(
    mode === "blink" && blinkReference ? referenceIndex : index,
  );
  const current = $derived(frames[shownIndex]);
  const observation = $derived(observations[shownIndex]);
  const secondaryShownIndex = $derived(
    secondaryMode === "blink" && secondaryBlinkReference
      ? secondaryReferenceIndex
      : index,
  );
  const secondaryCurrent = $derived(frames[secondaryShownIndex]);
  const selectedPreset = $derived(
    presets.find(
      (p) =>
        Math.abs(p.ra - query.ra) < 0.000001 &&
        Math.abs(p.dec - query.dec) < 0.000001,
    ),
  );

  onMount(() => {
    skipTutorialPrompt =
      localStorage.getItem("skip-tutorial-prompt") === "true";
    query = readQuery(window.location.search);
    autoplayAllowed = !window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    const preview = getSavedPreview(query);
    if (preview) {
      observations = preview.observations;
      frames = preview.frames;
      referenceIndex = frames.length > 1 ? 1 : 0;
      secondaryReferenceIndex = referenceIndex;
      previewSavedAt = preview.savedAt;
      activeQuery = { ...query };
    }
    void explore();
    return () => {
      controller?.abort();
      clearViewerFocus();
    };
  });

  async function updateTutorialHighlight() {
    regionOpen = tutorialStep === 1;
    await tick();
    const target = document.querySelector<HTMLElement>(
      tutorialSteps[tutorialStep]?.selector,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    await tick();
    tutorialHighlight = target.getBoundingClientRect();
    const { left, right, top, bottom } = tutorialHighlight;
    const cardWidth = Math.min(390, window.innerWidth - 32);
    const cardHeight = 230;
    const preferredTop =
      bottom + 16 + cardHeight <= window.innerHeight
        ? bottom + 16
        : top - cardHeight - 16;
    tutorialCardPosition = {
      left:
        right + 16 + cardWidth <= window.innerWidth
          ? right + 16
          : Math.max(16, left - cardWidth - 16),
      top: Math.max(
        16,
        Math.min(window.innerHeight - cardHeight - 16, preferredTop),
      ),
    };
  }

  function startTutorial() {
    tutorialPrompt = false;
    tutorialStep = 0;
    void updateTutorialHighlight();
  }

  function closeTutorial() {
    tutorialStep = -1;
    tutorialHighlight = null;
    regionOpen = false;
  }

  function nextTutorial() {
    if (tutorialStep === tutorialSteps.length - 1) {
      closeTutorial();
      return;
    }
    tutorialStep++;
    void updateTutorialHighlight();
  }

  function previousTutorial() {
    if (tutorialStep === 0) return;
    tutorialStep--;
    void updateTutorialHighlight();
  }

  const anomalyDetails: Record<string, string[]> = {
    position: [
      "The point changed position, but the others remained fixed.",
      "The whole image appears to move.",
      "It moved and then returned to its position.",
      "I am not sure.",
    ],
    brightness: [
      "It is brighter now.",
      "It is dimmer now.",
      "Its brightness increases and decreases.",
      "I am not sure.",
    ],
    appearance: [
      "It appears in the first image and disappears later.",
      "It does not appear at first, but it does later.",
      "It appears and disappears several times.",
      "I am not sure.",
    ],
    shape: [
      "It looks larger or smaller.",
      "It looks elongated or distorted.",
      "Several points now seem visible.",
      "I am not sure.",
    ],
    other: [
      "I see a point I had not noticed.",
      "There is a spot or an unusual shape.",
      "The image changes unexpectedly.",
      "I cannot explain it, but I want to flag it.",
    ],
  };
  const anomalyCategories = [
    ["position", "Changed position"],
    ["brightness", "Changed brightness"],
    ["appearance", "Appeared or disappeared"],
    ["shape", "Changed shape"],
    ["other", "Something looks unusual"],
  ] as const;

  function chooseAnomalyPixel(event: MouseEvent, frame: Frame) {
    if (!markingAnomaly || !(event.currentTarget instanceof HTMLCanvasElement))
      return;
    const bounds = event.currentTarget.getBoundingClientRect();
    reportedPixel = {
      x: Math.max(
        0,
        Math.min(
          frame.width - 1,
          Math.floor(
            ((event.clientX - bounds.left) / bounds.width) * frame.width,
          ),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          frame.height - 1,
          Math.floor(
            ((event.clientY - bounds.top) / bounds.height) * frame.height,
          ),
        ),
      ),
    };
    anomalyCategory = "";
    anomalyDetail = "";
    anomalyConfidence = "";
    anomalyQuestion = 1;
    anomalyReportSaved = false;
    markingAnomaly = false;
  }

  async function submitAnomalyReport() {
    if (
      !reportedPixel ||
      !anomalyCategory ||
      !anomalyDetail ||
      !anomalyConfidence ||
      !observation
    )
      return;
    try {
      await saveAnomalyReport({
        observation_id: observation.id,
        date: observation.date,
        ...reportedPixel,
        category: anomalyCategory,
        detail: anomalyDetail,
        confidence: anomalyConfidence,
      });
      status = "Anomaly report saved.";
      anomalyReportSaved = true;
    } catch (error) {
      errors = [
        ...errors,
        error instanceof Error
          ? error.message
          : "Could not save the anomaly report.",
      ];
    }
  }

  function nextAnomalyQuestion() {
    if (anomalyQuestion === 1 && anomalyCategory) anomalyQuestion = 2;
    else if (anomalyQuestion === 2 && anomalyDetail) anomalyQuestion = 3;
  }

  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });

  $effect(() => {
    if (busy || !playing || frames.length < 2) return;
    const timer = window.setInterval(() => {
      if (mode === "blink") blinkReference = !blinkReference;
      if (dualView && secondaryMode === "blink")
        secondaryBlinkReference = !secondaryBlinkReference;
      if (mode !== "blink" || (dualView && secondaryMode !== "blink"))
        index = (index + 1) % frames.length;
    }, 1000 / fps);
    return () => window.clearInterval(timer);
  });

  $effect(() => {
    if (!canvas || !current) return;
    paintFrame(canvas, current, frames[referenceIndex], mode);
  });

  $effect(() => {
    if (!dualView || !secondaryCanvas || !secondaryCurrent) return;
    paintFrame(
      secondaryCanvas,
      secondaryCurrent,
      frames[secondaryReferenceIndex],
      secondaryMode,
    );
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

  function clearViewerFocus() {
    clearTimeout(cursorTimer);
    cursorTimer = undefined;
    focusedViewer = null;
    cursorHidden = false;
  }

  function wakeCursor(event: PointerEvent) {
    if (event.pointerType !== "mouse") {
      clearViewerFocus();
      return;
    }
    clearTimeout(cursorTimer);
    cursorTimer = undefined;
    cursorHidden = false;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const viewport = target?.closest(".image-viewport");
    const viewer = viewport
      ?.closest(".viewer-pane")
      ?.getAttribute("data-viewer");
    focusedViewer = viewer === "1" ? 1 : viewer === "2" ? 2 : null;
    if (!focusedViewer || dragging) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = undefined;
      if (focusedViewer !== null && !dragging) cursorHidden = true;
    }, 2000);
  }

  function startPan(event: PointerEvent) {
    wakeCursor(event);
    if (
      event.target instanceof Element &&
      event.target.closest("button, select, input, label, summary")
    )
      return;
    if (busy || !current || zoom <= 1 || event.button !== 0 || !skyContainer)
      return;
    dragging = true;
    dragStartX = event.clientX - panX;
    dragStartY = event.clientY - panY;
    skyContainer.setPointerCapture(event.pointerId);
  }

  function movePan(event: PointerEvent) {
    wakeCursor(event);
    if (!dragging) return;
    panX = event.clientX - dragStartX;
    panY = event.clientY - dragStartY;
    clampPan();
  }

  function endPan(event: PointerEvent) {
    dragging = false;
    if (skyContainer?.hasPointerCapture(event.pointerId))
      skyContainer.releasePointerCapture(event.pointerId);
    wakeCursor(event);
  }

  function navigateImage(event: KeyboardEvent) {
    if (
      event.target instanceof Element &&
      event.target.closest("button, select, input, label, summary")
    )
      return;
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
      errors = [...errors, "Could not switch to full-screen mode."];
    }
  }

  function selectPreset(value: string) {
    const preset = presets[Number(value)];
    query = { ...query, ra: preset.ra, dec: preset.dec, fov: 12 };
  }

  async function explore() {
    clearViewerFocus();
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
    secondaryBlinkReference = false;
    errors = [];
    frameIssues = [];
    warnings = [];
    previewMessageDismissed = false;
    progress = null;
    loadingTotal = 0;
    loadingCompleted = 0;
    busy = true;
    status = "Querying DR1 and QR3 at NASA/IPAC IRSA…";
    try {
      const result = await search(submitted, signal);
      if (token !== generation) return;
      warnings = result.warnings;
      progress = 10;
      loadingTotal = result.observations.length;
      if (!result.observations.length) {
        status = usingPreview
          ? "IRSA returned no observations to update the saved preview."
          : `No observations are available for these coordinates and detector.${frames.length ? " The previous view is preserved." : ""}`;
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
              `${item.date.slice(0, 10)} · ${item.obs_id}: ${error instanceof Error ? error.message : "Error loading image."}`,
            ];
          }
          if (token !== generation) return;
          loadingCompleted++;
          progress = 10 + Math.round((loadingCompleted / loadingTotal) * 90);
          status = `Preparing the series: ${loadingCompleted}/${loadingTotal} observations processed · ${loaded.length} images ready`;
        }
      };
      await Promise.all([worker(), worker()]);
      if (token !== generation || signal.aborted) return;
      if (!loaded.length) {
        errors = [
          "Could not prepare any images from this query. You can explore again to retry.",
        ];
        status = usingPreview
          ? "Could not update. The saved preview is preserved."
          : frames.length
            ? "Could not update. The last complete series is preserved."
            : "Could not prepare any images. Check the errors.";
        return;
      }
      loaded.sort((a, b) => a.observation.mjd - b.observation.mjd);
      observations = loaded.map((item) => item.observation);
      frames = loaded.map((item) => item.frame);
      activeQuery = submitted;
      previewSavedAt = null;
      index = 0;
      referenceIndex = frames.length > 1 ? 1 : 0;
      secondaryReferenceIndex = referenceIndex;
      mode = "image";
      secondaryMode = frames.length > 1 ? "overlay" : "image";
      secondaryBlinkReference = false;
      resetZoom();
      playing = autoplayAllowed && frames.length >= 2;
      window.history.replaceState(
        null,
        "",
        shareUrl(window.location.href, submitted),
      );
      status = frameIssues.length
        ? `${frames.length} of ${loadingTotal} images ready · partial result`
        : `${frames.length} real images ready · ${result.total} observations found`;
      tutorialPrompt = !skipTutorialPrompt;
      if (frames.length === 1)
        warnings = [
          ...warnings,
          "Only one image is loaded; comparing epochs is not possible.",
        ];
    } catch (error) {
      if (signal.aborted || token !== generation) return;
      errors = [
        error instanceof Error ? error.message : "Could not query IRSA.",
      ];
      status = usingPreview
        ? "The update failed. The saved preview is preserved."
        : frames.length
          ? "The update failed. The last complete series is preserved."
          : "The query did not complete.";
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
    secondaryBlinkReference = false;
    busy = false;
    status = frames.length
      ? `Query cancelled. ${frames.length} loaded images were preserved.`
      : "Query cancelled. You can start another search.";
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        shareUrl(window.location.href, activeQuery ?? query),
      );
      status = "Region link copied.";
    } catch {
      errors = [
        ...errors,
        "Could not access the clipboard. Copy the URL from the browser address bar.",
      ];
    }
  }

  function changeMode(value: string, viewer: 1 | 2 = 1) {
    const selectedMode = availableModes.find((option) => option === value);
    if (!selectedMode) {
      errors = [...errors, "The selected view mode is invalid."];
      return;
    }
    if (viewer === 1) {
      mode = selectedMode;
      blinkReference = false;
    } else {
      secondaryMode = selectedMode;
      secondaryBlinkReference = false;
    }
  }

  function setReference(viewer: 1 | 2, value: number) {
    if (viewer === 1) referenceIndex = value;
    else secondaryReferenceIndex = value;
  }

  function needsReference(selectedMode: Mode) {
    return (
      selectedMode === "blink" ||
      selectedMode === "overlay" ||
      selectedMode === "difference"
    );
  }

  function anomalySummary() {
    return "Use Overlay images: red points stand out in the current epoch against the cyan reference.";
  }

  function step(delta: number) {
    playing = false;
    autoplayAllowed = false;
    blinkReference = false;
    secondaryBlinkReference = false;
    index = (index + delta + frames.length) % frames.length;
  }
</script>

{#snippet referenceControls(viewer: 1 | 2, selected: number)}
  <div class="reference-controls">
    <label for={`reference-${viewer}`}>Reference</label>
    <select
      id={`reference-${viewer}`}
      class="reference-select"
      aria-label={`Viewer ${viewer} reference`}
      value={selected}
      disabled={busy || frames.length < 2}
      onchange={(event) =>
        setReference(viewer, Number(event.currentTarget.value))}
    >
      {#each observations as item, i}
        <option value={i}>
          {i + 1} · {item.date.slice(0, 10)}
          {item.date.slice(11, 19)}
        </option>
      {/each}
    </select>
    <button
      aria-label={`Use current image as viewer ${viewer} reference`}
      title="Select the current timeline image as the reference"
      disabled={busy || frames.length < 2}
      onclick={() => setReference(viewer, index)}>Use current image</button
    >
  </div>
{/snippet}

<svelte:head>
  <title>SPHEREx Explorer · The sky, through time</title>
</svelte:head>

<svelte:window
  onblur={clearViewerFocus}
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

<div
  class="app"
  class:viewer-focused={focusedViewer !== null}
  bind:this={appElement}
>
  <header
    class="toolbar"
    aria-label="Explorer controls"
    inert={tutorialPrompt || tutorialStep >= 0}
  >
    <a class="brand" href="/" aria-label="SPHEREx Explorer home"
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
            title="Choose object, coordinates, and field of view"
          >
            <span class="region-name"
              >{selectedPreset?.name ?? "Coordinates"}</span
            >
            <span class="chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="popover-content">
            <h1>Sky region</h1>
            <label for="preset">Reference object</label>
            <select
              id="preset"
              value={selectedPreset
                ? String(presets.indexOf(selectedPreset))
                : ""}
              onchange={(event) => selectPreset(event.currentTarget.value)}
            >
              <option value="" disabled>Custom coordinates</option>
              {#each presets as preset, i}
                <option value={String(i)}>{preset.name}</option>
              {/each}
            </select>
            <p class="hint">
              {selectedPreset?.detail ?? "ICRS coordinates in decimal degrees."}
            </p>
            <div class="coordinate-fields">
              <div>
                <label for="ra">Right ascension (°)</label>
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
                <label for="dec">Declination (°)</label>
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
            <label for="fov">Field of view <span>{query.fov}′</span></label>
            <input
              id="fov"
              type="range"
              min="1"
              max="30"
              step="1"
              bind:value={query.fov}
            />
            <div class="range-labels">
              <span>1′ · detail</span><span>30′ · context</span>
            </div>
            <p class="hint">
              Coordinates do not propagate to each epoch. Use a wide field for
              high-proper-motion objects, such as Barnard's Star.
            </p>
            <button type="submit" class="primary" disabled={busy}
              >Explore this region</button
            >
          </div>
        </details>
        <label class="sr-only" for="detector">Infrared detector</label>
        <select
          id="detector"
          bind:value={query.detector}
          title="Infrared detector"
        >
          {#each detectors as band, i}
            <option value={i + 1}>D{i + 1} · {band}</option>
          {/each}
        </select>
        <button
          type="submit"
          class="primary"
          aria-label="Explore region"
          disabled={busy}>Explore</button
        >
        {#if busy}
          <button
            type="button"
            class="cancel"
            aria-label="Cancel query"
            onclick={cancel}>Cancel</button
          >
        {/if}
      </form>

      <div class="control-group display-controls">
        <label class="contrast-control" for="contrast">
          Contrast
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
          aria-label="Zoom out"
          title="Zoom out (−)"
          onclick={() => zoomBy(-0.5)}
          disabled={busy || !current || zoom <= 1}>−</button
        >
        <button
          class="zoom-reset"
          aria-label="Reset view"
          title="Reset view (0)"
          onclick={resetZoom}
          disabled={busy || !current}>{Math.round(zoom * 100)}%</button
        >
        <button
          aria-label="Zoom in"
          title="Zoom in (+)"
          onclick={() => zoomBy(0.5)}
          disabled={busy || !current || zoom >= 4}>+</button
        >
        <button
          aria-label="Toggle full screen"
          title="Full screen"
          onclick={() => void toggleFullscreen()}>⛶</button
        >
      </div>
    </div>

    <div class="control-group utility-controls">
      <details class="popover settings-popover" open={settingsOpen}>
        <summary
          id="settings-toggle"
          aria-label="Settings"
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
          <span class="settings-label">Settings</span>
          <span class="chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="popover-content">
          <h2>Comparison and data</h2>
          <label class="checkbox">
            <input type="checkbox" bind:checked={hideFlags} />
            Hide pixels with any quality flag
          </label>
          <p class="hint">
            Some flags are informative. Hiding them all can leave the viewer
            empty.
          </p>
          {#if current}
            <dl class="metadata">
              <div>
                <dt>Brightness</dt>
                <dd>{current.unit}</dd>
              </div>
              <div>
                <dt>Bandwidth</dt>
                <dd>
                  {current.bandwidth_um?.toFixed(3) ?? "Unavailable"} μm
                </dd>
              </div>
              <div>
                <dt>Coverage</dt>
                <dd>{(current.coverage * 100).toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Flagged</dt>
                <dd>{(current.flagged_fraction * 100).toFixed(1)}%</dd>
              </div>
            </dl>
          {/if}
          <p class="hint science-note">
            Common brightness scale across the series. Zodiacal background is
            not subtracted. Differences may also be caused by wavelength, PSF,
            noise, or contamination: they do not confirm motion or variability.
            Each detector covers multiple wavelengths, not a fixed band.
          </p>
          <p class="hint">
            Drag the zoomed image to pan, or focus the viewer and use the arrow
            keys. + / − zoom, and 0 resets the view.
          </p>
          <a
            href="https://irsa.ipac.caltech.edu/Missions/spherex.html"
            target="_blank"
            rel="noreferrer">NASA/IPAC archive ↗</a
          >
          <p class="credits">
            NASA Space Apps Challenge · Otarios Team<br />La Paz Institute of
            Technology<br />Data: NASA / JPL-Caltech / IPAC · Independent
            project
          </p>
        </div>
      </details>
      <button
        class="share"
        hidden
        onclick={copyLink}
        disabled={busy || !activeQuery}
        title="Copy region link"
      >
        Share ↗
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
    aria-label="SPHEREx time-series viewer"
    aria-busy={busy}
  >
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The spatial viewer supports keyboard zoom and pan.) -->
    <div
      class="sky-view"
      class:has-image={!busy && !!current}
      class:zoomed={!busy && zoom > 1}
      class:dragging
      inert={tutorialPrompt || tutorialStep >= 0}
      bind:this={skyContainer}
      role="application"
      aria-label="Astronomical viewer. Use + and − to zoom, arrow keys to pan, and 0 to reset."
      tabindex={!busy && current ? 0 : -1}
      onkeydown={navigateImage}
      onpointerenter={wakeCursor}
      onpointerleave={clearViewerFocus}
      onpointerdown={startPan}
      onpointermove={movePan}
      onpointerup={endPan}
      onpointercancel={endPan}
      onlostpointercapture={() => (dragging = false)}
    >
      {#if busy}
        <div
          class="loading-progress"
          role="progressbar"
          aria-label="Loading observations"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress ?? undefined}
          aria-valuetext={progress === null
            ? "Searching for observations at IRSA"
            : `Query progress: ${progress}%`}
        >
          <span
            class:indeterminate={progress === null}
            style:transform={progress === null
              ? undefined
              : `scaleX(${progress / 100})`}
          ></span>
        </div>
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
              ? "Searching your region"
              : "Building the time series"}
          </h2>
          <p>
            {progress === null
              ? "Querying available observations in the archive."
              : "Downloading and aligning cutouts onto the same celestial grid."}
          </p>
          <div class="loading-detail">
            {progress === null
              ? "Every image has a story. We are bringing them together."
              : `${loadingCompleted} of ${loadingTotal} observations processed`}
          </div>
          <ol class="loading-steps" aria-label="Loading stages">
            <li
              class:active={progress === null}
              class:done={progress !== null}
              aria-current={progress === null ? "step" : undefined}
            >
              <span>01</span>Archive
            </li>
            <li
              class:active={progress !== null}
              aria-current={progress !== null ? "step" : undefined}
            >
              <span>02</span>Preparation
            </li>
            <li><span>03</span>Viewer</li>
          </ol>
        </section>
      {:else if current}
        <div class="viewer-panes" class:dual={dualView}>
          <div
            class="viewer-pane series-pane"
            class:focused={focusedViewer === 1}
            class:cursor-hidden={focusedViewer === 1 && cursorHidden}
            data-viewer="1"
            aria-label="Viewer 1"
          >
            <div class="pane-header">
              <h2 class="pane-title">Viewer 1</h2>
              <label class="sr-only" for="mode">View</label>
              <select
                id="mode"
                value={mode}
                title="Viewer 1 mode"
                onchange={(event) => changeMode(event.currentTarget.value)}
              >
                {#each availableModes as value}
                  <option
                    {value}
                    disabled={value !== "image" && frames.length < 2}
                    >{modeLabels[value]}</option
                  >
                {/each}
              </select>
              {#if needsReference(mode)}
                {@render referenceControls(1, referenceIndex)}
              {/if}
              <button
                class="anomaly-target"
                aria-label="Mark an anomaly"
                title="Freeze the image and mark an anomaly"
                aria-pressed={markingAnomaly}
                disabled={busy}
                onclick={() => {
                  playing = false;
                  markingAnomaly = !markingAnomaly;
                }}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                >
                  <circle cx="12" cy="12" r="7"></circle>
                  <circle cx="12" cy="12" r="2"></circle>
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>
                </svg>
              </button>
              >
              <button
                class="dual-toggle"
                aria-label={dualView ? "Show one viewer" : "Show two viewers"}
                aria-pressed={dualView}
                title={dualView
                  ? "Close second viewer"
                  : "Open second viewer to compare"}
                disabled={busy}
                onclick={() => {
                  clearViewerFocus();
                  dualView = !dualView;
                  secondaryBlinkReference = false;
                }}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                >
                  <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                  <path d="M12 5v14"></path>
                </svg>
              </button>
            </div>
            <div class="image-viewport" bind:this={imageViewport}>
              <canvas
                bind:this={canvas}
                style:transform="translate({panX}px, {panY}px) scale({zoom})"
                onclick={(event) => chooseAnomalyPixel(event, current)}
                aria-label="Aligned astronomical cutout: north up, east left"
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
              {#if mode === "anomaly"}
                <div class="comparison-note">{anomalySummary()}</div>
              {:else if needsReference(mode) && frames.length > 1}
                <div class="comparison-note">
                  Current: {observations[index]?.date.slice(0, 10)} · {frames[
                    index
                  ]?.wavelength_um?.toFixed(3) ?? "?"} μm<br />
                  Reference: {observations[referenceIndex]?.date.slice(0, 10)} ·
                  {frames[referenceIndex]?.wavelength_um?.toFixed(3) ?? "?"} μm
                  {#if index === referenceIndex}<br />The current image and the
                    reference are the same observation.{/if}
                </div>
              {/if}
            </div>
          </div>
          {#if dualView}
            <div
              class="viewer-pane secondary-pane"
              class:focused={focusedViewer === 2}
              class:cursor-hidden={focusedViewer === 2 && cursorHidden}
              data-viewer="2"
              aria-label="Viewer 2"
            >
              <div class="pane-header">
                <h2 class="pane-title">Viewer 2</h2>
                <label class="sr-only" for="secondary-mode">Viewer 2 mode</label
                >
                <select
                  id="secondary-mode"
                  value={secondaryMode}
                  title="Viewer 2 mode"
                  onchange={(event) => changeMode(event.currentTarget.value, 2)}
                >
                  {#each availableModes as value}
                    <option
                      {value}
                      disabled={value !== "image" && frames.length < 2}
                      >{modeLabels[value]}</option
                    >
                  {/each}
                </select>
                {#if needsReference(secondaryMode)}
                  {@render referenceControls(2, secondaryReferenceIndex)}
                {/if}
              </div>
              <div class="image-viewport">
                {#if secondaryCurrent}
                  <canvas
                    bind:this={secondaryCanvas}
                    style:transform="translate({panX}px, {panY}px) scale({zoom})"
                    aria-label="Viewer 2 astronomical cutout: north up, east left"
                  ></canvas>
                  <span class="north">N ↑</span><span class="east">E ←</span>
                  {#if secondaryMode === "overlay" || secondaryMode === "difference"}
                    <div class="overlay-date">
                      <span
                        >Current · {observations[index]?.date.slice(
                          0,
                          10,
                        )}</span
                      >
                      <span
                        >Reference · {observations[
                          secondaryReferenceIndex
                        ]?.date.slice(0, 10)}</span
                      >
                    </div>
                  {:else}
                    <div class="secondary-image-label">
                      <span
                        >{observations[secondaryShownIndex]?.date.slice(
                          0,
                          10,
                        )}</span
                      >
                      <span class="muted"
                        >{observations[secondaryShownIndex]?.date.slice(11, 19)} UTC</span
                      >
                    </div>
                  {/if}
                  <div class="image-scale">
                    {activeQuery?.fov}′ × {activeQuery?.fov}′
                  </div>
                  {#if secondaryMode === "anomaly"}
                    <div class="comparison-note">{anomalySummary()}</div>
                  {:else if needsReference(secondaryMode) && frames.length > 1}
                    <div class="comparison-note">
                      {#if secondaryMode === "overlay"}Current in red ·
                        Reference in cyan<br />{/if}
                      Current: {frames[index]?.wavelength_um?.toFixed(3) ?? "?"} μm
                      · Reference:
                      {frames[secondaryReferenceIndex]?.wavelength_um?.toFixed(
                        3,
                      ) ?? "?"} μm
                      {#if index === secondaryReferenceIndex}<br />The current
                        image and the reference are the same observation.{/if}
                    </div>
                  {/if}
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="empty-state">
          <span class="empty-symbol" aria-hidden="true">+</span>
          <h2>One region, many epochs</h2>
          <p>
            Choose an object or enter coordinates in the region menu, then press
            Explore.
          </p>
        </div>
      {/if}
    </div>

    {#if !busy && ((usingPreview && !previewMessageDismissed) || warnings.length || frameIssues.length || errors.length)}
      <div class="messages">
        {#if usingPreview && !previewMessageDismissed}
          <p
            class="preview-note dismissible-message"
            data-testid="saved-preview"
          >
            Saved preview of Barnard's Star · prepared on {previewSavedAt?.slice(
              0,
              10,
            )}. Real observations with their original dates; this is not an
            updated query or simulated images.
            <button
              class="dismiss-message"
              aria-label="Close saved-preview notice"
              title="Close notice"
              onclick={() => (previewMessageDismissed = true)}
              ><span aria-hidden="true">×</span></button
            >
          </p>
        {/if}
        {#each warnings as warning}<p class="notice">{warning}</p>{/each}
        {#if frameIssues.length}
          <details class="frame-issues">
            <summary
              >{frameIssues.length} observation(s) could not be prepared · View details</summary
            >
            <p>
              IRSA did not allow these cutouts to be prepared. You can explore
              again to retry; available images were not replaced with simulated
              data.
            </p>
            {#each frameIssues as issue}<p>{issue}</p>{/each}
          </details>
        {/if}
        {#if errors.length}
          <div class="error-box dismissible-message" role="alert">
            <strong>Some operations did not complete</strong>
            {#each errors as error}<p>{error}</p>{/each}
            <button
              class="dismiss-message"
              aria-label="Close error message"
              title="Close message"
              onclick={() => (errors = [])}
              ><span aria-hidden="true">×</span></button
            >
          </div>
        {/if}
      </div>
    {/if}

    <div class="timeline-strip">
      <span class="timeline-caption">Epochs</span>
      <div class="timeline-track">
        <label class="sr-only" for="timeline">Current observation</label>
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
            secondaryBlinkReference = false;
          }}
        />
        <div class="timeline-dates">
          <span
            >{busy
              ? "Preparing the series…"
              : (observations[0]?.date.slice(0, 10) ??
                "First observation")}</span
          >
          <span
            >{busy
              ? ""
              : (observations.at(-1)?.date.slice(0, 10) ??
                "Last observation")}</span
          >
        </div>
      </div>
      <span class="timeline-count" title={busy ? undefined : anomalySummary()}
        >{busy ? "Preparing" : `${frames.length} images`}</span
      >
      <div class="playback" role="group" aria-label="Series playback">
        <span class="frame-position"
          >{busy
            ? "— / —"
            : `${frames.length ? index + 1 : 0} / ${frames.length}`}</span
        >
        <div class="transport">
          <button
            aria-label="Previous image"
            title="Previous image"
            disabled={busy || frames.length < 2}
            onclick={() => step(-1)}>‹</button
          >
          <button
            class="play"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
            disabled={busy || frames.length < 2}
            onclick={() => {
              playing = !playing;
              autoplayAllowed = playing;
            }}>{playing ? "Ⅱ" : "▶"}</button
          >
          <button
            aria-label="Next image"
            title="Next image"
            disabled={busy || frames.length < 2}
            onclick={() => step(1)}>›</button
          >
        </div>
        <label class="sr-only" for="fps">Speed</label>
        <select id="fps" bind:value={fps} title="Playback speed">
          <option value={1}>1 fps</option><option value={2}>2 fps</option>
          <option value={4}>4 fps</option><option value={8}>8 fps</option>
        </select>
      </div>
    </div>
  </main>

  <footer inert={tutorialPrompt || tutorialStep >= 0}>
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

  {#if reportedPixel}
    <div class="tutorial-backdrop" role="presentation">
      <div
        class="tutorial-prompt anomaly-report"
        role="dialog"
        aria-modal="true"
      >
        <span class="report-kicker"
          >Citizen report · Step {anomalyQuestion} of 3</span
        >
        <h2>Why do you consider it an anomaly?</h2>
        <p>
          Pixel {reportedPixel.x + 1}, {reportedPixel.y + 1} · {observation.date.slice(
            0,
            10,
          )}
        </p>
        {#if anomalyReportSaved}
          <div class="report-success" role="status">
            <strong>Report saved successfully</strong>
            <span>Thank you for helping flag this possible change.</span>
          </div>
        {:else if anomalyQuestion === 1}
          <fieldset>
            <legend>What caught your attention?</legend
            >{#each anomalyCategories as [value, label]}<label
                ><input
                  type="radio"
                  name="category"
                  {value}
                  bind:group={anomalyCategory}
                />
                {label}</label
              >{/each}
          </fieldset>
        {:else if anomalyQuestion === 2}
          <fieldset>
            <legend>What detail did you observe?</legend
            >{#each anomalyDetails[anomalyCategory] as detail}<label
                ><input
                  type="radio"
                  name="detail"
                  value={detail}
                  bind:group={anomalyDetail}
                />
                {detail}</label
              >{/each}
          </fieldset>
        {:else}
          <fieldset>
            <legend>How confident are you in what you observed?</legend><label
              ><input
                type="radio"
                name="confidence"
                value="very"
                bind:group={anomalyConfidence}
              /> Very confident: I can clearly see the change.</label
            ><label
              ><input
                type="radio"
                name="confidence"
                value="somewhat"
                bind:group={anomalyConfidence}
              /> Somewhat confident: there appears to be a change, but I have doubts.</label
            ><label
              ><input
                type="radio"
                name="confidence"
                value="unsure"
                bind:group={anomalyConfidence}
              /> Unsure: I need another opinion.</label
            >
          </fieldset>
        {/if}
        <div class="tutorial-actions">
          <button onclick={() => (reportedPixel = null)}
            >{anomalyReportSaved ? "Done" : "Close"}</button
          >
          {#if !anomalyReportSaved && anomalyQuestion > 1}<button
              onclick={() => anomalyQuestion--}>Previous</button
            >{/if}
          {#if !anomalyReportSaved && anomalyQuestion < 3}<button
              class="primary"
              disabled={(anomalyQuestion === 1 && !anomalyCategory) ||
                (anomalyQuestion === 2 && !anomalyDetail)}
              onclick={nextAnomalyQuestion}>Next</button
            >{:else if !anomalyReportSaved}<button
              class="primary"
              disabled={!anomalyConfidence}
              onclick={submitAnomalyReport}>Save report</button
            >{/if}
        </div>
      </div>
    </div>
  {/if}

  {#if tutorialPrompt}
    <div class="tutorial-backdrop" role="presentation">
      <div
        class="tutorial-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tutorial-title"
      >
        <h2 id="tutorial-title">Would you like to learn about the explorer?</h2>
        <p>We will show you the main controls in a few short steps.</p>
        <label class="checkbox">
          <input
            type="checkbox"
            bind:checked={skipTutorialPrompt}
            onchange={() =>
              localStorage.setItem(
                "skip-tutorial-prompt",
                String(skipTutorialPrompt),
              )}
          />
          Do not show again
        </label>
        <div class="tutorial-actions">
          <button onclick={() => (tutorialPrompt = false)}>Close</button>
          <button class="primary" onclick={startTutorial}>Yes, start</button>
        </div>
      </div>
    </div>
  {/if}

  {#if tutorialStep >= 0 && tutorialHighlight}
    <div class="tutorial-backdrop tutorial-tour" role="presentation">
      <div
        class="tutorial-highlight"
        style:left={`${tutorialHighlight.left - 8}px`}
        style:top={`${tutorialHighlight.top - 8}px`}
        style:width={`${tutorialHighlight.width + 16}px`}
        style:height={`${tutorialHighlight.height + 16}px`}
      ></div>
      <div
        class="tutorial-card"
        role="dialog"
        aria-modal="true"
        aria-live="polite"
        style:left={`${tutorialCardPosition.left}px`}
        style:top={`${tutorialCardPosition.top}px`}
      >
        <span>Step {tutorialStep + 1} of {tutorialSteps.length}</span>
        <h2>{tutorialSteps[tutorialStep].title}</h2>
        <p>{tutorialSteps[tutorialStep].text}</p>
        <div class="tutorial-actions">
          <button onclick={closeTutorial}>Close</button>
          <button disabled={tutorialStep === 0} onclick={previousTutorial}
            >Previous</button
          >
          <button class="primary" onclick={nextTutorial}
            >{tutorialStep === tutorialSteps.length - 1
              ? "Finish"
              : "Next"}</button
          >
        </div>
      </div>
    </div>
  {/if}
</div>
