const assert = require('assert');
const { measureSkew, rotateGray, otsuThreshold } = require('../deskew-core');

const W = 700;
const H = 900;

// a page of text lines, tilted by `degrees` (positive tilts them down to the right)
function textPage(degrees) {
  const gray = new Uint8Array(W * H).fill(255);
  const slope = Math.tan(degrees * Math.PI / 180);
  for (let row = 0; row < 24; row++) {
    const baseline = 110 + row * 30;
    const end = row % 5 === 4 ? 400 : 600;
    for (let x = 100; x < end; x++) {
      const y = Math.round(baseline + (x - W / 2) * slope);
      for (let t = 0; t < 6; t++) {
        const yy = y + t;
        if (yy >= 0 && yy < H) gray[yy * W + x] = 20;
      }
    }
  }
  return gray;
}

// the same page drawn four times as large, which is the size a real one arrives at
function bigTextPage(degrees) {
  const scale = 4;
  const w = W * scale, h = H * scale;
  const small = textPage(degrees);
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) gray[y * w + x] = small[((y / scale) | 0) * W + ((x / scale) | 0)];
  }
  return { gray, w, h };
}

function run() {
  // 1. a known tilt is measured back, in both directions
  [1.7, -2.4, 0.6, 4].forEach((tilt) => {
    const found = measureSkew(textPage(tilt), W, H);
    assert.ok(Math.abs(found - tilt) < 0.15, `tilted ${tilt}°, measured ${found}°`);
  });

  // 2. a straight page is left alone
  assert.strictEqual(measureSkew(textPage(0), W, H), 0, 'a straight page needs no correction');

  // 3. pages with nothing to measure must not be guessed at
  assert.strictEqual(measureSkew(new Uint8Array(W * H).fill(255), W, H), 0, 'blank page');
  const noise = new Uint8Array(W * H);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 256;
  assert.strictEqual(measureSkew(noise, W, H), 0, 'noise is not text');

  // 4. Otsu separates ink from paper rather than picking a fixed threshold
  const dim = new Uint8Array(W * H).fill(180);
  for (let i = 0; i < dim.length; i += 3) dim[i] = 90;
  const threshold = otsuThreshold(dim);
  assert.ok(threshold >= 90 && threshold < 180, `threshold ${threshold} must split the two peaks apart`);

  // 5. the measurement does not depend on the resolution the page came in at
  const big = bigTextPage(2.1);
  const found = measureSkew(big.gray, big.w, big.h);
  assert.ok(Math.abs(found - 2.1) < 0.15, `full-size page tilted 2.1°, measured ${found}°`);

  // 6. turning a page by what was measured leaves it straight: the whole point,
  //    and the one place the two halves have to agree about which way is which
  [1.7, -2.4].forEach((tilt) => {
    const page = textPage(tilt);
    const straight = rotateGray(page, W, H, measureSkew(page, W, H));
    const left = measureSkew(straight, W, H);
    assert.ok(Math.abs(left) < 0.2, `tilted ${tilt}°, straightened, ${left}° left over`);
  });

  // 7. nothing is invented outside the sheet: the corners come in as paper
  const turned = rotateGray(textPage(0), W, H, 3);
  assert.strictEqual(turned[0], 255, 'the corner a rotation empties must be paper');
  assert.strictEqual(rotateGray(textPage(0), W, H, 0)[0], 255, 'no angle, no work');

  // 8. the type survives the turn: as much ink as before, give or take the edges
  const inkOf = (g) => g.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);
  const before = inkOf(textPage(1.2));
  const after = inkOf(rotateGray(textPage(1.2), W, H, 1.2));
  assert.ok(Math.abs(after - before) < before * 0.1,
    `ink went from ${before} to ${after} pixels through the rotation`);

  console.log('deskew: all assertions passed');
}

run();
