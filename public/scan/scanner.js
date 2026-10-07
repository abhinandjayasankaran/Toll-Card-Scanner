/* Phone scanner: live card detection, auto-capture, flatten, upload. */
/* global CardDetector */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const DETECT_MAX_DIM = 400; // live preview analysis size (see CardDetector scales)
  const OUT_WIDTH = 1600; // saved card image width (height follows the card ratio)
  const STABLE_MS = 450; // card must stay put this long before auto-capture
  const STABLE_DELTA = 0.03; // allowed corner jitter between frames (fraction of card size)
  const REARM_LOST_FRAMES = 3; // frames without a card before the next auto-capture
  const MOVED_DELTA = 0.25; // ...or the card moved this much

  // ------------------------------------------------------------ settings
  const local = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('tcs.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('tcs.' + key, JSON.stringify(value));
      } catch (e) {
        /* private mode */
      }
    },
  };

  const params = new URLSearchParams(location.search);
  let token = params.get('k') || local.get('token', '');
  if (params.get('k')) local.set('token', token);
  if (token) $('manifest-link').href = 'manifest.webmanifest?k=' + encodeURIComponent(token);

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const settings = {
    auto: local.get('auto', true),
    sound: local.get('sound', true),
    hires: local.get('hires', true),
    device: local.get('device', '') || (isIOS ? 'iPhone' : 'Phone'),
  };

  function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (token) headers['X-Access-Token'] = token;
    return fetch(path, Object.assign({}, opts, { headers, credentials: 'same-origin', cache: 'no-store' }));
  }

  const formatNumber = (n) => (n ? n.replace(/(\d{4})(?=\d)/g, '$1 ') : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uuid = () =>
    crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);

  // ------------------------------------------------------------- pairing
  const pairEl = $('pair-status');
  function setPair(cls, text) {
    pairEl.className = 'pill ' + cls;
    pairEl.textContent = text;
  }

  async function checkPairing() {
    try {
      const res = await api('/api/pair');
      if (res.ok) setPair('pill-ok', '✓ Connected to your Mac');
      else if (res.status === 401) setPair('pill-bad', 'Not paired – scan the QR code on the Mac portal');
      else setPair('pill-bad', 'Mac replied with an error (' + res.status + ')');
      return res.ok;
    } catch (e) {
      setPair('pill-bad', 'Can’t reach your Mac – same Wi-Fi? Scanner running?');
      return false;
    }
  }

  // --------------------------------------------------------- live events
  let events = null;
  function setConn(on) {
    $('conn').className = 'conn ' + (on ? 'conn-on' : 'conn-off');
    $('conn').querySelector('span').textContent = on ? 'Mac connected' : 'Offline';
  }
  function setTotal(stats) {
    if (!stats) return;
    $('total').textContent = stats.total;
    $('total-unit').textContent = stats.total === 1 ? 'card' : 'cards';
  }
  function connectEvents() {
    if (events) events.close();
    const q = new URLSearchParams({ role: 'scanner', device: settings.device });
    if (token) q.set('k', token);
    events = new EventSource('/api/events?' + q.toString());
    events.onopen = () => {
      setConn(true);
      pumpQueue();
    };
    events.onerror = () => setConn(false);
    const onStats = (e) => {
      try {
        setTotal(JSON.parse(e.data).stats);
      } catch (err) {
        /* ignore */
      }
    };
    ['hello', 'add', 'update', 'remove', 'reset'].forEach((t) => events.addEventListener(t, onStats));
  }

  // -------------------------------------------------------------- worker
  const worker = new Worker('detector-worker.js');
  let workerReady = false;
  const pending = new Map();
  let callId = 0;

  function workerCall(msg, transfer) {
    const id = ++callId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') {
      workerReady = true;
      const btn = $('start-btn');
      btn.disabled = false;
      btn.textContent = 'Start scanning';
      return;
    }
    if (m.type === 'fatal') {
      showStartError('The scanner engine could not start on this phone:\n' + m.message);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (e) => showStartError('The scanner engine failed to load (' + (e.message || 'unknown error') + ').');

  // -------------------------------------------------------------- camera
  const video = $('video');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  let stream = null;
  let running = false;

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function startCamera() {
    stopCamera();
    const size = settings.hires ? { width: { ideal: 3840 }, height: { ideal: 2160 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: Object.assign({ facingMode: { ideal: 'environment' } }, size),
    });
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      }
    } catch (e) {
      /* not supported */
    }
  }

  function showStartError(text) {
    const el = $('start-error');
    el.textContent = text;
    el.hidden = false;
    $('start').hidden = false;
    $('camera').hidden = true;
  }

  // ---------------------------------------------------------- wake lock
  let wakeLock = null;
  async function keepAwake() {
    try {
      if (navigator.wakeLock && (!wakeLock || wakeLock.released)) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      /* not supported / denied */
    }
  }

  // ---------------------------------------------------------------- sound
  let audio = null;
  function unlockAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) {
      audio = null;
    }
  }
  function beep(freq, delay, dur) {
    if (!settings.sound || !audio) return;
    const t = audio.currentTime + (delay || 0);
    const d = dur || 0.09;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + d + 0.03);
  }

  // ------------------------------------------------------ geometry helpers
  function videoBox() {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const s = Math.max(r.width / vw, r.height / vh); // object-fit: cover
    return { r, vw, vh, s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2 };
  }

  /** The on-screen guide frame, in video pixels (used for manual capture). */
  function guideQuad() {
    const b = videoBox();
    const g = $('guide').getBoundingClientRect();
    const toVideo = (x, y) => ({ x: (x - b.r.left - b.ox) / b.s, y: (y - b.r.top - b.oy) / b.s });
    return [toVideo(g.left, g.top), toVideo(g.right, g.top), toVideo(g.right, g.bottom), toVideo(g.left, g.bottom)].map((p) => ({
      x: Math.max(0, Math.min(b.vw - 1, p.x)),
      y: Math.max(0, Math.min(b.vh - 1, p.y)),
    }));
  }

  function longSide(q) {
    let m = 0;
    for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(q[i].x - q[(i + 1) % 4].x, q[i].y - q[(i + 1) % 4].y));
    return m;
  }

  function sizeOverlay() {
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(overlay.clientWidth * dpr);
    overlay.height = Math.round(overlay.clientHeight * dpr);
  }
  window.addEventListener('resize', sizeOverlay);

  // ------------------------------------------------------- live tracking
  const tracker = { corners: null, seenAt: 0, stableSince: 0, lost: 0, armed: true, lastCaptured: null };
  let capturing = false;
  let frameBusy = false;
  const proc = document.createElement('canvas');
  const pctx = proc.getContext('2d', { willReadFrequently: true });

  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    if (frameBusy || capturing || !workerReady || video.readyState < 2 || !video.videoWidth) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const s = Math.min(1, DETECT_MAX_DIM / Math.max(vw, vh));
    const w = Math.round(vw * s);
    const h = Math.round(vh * s);
    if (proc.width !== w || proc.height !== h) {
      proc.width = w;
      proc.height = h;
    }
    pctx.drawImage(video, 0, 0, w, h);
    const img = pctx.getImageData(0, 0, w, h);
    frameBusy = true;
    workerCall({ type: 'detect', width: w, height: h, buffer: img.data.buffer }, [img.data.buffer])
      .then((m) => onDetected(m.result, vw / w))
      .catch(() => {})
      .then(() => {
        frameBusy = false;
      });
  }

  function onDetected(result, scale) {
    if (!running || capturing) return;
    const now = performance.now();
    const corners = result ? result.corners.map((p) => ({ x: p.x * scale, y: p.y * scale })) : null;
    if (corners) {
      if (!tracker.corners || CardDetector.quadDelta(tracker.corners, corners) > STABLE_DELTA) tracker.stableSince = now;
      tracker.lost = 0;
      tracker.seenAt = now;
    } else {
      tracker.lost++;
      tracker.stableSince = 0;
    }
    tracker.corners = corners;

    if (!tracker.armed) {
      const moved = corners && tracker.lastCaptured && CardDetector.quadDelta(tracker.lastCaptured, corners) > MOVED_DELTA;
      if (tracker.lost >= REARM_LOST_FRAMES || moved) tracker.armed = true;
    }

    const minLong = Math.min(650, 0.5 * Math.max(video.videoWidth, video.videoHeight));
    let state;
    if (!corners) state = tracker.armed ? 'search' : 'next';
    else if (!tracker.armed) state = 'next';
    else if (longSide(corners) < minLong) state = 'closer';
    else if (!settings.auto) state = 'manual';
    else if (now - tracker.stableSince >= STABLE_MS) state = 'capture';
    else state = 'steady';

    draw(corners, state);
    if (state === 'capture') capture(corners);
  }

  const HINTS = {
    search: ['Point at a card', ''],
    next: ['✓ Next card', 'ok'],
    closer: ['Move closer', 'warn'],
    manual: ['Tap the button to capture', ''],
    steady: ['Hold still…', 'ok'],
    capture: ['Capturing…', 'ok'],
  };

  function setHint(state) {
    const [text, cls] = HINTS[state] || HINTS.search;
    const el = $('hint');
    if (el.textContent !== text) el.textContent = text;
    el.className = 'hint ' + cls;
  }

  function draw(corners, state) {
    setHint(state);
    $('guide').classList.toggle('dim', !!corners);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!corners) return;
    const b = videoBox();
    const dpr = overlay.width / Math.max(1, b.r.width);
    const pts = corners.map((p) => ({ x: (p.x * b.s + b.ox) * dpr, y: (p.y * b.s + b.oy) * dpr }));
    const color =
      state === 'steady' || state === 'capture'
        ? '34,197,94'
        : state === 'closer'
          ? '245,158,11'
          : state === 'next'
            ? '160,170,180'
            : '255,255,255';
    octx.beginPath();
    pts.forEach((p, i) => (i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)));
    octx.closePath();
    octx.fillStyle = 'rgba(' + color + ',0.16)';
    octx.fill();
    octx.lineWidth = 3 * dpr;
    octx.lineJoin = 'round';
    octx.strokeStyle = 'rgba(' + color + ',0.95)';
    octx.stroke();
    octx.fillStyle = 'rgb(' + color + ')';
    pts.forEach((p) => {
      octx.beginPath();
      octx.arc(p.x, p.y, 5 * dpr, 0, Math.PI * 2);
      octx.fill();
    });
  }

  // ------------------------------------------------------------- capture
  const grab = document.createElement('canvas');
  const gctx = grab.getContext('2d', { willReadFrequently: true });
  const flat = document.createElement('canvas');
  const fctx = flat.getContext('2d');

  function thumbOf(canvas) {
    const t = document.createElement('canvas');
    t.width = 240;
    t.height = Math.round((240 * canvas.height) / canvas.width);
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.7);
  }

  async function capture(corners) {
    if (capturing || !video.videoWidth) return;
    capturing = true;
    tracker.armed = false;
    tracker.lastCaptured = corners;
    tracker.stableSince = 0;
    $('shutter').classList.add('busy');
    const fl = $('flash');
    fl.classList.remove('go');
    void fl.offsetWidth;
    fl.classList.add('go');
    beep(1320);

    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const quad = corners || guideQuad();
      const xs = quad.map((p) => p.x);
      const ys = quad.map((p) => p.y);
      const pad = 0.08 * Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs), Math.max.apply(null, ys) - Math.min.apply(null, ys));
      const x0 = Math.max(0, Math.floor(Math.min.apply(null, xs) - pad));
      const y0 = Math.max(0, Math.floor(Math.min.apply(null, ys) - pad));
      const x1 = Math.min(vw, Math.ceil(Math.max.apply(null, xs) + pad));
      const y1 = Math.min(vh, Math.ceil(Math.max.apply(null, ys) + pad));
      grab.width = x1 - x0;
      grab.height = y1 - y0;
      gctx.drawImage(video, x0, y0, grab.width, grab.height, 0, 0, grab.width, grab.height);
      const img = gctx.getImageData(0, 0, grab.width, grab.height);
      const hint = quad.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
      const out = await workerCall(
        { type: 'capture', width: grab.width, height: grab.height, buffer: img.data.buffer, hint, trustHint: !!corners, outWidth: OUT_WIDTH },
        [img.data.buffer]
      );
      flat.width = out.width;
      flat.height = out.height;
      fctx.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), out.width, out.height), 0, 0);
      const blob = await new Promise((resolve) => flat.toBlob(resolve, 'image/jpeg', 0.92));
      const item = { id: uuid(), createdAt: Date.now(), data: await blob.arrayBuffer(), thumb: thumbOf(flat), found: out.found };
      await queue.add(item);
      showLast(item, { cls: '', number: '', status: out.found ? 'Reading number…' : 'Edges not found – sent uncropped' });
      pumpQueue();
    } catch (err) {
      tracker.armed = true;
      toast('bad', 'Capture failed', String(err.message || err));
    } finally {
      capturing = false;
      $('shutter').classList.remove('busy');
    }
  }

  // --------------------------------------------------------- upload queue
  // Captures are written to IndexedDB first, so nothing is lost if Wi-Fi
  // drops or the Mac is busy; they upload in order as soon as possible.
  const queue = (function () {
    let dbp = null;
    const memory = new Map();
    function db() {
      if (!dbp) {
        dbp = new Promise((resolve, reject) => {
          const req = indexedDB.open('toll-card-scanner', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath: 'id' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }).catch(() => null);
      }
      return dbp;
    }
    function run(mode, fn) {
      return db().then(
        (d) =>
          new Promise((resolve, reject) => {
            if (!d) return resolve(fn(null));
            const tx = d.transaction('queue', mode);
            const result = fn(tx.objectStore('queue'));
            tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
            tx.onerror = () => reject(tx.error);
          })
      );
    }
    return {
      add: (item) => run('readwrite', (s) => (s ? s.put(item) : memory.set(item.id, item))),
      remove: (id) => run('readwrite', (s) => (s ? s.delete(id) : memory.delete(id))),
      all: () => run('readonly', (s) => (s ? s.getAll() : null)).then((r) => (Array.isArray(r) ? r : Array.from(memory.values()))),
    };
  })();

  let pumping = false;
  let blockedByPairing = false;
  const failures = new Map();

  function setQueueCount(n) {
    $('queue-count').textContent = n;
    $('queue').classList.toggle('active', n > 0);
  }

  async function pumpQueue() {
    if (pumping) return;
    pumping = true;
    let backoff = 1500;
    try {
      for (;;) {
        const items = (await queue.all()).sort((a, b) => a.createdAt - b.createdAt);
        setQueueCount(items.length);
        if (!items.length || blockedByPairing) break;
        const item = items[0];
        let res;
        try {
          res = await api('/api/scans', {
            method: 'POST',
            headers: { 'Content-Type': 'image/jpeg', 'X-Capture-Id': item.id, 'X-Device': settings.device },
            body: new Blob([item.data], { type: 'image/jpeg' }),
          });
        } catch (netErr) {
          setConn(false);
          showLast(item, { cls: 'warn', number: '', status: 'Waiting for the Mac… (' + items.length + ' queued)' });
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 15000);
          continue;
        }
        backoff = 1500;
        if (res.status === 401) {
          blockedByPairing = true;
          showLast(item, { cls: 'bad', number: '', status: 'Not paired – scan the QR code on the Mac again' });
          break;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const tries = (failures.get(item.id) || 0) + 1;
          failures.set(item.id, tries);
          if (res.status >= 500 && tries < 4) {
            await sleep(2500);
            continue;
          }
          await queue.remove(item.id);
          showResult(item, { result: 'error', error: data.error || 'Upload failed (' + res.status + ')' });
          continue;
        }
        await queue.remove(item.id);
        showResult(item, data);
      }
    } finally {
      pumping = false;
    }
  }
  window.addEventListener('online', pumpQueue);
  setInterval(pumpQueue, 10000);

  // -------------------------------------------------------------- results
  let lastScanId = null;

  function showLast(item, view) {
    const box = $('last');
    box.className = 'last ' + (view.cls || '');
    if (item && item.thumb) $('last-img').src = item.thumb;
    $('last-number').textContent = view.number ? formatNumber(view.number) : view.cls === 'bad' ? 'Not saved' : '•••• •••• •••• ••••';
    $('last-status').textContent = view.status;
    $('undo-btn').hidden = !view.undo;
  }

  let toastTimer = null;
  function toast(cls, title, number) {
    const el = $('toast');
    el.className = 'toast ' + (cls || '');
    el.innerHTML = '';
    const t = document.createElement('div');
    t.className = 't-title';
    t.textContent = title;
    el.appendChild(t);
    if (number) {
      const n = document.createElement('div');
      n.className = 't-number';
      n.textContent = number;
      el.appendChild(n);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 1600);
  }

  function showResult(item, data) {
    const scan = data.scan || {};
    if (data.stats) setTotal(data.stats);
    if (data.result === 'saved') {
      lastScanId = scan.id;
      showLast(item, { cls: 'ok', number: scan.number, status: '✓ Saved as ' + scan.file, undo: true });
      toast('', '✓ Saved', formatNumber(scan.number));
      beep(1760, 0.12, 0.08);
    } else if (data.result === 'review') {
      lastScanId = scan.id;
      const status = scan.number ? 'Saved – please double-check this number on the Mac' : 'Saved – number not readable, type it in on the Mac';
      showLast(item, { cls: 'warn', number: scan.number, status, undo: true });
      toast('warn', scan.number ? 'Saved – check number' : 'Number not readable', scan.number ? formatNumber(scan.number) : 'Fix it on the Mac');
      beep(660, 0.12, 0.15);
    } else if (data.result === 'duplicate') {
      showLast(item, { cls: 'warn', number: scan.number, status: 'Already scanned (#' + scan.seq + ') – skipped' });
      toast('warn', 'Already scanned – skipped', formatNumber(scan.number));
      beep(520, 0.12, 0.1);
      beep(520, 0.28, 0.1);
    } else {
      showLast(item, { cls: 'bad', number: '', status: data.error || 'Upload failed' });
      toast('bad', 'Not saved', data.error || '');
      beep(300, 0.12, 0.25);
    }
  }

  $('undo-btn').addEventListener('click', async () => {
    if (!lastScanId) return;
    const id = lastScanId;
    lastScanId = null;
    $('undo-btn').hidden = true;
    try {
      const res = await api('/api/scans/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      showLast(null, { cls: '', number: '', status: 'Removed – scan the card again' });
      tracker.armed = true;
    } catch (e) {
      toast('bad', 'Could not undo', e.message);
    }
  });

  // ------------------------------------------------------------ controls
  function applyAuto() {
    const b = $('auto-btn');
    b.classList.toggle('on', settings.auto);
    b.setAttribute('aria-pressed', String(settings.auto));
    $('opt-auto').checked = settings.auto;
  }

  $('auto-btn').addEventListener('click', () => {
    settings.auto = !settings.auto;
    local.set('auto', settings.auto);
    applyAuto();
  });

  $('shutter').addEventListener('click', () => {
    unlockAudio();
    const fresh = tracker.corners && performance.now() - tracker.seenAt < 400;
    capture(fresh ? tracker.corners : null);
  });

  $('settings-btn').addEventListener('click', () => {
    $('opt-sound').checked = settings.sound;
    $('opt-hires').checked = settings.hires;
    $('opt-device').value = settings.device;
    const track = stream && stream.getVideoTracks()[0];
    const s = track && track.getSettings ? track.getSettings() : {};
    $('sheet-info').textContent = 'Camera: ' + (video.videoWidth || s.width || '?') + '×' + (video.videoHeight || s.height || '?') + ' · Mac: ' + location.host;
    $('sheet').hidden = false;
  });

  $('sheet').addEventListener('click', (e) => {
    if (e.target.id === 'sheet') $('sheet-close').click();
  });

  $('sheet-close').addEventListener('click', async () => {
    $('sheet').hidden = true;
    settings.auto = $('opt-auto').checked;
    settings.sound = $('opt-sound').checked;
    const hires = $('opt-hires').checked;
    const device = $('opt-device').value.trim() || (isIOS ? 'iPhone' : 'Phone');
    local.set('auto', settings.auto);
    local.set('sound', settings.sound);
    applyAuto();
    if (device !== settings.device) {
      settings.device = device;
      local.set('device', device);
      connectEvents();
    }
    if (hires !== settings.hires) {
      settings.hires = hires;
      local.set('hires', hires);
      if (running) await startCamera().catch((e) => toast('bad', 'Camera error', e.message));
    }
  });

  $('start-btn').addEventListener('click', async () => {
    unlockAudio();
    $('start-error').hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showStartError('The camera is only available over the secure link.\nOpen the scanner by scanning the QR code on the Mac portal.');
      return;
    }
    try {
      await startCamera();
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showStartError(
        denied
          ? 'Camera access was blocked.\nAllow it in Settings → Apps → Safari → Camera (or tap “aA” → Website Settings → Camera), then try again.'
          : 'Could not open the camera: ' + (err && err.message ? err.message : err)
      );
      return;
    }
    $('start').hidden = true;
    $('camera').hidden = false;
    sizeOverlay();
    running = true;
    keepAwake();
    requestAnimationFrame(loop);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    pumpQueue();
    if (!running) return;
    keepAwake();
    const track = stream && stream.getVideoTracks()[0];
    if (!track || track.readyState === 'ended') startCamera().catch((e) => showStartError('Could not restart the camera: ' + e.message));
  });

  // ---------------------------------------------------------------- boot
  applyAuto();
  if (isIOS && !navigator.standalone) $('install-tip').hidden = false;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* untrusted certificate: works, just without offline caching */
    });
  }
  checkPairing().then((ok) => {
    if (ok) {
      blockedByPairing = false;
      connectEvents();
      pumpQueue();
    }
  });
  queue.all().then((items) => setQueueCount(items.length));
})();
