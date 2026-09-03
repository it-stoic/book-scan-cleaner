/*
 * Book Scan Cleaner, https://github.com/it-stoic/book-scan-cleaner
 * Copyright (C) 2026 Filip Simunjak
 * Licensed under the GNU Affero General Public License v3 or later; see LICENSE.
 * If you host a modified version, its users must be offered its source.
 */
(function () {
  'use strict';

  var PREVIEW_WIDTH = 880;   // CSS pixels the page preview may grow to
  var VIEW_MIN_HEIGHT = 260; // shortest the preview is ever shown
  var DETAIL_W = 430;        // life-size window on the page, in output pixels
  var DETAIL_H = 250;
  var MAX_PIXELS = 40e6;     // ceiling on one rendered page, to stay inside memory
  var QUALITY = 0.85;        // JPEG quality of the pages written out
  var SETTLE = 250;          // ms a slider is left alone before the page is redone
  var TILT_LIMIT = 15;       // degrees a page may be turned by hand, either way
  var CURVE_HANDLES = 4;     // points the reader drags along each curve
  var CURVE_STEPS = 33;      // points the curve is handed to the model as
  var HANDLE_REACH = 11;     // CSS pixels a handle answers a pointer within

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  var el = function (id) { return document.getElementById(id); };
  var ui = {
    drop: el('drop'), file: el('file'), pick: el('pick'), change: el('change'),
    workspace: el('workspace'), fileName: el('fileName'), fileMeta: el('fileMeta'),
    viewTabs: el('viewTabs'), pager: el('pager'), prev: el('prev'), next: el('next'),
    pageNum: el('pageNum'), pageTotal: el('pageTotal'), renderInfo: el('renderInfo'),
    preview: el('preview'), detailBefore: el('detailBefore'), detailAfter: el('detailAfter'),
    whiten: el('whiten'), strength: el('strength'),
    despeckle: el('despeckle'), speckSize: el('speckSize'), speckInfo: el('speckInfo'),
    deband: el('deband'), bandInfo: el('bandInfo'),
    deskew: el('deskew'), tiltAngle: el('tiltAngle'), tiltAuto: el('tiltAuto'),
    tiltInfo: el('tiltInfo'),
    dewarp: el('dewarp'), curveReset: el('curveReset'), curveInfo: el('curveInfo'),
    align: el('align'), alignInfo: el('alignInfo'),
    dpi: el('dpi'), rangeFrom: el('rangeFrom'), rangeTo: el('rangeTo'),
    go: el('go'), status: el('status'), install: el('install'),
  };

  var state = {
    file: null, pdf: null, pageCount: 0, page: 1,
    whiten: true, strength: 0.5, despeckle: true, speckSize: 1, deband: true,
    deskew: false, dewarp: false, align: false, dpi: 300,
    view: 'after',
    angles: {},     // pages whose angle was set by hand: page number → degrees
    curves: {},     // pages with curves laid on them: page number → { top, bottom }
    drag: null,
    source: null,   // the page as it was rendered: { page, dpi, canvas, gray, w, h, auto }
    result: null,   // what cleaning made of it: { canvas, removed, box }
    focus: null,    // the point the life-size windows are centred on
    token: 0,
    timer: null,
  };

  function status(text) { ui.status.textContent = text || ''; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function options() {
    return {
      whiten: state.whiten,
      strength: state.strength,
      despeckle: state.despeckle,
      speckSize: state.speckSize,
      deband: state.deband,
    };
  }

  function effectiveRange() {
    var from = clamp(parseInt(ui.rangeFrom.value, 10) || 1, 1, state.pageCount || 1);
    var to = clamp(parseInt(ui.rangeTo.value, 10) || state.pageCount, 1, state.pageCount || 1);
    if (to < from) { var t = from; from = to; to = t; }
    return { from: from, to: to };
  }

  /* ---------------------------------------------------------------- loading */

  function openFile(file) {
    if (!file) return;
    state.file = file;
    state.pdf = null;
    state.source = null;
    state.result = null;
    state.focus = null;
    state.angles = {};
    state.curves = {};
    state.page = 1;
    ui.fileName.textContent = file.name;
    ui.fileMeta.textContent = file.size > 1048576
      ? (file.size / 1048576).toFixed(1) + ' MB'
      : Math.round(file.size / 1024) + ' kB';
    ui.drop.hidden = true;
    ui.workspace.hidden = false;
    status('');
    file.arrayBuffer().then(function (buf) {
      // pdf.js may detach the buffer it is given, so hand it a private copy
      return pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    }).then(function (pdf) {
      state.pdf = pdf;
      state.pageCount = pdf.numPages;
      ui.pageTotal.textContent = '/ ' + pdf.numPages;
      ui.pageNum.max = pdf.numPages;
      ui.pageNum.value = 1;
      ui.rangeFrom.max = pdf.numPages;
      ui.rangeTo.max = pdf.numPages;
      ui.rangeFrom.value = '';
      ui.rangeTo.value = '';
      ui.go.disabled = false;
      refresh(true);
    }).catch(function (err) {
      status('Cannot open PDF: ' + err.message);
    });
  }

  ui.pick.addEventListener('click', function () { ui.file.click(); });
  ui.change.addEventListener('click', function () { ui.file.click(); });
  ui.file.addEventListener('change', function () { openFile(ui.file.files[0]); });

  ['dragenter', 'dragover'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      e.preventDefault();
      ui.drop.classList.add('over');
    });
  });
  window.addEventListener('dragleave', function (e) {
    if (e.relatedTarget === null) ui.drop.classList.remove('over');
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    ui.drop.classList.remove('over');
    openFile(e.dataTransfer.files[0]);
  });

  /* --------------------------------------------------------------- pixels */

  function renderPage(page, dpi) {
    var rotation = page.rotate % 360;
    var scale = dpi / 72;
    var probe = page.getViewport({ scale: scale, rotation: rotation });
    var pixels = probe.width * probe.height;
    if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
    var viewport = page.getViewport({ scale: scale, rotation: rotation });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
      return canvas;
    });
  }

  function toGray(canvas) {
    var image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    var d = image.data, gray = new Uint8Array(canvas.width * canvas.height);
    for (var i = 0, p = 0; p < gray.length; i += 4, p++) {
      gray[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    }
    return gray;
  }

  function fromGray(gray, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    var image = ctx.createImageData(w, h);
    var d = image.data;
    for (var i = 0, p = 0; p < gray.length; i += 4, p++) {
      d[i] = d[i + 1] = d[i + 2] = gray[p];
      d[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  function release(canvas) {
    if (!canvas) return;
    canvas.width = 1;
    canvas.height = 1;
  }

  /*
   * The last step and the only one that moves a pixel. The angle is read off
   * the page the cleaning rules have already been over, because the gutter's
   * shadow and the strip up the side are the darkest things on a scan and a
   * projection profile counts them as text; and the rules themselves are left
   * to measure ink the scanner made rather than ink an interpolation has
   * smeared. Pass `known` to reuse an angle already measured for this page, or
   * to turn it by one the reader set by hand.
   */
  function straighten(gray, w, h, known) {
    var angle = known === undefined ? DeskewCore.measureSkew(gray, w, h) : known;
    return { gray: DeskewCore.rotateGray(gray, w, h, angle), angle: angle };
  }

  function contentBox(gray, w, h) {
    return CleanCore.textBox(gray, w, h, CleanCore.threshold(gray));
  }

  // handles are kept as fractions of the sheet, so they survive a change of dpi
  function defaultCurves(box, w, h) {
    var x0 = box ? box.x0 / w : 0.1, x1 = box ? box.x1 / w : 0.9;
    var y0 = box ? box.y0 / h : 0.1, y1 = box ? box.y1 / h : 0.9;
    var top = [], bottom = [];
    for (var i = 0; i < CURVE_HANDLES; i++) {
      var x = x0 + (x1 - x0) * (i / (CURVE_HANDLES - 1));
      top.push({ x: x, y: y0 });
      bottom.push({ x: x, y: y1 });
    }
    return { top: top, bottom: bottom };
  }

  function spline(a, b, c, d, t) {
    var t2 = t * t;
    return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2
      + (3 * b - a - 3 * c + d) * t2 * t);
  }

  function polyline(points, w, h) {
    var out = [], last = points.length - 1;
    for (var s = 0; s < CURVE_STEPS; s++) {
      var t = (s / (CURVE_STEPS - 1)) * last;
      var i = Math.min(last - 1, t | 0), f = t - i;
      var p0 = points[i > 0 ? i - 1 : 0], p1 = points[i], p2 = points[i + 1];
      var p3 = points[i + 2 <= last ? i + 2 : last];
      out.push({
        x: spline(p0.x, p1.x, p2.x, p3.x, f) * w,
        y: spline(p0.y, p1.y, p2.y, p3.y, f) * h,
      });
    }
    return out;
  }

  function curvesFor(page, gray, w, h) {
    if (!state.curves[page]) state.curves[page] = defaultCurves(contentBox(gray, w, h), w, h);
    return state.curves[page];
  }

  function flatten(gray, w, h, pair) {
    return DewarpCore.dewarpGray(gray, w, h, polyline(pair.top, w, h), polyline(pair.bottom, w, h));
  }

  // slides only: what leaves one edge is the white the block was pushed against
  function centreContent(canvas, box) {
    var w = canvas.width, h = canvas.height;
    var dx = Math.round((w - box.x0 - box.x1) / 2);
    var dy = Math.round((h - box.y0 - box.y1) / 2);
    if (!dx && !dy) return { canvas: canvas, dx: 0, dy: 0 };
    var out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, dx, dy);
    return { canvas: out, dx: dx, dy: dy };
  }

  /* -------------------------------------------------------------- preview */

  async function refresh(reload) {
    if (!state.pdf) return;
    var token = ++state.token;
    var dpi = state.dpi;
    var stale = !state.source || state.source.page !== state.page || state.source.dpi !== dpi;
    if (reload || stale) {
      status('Rendering page ' + state.page + '…');
      var page = await state.pdf.getPage(state.page);
      var canvas = await renderPage(page, dpi);
      page.cleanup();
      if (token !== state.token) { release(canvas); return; }
      release(state.source && state.source.canvas);
      state.source = {
        page: state.page, dpi: dpi, canvas: canvas,
        gray: toGray(canvas), w: canvas.width, h: canvas.height,
      };
      state.focus = null;
    }

    var src = state.source;
    status('Cleaning…');
    // let the status line paint before the main thread goes away for a moment
    await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
    if (token !== state.token) return;

    var out = CleanCore.clean(src.gray, src.w, src.h, options());
    var byHand = state.angles[state.page];
    var pixels = out.gray, angle = 0;
    if (state.deskew) {
      var turn = straighten(out.gray, src.w, src.h, byHand === undefined ? src.auto : byHand);
      if (byHand === undefined) src.auto = turn.angle;
      angle = turn.angle;
      pixels = turn.gray;
    }
    var curves = null;
    if (state.dewarp) {
      curves = curvesFor(state.page, pixels, src.w, src.h);
      pixels = flatten(pixels, src.w, src.h, curves);
    }
    var sheet = fromGray(pixels, src.w, src.h);
    var box = out.box, shift = null;
    if (state.align) {
      var found = contentBox(pixels, src.w, src.h);
      if (found) {
        shift = centreContent(sheet, found);
        if (shift.canvas !== sheet) { release(sheet); sheet = shift.canvas; }
        box = {
          x0: found.x0 + shift.dx, x1: found.x1 + shift.dx,
          y0: found.y0 + shift.dy, y1: found.y1 + shift.dy,
        };
      }
    }
    release(state.result && state.result.canvas);
    state.result = { canvas: sheet, removed: out.removed, box: box };
    if (!state.focus) {
      state.focus = box
        ? { x: (box.x0 + box.x1) / 2, y: box.y0 + (box.y1 - box.y0) * 0.35 }
        : { x: src.w / 2, y: src.h / 2 };
    }
    ui.renderInfo.textContent = src.w + ' × ' + src.h + ' pixels at ' + src.dpi + ' dpi';
    // not while it is being typed into, or the cursor jumps mid-number
    if (document.activeElement !== ui.tiltAngle) {
      ui.tiltAngle.value = state.deskew ? angle.toFixed(2) : '';
    }
    ui.tiltAngle.disabled = !state.deskew;
    ui.tiltAuto.disabled = !state.deskew || byHand === undefined;
    ui.tiltInfo.textContent = !state.deskew
      ? 'Pages are left at the angle they were scanned.'
      : (byHand !== undefined
        ? 'This page is turned ' + angle.toFixed(2) + '° by hand. Every other page is still measured.'
        : (angle
          ? 'This page leaned ' + Math.abs(angle).toFixed(2) + '° and has been turned back.'
          : 'This page is straight, or carries nothing straight enough to measure.'));
    ui.curveReset.disabled = !state.dewarp;
    ui.curveInfo.textContent = !state.dewarp
      ? 'Pages are left with whatever bend the binding gave them.'
      : 'Drag the handles so the curves follow the top and the bottom of the type. This page bends '
        + Math.round(Math.abs(curves.top[1].y - curves.top[0].y) * src.h) + ' pixels away from straight.';
    ui.alignInfo.textContent = !state.align
      ? 'Pages keep the place on the sheet the scanner gave them.'
      : (shift && (shift.dx || shift.dy)
        ? 'This page was slid into the middle: ' + Math.abs(shift.dx) + ' pixels sideways, '
          + Math.abs(shift.dy) + ' up or down.'
        : 'This page is already in the middle, or carries nothing to line up.');
    ui.bandInfo.textContent = state.deband
      ? out.bands + ' band' + (out.bands === 1 ? '' : 's') + ' taken off this page.'
      : 'Bands are left where they are.';
    ui.speckInfo.textContent = state.despeckle
      ? out.removed + ' speck' + (out.removed === 1 ? '' : 's') + ' removed on this page. None'
        + ' wider than ' + Math.max(2, Math.round(out.stroke * 1.6 * state.speckSize))
        + ' pixels, against a stroke of ' + out.stroke + ', and none with ink beside it.'
      : 'Nothing is being removed.';
    drawStage();
    drawDetail();
    status('');
  }

  /*
   * The page is shown at whatever is left of the screen below the header, rather
   * than at full width: a tall page drawn 880 pixels across pushes the life-size
   * pair and the controls out of sight, and takes several screens on a phone.
   * The canvas still carries the screen's pixel ratio, so it is no softer for it.
   */
  function viewSize(aspect) {
    var stage = ui.preview.parentElement;
    var pad = parseFloat(getComputedStyle(stage).paddingLeft) || 0;
    var room = Math.max(200, stage.clientWidth - pad * 2);
    var w = Math.min(PREVIEW_WIDTH, room);
    var h = w * aspect;
    var free = window.innerHeight - stage.getBoundingClientRect().top - window.scrollY;
    var roof = Math.max(VIEW_MIN_HEIGHT, free - pad * 2 - 24);
    if (h > roof) { h = roof; w = h / aspect; }
    return { w: Math.round(w), h: Math.round(h) };
  }

  var fitTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(drawStage, 120);
  });

  function drawStage() {
    var src = state.source;
    if (!src || !state.result) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var view = viewSize(src.h / src.w);
    var w = Math.round(view.w * dpr);
    var h = Math.round(view.h * dpr);
    ui.preview.width = w;
    ui.preview.height = h;
    ui.preview.style.width = view.w + 'px';
    ui.preview.style.height = view.h + 'px';
    var ctx = ui.preview.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(state.view === 'before' ? src.canvas : state.result.canvas, 0, 0, w, h);

    var scale = w / src.w;
    var pair = state.dewarp && state.curves[state.page];
    if (pair) {
      ctx.strokeStyle = 'rgba(47, 111, 208, .95)';
      ctx.lineWidth = 2 * dpr;
      [pair.top, pair.bottom].forEach(function (points) {
        ctx.beginPath();
        polyline(points, src.w, src.h).forEach(function (p, i) {
          if (i) ctx.lineTo(p.x * scale, p.y * scale);
          else ctx.moveTo(p.x * scale, p.y * scale);
        });
        ctx.stroke();
        ctx.fillStyle = '#fff';
        points.forEach(function (p) {
          ctx.beginPath();
          ctx.arc(p.x * src.w * scale, p.y * src.h * scale, 5 * dpr, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        });
      });
    }
    if (state.focus) {
      ctx.strokeStyle = 'rgba(20, 26, 34, .75)';
      ctx.lineWidth = dpr;
      ctx.strokeRect(
        (state.focus.x - DETAIL_W / 2) * scale, (state.focus.y - DETAIL_H / 2) * scale,
        DETAIL_W * scale, DETAIL_H * scale,
      );
    }
  }

  function drawDetail() {
    var src = state.source;
    if (!src || !state.result || !state.focus) return;
    var w = Math.min(DETAIL_W, src.w), h = Math.min(DETAIL_H, src.h);
    var sx = clamp(Math.round(state.focus.x - w / 2), 0, src.w - w);
    var sy = clamp(Math.round(state.focus.y - h / 2), 0, src.h - h);
    [[ui.detailBefore, src.canvas], [ui.detailAfter, state.result.canvas]].forEach(function (pair) {
      var canvas = pair[0];
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(pair[1], sx, sy, w, h, 0, 0, w, h);
    });
  }

  function handleAt(e) {
    var pair = state.dewarp && state.source && state.curves[state.page];
    if (!pair) return null;
    var rect = ui.preview.getBoundingClientRect();
    var fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
    var reach = HANDLE_REACH / rect.width, best = null, nearest = reach * reach;
    ['top', 'bottom'].forEach(function (which) {
      pair[which].forEach(function (p, i) {
        var dx = p.x - fx, dy = (p.y - fy) * (rect.height / rect.width);
        var distance = dx * dx + dy * dy;
        if (distance <= nearest) { nearest = distance; best = { which: which, index: i }; }
      });
    });
    return best;
  }

  ui.preview.addEventListener('pointerdown', function (e) {
    var hit = handleAt(e);
    if (!hit) return;
    state.drag = hit;
    ui.preview.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  ui.preview.addEventListener('pointermove', function (e) {
    if (!state.drag) return;
    var rect = ui.preview.getBoundingClientRect();
    var point = state.curves[state.page][state.drag.which][state.drag.index];
    point.x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    point.y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    drawStage();
  });
  ui.preview.addEventListener('pointerup', function () {
    if (!state.drag) return;
    state.drag = null;
    refresh(false);
  });

  ui.preview.addEventListener('click', function (e) {
    if (!state.source || handleAt(e)) return;
    var rect = ui.preview.getBoundingClientRect();
    var scale = state.source.w / rect.width;
    state.focus = {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top) * scale,
    };
    drawStage();
    drawDetail();
  });

  /* -------------------------------------------------------------- controls */

  function later() {
    clearTimeout(state.timer);
    state.timer = setTimeout(function () { refresh(false); }, SETTLE);
  }

  Array.prototype.forEach.call(ui.viewTabs.children, function (button) {
    button.addEventListener('click', function () {
      state.view = button.dataset.view;
      Array.prototype.forEach.call(ui.viewTabs.children, function (b) {
        b.classList.toggle('on', b === button);
      });
      drawStage();
    });
  });

  ui.whiten.addEventListener('change', function () {
    state.whiten = ui.whiten.checked;
    ui.strength.disabled = !state.whiten;
    refresh(false);
  });
  ui.deband.addEventListener('change', function () {
    state.deband = ui.deband.checked;
    refresh(false);
  });
  ui.deskew.addEventListener('change', function () {
    state.deskew = ui.deskew.checked;
    refresh(false);
  });
  ui.tiltAngle.addEventListener('input', function () {
    var typed = parseFloat(ui.tiltAngle.value);
    if (isNaN(typed)) return;
    state.angles[state.page] = clamp(typed, -TILT_LIMIT, TILT_LIMIT);
    later();
  });
  ui.tiltAuto.addEventListener('click', function () {
    delete state.angles[state.page];
    refresh(false);
  });
  ui.dewarp.addEventListener('change', function () {
    state.dewarp = ui.dewarp.checked;
    refresh(false);
  });
  ui.curveReset.addEventListener('click', function () {
    delete state.curves[state.page];
    refresh(false);
  });
  ui.align.addEventListener('change', function () {
    state.align = ui.align.checked;
    refresh(false);
  });
  ui.despeckle.addEventListener('change', function () {
    state.despeckle = ui.despeckle.checked;
    ui.speckSize.disabled = !state.despeckle;
    refresh(false);
  });
  ui.strength.addEventListener('input', function () {
    state.strength = ui.strength.value / 100;
    later();
  });
  ui.speckSize.addEventListener('input', function () {
    state.speckSize = ui.speckSize.value / 100;
    later();
  });
  ui.dpi.addEventListener('change', function () {
    state.dpi = parseInt(ui.dpi.value, 10);
    refresh(true);
  });

  function goToPage(n) {
    state.page = clamp(n, 1, state.pageCount);
    ui.pageNum.value = state.page;
    refresh(true);
  }
  ui.prev.addEventListener('click', function () { goToPage(state.page - 1); });
  ui.next.addEventListener('click', function () { goToPage(state.page + 1); });
  ui.pageNum.addEventListener('change', function () {
    goToPage(parseInt(ui.pageNum.value, 10) || 1);
  });

  /* ----------------------------------------------------------------- output */

  function jpegBytes(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('the page could not be encoded')); return; }
        resolve(blob.arrayBuffer());
      }, 'image/jpeg', QUALITY);
    });
  }

  ui.go.addEventListener('click', async function () {
    if (!state.pdf) return;
    ui.go.disabled = true;
    var range = effectiveRange();
    var removed = 0, bands = 0, turned = 0, largest = 0, lined = 0, flattened = 0;
    try {
      var doc = await PDFLib.PDFDocument.create();
      for (var n = range.from; n <= range.to; n++) {
        status('Cleaning page ' + n + ' of ' + range.to + '…');
        // hand the main thread back so the status line above actually moves
        await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
        var page = await state.pdf.getPage(n);
        var canvas = await renderPage(page, state.dpi);
        var size = page.getViewport({ scale: 1, rotation: page.rotate % 360 });
        page.cleanup();
        var out = CleanCore.clean(toGray(canvas), canvas.width, canvas.height, options());
        removed += out.removed;
        bands += out.bands;
        var pixels = out.gray;
        if (state.deskew) {
          var turn = straighten(out.gray, canvas.width, canvas.height, state.angles[n]);
          pixels = turn.gray;
          if (turn.angle) { turned++; largest = Math.max(largest, Math.abs(turn.angle)); }
        }
        if (state.dewarp) {
          pixels = flatten(pixels, canvas.width, canvas.height,
            curvesFor(n, pixels, canvas.width, canvas.height));
          flattened++;
        }
        var cleaned = fromGray(pixels, canvas.width, canvas.height);
        release(canvas);
        if (state.align) {
          var found = contentBox(pixels, cleaned.width, cleaned.height);
          if (found) {
            var placed = centreContent(cleaned, found);
            if (placed.canvas !== cleaned) { release(cleaned); cleaned = placed.canvas; }
            if (placed.dx || placed.dy) lined++;
          }
        }
        var image = await doc.embedJpg(await jpegBytes(cleaned));
        release(cleaned);
        var sheet = doc.addPage([size.width, size.height]);
        sheet.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      }
      var bytes = await doc.save();
      save(bytes, state.file.name.replace(/\.pdf$/i, '') + '-clean.pdf');
      status('Done: ' + (range.to - range.from + 1) + ' pages, '
        + removed + ' specks and ' + bands + ' bands removed, '
        + (state.deskew
          ? (turned
            ? turned + ' page' + (turned === 1 ? '' : 's') + ' straightened by up to '
              + largest.toFixed(1) + '°, '
            : 'no page crooked enough to straighten, ')
          : '')
        + (state.dewarp
          ? flattened + ' page' + (flattened === 1 ? '' : 's') + ' flattened, '
          : '')
        + (state.align
          ? (lined
            ? lined + ' page' + (lined === 1 ? '' : 's') + ' lined up, '
            : 'no page needed lining up, ')
          : '')
        + (bytes.length / 1048576).toFixed(1) + ' MB.');
    } catch (err) {
      status('Error: ' + err.message);
    }
    ui.go.disabled = false;
  });

  function save(bytes, name) {
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    // removing the anchor right away cancels the download in some browsers
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 30000);
  }

  /* ------------------------------------------------------- install / offline */

  // Only over http(s): a service worker cannot be registered from file://
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {
        // offline support is a bonus; the app works without it
      });
    });
  }

  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installPrompt = e;
    ui.install.hidden = false;
  });
  ui.install.addEventListener('click', function () {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt = null;
    ui.install.hidden = true;
  });
  window.addEventListener('appinstalled', function () { ui.install.hidden = true; });
})();
