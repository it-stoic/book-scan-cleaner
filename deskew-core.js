/*
 * Book Scan Cleaner, https://github.com/it-stoic/book-scan-cleaner
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 * If you host a modified version, its users must be offered its source.
 */
/*
 * Straightens pages that were scanned a little crooked.
 *
 * The angle is measured the way every deskew tool measures it: rotate the ink
 * of a page through a range of candidate angles and keep the one whose
 * horizontal projection profile is sharpest. Straight text lines pile up into
 * tall spikes, crooked ones smear across many rows.
 *
 * Both halves take and return plain grayscale bytes, 0 black and 255 white,
 * the same as clean-core, so the whole thing runs and is tested without a
 * canvas. Straightening is the last thing done to a page and the only thing
 * here that moves a pixel: the cleaning rules all measure ink, and ink that
 * has been through an interpolation measures worse.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeskewCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMIT = 6;            // degrees searched either side of straight
  var COARSE = 0.5;
  var FINE = 0.05;
  var MAX_POINTS = 30000;
  var INSET = 0.04;         // ignored border, where a scanner leaves its edge
  var MIN_INK = 0.002;      // below this a page has nothing to measure
  var MIN_CONFIDENCE = 0.02;
  var MEASURE_WIDTH = 700;  // the angle is read off a page this wide, however big it came

  function otsuThreshold(gray) {
    var hist = new Float64Array(256), i;
    for (i = 0; i < gray.length; i++) hist[gray[i]]++;
    var total = gray.length, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, weightB = 0, best = -1, threshold = 128;
    for (i = 0; i < 256; i++) {
      weightB += hist[i];
      if (weightB === 0) continue;
      var weightF = total - weightB;
      if (weightF === 0) break;
      sumB += i * hist[i];
      var meanB = sumB / weightB;
      var meanF = (sum - sumB) / weightF;
      var between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
      if (between > best) { best = between; threshold = i; }
    }
    return threshold;
  }

  /*
   * A page rendered at 300 dpi is eight million pixels, and the angle does not
   * live in any of that detail. Averaging it down first is what the splitter
   * gets for free by rendering the page small in the first place, and it keeps
   * the measurement the same whatever resolution the output is set to.
   */
  function shrink(gray, w, h, width) {
    if (w <= width) return { gray: gray, w: w, h: h };
    var nw = width, nh = Math.max(1, Math.round(h * width / w));
    var out = new Uint8Array(nw * nh);
    for (var y = 0; y < nh; y++) {
      var y0 = Math.floor(y * h / nh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / nh));
      for (var x = 0; x < nw; x++) {
        var x0 = Math.floor(x * w / nw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / nw));
        var sum = 0, n = 0;
        for (var yy = y0; yy < y1; yy++) {
          for (var xx = x0; xx < x1; xx++) { sum += gray[yy * w + xx]; n++; }
        }
        out[y * nw + x] = sum / n;
      }
    }
    return { gray: out, w: nw, h: nh };
  }

  function inkPoints(gray, w, h) {
    var threshold = otsuThreshold(gray);
    var x0 = Math.floor(w * INSET), x1 = w - x0;
    var y0 = Math.floor(h * INSET), y1 = h - y0;
    var found = [], x, y;
    for (y = y0; y < y1; y++) {
      for (x = x0; x < x1; x++) {
        if (gray[y * w + x] <= threshold) found.push(x, y);
      }
    }
    var count = found.length / 2;
    if (count < (x1 - x0) * (y1 - y0) * MIN_INK) return null;
    if (count <= MAX_POINTS) return found;
    var stride = Math.ceil(count / MAX_POINTS);
    var thinned = [];
    for (var i = 0; i < count; i += stride) thinned.push(found[i * 2], found[i * 2 + 1]);
    return thinned;
  }

  function profileScore(points, angle, cx, cy, bins, pad) {
    var sin = Math.sin(angle), cos = Math.cos(angle), i;
    bins.fill(0);
    for (i = 0; i < points.length; i += 2) {
      var row = cy + (points[i] - cx) * sin + (points[i + 1] - cy) * cos;
      bins[(row + pad) | 0]++;
    }
    var score = 0;
    for (i = 0; i < bins.length; i++) score += bins[i] * bins[i];
    return score;
  }

  function median(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[sorted.length >> 1];
  }

  /*
   * Returns how far the page has to be turned to stand straight, in degrees,
   * counter-clockwise as the eye sees it. 0 means nothing worth measuring was
   * found, and a page with nothing to measure is left alone rather than guessed
   * at: a full-page photograph and a blank both come back 0.
   */
  function measureSkew(gray, w, h) {
    var small = shrink(gray, w, h, MEASURE_WIDTH);
    var points = inkPoints(small.gray, small.w, small.h);
    if (!points) return 0;

    var cx = small.w / 2, cy = small.h / 2;
    var pad = Math.ceil(small.w * Math.sin(LIMIT * Math.PI / 180)) + 2;
    var bins = new Int32Array(small.h + 2 * pad + 2);
    var scores = [], best = -1, bestAngle = 0, a;

    for (a = -LIMIT; a <= LIMIT + 1e-9; a += COARSE) {
      var score = profileScore(points, a * Math.PI / 180, cx, cy, bins, pad);
      scores.push(score);
      if (score > best) { best = score; bestAngle = a; }
    }

    var middle = median(scores);
    if (!middle || (best - middle) / middle < MIN_CONFIDENCE) return 0;

    var from = bestAngle - COARSE, to = bestAngle + COARSE;
    for (a = from; a <= to + 1e-9; a += FINE) {
      var fine = profileScore(points, a * Math.PI / 180, cx, cy, bins, pad);
      if (fine > best) { best = fine; bestAngle = a; }
    }

    var corrected = -Math.round(bestAngle * 100) / 100;
    return corrected === 0 ? 0 : corrected;
  }

  /*
   * Turns the page by `degrees` counter-clockwise about its centre, which is
   * the direction measureSkew's answer is in. The sheet keeps its size, so the
   * corners swing out and are cut, and what swings in from beyond the sheet
   * comes in as paper rather than as black.
   */
  function rotateGray(gray, w, h, degrees) {
    if (!degrees) return gray;
    var out = new Uint8Array(w * h).fill(255);
    // image rows run down, so the sine changes sign against the usual matrix
    var a = degrees * Math.PI / 180;
    var cos = Math.cos(a), sin = Math.sin(a);
    var cx = (w - 1) / 2, cy = (h - 1) / 2;
    for (var y = 0, i = 0; y < h; y++) {
      var dy = y - cy;
      for (var x = 0; x < w; x++, i++) {
        var dx = x - cx;
        var sx = cx + dx * cos - dy * sin;
        var sy = cy + dx * sin + dy * cos;
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
        var x0 = sx | 0, y0 = sy | 0;
        var x1 = x0 + 1 < w ? x0 + 1 : x0;
        var y1 = y0 + 1 < h ? y0 + 1 : y0;
        var fx = sx - x0, fy = sy - y0;
        var top = gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx;
        var bottom = gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx;
        out[i] = top * (1 - fy) + bottom * fy + 0.5;
      }
    }
    return out;
  }

  return {
    measureSkew: measureSkew,
    rotateGray: rotateGray,
    otsuThreshold: otsuThreshold,
  };
});
