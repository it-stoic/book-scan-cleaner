const assert = require('assert');
const { clean, whiten, despeckle, deband, strokeWidth, textBox, threshold } = require('../clean-core');

const W = 800;
const H = 1000;
const INK = 60;

/*
 * A page the way a scanner hands it over: paper that darkens towards the left
 * the way it does next to a gutter, a block of type in the middle, and dirt.
 * The type carries separate little marks above the strokes, which is what the
 * dot on an i and the caron on a c and a z look like to any of this code.
 */
function fixture() {
  const gray = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) gray[y * W + x] = Math.round(150 + 85 * (x / W));
  }

  const box = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) gray[y * W + x] = INK;
    }
  };

  const marks = [];
  for (let y = 150; y <= 780; y += 30) {
    for (let x = 100; x <= 690; x += 12) {
      box(x, y, 3, 18);
      // every fourth stroke wears a mark, four pixels clear of its stroke
      if (((x - 100) / 12) % 4 === 0) {
        box(x, y - 7, 3, 3);
        marks.push({ x: x + 1, y: y - 6 });
      }
    }
  }

  // dirt in the margins, each speck alone in an empty stretch of paper
  const specks = [[40, 60], [760, 120], [50, 950], [700, 960], [400, 40]];
  specks.forEach(([x, y]) => box(x, y, 3, 3));

  // a page number below the text block: small marks, but far too big to be dirt
  const pageNumber = [];
  for (let x = 380; x < 400; x += 10) {
    box(x, 900, 4, 20);
    pageNumber.push({ x: x + 1, y: 910 });
  }

  // a note in the left margin, with a speck of its own three pixels above it:
  // small and outside the text, and saved only by the ink next to it
  box(30, 500, 4, 20);
  const punctuation = { x: 31, y: 495 };
  box(30, 494, 3, 3);

  return { gray, marks, specks, pageNumber, punctuation };
}

const at = (page, x, y) => page[y * W + x];

function run() {
  const { gray, marks, specks, pageNumber, punctuation } = fixture();

  /* --- the paper goes white and the type does not -------------------------- */

  const white = whiten(gray, W, H, 0.5);
  assert.ok(at(white, 10, 10) >= 250, 'shadowed paper should come out white');
  assert.ok(at(white, 790, 10) >= 250, 'light paper should stay white');
  assert.ok(at(white, 101, 160) <= 150, 'a stroke in the shadow should stay dark');
  assert.ok(at(white, 689, 760) <= 150, 'a stroke in the light should stay dark');
  marks.forEach((m) => {
    assert.ok(at(white, m.x, m.y) <= 150, `mark at ${m.x},${m.y} should survive whitening`);
  });

  /* --- a stroke is measured, not guessed ---------------------------------- */

  const cut = threshold(white);
  const stroke = strokeWidth(white, W, H, cut);
  assert.ok(stroke >= 3 && stroke <= 4, `stroke width should be about 3, got ${stroke}`);

  const box = textBox(white, W, H, cut);
  assert.ok(box.y0 <= 143 && box.y1 >= 798, 'the text box should cover the block of type');
  assert.ok(box.x0 <= 100 && box.x1 >= 690, 'the text box should span the block of type');
  assert.ok(box.y1 < 880, 'the text box should stop above the page number');

  /* --- dirt goes, everything shaped like type stays ----------------------- */

  const result = despeckle(white, W, H, { threshold: cut });
  assert.strictEqual(result.removed, specks.length, 'every speck and nothing else');

  specks.forEach(([x, y]) => {
    assert.strictEqual(at(result.gray, x + 1, y + 1), 255, `speck at ${x},${y} should be gone`);
  });
  marks.forEach((m) => {
    assert.ok(at(result.gray, m.x, m.y) <= 150, `mark at ${m.x},${m.y} should survive`);
  });
  pageNumber.forEach((p) => {
    assert.ok(at(result.gray, p.x, p.y) <= 150, 'a page number is not dirt');
  });
  assert.ok(
    at(result.gray, punctuation.x, punctuation.y) <= 150,
    'a small mark next to ink in the margin is punctuation, not dirt',
  );

  /* --- and the two steps together ----------------------------------------- */

  const both = clean(gray, W, H, { despeckle: true });
  assert.strictEqual(both.removed, specks.length);
  assert.ok(at(both.gray, 10, 10) >= 250);
  marks.forEach((m) => {
    assert.ok(at(both.gray, m.x, m.y) <= 150, 'marks survive the whole run');
  });

  const gentle = clean(gray, W, H, { despeckle: false });
  assert.strictEqual(gentle.removed, 0, 'nothing is removed unless asked for');
  specks.forEach(([x, y]) => {
    assert.ok(at(gentle.gray, x + 1, y + 1) <= 150, 'specks stay when despeckling is off');
  });

  /* --- the scanner's own bands go, the book's own blocks stay ------------- */

  const banded = new Uint8Array(white);
  const fill = (x0, y0, bw, bh) => {
    for (let y = y0; y < y0 + bh; y++) {
      for (let x = x0; x < x0 + bw; x++) banded[y * W + x] = INK;
    }
  };
  fill(10, 100, 6, 700);      // the strip a scanner lid leaves down the side
  fill(690, 400, 90, 200);    // a plate on the page, as wide as it is tall

  const debanded = deband(banded, W, H, { threshold: cut });
  assert.strictEqual(debanded.removed, 1, 'the strip and nothing else');
  assert.strictEqual(at(debanded.gray, 12, 400), 255, 'the strip should be gone');
  assert.ok(at(debanded.gray, 730, 500) <= 150, 'a plate is not a band');
  marks.forEach((m) => {
    assert.ok(at(debanded.gray, m.x, m.y) <= 150, 'marks survive band removal');
  });

  /* --- a mark or two is company, a cloud of them is not ------------------- */

  // marks that have nothing beside them but each other are still marks: the
  // second and third dots of an ellipsis, a colon, a pair of opening quotes
  const dotted = new Uint8Array(white);
  const dots = [[150, 860], [161, 860], [172, 860], [300, 855], [300, 866]];
  dots.forEach(([x, y]) => {
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) dotted[(y + dy) * W + x + dx] = INK;
  });
  const kept = despeckle(dotted, W, H, { threshold: cut, stroke: stroke });
  dots.forEach(([x, y]) => {
    assert.ok(at(kept.gray, x + 1, y + 1) <= 150, `the mark at ${x},${y} has company and stays`);
  });

  // a cloud of stipple has nothing but itself either, and the difference is
  // that there is a great deal of it. This is the scatter a smear throws off,
  // and under the old count every fleck of it was saved by all the others.
  const clouded = new Uint8Array(white);
  let grain = 5;
  const roll = () => (grain = (grain * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let sown = 0;
  for (let y = 20; y < 90; y++) {
    for (let x = 500; x < 570; x++) {
      if (roll() < 0.12) { clouded[y * W + x] = INK; sown++; }
    }
  }
  assert.ok(sown > 400, 'the fixture should have a cloud worth removing');
  const swept = despeckle(clouded, W, H, { threshold: cut, stroke: stroke });
  let left = 0;
  for (let y = 20; y < 90; y++) {
    for (let x = 500; x < 570; x++) if (swept.gray[y * W + x] <= 150) left++;
  }
  assert.ok(left < sown * 0.15, `a cloud is not company: ${left} of ${sown} left standing`);
  marks.forEach((m) => {
    assert.ok(at(swept.gray, m.x, m.y) <= 150, 'marks survive a cloud being swept');
  });
  pageNumber.forEach((p) => {
    assert.ok(at(swept.gray, p.x, p.y) <= 150, 'a page number survives it too');
  });

  /* --- the scanner's smears come off, printed blocks stay ----------------- */

  // a burn has no shape to speak of: a dark core frayed out into stipple, too
  // nearly square for the band rule and far too crowded for the speck rule
  const burn = (page, cx, y0, half, tall) => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let y = y0; y < y0 + tall; y++) {
      const fade = 1 - (y - y0) / tall;
      for (let x = cx - half; x <= cx + half; x++) {
        const away = Math.abs(x - cx) / half;
        if (rnd() < (1 - away * away) * (0.35 + 0.65 * fade)) page[y * W + x] = 40;
      }
    }
  };
  const inkIn = (page, x0, y0, x1, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (page[y * W + x] < 128) n++;
    return n;
  };

  const smeared = new Uint8Array(white);
  burn(smeared, 250, 0, 40, 110);   // in the head margin, clear of the type
  const burnt = inkIn(smeared, 210, 0, 291, 110);
  assert.ok(burnt > 1500, 'the fixture should have a burn worth removing');

  const cleared = deband(smeared, W, H, { threshold: cut, stroke: stroke });
  assert.ok(
    inkIn(cleared.gray, 210, 0, 291, 110) < burnt * 0.1,
    'a burn in the margin should come off',
  );
  marks.forEach((m) => {
    assert.ok(at(cleared.gray, m.x, m.y) <= 150, 'marks survive a burn being cleared');
  });

  // the same measurement of density reads a printed block, however narrow, and
  // has to leave it: what a burn has and a press has not is a fringe it fades
  // into, so ink that stays solid to the last tile was put there on purpose
  const plated = new Uint8Array(white);
  for (let y = 400; y < 600; y++) {
    for (let x = 720; x < 780; x++) plated[y * W + x] = INK;
  }
  const plates = deband(plated, W, H, { threshold: cut, stroke: stroke });
  assert.strictEqual(plates.removed, 0, 'a solid block is printed, however narrow');
  assert.ok(at(plates.gray, 750, 500) <= 150, 'a narrow plate is not a smear');

  // and where a burn runs up against a column of type, the fringe grows into
  // the type, the region comes back too fat to be a burn, and it is refused
  // whole: the cost of this rule is a smear left on the page, never a stroke
  const crowded = new Uint8Array(white);
  burn(crowded, 58, 150, 38, 300);
  const spared = deband(crowded, W, H, { threshold: cut, stroke: stroke });
  for (let y = 150; y <= 780; y += 30) {
    assert.ok(at(spared.gray, 101, y + 9) <= 150, 'type next to a burn is not touched');
  }

  /* --- a blank page has nothing to measure and must not crash ------------- */

  const blank = new Uint8Array(W * H).fill(240);
  const empty = clean(blank, W, H, { despeckle: true });
  assert.strictEqual(empty.removed, 0);

  console.log('clean: ok');
}

run();
