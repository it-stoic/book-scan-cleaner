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
    deskew: el('deskew'), tiltInfo: el('tiltInfo'),
    dpi: el('dpi'), rangeFrom: el('rangeFrom'), rangeTo: el('rangeTo'),
    go: el('go'), status: el('status'), install: el('install'),
  };

  var state = {
    file: null, pdf: null, pageCount: 0, page: 1,
    whiten: true, strength: 0.5, despeckle: true, speckSize: 1, deband: true,
    deskew: false, dpi: 300,
    view: 'after',
    source: null,   // the page as it was rendered: { page, dpi, canvas, gray, w, h, angle }
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
   * smeared. Pass `known` to reuse an angle already measured for this page.
   */
  function straighten(gray, w, h, known) {
    var angle = known === undefined ? DeskewCore.measureSkew(gray, w, h) : known;
    return { gray: DeskewCore.rotateGray(gray, w, h, angle), angle: angle };
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
    var pixels = out.gray, angle = 0;
    if (state.deskew) {
      var turn = straighten(out.gray, src.w, src.h, src.angle);
      src.angle = angle = turn.angle;
      pixels = turn.gray;
    }
    release(state.result && state.result.canvas);
    state.result = {
      canvas: fromGray(pixels, src.w, src.h),
      removed: out.removed,
      box: out.box,
    };
    if (!state.focus) {
      var box = out.box;
      state.focus = box
        ? { x: (box.x0 + box.x1) / 2, y: box.y0 + (box.y1 - box.y0) * 0.35 }
        : { x: src.w / 2, y: src.h / 2 };
    }
    ui.renderInfo.textContent = src.w + ' × ' + src.h + ' pixels at ' + src.dpi + ' dpi';
    ui.tiltInfo.textContent = !state.deskew
      ? 'Pages are left at the angle they were scanned.'
      : (angle
        ? 'This page leaned ' + Math.abs(angle).toFixed(2) + '° and has been turned back.'
        : 'This page is straight, or carries nothing straight enough to measure.');
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

  ui.preview.addEventListener('click', function (e) {
    if (!state.source) return;
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
    var removed = 0, bands = 0, turned = 0, largest = 0;
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
          var turn = straighten(out.gray, canvas.width, canvas.height);
          pixels = turn.gray;
          if (turn.angle) { turned++; largest = Math.max(largest, Math.abs(turn.angle)); }
        }
        var cleaned = fromGray(pixels, canvas.width, canvas.height);
        release(canvas);
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
