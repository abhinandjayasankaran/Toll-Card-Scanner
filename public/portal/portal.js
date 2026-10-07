/* Desktop portal: live list of scanned cards, review, exports. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const scans = new Map(); // id -> scan
  let order = []; // ids in scan order (oldest first)
  let filter = 'all';
  let sort = 'new';
  let query = '';
  let viewingId = null;
  let info = null;

  const fmt = (n) => (n ? n.replace(/(\d{4})(?=\d)/g, '$1 ') : '');
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });

  async function api(path, opts) {
    opts = Object.assign({ cache: 'no-store' }, opts || {});
    opts.headers = Object.assign({ 'X-Requested-With': 'toll-card-scanner' }, opts.headers || {});
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed (' + res.status + ')');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(text, cls) {
    const el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  // ---------------------------------------------------------------- stats
  function setStats(stats) {
    if (!stats) return;
    $('stat-total').textContent = stats.total;
    $('stat-review').textContent = stats.review;
    $('stat-review-wrap').hidden = !stats.review;
    $('seg-review').textContent = stats.review ? stats.review : '';
    document.title = (stats.total ? '(' + stats.total + ') ' : '') + 'Toll Card Scanner';
  }

  function setPresence(p) {
    const chip = $('phone-chip');
    const n = (p && p.scanners) || 0;
    chip.className = 'chip ' + (n ? 'chip-on' : 'chip-off');
    chip.querySelector('span').textContent = n ? (n === 1 ? p.devices[0] + ' connected' : n + ' phones connected') : 'No phone connected';
  }

  function setLive(on) {
    const chip = $('live-chip');
    chip.className = 'chip ' + (on ? 'chip-on' : 'chip-warn');
    chip.querySelector('span').textContent = on ? 'Live' : 'Reconnecting…';
  }

  // ----------------------------------------------------------------- grid
  function matches(s) {
    if (filter === 'review' && !s.needsReview) return false;
    if (query) {
      const q = query.replace(/\s+/g, '');
      if (!(s.number || '').includes(q) && !s.file.toLowerCase().includes(query.toLowerCase())) return false;
    }
    return true;
  }

  function visibleIds() {
    const ids = order.filter((id) => matches(scans.get(id)));
    return sort === 'new' ? ids.reverse() : ids;
  }

  function tileFor(s) {
    const el = document.createElement('article');
    el.className = 'tile' + (s.needsReview ? ' review' : '');
    el.dataset.id = s.id;

    const btn = document.createElement('button');
    btn.className = 'thumb';
    btn.type = 'button';
    btn.title = 'Open ' + s.file;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = s.number ? 'Card ' + s.number : 'Card without number';
    img.src = s.thumbUrl;
    btn.appendChild(img);
    btn.addEventListener('click', () => openViewer(s.id));

    const body = document.createElement('div');
    body.className = 'tile-body';
    const num = document.createElement('div');
    num.className = 'num' + (s.number ? '' : ' missing');
    num.textContent = s.number ? fmt(s.number) : 'Number missing – click to add';
    num.title = 'Click to edit';
    num.addEventListener('click', () => openViewer(s.id, true));
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = '#' + s.seq + ' · ' + time(s.createdAt);
    if (s.needsReview) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = s.number ? 'Check' : 'No number';
      sub.appendChild(b);
    }
    body.appendChild(num);
    body.appendChild(sub);
    el.appendChild(btn);
    el.appendChild(body);
    return el;
  }

  function render() {
    const grid = $('grid');
    const frag = document.createDocumentFragment();
    const ids = visibleIds();
    ids.forEach((id) => frag.appendChild(tileFor(scans.get(id))));
    grid.replaceChildren(frag);
    $('empty').hidden = scans.size > 0;
    if (scans.size === 0) showConnect(true, true);
  }

  function upsert(s, isNew) {
    const existed = scans.has(s.id);
    scans.set(s.id, s);
    if (!existed) order.push(s.id);
    const old = $('grid').querySelector('[data-id="' + s.id + '"]');
    if (!matches(s)) {
      if (old) old.remove();
    } else if (old) {
      old.replaceWith(tileFor(s));
    } else {
      const el = tileFor(s);
      if (isNew) el.classList.add('fresh');
      const grid = $('grid');
      if (sort === 'new') grid.prepend(el);
      else grid.appendChild(el);
    }
    $('empty').hidden = true;
    if (isNew && connectAuto) showConnect(false);
    if (viewingId === s.id) fillViewer(false);
  }

  function removeScan(id) {
    scans.delete(id);
    order = order.filter((x) => x !== id);
    const el = $('grid').querySelector('[data-id="' + id + '"]');
    if (el) el.remove();
    $('empty').hidden = scans.size > 0;
    if (viewingId === id) {
      const ids = visibleIds();
      if (ids.length) openViewer(ids[0]);
      else $('viewer').close();
    }
  }

  async function loadAll() {
    const data = await api('/api/scans');
    scans.clear();
    order = [];
    data.scans.forEach((s) => {
      scans.set(s.id, s);
      order.push(s.id);
    });
    setStats(data.stats);
    setPresence(data.presence);
    render();
  }

  // ---------------------------------------------------------------- events
  let es = null;
  function connect() {
    es = new EventSource('/api/events?role=portal');
    es.addEventListener('hello', (e) => {
      setLive(true);
      const d = JSON.parse(e.data);
      setPresence(d.presence);
      loadAll().catch((err) => toast(err.message, 'bad'));
    });
    es.addEventListener('add', (e) => {
      const d = JSON.parse(e.data);
      upsert(d.scan, true);
      setStats(d.stats);
      if (d.scan.needsReview) toast(d.scan.number ? 'Scan #' + d.scan.seq + ': please check the number' : 'Scan #' + d.scan.seq + ': number not readable – click it to type it in', 'warn');
    });
    es.addEventListener('update', (e) => {
      const d = JSON.parse(e.data);
      upsert(d.scan, false);
      setStats(d.stats);
    });
    es.addEventListener('remove', (e) => {
      const d = JSON.parse(e.data);
      removeScan(d.id);
      setStats(d.stats);
    });
    es.addEventListener('reset', (e) => {
      setStats(JSON.parse(e.data).stats);
      loadAll();
    });
    es.addEventListener('presence', (e) => setPresence(JSON.parse(e.data)));
    es.addEventListener('duplicate', (e) => {
      const d = JSON.parse(e.data);
      toast('Duplicate skipped: ' + fmt(d.number) + ' is already scan #' + d.scan.seq, 'warn');
    });
    es.onerror = () => setLive(false);
  }

  // ---------------------------------------------------------------- viewer
  const viewer = $('viewer');
  const numInput = $('v-number');

  function openViewer(id, focusNumber) {
    viewingId = id;
    fillViewer(true);
    if (!viewer.open) viewer.showModal();
    if (focusNumber || !scans.get(id).number) {
      numInput.focus();
      numInput.select();
    }
  }

  function fillViewer(resetInput) {
    const s = scans.get(viewingId);
    if (!s) return;
    $('v-img').src = s.imageUrl;
    $('v-head').innerHTML = '';
    const b = document.createElement('b');
    b.textContent = 'Scan #' + s.seq;
    $('v-head').append(b, ' · ' + dateTime(s.createdAt) + (s.device ? ' · ' + s.device : ''));
    if (resetInput || document.activeElement !== numInput) numInput.value = fmt(s.number || '');
    $('v-error').hidden = true;
    $('v-file').textContent = s.file;
    const o = s.ocr || {};
    $('v-ocr').textContent = o.text ? '“' + o.text.replace(/\s+/g, ' ').trim() + '”' + (o.confidence ? ' · ' + o.confidence + '% confident' : '') : 'nothing readable';
    $('v-download').href = '/api/scans/' + encodeURIComponent(s.id) + '/download';
    const ids = visibleIds();
    const i = ids.indexOf(s.id);
    $('v-prev').disabled = i <= 0;
    $('v-next').disabled = i < 0 || i >= ids.length - 1;
  }

  function step(dir) {
    const ids = visibleIds();
    const i = ids.indexOf(viewingId);
    const next = ids[i + dir];
    if (next) openViewer(next);
  }

  numInput.addEventListener('input', () => {
    const digits = numInput.value.replace(/\D/g, '').slice(0, 16);
    const formatted = fmt(digits);
    if (numInput.value !== formatted) numInput.value = formatted;
  });

  $('v-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const s = scans.get(viewingId);
    const number = numInput.value.replace(/\D/g, '');
    const err = $('v-error');
    if (number.length !== 16) {
      err.textContent = 'A card number has 16 digits (' + number.length + ' entered).';
      err.hidden = false;
      return;
    }
    try {
      const d = await api('/api/scans/' + encodeURIComponent(s.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number }),
      });
      upsert(d.scan, false);
      toast('Saved ' + fmt(number) + ' → ' + d.scan.file);
      // jump straight to the next card that still needs checking
      if (filter === 'review') {
        const ids = visibleIds();
        if (ids.length) openViewer(ids[0], true);
        else viewer.close();
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  async function action(fn, okText) {
    try {
      const d = await fn();
      if (d && d.scan) upsert(d.scan, false);
      if (okText) toast(typeof okText === 'function' ? okText(d) : okText);
    } catch (ex) {
      toast(ex.message, 'bad');
    }
  }

  $('v-rotate').addEventListener('click', () => action(() => api('/api/scans/' + encodeURIComponent(viewingId) + '/rotate', { method: 'POST' }), 'Image rotated'));
  $('v-reocr').addEventListener('click', () =>
    action(
      () => api('/api/scans/' + encodeURIComponent(viewingId) + '/reocr', { method: 'POST' }),
      (d) => d.note || (d.read ? 'Read ' + fmt(d.read) : 'Still could not read a number – type it in')
    ).then(() => fillViewer(true))
  );
  $('v-delete').addEventListener('click', () => {
    const s = scans.get(viewingId);
    if (!confirm('Delete scan #' + s.seq + (s.number ? ' (' + fmt(s.number) + ')' : '') + '?\nThe image is moved to the trash folder on this Mac.')) return;
    action(() => api('/api/scans/' + encodeURIComponent(s.id), { method: 'DELETE' }), 'Scan deleted');
  });
  $('v-prev').addEventListener('click', () => step(-1));
  $('v-next').addEventListener('click', () => step(1));
  $('v-close').addEventListener('click', () => viewer.close());
  viewer.addEventListener('close', () => (viewingId = null));
  viewer.addEventListener('click', (e) => {
    if (e.target === viewer) viewer.close();
  });
  document.addEventListener('keydown', (e) => {
    if (!viewer.open) return;
    if (document.activeElement === numInput && e.key !== 'Escape') return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  // ---------------------------------------------------------------- toolbar
  document.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      filter = b.dataset.filter;
      render();
    })
  );
  $('sort').addEventListener('change', (e) => {
    sort = e.target.value;
    render();
  });
  $('search').addEventListener('input', (e) => {
    query = e.target.value.trim();
    render();
  });

  // ---------------------------------------------------------------- exports
  function download(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function unreadCount() {
    let n = 0;
    scans.forEach((s) => {
      if (!s.number) n++;
    });
    return n;
  }

  $('btn-xlsx').addEventListener('click', () => {
    if (!scans.size) return toast('Nothing to export yet', 'warn');
    const n = unreadCount();
    if (n && !confirm(n + ' scan(s) have no card number yet and will be left out of the Excel file.\nUse the “To check” filter to fix them first.\n\nExport anyway?')) return;
    download('/api/export.xlsx');
  });

  $('btn-zip').addEventListener('click', () => {
    if (!scans.size) return toast('Nothing to download yet', 'warn');
    const n = unreadCount();
    if (n && !confirm(n + ' image(s) have no card number yet and are named UNREAD-….jpg.\n\nDownload anyway?')) return;
    download('/api/export.zip');
  });

  $('btn-more').addEventListener('click', (e) => {
    e.stopPropagation();
    $('menu').hidden = !$('menu').hidden;
  });
  document.addEventListener('click', () => ($('menu').hidden = true));

  $('btn-archive').addEventListener('click', async () => {
    $('menu').hidden = true;
    if (!scans.size) return toast('The list is already empty', 'warn');
    if (!confirm('Archive all ' + scans.size + ' scans and start a new, empty batch?\n\nDownload the images and the Excel file first. The archived files stay on this Mac in:\n' + ((info && info.dataDir) || 'the data folder') + '/archive')) return;
    try {
      const d = await api('/api/archive', { method: 'POST' });
      toast('Archived ' + d.count + ' scans');
    } catch (ex) {
      toast(ex.message, 'bad');
    }
  });

  // ---------------------------------------------------------------- connect
  let connectAuto = false; // shown automatically because the list was empty
  function showConnect(show, auto) {
    $('connect').hidden = !show;
    connectAuto = !!(show && auto);
  }
  $('btn-connect').addEventListener('click', () => showConnect($('connect').hidden));
  $('connect-close').addEventListener('click', () => showConnect(false));
  $('btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(info.phoneUrl);
      toast('Link copied – AirDrop or message it to the iPhone');
    } catch (e) {
      toast('Copy failed – select the link text instead', 'warn');
    }
  });

  async function loadInfo() {
    try {
      info = await api('/api/info');
      $('qr').innerHTML = info.qrSvg || '';
      $('phone-url').textContent = info.phoneUrl || 'No Wi-Fi address found';
      $('connect-note').textContent = info.addresses && info.addresses.length ? 'This Mac: ' + info.addresses.join(', ') + (info.hostname ? ' (' + info.hostname + ')' : '') + ' · Images are saved in ' + info.dataDir + '/images' : 'This Mac is not on a network. Connect it to Wi-Fi and restart the scanner.';
    } catch (e) {
      toast('Could not load connection details: ' + e.message, 'bad');
    }
  }

  loadInfo();
  connect();
})();
