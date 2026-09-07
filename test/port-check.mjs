import { fitTrajectory, theoreticalAcceleration } from '../public/analysis.js';

// Swift 판과 같은 선형합동 난수 — 입력 데이터를 완전히 동일하게 만든다
const MASK = (1n << 64n) - 1n;
class LCG {
  constructor(seed) { this.s = BigInt(seed); }
  next() {
    this.s = (this.s * 6364136223846793005n + 1442695040888963407n) & MASK;
    return Number((this.s >> 11n) & 0x1FFFFFFFFFFFFFn) / Number(0x20000000000000n);
  }
  gauss(sigma) {
    const u1 = Math.max(1e-12, this.next()), u2 = this.next();
    return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

function makeTrack({ accel, angleDeg, ppm, fps, duration, noisePx, outliers, seed }) {
  const rng = new LCG(seed);
  const th = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(th), dy = Math.sin(th);
  const n = Math.trunc(duration * fps);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const sPx = 0.5 * accel * t * t * ppm;
    pts.push({ time: t, point: { x: 120 + sPx * dx + rng.gauss(noisePx),
                                 y: 60 + sPx * dy + rng.gauss(noisePx) }, area: 40 });
  }
  for (let k = 0; k < outliers; k++) {
    pts.push({ time: (k * 7 + 3) / fps,
               point: { x: 400 + rng.next() * 200, y: 300 + rng.next() * 100 }, area: 60 });
  }
  return pts.sort((a, b) => a.time - b.time);
}

const trueA = theoreticalAcceleration(25, 'solidSphere');
const track = makeTrack({ accel: trueA, angleDeg: 25, ppm: 600, fps: 240,
                          duration: 0.55, noisePx: 0.3, outliers: 5, seed: 42 });

// Swift 판이 같은 입력에서 낸 값 (앞서 실행한 결과)
const SWIFT = {
  acceleration: 2.955, angle: 25.016, fps: 240.0,
  travel: 0.441, maxSpeed: 1.614, entrySpeed: 0.001,
};

const r = fitTrajectory(track, 600);
console.log('=== Swift ↔ JavaScript 대조 (동일 입력) ===\n');
const rows = [
  ['가속도',     r.acceleration,           SWIFT.acceleration, 'm/s²'],
  ['경사각',     r.trajectoryAngleDegrees, SWIFT.angle,        '°'],
  ['프레임레이트', r.effectiveFrameRate,     SWIFT.fps,          'fps'],
  ['이동 거리',   r.travelDistance,         SWIFT.travel,       'm'],
  ['최고 속도',   r.maxSpeed,               SWIFT.maxSpeed,     'm/s'],
  ['출발 속도',   r.entrySpeed,             SWIFT.entrySpeed,   'm/s'],
];
let allOk = true;
for (const [label, js, swift, unit] of rows) {
  // Swift 출력이 소수 3자리로 반올림돼 있으므로 그 자릿수에서 비교
  const ok = Math.abs(js - swift) < 0.002;
  if (!ok) allOk = false;
  console.log(`  ${ok ? '✅' : '❌'} ${label.padEnd(7)}  JS ${js.toFixed(3).padStart(8)}   Swift ${swift.toFixed(3).padStart(8)}  ${unit}`);
}
console.log(`\n  참값 가속도 ${trueA.toFixed(3)} m/s²  →  JS 오차 ${Math.abs(r.acceleration - trueA).toFixed(4)}`);
console.log(`  이상치 걸러냄 ${r.detectedCount - r.inlierCount}개 / 넣은 이상치 5개`);
console.log(`  사용 프레임 ${r.inlierCount}장`);
console.log(allOk ? '\n두 구현이 일치합니다.' : '\n불일치가 있습니다.');
process.exit(allOk ? 0 : 1);
