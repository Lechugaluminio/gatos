import {
  HandLandmarker,
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// ---- calabozo: gesto -> puerta -> lo que hay al otro lado ----------------
// main_room es la sala de espera. Cada gesto abre una puerta distinta y
// muestra lo que hay detrás durante ACTION_DISPLAY_MS; luego se vuelve a
// main_room. Los nombres de archivo distinguen mayúsculas (GitHub Pages).
const GESTURE_MEMES = {
  default: ["memes/main_room.jpg"],
  Praise_the_sun: ["memes/praise_the_sun.jpg"],
  point_forward: ["memes/floor_colapse.jpg"],
  go_right: ["memes/door_locked.jpg"],
  go_left: ["memes/Dead_end.jpg"],
  peace_sign: ["memes/spider_room.jpg"],
  fist: ["memes/Bonfire_room.jpg"],
};

// texto que aparece sobre la imagen (útil para el video de la entrega)
const GESTURE_LABELS = {
  default: "Sala principal — elige una puerta",
  Praise_the_sun: "\\[T]/ Praise the Sun",
  point_forward: "Puerta del frente: ¡el suelo colapsa!",
  go_right: "Puerta derecha: está cerrada",
  go_left: "Puerta izquierda: callejón sin salida",
  peace_sign: "Segunda puerta: la sala de la araña",
  fist: "Cuarta puerta: una hoguera",
};

// cuántos fotogramas seguidos debe mantenerse un gesto antes de aceptarlo
const STABLE_FRAMES_REQUIRED = 5;
// cuánto tiempo se muestra la sala detrás de la puerta
const ACTION_DISPLAY_MS = 3000;
// espera antes de poder repetir el mismo gesto
const ACTION_COOLDOWN_MS = 2000;
// cuánto tiempo confiamos en la última posición de la cara si se pierde
const FACE_STALE_MS = 1200;

// ---- umbrales de detección (ajustar mirando el HUD) ----------------------
const FINGER_EXTENDED_MAX_DEG = 45; // ángulo máx. entre falanges para "dedo estirado"
const FIST_TIP_TO_WRIST_MAX = 1.35; // puntas cerca de la muñeca = puño (relativo al tamaño de la mano)
const PEACE_MIN_SPREAD = 0.25; // separación mínima entre índice y medio para la "V"
const OPEN_HAND_THUMB_MAX_DEG = 50; // pulgar más o menos paralelo a los dedos
const POINT_2D_MAX = 0.35; // índice "acortado" en 2D al apuntar a la cámara
const POINT_Z_MIN = 0.03; // punta del índice más cerca de la cámara que el nudillo

const video = document.getElementById("video");
const memeImg = document.getElementById("memeImg");
const memeLabel = document.getElementById("memeLabel");
const debugHud = document.getElementById("debugHud");

let handLandmarker, faceLandmarker;
let lastVideoTime = -1;
let candidateGesture = "default";
let candidateStreak = 0;
let activeAction = null; // gesto que se está mostrando, o null
let actionStartTime = 0;
let actionEndTime = 0;
let lastTriggeredGesture = null;
let isCoolingDown = false;
let currentMemeGesture = "default";
let lastFace = null; // { mouthCenter, faceWidth, t }
let lastHandDebug = "";

// precarga de imágenes para que no haya parpadeo al abrir una puerta
function preloadImages() {
  Object.values(GESTURE_MEMES)
    .flat()
    .forEach((src) => {
      const img = new Image();
      img.src = src;
    });
}

async function init() {
  setHud("Solicitando acceso a la cámara web...");
  preloadImages();
  showMeme("default");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (camErr) {
    setHud(
      "Error al acceder a la cámara:\n" +
        camErr.message +
        "\n\nPermite la cámara en el icono del candado de la barra de direcciones.",
      true
    );
    throw camErr;
  }

  setHud("Cámara conectada.\nCargando modelos de MediaPipe...");

  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );

  async function loadLandmarker(createFn, modelUrl, extraOpts = {}) {
    try {
      return await createFn(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
        runningMode: "VIDEO",
        ...extraOpts,
      });
    } catch (gpuErr) {
      console.warn("GPU no disponible, usando CPU:", gpuErr);
      return await createFn(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
        runningMode: "VIDEO",
        ...extraOpts,
      });
    }
  }

  handLandmarker = await loadLandmarker(
    (f, opts) => HandLandmarker.createFromOptions(f, opts),
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    { numHands: 2 }
  );

  faceLandmarker = await loadLandmarker(
    (f, opts) => FaceLandmarker.createFromOptions(f, opts),
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    { numFaces: 1 }
  );

  setHud("Modelos cargados. ¡Listo!");
  requestAnimationFrame(loop);
}

function setHud(text, isError = false) {
  if (!debugHud) return;
  debugHud.style.color = isError ? "#ff5555" : "#7cffa0";
  debugHud.textContent = text;
}

// ---- geometría 3D ---------------------------------------------------------
function vec(a, b) {
  return { x: b.x - a.x, y: b.y - a.y, z: (b.z || 0) - (a.z || 0) };
}
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}
function angleDeg(v1, v2) {
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const m1 = Math.hypot(v1.x, v1.y, v1.z);
  const m2 = Math.hypot(v2.x, v2.y, v2.z);
  if (m1 < 1e-9 || m2 < 1e-9) return 180;
  return (Math.acos(Math.min(1, Math.max(-1, dot / (m1 * m2)))) * 180) / Math.PI;
}

// un dedo está "estirado" si sus dos segmentos (mcp->pip, pip->tip) apuntan
// más o menos en la misma dirección
function fingerExtended(lm, mcp, pip, tip) {
  return angleDeg(vec(lm[mcp], lm[pip]), vec(lm[pip], lm[tip])) < FINGER_EXTENDED_MAX_DEG;
}

// Puntos de MediaPipe Hands: 0 muñeca, 1-4 pulgar, 5-8 índice, 9-12 medio,
// 13-16 anular, 17-20 meñique.
function classifyHand(lm) {
  const handScale = dist(lm[0], lm[9]) || 1e-6; // muñeca -> nudillo del medio

  const indexUp = fingerExtended(lm, 5, 6, 8);
  const middleUp = fingerExtended(lm, 9, 10, 12);
  const ringUp = fingerExtended(lm, 13, 14, 16);
  const pinkyUp = fingerExtended(lm, 17, 18, 20);
  const curledCount = [indexUp, middleUp, ringUp, pinkyUp].filter((v) => !v).length;

  // índice apuntando a la cámara: se ve corto en 2D y la punta está más
  // cerca de la cámara que el nudillo
  const idx2d = Math.hypot(lm[8].x - lm[5].x, lm[8].y - lm[5].y) / handScale;
  const idxZDelta = (lm[5].z || 0) - (lm[8].z || 0);
  const indexPointingAtCamera = idx2d < POINT_2D_MAX && idxZDelta > POINT_Z_MIN;

  // puño: las cuatro puntas recogidas cerca de la muñeca
  const tipsToWrist =
    [8, 12, 16, 20].reduce((acc, i) => acc + dist(lm[i], lm[0]), 0) / 4 / handScale;

  return {
    indexUp,
    middleUp,
    ringUp,
    pinkyUp,
    curledCount,
    handScale,
    indexPointingAtCamera,
    tipsToWrist,
    lm,
  };
}

function updateFace(faceResult) {
  if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
    const f = faceResult.faceLandmarks[0];
    const upperLip = f[13];
    const lowerLip = f[14];
    lastFace = {
      mouthCenter: {
        x: (upperLip.x + lowerLip.x) / 2,
        y: (upperLip.y + lowerLip.y) / 2,
        z: ((upperLip.z || 0) + (lowerLip.z || 0)) / 2,
      },
      faceWidth: dist(f[234], f[454]), // mejilla a mejilla
      t: performance.now(),
    };
  }
}

// ---- gestos ---------------------------------------------------------------
// Se revisan en este orden; gana el primero que coincide.

// 1. Praise the Sun: dos manos cerca de la cara y sobre la cabeza
function isPraiseTheSun(hands) {
  if (hands.length !== 2 || !lastFace) return false;
  if (performance.now() - lastFace.t > FACE_STALE_MS) return false;
  const { mouthCenter, faceWidth } = lastFace;
  const nearFace = hands.every((h) => dist(h.lm[9], mouthCenter) / faceWidth < 3.5);
  const headTopY = mouthCenter.y - faceWidth * 1.47;
  const bothAboveHead = hands.every((h) => h.lm[9].y < headTopY);
  return nearFace && bothAboveHead;
}

// 2. Índice apuntando a la cámara (solo el índice estirado)
function isPointForward(h) {
  return h.indexUp && !h.middleUp && !h.ringUp && !h.pinkyUp && h.indexPointingAtCamera;
}

// 3. Signo de paz: índice y medio arriba y separados en V, anular y meñique doblados
function isPeaceSign(h) {
  const { lm } = h;
  if (!(h.indexUp && h.middleUp && !h.ringUp && !h.pinkyUp)) return false;
  const pointingUp = lm[8].y < lm[5].y && lm[12].y < lm[9].y;
  const spread = Math.hypot(lm[8].x - lm[12].x, lm[8].y - lm[12].y) / h.handScale;
  return pointingUp && spread > PEACE_MIN_SPREAD;
}

// 4. Puño cerrado: los cuatro dedos doblados y las puntas recogidas
function isFist(h) {
  return h.curledCount === 4 && h.tipsToWrist < FIST_TIP_TO_WRIST_MAX;
}

// 5/6. Mano abierta en horizontal, apuntando a la derecha o a la izquierda
// de la pantalla. La imagen de la cámara se muestra en espejo, por eso se
// invierte el eje x. Devuelve "go_right", "go_left" o null.
function openHandDirection(h) {
  if (h.curledCount !== 0) return null;
  const { lm } = h;
  const vxScreen = -(lm[12].x - lm[0].x);
  const vy = lm[12].y - lm[0].y;
  const isHorizontal = Math.abs(vxScreen) > 1.2 * Math.abs(vy);
  if (!isHorizontal) return null;

  const thumbParallel = angleDeg(vec(lm[2], lm[4]), vec(lm[9], lm[12])) < OPEN_HAND_THUMB_MAX_DEG;
  if (!thumbParallel) return null;

  if (vxScreen > 0.15 * h.handScale) return "go_right";
  if (vxScreen < -0.15 * h.handScale) return "go_left";
  return null;
}

function decideGesture(handResult) {
  if (!handResult.landmarks || handResult.landmarks.length === 0) {
    lastHandDebug = "manos: 0";
    return "default";
  }

  const hands = handResult.landmarks.map(classifyHand);
  const h0 = hands[0];
  const mark = (v) => (v ? "↑" : "·");
  lastHandDebug =
    `manos: ${hands.length}  dedos I${mark(h0.indexUp)} M${mark(h0.middleUp)} ` +
    `A${mark(h0.ringUp)} Me${mark(h0.pinkyUp)}  puño ${h0.tipsToWrist.toFixed(2)} (<${FIST_TIP_TO_WRIST_MAX})`;

  if (isPraiseTheSun(hands)) return "Praise_the_sun";

  for (const h of hands) {
    if (isPointForward(h)) return "point_forward";
    if (isPeaceSign(h)) return "peace_sign";
    if (isFist(h)) return "fist";
    const dir = openHandDirection(h);
    if (dir) return dir;
  }

  return "default";
}

// ---- mostrar sala ---------------------------------------------------------
function pickImage(gesture) {
  const images = GESTURE_MEMES[gesture];
  return images[Math.floor(Math.random() * images.length)];
}

function showMeme(gesture) {
  currentMemeGesture = gesture;
  memeImg.src = pickImage(gesture);
  if (memeLabel) memeLabel.textContent = GESTURE_LABELS[gesture] || "";
}

function loop() {
  const now = performance.now();
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;

    const handResult = handLandmarker.detectForVideo(video, now);
    const faceResult = faceLandmarker.detectForVideo(video, now);
    updateFace(faceResult);

    const gesture = decideGesture(handResult);

    // anti-parpadeo: el gesto debe mantenerse varios fotogramas seguidos
    if (gesture === candidateGesture) {
      candidateStreak++;
    } else {
      candidateGesture = gesture;
      candidateStreak = 1;
    }

    // 1. terminó el tiempo de la sala detrás de la puerta
    if (activeAction !== null && now - actionStartTime >= ACTION_DISPLAY_MS) {
      activeAction = null;
      actionEndTime = now;
      isCoolingDown = true;
      showMeme("default");
    }

    // 2. terminó la espera anti-repetición
    if (isCoolingDown && now - actionEndTime >= ACTION_COOLDOWN_MS) {
      isCoolingDown = false;
    }

    // 3. procesar el gesto cuando ya es estable
    if (candidateStreak >= STABLE_FRAMES_REQUIRED) {
      const stableGesture = candidateGesture;

      if (stableGesture === "default") {
        // volvió a la postura neutra: se puede repetir el último gesto
        if (!isCoolingDown) lastTriggeredGesture = null;
        if (activeAction === null && currentMemeGesture !== "default") {
          showMeme("default");
        }
      } else {
        const inCooldown = isCoolingDown && stableGesture === lastTriggeredGesture;
        const alreadyActive = activeAction !== null;
        const isSameUnreleased =
          stableGesture === lastTriggeredGesture && !isCoolingDown && activeAction === null;

        if (!alreadyActive && !inCooldown && !isSameUnreleased) {
          activeAction = stableGesture;
          lastTriggeredGesture = stableGesture;
          actionStartTime = now;
          showMeme(stableGesture);
        }
      }
    }

    updateDebugHud(now);
  }
  requestAnimationFrame(loop);
}

function updateDebugHud(now) {
  if (!debugHud) return;
  let statusText = "espera (main_room)";
  if (activeAction !== null) {
    const remaining = Math.max(0, (ACTION_DISPLAY_MS - (now - actionStartTime)) / 1000).toFixed(1);
    statusText = `${activeAction} (${remaining}s)`;
  } else if (isCoolingDown) {
    const cdRemaining = Math.max(0, (ACTION_COOLDOWN_MS - (now - actionEndTime)) / 1000).toFixed(1);
    statusText = `cooldown ${lastTriggeredGesture} (${cdRemaining}s)`;
  }
  debugHud.textContent =
    `detectado: ${candidateGesture}\n` + `pantalla: ${statusText}\n` + lastHandDebug;
}

init().catch((err) => {
  console.error("Error al inicializar:", err);
  setHud(
    "Error al iniciar:\n" +
      (err.message || err) +
      "\n\nVerifica los permisos de cámara y la conexión a internet.",
    true
  );
});
