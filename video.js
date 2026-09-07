// 브라우저에서 동영상 프레임을 꺼내 흑백으로 바꾸는 부분.
//
// WebCodecs 는 컨테이너를 직접 해체해야 해서 외부 라이브러리가 필요하다.
// 대신 <video> + requestVideoFrameCallback 을 쓴다 — 의존성이 없고 사파리에서도 돈다.
//
// 시간 보정이 핵심이다. 아이폰이 슬로모 파일을 넘길 때
//   (a) 240fps 원본 그대로 주거나
//   (b) 느리게 늘린 30fps 로 변환해서 준다
// 어느 쪽이든 프레임 수는 같다. 그래서 "컨테이너 fps ÷ 촬영 fps" 를 곱하면
// 두 경우 모두 실제 시간으로 되돌릴 수 있다.

export async function openVideo(file) {
  // 이전에 쓰던 것이 있으면 정리한다
  document.querySelectorAll('video[data-marble]').forEach(v => {
    try { URL.revokeObjectURL(v.src); } catch (_) {}
    v.remove();
  });

  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.preload = 'auto';
  video.dataset.marble = '1';
  // 화면에서 떼어 놓으면 브라우저가 합성을 생략해 프레임 콜백이 오지 않는다.
  // 보이지 않게 아주 작게 붙여 둔다 (display:none 은 같은 이유로 안 된다).
  video.style.cssText =
    'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(video);
  video.src = URL.createObjectURL(file);

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('영상을 읽지 못했습니다. 다른 파일을 골라 보세요.'));
  });

  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('영상 크기를 알 수 없습니다.');
  }
  return {
    el: video,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
  };
}

/** 분석용 축소 크기. 구슬이 최소 4~5px 은 되어야 추적된다. */
export function analysisSize(width, height, targetWidth = 640) {
  const scale = Math.min(1, targetWidth / width);
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
    scale,
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
}

/** RGBA → 휘도. 사람 눈 감도에 맞춘 가중치를 쓴다. */
function toLuma(imageData, out) {
  const d = imageData.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    out[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  }
  return out;
}

/** 영상 전체에 골고루 퍼진 프레임 몇 장을 뽑는다 (배경 모델용). 재생 대신 탐색을 쓴다. */
export async function sampleFrames(vid, count, size) {
  const { canvas, ctx } = makeCanvas(size.width, size.height);
  const frames = [];
  const dur = vid.duration;
  for (let k = 0; k < count; k++) {
    const t = dur * ((k + 0.5) / count);
    await seekTo(vid.el, Math.min(t, Math.max(0, dur - 0.001)));
    ctx.drawImage(vid.el, 0, 0, size.width, size.height);
    const img = ctx.getImageData(0, 0, size.width, size.height);
    frames.push(toLuma(img, new Uint8Array(size.width * size.height)));
  }
  return frames;
}

function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = () => { if (!done) { done = true; cleanup(); resolve(); } };
    const fail = () => { if (!done) { done = true; cleanup(); reject(new Error('영상 탐색에 실패했습니다.')); } };
    const cleanup = () => {
      video.removeEventListener('seeked', ok);
      video.removeEventListener('error', fail);
      clearTimeout(timer);
    };
    const timer = setTimeout(ok, 3000);   // 탐색이 막히면 그냥 진행한다
    video.addEventListener('seeked', ok);
    video.addEventListener('error', fail);
    video.currentTime = time;
  });
}

/**
 * 영상을 재생하며 프레임마다 콜백한다.
 * @param onFrame (luma, mediaTime) => void
 * @param onProgress (0~1) => void
 */
export async function streamFrames(vid, size, onFrame, onProgress, playbackRate = 2) {
  const video = vid.el;
  const { canvas, ctx } = makeCanvas(size.width, size.height);
  const luma = new Uint8Array(size.width * size.height);

  await seekTo(video, 0);

  // 재생을 바로 시작하면 디코더가 못 따라와, 화면은 첫 프레임에 멈춘 채
  // 미디어 시각만 흐르는 구간이 생긴다. 그 프레임들은 타임스탬프가 거짓이다.
  // 충분히 버퍼링될 때까지 기다려 이 구간을 줄인다.
  if (video.readyState < 4) {
    await new Promise((r) => {
      const done = () => { video.removeEventListener('canplaythrough', done); clearTimeout(t); r(); };
      const t = setTimeout(done, 4000);
      video.addEventListener('canplaythrough', done);
    });
  }
  video.playbackRate = playbackRate;

  if (!('requestVideoFrameCallback' in video)) {
    throw new Error('이 브라우저는 프레임 단위 읽기를 지원하지 않습니다. 사파리나 크롬 최신판을 써 주세요.');
  }

  return new Promise((resolve, reject) => {
    let count = 0;
    let finished = false;

    // 화면이 가려지면 프레임 합성이 멈춰 콜백이 오지 않는다.
    // 그런데 재생 자체는 계속 흘러서, 그냥 두면 아무것도 못 읽은 채 영상만 끝나 버린다.
    // 그래서 가려지면 재생을 세우고, 돌아오면 이어서 재생한다.
    // visibilitychange 는 '바뀔 때'만 온다. 시작 시점에 이미 가려져 있으면
    // 이벤트가 없어 그대로 재생돼 버리므로, 현재 상태를 직접 확인해 맞춘다.
    const atEnd = () =>
      video.ended || (video.duration > 0 && video.currentTime >= video.duration - 0.02);

    const syncPlayback = () => {
      if (finished) return;
      // 'ended' 이벤트는 가려진 채로 끝에 닿으면 유실될 수 있다.
      // 끝까지 갔는지는 이벤트가 아니라 재생 위치로 직접 판단한다.
      if (atEnd()) { finish(); return; }
      if (document.visibilityState === 'hidden') {
        if (!video.paused) video.pause();
      } else if (video.paused) {
        video.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', syncPlayback);
    // 이벤트를 놓쳐도 분석이 멈춰 있지 않도록 주기적으로 상태를 확인한다
    const watchdog = setInterval(syncPlayback, 500);

    const settle = (fn, arg) => {
      if (finished) return;
      finished = true;
      clearInterval(watchdog);
      document.removeEventListener('visibilitychange', syncPlayback);
      video.pause();
      fn(arg);
    };
    const finish = () => settle(resolve, count);
    const abort = (e) => settle(reject, e);

    const onTick = (_now, meta) => {
      if (finished) return;
      try {
        ctx.drawImage(video, 0, 0, size.width, size.height);
        const img = ctx.getImageData(0, 0, size.width, size.height);
        onFrame(toLuma(img, luma), meta.mediaTime);
        count++;
        if (onProgress && vid.duration > 0) {
          onProgress(Math.min(1, meta.mediaTime / vid.duration));
        }
      } catch (e) {
        abort(e);
        return;
      }
      video.requestVideoFrameCallback(onTick);
    };

    video.addEventListener('ended', finish, { once: true });
    video.requestVideoFrameCallback(onTick);
    syncPlayback();      // 지금 보이는 상태면 재생, 가려져 있으면 보일 때까지 대기
  });
}

/**
 * 영상 파일이 실제로 초당 몇 장을 담고 있는지 잰다.
 *
 * 이게 왜 필요한가: 아이폰이 슬로모를 넘길 때 240fps 원본을 그대로 주기도 하고,
 * 8배 느리게 늘린 30fps 로 변환해 주기도 한다. 둘을 구분 못 하면 속도가 8배 틀린다.
 *
 * 재생 중 브라우저가 프레임을 건너뛰면 간격이 뻥튀기되므로,
 * 아주 느리게 재생해서 한 장도 빠뜨리지 않는 상태로 잰다.
 */
export async function probeContainerFps(vid, probeSeconds = 0.5) {
  const video = vid.el;
  if (!('requestVideoFrameCallback' in video)) return null;
  await seekTo(video, 0);
  video.playbackRate = 0.15;

  const times = [];
  const estimate = () => {
    const d = [];
    for (let i = 1; i < times.length; i++) {
      const x = times[i] - times[i - 1];
      if (x > 1e-6) d.push(x);
    }
    if (d.length < 3) return null;
    d.sort((a, b) => a - b);
    // 가장 짧은 간격을 그냥 쓰면 안 된다. .mov 타임스케일(보통 600)이 240fps 를
    // 정수로 못 나눠서 간격이 2틱/3틱으로 번갈아 찍히기 때문이다.
    // 중앙값 근처만 남겨 평균을 내면 이 양자화가 상쇄된다.
    // (재생 중 건너뛴 프레임은 간격이 2배 이상이라 이 범위 밖으로 빠진다)
    const median = d[d.length >> 1];
    const kept = d.filter(x => x >= median * 0.5 && x <= median * 1.5);
    if (!kept.length) return null;
    const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
    return mean > 0 ? snapToStandardRate(1 / mean) : null;
  };

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.pause();
      video.playbackRate = 1;
      resolve(estimate());
    };
    const guard = setTimeout(finish, 12000);
    const tick = (_now, meta) => {
      if (done) return;
      times.push(meta.mediaTime);
      if (meta.mediaTime >= probeSeconds || times.length > 400) {
        clearTimeout(guard); finish(); return;
      }
      video.requestVideoFrameCallback(tick);
    };
    video.addEventListener('ended', () => { clearTimeout(guard); finish(); }, { once: true });
    video.requestVideoFrameCallback(tick);
    video.play().catch(() => { clearTimeout(guard); finish(); });
  });
}

/** 영상 프레임레이트는 늘 정해진 값 중 하나다. 가까우면 그 값으로 맞춘다. */
function snapToStandardRate(fps) {
  const standard = [24, 25, 30, 48, 50, 60, 100, 120, 240];
  for (const s of standard) {
    if (Math.abs(fps - s) / s < 0.08) return s;
  }
  return fps;
}

/** 프레임을 하나도 안 놓칠 만한 재생 속도. 화면 주사율(60Hz)을 넘기지 않게 잡는다. */
export function safePlaybackRate(containerFps) {
  if (!(containerFps > 0)) return 1;
  // 하한 0.25 — 이보다 느리게 재생하면 requestVideoFrameCallback 이 아예 안 불린다.
  return Math.max(0.25, Math.min(4, 45 / containerFps));
}

/**
 * 컨테이너 시간 → 실제 시간 배율.
 * 아이폰이 슬로모를 느리게 늘려 저장했으면 컨테이너 fps 가 촬영 fps 보다 낮다.
 * 그 비율만큼 시간을 압축해야 실제 속도가 나온다.
 */
export function timeScale(containerFps, captureFps) {
  if (!(containerFps > 0) || !(captureFps > 0)) return 1;
  // 30fps 로 늘려 저장된 240fps 촬영본이면 0.125 → 시간을 8배 압축한다.
  // 원본 그대로면 240/240 = 1 → 손대지 않는다.
  return Math.min(1, containerFps / captureFps);
}

// ── 카메라로 바로 재기 ──────────────────────────────────────
//
// 브라우저는 240fps 를 열어 주지 않는다 (iOS 사파리는 최대 60fps).
// 그래서 슬로모 파일보다 정확도가 낮다. 대신 파일을 주고받을 필요가 없다.
//
// 시간은 파일과 달리 '지금 몇 시'로 재야 한다.
// requestVideoFrameCallback 이 주는 captureTime(카메라가 실제로 찍은 시각)이 가장 정확하고,
// 없으면 mediaTime, 그것도 없으면 콜백이 불린 시각을 쓴다.
// 단위가 섞이면 통째로 틀리므로 첫 프레임에서 한 가지를 골라 끝까지 그것만 쓴다.

export async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('이 브라우저에서는 카메라를 쓸 수 없습니다. 영상 파일을 골라 주세요.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },   // 뒷면 카메라
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60, min: 30 },
      },
    });
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      throw new Error('카메라 사용을 허용해 주세요. 주소창의 자물쇠를 눌러 권한을 켤 수 있습니다.');
    }
    throw new Error('카메라를 열지 못했습니다: ' + (e?.message || e));
  }
  return attachStream(stream);
}

/** MediaStream 을 화면에 붙여 프레임을 꺼낼 수 있게 만든다 */
export async function attachStream(stream) {
  document.querySelectorAll('video[data-marble-cam]').forEach(v => v.remove());

  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.dataset.marbleCam = '1';
  video.srcObject = stream;
  video.style.cssText = 'width:100%;height:auto;display:block';

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('카메라 화면을 읽지 못했습니다.'));
    setTimeout(resolve, 4000);
  });
  await video.play().catch(() => {});

  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  return {
    el: video,
    stream,
    width: video.videoWidth || settings.width || 1280,
    height: video.videoHeight || settings.height || 720,
    frameRate: settings.frameRate || null,
  };
}

export function closeCamera(cam) {
  try { cam?.stream?.getTracks()?.forEach(t => t.stop()); } catch (_) {}
  try { cam?.el?.remove(); } catch (_) {}
}

/** 첫 프레임에서 쓸 시각 출처를 정한다. 단위가 섞이면 안 되므로 하나만 골라 고정한다. */
function chooseClock(meta) {
  if (typeof meta.captureTime === 'number' && meta.captureTime > 0) {
    return { pick: (m) => m.captureTime / 1000, name: 'captureTime' };
  }
  if (typeof meta.mediaTime === 'number' && meta.mediaTime > 0) {
    return { pick: (m) => m.mediaTime, name: 'mediaTime' };
  }
  return { pick: (_m, now) => now / 1000, name: 'now' };
}

/**
 * 카메라 화면에서 프레임을 계속 꺼낸다. stop() 을 부를 때까지 이어진다.
 * @returns {{stop:()=>void, done:Promise<{frames:number, clock:string}>}}
 */
export function streamCameraFrames(cam, size, onFrame) {
  const video = cam.el;
  const { ctx } = makeCanvas(size.width, size.height);
  const luma = new Uint8Array(size.width * size.height);

  let stopped = false;
  let frames = 0;
  let clock = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  if (!('requestVideoFrameCallback' in video)) {
    stopped = true;
    resolveDone({ frames: 0, clock: 'none' });
    return { stop: () => {}, done };
  }

  const tick = (now, meta) => {
    if (stopped) return;
    if (!clock) clock = chooseClock(meta);
    try {
      ctx.drawImage(video, 0, 0, size.width, size.height);
      const img = ctx.getImageData(0, 0, size.width, size.height);
      onFrame(toLuma(img, luma), clock.pick(meta, now));
      frames++;
    } catch (_) { /* 한 장 실패는 넘어간다 */ }
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      resolveDone({ frames, clock: clock?.name || 'none' });
    },
    done,
  };
}
