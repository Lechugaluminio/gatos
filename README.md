# Calabozo de los gatos — tarea 02

**DIS9087 · Dispositivos Periféricos y Plataformas para la Interacción Digital (DPPI) · Diseño UDP**
Daniel Victoriano

🔗 **Sitio:** https://lechugaluminio.github.io/gatos/dppi-tarea-02/
🎥 **Video:** [`video/Prueba mediapipe.mp4`](video/Prueba%20mediapipe.mp4)
🐱 **Repositorio base:** [fefeliperoar/gatos](https://github.com/fefeliperoar/gatos) (Meowmeow cat cam meme detector)

---

## Idea

El proyecto original usa MediaPipe para reconocer gestos con la webcam y responder con un meme de gato. En esta versión el mismo sistema sirve para **recorrer un calabozo al estilo Dark Souls**: el personaje está en la sala principal y cada gesto abre una puerta distinta. Detrás de cada puerta hay algo diferente: una trampa, una araña, una hoguera, un callejón sin salida…

La pantalla se divide en dos:
- **Izquierda:** la cámara (en espejo) con un panel de depuración en verde.
- **Derecha:** la sala en la que está el personaje, con un texto que dice qué puerta se abrió.

Cada sala se muestra 3 segundos y luego el personaje vuelve a la **sala principal** (`main_room`).

## Gestos

Se revisan en este orden; si una pose calza con más de uno, gana el primero.

| # | Gesto | Cómo hacerlo | Puerta → lo que hay detrás | Imagen |
|---|---|---|---|---|
| — | *(sin gesto)* | Manos abajo o fuera de cámara | Sala principal | `main_room.jpg` |
| 1 | **Praise the Sun** | Las dos manos arriba, sobre la cabeza | \[T]/ Praise the Sun | `praise_the_sun.jpg` |
| 2 | **Apuntar al frente** | Solo el índice estirado, apuntando directo a la cámara | Puerta del frente: el suelo colapsa (trampa) | `floor_colapse.jpg` |
| 3 | **Signo de paz ✌️** | Índice y medio arriba, separados en V; anular y meñique doblados | Segunda puerta: la sala de la araña | `spider_room.jpg` |
| 4 | **Puño cerrado ✊** | Los cuatro dedos doblados | Cuarta puerta: una hoguera | `Bonfire_room.jpg` |
| 5 | **Mano a la derecha** | Mano abierta en horizontal, dedos apuntando a la derecha de la pantalla, pulgar junto a los dedos | Puerta derecha: está cerrada | `door_locked.jpg` |
| 6 | **Mano a la izquierda** | Lo mismo, apuntando a la izquierda de la pantalla | Puerta izquierda: callejón sin salida | `Dead_end.jpg` |

**Gestos que se repiten del proyecto original (máximo 2):**
- *Praise the Sun* ← "Devo cat" (dos manos sobre la cabeza)
- *Puño cerrado* ← "I will punch you" (cuatro dedos doblados)

Los otros cuatro son nuevos o cambian la detección: el índice ahora tiene que apuntar **hacia la cámara** (en el original se levantaba lejos de la cara), el signo de paz no existía, y la mano abierta ahora distingue **dirección** (derecha / izquierda) en lugar de solo "palma abierta".

## Cambios respecto al repositorio original

**Concepto e imágenes**
- Los memes de gatos se reemplazaron por 7 salas de un calabozo en `dppi-tarea-02/memes/`.
- Los gestos son ahora "puertas" y cada imagen lleva un texto con lo que encontró el personaje.

**Detección (`dppi-tarea-02/app.js`)**
- Se escribieron los gestos nuevos: apuntar a la cámara (por escorzo: el índice se ve corto en 2D y la punta está más cerca que el nudillo), signo de paz, puño y mano abierta con dirección.
- La mano izquierda/derecha se decide por la **dirección en pantalla**, no por la etiqueta "Left/Right" de MediaPipe, que salía invertida porque el navegador analiza la imagen sin espejar.
- Se revisan **todas las manos** visibles, no solo la primera.
- Los umbrales quedaron agrupados al inicio del archivo para ajustarlos fácilmente.
- Se quitaron gestos y cálculos que ya no se usaban (side-eye, mano tapando la cara, etc.).

**Correcciones**
- Se arreglaron errores de sintaxis que impedían que la página cargara.
- Rutas de imágenes con extensión y mayúsculas correctas (GitHub Pages distingue mayúsculas).
- `go_right` devolvía un nombre (`locked_door`) que no tenía imagen asignada.
- Se quitó el `alert()` de prueba de la cámara.
- El video ya no tiene un tamaño fijo de 640×480 y llena su mitad de la pantalla.
- Las imágenes se precargan para que no haya parpadeo al cambiar de sala.

**Interfaz**
- Texto con estilo de juego sobre cada sala.
- Panel de depuración en español: gesto detectado, estado (sala activa o espera) y qué dedos ve el sistema.

## Cómo funciona

1. **MediaPipe Hand Landmarker** detecta hasta 2 manos (21 puntos con profundidad) y **Face Landmarker** ubica la cara, que se usa para saber dónde está "sobre la cabeza".
2. Para cada mano se calcula qué dedos están estirados (ángulo entre falanges), si las puntas están recogidas (puño) y hacia dónde apunta.
3. Un gesto tiene que mantenerse **5 fotogramas seguidos** para contar, así no parpadea.
4. La sala se muestra **3 s**; después hay **2 s** de espera antes de poder repetir el mismo gesto, y hay que bajar la mano para volver a activarlo.

## Cómo ejecutarlo

**En línea:** abre el sitio y permite el acceso a la cámara.

**Local:** la cámara solo funciona por HTTP (no abriendo el archivo directo). Desde `dppi-tarea-02/`:

```bash
python serve.py
```

y abre `http://localhost:8000`. Los modelos de MediaPipe se cargan desde internet.

> `gesture_meme.py` (versión de escritorio con OpenCV) quedó de la primera etapa del proyecto y no tiene los 6 gestos nuevos; la versión entregada es la del navegador.

## Estructura

```
README.md                  este archivo
video/                     video de demostración con los 6 gestos
dppi-tarea-02/
  index.html               interfaz (cámara | sala)
  app.js                   detección de gestos y lógica del calabozo
  serve.py                 servidor local para probar con cámara
  memes/                   imágenes de las salas
  gesture_meme.py          versión de escritorio (etapa anterior)
  models/                  modelos de MediaPipe para la versión de escritorio
```

## Reflexión

Me parece muy interesante el potencial interactivo de MediaPipe, aunque tenga sus limitaciones para leer puntos que resultan superpuestos. Trabajar con IA salva muchas de las frustraciones de mi experiencia pasada intentando aprender a programar. Noto que la app funciona mejor si se usan gestos suficientemente diferentes entre sí para evitar lecturas equivocadas.
