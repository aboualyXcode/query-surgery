/* runner.js: executes lab requests. Loaded in a Web Worker (so slow queries never freeze the page) or,
   when workers are unavailable (pages opened from file://), on the main thread with the same API. */
(function (root) {
  'use strict';
  const X = root.SQLX;
  const S = () => X.surgery;
  const byId = id => X.CHALLENGES.find(c => c.id === id);
  const MAX_ROWS = 200;
  const cell = v => (v == null ? null : typeof v === 'number' || typeof v === 'boolean' ? v : X.display(v));
  const planLines = node => (node ? X.explainLines(node, true) : []);
  const baselines = new Map();

  function result(r) {
    if (!r) return null;
    return { kind: r.kind, columns: r.columns || [], rows: (r.rows || []).slice(0, MAX_ROWS).map(row => row.map(cell)), rowCount: (r.rows || []).length, work: r.work, message: r.message, plan: r.kind === 'plan' ? r.rows.map(x => x[0]) : planLines(r.plan) };
  }
  function workload(w) {
    return { total: w.total, readCost: w.readCost, writeCost: w.writeCost, created: w.created, entries: w.entries,
      indexes: w.indexes.map(d => ({ name: d.name, table: d.table, cols: d.cols.map(c => c.name + (c.desc ? ' DESC' : '')), include: d.include, where: d.whereText, pk: /_pkey$/.test(d.name) })),
      queries: w.queries.map(q => ({ sql: q.sql, perHour: q.perHour, work: q.work === Infinity ? null : q.work, error: q.error || null, rowCount: q.rows ? q.rows.length : null, plan: planLines(q.plan) })) };
  }
  function schema(ch) {
    const db = S().prepared(ch);
    return { tables: Array.from(db.tables.values()).map(t => ({ name: t.name, rows: t.rows.length, cols: t.cols.map(c => `${c.name} ${X.typeName(c.type).toLowerCase()}`), description: t.description })),
      indexes: Array.from(db.indexes.values()).map(d => ({ name: d.name, table: d.table, cols: d.cols.map(c => c.name + (c.desc ? ' DESC' : '')), include: d.include, where: d.whereText, pk: /_pkey$/.test(d.name) })) };
  }
  function handle(msg) {
    const ch = msg.challenge ? byId(msg.challenge) : null;
    switch (msg.type) {
      case 'init': X.surgery.base(); return { ready: true };
      case 'schema': return schema(ch);
      case 'baseline': {
        if (baselines.has(ch.id)) return baselines.get(ch.id);
        let out;
        if (ch.mode === 'rewrite') {
          const db = S().prepared(ch);
          try { out = { result: result(S().runQuery(db, ch.slow)) }; } catch (e) { out = { error: e.message, cls: e.cls, work: db.meter.work }; }
        } else out = { workload: workload(S().workloadCost(ch, ch.starter || '')) };
        baselines.set(ch.id, out);
        return out;
      }
      case 'run': {
        if (ch.mode === 'rewrite') { const db = S().prepared(ch); try { return { result: result(S().runQuery(db, msg.sql)) }; } catch (e) { return { error: e.message, cls: e.cls, work: db.meter.work }; } }
        try { return { workload: workload(S().workloadCost(ch, msg.sql)) }; } catch (e) { return { error: e.message, cls: e.cls }; }
      }
      case 'submit': {
        const g = S().grade(ch, msg.sql);
        const out = { ok: g.ok, message: g.message, error: g.error || null, cls: g.cls || null, same: g.same, fast: g.fast, work: g.work, total: g.total, target: g.target, problems: g.problems || [] };
        if (g.got) out.result = result(g.got);
        if (g.workload) out.workload = workload(g.workload);
        return out;
      }
      default: throw new Error('unknown request ' + msg.type);
    }
  }
  root.QSRunner = { handle };
  if (typeof importScripts === 'function' && typeof window === 'undefined') {
    root.onmessage = e => {
      const { id } = e.data;
      try { root.postMessage({ id, ok: true, result: handle(e.data) }); }
      catch (err) { root.postMessage({ id, ok: false, error: err.message, cls: err.cls }); }
    };
  }
})(typeof window !== 'undefined' ? window : self);
