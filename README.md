# SPHEREx Explorer

Visor público de observaciones reales de SPHEREx: **Svelte + TypeScript + Vite**
para los controles, **Canvas** para las imágenes y **FastAPI + Astropy + NumPy +
SciPy** para consultar NASA/IPAC IRSA y alinear recortes FITS.

## Ejecutar

Necesitas Node.js 22.12 o posterior, [uv](https://docs.astral.sh/uv/) y acceso a
internet para consultar IRSA.

```bash
npm ci
uv sync --project backend --python 3.13
```

En una terminal, inicia la API:

```bash
uv run --project backend uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

En otra, inicia el frontend:

```bash
npm run dev
```

Abre la URL que indica Vite, normalmente `http://localhost:5173`.
El frontend utiliza `/api`; Vite dirige esas peticiones a la API local.

Para servir la versión compilada desde FastAPI, sin servidor Vite:

```bash
npm run build
uv run --project backend uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

Abre `http://127.0.0.1:8000`. Esta configuración es local; antes de exponerla
públicamente hacen falta HTTPS, límites de solicitudes y de trabajos concurrentes,
y una política de caché para las descargas.

## Explorar

Selecciona Barnard, Epsilon Indi B, WISE 0855, RW Aurigae o R Draconis, o introduce
ascensión recta y declinación ICRS **en grados decimales**. El campo de visión
abarca entre 1 y 30 minutos de arco; los ejemplos comienzan con 12′ para dejar
margen al movimiento respecto de las coordenadas de referencia.

Pulsa **Explorar región**. La API consulta las colecciones Wide Survey
`spherex_dr1` y `spherex_qr3`, conserva las fechas de las exposiciones, selecciona
el detector y descarga hasta 12 recortes distribuidos sobre el intervalo
encontrado. No utiliza el cubo combinado del cielo para simular épocas.
Las consultas truncadas y las imágenes que no pudieron cargarse se notifican.

Las imágenes se reproyectan con WCS e interpolación bilineal a una cuadrícula TAN
común, con norte arriba, este a la izquierda y escala próxima a 6.2″/píxel. Los
valores de brillo se transmiten como float32 little-endian codificado en base64,
con compresión HTTP. Canvas aplica un contraste común a la serie, sin normalizar
cada exposición por separado.

Puedes reproducir la serie, seleccionar fechas, alternar A/B, superponer A en rojo
y B en cian o visualizar A − B (positivo en rojo, negativo en azul).
**Compartir** copia la región con coordenadas, detector y campo de visión:

```text
http://localhost:5173/?ra=269.452083&dec=4.693364&fov=12&detector=1
```

El enlace vuelve a consultar el archivo; no conserva una selección inmutable de
observaciones, contraste o modo de comparación.

## Límites científicos del MVP

- Un detector **no equivale a una única banda espectral**. Los filtros varían con
  la posición en el detector. Se muestra la longitud de onda central en las
  coordenadas consultadas para cada exposición; no describe todo el recorte.
- El fondo zodiacal de `IMAGE` no se sustrae. Las diferencias no corrigen PSF,
  respuesta espectral o ruido, ni incluyen significancia estadística. Son una
  ayuda visual, **no una detección confirmada** ni una curva de luminosidad.
- Los píxeles sin cobertura se muestran oscuros, no como mediciones de brillo
  cero. La máscara opcional excluye cualquier píxel de entrada con banderas que
  contribuya a la interpolación; algunas banderas son informativas. El porcentaje
  marcado se calcula entre los píxeles de salida con datos finitos.
- Las coordenadas de los ejemplos son referencias, no posiciones propagadas a
  la fecha de cada exposición. Barnard requiere un campo amplio. No hay todavía
  corrección de movimiento propio, fotometría subpíxel o apilado por trayectoria.
- Epsilon Indi B no se resuelve como dos componentes en este visor. Recuperar
  una región de WISE 0855 tampoco demuestra que la fuente sea detectable.
- El MVP no incluye búsqueda por nombre libre, Gaia/WISE, espectros, anotaciones
  ni exportación de vídeo. Los cinco nombres disponibles son ejemplos precargados.

IRSA se consulta de nuevo en cada búsqueda, sin fijar una lista local de imágenes.
Los recortes preparados tienen una caché de hasta 16 entradas por proceso.
Las descargas tienen límites de tamaño y hasta tres intentos ante fallos
transitorios; los errores definitivos se muestran, nunca se sustituyen por datos
sintéticos.

## Verificación

```bash
npm run check
npm test
npm run format:check
npm run build
uv run --project backend pytest -q backend/tests
uv run --project backend ruff check backend
uv run --project backend ruff format --check backend
```

Las pruebas de navegador usan respuestas sintéticas **solo dentro de los tests**,
para comprobar reproducción, Canvas, comparación, errores y cancelación sin
depender del servicio remoto:

```bash
npx playwright install chromium
npm run test:e2e
```

Si ya tienes Chromium instalado:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

Para comprobar el acceso real a las cinco regiones y preparar dos épocas de cada
una (requiere internet y puede tardar):

```bash
PYTHONPATH=backend uv run --project backend python backend/scripts/check_irsa.py
```

Esta comprobación se ejecutó con éxito en noviembre de 2026; verifica recuperación
y reproyección de datos, no el movimiento o la variabilidad de las fuentes.

## Recursos

- [Archivo SPHEREx en IRSA](https://irsa.ipac.caltech.edu/Missions/spherex.html)
- [Acceso SIA2 y recortes FITS](https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-access/)
- [Productos, detectores y limitaciones](https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-products/)
- [Tutoriales oficiales](https://caltech-ipac.github.io/irsa-tutorials/spherex/)

Proyecto independiente para NASA Space Apps Challenge; no es una aplicación
oficial de NASA. `IRSA_colab.ipynb` es el notebook existente y se conserva intacto.
