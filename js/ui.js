/* ui.js: the browser front end. Queries run in a Web Worker when possible (js/worker.js), otherwise on the
   main thread through the same runner API. */
(function () {
  'use strict';
  const X = window.SQLX;
  const $ = s => document.querySelector(s);
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach(c => { if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c)); });
    return el;
  };
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = u => (u == null ? '—' : X.fmtWork(u));

  /* ---------- worker client ---------- */
  let worker = null, seq = 0;
  const pending = new Map();
  try {
    worker = new Worker('js/worker.js');
    worker.onmessage = e => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.res(e.data.result) : p.rej(Object.assign(new Error(e.data.error), { cls: e.data.cls })); };
    worker.onerror = () => { worker = null; pending.forEach(p => p.retry()); pending.clear(); };
  } catch (e) { worker = null; }
  function call(msg) {
    return new Promise((res, rej) => {
      const local = () => setTimeout(() => { try { res(window.QSRunner.handle(msg)); } catch (err) { rej(err); } }, 15);
      if (!worker) return local();
      const id = ++seq;
      pending.set(id, { res, rej, retry: local });
      worker.postMessage(Object.assign({ id }, msg));
    });
  }

  /* ---------- state ---------- */
  const KEY = 'query-surgery:v1';
  const store = (() => { let d; try { d = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { d = {}; } d = Object.assign({ solved: {}, sql: {}, hints: {} }, d); return { d, save() { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* private mode */ } } }; })();
  const CH = X.CHALLENGES;
  let current = null, baseline = null, mine = null, busy = false;
  const ed = $('#sql');

  /* ---------- editor ---------- */
  const KW = new Set('select from where group by having order limit offset join on using inner left right full outer cross semi anti union intersect except all distinct as and or not in is null like between case when then else end exists with recursive over partition rows range unbounded preceding following current row asc desc nulls first last true false interval insert update delete create index unique include drop explain analyze timestamp date cast'.split(' '));
  function highlight(src) {
    const re = /(--[^\n]*)|('(?:[^']|'')*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([\s\S])/g;
    let out = '', m;
    while ((m = re.exec(src)) !== null) out += m[1] ? `<span class="c">${esc(m[1])}</span>` : m[2] ? `<span class="s">${esc(m[2])}</span>` : m[3] ? `<span class="n">${m[3]}</span>` : m[4] ? (KW.has(m[4].toLowerCase()) ? `<span class="k">${m[4]}</span>` : esc(m[4])) : esc(m[5]);
    return out + '\n';
  }
  function sync() {
    $('#hl').innerHTML = highlight(ed.value);
    $('#gutter').textContent = Array.from({ length: Math.max(ed.value.split('\n').length, 7) }, (_, i) => i + 1).join('\n');
    ed.style.height = 'auto'; ed.style.height = Math.max(190, ed.scrollHeight) + 'px';
    if (current) { store.d.sql[current.id] = ed.value; store.save(); }
  }
  ed.addEventListener('input', sync);
  ed.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.shiftKey ? submit() : run(); }
    else if (e.key === 'Tab') { e.preventDefault(); ed.setRangeText('  ', ed.selectionStart, ed.selectionEnd, 'end'); sync(); }
  });

  /* ---------- sidebar ---------- */
  function renderTracks() {
    $('#tracks').replaceChildren(...X.TRACKS.map(t => {
      const list = CH.filter(c => c.track === t.id);
      return h('section', { class: 'track-group' }, h('h2', null, t.title, h('span', { text: `${list.filter(c => store.d.solved[c.id]).length}/${list.length}` })),
        h('ol', null, list.map(c => h('li', null, h('button', { type: 'button', class: 'item' + (store.d.solved[c.id] ? ' done' : ''), 'aria-current': current && current.id === c.id ? 'true' : 'false', onclick: () => open(c.id) },
          h('span', { class: 'dot' }), h('span', { text: c.title }), h('span', { class: 'm', text: c.mode === 'index' ? 'index' : '' }))))));
    }));
    const n = CH.filter(c => store.d.solved[c.id]).length;
    $('#progress-text').textContent = `${n} of ${CH.length} solved`;
    $('#progress-bar').style.width = (100 * n / CH.length) + '%';
  }

  /* ---------- open a challenge ---------- */
  function open(id) {
    const c = CH.find(x => x.id === id) || CH[0];
    current = c; baseline = null; mine = null;
    if (location.hash !== '#' + c.id) history.replaceState(null, '', '#' + c.id);
    document.title = `${c.title} · Query Surgery`;
    $('#track').textContent = X.TRACKS.find(t => t.id === c.track).title;
    $('#level').textContent = ['', 'Warm-up', 'Core', 'Hard'][c.level];
    $('#mode').textContent = c.mode === 'index' ? 'Index design: the queries are fixed' : 'Rewrite: same result, less work';
    $('#title').textContent = c.title;
    $('#scenario').innerHTML = c.scenario;
    const b = c.budget || {};
    $('#task').innerHTML = c.mode === 'rewrite'
      ? `Rewrite the query so it returns <b>exactly the same result</b> with at most <b>${fmt(c.target)}</b> of work.${c.ordered ? ' Row order matters.' : ''}`
      : `Bring the workload under <b>${fmt(c.target)} of work per hour</b>${c.writes ? ', including index maintenance for ' + c.writes.perHour.toLocaleString() + ' inserts per hour' : ''}.` +
        `<ul>${b.maxNew != null ? `<li>Add at most ${b.maxNew} index${b.maxNew === 1 ? '' : 'es'}.</li>` : ''}${b.maxEntries != null ? `<li>New indexes may hold at most ${b.maxEntries.toLocaleString()} entries in total.</li>` : ''}${b.allowCreate === false ? '<li>Only DROP INDEX is allowed.</li>' : ''}<li>Write <code>CREATE INDEX</code> / <code>DROP INDEX</code> statements; the queries cannot change.</li></ul>`;
    renderHelp(); renderStatus();
    $('#orig-h').textContent = c.mode === 'rewrite' ? 'The slow query' : 'The workload';
    $('#editor-label').textContent = c.mode === 'rewrite' ? 'Your query' : 'Your index changes';
    $('#original').replaceChildren(c.mode === 'rewrite'
      ? h('div', null, h('pre', { class: 'sqlblock', html: highlight(c.slow) }), h('details', { class: 'plan-d', id: 'orig-plan' }, h('summary', { text: 'Measuring the original…' })))
      : h('div', null, c.workload.map((w, i) => h('div', { class: 'wq' }, h('div', { class: 'wq-head', html: `<b>×${w.perHour.toLocaleString()}</b> per hour` }), h('pre', { class: 'sqlblock', html: highlight(w.sql) }), h('details', { class: 'plan-d', id: `wq-plan-${i}` }, h('summary', { text: 'Measuring…' }))))));
    ed.value = store.d.sql[c.id] != null ? store.d.sql[c.id] : c.mode === 'rewrite' ? c.slow : (c.starter || '-- CREATE INDEX name ON table (columns) [INCLUDE (columns)] [WHERE condition]\n');
    sync();
    $('#verdict').hidden = true; $('#output').hidden = true;
    renderMeter();
    renderTracks();
    call({ type: 'schema', challenge: c.id }).then(s => { if (current === c) renderSchema(s); });
    call({ type: 'baseline', challenge: c.id }).then(r => { if (current !== c) return; baseline = r; renderBaseline(); renderMeter(); }).catch(() => {});
    window.scrollTo({ top: 0 });
  }
  function renderStatus() { const s = $('#status'), d = store.d.solved[current.id]; s.textContent = d ? 'Solved' : 'Not solved yet'; s.className = 'pill' + (d ? ' ok' : ''); }
  function renderHelp() {
    const c = current, shown = store.d.hints[c.id] || 0;
    const kids = c.hints.slice(0, shown).map((t, i) => h('p', { class: 'hint', html: `<b>Hint ${i + 1}.</b> ${esc(t)}` }));
    if (shown < c.hints.length) kids.push(h('button', { type: 'button', class: 'btn', text: shown ? `Another hint (${shown + 1} of ${c.hints.length})` : `Hint (${c.hints.length} available)`, onclick: () => { store.d.hints[c.id] = shown + 1; store.save(); renderHelp(); } }));
    kids.push(h('button', { type: 'button', class: 'btn quiet', text: 'Show the solution', onclick: () => { if (confirm('Show the reference solution? Running EXPLAIN ANALYZE on your own attempt usually teaches more.')) { ed.value = c.solution; sync(); } } }));
    $('#help').replaceChildren(...kids);
  }
  function renderSchema(s) {
    $('#schema').replaceChildren(h('div', { class: 'schema-grid' }, s.tables.map(t => h('div', { class: 'schema-t' }, h('b', { text: t.name }), h('small', { text: `${t.rows.toLocaleString()} rows` }),
      h('p', { text: t.cols.join(', ') }),
      s.indexes.filter(d => d.table === t.name).map(d => h('p', { class: 'idx', text: `${d.pk ? 'primary key' : 'index ' + d.name} (${d.cols.join(', ')})${d.include.length ? ` INCLUDE (${d.include.join(', ')})` : ''}${d.where ? ` WHERE ${d.where}` : ''}` }))))));
  }
  function renderBaseline() {
    const c = current, b = baseline;
    if (c.mode === 'rewrite') {
      const d = $('#orig-plan');
      const sum = d.querySelector('summary');
      if (b.error) { sum.textContent = `Original: ${/timeout/.test(b.error) ? 'hits the 5-second statement timeout' : 'error'} · show the plan`; d.append(h('p', { class: 'out-note', text: b.error })); }
      else { sum.textContent = `Original: ${fmt(b.result.work)} of work, ${b.result.rowCount.toLocaleString()} rows · show the plan`; d.append(planEl(b.result.plan)); }
    } else {
      b.workload.queries.forEach((q, i) => { const d = $(`#wq-plan-${i}`); if (!d) return; d.querySelector('summary').textContent = `${q.error ? 'Times out' : fmt(q.work) + ' per run'} · ${fmt(q.work == null ? null : q.work * q.perHour)} per hour · show the plan`; d.append(planEl(q.plan)); });
    }
  }

  /* ---------- the work meter ---------- */
  function renderMeter() {
    const c = current;
    const origVal = !baseline ? null : c.mode === 'rewrite' ? (baseline.error ? 5e6 : baseline.result.work) : baseline.workload.total;
    const origTimeout = baseline && baseline.error && /timeout/.test(baseline.error);
    const yours = mine;
    const vals = [c.target, origVal, yours && yours.value].filter(v => v != null && v > 0);
    const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...vals) / 2))), hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...vals) * 1.5)));
    const pos = v => `${(100 * (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))).toFixed(2)}%`;
    const kids = [h('div', { class: 'axis' })];
    for (let e = Math.log10(lo); e <= Math.log10(hi) + 1e-9; e++) kids.push(h('span', { class: 'tick', style: `left:${pos(Math.pow(10, e))}`, text: fmt(Math.pow(10, e)) }));
    kids.push(h('div', { class: 'mark target', style: `left:${pos(c.target)}` }, h('i'), h('span', { text: `target ${fmt(c.target)}` })));
    kids.push(origVal != null ? h('div', { class: 'mark orig', style: `left:${pos(origVal)}` }, h('span', { text: `original ${origTimeout ? 'timed out' : fmt(origVal)}` }), h('i')) : h('div', { class: 'mark orig pending', style: 'left:96%' }, h('span', { text: 'measuring…' }), h('i')));
    if (yours && yours.value != null) kids.push(h('div', { class: 'mark you', style: `left:${pos(yours.value)}` }, h('span', { text: `yours ${yours.timeout ? 'timed out' : fmt(yours.value)}` }), h('i')));
    $('#meter').replaceChildren(...kids);
    let sum = '';
    if (yours && yours.value != null && origVal != null) {
      const ratio = origVal / Math.max(yours.value, 1e-9);
      sum = `${origTimeout ? 'timeout' : `<b>${fmt(origVal)}</b>`} → <b>${fmt(yours.value)}</b> ${ratio >= 1.05 ? `<span class="gain">${ratio >= 100 ? Math.round(ratio).toLocaleString() : ratio.toFixed(1)}× less work${origTimeout ? ' (at least)' : ''}</span>` : ratio < 0.95 ? '<span style="color:var(--red)">more work than the original</span>' : 'about the same'}`;
    } else if (origVal != null) sum = `Original: <b>${origTimeout ? 'timed out (over 5 s)' : fmt(origVal)}</b>${c.mode === 'index' ? ' per hour' : ''}. Target: <b>${fmt(c.target)}</b>.`;
    $('#meter-summary').innerHTML = sum;
  }

  /* ---------- plans and results ---------- */
  function planEl(lines) {
    const workOf = l => { const m = /work=([\d.]+) (µs|ms|s)\)/.exec(l); return m ? Number(m[1]) * { 'µs': 1, ms: 1e3, s: 1e6 }[m[2]] : 0; };
    const total = Math.max(1, ...lines.map(workOf));
    const html = lines.map(l => {
      let s = esc(l);
      s = s.replace(/(Seq Scan|Nested Loop(?= \()|Sort(?! \(skipped))/g, '<span class="op-bad">$1</span>')
        .replace(/(Index Only Scan|Index Scan|Hashed SubPlan|Sort \(skipped[^)]*\))/g, '<span class="op-good">$1</span>')
        .replace(/^(\s*(?:-&gt;\s+)?)(Hash Join|HashAggregate|Aggregate|WindowAgg|Limit|Unique|Filter|CTE Scan|CTE|Subquery Scan|Append|HashSetOp[A-Z ]*|Recursive Union|Values Scan|Result)/, '$1<span class="op">$2</span>')
        .replace(/(Note: .*)$/, '<span class="note">$1</span>').replace(/((?:Index entries|Rows) read: .*)$/, '<span class="note">$1</span>')
        .replace(/(\(rows=[^)]*\))/, '<span class="dim">$1</span>');
      return workOf(l) > total * 0.4 && workOf(l) > 1000 ? `<span class="heavy">${s}</span>` : s;
    }).join('\n');
    return h('pre', { class: 'plan', html });
  }
  function gridEl(r) {
    if (!r.columns.length) return h('p', { class: 'out-note', text: r.message || 'Done.' });
    return h('div', null, h('div', { class: 'grid-wrap' }, h('table', { class: 'grid' }, h('thead', null, h('tr', null, r.columns.map(c => h('th', { text: c })))),
      h('tbody', null, r.rows.map(row => h('tr', null, row.map(v => h('td', { class: v == null ? 'null' : typeof v === 'number' ? 'num' : '', text: v == null ? 'NULL' : String(v) }))))))),
    h('p', { class: 'out-note', text: `${r.rowCount.toLocaleString()} row${r.rowCount === 1 ? '' : 's'}${r.rowCount > r.rows.length ? ` (showing ${r.rows.length})` : ''}` }));
  }
  function showOutput(res) {
    const out = $('#output'); out.hidden = false;
    if (res.error) { out.replaceChildren(h('div', { class: 'err' }, h('b', { text: (/^\[([A-Z_.]+)\]/.exec(res.error) || [, 'Error'])[1] }), h('p', { text: res.error.replace(/^\[[A-Z_.]+\]\s*/, '') }))); return; }
    if (res.workload) {
      const w = res.workload;
      out.replaceChildren(h('div', { class: 'card-h' }, h('span', { class: 'label', text: `Workload: ${fmt(w.total)} per hour` }), h('span', { class: 'kbd', text: `reads ${fmt(w.readCost)}${w.writeCost ? ` · index maintenance ${fmt(w.writeCost)}` : ''}${w.created.length ? ` · ${w.created.length} new index${w.created.length > 1 ? 'es' : ''}, ${w.entries.toLocaleString()} entries` : ''}` })),
        ...w.queries.map(q => h('div', { class: 'wq' }, h('div', { class: 'wq-head', html: `<b>${q.error ? 'error' : fmt(q.work)}</b> per run × ${q.perHour.toLocaleString()} = <b>${q.work == null ? '—' : fmt(q.work * q.perHour)}</b> per hour` }), q.error ? h('p', { class: 'out-note', text: q.error }) : planEl(q.plan))));
      return;
    }
    const r = res.result;
    let tab = r.kind === 'plan' ? 'plan' : 'plan';
    const body = h('div');
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, ['plan', 'result'].map(t => h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(t === tab), text: t === 'plan' ? `Plan · ${fmt(r.work)} of work` : `Result · ${r.rowCount.toLocaleString()} rows`, onclick: e => { tab = t; tabs.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b === e.target))); draw(); } })));
    const draw = () => body.replaceChildren(tab === 'plan' ? planEl(r.plan) : r.kind === 'plan' ? h('p', { class: 'out-note', text: 'EXPLAIN returns a plan, not rows.' }) : gridEl(r));
    draw();
    out.replaceChildren(tabs, body);
  }

  /* ---------- run and submit ---------- */
  function setBusy(b) { busy = b; ['#run', '#submit'].forEach(s => { $(s).disabled = b; }); $('#run').textContent = b ? 'Running…' : 'Run'; }
  async function run() {
    if (busy || !ed.value.trim()) return;
    setBusy(true);
    const c = current;
    try {
      const res = await call({ type: 'run', challenge: c.id, sql: ed.value });
      if (current !== c) return;
      showOutput(res);
      mine = res.error ? (/timeout/.test(res.error) ? { value: 5e6, timeout: true } : null) : { value: res.workload ? res.workload.total : res.result.work };
      renderMeter();
    } catch (e) { showOutput({ error: e.message }); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (busy || !ed.value.trim()) return;
    setBusy(true);
    const c = current;
    try {
      const g = await call({ type: 'submit', challenge: c.id, sql: ed.value });
      if (current !== c) return;
      if (g.result || g.workload || g.error) showOutput(g);
      mine = g.error ? (/timeout/.test(g.error) ? { value: 5e6, timeout: true } : null) : { value: g.workload ? g.total : g.work };
      renderMeter();
      const v = $('#verdict'); v.hidden = false;
      if (g.ok) {
        const first = !store.d.solved[c.id];
        store.d.solved[c.id] = Date.now(); store.save(); renderTracks(); renderStatus();
        const next = CH.slice(CH.indexOf(c) + 1).find(x => !store.d.solved[x.id]) || CH.find(x => !store.d.solved[x.id]);
        v.className = 'verdict ok';
        v.replaceChildren(h('h2', { text: first ? 'Operation successful' : 'Operation successful (again)' }), h('p', { text: g.message }),
          h('div', { class: 'lesson' }, h('p', { html: c.explain }), h('details', null, h('summary', { text: 'Another way to do it' }), h('pre', { html: highlight(c.alt) }))),
          next ? h('button', { type: 'button', class: 'btn primary', text: `Next: ${next.title} →`, onclick: () => open(next.id) }) : h('p', { text: 'Every challenge solved.' }));
      } else {
        v.className = 'verdict bad';
        v.replaceChildren(h('h2', { text: g.error ? 'The query failed' : g.same === false ? 'Different result' : 'Not fast enough yet' }), h('p', { text: g.error || g.message }));
      }
    } catch (e) { showOutput({ error: e.message }); }
    finally { setBusy(false); }
  }
  $('#run').addEventListener('click', run);
  $('#submit').addEventListener('click', submit);
  $('#reset').addEventListener('click', () => { delete store.d.sql[current.id]; store.save(); open(current.id); });
  window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (CH.some(c => c.id === id) && (!current || current.id !== id)) open(id); });
  open(CH.some(c => c.id === location.hash.slice(1)) ? location.hash.slice(1) : (CH.find(c => !store.d.solved[c.id]) || CH[0]).id);
  call({ type: 'init' }).catch(() => {});
  window.qs = { open, run, submit, store, call };
})();
