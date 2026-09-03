/*
 * Book Scan Cleaner, https://github.com/it-stoic/book-scan-cleaner
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 * If you host a modified version, its users must be offered its source.
 */
/*
 * Cleans a scanned page in two steps, both of them deliberately timid.
 *
 * Whitening divides the page by an estimate of the paper itself: the page is
 * cut into tiles, each tile's paper level is read off high in its histogram
 * where the text cannot reach, and the page is divided by that surface. Grey
 * paper and the shadow a gutter throws come out white, while every stroke keeps
 * its distance from its own surroundings, so nothing darker than the paper
 * around it can be whitened away.
 *
 * Speck removal is the dangerous half, because the dot on an i, the caron on a
 * c and a full stop are small isolated blobs of ink and so is dirt. Two
 * conditions have to hold at once before a blob is dropped: it is small
 * measured against the stroke width of that same page rather than against a
 * fixed number of pixels, and it sits alone, with a clear run of paper all
 * around it and no ink it could be the punctuation of. Whatever the measurement
 * is unsure about is kept.
 *
 * Being alone is the whole of the protection, and it is nearly enough, because
 * that is what a diacritic never is: the dot has its stem a stroke or two below
 * it, the full stop has the word it ends. What it misses is that a fleck of
 * dirt in the scatter round a smear is not alone either, and hundreds of them
 * standing together used to vote each other innocent. So company is counted as
 * well as looked for. Type beside a mark keeps it, and so do a companion or two
 * with nothing else around, which is an ellipsis or a colon or a pair of
 * quotes. A hundred companions are a cloud, and a cloud is not company.
 *
 * The stipple that is paler than ink is a case of its own, because a rule about
 * ink cannot see it: a grey fleck two thirds of the way to white is not dark
 * enough to be walked at all, and used to survive every pass untouched. It is
 * caught by asking a blob gathered at that pale level whether there is any real
 * printing anywhere inside it, since type and the punctuation set in the same
 * ink are dark in the middle however soft their edges may be.
 *
 * An earlier version also refused to touch anything inside a rectangle drawn
 * around the text, which sounds safer and is not. On a scan of two pages side by
 * side that rectangle covers four fifths of the sheet, so the dirt between the
 * columns and along the gutter was untouched while nothing was protected that
 * being alone did not already protect.
 *
 * Every function here takes and returns plain grayscale bytes, 0 black and 255
 * white, so the whole thing runs and is tested without a canvas.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CleanCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TILE_DIVISOR = 24;      // page width / this = side of a background tile
  var MIN_TILE = 16;
  var PAPER_LEVEL = 0.8;      // where in a tile's histogram the paper sits
  var DARKEST_PAPER = 0.55;   // a tile's paper may not fall below this much of
                              // the page's own paper level, which keeps solid
                              // dark areas, photographs above all, from being
                              // blown out into white
  var MAX_RUN = 40;           // dark runs longer than this are not letter strokes
  var MIN_RUNS = 20;          // fewer than this and the page has no type to measure
  var TEXT_INK_SHARE = 0.08;  // ink share of the busiest row a row needs to count
  var TEXT_PAD = 0.02;        // the text box is grown by this share of the page
  var SPECK_STROKES = 1.6;    // a speck may not be wider than this many strokes
  var SPECK_AREA = 2.2;       // nor cover more than this many stroke squares
  var LONELY_STROKES = 4;     // the paper a speck needs around it, in strokes
  var LONELY_SHARE = 0.02;    // ink share in that neighbourhood that saves it
  var CROWD_SPECKS = 4;       // more specks than this beside one is a cloud, not company
  var GHOST_LEVEL = 0.8;      // a mark that stays this far from the ink towards the
                              // paper has no printing anywhere in it
  var BAND_EDGE = 0.08;       // how far from the edge a band has to reach
  var BAND_LONG = 0.03;       // a band runs at least this share of the page
  var BAND_THIN = 0.12;       // and is at most this share of it across
  var BAND_RATIO = 6;         // and is at least this many times longer than wide
  var BAND_GROW = 0.5;        // strokes of grey fringe taken with a band or a speck
  var BAND_BRIDGE = 3;        // strokes of gap that still leave a hairline one hairline
  var BAND_HAIR = 0.5;        // strokes of ink a hairline may carry for each row it crosses
  var SMEAR_TILE = 4;         // strokes to a side of a tile the ink is weighed in
  var SMEAR_CORE = 0.55;      // ink share of such a tile that type never reaches
  var SMEAR_EDGE = 0.2;       // and the share the smear's own fringe falls away to
  var SMEAR_SOLID = 0.8;      // ink this solid all through a region was printed there

  /*
   * Percentile of byte values through a 256 bin histogram, which is what keeps
   * this linear: the same reading by sorting costs a page of scanned text a
   * second or two all by itself.
   */
  function levelOf(hist, count, share) {
    if (!count) return 255;
    var want = Math.floor(share * count), seen = 0;
    for (var v = 0; v < 256; v++) {
      seen += hist[v];
      if (seen > want) return v;
    }
    return 255;
  }

  function histogram(gray, out) {
    var hist = out || new Uint32Array(256);
    for (var i = 0; i < gray.length; i++) hist[gray[i]]++;
    return hist;
  }

  /* Otsu's threshold, the usual split of a page's histogram into ink and paper. */
  function threshold(gray) {
    var hist = histogram(gray), i;
    var total = gray.length, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, weightB = 0, best = -1, cut = 128;
    for (i = 0; i < 256; i++) {
      weightB += hist[i];
      if (weightB === 0) continue;
      var weightF = total - weightB;
      if (weightF === 0) break;
      sumB += i * hist[i];
      var between = weightB * weightF
        * Math.pow(sumB / weightB - (sum - sumB) / weightF, 2);
      if (between > best) { best = between; cut = i; }
    }
    return cut;
  }

  /*
   * The paper surface under the page: one reading per tile, read back with
   * bilinear interpolation so that no tile edge shows up as a seam.
   */
  function backgroundSurface(gray, w, h) {
    var tile = Math.max(MIN_TILE, Math.round(w / TILE_DIVISOR));
    var cols = Math.max(1, Math.ceil(w / tile));
    var rows = Math.max(1, Math.ceil(h / tile));
    var page = histogram(gray);
    var floor = levelOf(page, gray.length, PAPER_LEVEL) * DARKEST_PAPER;
    var level = new Float64Array(cols * rows);
    var hist = new Uint32Array(256);
    for (var ty = 0; ty < rows; ty++) {
      for (var tx = 0; tx < cols; tx++) {
        var x0 = tx * tile, y0 = ty * tile;
        var x1 = Math.min(w, x0 + tile), y1 = Math.min(h, y0 + tile);
        hist.fill(0);
        var count = 0;
        for (var y = y0; y < y1; y++) {
          for (var x = x0; x < x1; x++) { hist[gray[y * w + x]]++; count++; }
        }
        level[ty * cols + tx] = Math.max(1, floor, levelOf(hist, count, PAPER_LEVEL));
      }
    }
    return { level: level, cols: cols, rows: rows, tile: tile };
  }

  function surfaceAt(surface, x, y) {
    var fx = (x + 0.5) / surface.tile - 0.5;
    var fy = (y + 0.5) / surface.tile - 0.5;
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var dx = fx - x0, dy = fy - y0;
    var cx0 = x0 < 0 ? 0 : (x0 > surface.cols - 1 ? surface.cols - 1 : x0);
    var cx1 = x0 + 1 < 0 ? 0 : (x0 + 1 > surface.cols - 1 ? surface.cols - 1 : x0 + 1);
    var cy0 = y0 < 0 ? 0 : (y0 > surface.rows - 1 ? surface.rows - 1 : y0);
    var cy1 = y0 + 1 < 0 ? 0 : (y0 + 1 > surface.rows - 1 ? surface.rows - 1 : y0 + 1);
    var a = surface.level[cy0 * surface.cols + cx0];
    var b = surface.level[cy0 * surface.cols + cx1];
    var c = surface.level[cy1 * surface.cols + cx0];
    var d = surface.level[cy1 * surface.cols + cx1];
    return (a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy;
  }

  /*
   * Divides the page by its own paper, then pushes the near-white end the rest
   * of the way. `strength` runs from 0, where paper has to be as light as the
   * tile it sits in before it is called white, to 1, where a little short of
   * that is enough. It moves only the light end of the range: no setting of it
   * can lighten a pixel that is much darker than the paper around it.
   */
  function whiten(gray, w, h, strength) {
    var amount = strength === undefined ? 0.5 : Math.max(0, Math.min(1, strength));
    var surface = backgroundSurface(gray, w, h);
    var white = 255 - amount * 45;  // 255 down to 210 as the slider is pushed
    var out = new Uint8Array(gray.length);
    for (var y = 0, i = 0; y < h; y++) {
      for (var x = 0; x < w; x++, i++) {
        var value = 255 * gray[i] / surfaceAt(surface, x, y);
        if (value >= white) { out[i] = 255; continue; }
        value = Math.round(value * 255 / white);
        out[i] = value < 0 ? 0 : (value > 255 ? 255 : value);
      }
    }
    return out;
  }

  /*
   * Stroke width, from the lengths of the dark runs across every row, which is
   * the only sane unit for "small" on a page that may be 200 or 600 dpi.
   *
   * The run that matters is weighed by ink rather than counted. On a scan of
   * ordinary type a third of all runs turn out to be a single pixel long, the
   * frayed edges of the letters, and counting runs lets that crowd hand back a
   * stroke of one or two pixels for type that is plainly five. Asking instead
   * which length the ink on the page is mostly made of ignores the fraying,
   * because a pixel of it is a pixel and a stroke of it is five.
   */
  function strokeWidth(gray, w, h, cut) {
    var runs = new Uint32Array(MAX_RUN + 1), total = 0, ink = 0;
    for (var y = 0; y < h; y++) {
      var run = 0;
      for (var x = 0; x < w; x++) {
        if (gray[y * w + x] <= cut) { run++; continue; }
        if (run > 0 && run <= MAX_RUN) { runs[run]++; total++; ink += run; }
        run = 0;
      }
      if (run > 0 && run <= MAX_RUN) { runs[run]++; total++; ink += run; }
    }
    if (total < MIN_RUNS) return 0;
    var half = ink / 2, seen = 0;
    for (var r = 1; r <= MAX_RUN; r++) {
      seen += r * runs[r];
      if (seen >= half) return r;
    }
    return 1;
  }

  /*
   * The rectangle the body of the text lives in. Rows and columns carrying a
   * fair share of the busiest row's ink are text; the first and last of them
   * bound the block, which is then padded, because the whole point of this
   * rectangle is to be generous about what counts as text.
   */
  function textBox(gray, w, h, cut) {
    var rowInk = new Uint32Array(h), colInk = new Uint32Array(w);
    for (var y = 0, i = 0; y < h; y++) {
      for (var x = 0; x < w; x++, i++) {
        if (gray[i] > cut) continue;
        rowInk[y]++;
        colInk[x]++;
      }
    }
    var down = inkBounds(rowInk), across = inkBounds(colInk);
    if (!down || !across) return null;
    var padY = Math.round(h * TEXT_PAD), padX = Math.round(w * TEXT_PAD);
    return {
      x0: Math.max(0, across.first - padX),
      x1: Math.min(w - 1, across.last + padX),
      y0: Math.max(0, down.first - padY),
      y1: Math.min(h - 1, down.last + padY),
    };
  }

  function inkBounds(ink) {
    var peak = 0, i;
    for (i = 0; i < ink.length; i++) if (ink[i] > peak) peak = ink[i];
    if (peak <= 0) return null;
    var need = Math.max(1, peak * TEXT_INK_SHARE);
    var first = -1, last = -1;
    for (i = 0; i < ink.length; i++) {
      if (ink[i] < need) continue;
      if (first < 0) first = i;
      last = i;
    }
    return first < 0 ? null : { first: first, last: last };
  }

  /* Ink counted per block, used to ask whether a speck has neighbours. */
  function inkBlocks(gray, w, h, cut, size) {
    var cols = Math.ceil(w / size), rows = Math.ceil(h / size);
    var counts = new Uint32Array(cols * rows);
    for (var y = 0, i = 0; y < h; y++) {
      var row = Math.floor(y / size) * cols;
      for (var x = 0; x < w; x++, i++) {
        if (gray[i] <= cut) counts[row + Math.floor(x / size)]++;
      }
    }
    return { counts: counts, cols: cols, rows: rows, size: size };
  }

  /* Ink in the blocks around a blob. The specks have been taken out of the
   * count by the time this is asked, so what it returns is the type nearby. */
  function neighbourInk(blocks, blob) {
    var bx0 = Math.max(0, Math.floor(blob.x0 / blocks.size) - 1);
    var bx1 = Math.min(blocks.cols - 1, Math.floor(blob.x1 / blocks.size) + 1);
    var by0 = Math.max(0, Math.floor(blob.y0 / blocks.size) - 1);
    var by1 = Math.min(blocks.rows - 1, Math.floor(blob.y1 / blocks.size) + 1);
    var ink = 0, cells = 0;
    for (var by = by0; by <= by1; by++) {
      for (var bx = bx0; bx <= bx1; bx++) {
        ink += blocks.counts[by * blocks.cols + bx];
        cells++;
      }
    }
    return {
      ink: ink,
      area: cells * blocks.size * blocks.size,
    };
  }

  /*
   * Walks one blob of connected ink from a seed, eight-connected, marking every
   * pixel it reaches so the page as a whole is walked once however many blobs
   * it holds. Pixels are collected only while the blob is still small enough to
   * be a candidate: past that the blob is going to be kept whatever else is
   * true of it, and there is no reason to hold on to a page number pixel by
   * pixel. The walk itself continues either way, because a blob left half
   * walked would be met again later as a smaller blob of its own.
   */
  function traceBlob(gray, w, h, seen, seed, cut, cap) {
    var stack = [seed];
    var x = seed % w, y = (seed / w) | 0;
    var blob = { x0: x, x1: x, y0: y, y1: y, area: 0, dark: 255, pixels: [] };
    seen[seed] = 1;
    while (stack.length) {
      var at = stack.pop();
      x = at % w;
      y = (at / w) | 0;
      blob.area++;
      if (gray[at] < blob.dark) blob.dark = gray[at];
      if (blob.area <= cap) blob.pixels.push(at);
      else if (blob.pixels.length) blob.pixels = [];
      if (x < blob.x0) blob.x0 = x;
      if (x > blob.x1) blob.x1 = x;
      if (y < blob.y0) blob.y0 = y;
      if (y > blob.y1) blob.y1 = y;
      for (var dy = -1; dy <= 1; dy++) {
        var ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          var next = ny * w + nx;
          if (seen[next] || gray[next] > cut) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
    }
    return blob;
  }

  function tooBig(blob, maxSide, maxArea) {
    return blob.area > maxArea
      || blob.x1 - blob.x0 + 1 > maxSide
      || blob.y1 - blob.y0 + 1 > maxSide;
  }

  /* Nothing but paper around it, so there is no type it could belong to. */
  function alone(blocks, blob) {
    var near = neighbourInk(blocks, blob);
    return near.ink <= near.area * LONELY_SHARE;
  }

  /*
   * Rubs out the blobs that pass the tests, and counts them, because a number of
   * specks removed is the one thing a preview can tell you that a picture of a
   * page cannot.
   *
   * It takes two passes rather than one, and the reason is what company means.
   * Being alone is the whole of a diacritic's protection, so the question put to
   * a blob is what lies round it, and the first version of that counted every
   * dark pixel there. On an empty margin that is the right count. In the scatter
   * a scanner throws off a smear it is the wrong one: there the neighbours of a
   * fleck of dirt are other flecks of dirt, hundreds of them, and the crowd
   * votes itself innocent. It is why the fringe of a smear used to survive the
   * very pass that took its middle away.
   *
   * So the specks are found first and counted apart from the rest, and each is
   * then asked two questions instead of one. Is there type beside it, which is
   * what saves the dot on an i and the full stop at the end of a word. Failing
   * that, are its companions few, which is what saves the second and third dots
   * of an ellipsis, or a colon, or a pair of quotes: marks that have nothing but
   * each other and are plainly still marks. What is left over is a fleck in a
   * cloud of flecks, and a cloud is not company.
   *
   * Then the walk is made a second time at a level near enough to the paper to
   * pick up what the first walk never saw at all. A speck has to be darker than
   * the page's own threshold before the first walk counts it as ink, and the
   * grey stipple a scanner leaves is often not: it is dirt at two thirds of the
   * way to white, invisible to a rule written about ink and perfectly visible to
   * whoever is reading the page. So a blob is gathered at the pale level, and
   * kept if it has any real printing in it anywhere. A mark of the book's own
   * always has: type, and the punctuation set in the same ink, is dark in the
   * middle however soft its edges are. A blob that is pale the whole way through
   * was left by the scanner, and if it is small and alone as well, it goes.
   *
   * Both walks rub out the grey halo around what they take, and not only the
   * pixels the threshold happened to catch. A speck lifted without its halo
   * leaves a ring of exactly the dirt that is being complained about.
   */
  function despeckle(gray, w, h, options) {
    var opts = options || {};
    var cut = opts.threshold === undefined ? threshold(gray) : opts.threshold;
    var stroke = opts.stroke || strokeWidth(gray, w, h, cut);
    var out = new Uint8Array(gray);
    if (!stroke) return { gray: out, removed: 0, stroke: 0 };

    var size = Math.max(0.25, opts.size === undefined ? 1 : opts.size);
    var maxSide = Math.max(2, Math.round(stroke * SPECK_STROKES * size));
    var maxArea = Math.max(4, Math.round(stroke * stroke * SPECK_AREA * size * size));
    var grow = Math.max(1, Math.round(stroke * BAND_GROW));
    var blocks = inkBlocks(gray, w, h, cut, Math.max(8, Math.round(stroke * LONELY_STROKES)));
    var crowd = new Uint32Array(blocks.cols * blocks.rows);
    var seen = new Uint8Array(gray.length);
    var specks = [];
    var i, p, at, blob;

    for (i = 0; i < gray.length; i++) {
      if (seen[i] || gray[i] > cut) continue;
      blob = traceBlob(gray, w, h, seen, i, cut, maxArea);
      if (tooBig(blob, maxSide, maxArea)) continue;
      for (p = 0; p < blob.pixels.length; p++) {
        at = blob.pixels[p];
        blocks.counts[(((at / w) | 0) / blocks.size | 0) * blocks.cols
          + ((at % w) / blocks.size | 0)]--;
      }
      crowd[(blob.y0 / blocks.size | 0) * blocks.cols + (blob.x0 / blocks.size | 0)]++;
      specks.push(blob);
    }

    var removed = 0;
    for (i = 0; i < specks.length; i++) {
      if (!alone(blocks, specks[i])) continue;
      var mates = neighbourCount(crowd, blocks, specks[i]);
      if (mates > 0 && mates <= CROWD_SPECKS) continue;
      erase(out, w, h, specks[i], paleFor(cut), grow);
      removed++;
    }

    // and the same walk again at a level so pale that it is nearly the paper.
    // It only means anything once the paper is white: on grey paper everything
    // under the level is joined to everything else and the walk is the page.
    var ghost = cut + Math.round((255 - cut) * GHOST_LEVEL);
    if (levelOf(histogram(gray), gray.length, PAPER_LEVEL) <= ghost) {
      return { gray: out, removed: removed, stroke: stroke };
    }
    // a blob gathered this pale comes with the fringe the ink level never
    // reached, so it is allowed the size of a speck plus that fringe
    var ghostSide = maxSide + 2 * grow;
    var ghostArea = Math.round(maxArea * ghostSide * ghostSide / (maxSide * maxSide));
    seen = new Uint8Array(gray.length);
    for (i = 0; i < out.length; i++) {
      if (seen[i] || out[i] > ghost) continue;
      blob = traceBlob(out, w, h, seen, i, ghost, ghostArea);
      if (blob.dark <= cut) continue;   // there is printing in it, so it stays
      if (tooBig(blob, ghostSide, ghostArea) || !alone(blocks, blob)) continue;
      erase(out, w, h, blob, paleFor(ghost), grow);
      removed++;
    }
    return { gray: out, removed: removed, stroke: stroke };
  }

  /* How many other specks share the blocks around this one. */
  function neighbourCount(crowd, blocks, blob) {
    var bx0 = Math.max(0, Math.floor(blob.x0 / blocks.size) - 1);
    var bx1 = Math.min(blocks.cols - 1, Math.floor(blob.x1 / blocks.size) + 1);
    var by0 = Math.max(0, Math.floor(blob.y0 / blocks.size) - 1);
    var by1 = Math.min(blocks.rows - 1, Math.floor(blob.y1 / blocks.size) + 1);
    var n = 0;
    for (var by = by0; by <= by1; by++) {
      for (var bx = bx0; bx <= bx1; bx++) n += crowd[by * blocks.cols + bx];
    }
    return n - 1;   // itself
  }

  /*
   * The other thing a scanner leaves, and the one a rule about long thin shapes
   * cannot see: the smear where the gutter's shadow burns out against the
   * sensor, or the corner where the sheet lifted off the glass. Measured, it is
   * not a line at all. The one this was written against was a mass a hundred
   * pixels across and a hundred and fifty down, half again as long as it is
   * wide, with three hundred odd flecks of stipple scattered round it. The band
   * rule reads the mass and refuses it for being too nearly square; the speck
   * rule reads the stipple and refuses it because none of those flecks is alone,
   * each one having all the others for company. Both look straight at it and
   * pass on.
   *
   * What the smear does have is density. Weighed over a tile a few strokes
   * wide, type covers about a sixth of the paper and in measurement never more
   * than a third, because a letter is mostly the white inside it and around it.
   * The smear covers half the tile and better. So tiles above that share are
   * taken as the core of one, its fringe is grown out from them down to a share
   * type does reach, and what comes out is asked the two questions a band is
   * asked: has it a foot in the margin, where the scanner is rather than the
   * book, and is it thin.
   *
   * Thinness is what keeps this safe, and it stays safe precisely because the
   * fringe is grown before it is asked. Where a smear runs up against a column
   * of type the growth walks into the type, and the region that comes back is
   * fat, and a fat region is refused whole. The failure this can have is a smear
   * left on the page. It is not a column of type taken off it.
   */
  var SIDES = [-1, 0, 1, 0, 0, -1, 0, 1];   // the four tiles a tile touches

  function unsmear(page, w, h, cut, stroke, edgeX, edgeY, grow) {
    var size = Math.max(8, Math.round(stroke * SMEAR_TILE));
    var blocks = inkBlocks(page, w, h, cut, size);
    var cols = blocks.cols, rows = blocks.rows;
    var share = new Float64Array(cols * rows);
    var bx, by, t;
    for (by = 0; by < rows; by++) {
      for (bx = 0; bx < cols; bx++) {
        var tw = Math.min(size, w - bx * size), th = Math.min(size, h - by * size);
        share[by * cols + bx] = blocks.counts[by * cols + bx] / (tw * th);
      }
    }

    var seen = new Uint8Array(cols * rows);
    var removed = 0;
    for (t = 0; t < share.length; t++) {
      if (seen[t] || share[t] < SMEAR_CORE) continue;
      var stack = [t], tiles = [];
      var tx0 = t % cols, tx1 = tx0, ty0 = (t / cols) | 0, ty1 = ty0;
      seen[t] = 1;
      while (stack.length) {
        var at = stack.pop();
        var x = at % cols, y = (at / cols) | 0;
        tiles.push(at);
        if (x < tx0) tx0 = x;
        if (x > tx1) tx1 = x;
        if (y < ty0) ty0 = y;
        if (y > ty1) ty1 = y;
        for (var d = 0; d < 8; d += 2) {
          var nx = x + SIDES[d], ny = y + SIDES[d + 1];
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          var next = ny * cols + nx;
          if (seen[next] || share[next] < SMEAR_EDGE) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }

      var x0 = tx0 * size, y0 = ty0 * size;
      var x1 = Math.min(w, (tx1 + 1) * size) - 1, y1 = Math.min(h, (ty1 + 1) * size) - 1;
      var across = (x1 - x0 + 1) / w, down = (y1 - y0 + 1) / h;
      if (Math.max(across, down) < BAND_LONG) continue;
      if (Math.min(across, down) > BAND_THIN) continue;
      if (x0 >= edgeX && x1 < w - edgeX && y0 >= edgeY && y1 < h - edgeY) continue;
      var solid = 0;
      for (var s = 0; s < tiles.length; s++) solid += share[tiles[s]];
      // a burn fades from its core outwards and the growth above followed it out
      // to the fringe, so its ink comes to about half the paper it covers. Ink
      // that stays solid to the last tile was put there by a press.
      if (solid > tiles.length * SMEAR_SOLID) continue;

      var pixels = [];
      for (var k = 0; k < tiles.length; k++) {
        bx = tiles[k] % cols;
        by = (tiles[k] / cols) | 0;
        var px1 = Math.min(w, (bx + 1) * size), py1 = Math.min(h, (by + 1) * size);
        for (var py = by * size; py < py1; py++) {
          for (var px = bx * size; px < px1; px++) {
            if (page[py * w + px] <= cut) pixels.push(py * w + px);
          }
        }
      }
      erase(page, w, h, { pixels: pixels }, paleFor(cut), grow);
      removed++;
    }
    return removed;
  }

  /*
   * The dark bands a scanner leaves: the strip down the side where the lid did
   * not reach, and the shadow the gutter throws between two pages on one sheet.
   * Neither is dirt in the sense the speck rule means, because both are
   * thousands of times bigger than a letter, so they need a rule of their own.
   *
   * Measured on real scans they have three things in common that nothing on the
   * printed page has. They are long, running a good part of the way down the
   * sheet or across it. They are thin, a few dozen pixels against the thousands
   * they run for. And they start at the edge of the sheet, because that is
   * where the scanner is, not where the book is. A photograph fails the second
   * test, a headline fails all three, and a letter is not remotely large enough
   * to be asked.
   *
   * Only the pixels of the band itself are rubbed out, with a stroke of margin
   * for the grey it frays into, so type that happens to stand next to one is
   * untouched unless it is joined to it.
   */
  function deband(gray, w, h, options) {
    var opts = options || {};
    var cut = opts.threshold === undefined ? threshold(gray) : opts.threshold;
    var stroke = opts.stroke || strokeWidth(gray, w, h, cut) || 2;
    var out = new Uint8Array(gray);
    var edgeX = Math.round(w * BAND_EDGE);
    var edgeY = Math.round(h * BAND_EDGE);
    var grow = Math.max(1, Math.round(stroke * BAND_GROW));
    var seen = new Uint8Array(gray.length);

    // the smear first: it comes off as a region, and the flecks lying in it
    // stop being ink the line rule below has to walk through
    var removed = unsmear(out, w, h, cut, stroke, edgeX, edgeY, grow);

    for (var y = 0, i = 0; y < h; y++) {
      var nearTopOrBottom = y < edgeY || y >= h - edgeY;
      for (var x = 0; x < w; x++, i++) {
        // a band has to have a foot in the margin somewhere; whatever lives
        // wholly in the middle of the sheet is the book's own
        if (!nearTopOrBottom && x >= edgeX && x < w - edgeX) continue;
        if (seen[i] || out[i] > cut) continue;
        var band = traceBlob(out, w, h, seen, i, cut, out.length);
        var across = (band.x1 - band.x0 + 1) / w;
        var down = (band.y1 - band.y0 + 1) / h;
        if (Math.max(across, down) < BAND_LONG) continue;
        if (Math.min(across, down) > BAND_THIN) continue;
        var long = Math.max(band.x1 - band.x0, band.y1 - band.y0) + 1;
        var short = Math.min(band.x1 - band.x0, band.y1 - band.y0) + 1;
        if (long < short * BAND_RATIO) continue;
        erase(out, w, h, band, paleFor(cut), grow);
        removed++;
      }
    }
    // last, on what the rules above left: the dashes they could not join up
    removed += hairlines(out, w, h, cut, stroke, edgeX, edgeY, grow);
    return { gray: out, removed: removed };
  }

  /*
   * The hairlines the lid leaves along an edge, which arrive broken into dashes
   * and so are never one blob long enough for the band rule above to see. The
   * dashes are bridged along the edge before the same long-and-thin questions
   * are asked, and one more that decides everything: a hairline carries about a
   * pixel of ink for every row it crosses, while anything the book printed
   * carries at least a stroke's worth. Measured on the reference scan, the
   * hairlines come to 0.7 to 0.95 pixels a row against a stroke of 4 to 6, and
   * the edge of a halftone photograph that must survive comes to 18.
   */
  function hairlines(out, w, h, cut, stroke, edgeX, edgeY, grow) {
    var bridge = Math.max(2, Math.round(stroke * BAND_BRIDGE));
    return sweep(out, w, h, cut, stroke, grow, bridge, edgeX, true)
      + sweep(out, w, h, cut, stroke, grow, bridge, edgeY, false);
  }

  function sweep(out, w, h, cut, stroke, grow, bridge, edge, down) {
    if (edge <= 0) return 0;
    var crossSpan = down ? w : h, alongSpan = down ? h : w;
    var at = function (cross, along) {
      return down ? along * w + cross : cross * w + along;
    };
    var margin = function (cross) { return cross < edge || cross >= crossSpan - edge; };
    var mask = new Uint8Array(w * h);
    var cross, along, k;
    for (cross = 0; cross < crossSpan; cross++) {
      if (!margin(cross)) continue;
      for (along = 0; along < alongSpan; along++) {
        if (out[at(cross, along)] > cut) continue;
        for (k = 0; k <= bridge && along + k < alongSpan; k++) mask[at(cross, along + k)] = 1;
      }
    }

    var seen = new Uint8Array(w * h);
    var removed = 0;
    for (cross = 0; cross < crossSpan; cross++) {
      if (!margin(cross)) continue;
      for (along = 0; along < alongSpan; along++) {
        var start = at(cross, along);
        if (seen[start] || !mask[start]) continue;
        seen[start] = 1;
        var stack = [cross, along], pixels = [];
        var c0 = cross, c1 = cross, a0 = along, a1 = along;
        while (stack.length) {
          var ay = stack.pop(), ax = stack.pop();
          var here = at(ax, ay);
          if (out[here] <= cut) pixels.push(here);
          if (ax < c0) c0 = ax;
          if (ax > c1) c1 = ax;
          if (ay < a0) a0 = ay;
          if (ay > a1) a1 = ay;
          for (var dc = -1; dc <= 1; dc++) {
            for (var da = -1; da <= 1; da++) {
              var nc = ax + dc, na = ay + da;
              if (nc < 0 || na < 0 || nc >= crossSpan || na >= alongSpan) continue;
              var n = at(nc, na);
              if (seen[n] || !mask[n]) continue;
              seen[n] = 1;
              stack.push(nc, na);
            }
          }
        }
        var length = a1 - a0 + 1, width = c1 - c0 + 1;
        if (length < alongSpan * BAND_LONG) continue;
        if (length < width * BAND_RATIO) continue;
        if (pixels.length >= length * stroke * BAND_HAIR) continue;
        erase(out, w, h, { pixels: pixels }, paleFor(cut), grow);
        removed++;
      }
    }
    return removed;
  }

  /*
   * How pale a pixel may be and still belong to what is being rubbed out: far
   * enough above the level the thing was found at to take the grey halo a hard
   * threshold always leaves around it.
   */
  function paleFor(level) {
    return Math.min(250, level + (255 - level) * 0.6);
  }

  /*
   * Whitens a band and the grey it frays into, staying inside its own bounding
   * box: everything within `grow` of one of its pixels that is darker than the
   * paper goes, which takes the halo a hard threshold leaves behind.
   */
  function erase(out, w, h, band, pale, grow) {
    for (var p = 0; p < band.pixels.length; p++) {
      var at = band.pixels[p];
      var px = at % w, py = (at / w) | 0;
      for (var dy = -grow; dy <= grow; dy++) {
        var ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (var dx = -grow; dx <= grow; dx++) {
          var nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          var n = ny * w + nx;
          if (out[n] < pale) out[n] = 255;
        }
      }
    }
  }

  /*
   * The whole job, in the order the steps have to run. The text box comes
   * back with it, not because anything is protected by it any more, but so that
   * a preview knows where on the page it is worth looking closely.
   */
  function clean(gray, w, h, options) {
    var opts = options || {};
    var page = opts.whiten === false ? gray : whiten(gray, w, h, opts.strength);
    var cut = threshold(page);
    var stroke = strokeWidth(page, w, h, cut);
    var bands = 0;
    if (opts.deband) {
      // before the specks, so that the dirt lying along a band stops having a
      // band to keep it company and can be judged on its own
      var edged = deband(page, w, h, { threshold: cut, stroke: stroke });
      page = edged.gray;
      bands = edged.removed;
    }
    var result = opts.despeckle
      ? despeckle(page, w, h, { threshold: cut, stroke: stroke, size: opts.speckSize })
      : { gray: page, removed: 0, stroke: stroke };
    result.bands = bands;
    result.box = textBox(result.gray, w, h, cut);
    return result;
  }

  return {
    clean: clean,
    whiten: whiten,
    despeckle: despeckle,
    deband: deband,
    threshold: threshold,
    strokeWidth: strokeWidth,
    textBox: textBox,
  };
});
