// 구슬 추적·궤적 적합 — Swift 판 Analysis/ 를 그대로 옮긴 것.
// 순수 계산만 있어 브라우저와 Node 양쪽에서 돈다.

// ── 물리 ────────────────────────────────────────────────────
export const G = 9.80665;

export const BODIES = {
  solidSphere:  { k: 2 / 5, name: '속이 찬 구 (유리구슬·쇠구슬)', short: '구슬' },
  hollowSphere: { k: 2 / 3, name: '속이 빈 구 (탁구공)',        short: '탁구공' },
  solidCylinder:{ k: 1 / 2, name: '원기둥·원판 (동전)',          short: '원판' },
  sliding:      { k: 0,     name: '미끄러짐 (구르지 않음)',      short: '미끄럼' },
};

/** a = g·sinθ / (1 + k) */
export function theoreticalAcceleration(inclineDeg, bodyKey) {
  const k = BODIES[bodyKey].k;
  return (G * Math.sin((inclineDeg * Math.PI) / 180)) / (1 + k);
}

export function energySplit(bodyKey) {
  const k = BODIES[bodyKey].k;
  return { translation: 1 / (1 + k), rotation: k / (1 + k) };
}

// ── 배경 모델 ────────────────────────────────────────────────
/** 픽셀별 중앙값. 구슬은 어느 픽셀에서든 잠깐만 머무르므로 자연히 지워진다. */
export function medianBackground(samples, width, height) {
  const n = samples.length;
  if (n === 0) return null;
  const out = new Uint8Array(width * height);
  const bucket = new Uint8Array(n);
  const mid = n >> 1;
  for (let i = 0; i < out.length; i++) {
    for (let s = 0; s < n; s++) bucket[s] = samples[s][i];
    // n 이 작아 삽입 정렬이 가장 빠르다
    for (let a = 1; a < n; a++) {
      const v = bucket[a];
      let b = a - 1;
      while (b >= 0 && bucket[b] > v) { bucket[b + 1] = bucket[b]; b--; }
      bucket[b + 1] = v;
    }
    out[i] = bucket[mid];
  }
  return out;
}

// ── 구슬 검출 ────────────────────────────────────────────────
export class BlobDetector {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.diff = new Uint8Array(n);
    this.stamp = new Int32Array(n);   // 매 프레임 배열을 지우지 않으려 세대 번호를 쓴다
    this.generation = 0;
    this.stack = new Int32Array(Math.min(n, 1 << 16));
  }

  /** @returns {{area,minX,maxX,minY,maxY,cx,cy}|null} */
  detect(frame, background, threshold, roi, expectedArea) {
    const { width: W, height: H, diff, stamp } = this;
    const x0 = Math.max(0, roi.x0), y0 = Math.max(0, roi.y0);
    const x1 = Math.min(W - 1, roi.x1), y1 = Math.min(H - 1, roi.y1);
    if (x1 < x0 || y1 < y0) return null;

    const gen = ++this.generation;

    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      for (let x = x0; x <= x1; x++) {
        const i = row + x;
        const d = frame[i] - background[i];
        diff[i] = d < 0 ? -d : d;
      }
    }

    let best = null, bestScore = 0;
    const stack = this.stack;

    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      for (let x = x0; x <= x1; x++) {
        const start = row + x;
        if (diff[start] <= threshold || stamp[start] === gen) continue;

        let sp = 0;
        stack[sp++] = start;
        stamp[start] = gen;

        let area = 0, minX = x, maxX = x, minY = y, maxY = y;
        let wsum = 0, wx = 0, wy = 0;

        while (sp > 0) {
          const idx = stack[--sp];
          const py = (idx / W) | 0;
          const px = idx - py * W;
          const w = diff[idx];

          area++; wsum += w; wx += w * px; wy += w * py;
          if (px < minX) minX = px; else if (px > maxX) maxX = px;
          if (py < minY) minY = py; else if (py > maxY) maxY = py;

          if (px > x0)  { const n = idx - 1; if (diff[n] > threshold && stamp[n] !== gen && sp < stack.length) { stamp[n] = gen; stack[sp++] = n; } }
          if (px < x1)  { const n = idx + 1; if (diff[n] > threshold && stamp[n] !== gen && sp < stack.length) { stamp[n] = gen; stack[sp++] = n; } }
          if (py > y0)  { const n = idx - W; if (diff[n] > threshold && stamp[n] !== gen && sp < stack.length) { stamp[n] = gen; stack[sp++] = n; } }
          if (py < y1)  { const n = idx + W; if (diff[n] > threshold && stamp[n] !== gen && sp < stack.length) { stamp[n] = gen; stack[sp++] = n; } }
        }

        if (area < 3 || wsum <= 0) continue;
        // 픽셀 (x,y) 가 덮는 영역은 [x, x+1) 이므로 중심은 x+0.5 다
        const blob = {
          area, minX, maxX, minY, maxY,
          cx: wx / wsum + 0.5,
          cy: wy / wsum + 0.5,
        };
        const score = scoreBlob(blob, expectedArea);
        if (score > bestScore) { bestScore = score; best = blob; }
      }
    }
    return bestScore > 0.05 ? best : null;
  }
}

function scoreBlob(b, expectedArea) {
  const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1;
  const aspect = Math.min(bw, bh) / Math.max(bw, bh);
  const fill = b.area / (bw * bh);
  if (aspect <= 0.35 || fill <= 0.35) return 0;
  const shape = aspect * fill;
  if (!expectedArea || expectedArea <= 0) return shape * Math.min(1, b.area / 200);
  const ratio = b.area / expectedArea;
  if (ratio <= 0.15 || ratio >= 8) return 0;
  return shape * Math.exp(-Math.abs(Math.log(ratio)));
}

// ── 궤적 적합 ────────────────────────────────────────────────
const VELOCITY_WINDOW = 15;

export function fitTrajectory(rawPoints, pixelsPerMeter) {
  const points = [...rawPoints].sort((a, b) => a.time - b.time);
  if (points.length < 6) throw new Error(`구슬을 찾은 프레임이 ${points.length}장뿐입니다. 배경 대비를 높이거나 조명을 밝게 해 다시 찍어 보세요.`);
  if (!(pixelsPerMeter > 0)) throw new Error('거리 환산 기준이 없습니다.');

  // 1) RANSAC 직선 — 경사면을 벗어난 구간·손이 잡힌 프레임이 여기서 걸러진다
  const tol = 3.0;
  const line = ransacLine(points.map(p => p.point), tol);
  if (!line) throw new Error('구슬이 거의 움직이지 않았습니다. 경사를 세우거나 촬영 구간을 늘려 보세요.');

  const marked = points.map(p => ({ ...p, isInlier: distanceToLine(line, p.point) <= tol }));
  let inliers = marked.filter(p => p.isInlier);
  if (inliers.length < 6) throw new Error(`직선 궤적에 맞는 프레임이 ${inliers.length}장뿐입니다.`);

  // 2) 직선 위로 투영 → 1차원 위치
  let dir = { ...line.direction };
  let s = inliers.map(p => projectOnLine(line, p.point));
  if (s[s.length - 1] < s[0]) { s = s.map(v => -v); dir = { x: -dir.x, y: -dir.y }; }

  const span = Math.max(...s) - Math.min(...s);
  if (span <= 5) throw new Error('구슬이 거의 움직이지 않았습니다. 경사를 세우거나 촬영 구간을 늘려 보세요.');

  const sMin = Math.min(...s), t0 = inliers[0].time;
  let distance = s.map(v => (v - sMin) / pixelsPerMeter);
  let times = inliers.map(p => p.time - t0);

  // 3) 2차 적합 → 가속도
  let quad = quadraticFit(times, distance);
  if (quad.residualRMS > 0) {
    const cut = 4 * quad.residualRMS;
    const keep = [];
    for (let i = 0; i < times.length; i++) {
      if (Math.abs(distance[i] - quadValue(quad, times[i])) <= cut) keep.push(i);
    }
    if (keep.length >= 6 && keep.length < times.length) {
      const keepSet = new Set(keep);
      inliers.forEach((p, i) => { if (!keepSet.has(i)) { const m = marked.find(m => m.time === p.time); if (m) m.isInlier = false; } });
      inliers = keep.map(i => inliers[i]);
      times = keep.map(i => times[i]);
      distance = keep.map(i => distance[i]);
      quad = quadraticFit(times, distance);
    }
  }

  // 4) 이동창 선형적합으로 속도 곡선 (그래프용)
  const speeds = windowedSpeeds(times, distance, VELOCITY_WINDOW);
  const samples = times.map((t, i) => ({ time: t, distance: distance[i], speed: speeds[i] }));

  // 5) 대표 속도는 2차 적합에서. 이동창은 양끝에서 창이 한쪽으로만 열려 값이 안쪽으로 끌린다.
  const vFirst = quadSpeed(quad, times[0]);
  const vLast = quadSpeed(quad, times[times.length - 1]);

  // 실제 프레임레이트 — 중앙값이 아니라 중앙값 근처 '평균'.
  // .mov 타임스케일(보통 600)이 240fps 를 정수로 못 나눠 간격이 2틱/3틱으로 번갈아 찍히기 때문.
  const deltas = [];
  for (let i = 1; i < times.length; i++) { const d = times[i] - times[i - 1]; if (d > 0) deltas.push(d); }
  deltas.sort((a, b) => a - b);
  let fps = 0;
  if (deltas.length) {
    const med = deltas[deltas.length >> 1];
    const kept = deltas.filter(d => d >= med * 0.5 && d <= med * 1.5);
    if (kept.length) fps = 1 / (kept.reduce((a, b) => a + b, 0) / kept.length);
  }

  return {
    samples,
    track: marked,
    acceleration: quad.acceleration,
    accelerationStdError: quad.accelerationStdError,
    fitResidualRMS: quad.residualRMS,
    entrySpeed: vFirst,
    exitSpeed: vLast,
    maxSpeed: Math.max(Math.abs(vFirst), Math.abs(vLast)),
    travelDistance: distance[distance.length - 1] - distance[0],
    duration: times[times.length - 1] - times[0],
    trajectoryAngleDegrees: (Math.atan2(Math.abs(dir.y), Math.abs(dir.x)) * 180) / Math.PI,
    effectiveFrameRate: fps,
    inlierCount: inliers.length,
    detectedCount: rawPoints.length,
    get averageSpeed() { return this.duration > 0 ? this.travelDistance / this.duration : 0; },
  };
}

function distanceToLine(line, p) {
  const vx = p.x - line.origin.x, vy = p.y - line.origin.y;
  return Math.abs(vx * line.direction.y - vy * line.direction.x);
}
function projectOnLine(line, p) {
  return (p.x - line.origin.x) * line.direction.x + (p.y - line.origin.y) * line.direction.y;
}

function ransacLine(pts, tolerance) {
  if (pts.length < 2) return null;
  let bestInliers = [];
  const iterations = Math.min(300, Math.max(50, pts.length * 4));
  for (let it = 0; it < iterations; it++) {
    const i = (Math.random() * pts.length) | 0;
    let j = (Math.random() * pts.length) | 0;
    if (i === j) j = (j + 1) % pts.length;
    const a = pts[i], b = pts[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 1) continue;
    const cand = { origin: a, direction: { x: dx / len, y: dy / len } };
    const ins = pts.filter(p => distanceToLine(cand, p) <= tolerance);
    if (ins.length > bestInliers.length) bestInliers = ins;
  }
  if (bestInliers.length < 2) return null;
  return totalLeastSquaresLine(bestInliers);
}

/** 주성분 방향으로 직선을 맞춘다 (수직거리 제곱합 최소화) */
function totalLeastSquaresLine(pts) {
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n;
  const my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx + syy <= 0) return null;
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { origin: { x: mx, y: my }, direction: { x: Math.cos(theta), y: Math.sin(theta) } };
}

function quadValue(q, t) { const u = t - q.tMean; return q.c0 + q.c1 * u + q.c2 * u * u; }
function quadSpeed(q, t) { return q.c1 + 2 * q.c2 * (t - q.tMean); }

/** τ 를 평균 중심으로 옮겨 수치적으로 안정한 최소제곱 2차 적합 */
function quadraticFit(times, values) {
  const n = times.length;
  if (n < 4) throw new Error('점이 너무 적어 등가속도 적합이 안 됩니다.');
  const tMean = times.reduce((a, b) => a + b, 0) / n;
  const tau = times.map(t => t - tMean);

  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const x = tau[i], y = values[i], x2 = x * x;
    s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    b0 += y; b1 += x * y; b2 += x2 * y;
  }
  const inv = invert3x3([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]]);
  if (!inv) throw new Error('궤적을 등가속도 운동으로 설명할 수 없습니다.');
  const b = [b0, b1, b2];
  const c = [0, 1, 2].map(r => inv[r][0] * b[0] + inv[r][1] * b[1] + inv[r][2] * b[2]);

  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const r = values[i] - (c[0] + c[1] * tau[i] + c[2] * tau[i] * tau[i]);
    ssr += r * r;
  }
  const variance = ssr / Math.max(1, n - 3);
  return {
    c0: c[0], c1: c[1], c2: c[2], tMean,
    acceleration: 2 * c[2],
    residualRMS: Math.sqrt(ssr / n),
    accelerationStdError: 2 * Math.sqrt(Math.max(0, variance * inv[2][2])),
  };
}

function invert3x3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-18) return null;
  const q = 1 / det;
  return [
    [(e * i - f * h) * q, (c * h - b * i) * q, (b * f - c * e) * q],
    [(f * g - d * i) * q, (a * i - c * g) * q, (c * d - a * f) * q],
    [(d * h - e * g) * q, (b * g - a * h) * q, (a * e - b * d) * q],
  ];
}

/** 각 점 주변 window 개를 직선으로 맞춰 기울기(속도)를 얻는다 */
function windowedSpeeds(times, distance, window) {
  const n = times.length;
  if (n < 2) return new Array(n).fill(0);
  const half = Math.max(1, Math.min(window, n) >> 1);
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    const count = hi - lo + 1;
    if (count < 2) continue;
    let st = 0, sd = 0;
    for (let k = lo; k <= hi; k++) { st += times[k]; sd += distance[k]; }
    const mt = st / count, md = sd / count;
    let stt = 0, std = 0;
    for (let k = lo; k <= hi; k++) {
      const dt = times[k] - mt;
      stt += dt * dt; std += dt * (distance[k] - md);
    }
    out[i] = stt > 0 ? std / stt : 0;
  }
  return out;
}

// ── 이론 대조 ────────────────────────────────────────────────
export function compareWithTheory(inclineDeg, bodyKey, measuredAcceleration) {
  const theo = theoreticalAcceleration(inclineDeg, bodyKey);
  const sliding = theoreticalAcceleration(inclineDeg, 'sliding');
  const ratio = theo > 0 ? measuredAcceleration / theo : 0;
  let verdict;
  if (inclineDeg <= 2) verdict = 'unreliable';
  else if (ratio > 1.06) verdict = 'likelySlipping';
  else if (ratio < 0.85) verdict = 'energyLoss';
  else verdict = 'matchesTheory';

  const rot = Math.round(energySplit(bodyKey).rotation * 100);
  const detail = {
    matchesTheory: `구슬이 미끄러지지 않고 제대로 굴렀다는 뜻입니다. 위치에너지의 약 ${rot}%가 '앞으로 나아가는 것'이 아니라 '스스로 도는 것'에 쓰이기 때문에, 같은 높이에서 미끄러져 내려올 때보다 느립니다.`,
    likelySlipping: '구슬이 굴러가는 대신 일부 미끄러졌을 가능성이 있습니다. 경사면이 미끄럽거나 경사가 급할 때 생깁니다. 아니면 경사각을 실제보다 작게 잡았을 수도 있으니 각도를 다시 확인해 보세요.',
    energyLoss: '마찰·구름저항 때문에 에너지가 새고 있습니다. 경사면이 울퉁불퉁하거나(카펫·수건), 구슬이 벽을 스치며 내려왔거나, 경사각을 실제보다 크게 잡았을 때 이렇게 나옵니다.',
    unreliable: '경사각이 2도 이하라 이론값 자체가 너무 작아 비교가 무의미합니다. 경사를 더 세우고 다시 찍어 보세요.',
  }[verdict];
  const title = {
    matchesTheory: '이론과 잘 맞습니다',
    likelySlipping: '이론보다 빠릅니다',
    energyLoss: '이론보다 느립니다',
    unreliable: '경사가 너무 완만합니다',
  }[verdict];

  return { inclineDeg, bodyKey, measuredAcceleration, theoreticalAcceleration: theo,
           slidingAcceleration: sliding, ratio, verdict, verdictTitle: title, verdictDetail: detail };
}
