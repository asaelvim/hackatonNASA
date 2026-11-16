# SPHEREx Explorer

Desarrollado por el **equipo Otarios**, del **Instituto Tecnológico de La Paz**,
para NASA Space Apps Challenge.

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

Al abrir la región inicial de Barnard se consulta el archivo y se muestra una
animación de espera con el progreso de preparación. Las imágenes disponibles
aparecen juntas, ordenadas por fecha, cuando termina la carga; no se presentan
resultados intermedios. Si la consulta falla, hay dos observaciones reales
guardadas como respaldo, identificadas como **vista previa guardada**, con sus
fechas originales y los enlaces FITS de procedencia.

Para otras coordenadas, campos de visión o detectores, la primera imagen depende
de IRSA: no se muestra la vista de Barnard como si perteneciera a otra región.
Con dos imágenes comienza la reproducción automática, salvo que el navegador
indique movimiento reducido o que el usuario haya pausado la reproducción.
Si IRSA falla, se muestra el error y, cuando existe, permanece la vista previa
real claramente etiquetada; no se sustituye la respuesta por una animación sintética.

Selecciona Barnard, Epsilon Indi B, WISE 0855, RW Aurigae o R Draconis, o introduce
ascensión recta y declinación ICRS **en grados decimales**. El campo de visión
abarca entre 1 y 30 minutos de arco; los ejemplos comienzan con 12′ para dejar
margen al movimiento respecto de las coordenadas de referencia.

Pulsa **Explorar región**. La API consulta las colecciones Wide Survey
`spherex_dr1` y `spherex_qr3`, conserva las fechas de las exposiciones, selecciona
el detector y descarga los recortes de todas las observaciones encontradas,
sin muestrear la serie ni limitarla a 12 imágenes. La primera carga puede tardar
más en regiones con muchas observaciones; las siguientes reutilizan la caché.
No utiliza el cubo combinado del cielo para simular épocas.
Las consultas truncadas y las imágenes que no pudieron cargarse se notifican.
Puedes cancelar la descarga sin perder la última serie disponible; los resultados
intermedios de la nueva consulta se descartan.

Las imágenes se reproyectan con WCS e interpolación bilineal a una cuadrícula TAN
común, con norte arriba, este a la izquierda y escala próxima a 6.2″/píxel. Los
valores de brillo se transmiten como float32 little-endian codificado en base64,
con compresión HTTP. Canvas aplica un contraste común a la serie, sin normalizar
cada exposición por separado.

Puedes reproducir la serie, seleccionar fechas, alternar imágenes, superponer la
imagen actual en rojo y la referencia en cian o visualizar su diferencia
(actual menos referencia: positivo en rojo, negativo en azul).
Por defecto se muestra un visor. El icono de doble visor, en la esquina superior
derecha del encabezado de **Visor 1**, activa un segundo panel; cada visor tiene
su propio selector de modo. La reproducción, el contraste,
el zoom y el desplazamiento son compartidos. En móviles se apilan verticalmente.
Los controles de reproducción, avance y retroceso están centrados debajo de la
línea de tiempo, con el contador de frames a la izquierda y la velocidad a la derecha.
Cada visor tiene su propia referencia, inicialmente la segunda observación.
El selector **Referencia** aparece junto al modo de ese visor solamente al alternar
imágenes, superponer o mostrar diferencias. **Usar imagen actual** selecciona la
observación actual de la línea de tiempo como referencia de ese visor.
El botón **?** del encabezado permite consultar una explicación breve del modo de
comparación sin mantener más texto visible sobre las imágenes.
Al pasar el cursor sobre una imagen, las etiquetas de fecha, orientación, escala
y notas desaparecen de ambos visores. Solo las imágenes conservan su brillo;
el resto de la interfaz, incluidos los márgenes alrededor de las imágenes,
se oscurece ligeramente.
Las etiquetas vuelven al retirar el cursor. Sobre la imagen, el cursor se oculta después
de dos segundos sin movimiento; vuelve al moverlo y permanece visible sobre
los controles o mientras arrastras la imagen.
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
Los recortes preparados se guardan en una caché persistente SQLite de hasta
128 MiB de datos, compartida entre reinicios y procesos locales. Se descartan
primero los recortes menos usados recientemente. Por defecto está en
`$XDG_CACHE_HOME/spherex-explorer` o `~/.cache/spherex-explorer`; puedes cambiar
el directorio con `SPHEREX_CACHE_DIR`. La clave incluye la observación, las
coordenadas, el campo de visión y la versión de procesamiento; cambia esta
versión si modificas la preparación científica de los recortes.
Las descargas reutilizan conexiones HTTP y el visor prepara hasta dos
observaciones a la vez. La consulta del catálogo sigue dependiendo de IRSA.
La vista previa local es una muestra de dos exposiciones, no un archivo completo
ni una garantía de descubrimiento. Para regenerarla con datos del archivo y
volver a compilar el frontend:

```bash
PYTHONPATH=backend uv run --project backend python backend/scripts/cache_preview.py
npm run build
```

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
