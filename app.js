import {
  FilesetResolver,
  HandLandmarker,
  DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const video = document.getElementById("webcam");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const videoWrap = document.getElementById("videoWrap");
const touchPad = document.getElementById("touchPad");

const offlineBadge = document.getElementById("offlineBadge");
const wsBadge = document.getElementById("wsBadge");
const wsDot = document.getElementById("wsDot");
const handStatus = document.getElementById("handStatus");
const fpsLabel = document.getElementById("fpsLabel");
const handBadge = document.getElementById("handBadge");

const btnStartCam = document.getElementById("btnStartCam");
const btnFlipCam = document.getElementById("btnFlipCam");
const btnHoldActive = document.getElementById("btnHoldActive");
const chkLatchMode = document.getElementById("chkLatchMode");
const chkMirrorView = document.getElementById("chkMirrorView");
const rngAlpha = document.getElementById("rngAlpha");
const rngDeadband = document.getElementById("rngDeadband");
const lblAlpha = document.getElementById("lblAlpha");
const lblDeadband = document.getElementById("lblDeadband");

const valM1 = document.getElementById("valM1");
const openBar = document.getElementById("openBar");
const openPctText = document.getElementById("openPctText");
const btnCalOpen = document.getElementById("btnCalOpen");
const btnCalClosed = document.getElementById("btnCalClosed");
const selMotionMode = document.getElementById("selMotionMode");

// PID Analiz elemanları
const pidChart = document.getElementById("pidChart");
const pidCtx = pidChart.getContext("2d");
const pidSpEl = document.getElementById("pidSp");
const pidActEl = document.getElementById("pidAct");
const pidErrEl = document.getElementById("pidErr");
const pidOsEl = document.getElementById("pidOs");
const pidSettleEl = document.getElementById("pidSettle");
const inpKp = document.getElementById("inpKp");
const inpKi = document.getElementById("inpKi");
const inpKd = document.getElementById("inpKd");
const inpMaxPwm = document.getElementById("inpMaxPwm");
const btnApplyPid = document.getElementById("btnApplyPid");
const btnStepTest = document.getElementById("btnStepTest");
const btnStepTestNeg = document.getElementById("btnStepTestNeg");
const btnExportCsv = document.getElementById("btnExportCsv");
const btnClearPlot = document.getElementById("btnClearPlot");

// Manuel ve kalibrasyon elemanları
const wsUrlInput = document.getElementById("wsUrlInput");
const btnConnectWs = document.getElementById("btnConnectWs");
const btnTrustCert = document.getElementById("btnTrustCert");
const chkInvert = document.getElementById("chkInvert");
const inpGain = document.getElementById("inpGain");
const manRange0 = document.getElementById("manRange0");
const manLbl0 = document.getElementById("manLbl0");
const btnSendManual = document.getElementById("btnSendManual");
const btnCenterAll = document.getElementById("btnCenterAll");

let handLandmarker = null;
let drawingUtils = new DrawingUtils(ctx);
let facingMode = "user";
let stream = null;
let running = false;
let isArmed = false;
let ws = null;
let lastSendTime = 0;

let smoothedAngle = -180;
let lastSentAngle = -180;
let lastRatio = null;

// Kalibrasyon ayarları (localStorage)
const saved = JSON.parse(localStorage.getItem("tekmotor_calib_v13") || "null") || {
  mode: "index_cam",
  indexMinDeg: -180,
  indexMaxDeg: 180,
  palmMinDeg: -180,
  palmMaxDeg: 180,
  thumbOpenRatio: 1.55,
  thumbClosedRatio: 0.85,
  openRatio: 1.90,
  closedRatio: 0.85,
  invert: false,
  gain: 1.0
};
selMotionMode.value = saved.mode || "thumb_slide";
chkInvert.checked = saved.invert;
inpGain.value = saved.gain;
function syncModeUI() {
  if (saved.mode === "touch_pad") touchPad.classList.add("active");
  else touchPad.classList.remove("active");
}
syncModeUI();

function saveCalib() {
  localStorage.setItem("tekmotor_calib_v13", JSON.stringify(saved));
}

chkInvert.addEventListener("change", () => { saved.invert = chkInvert.checked; saveCalib(); });
inpGain.addEventListener("change", () => { saved.gain = Number(inpGain.value) || 1.0; saveCalib(); });

selMotionMode.addEventListener("change", () => {
  saved.mode = selMotionMode.value;
  saveCalib();
syncModeUI();
});
btnCalOpen.addEventListener("click", () => {
  if (lastRatio === null) { alert("Önce kamerada elinizi gösterin."); return; }
  if (saved.mode === "index_cam") saved.indexMinDeg = lastRatio;
  else if (saved.mode === "palm_tilt") saved.palmMinDeg = lastRatio;
  else if (saved.mode === "thumb_slide") saved.thumbOpenRatio = lastRatio;
  else saved.openRatio = lastRatio;
  saveCalib();
});
btnCalClosed.addEventListener("click", () => {
  if (lastRatio === null) { alert("Önce kamerada elinizi gösterin."); return; }
  if (saved.mode === "index_cam") saved.indexMaxDeg = lastRatio;
  else if (saved.mode === "palm_tilt") saved.palmMaxDeg = lastRatio;
  else if (saved.mode === "thumb_slide") saved.thumbClosedRatio = lastRatio;
  else saved.closedRatio = lastRatio;
  saveCalib();
});

// PID grafik ve yerleşme süresi takibi
const MAX_HIST = 150;
let pidHistory = [];
let stepStart = null;
let stepTarget = null;
let stepPeak = 0;
let stepStartTime = null;
let settleCandidateTime = null;

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab, .panel").forEach((el) => el.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(console.error);
}

chkMirrorView.addEventListener("change", () => videoWrap.classList.toggle("mirrored", chkMirrorView.checked));
rngAlpha.addEventListener("input", () => (lblAlpha.textContent = rngAlpha.value));
rngDeadband.addEventListener("input", () => (lblDeadband.textContent = `${rngDeadband.value}°`));
manRange0.addEventListener("input", () => (manLbl0.textContent = `${manRange0.value}°`));

function setArmed(state) {
  isArmed = state;
  btnHoldActive.classList.toggle("armed", state);
  btnHoldActive.textContent = state ? "MOTOR AKTİF (Canlı)" : "Motor Kilitli (Basılı Tut / Aç)";
  if (!state) sendTarget(smoothedAngle, false);
}

btnHoldActive.addEventListener("pointerdown", () => { if (!chkLatchMode.checked) setArmed(true); });
btnHoldActive.addEventListener("pointerup", () => { if (!chkLatchMode.checked) setArmed(false); });
btnHoldActive.addEventListener("pointerleave", () => { if (!chkLatchMode.checked && isArmed) setArmed(false); });
btnHoldActive.addEventListener("click", () => { if (chkLatchMode.checked) setArmed(!isArmed); });

async function createLandmarker(vision, delegate) {
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.45,
    minTrackingConfidence: 0.45
  });
}

async function initMediaPipe() {
  try {
    offlineBadge.textContent = "El modeli yükleniyor (~13 MB)...";
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    try {
      handLandmarker = await createLandmarker(vision, "GPU");
      offlineBadge.textContent = "Çevrimdışı Hazır (GPU) ✓";
    } catch (_) {
      handLandmarker = await createLandmarker(vision, "CPU");
      offlineBadge.textContent = "Çevrimdışı Hazır (CPU) ✓";
    }
    offlineBadge.classList.add("ok");
  } catch (err) {
    offlineBadge.textContent = `Model hatası: ${err?.message || "İlk açılışta internet gerekir"}`;
  }
}

initMediaPipe();

function connectWS() {
  if (ws) ws.close();
  wsBadge.textContent = "ESP32: Bağlanıyor...";
  ws = new WebSocket(wsUrlInput.value.trim());

  ws.onopen = () => {
    wsBadge.textContent = "ESP32: Bağlı ✓";
    wsBadge.classList.add("ok");
    wsDot.classList.add("ok");
  };
  ws.onclose = () => {
    wsBadge.textContent = "ESP32: Bağlı Değil";
    wsBadge.classList.remove("ok");
    wsDot.classList.remove("ok");
  };
  ws.onerror = () => {
    wsBadge.textContent = "ESP32: SSL/Bağlantı Hatası";
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "telemetry") onTelemetry(msg);
    } catch (_) {}
  };
}

function sendWs(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function sendTarget(angle, active) {
  sendWs({ type: "target", m1: Number(angle.toFixed(1)), active });
}

btnConnectWs.addEventListener("click", connectWS);
btnTrustCert.addEventListener("click", () => window.open("https://192.168.4.1", "_blank"));

btnSendManual.addEventListener("click", () => {
  const val = Number(manRange0.value);
  smoothedAngle = val;
  valM1.textContent = `${Math.round(val)}°`;
  sendTarget(val, true);
});

btnCenterAll.addEventListener("click", () => {
  manRange0.value = 0;
  manLbl0.textContent = "0°";
  smoothedAngle = 0;
  valM1.textContent = "0°";
  sendTarget(0, true);
});

btnApplyPid.addEventListener("click", () => {
  sendWs({
    type: "pid",
    kp: Number(inpKp.value),
    ki: Number(inpKi.value),
    kd: Number(inpKd.value),
    maxPwm: Number(inpMaxPwm.value)
  });
});

function triggerStep(delta) {
  pidHistory = [];
  stepTarget = null;
  stepStart = null;
  stepPeak = 0;
  stepStartTime = performance.now();
  settleCandidateTime = null;
  pidSettleEl.textContent = "-";
  sendWs({ type: "step", delta });
}

btnStepTest.addEventListener("click", () => triggerStep(30));
btnStepTestNeg.addEventListener("click", () => triggerStep(-30));
btnClearPlot.addEventListener("click", () => {
  pidHistory = [];
  stepTarget = null;
  stepStart = null;
  pidSettleEl.textContent = "-";
  drawPidChart();
});

btnExportCsv.addEventListener("click", () => {
  if (pidHistory.length === 0) return;
  const rows = ["zaman_ms,hedef_sp,gercek_enc,hata,pwm"];
  pidHistory.forEach((p) => rows.push(`${p.t},${p.sp},${p.act},${p.err},${p.out}`));
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tekmotor_pid_analiz.csv";
  a.click();
});

function onTelemetry(t) {
  const now = performance.now();
  pidSpEl.textContent = `${Number(t.sp).toFixed(1)}°`;
  pidActEl.textContent = `${Number(t.act).toFixed(1)}°`;
  pidErrEl.textContent = `${Number(t.err).toFixed(1)}°`;

  if (stepTarget === null) {
    stepTarget = t.sp;
    stepStart = t.act;
    stepPeak = t.act;
    stepStartTime = now;
  } else if (t.sp !== stepTarget) {
    stepStart = t.act;
    stepTarget = t.sp;
    stepPeak = t.act;
    stepStartTime = now;
    settleCandidateTime = null;
  } else {
    const dir = stepTarget >= stepStart ? 1 : -1;
    if (dir > 0) stepPeak = Math.max(stepPeak, t.act);
    else stepPeak = Math.min(stepPeak, t.act);
  }

  const stepSize = Math.abs(stepTarget - stepStart);
  const overshootDeg = stepTarget >= stepStart ? (stepPeak - stepTarget) : (stepTarget - stepPeak);
  const osPct = stepSize > 1 ? Math.max(0, (overshootDeg / stepSize) * 100) : 0;
  pidOsEl.textContent = `${osPct.toFixed(1)}%`;

  // Yerleşme süresi (±2° bandı içinde 200ms kalma)
  if (Math.abs(t.err) <= 2.0) {
    if (!settleCandidateTime) settleCandidateTime = now;
    if (now - settleCandidateTime >= 200 && stepStartTime) {
      pidSettleEl.textContent = `${Math.round(settleCandidateTime - stepStartTime)} ms`;
    }
  } else {
    settleCandidateTime = null;
  }

  pidHistory.push({ t: Math.round(now), sp: t.sp, act: t.act, err: t.err, out: t.out });
  if (pidHistory.length > MAX_HIST) pidHistory.shift();
  drawPidChart();
}

function drawPidChart() {
  const w = pidChart.width;
  const h = pidChart.height;
  pidCtx.clearRect(0, 0, w, h);

  pidCtx.strokeStyle = "#1e293b";
  pidCtx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    pidCtx.beginPath();
    pidCtx.moveTo(0, y);
    pidCtx.lineTo(w, y);
    pidCtx.stroke();
  }
  const zeroY = (10 + h * 0.58) / 2;
  pidCtx.strokeStyle = "#475569";
  pidCtx.setLineDash([4, 4]);
  pidCtx.beginPath();
  pidCtx.moveTo(0, zeroY);
  pidCtx.lineTo(w, zeroY);
  pidCtx.stroke();
  pidCtx.setLineDash([]);

  if (pidHistory.length < 2) return;

  const plotLine = (key, color, minV, maxV, yTop, yBot) => {
    pidCtx.strokeStyle = color;
    pidCtx.lineWidth = 2;
    pidCtx.beginPath();
    pidHistory.forEach((p, i) => {
      const x = (i / (MAX_HIST - 1)) * w;
      const norm = clamp((p[key] - minV) / (maxV - minV), 0, 1);
      const y = yBot - norm * (yBot - yTop);
      if (i === 0) pidCtx.moveTo(x, y);
      else pidCtx.lineTo(x, y);
    });
    pidCtx.stroke();
  };

  plotLine("sp", "#38bdf8", -180, 180, 10, h * 0.58);
  plotLine("act", "#22c55e", -180, 180, 10, h * 0.58);
  plotLine("err", "#f59e0b", -90, 90, h * 0.64, h - 10);
  plotLine("out", "#ef4444", -255, 255, h * 0.64, h - 10);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z); }

// Videodaki başparmak kaydırma/çevirme hareketi + yumruk modu
function computeOpennessAngle(wl) {
  const palmSize = dist(wl[0], wl[9]) || 0.09;
  let ratio = 1.0;
  let minR = 0.85;
  let maxR = 1.55;
 if (saved.mode === "index_cam" || saved.mode === "palm_tilt") {
   const pA = saved.mode === "index_cam" ? wl[5] : wl[0]; const pB = saved.mode === "index_cam" ? wl[8] : wl[9];
   const rawDeg = (Math.atan2(pB.x - pA.x, -(pB.y - pA.y)) * 180) / Math.PI; lastRatio = rawDeg;
   const minD = saved.mode === "index_cam" ? saved.indexMinDeg : saved.palmMinDeg; const maxD = saved.mode === "index_cam" ? saved.indexMaxDeg : saved.palmMaxDeg;
   let span = maxD - minD; if (Math.abs(span) < 5) span = span >= 0 ? 5 : -5;
   const openNorm = clamp((rawDeg - minD) / span, 0, 1); let angle = -180 + openNorm * 360;
   if (saved.invert) angle = -angle; angle = clamp(angle * saved.gain, -180, 180); return { angle, openNorm };
  }  
  if (saved.mode === "thumb_slide") {
    // Başparmak ucunun (4) serçe köküne (17) ve işaret köküne (5) göre durumu
    ratio = dist(wl[4], wl[17]) / palmSize;
    minR = saved.thumbClosedRatio;
    maxR = saved.thumbOpenRatio;
  } else {
    const tipAvg = (dist(wl[0], wl[8]) + dist(wl[0], wl[12]) + dist(wl[0], wl[16]) + dist(wl[0], wl[20])) / 4;
    ratio = tipAvg / palmSize;
    minR = saved.closedRatio;
    maxR = saved.openRatio;
  }

  lastRatio = ratio;
  const span = Math.max(0.10, maxR - minR);
  const openNorm = clamp((ratio - minR) / span, 0, 1); // 1 = Uç 1 (-180°), 0 = Uç 2 (+180°)
  let angle = 180 - openNorm * 360;
  if (saved.invert) angle = -angle;
  angle = clamp(angle * saved.gain, -180, 180);
  return { angle, openNorm };
}

async function startCamera() {
  if (!handLandmarker) { alert("El tanıma modeli henüz yükleniyor, birkaç saniye bekleyin."); return; }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  running = true;
  requestAnimationFrame(loop);
}

btnStartCam.addEventListener("click", startCamera);
btnFlipCam.addEventListener("click", () => {
  facingMode = facingMode === "user" ? "environment" : "user";
  if (running) startCamera();
});

let frameCount = 0;
let fpsTimer = performance.now();

function loop(now) {
  if (!running) return;
  frameCount++;
  if (now - fpsTimer >= 1000) {
    fpsLabel.textContent = `${frameCount} FPS`;
    frameCount = 0;
    fpsTimer = now;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (video.readyState >= 2) {
    const res = handLandmarker.detectForVideo(video, now);
    if (res.landmarks && res.landmarks.length > 0 && res.worldLandmarks) {
      handBadge.textContent = "Algılandı";
      handBadge.className = "mini-status ok";
      handStatus.textContent = "El Algılandı ✓";
      handStatus.className = "pill ok";

      drawingUtils.drawConnectors(res.landmarks[0], HandLandmarker.HAND_CONNECTIONS, { color: "#38bdf8", lineWidth: 3 });
      drawingUtils.drawLandmarks(res.landmarks[0], { color: "#f8fafc", radius: 4 });

      const { angle, openNorm } = computeOpennessAngle(res.worldLandmarks[0]);
      const alpha = Number(rngAlpha.value);
      const deadband = Number(rngDeadband.value);

      smoothedAngle = alpha * angle + (1 - alpha) * smoothedAngle;
      valM1.textContent = `${Math.round(smoothedAngle)}°`;
      const pct = Math.round(openNorm * 100);
      openBar.style.width = `${pct}%`;
      openPctText.textContent = `Açıklık: %${pct}`;

      if (isArmed && now - lastSendTime >= 33) {
        if (Math.abs(smoothedAngle - lastSentAngle) >= deadband) {
          sendTarget(smoothedAngle, true);
          lastSentAngle = smoothedAngle;
        } else {
          sendTarget(lastSentAngle, true);
        }
        lastSendTime = now;
      }
    } else {
      handBadge.textContent = "Yok";
      handBadge.className = "mini-status";
      handStatus.textContent = "El bekleniyor (Kilitli)";
      handStatus.className = "pill warn";
      if (isArmed) sendTarget(lastSentAngle, false);
    }
  }
  requestAnimationFrame(loop);


let touchStart = null, touchPrev = null, touchDir = null;
touchPad.addEventListener("pointerdown", (e) => {
  touchPad.setPointerCapture(e.pointerId);
  touchStart = { x: e.clientX, y: e.clientY };
  touchPrev = { x: e.clientX, y: e.clientY };
  touchDir = null;
});
touchPad.addEventListener("pointermove", (e) => {
  if (!touchPrev) return;
  if (!touchDir) {
    const dist = Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y);
    if (dist >= 8) {
      touchDir = { x: (e.clientX - touchStart.x) / dist, y: (e.clientY - touchStart.y) / dist };
    }
  }
  if (touchDir) {
    const dx = e.clientX - touchPrev.x;
    const dy = e.clientY - touchPrev.y;
    const proj = dx * touchDir.x + dy * touchDir.y;
    let delta = proj * 0.6 * saved.gain;
    if (saved.invert) delta = -delta;
    smoothedAngle = clamp(smoothedAngle + delta, -180, 180);
    touchPrev = { x: e.clientX, y: e.clientY };
    valM1.textContent = Math.round(smoothedAngle) + "°";
    const pct = Math.round(((smoothedAngle + 180) / 360) * 100);
    openBar.style.width = pct + "%";
    openPctText.textContent = "Açıklık: %" + pct;
    const now = performance.now();
    if (isArmed && now - lastSendTime >= 33) {
      sendTarget(smoothedAngle, true);
      lastSentAngle = smoothedAngle;
      lastSendTime = now;
    }
  }
});
function resetTouch() {
  touchStart = null;
  touchPrev = null;
  touchDir = null;
}
touchPad.addEventListener("pointerup", resetTouch);
touchPad.addEventListener("pointercancel", resetTouch);}
