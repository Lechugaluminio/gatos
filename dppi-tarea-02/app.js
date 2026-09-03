import {
  HandLandmarker,
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

// ---- meme mapping -----------------------------------------------------
// Each gesture maps to one or more meme images. When a gesture has more
// than one image, one is picked at random each time the gesture is newly
// (re)triggered, so repeated gestures don't always show the same frame.
const GESTURE_MEMES = {
  default: ["memes/main_room.jpg"],
  Praise_the_sun: ["memes/praise_the_sun.jpg"],
  point_forward: ["memes/floor_colapse.jpg"],
  go_right: ["memes/door_locked.jpg"],
  go_left: ["memes/dead_end"],
  second_door: ["memes/spider_room"],
fourth_door:["memes/Bonfire_room"]
};

// how many consecutive frames a gesture must hold before we switch to it
const STABLE_FRAMES_REQUIRED = 5;
// action display duration: 3.0 seconds
const ACTION_DISPLAY_MS = 3000;
// anti-repetition cooldown duration: 2.0 seconds
const ACTION_COOLDOWN_MS = 2000;
// how long we trust a stale face box after the face detector loses the face
// (e.g. hand covering the mouth during a shush)
const FACE_STALE_MS = 1200;

// how far the head has to turn (yaw, in degrees, from MediaPipe's own head
// pose estimate - not a hand-rolled distance heuristic) to count as a
// side-eye look. Watch the live debug HUD in the camera pane while turning
// your head to find the right value for you.
const SIDE_EYE_YAW_DEG = 15.0;

// hand-covering-face: how close the hand needs to be to where the mouth
// last was. Wider when the face detector has fully lost the face (strong
// evidence of a real occlusion); tighter when the face is still partially
// tracked (weaker evidence, avoid false positives from a hand just passing
// near the face).
const HAND_COVER_FACE_DIST_FACE_LOST = 1.3;
const HAND_COVER_FACE_DIST_FACE_SEEN = 0.7;

const video = document.getElementById("video");
const memeImg = document.getElementById("memeImg");
const debugHud = document.getElementById("debugHud");

let handLandmarker, faceLandmarker;
let lastVideoTime = -1;
let candidateGesture = "default";
let candidateStreak = 0;
let activeAction = null; // currently displaying action gesture name, or null
let actionStartTime = 0;
let actionEndTime = 0;
let lastTriggeredGesture = null; // for cooldown tracking
let isCoolingDown = false;
let currentMemeGesture = "default";
let lastFace = null; // { mouthCenter, faceWidth, mouthOpen, yawDeg, t }
let lastFaceSeenThisFrame = false;
let lastYawDebug = 0;

async function init() {
  if (debugHud) {
    debugHud.style.color = "#7cffa0";
    debugHud.textContent = "Solicitando acceso a la cámara web...";
  }

  // 1. Iniciar cámara de inmediato para que el usuario vea su imagen de una vez
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (camErr) {
    if (debugHud) {
      debugHud.style.color = "#ff5555";
      debugHud.textContent = "Error al acceder a la cámara:\n" + camErr.message + "\n\nPor favor, permite el permiso de cámara en el icono del candado en la barra de direcciones.";
    }
    throw camErr;
  }

  if (debugHud) {
    debugHud.textContent = "Cámara conectada.\nCargando librerías y modelos de IA...";
  }

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
      console.warn("GPU delegate no disponible, usando CPU:", gpuErr);
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
    { numFaces: 1, outputFacialTransformationMatrixes: true }
  );

  if (debugHud) {
    debugHud.textContent = "Modelos cargados con éxito. Listo!";
  }

  requestAnimationFrame(loop);
}

// ---- 3D-aware geometry helpers -----------------------------------------
// Using z (depth) as well as x/y makes these tests far more robust to hand
// rotation, foreshortening, and motion blur than a plain 2D/wrist-distance
// check would be.
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

// a finger is "extended" if its two segments (mcp->pip, pip->tip) point in
// roughly the same direction; "curled" if it folds back sharply.
function fingerExtended(lm, mcp, pip, tip) {
  const angle = angleDeg(vec(lm[mcp], lm[pip]), vec(lm[pip], lm[tip]));
  return angle < 45;
}

// extract the head's left/right turn angle (yaw, degrees) from MediaPipe's
// facial transformation matrix - its own estimate of head pose, far more
// robust than trying to infer turn from landmark distances.
function yawFromTransformMatrix(matrixData) {
  // matrixData is a 16-element row-major 4x4 array; r(row, col) = data[row*4+col]
  const r00 = matrixData[0];
  const r10 = matrixData[4];
  const r20 = matrixData[8];
  const sy = Math.hypot(r00, r10);
  if (sy < 1e-6) return 0;
  return (Math.atan2(-r20, sy) * 180) / Math.PI;
}

function classifyHand(lm) {
  const handScale = dist(lm[0], lm[9]) || 1e-6; // wrist -> middle mcp

  const indexUp = fingerExtended(lm, 5, 6, 8);
  const middleUp = fingerExtended(lm, 9, 10, 12);
  const ringUp = fingerExtended(lm, 13, 14, 16);
  const pinkyUp = fingerExtended(lm, 17, 18, 20);

  // thumb + pinky spread apart from each other = shaka/rock-on shape.
  // tucked thumb sits close to the pinky-side of the palm; an abducted
  // thumb sticks straight out and this distance grows a lot.
  const thumbPinkySpread = dist(lm[4], lm[17]) / handScale;
  const thumbOut = thumbPinkySpread > 1.05;

  const curledCount = [indexUp, middleUp, ringUp, pinkyUp].filter((v) => !v).length;

  // foreshortening: when the index finger points straight at the camera,
  // the 2D (x,y) distance between MCP (lm[5]) and TIP (lm[8]) appears
  // much shorter than the actual finger length. We compare it to handScale.
  // Also, the z of the tip should be clearly negative (closer to camera)
  // relative to the MCP base.
  const idx2dDist = Math.hypot(lm[8].x - lm[5].x, lm[8].y - lm[5].y) / handScale;
  const idxZDelta = (lm[5].z || 0) - (lm[8].z || 0); // positive = tip closer to camera
  const indexPointingAtCamera = idx2dDist < 0.35 && idxZDelta > 0.03;

  return {
    indexUp,
    middleUp,
    ringUp,
    pinkyUp,
    thumbOut,
    curledCount,
    handScale,
    indexTip: lm[8],
    middleTip: lm[12],
    pinkyTip: lm[20],
    thumbTip: lm[4],
    thumbBase: lm[2],
    wrist: lm[0],
    palmCenter: lm[9],
    indexPointingAtCamera,
  };
}

function updateFace(faceResult) {
  const now = performance.now();
  const sawFace = !!(faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0);

  if (sawFace) {
    const f = faceResult.faceLandmarks[0];
    const upperLip = f[13];
    const lowerLip = f[14];
    const rightCheek = f[234];
    const leftCheek = f[454];
    const mouthCenter = {
      x: (upperLip.x + lowerLip.x) / 2,
      y: (upperLip.y + lowerLip.y) / 2,
      z: ((upperLip.z || 0) + (lowerLip.z || 0)) / 2,
    };
    const faceWidth = dist(rightCheek, leftCheek);
    // how open the mouth is right now - normalized so it doesn't depend on
    // distance from the camera.
    const mouthOpen = dist(upperLip, lowerLip) / faceWidth;

    let yawDeg = 0;
    if (faceResult.facialTransformationMatrixes && faceResult.facialTransformationMatrixes.length > 0) {
      yawDeg = yawFromTransformMatrix(faceResult.facialTransformationMatrixes[0].data);
    }

    lastFace = { mouthCenter, faceWidth, mouthOpen, yawDeg, t: now };
    lastYawDebug = yawDeg;
  }
  lastFaceSeenThisFrame = sawFace;
}

// a hand is "pointing" if only the index finger is extended (thumb can be
// either way) - the shape both hands make in the finger-tips-touching pose.
function isPointing(h) {
  return h.indexUp && !h.middleUp && !h.ringUp && !h.pinkyUp;
}

function decideGesture(handResult) {
  const now = performance.now();
  const faceIsFresh = !!lastFace && now - lastFace.t < FACE_STALE_MS;

  if (!handResult.landmarks || handResult.landmarks.length === 0) {
    return "default";
  }

  const hands = handResult.landmarks.map(classifyHand);

  if (hands.length === 2) {
    if (faceIsFresh) {
      const { mouthCenter, faceWidth } = lastFace;
      const nearFace = hands.every(
        (h) => dist(h.palmCenter, mouthCenter) / faceWidth < 3.5
      );
      if (nearFace) {
        const headTopY = mouthCenter.y - faceWidth * 1.47;
        const bothAboveHead = hands.every((h) => h.palmCenter.y < headTopY);
        if (bothAboveHead) {
          return "Praise_the_sun";
        }
      }
    }
  }

  const h = hands[0];

  // point_forward: right hand, only index extended, pointing straight at
  // the camera.
  if (h.indexUp && !h.middleUp && !h.ringUp && !h.pinkyUp && h.indexPointingAtCamera) {
    const handedness = handResult.handednesses && handResult.handednesses[0];
    const isRightHand =
      handedness &&
      handedness.length > 0 &&
      handedness[0].categoryName === "Right";
    if (isRightHand) {
      return "point_forward";
    }
  }

  // go_right: Right hand open with palm open towards the camera,
  // fingers stretched out horizontally away from the center of the screen.
  // Thumb and fingers parallel.
  if (h.curledCount === 0) {
    const vxScreen = -(h.middleTip.x - h.wrist.x);
    const vy = h.middleTip.y - h.wrist.y;
    const isHorizontal = Math.abs(vxScreen) > 1.2 * Math.abs(vy);
    const pointingRight = vxScreen > 0.15 * h.handScale;

    const thumbVec = vec(h.thumbBase, h.thumbTip);
    const fingerVec = vec(h.palmCenter, h.middleTip);
    const thumbParallel = angleDeg(thumbVec, fingerVec) < 42 && !h.thumbOut;

    const handedness = handResult.handednesses && handResult.handednesses[0];
    const isRightHand =
      (handedness && handedness.length > 0 && handedness[0].categoryName === "Right") ||
      (h.thumbTip.y < h.pinkyTip.y);

    if (isHorizontal && pointingRight && thumbParallel && isRightHand) {
      return "locked_door";
    }
  }
 // go_left: left hand open with palm open towards the camera,
  // fingers stretched out horizontally away from the center of the screen.
  // Thumb and fingers parallel.
 / go_left: Left hand open with palm towards camera, pointing left
  if (h.curledCount === 0) {
    const vxScreen = -(h.middleTip.x - h.wrist.x);
    const vy = h.middleTip.y - h.wrist.y;
    // La línea horizontal se mantiene siempre positiva (Math.abs)
    const isHorizontal = Math.abs(vxScreen) > 1.2 * Math.abs(vy);
    // Para apuntar a la izquierda, vxScreen debe ser negativo
    const pointingLeft = vxScreen < -0.15 * h.handScale;

    const thumbVec = vec(h.thumbBase, h.thumbTip);
    const fingerVec = vec(h.palmCenter, h.middleTip);
    // Los grados nunca son negativos, se mantiene 42
    const thumbParallel = angleDeg(thumbVec, fingerVec) < 42 && !h.thumbOut;

    const handedness = handResult.handednesses && handResult.handednesses[0];
    const isLeftHand =
      (handedness && handedness.length > 0 && handedness[0].categoryName === "Left");

    if (isHorizontal && pointingLeft && thumbParallel && isLeftHand) {
      return "go_left"; 
    }
  }

  // Si ninguna de las reglas anteriores se cumplió, volvemos a default
  return "default";
}

function pickImage(gesture) {
  const images = GESTURE_MEMES[gesture];
  return images[Math.floor(Math.random() * images.length)];
}

function showMeme(gesture) {
  currentMemeGesture = gesture;
  memeImg.src = pickImage(gesture);
}

function loop() {
  const now = performance.now();
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const ts = performance.now();

    const handResult = handLandmarker.detectForVideo(video, ts);
    const faceResult = faceLandmarker.detectForVideo(video, ts);
    updateFace(faceResult);

    const gesture = decideGesture(handResult);

    // debounce: require a gesture to be seen for several consecutive
    // frames before we commit to it, to avoid flicker between frames
    if (gesture === candidateGesture) {
      candidateStreak++;
    } else {
      candidateGesture = gesture;
      candidateStreak = 1;
    }

    // 1. Check if the 3-second action display has expired
    if (activeAction !== null) {
      if (now - actionStartTime >= ACTION_DISPLAY_MS) {
        activeAction = null;
        actionEndTime = now;
        isCoolingDown = true;
        showMeme("default");
      }
    }

    // 2. Check if the 2-second anti-repetition cooldown has expired
    if (isCoolingDown && now - actionEndTime >= ACTION_COOLDOWN_MS) {
      isCoolingDown = false;
    }

    // 3. Process candidate gesture once stable
    if (candidateStreak >= STABLE_FRAMES_REQUIRED) {
      const stableGesture = candidateGesture;

      if (stableGesture === "default") {
        // User returned to neutral/standby posture
        if (!isCoolingDown) {
          lastTriggeredGesture = null;
        }
        if (activeAction === null && currentMemeGesture !== "default") {
          showMeme("default");
        }
      } else {
        // User is performing an action gesture (e.g. Praise_the_sun)
        const inCooldown = isCoolingDown && (stableGesture === lastTriggeredGesture);
        const alreadyActive = (activeAction !== null);
        const isSameUnreleased = (stableGesture === lastTriggeredGesture && !isCoolingDown && activeAction === null);

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
    `detectado: ${candidateGesture}\n` +
    `pantalla: ${statusText}\n` +
    `yaw: ${lastYawDebug >= 0 ? "+" : ""}${lastYawDebug.toFixed(1)} deg  (side-eye thr +/-${SIDE_EYE_YAW_DEG.toFixed(1)})`;
}

init().catch((err) => {
  console.error("Error al inicializar:", err);
  if (debugHud) {
    debugHud.style.color = "#ff5555";
    debugHud.textContent = "Error al iniciar:\n" + (err.message || err) + "\n\nVerifica los permisos de cámara y la conexión a internet.";
  }
});
