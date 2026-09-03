/*
 * Book Scan Cleaner, https://github.com/it-stoic/book-scan-cleaner
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 * If you host a modified version, its users must be offered its source.
 *
 * The cylindrical surface model is ported from Scan Tailor's dewarping code
 * (CylindricalSurfaceDewarper, ArcLengthMapper, PolylineIntersector), which is
 * Copyright (C) Joseph Artsimovich and contributors and licensed under the GNU
 * General Public License v3 or later. AGPL v3 section 13 permits the two to be
 * combined; see https://github.com/ImageProcessing-ElectronicPublications/scantailor-experimental
 */
/*
 * Flattens a page that was scanned while it curved into its binding. The page
 * is taken to be a piece of a cylinder, pinned down by two curves the reader
 * lays along the top and the bottom of the block of type. Arc length along
 * those curves, rather than width, is what pulls apart the type squeezed
 * towards the binding.
 *
 * Grayscale bytes in and out, 0 black and 255 white, like the other two cores.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DewarpCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SAMPLES = 128;        // points the two curves are read at to measure arc length
  var DEPTH = 2;            // how much of the cylinder's bulge is taken out

  function solve(A, b, n) {
    var i, j, k;
    for (i = 0; i < n; i++) {
      var pivot = i;
      for (j = i + 1; j < n; j++) {
        if (Math.abs(A[j * n + i]) > Math.abs(A[pivot * n + i])) pivot = j;
      }
      if (Math.abs(A[pivot * n + i]) < 1e-12) return null;
      if (pivot !== i) {
        for (k = 0; k < n; k++) {
          var swap = A[i * n + k]; A[i * n + k] = A[pivot * n + k]; A[pivot * n + k] = swap;
        }
        var t = b[i]; b[i] = b[pivot]; b[pivot] = t;
      }
      for (j = i + 1; j < n; j++) {
        var factor = A[j * n + i] / A[i * n + i];
        if (!factor) continue;
        for (k = i; k < n; k++) A[j * n + k] -= factor * A[i * n + k];
        b[j] -= factor * b[i];
      }
    }
    var x = new Float64Array(n);
    for (i = n - 1; i >= 0; i--) {
      var sum = b[i];
      for (j = i + 1; j < n; j++) sum -= A[i * n + j] * x[j];
      x[i] = sum / A[i * n + i];
    }
    return x;
  }

  function homography2D(pairs) {
    var A = new Float64Array(64), b = new Float64Array(8);
    for (var i = 0; i < 4; i++) {
      var p = pairs[i], r = i * 2;
      A[r * 8] = -p.fx; A[r * 8 + 1] = -p.fy; A[r * 8 + 2] = -1;
      A[r * 8 + 6] = p.tx * p.fx; A[r * 8 + 7] = p.tx * p.fy;
      b[r] = -p.tx;
      r++;
      A[r * 8 + 3] = -p.fx; A[r * 8 + 4] = -p.fy; A[r * 8 + 5] = -1;
      A[r * 8 + 6] = p.ty * p.fx; A[r * 8 + 7] = p.ty * p.fy;
      b[r] = -p.ty;
    }
    var h = solve(A, b, 8);
    return h && [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function applyH2(H, x, y) {
    var w = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
  }

  function invert3(H) {
    var a = H[4] * H[8] - H[5] * H[7], b = H[5] * H[6] - H[3] * H[8], c = H[3] * H[7] - H[4] * H[6];
    var det = H[0] * a + H[1] * b + H[2] * c;
    if (Math.abs(det) < 1e-12) return null;
    return [
      a / det, (H[2] * H[7] - H[1] * H[8]) / det, (H[1] * H[5] - H[2] * H[4]) / det,
      b / det, (H[0] * H[8] - H[2] * H[6]) / det, (H[2] * H[3] - H[0] * H[5]) / det,
      c / det, (H[1] * H[6] - H[0] * H[7]) / det, (H[0] * H[4] - H[1] * H[3]) / det,
    ];
  }

  function homography1D(pairs) {
    var A = new Float64Array(9), b = new Float64Array(3);
    for (var i = 0; i < 3; i++) {
      A[i * 3] = -pairs[i][0];
      A[i * 3 + 1] = -1;
      A[i * 3 + 2] = pairs[i][0] * pairs[i][1];
      b[i] = -pairs[i][1];
    }
    var h = solve(A, b, 3);
    return h && [h[0], h[1], h[2]];
  }

  function applyH1(h, v) {
    return (h[0] * v + h[1]) / (h[2] * v + 1);
  }

  function projectionScalar(ax, ay, bx, by, px, py) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    return len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  }

  // a line that misses the polyline is met by carrying its nearest end segment out
  function crossPolyline(points, ax, ay, bx, by) {
    var nx = -(by - ay), ny = bx - ax;
    var i, dot, prev = nx * (points[0].x - ax) + ny * (points[0].y - ay), found = -1;
    for (i = 1; i < points.length; i++) {
      dot = nx * (points[i].x - ax) + ny * (points[i].y - ay);
      if (prev * dot <= 0) { found = i - 1; break; }
      prev = dot;
    }
    if (found < 0) {
      var first = Math.abs(nx * (points[0].x - ax) + ny * (points[0].y - ay));
      var last = Math.abs(nx * (points[points.length - 1].x - ax)
        + ny * (points[points.length - 1].y - ay));
      found = first < last ? 0 : points.length - 2;
    }
    var p = points[found], q = points[found + 1];
    var rx = bx - ax, ry = by - ay, sx = q.x - p.x, sy = q.y - p.y;
    var denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-12) return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    var u = ((p.x - ax) * ry - (p.y - ay) * rx) / denom;
    return { x: p.x + u * sx, y: p.y + u * sy };
  }

  function generatrixAt(model, plnX) {
    var top = applyH2(model.pln2img, plnX, 0);
    var bottom = applyH2(model.pln2img, plnX, 1);
    var d1 = crossPolyline(model.top, top.x, top.y, bottom.x, bottom.y);
    var d2 = crossPolyline(model.bottom, top.x, top.y, bottom.x, bottom.y);
    return {
      top: top,
      bottom: bottom,
      p1: projectionScalar(top.x, top.y, bottom.x, bottom.y, d1.x, d1.y),
      p2: projectionScalar(top.x, top.y, bottom.x, bottom.y, d2.x, d2.y),
    };
  }

  function arcLengthSamples(model, depth) {
    var coeff = model.pln2img;
    var cm0 = coeff[6] * coeff[6], cm1 = coeff[7] * coeff[7];
    var cnorm = cm0 + cm1;
    var widthShare = cnorm > 0 ? cm1 / cnorm : 1;
    var xs = [], lens = [], length = 0, prevElev = 0;
    for (var i = 0; i < SAMPLES; i++) {
      var plnX = i / (SAMPLES - 1);
      var g = generatrixAt(model, plnX);
      var bx = 0.5 * ((g.p2 + g.p1) - 1) * widthShare;
      var by = 1 - (g.p2 - g.p1);
      var elevation = depth / (1 + widthShare) * (bx + by);
      elevation = elevation < -0.5 ? -0.5 : (elevation > 0.5 ? 0.5 : elevation);
      if (i > 0) {
        var dx = plnX - xs[i - 1], dy = elevation - prevElev;
        length += Math.sqrt(dx * dx + dy * dy);
      }
      xs.push(plnX);
      lens.push(length);
      prevElev = elevation;
    }
    if (length > 0) for (var j = 0; j < lens.length; j++) lens[j] /= length;
    return { xs: xs, lens: lens };
  }

  // beyond either end the last segment is carried on, so margins outside the
  // curves keep moving with the page instead of smearing its edge column
  function arcLenToX(arc, xs, lens) {
    var last = lens.length - 1, lo = 0, hi = last;
    if (arc < lens[0]) { hi = 1; }
    else if (arc > lens[last]) { lo = last - 1; hi = last; }
    else {
      while (lo + 1 < hi) {
        var mid = (lo + hi) >> 1;
        if (lens[mid] <= arc) lo = mid; else hi = mid;
      }
    }
    var span = lens[hi] - lens[lo];
    return span ? xs[lo] + (xs[hi] - xs[lo]) * (arc - lens[lo]) / span : xs[lo];
  }

  // mapping about the line where the sheet runs straight, not about the middle,
  // is what keeps the type from being sheared
  function straightLineY(model) {
    var img2pln = invert3(model.pln2img);
    if (!img2pln) return 0.5;
    var accum = 0, weights = 0;
    for (var i = 0; i < SAMPLES; i++) {
      var plnX = i / (SAMPLES - 1);
      var g = generatrixAt(model, plnX);
      var dp1 = g.p1, dp2 = 1 - g.p2;
      var weight = Math.abs(dp1 + dp2);
      if (weight < 0.01) continue;
      var p0 = (g.p2 * dp1 + g.p1 * dp2) / (dp1 + dp2);
      var px = g.top.x + (g.bottom.x - g.top.x) * p0;
      var py = g.top.y + (g.bottom.y - g.top.y) * p0;
      accum += applyH2(img2pln, px, py).y * weight;
      weights += weight;
    }
    return weights ? accum / weights : 0.5;
  }

  // curves are { x, y } in image pixels, left to right; null means leave the page alone
  function buildModel(top, bottom, options) {
    if (!top || !bottom || top.length < 2 || bottom.length < 2) return null;
    var opts = options || {};
    var depth = opts.depth === undefined ? DEPTH : opts.depth;
    var pln2img = homography2D([
      { fx: 0, fy: 0, tx: top[0].x, ty: top[0].y },
      { fx: 1, fy: 0, tx: top[top.length - 1].x, ty: top[top.length - 1].y },
      { fx: 0, fy: 1, tx: bottom[0].x, ty: bottom[0].y },
      { fx: 1, fy: 1, tx: bottom[bottom.length - 1].x, ty: bottom[bottom.length - 1].y },
    ]);
    if (!pln2img) return null;
    var model = { top: top, bottom: bottom, pln2img: pln2img };
    var arc = arcLengthSamples(model, depth);
    model.xs = arc.xs;
    model.lens = arc.lens;
    model.straightY = straightLineY(model);
    return model;
  }

  function columnAt(model, crvX) {
    var plnX = arcLenToX(crvX, model.xs, model.lens);
    var g = generatrixAt(model, plnX);
    var delta = 2 * model.straightY - 1;
    var frac = Math.min(1, delta * delta);
    var y = frac * 0.5 + (1 - frac) * model.straightY;
    var mixed = (1 - y) * g.p1 + y * g.p2;
    var straight = applyH2(model.pln2img, plnX, mixed);
    var p3 = projectionScalar(g.top.x, g.top.y, g.bottom.x, g.bottom.y, straight.x, straight.y);
    var H = homography1D([[0, g.p1], [1, g.p2], [y, p3]]);
    return H && { top: g.top, bottom: g.bottom, H: H };
  }

  function mapToWarped(model, crvX, crvY) {
    var column = columnAt(model, crvX);
    if (!column) return null;
    var t = applyH1(column.H, crvY);
    return {
      x: column.top.x + (column.bottom.x - column.top.x) * t,
      y: column.top.y + (column.bottom.y - column.top.y) * t,
    };
  }

  // the model's unit square is laid over the box the four curve ends make, so the
  // type comes out flat where it already was rather than somewhere else
  function dewarpGray(gray, w, h, top, bottom, options) {
    var model = buildModel(top, bottom, options);
    if (!model) return gray;
    var ends = [top[0], top[top.length - 1], bottom[0], bottom[bottom.length - 1]];
    var rx = Math.min(ends[0].x, ends[2].x), ry = Math.min(ends[0].y, ends[1].y);
    var rw = Math.max(ends[1].x, ends[3].x) - rx;
    var rh = Math.max(ends[2].y, ends[3].y) - ry;
    if (!(rw > 1 && rh > 1)) return gray;

    var out = new Uint8Array(w * h).fill(255);
    for (var x = 0; x < w; x++) {
      var column = columnAt(model, (x - rx) / rw);
      if (!column) continue;
      var dx = column.bottom.x - column.top.x, dy = column.bottom.y - column.top.y;
      for (var y = 0; y < h; y++) {
        var t = applyH1(column.H, (y - ry) / rh);
        var sx = column.top.x + dx * t, sy = column.top.y + dy * t;
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
        var x0 = sx | 0, y0 = sy | 0;
        var x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
        var fx = sx - x0, fy = sy - y0;
        var above = gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx;
        var below = gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx;
        out[y * w + x] = above * (1 - fy) + below * fy + 0.5;
      }
    }
    return out;
  }

  return {
    buildModel: buildModel,
    mapToWarped: mapToWarped,
    dewarpGray: dewarpGray,
  };
});
