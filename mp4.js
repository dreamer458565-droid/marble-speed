// MP4/MOV 헤더를 직접 읽어 영상 트랙의 정확한 프레임레이트를 구한다.
//
// 왜 헤더를 파싱하는가: 재생하면서 프레임 간격을 재는 방법은 못 믿는다.
// 브라우저가 프레임을 건너뛰면 간격이 뻥튀기되고, 재생속도를 낮추면
// requestVideoFrameCallback 이 아예 안 불리기도 한다.
// 파일 안에는 정확한 답(시간 단위 + 샘플별 길이)이 들어 있으므로 그걸 읽는다.
//
// 이 값이 필요한 이유: 아이폰이 슬로모를 240fps 원본으로 주는지,
// 8배 느리게 늘린 30fps 로 주는지에 따라 실제 속도가 8배 달라진다.

/** 영상 프레임레이트는 늘 정해진 값 중 하나다. 컨테이너 반올림 오차를 걷어낸다. */
function snapToStandardRate(fps) {
  const standard = [24, 25, 30, 48, 50, 60, 100, 120, 240];
  for (const s of standard) if (Math.abs(fps - s) / s < 0.04) return s;
  return fps;
}

const u32 = (dv, o) => dv.getUint32(o);
const type = (dv, o) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/** 파일 맨 위 상자들을 훑어 moov 상자의 위치를 찾는다. 파일 끝에 있는 경우도 있다. */
async function findBox(file, wanted) {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    if (head.byteLength < 8) return null;
    let size = u32(head, 0);
    const name = type(head, 4);
    let headerSize = 8;
    if (size === 1) {
      if (head.byteLength < 16) return null;
      // 64비트 크기 — 상위 32비트는 사실상 항상 0이다
      size = head.getUint32(8) * 2 ** 32 + head.getUint32(12);
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - offset;      // 파일 끝까지
    }
    if (size < headerSize) return null;
    if (name === wanted) {
      return file.slice(offset + headerSize, offset + size);
    }
    offset += size;
  }
  return null;
}

/** 어떤 상자 안에서 자식 상자들을 훑는다 */
function* children(dv, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(dv, o);
    const name = type(dv, o + 4);
    let headerSize = 8;
    if (size === 1) {
      if (o + 16 > end) return;
      size = dv.getUint32(o + 8) * 2 ** 32 + dv.getUint32(o + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < headerSize || o + size > end) return;
    yield { name, start: o + headerSize, end: o + size };
    o += size;
  }
}

function find(dv, range, name) {
  for (const c of children(dv, range.start, range.end)) if (c.name === name) return c;
  return null;
}

/** mdhd 에서 시간 단위를 읽는다 */
function readTimescale(dv, box) {
  const version = dv.getUint8(box.start);
  return version === 1 ? u32(dv, box.start + 20) : u32(dv, box.start + 12);
}

/** hdlr 에서 트랙 종류를 읽는다 ('vide' 면 영상) */
function readHandler(dv, box) {
  return type(dv, box.start + 8);
}

/** stts(샘플별 길이 표)에서 총 프레임 수와 총 길이를 구한다 */
function readStts(dv, box) {
  const count = u32(dv, box.start + 4);
  let samples = 0, duration = 0;
  let o = box.start + 8;
  for (let i = 0; i < count && o + 8 <= box.end; i++, o += 8) {
    const n = u32(dv, o), delta = u32(dv, o + 4);
    samples += n;
    duration += n * delta;
  }
  return { samples, duration };
}

/**
 * 영상 파일의 정확한 프레임레이트와 프레임 수.
 * @returns {{fps:number, frames:number, duration:number}|null} 못 읽으면 null
 */
export async function readVideoTrackInfo(file) {
  try {
    const moovBlob = await findBox(file, 'moov');
    if (!moovBlob) return null;
    const buf = await moovBlob.arrayBuffer();
    const dv = new DataView(buf);
    const root = { start: 0, end: buf.byteLength };

    for (const trak of children(dv, root.start, root.end)) {
      if (trak.name !== 'trak') continue;
      const mdia = find(dv, trak, 'mdia');
      if (!mdia) continue;
      const hdlr = find(dv, mdia, 'hdlr');
      if (!hdlr || readHandler(dv, hdlr) !== 'vide') continue;

      const mdhd = find(dv, mdia, 'mdhd');
      const minf = find(dv, mdia, 'minf');
      const stbl = minf && find(dv, minf, 'stbl');
      const stts = stbl && find(dv, stbl, 'stts');
      if (!mdhd || !stts) continue;

      const timescale = readTimescale(dv, mdhd);
      const { samples, duration } = readStts(dv, stts);
      if (!(timescale > 0) || !(samples > 0) || !(duration > 0)) continue;

      return {
        fps: snapToStandardRate((samples * timescale) / duration),
        frames: samples,
        duration: duration / timescale,
      };
    }
    return null;
  } catch (_) {
    return null;      // 못 읽으면 재생 기반 추정으로 넘어간다
  }
}
