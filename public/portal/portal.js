/* Desktop portal: live list of scanned cards, selection, ordering, review, exports. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const local = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('tcs.portal.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('tcs.portal.' + key, JSON.stringify(value));
      } catch (e) {
        /* storage unavailable */
      }
    },
  };

  const scans = new Map(); // id -> scan
  let order = []; // ids in list order - the order used for "No." and exports
  let positions = new Map(); // id -> 1-based position in `order`
  const selected = new Set();
  let anchorId = null; // last picked card, start of a shift-click range
  let filter = 'all';
  let sort = local.get('sort', 'new') === 'order' ? 'order' : 'new';
  let query = '';
  let viewingId = null;
  let info = null;

  const fmt = (n) => (n ? n.replace(/(\d{4})(?=\d)/g, '$1 ') : '');
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const label = (s) => 'No. ' + positions.get(s.id) + ' (' + (s.number ? fmt(s.number) : s.file) + ')';

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

  const postJson = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  /** Shows a message; `action` = { label, run } adds a button such as Undo. */
  function toast(text, cls, action) {
    const el = document.createElement('div');
    el.className = 'toast ' + (cls || '');
    const msg = document.createElement('span');
    msg.textContent = text;
    el.appendChild(msg);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        el.remove();
        action.run();
      });
      el.appendChild(b);
    }
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), action ? 9000 : 4500);
    return el;
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

  // ----------------------------------------------------------------- order
  function setOrder(ids) {
    order = ids;
    positions = new Map(ids.map((id, i) => [id, i + 1]));
  }

  /** Server order wins, but keep any scan we know about that it did not list. */
  function adoptOrder(ids) {
    const known = ids.filter((id) => scans.has(id));
    const listed = new Set(known);
    setOrder(known.concat(order.filter((id) => !listed.has(id) && scans.has(id))));
  }

  let orderWrites = 0; // reorders in flight - ignore our own echoes meanwhile
  let undoToast = null; // only the latest reorder can be undone

  function dropUndo() {
    if (undoToast) undoToast.remove();
    undoToast = null;
  }

  /** Applies a new list order right away, saves it, and offers Undo. */
  async function saveOrder(wanted, message, undoable) {
    const before = order.slice();
    // an Undo snapshot may name cards deleted since; keep only live ones and
    // append any that arrived meanwhile (same rule as the server)
    const kept = wanted.filter((id) => scans.has(id));
    const listed = new Set(kept);
    const next = kept.concat(order.filter((id) => !listed.has(id)));
    if (next.every((id, i) => id === before[i])) {
      toast('The list is already in that order');
      return;
    }
    dropUndo();
    setOrder(next);
    if (sort !== 'order') setSort('order');
    else render();
    orderWrites++;
    try {
      const d = await postJson('/api/scans/order', { ids: next });
      orderWrites--;
      if (!orderWrites) {
        adoptOrder(d.order);
        render();
      }
      const t = toast(message, '', undoable === false ? null : { label: 'Undo', run: () => saveOrder(before, 'Order restored', false) });
      if (undoable !== false) undoToast = t;
    } catch (ex) {
      orderWrites--;
      toast('Could not save the new order: ' + ex.message, 'bad');
      loadAll().catch(() => {});
    }
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

  function newestFirst(a, b) {
    return b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : b.seq - a.seq;
  }

  function visibleIds() {
    const ids = order.filter((id) => scans.has(id) && matches(scans.get(id)));
    if (sort === 'new') ids.sort((a, b) => newestFirst(scans.get(a), scans.get(b)));
    return ids;
  }

  const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6 11-11-1.4-1.4z"/></svg>';

  function tileFor(s) {
    const isSel = selected.has(s.id);
    const el = document.createElement('article');
    el.className = 'tile' + (s.needsReview ? ' review' : '') + (isSel ? ' selected' : '');
    el.dataset.id = s.id;
    el.draggable = sort === 'order';

    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.type = 'button';
    pick.setAttribute('role', 'checkbox');
    pick.setAttribute('aria-checked', String(isSel));
    pick.setAttribute('aria-label', 'Select ' + label(s));
    pick.innerHTML = CHECK;
    pick.addEventListener('click', (e) => onPick(s.id, e));

    const btn = document.createElement('button');
    btn.className = 'thumb';
    btn.type = 'button';
    btn.title = 'Open ' + s.file;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.alt = s.number ? 'Card ' + s.number : 'Card without number';
    img.src = s.thumbUrl;
    btn.appendChild(img);
    btn.addEventListener('click', (e) => {
      // once something is selected, clicking cards adds/removes them
      if (selected.size || e.shiftKey || e.metaKey || e.ctrlKey) onPick(s.id, e);
      else openViewer(s.id);
    });

    const body = document.createElement('div');
    body.className = 'tile-body';
    const num = document.createElement('div');
    num.className = 'num' + (s.number ? '' : ' missing');
    num.textContent = s.number ? fmt(s.number) : 'Number missing – click to add';
    num.title = 'Click to edit';
    num.addEventListener('click', () => openViewer(s.id, true));
    const sub = document.createElement('div');
    sub.className = 'sub';
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = 'No. ' + positions.get(s.id);
    sub.append(pos, ' · ' + time(s.createdAt));
    if (s.needsReview) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = s.number ? 'Check' : 'No number';
      sub.appendChild(b);
    }
    body.appendChild(num);
    body.appendChild(sub);
    el.append(pick, btn, body);
    return el;
  }

  function render() {
    const grid = $('grid');
    const frag = document.createDocumentFragment();
    visibleIds().forEach((id) => frag.appendChild(tileFor(scans.get(id))));
    grid.replaceChildren(frag);
    grid.classList.toggle('can-drag', sort === 'order');
    $('drag-hint').hidden = sort !== 'order' || scans.size < 2;
    $('empty').hidden = scans.size > 0;
    if (scans.size === 0) showConnect(true, true);
    refreshSelection();
  }

  function setSort(value) {
    sort = value;
    $('sort').value = value;
    local.set('sort', value);
    render();
  }

  function tileEl(id) {
    return $('grid').querySelector('.tile[data-id="' + CSS.escape(id) + '"]');
  }

  function upsert(s, isNew) {
    const existed = scans.has(s.id);
    scans.set(s.id, s);
    if (!existed) {
      order.push(s.id);
      positions.set(s.id, order.length);
    }
    const old = tileEl(s.id);
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
    $('drag-hint').hidden = sort !== 'order' || scans.size < 2;
    if (isNew && connectAuto) showConnect(false);
    if (viewingId === s.id) fillViewer(false);
    refreshSelection();
  }

  function removeIds(ids) {
    const gone = ids.filter((id) => scans.has(id));
    if (!gone.length) return;
    dropUndo(); // an older "Undo" next to a delete would look like it undoes the delete
    const goneSet = new Set(gone);
    let nextView = null;
    if (viewingId && goneSet.has(viewingId)) {
      const vis = visibleIds();
      const i = vis.indexOf(viewingId);
      nextView = vis.slice(i + 1).concat(vis.slice(0, i).reverse()).find((id) => !goneSet.has(id)) || null;
    }
    gone.forEach((id) => {
      scans.delete(id);
      selected.delete(id);
    });
    if (anchorId && goneSet.has(anchorId)) anchorId = null;
    setOrder(order.filter((id) => !goneSet.has(id)));
    render(); // positions after the removed cards shift
    if (viewingId && goneSet.has(viewingId)) {
      if (nextView) openViewer(nextView);
      else $('viewer').close();
    }
  }

  async function loadAll() {
    const data = await api('/api/scans');
    scans.clear();
    data.scans.forEach((s) => scans.set(s.id, s));
    setOrder(data.scans.map((s) => s.id));
    [...selected].forEach((id) => scans.has(id) || selected.delete(id));
    setStats(data.stats);
    setPresence(data.presence);
    render();
    if (viewingId) {
      if (scans.has(viewingId)) fillViewer(false);
      else $('viewer').close();
    }
  }

  // ------------------------------------------------------------- selection
  function selectedInOrder() {
    return order.filter((id) => selected.has(id));
  }

  function onPick(id, e) {
    if (e && e.shiftKey && anchorId && anchorId !== id) {
      const ids = visibleIds();
      const a = ids.indexOf(anchorId);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(ids[i]);
        anchorId = id;
        refreshSelection();
        return;
      }
    }
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchorId = id;
    refreshSelection();
  }

  function selectVisible(on) {
    visibleIds().forEach((id) => (on ? selected.add(id) : selected.delete(id)));
    refreshSelection();
  }

  function clearSelection() {
    selected.clear();
    anchorId = null;
    refreshSelection();
  }

  function refreshSelection() {
    $('grid')
      .querySelectorAll('.tile')
      .forEach((el) => {
        const on = selected.has(el.dataset.id);
        el.classList.toggle('selected', on);
        el.querySelector('.pick').setAttribute('aria-checked', String(on));
      });
    const n = selected.size;
    document.body.classList.toggle('selecting', n > 0);
    $('selbar').hidden = n === 0;
    if (n) fitSelbar();
    $('sel-count').textContent = n;
    const vis = visibleIds();
    const shownSel = vis.filter((id) => selected.has(id)).length;
    $('sel-hidden').textContent = n > shownSel ? ' (' + (n - shownSel) + ' not shown)' : '';
    const all = $('select-all');
    all.checked = vis.length > 0 && shownSel === vis.length;
    all.indeterminate = shownSel > 0 && shownSel < vis.length;
    all.disabled = vis.length === 0;
  }

  /** Lets the page leave room for the selection bar, however many rows it wraps to. */
  function fitSelbar() {
    document.body.style.setProperty('--selbar-h', $('selbar').offsetHeight + 'px');
  }
  window.addEventListener('resize', () => selected.size && fitSelbar());

  $('select-all').addEventListener('change', (e) => selectVisible(e.target.checked));
  $('sel-clear').addEventListener('click', clearSelection);

  // ----------------------------------------------------- selection actions
  /** "3,4,5,9" -> "3-5,9" so long selections still fit in a download link. */
  function seqRanges(ids) {
    const seqs = ids.map((id) => scans.get(id).seq).sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < seqs.length; i++) {
      let j = i;
      while (j + 1 < seqs.length && seqs[j + 1] === seqs[j] + 1) j++;
      parts.push(j > i ? seqs[i] + '-' + seqs[j] : String(seqs[i]));
      i = j;
    }
    return parts.join(',');
  }

  function exportSelected(kind) {
    const ids = selectedInOrder();
    if (!ids.length) return;
    const unread = ids.filter((id) => !scans.get(id).number).length;
    if (kind === 'xlsx') {
      if (unread === ids.length) return toast('None of the selected scans has a card number yet', 'warn');
      if (unread && !confirm(plural(unread, 'selected scan') + ' without a card number will be left out of the Excel file.\n\nExport the other ' + (ids.length - unread) + ' anyway?')) return;
    } else if (unread && !confirm(plural(unread, 'selected image') + ' without a card number will be named UNREAD-….jpg.\n\nDownload anyway?')) {
      return;
    }
    download('/api/export.' + kind + '?seqs=' + seqRanges(ids));
  }

  async function deleteSelected() {
    const ids = selectedInOrder();
    if (!ids.length) return;
    const lines = ids.slice(0, 8).map((id) => '• ' + label(scans.get(id)));
    if (ids.length > 8) lines.push('…and ' + (ids.length - 8) + ' more');
    if (!confirm('Delete ' + plural(ids.length, 'selected scan') + '?\n\n' + lines.join('\n') + '\n\nThe images are moved to the trash folder on this Mac.')) return;
    try {
      const d = await postJson('/api/scans/bulk-delete', { ids });
      removeIds(ids);
      clearSelection();
      setStats(d.stats);
      toast('Deleted ' + plural(d.deleted, 'scan'));
    } catch (ex) {
      toast('Delete failed: ' + ex.message, 'bad');
    }
  }

  function moveSelected(where) {
    const sel = selectedInOrder();
    if (!sel.length) return;
    const rest = order.filter((id) => !selected.has(id));
    let index;
    let place;
    if (where === 'start') {
      index = 0;
      place = 'the start';
    } else if (where === 'end') {
      index = rest.length;
      place = 'the end';
    } else {
      const answer = prompt('Move ' + plural(sel.length, 'selected card') + ' to position (1–' + order.length + '):', '1');
      if (answer === null) return;
      const n = parseInt(answer, 10);
      if (!(n >= 1)) return toast('Enter a position number, e.g. 1', 'warn');
      index = Math.min(n - 1, rest.length);
      place = 'position ' + (index + 1);
    }
    saveOrder(rest.slice(0, index).concat(sel, rest.slice(index)), 'Moved ' + plural(sel.length, 'card') + ' to ' + place);
  }

  function arrange(kind) {
    const num = (id) => scans.get(id).number;
    let next;
    let message;
    if (kind === 'number-asc' || kind === 'number-desc') {
      const dir = kind === 'number-asc' ? 1 : -1;
      next = order.slice().sort((a, b) => {
        const x = num(a);
        const y = num(b);
        if (!x || !y) return x ? -1 : y ? 1 : 0; // cards without a number go last
        return x < y ? -dir : x > y ? dir : 0;
      });
      message = 'Sorted by card number' + (dir > 0 ? '' : ' (descending)');
    } else if (kind === 'time') {
      next = order.slice().sort((a, b) => newestFirst(scans.get(b), scans.get(a)));
      message = 'Sorted by scan time';
    } else {
      next = order.slice().reverse();
      message = 'List reversed';
    }
    saveOrder(next, message);
  }

  $('sel-xlsx').addEventListener('click', () => exportSelected('xlsx'));
  $('sel-zip').addEventListener('click', () => exportSelected('zip'));
  $('sel-delete').addEventListener('click', deleteSelected);
  document.querySelectorAll('[data-move]').forEach((b) =>
    b.addEventListener('click', () => {
      closeMenus();
      moveSelected(b.dataset.move);
    })
  );
  document.querySelectorAll('[data-arrange]').forEach((b) =>
    b.addEventListener('click', () => {
      closeMenus();
      if (order.length < 2) return toast('Nothing to sort yet', 'warn');
      arrange(b.dataset.arrange);
    })
  );

  // ---------------------------------------------------------- drag & drop
  // In "List order" view cards can be dragged; dragging a selected card
  // moves the whole selection.
  const grid = $('grid');
  let dragIds = null;
  let dropAt = null; // { id, after }

  function clearDropMarks() {
    grid.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  }

  function nearestTile(x, y) {
    let best = null;
    let bestD = Infinity;
    grid.querySelectorAll('.tile').forEach((el) => {
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = el;
      }
    });
    return best;
  }

  function endDrag() {
    clearDropMarks();
    grid.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    dragIds = null;
    dropAt = null;
  }

  grid.addEventListener('dragstart', (e) => {
    const tile = e.target.closest && e.target.closest('.tile');
    if (!tile || sort !== 'order') return;
    const id = tile.dataset.id;
    dragIds = selected.has(id) ? selectedInOrder() : [id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragIds.length + ' card(s)');
    if (dragIds.length > 1) {
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = plural(dragIds.length, 'card');
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 16, 16);
      setTimeout(() => ghost.remove(), 0);
    }
    const ids = new Set(dragIds);
    requestAnimationFrame(() => grid.querySelectorAll('.tile').forEach((el) => ids.has(el.dataset.id) && el.classList.add('dragging')));
  });

  grid.addEventListener('dragover', (e) => {
    if (!dragIds) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tile = nearestTile(e.clientX, e.clientY);
    clearDropMarks();
    if (!tile) return;
    const r = tile.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    tile.classList.add(after ? 'drop-after' : 'drop-before');
    dropAt = { id: tile.dataset.id, after };
  });

  grid.addEventListener('drop', (e) => {
    if (!dragIds) return;
    e.preventDefault();
    const moving = dragIds;
    const target = dropAt;
    endDrag();
    if (!target || moving.includes(target.id)) return;
    const movingSet = new Set(moving);
    const rest = order.filter((id) => !movingSet.has(id));
    const at = rest.indexOf(target.id) + (target.after ? 1 : 0);
    saveOrder(rest.slice(0, at).concat(moving, rest.slice(at)), 'Moved ' + plural(moving.length, 'card') + ' to position ' + (at + 1));
  });

  grid.addEventListener('dragend', endDrag);

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
      const where = 'Scan No. ' + positions.get(d.scan.id);
      if (d.scan.needsReview) toast(d.scan.number ? where + ': please check the number' : where + ': number not readable – click it to type it in', 'warn');
    });
    es.addEventListener('update', (e) => {
      const d = JSON.parse(e.data);
      upsert(d.scan, false);
      setStats(d.stats);
    });
    es.addEventListener('removed', (e) => {
      const d = JSON.parse(e.data);
      removeIds(d.ids);
      setStats(d.stats);
    });
    es.addEventListener('order', (e) => {
      if (orderWrites) return; // our own change; the save response carries the result
      dropUndo(); // changed elsewhere - an old undo would throw that away
      adoptOrder(JSON.parse(e.data).ids);
      render();
      if (viewingId) fillViewer(false);
    });
    es.addEventListener('reset', (e) => {
      setStats(JSON.parse(e.data).stats);
      dropUndo();
      clearSelection();
      loadAll();
    });
    es.addEventListener('presence', (e) => setPresence(JSON.parse(e.data)));
    es.addEventListener('duplicate', (e) => {
      const d = JSON.parse(e.data);
      toast('Duplicate skipped: ' + fmt(d.number) + ' is already No. ' + (positions.get(d.scan.id) || d.scan.position), 'warn');
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
    b.textContent = 'No. ' + positions.get(s.id);
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
    if (!confirm('Delete ' + label(s) + '?\nThe image is moved to the trash folder on this Mac.')) return;
    const id = s.id;
    action(() => api('/api/scans/' + encodeURIComponent(id), { method: 'DELETE' }).then((d) => (removeIds([id]), d)), 'Scan deleted');
  });
  $('v-prev').addEventListener('click', () => step(-1));
  $('v-next').addEventListener('click', () => step(1));
  $('v-close').addEventListener('click', () => viewer.close());
  viewer.addEventListener('close', () => (viewingId = null));
  viewer.addEventListener('click', (e) => {
    if (e.target === viewer) viewer.close();
  });

  // ------------------------------------------------------------- keyboard
  // Only real text entry swallows the shortcuts - not the "Select all"
  // checkbox or the view menu, which keep focus after being clicked in Chrome.
  const typing = (el) =>
    el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color|file)$/i.test(el.type)));

  document.addEventListener('keydown', (e) => {
    if (viewer.open) {
      if (document.activeElement === numInput && e.key !== 'Escape') return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
      return;
    }
    if (typing(document.activeElement)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectVisible(true);
    } else if (e.key === 'Escape') {
      if (!closeMenus() && selected.size) clearSelection();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
      e.preventDefault();
      deleteSelected();
    }
  });

  // ---------------------------------------------------------------- toolbar
  document.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      filter = b.dataset.filter;
      render();
    })
  );
  $('sort').value = sort;
  $('sort').addEventListener('change', (e) => setSort(e.target.value));
  $('search').addEventListener('input', (e) => {
    query = e.target.value.trim();
    render();
  });

  // ------------------------------------------------------------------ menus
  function closeMenus() {
    let closed = false;
    document.querySelectorAll('.menu').forEach((m) => {
      if (!m.hidden) closed = true;
      m.hidden = true;
      m.style.left = m.style.right = '';
    });
    return closed;
  }

  function menuToggle(buttonId, menuId) {
    $(buttonId).addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $(menuId);
      const open = menu.hidden;
      closeMenus();
      menu.hidden = !open;
      if (!open) return;
      // keep the menu on screen when the toolbar has wrapped in a narrow window
      const r = menu.getBoundingClientRect();
      if (r.left < 8) {
        menu.style.left = '0';
        menu.style.right = 'auto';
      } else if (r.right > window.innerWidth - 8) {
        menu.style.right = '0';
        menu.style.left = 'auto';
      }
    });
  }
  menuToggle('btn-more', 'menu');
  menuToggle('btn-arrange', 'arrange-menu');
  menuToggle('sel-move', 'move-menu');
  document.addEventListener('click', closeMenus);

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

  $('btn-archive').addEventListener('click', async () => {
    closeMenus();
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
