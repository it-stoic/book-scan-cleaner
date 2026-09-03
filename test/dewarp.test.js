const assert = require('assert');
const { buildModel, mapToWarped, dewarpGray } = require('../dewarp-core');

const W = 700;
const H = 900;
const TOP = 110;      // where the block of type starts
const BOTTOM = 800;   // and where it ends

// a page of straight text lines, each column then pushed down by `bow(x)`
function textPage(bow) {
  const gray = new Uint8Array(W * H).fill(255);
  for (let row = 0; row < 24; row++) {
    const baseline = TOP + row * 30;
    for (let x = 100; x < 600; x++) {
      const y = Math.round(baseline + bow(x));
      for (let t = 0; t < 6; t++) {
        if (y + t >= 0 && y + t < H) gray[(y + t) * W + x] = 20;
      }
    }
  }
  return gray;
}

// how sharply the ink piles into rows: straight lines spike, bowed ones smear
function rowSharpness(gray) {
  const rows = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) if (gray[y * W + x] < 128) rows[y]++;
  }
  let score = 0;
  for (let y = 0; y < H; y++) score += rows[y] * rows[y];
  return score;
}

function curve(y, bow) {
  const points = [];
  for (let i = 0; i <= 32; i++) {
    const x = 100 + (500 * i) / 32;
    points.push({ x, y: y + bow(x) });
  }
  return points;
}

function run() {
  const flat = () => 0;
  // a bow that leaves the ends alone and sags 40 pixels in the middle
  const sag = (x) => 40 * Math.sin(Math.PI * (x - 100) / 500);

  // 1. two straight curves describe a flat page, and a flat page is left as it is
  const straight = textPage(flat);
  const untouched = dewarpGray(straight, W, H, curve(TOP, flat), curve(BOTTOM, flat));
  let moved = 0;
  for (let i = 0; i < straight.length; i++) if (Math.abs(untouched[i] - straight[i]) > 8) moved++;
  assert.ok(moved < straight.length * 0.01,
    `a flat page must come back as it went in, ${moved} pixels differ`);

  // 2. the point of the whole thing: a bowed page comes back with straight lines
  const bowed = textPage(sag);
  const flattened = dewarpGray(bowed, W, H, curve(TOP, sag), curve(BOTTOM, sag));
  const before = rowSharpness(bowed);
  const after = rowSharpness(flattened);
  const ideal = rowSharpness(straight);
  assert.ok(after > before * 2, `bowed page scored ${before}, flattened only ${after}`);
  assert.ok(after > ideal * 0.6,
    `flattened page scored ${after}, a page that was never bowed scores ${ideal}`);

  // 3. the type survives: as much ink as went in, give or take the edges
  const inkOf = (g) => g.reduce((n, v) => n + (v < 128 ? 1 : 0), 0);
  assert.ok(Math.abs(inkOf(flattened) - inkOf(bowed)) < inkOf(bowed) * 0.1,
    `ink went from ${inkOf(bowed)} to ${inkOf(flattened)} pixels through the flattening`);

  // 4. the corners of the model land on the curves they were built from
  const model = buildModel(curve(TOP, sag), curve(BOTTOM, sag));
  const topLeft = mapToWarped(model, 0, 0);
  const bottomRight = mapToWarped(model, 1, 1);
  assert.ok(Math.hypot(topLeft.x - 100, topLeft.y - TOP) < 2,
    `the top left of the model should sit at the start of the top curve, got ${JSON.stringify(topLeft)}`);
  assert.ok(Math.hypot(bottomRight.x - 600, bottomRight.y - BOTTOM) < 2,
    `the bottom right should sit at the end of the bottom curve, got ${JSON.stringify(bottomRight)}`);

  // 5. the middle of the top curve is followed down into the sag, not cut across it
  const middle = mapToWarped(model, 0.5, 0);
  assert.ok(Math.abs(middle.y - (TOP + 40)) < 6,
    `halfway along, the top curve sags to ${TOP + 40}, the model read ${middle.y}`);

  // 6. curves that cannot pin a surface down are refused rather than guessed at
  assert.strictEqual(buildModel([{ x: 0, y: 0 }], curve(BOTTOM, flat)), null, 'one point is not a curve');
  assert.strictEqual(buildModel(null, null), null, 'no curves at all');
  const degenerate = [{ x: 100, y: TOP }, { x: 100, y: TOP }];
  assert.strictEqual(buildModel(degenerate, degenerate), null, 'a curve with no width');

  console.log('dewarp: all assertions passed');
}

run();
