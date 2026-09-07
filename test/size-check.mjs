import { BlobDetector, estimateMarbleDiameterPx } from '../analysis.js';

const W = 200, H = 140;

/** 배경 위에 구슬을 그린다. smear > 0 이면 진행 방향으로 번지게 그린다(빠른 움직임 모사). */
function render(cx, cy, r, smear, angleDeg) {
  const px = new Uint8Array(W * H).fill(180);
  const th = angleDeg * Math.PI / 180;
  const ux = Math.cos(th), uy = Math.sin(th);
  const steps = Math.max(1, Math.round(smear * 4));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let cover = 0, n = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const fx = x + (sx + 0.5) / 3, fy = y + (sy + 0.5) / 3;
        // 노출 시간 동안 구슬이 지나간 자리를 합친다
        let hit = 0;
        for (let k = 0; k < steps; k++) {
          const f = steps === 1 ? 0 : (k / (steps - 1) - 0.5) * smear;
          if (Math.hypot(fx - (cx + ux * f), fy - (cy + uy * f)) <= r) { hit = 1; break; }
        }
        cover += hit; n++;
      }
      if (cover) {
        const a = cover / n;
        px[y * W + x] = Math.round(180 * (1 - a) + 30 * a);
      }
    }
  }
  return px;
}

const bg = new Uint8Array(W * H).fill(180);
const det = new BlobDetector(W, H);
const roi = { x0: 0, y0: 0, x1: W - 1, y1: H - 1 };

console.log('=== 구슬 지름 추정 (자 없이 환산할 때 쓰는 값) ===\n');
console.log('  반지름   번짐    참 지름   추정      오차');
let allOk = true;
for (const r of [3, 4.5, 6.4, 9]) {
  for (const smear of [0, 4, 12]) {
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const frame = render(60 + i * 6, 60 + i * 2.8, r, smear, 25);
      const b = det.detect(frame, bg, 24, roi, null, smear > 0);
      if (b) pts.push(b);
    }
    const est = estimateMarbleDiameterPx(pts);
    const truth = 2 * r;
    const err = est ? Math.abs(est - truth) / truth * 100 : NaN;
    const ok = est !== null && err < 12;
    if (!ok) allOk = false;
    console.log(`  ${ok ? '✅' : '❌'} r=${String(r).padStart(4)}  ${String(smear).padStart(2)}px   ${truth.toFixed(1).padStart(5)}px  ${(est ?? NaN).toFixed(2).padStart(6)}px  ${err.toFixed(1).padStart(5)}%   (${pts.length}장)`);
  }
}
console.log(allOk ? '\n번짐이 있어도 지름이 유지됩니다 — 진행 방향과 수직인 폭을 쓰기 때문.'
                  : '\n일부 조건에서 어긋납니다.');
