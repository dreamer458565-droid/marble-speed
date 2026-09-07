import { BlobDetector, medianBackground, fitTrajectory, compareWithTheory,
         energySplit, estimateMarbleDiameterPx, BODIES } from './analysis.js';
import { openVideo, analysisSize, sampleFrames, streamFrames,
         probeContainerFps, safePlaybackRate, timeScale,
         openCamera, closeCamera, streamCameraFrames } from './video.js';
import { readVideoTrackInfo } from './mp4.js';

const $ = (id) => document.getElementById(id);
const BACKGROUND_SAMPLES = 9;

const S = {
  vid: null, size: null, background: null,
  containerFps: null, captureFps: 240,
  isLive: false, cam: null, live: null,
  a: { x: 0, y: 0 }, b: { x: 0, y: 0 },
  result: null, comparison: null,
};

// ── 화면 전환 ────────────────────────────────────────────────
const SCREENS = ['step-pick', 'step-live', 'step-busy', 'step-cal', 'step-result', 'step-error'];
function show(id) {
  SCREENS.forEach(s => $(s).classList.toggle('hidden', s !== id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function busy(title, detail, pct = 0) {
  $('busy-title').textContent = title;
  $('busy-detail').textContent = detail;
  progress(pct);
  show('step-busy');
}
function progress(p) {
  const v = Math.round(Math.max(0, Math.min(1, p)) * 100);
  $('busy-fill').style.width = v + '%';
  $('busy-pct').textContent = v;
}
function fail(msg) {
  $('error-msg').textContent = msg;
  show('step-error');
}
// 화면을 한 번 그리게 양보한다.
// 탭이 가려지면 requestAnimationFrame 이 멈추므로, 타임아웃을 같이 걸어
// 앱이 통째로 얼어붙지 않게 한다.
const nextPaint = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => setTimeout(finish, 0));
  setTimeout(finish, 250);
});

// ── 1. 영상 고르기 ───────────────────────────────────────────
$('pick').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) await loadFile(file);
};

async function loadFile(file) {
  try {
    S.captureFps = parseFloat($('capture-fps').value) || 240;

    busy('영상 여는 중', '파일을 읽고 있습니다.', 0.05);
    await nextPaint();
    S.vid = await openVideo(file);
    S.size = analysisSize(S.vid.width, S.vid.height, 640);

    busy('촬영 속도 확인 중',
         '이 영상이 초당 몇 장을 담고 있는지 확인하고 있습니다. 아이폰이 슬로모를 느리게 늘려 저장했는지 가려내는 과정입니다.', 0.15);
    await nextPaint();
    // 파일 헤더에 정확한 답이 들어 있다. 재생으로 재는 것보다 훨씬 믿을 만하다.
    const info = await readVideoTrackInfo(file);
    S.containerFps = info?.fps ?? await probeContainerFps(S.vid);

    busy('배경 만드는 중',
         '영상 곳곳에서 몇 장을 뽑아 구슬이 지워진 깨끗한 배경을 만듭니다.', 0.5);
    await nextPaint();
    const frames = await sampleFrames(S.vid, BACKGROUND_SAMPLES, S.size);
    S.background = medianBackground(frames, S.size.width, S.size.height);
    if (!S.background) throw new Error('배경을 만들지 못했습니다.');

    setupCalibration();
    show('step-cal');
  } catch (err) {
    fail(err.message || String(err));
  }
}

// ── 1-B. 카메라로 바로 재기 ──────────────────────────────────
//
// 파일 흐름과 다른 점은 둘뿐이다.
//   (1) 배경을 '굴리기 전'에 찍는다 — 구슬이 아예 없는 깨끗한 배경이라 파일보다 낫다
//   (2) 시간이 이미 실제 시간이라 배율 보정이 필요 없다
// 그 뒤 기준선·분석·결과는 파일 흐름과 똑같은 코드를 탄다.

$('live').onclick = async () => {
  try {
    S.isLive = true;
    $('live-status').textContent = '카메라를 켜는 중…';
    $('live-go').disabled = true;
    $('live-go').textContent = '배경 잡기';
    show('step-live');

    S.cam = await openCamera();
    const stage = $('live-stage');
    stage.style.aspectRatio = `${S.cam.width} / ${S.cam.height}`;
    stage.replaceChildren(S.cam.el, $('live-overlay'));
    S.size = analysisSize(S.cam.width, S.cam.height, 640);

    const fps = S.cam.frameRate;
    S.captureFps = fps || 30;
    S.containerFps = fps || null;
    $('live-status').textContent =
      `${S.cam.width}×${S.cam.height}` + (fps ? ` · ${Math.round(fps)}fps` : '') + ' — 화면을 익히는 중…';
    startWatch();
  } catch (err) {
    S.isLive = false;
    closeCamera(S.cam); S.cam = null;
    fail(err.message || String(err));
  }
};

$('live-cancel').onclick = () => {
  stopLive();
  show('step-pick');
};

function stopLive() {
  try { S.live?.stop(); } catch (_) {}
  S.live = null;
  closeCamera(S.cam);
  S.cam = null;
}

/**
 * 카메라 감시 루프.
 *
 * 화면을 익힌 뒤(배경 학습) [측정 시작]을 누르면 그때부터 기록한다.
 * 기록 중에는 잡힌 자리를 화면에 그려 준다 — 구슬이 제대로 보이는지
 * 눈으로 확인할 수 있어야 하기 때문이다.
 * 구슬이 다 지나가면 알아서 끝나고, [정지]로 직접 끝낼 수도 있다.
 *
 * 배경은 지수 이동 평균으로 계속 갱신한다. 조명이 바뀌거나 폰이 살짝 흔들려도
 * 따라가고, 갱신이 느려서(프레임당 3%) 빠르게 지나가는 구슬은 배경에 배지 않는다.
 */
function startWatch() {
  const { width: W, height: H } = S.size;
  const n = W * H;
  const bgF = new Float32Array(n);
  const bgU = new Uint8Array(n);
  const detector = new BlobDetector(W, H);
  const maxArea = Math.round(n * 0.01);   // 화면의 1% 넘으면 손·그림자로 본다

  const ov = $('live-overlay');
  ov.width = W; ov.height = H;
  const octx = ov.getContext('2d');

  const WARMUP = 25, MIN_POINTS = 8, LOST_END = 12;
  let seen = 0, phase = 'warming';
  let points = [];
  let last = null, vx = 0, vy = 0, lost = 0;

  const setStatus = (t) => { $('live-status').textContent = t; };

  const paint = (blob) => {
    octx.clearRect(0, 0, W, H);
    if (points.length > 1) {
      octx.strokeStyle = 'rgba(74,208,127,.55)';
      octx.lineWidth = 2;
      octx.beginPath();
      points.forEach((p, i) => i ? octx.lineTo(p.point.x, p.point.y) : octx.moveTo(p.point.x, p.point.y));
      octx.stroke();
    }
    octx.fillStyle = '#4ad07f';
    for (const p of points) {
      octx.beginPath(); octx.arc(p.point.x, p.point.y, 2.4, 0, 7); octx.fill();
    }
    if (blob) {
      const r = Math.max(7, (blob.maxX - blob.minX + blob.maxY - blob.minY) / 3);
      octx.strokeStyle = phase === 'armed' ? '#4ad07f' : '#37c7e0';
      octx.lineWidth = 2.5;
      octx.beginPath(); octx.arc(blob.cx, blob.cy, r, 0, 7); octx.stroke();
      octx.beginPath();
      octx.moveTo(blob.cx - r - 5, blob.cy); octx.lineTo(blob.cx - r + 2, blob.cy);
      octx.moveTo(blob.cx + r - 2, blob.cy); octx.lineTo(blob.cx + r + 5, blob.cy);
      octx.moveTo(blob.cx, blob.cy - r - 5); octx.lineTo(blob.cx, blob.cy - r + 2);
      octx.moveTo(blob.cx, blob.cy + r - 2); octx.lineTo(blob.cx, blob.cy + r + 5);
      octx.stroke();
    }
  };

  const track = streamCameraFrames(S.cam, S.size, (luma, t) => {
    seen++;

    if (seen === 1) { for (let i = 0; i < n; i++) bgF[i] = luma[i]; }
    else {
      const a = phase === 'armed' && points.length ? 0.005 : 0.03;
      for (let i = 0; i < n; i++) bgF[i] += (luma[i] - bgF[i]) * a;
    }
    for (let i = 0; i < n; i++) bgU[i] = bgF[i];

    if (seen < WARMUP) {
      setStatus(`화면을 익히는 중… ${Math.round((seen / WARMUP) * 100)}%`);
      return;
    }
    if (phase === 'warming') {
      phase = 'idle';
      $('live-go').disabled = false;
      setStatus('구슬을 굴려 보며 ● 표시가 따라붙는지 확인한 뒤 [측정 시작]을 누르세요.');
    }

    const roi = (last && lost < 3)
      ? { x0: Math.round(last.x + vx) - 70 - Math.abs(vx), y0: Math.round(last.y + vy) - 70 - Math.abs(vy),
          x1: Math.round(last.x + vx) + 70 + Math.abs(vx), y1: Math.round(last.y + vy) + 70 + Math.abs(vy) }
      : { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };

    const threshold = +$('sens').value;
    const blob = detector.detect(luma, bgU, threshold, roi, null, true, maxArea);
    paint(blob);

    if (blob) {
      const p = { x: blob.cx, y: blob.cy };
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.4) { last = p; lost++; return; }
      if (last && lost === 0) {
        vx = 0.6 * vx + 0.4 * (p.x - last.x);
        vy = 0.6 * vy + 0.4 * (p.y - last.y);
      } else { vx = 0; vy = 0; }
      last = p; lost = 0;
      if (phase === 'armed') {
        points.push({ time: t, point: p, area: blob.area, minorSigma: blob.minorSigma });
        setStatus(`쫓는 중… ${points.length}장`);
      }
      return;
    }

    lost++;
    if (lost < LOST_END) return;
    last = null; vx = 0; vy = 0;

    // 다 지나갔으면 알아서 끝낸다
    if (phase === 'armed' && points.length >= MIN_POINTS) {
      const done = points;
      S.background = new Uint8Array(bgU);
      track.stop();
      finishAuto(done);
    }
  });

  S.live = track;

  const arm = () => {
    phase = 'armed';
    points = [];
    setStatus('굴리세요! 다 지나가면 알아서 끝납니다.');
    $('live-go').textContent = '정지';
    $('live-go').onclick = finish;
  };
  const finish = () => {
    const done = points;
    S.background = new Uint8Array(bgU);
    track.stop();
    if (done.length >= 6) finishAuto(done);
    else {
      stopLive();
      fail(`구슬을 ${done.length}장밖에 못 찾았습니다. 배경과 구슬의 밝기 차이를 키우거나, 더 밝은 곳에서 해 보세요.`);
    }
  };

  $('live-go').textContent = '측정 시작';
  $('live-go').disabled = true;
  $('live-go').onclick = arm;
}

function finishAuto(points) {
  stopLive();
  S.livePoints = points;
  $('scale-mode').value = 'marble';    // 자동 감지는 자 없이 쓰는 게 자연스럽다
  setupCalibration();
  show('step-cal');
}

// ── 2. 기준선 ───────────────────────────────────────────────
function drawLuma(canvas, luma, w, h) {
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    img.data[p] = img.data[p + 1] = img.data[p + 2] = luma[i];
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return ctx;
}

function setupCalibration() {
  const { width: w, height: h } = S.size;
  // 드래그 핸들러가 이 객체를 붙잡고 있으므로 통째로 갈아끼우면 안 된다.
  // 새 객체를 대입하면 핸들러는 버려진 옛 객체를 고치게 되어 드래그가 먹통이 된다.
  S.a.x = w * 0.25; S.a.y = h * 0.75;
  S.b.x = w * 0.75; S.b.y = h * 0.75;
  drawLuma($('cal-canvas'), S.background, w, h);
  placeHandles();
  updateReadout();
}

/** 분석 픽셀 좌표 → 화면 CSS 좌표 */
function viewScale() {
  const c = $('cal-canvas');
  return c.clientWidth / c.width || 1;
}
function placeHandles() {
  const k = viewScale();
  for (const [el, p] of [[$('handle-a'), S.a], [$('handle-b'), S.b]]) {
    el.style.left = p.x * k + 'px';
    el.style.top = p.y * k + 'px';
  }
  drawCalOverlay();
}
function drawCalOverlay() {
  const c = $('cal-canvas');
  const ctx = drawLuma(c, S.background, S.size.width, S.size.height);
  ctx.strokeStyle = '#ffb43c';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(S.a.x, S.a.y);
  ctx.lineTo(S.b.x, S.b.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // 입력한 지름·기준선이 맞는지 눈으로 보라고 그려 주는 원
  const ppm = pixelsPerMeter();
  if (ppm) {
    const r = (diameterM() / 2) * ppm;
    if (r >= 1 && r < S.size.width / 4) {
      ctx.strokeStyle = '#37c7e0';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc((S.a.x + S.b.x) / 2, (S.a.y + S.b.y) / 2 - r * 3.5, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function dragHandle(el, point) {
  const move = (ev) => {
    ev.preventDefault();
    const rect = $('cal-canvas').getBoundingClientRect();
    const k = viewScale();
    point.x = Math.max(0, Math.min(S.size.width - 1, (ev.clientX - rect.left) / k));
    point.y = Math.max(0, Math.min(S.size.height - 1, (ev.clientY - rect.top) / k));
    placeHandles();
    updateReadout();
  };
  el.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    // 포인터 캡처는 실패해도 드래그 자체는 되어야 한다.
    // 여기서 예외가 나면 아래 리스너 등록이 통째로 건너뛰어져 핸들이 안 움직인다.
    try { el.setPointerCapture(ev.pointerId); } catch (_) { /* 무시 */ }
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', function up() {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    });
  });
}
dragHandle($('handle-a'), S.a);
dragHandle($('handle-b'), S.b);
window.addEventListener('resize', () => { if (S.background) placeHandles(); });

const scaleMode = () => $('scale-mode').value;
const usesRuler = () => scaleMode() === 'ruler';
const refCM = () => parseFloat($('ref-cm').value) || 0;
const diameterM = () => (parseFloat($('dia-mm').value) || 16) / 1000;
function pixelsPerMeter() {
  const px = Math.hypot(S.b.x - S.a.x, S.b.y - S.a.y);
  const m = refCM() / 100;
  return px > 1 && m > 0 ? px / m : null;
}

/** 자 대신 구슬 자신을 잣대로 쓴다. 화면에서 잰 지름(px) ÷ 실제 지름(m) */
function pixelsPerMeterFromMarble(points) {
  const dPx = estimateMarbleDiameterPx(points);
  const dM = diameterM();
  if (!dPx || !(dM > 0)) return null;
  return dPx / dM;
}
function updateReadout() {
  const ruler = usesRuler();
  const ppm = pixelsPerMeter();
  const px = Math.hypot(S.b.x - S.a.x, S.b.y - S.a.y);
  const fpsNote = S.containerFps
    ? ` · 영상 ${S.containerFps.toFixed(0)}fps${S.containerFps < S.captureFps - 5 ? ` (촬영 ${S.captureFps}fps 를 늘려 저장한 파일)` : ''}`
    : '';

  $('cal-wrap').classList.toggle('hidden', !ruler);
  $('row-ref').classList.toggle('hidden', !ruler);
  $('scale-help').textContent = ruler
    ? '길이를 아는 물건이면 무엇이든 됩니다 — 자, A4 종이 긴 변(29.7cm), 신용카드 긴 변(8.6cm), 500원 동전 지름(2.65cm), 젓가락. 구슬이 지나가는 그 자리에 놓인 것이어야 합니다.'
    : '구슬 자신을 잣대로 씁니다. 화면 속 구슬이 몇 픽셀인지 재어 환산합니다. 자가 없어도 되지만 오차가 5~10% 로 커집니다. 구슬 지름을 정확히 입력하세요.';

  if (ruler) {
    $('cal-readout').textContent = ppm
      ? `기준선 ${px.toFixed(0)}px = ${refCM()}cm → 1m 당 ${ppm.toFixed(0)}px · 구슬은 화면에서 약 ${(diameterM() * ppm).toFixed(1)}px${fpsNote}`
      : '기준선을 그어 주세요.';
    $('cal-go').disabled = !ppm;
    drawCalOverlay();
  } else {
    $('cal-readout').textContent =
      `구슬 지름 ${(diameterM() * 1000).toFixed(0)}mm 을 잣대로 씁니다. 분석하면서 화면 속 크기를 재어 환산합니다.${fpsNote}`;
    $('cal-go').disabled = false;
  }
}
$('scale-mode').onchange = updateReadout;
$('ref-cm').oninput = updateReadout;
$('dia-mm').oninput = updateReadout;
$('sens').oninput = () => {
  const v = +$('sens').value;
  $('sens-label').textContent = v <= 16 ? '예민' : v >= 40 ? '둔감' : '보통';
};
$('cal-back').onclick = () => { S.isLive = false; stopLive(); show('step-pick'); };
$('err-restart').onclick = () => { S.isLive = false; stopLive(); show('step-pick'); };
$('err-back').onclick = () => show(S.background ? 'step-cal' : 'step-pick');

// ── 3. 분석 ─────────────────────────────────────────────────
$('cal-go').onclick = async () => {
  try {
    const ppm = pixelsPerMeter();
    if (!ppm) return;

    // 카메라 모드는 이미 굴리는 동안 추적을 마쳤다. 바로 적합만 하면 된다.
    if (S.isLive) {
      const scale = usesRuler() ? ppm : pixelsPerMeterFromMarble(S.livePoints);
      if (!scale) throw new Error('구슬 크기를 재지 못했습니다. 자를 놓고 다시 하거나, 구슬이 더 크게 나오도록 가까이서 찍어 보세요.');
      S.scaleUsed = scale;
      S.result = fitTrajectory(S.livePoints, scale);
      S.comparison = compareWithTheory(
        S.result.trajectoryAngleDegrees, $('body').value, S.result.acceleration);
      renderResult();
      show('step-result');
      return;
    }

    const rate = safePlaybackRate(S.containerFps || S.captureFps);
    busy('구슬 추적 중',
         '영상을 처음부터 재생하며 프레임마다 구슬을 찾고 있습니다. 슬로모는 원래 길이가 길어 시간이 좀 걸립니다.', 0);
    await nextPaint();

    const { width: W, height: H } = S.size;
    const detector = new BlobDetector(W, H);
    const threshold = +$('sens').value;
    // 자 없이 환산할 때는 아직 배율을 모르므로 예상 크기를 줄 수 없다.
    // 크기 조건 없이 찾은 뒤, 잡힌 구슬의 폭으로 배율을 계산한다.
    const ruler = usesRuler();
    const radiusPx = ruler ? Math.max(2, (diameterM() / 2) * ppm) : 10;
    const expectedArea = ruler ? Math.PI * radiusPx * radiusPx : null;
    const searchRadius = Math.round(radiusPx * 6);

    const points = [];
    let last = null, vx = 0, vy = 0, miss = 0;

    await streamFrames(S.vid, S.size, (luma, mediaTime) => {
      // 예측 위치 주변만 뒤진다. 놓치면 전체 화면으로 되돌아간다.
      const roi = (last && miss < 3)
        ? { x0: Math.round(last.x + vx) - searchRadius - Math.abs(vx),
            y0: Math.round(last.y + vy) - searchRadius - Math.abs(vy),
            x1: Math.round(last.x + vx) + searchRadius + Math.abs(vx),
            y1: Math.round(last.y + vy) + searchRadius + Math.abs(vy) }
        : { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };

      const blob = detector.detect(luma, S.background, threshold, roi, expectedArea, !ruler);
      if (blob) {
        const p = { x: blob.cx, y: blob.cy };

        // 앞 프레임과 위치가 사실상 같으면 버린다.
        // (a) 재생 초반 디코더가 밀려 같은 화면이 반복되는 구간 — 시각이 거짓이다
        // (b) 굴리기 전에 구슬이 멈춰 있던 구간 — 등가속도 적합을 망친다
        if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.1) {
          last = p;
          return;
        }

        if (last && miss === 0) {
          vx = 0.6 * vx + 0.4 * (p.x - last.x);
          vy = 0.6 * vy + 0.4 * (p.y - last.y);
        } else { vx = 0; vy = 0; }
        last = p; miss = 0;
        points.push({ time: mediaTime, point: p, area: blob.area, minorSigma: blob.minorSigma });
      } else {
        miss++;
        if (miss >= 3) { last = null; vx = 0; vy = 0; }
      }
    }, progress, rate);

    // 컨테이너 시간 → 실제 시간
    const tScale = timeScale(S.containerFps || S.captureFps, S.captureFps);
    const real = points.map(p => ({ ...p, time: p.time * tScale }));

    const scale = ruler ? ppm : pixelsPerMeterFromMarble(real);
    if (!scale) throw new Error('구슬 크기를 재지 못했습니다. 자를 놓고 다시 하거나, 구슬이 더 크게 나오도록 가까이서 찍어 보세요.');
    S.scaleUsed = scale;

    S.result = fitTrajectory(real, scale);
    S.comparison = compareWithTheory(
      S.result.trajectoryAngleDegrees, $('body').value, S.result.acceleration);
    renderResult();
    show('step-result');
  } catch (err) {
    fail(err.message || String(err));
  }
};

// ── 4. 결과 ─────────────────────────────────────────────────
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—');

function renderResult() {
  const r = S.result, c = S.comparison;
  const split = energySplit(c.bodyKey);
  const badge = { matchesTheory: 'good', likelySlipping: 'warn', energyLoss: 'warn', unreliable: 'gray' }[c.verdict];
  const calPx = Math.hypot(S.b.x - S.a.x, S.b.y - S.a.y);

  $('step-result').innerHTML = `
    <div class="hero">
      <div class="lbl">가장 빨랐을 때</div>
      <div class="big">${f(r.maxSpeed)}</div>
      <div class="unit">m/s</div>
      <div class="kmh">시속 ${f(r.maxSpeed * 3.6, 1)} km</div>
    </div>

    <div class="grid">
      ${tile('가속도', f(r.acceleration), 'm/s²', `± ${f(r.accelerationStdError)}`)}
      ${tile('평균 속도', f(r.averageSpeed), 'm/s')}
      ${tile('굴러간 거리', f(r.travelDistance * 100, 1), 'cm')}
      ${tile('걸린 시간', f(r.duration, 3), '초')}
      ${tile('경사각', f(r.trajectoryAngleDegrees, 1), '°', '영상에서 측정')}
      ${tile('추적 프레임', String(r.inlierCount), '장', `검출 ${r.detectedCount}장 중`)}
    </div>

    <div class="card">
      <h2>이론과 견주기 <span class="badge ${badge}">${c.verdictTitle}</span></h2>
      ${bar('실제 측정값', c.measuredAcceleration, c, 'var(--accent)')}
      ${bar('굴러갈 때 이론값', c.theoreticalAcceleration, c, 'var(--good)')}
      ${bar('미끄러졌다면', c.slidingAcceleration, c, '#5b6e8c')}
      <p class="muted" style="margin-top:14px">${c.verdictDetail}</p>
      <div class="formula">
        a = g · sin θ ÷ (1 + k)<br>
        &nbsp;&nbsp;= 9.81 × sin ${f(c.inclineDeg, 1)}° ÷ (1 + ${f(BODIES[c.bodyKey].k, 2)})
        = <b>${f(c.theoreticalAcceleration)} m/s²</b>
      </div>
      <p class="hint">k 는 물체가 얼마나 '돌기 싫어하는가'를 나타내는 값입니다. 속이 찬 구슬은 0.4 라서, 미끄러질 때보다 1.4배 느리게 내려옵니다.</p>
    </div>

    <div class="card">
      <h2>속도가 어떻게 변했나</h2>
      <p class="muted">직선이면 등가속도 운동입니다. 기울기가 곧 가속도입니다.</p>
      <canvas id="chart-v" class="chart"></canvas>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>측정</span>
        <span><i style="background:var(--good)"></i>이론</span>
      </div>
    </div>

    <div class="card">
      <h2>얼마나 내려왔나</h2>
      <p class="muted">점점 가팔라지는 곡선입니다. 같은 시간에 갈수록 더 많이 내려간다는 뜻입니다.</p>
      <canvas id="chart-s" class="chart"></canvas>
    </div>

    <div class="card">
      <h2>찾아낸 구슬 자리</h2>
      <p class="muted">초록 점이 계산에 쓴 위치입니다. 빨간 점은 직선에서 벗어나 버린 것입니다.</p>
      <canvas id="chart-track" class="chart"></canvas>
    </div>

    <div class="card">
      <h2>에너지는 어디로 갔나</h2>
      <p class="muted">높은 곳에 있던 구슬의 에너지가 두 곳으로 나뉩니다. 하나는 앞으로 나아가는 데, 하나는 스스로 도는 데 쓰입니다.</p>
      <div class="split">
        <i style="background:var(--accent);width:${(split.translation * 100).toFixed(1)}%"></i>
        <i style="background:#a77bd6;flex:1"></i>
      </div>
      <div class="legend">
        <span><i style="background:var(--accent)"></i>앞으로 나아감 ${Math.round(split.translation * 100)}%</span>
        <span><i style="background:#a77bd6"></i>스스로 돎 ${Math.round(split.rotation * 100)}%</span>
      </div>
      <p class="hint">가장 빠를 때 구슬은 1초에 약 ${Math.round(r.maxSpeed / (Math.PI * diameterM()))}바퀴 돌고 있었습니다.</p>
    </div>

    <div class="card">
      <h2>이 값을 얼마나 믿을 수 있나</h2>
      ${check(S.captureFps >= 120,
        `슬로모로 찍었습니다 (${Math.round(S.captureFps)}fps)`,
        S.isLive
          ? `카메라로 바로 잰 값입니다 (${Math.round(S.captureFps)}fps). 브라우저가 열어 주는 최대치라 어쩔 수 없지만, 슬로모(240fps)로 찍어 파일로 넣으면 오차가 10배쯤 줄어듭니다.`
          : `${Math.round(S.captureFps)}fps 는 너무 느립니다. 슬로모로 다시 찍으면 훨씬 정확해집니다.`)}
      ${check(r.inlierCount >= 20,
        `${r.inlierCount}장의 프레임으로 계산했습니다`,
        `${r.inlierCount}장뿐이라 값이 흔들릴 수 있습니다. 구슬과 배경 대비를 높여 보세요.`)}
      ${check(r.fitResidualRMS < 0.004,
        `등가속도 운동에 잘 맞습니다 (오차 ${f(r.fitResidualRMS * 1000, 1)} mm)`,
        `궤적이 매끄럽지 않습니다 (오차 ${f(r.fitResidualRMS * 1000, 1)} mm). 폰이 흔들렸거나 구슬이 튀었을 수 있습니다.`)}
      ${usesRuler()
        ? check(calPx >= 100,
            '기준선이 충분히 깁니다',
            `기준선이 짧아(${calPx.toFixed(0)}px) 거리 환산 오차가 커집니다. 더 긴 물건을 쓰세요.`)
        : check(false,
            '',
            `자 없이 구슬 크기(화면에서 ${f(S.scaleUsed * diameterM(), 1)}px)로 환산했습니다. 거리·속도·가속도 모두 5~10% 오차를 안고 있습니다. 정확한 값이 필요하면 길이를 아는 물건을 같이 찍어 '자·물건으로' 환산하세요.`)}
      <p class="hint" style="margin-top:12px">가장 큰 오차는 시간이 아니라 <b>거리 환산</b>과 <b>카메라 각도</b>에서 옵니다. 자를 구슬이 지나가는 바로 그 자리에 두고, 카메라를 진행 방향과 직각으로 놓는 것이 정확도를 가장 크게 좌우합니다.</p>
    </div>

    <div class="row">
      <button id="res-cal">설정 바꿔 다시</button>
      <button id="res-new" class="primary">새 영상</button>
    </div>`;

  $('res-cal').onclick = () => show('step-cal');
  $('res-new').onclick = () => show('step-pick');

  // 이동창 속도는 양끝에서 창이 한쪽으로만 열려 기울기가 눌린다.
  // 그 구간을 빼야 이론선과 나란히 보인다 (대표 수치는 이미 2차 적합에서 뽑았다).
  const trim = Math.min(7, Math.floor(r.samples.length / 5));
  const mid = r.samples.slice(trim, r.samples.length - trim);
  drawLineChart($('chart-v'), mid.map(s => [s.time, s.speed]), '초', 'm/s',
    theoryLine(r, c, mid));
  drawLineChart($('chart-s'), r.samples.map(s => [s.time, s.distance * 100]), '초', 'cm', null, '#ffb43c');
  drawTrack($('chart-track'), r.track);
}

function theoryLine(r, c, shown) {
  const pts = shown && shown.length ? shown : r.samples;
  if (!(c.theoreticalAcceleration > 0) || !pts.length) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const out = [];
  for (let i = 0; i <= 20; i++) {
    const t = first.time + (last.time - first.time) * (i / 20);
    out.push([t, first.speed + c.theoreticalAcceleration * (t - first.time)]);
  }
  return out;
}

const tile = (k, v, u, n) =>
  `<div class="tile"><div class="k">${k}</div><div class="v">${v}<small>${u}</small></div>${n ? `<div class="n">${n}</div>` : ''}</div>`;

function bar(label, value, c, color) {
  const max = Math.max(c.slidingAcceleration, c.measuredAcceleration, 0.1) * 1.1;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return `<div class="abar">
    <div class="top"><span>${label}</span><b>${f(value)} m/s²</b></div>
    <div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
  </div>`;
}

const check = (ok, good, bad) =>
  `<div class="check ${ok ? 'ok' : 'no'}"><span class="m">${ok ? '✓' : '!'}</span><span>${ok ? good : bad}</span></div>`;

// ── 간단한 캔버스 그래프 ─────────────────────────────────────
function drawLineChart(canvas, data, xLabel, yLabel, extra, color = '#37c7e0') {
  const W = 640, H = 300, pad = { l: 52, r: 14, t: 30, b: 34 };
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0f1a2b';
  ctx.fillRect(0, 0, W, H);
  if (!data.length) return;

  const all = extra ? data.concat(extra) : data;
  const xs = all.map(d => d[0]), ys = all.map(d => d[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(0, Math.min(...ys)), y1 = Math.max(...ys);
  if (y1 - y0 < 1e-9) y1 = y0 + 1;
  const px = t => pad.l + ((t - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const py = v => H - pad.b - ((v - y0) / (y1 - y0)) * (H - pad.t - pad.b);

  ctx.strokeStyle = '#26354f'; ctx.lineWidth = 1;
  ctx.fillStyle = '#6d82a3'; ctx.font = '13px system-ui'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = y0 + ((y1 - y0) * i) / 4, y = py(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(v.toFixed(v >= 10 ? 0 : 2), pad.l - 8, y + 4);
  }
  ctx.textAlign = 'center';
  // 맨 오른쪽 눈금 자리는 단위 표시에 내준다
  for (let i = 0; i < 4; i++) {
    const t = x0 + ((x1 - x0) * i) / 4;
    ctx.fillText(t.toFixed(2), px(t), H - 12);
  }
  ctx.textAlign = 'left';
  ctx.fillText(yLabel, 6, 18);
  ctx.textAlign = 'right';
  ctx.fillText(xLabel, W - pad.r, H - 12);

  const line = (pts, col, dash) => {
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = 2.5;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    pts.forEach((d, i) => (i ? ctx.lineTo(px(d[0]), py(d[1])) : ctx.moveTo(px(d[0]), py(d[1]))));
    ctx.stroke();
    ctx.restore();
  };
  if (extra) line(extra, '#4ad07f', [6, 4]);
  line(data, color);
}

function drawTrack(canvas, track) {
  const { width: w, height: h } = S.size;
  const ctx = drawLuma(canvas, S.background, w, h);
  for (const p of track) {
    ctx.fillStyle = p.isInlier ? '#4ad07f' : '#ff7a6b';
    ctx.beginPath();
    ctx.arc(p.point.x, p.point.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#ffb43c';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(S.a.x, S.a.y); ctx.lineTo(S.b.x, S.b.y); ctx.stroke();
}
