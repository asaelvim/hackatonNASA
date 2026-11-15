# SPHEREx Explorer

Desarrollado por el **equipo Otarios**, del **Instituto Tecnológico de La Paz**,
para NASA Space Apps Challenge.

SPHEREx Explorer es una herramienta web de astronomía ciudadana para consultar
observaciones reales de **SPHEREx** desde NASA/IPAC IRSA, construir una serie
temporal de una región del cielo y comparar cómo cambia entre distintas épocas.

El proyecto está diseñado para que una persona sin experiencia astronómica pueda
explorar el cielo mediante objetos de ejemplo o coordenadas, sin ocultar la
información científica necesaria para interpretar correctamente las imágenes.

---

## Estado actual

El núcleo del explorador temporal está funcional y validado.

Incluye:

- Consulta de observaciones reales desde **SPHEREx DR1 y QR3**.
- Búsqueda por **ascensión recta y declinación**.
- Cinco objetos de referencia precargados.
- Selección de detector infrarrojo D1–D6.
- Campo de visión configurable entre 1′ y 30′.
- Hasta **12 imágenes visibles** distribuidas a lo largo del intervalo temporal.
- Pool interno de observaciones de respaldo para resistir fallos individuales.
- Reproyección WCS a una cuadrícula común.
- Norte arriba y este a la izquierda.
- Procesamiento **IMAGE − ZODI**.
- Máscara de calidad basada en flags problemáticos de SPHEREx.
- Timeline y reproducción automática.
- Modos **Normal**, **Blink**, **Overlay** y **Difference**.
- Validación de compatibilidad espectral entre imágenes A/B.
- Diferencia científica cuando el par es compatible.
- Diferencia visual exploratoria cuando no lo es.
- Contraste interactivo.
- Zoom de 100% a 400%.
- Pan con mouse o pantalla táctil.
- Reset y pantalla completa.
- Barra de progreso por etapas.
- Manejo de resultados completos, parciales y fallos de IRSA.
- Conservación de la última vista válida cuando una nueva consulta falla.
- Compartir consultas mediante URL.
- Enlace directo al FITS original de IRSA.
- Detección automática de fuentes compactas.
- Asociación de detecciones entre épocas.
- Ranking de candidatos por movimiento aparente y variabilidad.
- Candidate Score heurístico para priorizar revisión humana.
- Marcador de candidato dentro del visor temporal.

---

## Arquitectura

### Frontend

- **Svelte 5**
- **TypeScript**
- **Vite**
- **Canvas API**

El frontend controla la búsqueda, reproducción temporal, comparación de imágenes,
zoom, navegación y presentación de metadatos.

### Backend

- **FastAPI**
- **Astropy**
- **NumPy**
- **SciPy**
- **HTTPX**

El backend consulta NASA/IPAC IRSA, descarga archivos FITS, aplica el procesamiento
científico y alinea las observaciones antes de enviarlas al navegador.

---

## Flujo de una consulta

```text
RA + Dec + detector + campo de visión
                ↓
       NASA/IPAC IRSA
          DR1 + QR3
                ↓
      observaciones encontradas
                ↓
   selección temporal + respaldos
                ↓
          descarga FITS
                ↓
         IMAGE − ZODI
                ↓
      máscara de calidad SPHEREx
                ↓
        reproyección WCS
                ↓
      cuadrícula temporal común
                ↓
       hasta 12 imágenes visibles
                ↓
 Normal / Blink / Overlay / Difference
```

DR1 y QR3 se consultan de forma independiente. Si una colección falla pero la otra
responde, la aplicación continúa utilizando los datos disponibles.

---

## Procesamiento científico

### IMAGE − ZODI

Las imágenes utilizadas por el visor restan el modelo de luz zodiacal cuando el
archivo FITS contiene la extensión `ZODI`:

```text
imagen procesada = IMAGE − ZODI
```

Esto reduce cambios de fondo que podrían confundirse con variabilidad real.

### Máscara de calidad

La extensión `FLAGS` es una máscara de bits y **no se interpola como una imagen de
brillo**.

Los flags problemáticos se reproyectan mediante nearest-neighbor. Flags
informativos como `SOURCE` no se consideran automáticamente píxeles inválidos.

El porcentaje mostrado como **Píxeles con calidad baja** representa solo los flags
que el procesamiento considera problemáticos.

### Comparación espectral

Un detector SPHEREx no representa una única longitud de onda. Por ello, dos
observaciones del mismo detector no necesariamente son comparables directamente.

El visor muestra la longitud de onda central de cada imagen.

En modos A/B:

- Si las longitudes de onda son compatibles, el visor marca la comparación como
  **científicamente compatible**.
- Si no lo son, Difference sigue disponible como herramienta visual, pero se marca
  como **diferencia visual exploratoria**.

Una diferencia visual por sí sola **no representa una detección confirmada**.

---

## Muestreo temporal

Una región puede contener decenas de observaciones.

Por rendimiento, el backend obtiene un conjunto temporal de candidatos y el
frontend muestra hasta **12 imágenes distribuidas a través del intervalo disponible**.

Ejemplo:

```text
60 observaciones encontradas
        ↓
pool temporal de respaldo
        ↓
12 imágenes visibles
```

Si una observación del pool falla pero aun así se obtienen las 12 imágenes
requeridas, el usuario recibe una consulta completa.

Si no se consiguen las 12, la aplicación muestra un resultado parcial sin descartar
las imágenes que sí pudieron cargarse.

La serie visible es una muestra temporal y no representa necesariamente todas las
exposiciones disponibles en IRSA.

---

## Resiliencia ante IRSA

IRSA es un servicio externo y puede devolver timeouts o errores 5xx.

SPHEREx Explorer implementa:

- reintentos ante fallos transitorios;
- timeout independiente para búsquedas de catálogo;
- tolerancia a fallos independientes entre DR1 y QR3;
- pool de observaciones de respaldo;
- carga progresiva;
- conservación de la última consulta válida;
- botón de reintento;
- distinción entre consulta completa, parcial y fallo total.

Un timeout de IRSA no se interpreta como ausencia de datos astronómicos.

---

## Ejecutar el proyecto

### Requisitos

- Node.js 22.12 o posterior
- `uv`
- Python 3.12 o posterior
- Acceso a internet para consultar IRSA

Instala dependencias:

```bash
npm ci
uv sync --project backend --python 3.13
```

### Backend

En una terminal:

```bash
uv run --project backend uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

### Frontend

En otra terminal:

```bash
npm run dev
```

Abre la URL mostrada por Vite, normalmente:

```text
http://localhost:5173
```

---

## Build de producción

```bash
npm run build
```

Para servir el frontend compilado desde FastAPI:

```bash
uv run --project backend uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Después abre:

```text
http://127.0.0.1:8000
```

---

## Controles principales

### Explorar

Puedes seleccionar:

- Estrella de Barnard
- Epsilon Indi B
- WISE 0855−0714
- RW Aurigae
- R Draconis

o introducir coordenadas ICRS en grados decimales.

### Normal

Recorre cronológicamente las imágenes disponibles.

### Blink

Alterna rápidamente dos épocas para detectar cambios visuales.

### Overlay

Superpone la observación A y B usando rojo/cian.

### Difference

Calcula una representación visual A − B.

El visor indica si la comparación es científicamente compatible o únicamente
exploratoria.

### Zoom y navegación

- Zoom: 100%–400%
- Pan con mouse o pantalla táctil
- Reset
- Pantalla completa

---

## Verificación del núcleo

El estado actual fue comprobado con:

### Backend

```bash
uv run --project backend pytest backend/tests
```

Resultado esperado actualmente:

```text
16 passed
```

### Svelte y TypeScript

```bash
npm run check
```

Resultado esperado:

```text
0 errors and 0 warnings
```

### Pruebas unitarias del frontend

```bash
npm test
```

Resultado esperado actualmente:

```text
14 passed
```

### Formato

```bash
npm run format:check
```

### Build

```bash
npm run build
```

También existen pruebas end-to-end con Playwright:

```bash
npm run test:e2e
```

---

## Vista previa local

El repositorio incluye una vista previa guardada para evitar depender completamente
de IRSA durante una demostración.

Puede regenerarse con:

```bash
PYTHONPATH=backend uv run --project backend python backend/scripts/cache_preview.py
```

Después:

```bash
npm run build
```

La vista previa debe regenerarse cuando cambie el procesamiento científico del
backend.

---

## Sistema de candidatos

El análisis automático reutiliza las mismas imágenes cargadas en el visor.

```text
frames IMAGE − ZODI alineados
        ↓
sigma clipping del fondo
        ↓
detección de fuentes compactas
        ↓
asociación espacial entre épocas
        ↓
ajuste lineal de trayectoria
        ↓
variabilidad en grupos espectralmente compatibles
        ↓
Candidate Score
        ↓
Candidate Queue
        ↓
revisión humana
```

El sistema reporta movimiento aparente, desplazamiento, linealidad, variabilidad,
número de épocas y un score de prioridad.

La asociación temporal usa emparejamiento global uno-a-uno, limita saltos entre
épocas y exige continuidad suficiente antes de promover un track. Cuando falta
una detección intermedia, el visor puede mostrar una posición predicha con marcador
cian punteado; no se confunde con una detección real.

`Candidate Score`, `SNR proxy` y `motion significance proxy` son métricas
heurísticas del prototipo. No son incertidumbres o significancias estadísticas
formales y no confirman un descubrimiento.

La siguiente etapa científica es incorporar catálogos externos, errores formales,
PSF/ePSF y validación cruzada de candidatos.

---

## Limitaciones actuales

SPHEREx Explorer todavía no realiza automáticamente:

- detección de fuentes;
- seguimiento de una fuente entre épocas;
- medición automática de desplazamiento angular;
- curvas de brillo;
- identificación automática de objetos;
- Candidate Score;
- ranking de candidatos;
- clasificación mediante inteligencia artificial;
- confirmación de descubrimientos.

Los modos Blink, Overlay y Difference son herramientas de inspección.

Una detección futura deberá utilizar únicamente pares y observaciones que cumplan
los criterios científicos apropiados.

---

## Próxima etapa

Sobre este núcleo se construirá el sistema de descubrimiento:

```text
detección de fuentes
        ↓
asociación entre épocas
        ↓
desplazamiento + variabilidad
        ↓
filtros de calidad
        ↓
Candidate Score
        ↓
Candidate Queue
        ↓
revisión humana
```

El objetivo es convertir el visor temporal en una herramienta que ayude a localizar
automáticamente fuentes interesantes dentro de las observaciones de SPHEREx.

---

## Recursos

- NASA/IPAC IRSA — SPHEREx Archive
- SPHEREx Explanatory Supplement
- SPHEREx Data Access Documentation
- SPHEREx Data Products Documentation
- SPHEREx tutorials from Caltech/IPAC

---

## Equipo

**Equipo Otarios**  
Instituto Tecnológico de La Paz  
NASA Space Apps Challenge

Proyecto independiente. No es una aplicación oficial de NASA o JPL-Caltech.
