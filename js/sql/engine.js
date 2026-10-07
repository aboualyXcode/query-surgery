/* engine.js: plans and executes the AST from parser.js against an in-memory catalog.
   Queries compile to closures once (so correlated subqueries are cheap), then run.
   Evaluation order follows Databricks: FROM → WHERE → GROUP BY → HAVING → window → QUALIFY → SELECT
   → DISTINCT → ORDER BY → LIMIT. */
(function (root) {
  'use strict';
  const X = root.SQLX;
  const { SqlError, SCALAR, AGG, HIGHER_ORDER, WINDOW_ONLY, GENERATORS, compare, keyOf, castValue, arith, likeRe, javaRe, Interval, typeOf } = X;

  /* ---------- helpers ---------- */
  const lc = s => String(s).toLowerCase();
  function lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
  const suggest = (name, options) => options.map(o => [o, lev(lc(name), lc(o.replace(/`/g, '').split('.').pop()))]).sort((a, b) => a[1] - b[1]).slice(0, 5).map(x => x[0]);
  const truthy = v => v === true;
  const bt = s => '`' + s + '`';

  /* A readable name for an expression, the way Databricks labels unaliased columns. */
  function exprName(e) {
    switch (e.k) {
      case 'col': return e.parts[e.parts.length - 1];
      case 'lit': return e.v == null ? 'NULL' : typeof e.v === 'string' ? e.v : String(e.v);
      case 'fn': return e.star ? `${e.name}(1)` : `${e.name}(${e.distinct ? 'DISTINCT ' : ''}${e.args.map(exprName).join(', ')})`;
      case 'bin': return `(${exprName(e.l)} ${e.op} ${exprName(e.r)})`;
      case 'un': return e.op === 'NOT' ? `(NOT ${exprName(e.e)})` : `(${e.op} ${exprName(e.e)})`;
      case 'cast': return exprName(e.e);
      case 'field': return e.name;
      case 'case': return 'CASE WHEN … END';
      case 'index': return `${exprName(e.e)}[${exprName(e.idx)}]`;
      default: return e.k;
    }
  }

  /* ---------- scopes ---------- */
  class Scope {
    constructor(cols, parent, boundary) { this.cols = cols; this.parent = parent || null; this.boundary = boundary || null; }
    /* Returns {depth, index, rest} where rest are leftover parts (struct field access). */
    resolve(parts) {
      let s = this, depth = 0;
      while (s) {
        const r = s.resolveLocal(parts);
        if (r) { r.depth = depth; return r; }
        if (s.boundary) s.boundary.correlated = true;
        s = s.parent; depth++;
      }
      return null;
    }
    resolveLocal(parts) {
      if (this.resolver) return this.resolver(parts);
      const tryMatch = (tbl, name) => {
        const hits = [];
        this.cols.forEach((c, i) => { if (lc(c.name) === lc(name) && (tbl == null ? !c.hidden : lc(c.table || '') === lc(tbl))) hits.push(i); });
        return hits;
      };
      if (parts.length >= 2) {
        const h = tryMatch(parts[0], parts[1]);
        if (h.length === 1) return { index: h[0], rest: parts.slice(2) };
        if (h.length > 1) throw ambiguous(parts.slice(0, 2).join('.'), h.map(i => this.cols[i]));
      }
      const h = tryMatch(null, parts[0]);
      if (h.length === 1) return { index: h[0], rest: parts.slice(1) };
      if (h.length > 1) throw ambiguous(parts[0], h.map(i => this.cols[i]));
      return null;
    }
    names() { const out = []; for (let s = this; s; s = s.parent) s.cols.forEach(c => { if (!c.hidden && c.name) out.push(bt(c.table ? `${c.table}.${c.name}` : c.name)); }); return out; }
  }
  const ambiguous = (name, cols) => new SqlError('AMBIGUOUS_REFERENCE', `Reference ${bt(name)} is ambiguous, could be: [${cols.map(c => bt((c.table ? c.table + '.' : '') + c.name)).join(', ')}].`);
  const unresolved = (parts, scope) => {
    const sug = suggest(parts.join('.'), scope.names());
    return new SqlError('UNRESOLVED_COLUMN.WITH_SUGGESTION', `A column, variable, or function parameter with name ${bt(parts.join('.'))} cannot be resolved. Did you mean one of the following? [${sug.join(', ')}].`);
  };
  const fetch = (env, depth, index) => { let e = env; for (let i = 0; i < depth; i++) e = e.parent; return e.row[index]; };

  /* Structural fingerprint of an expression with columns resolved to positions, so `o.id` and `id` match. */
  function fingerprint(node, scope) {
    return JSON.stringify(node, function (k, v) {
      if (v && typeof v === 'object' && v.k === 'col') {
        try { const r = scope.resolve(v.parts); if (r) return `#c${r.depth}:${r.index}:${(r.rest || []).join('.')}`; } catch (e) { /* ambiguous: fall through */ }
        return '#n' + v.parts.map(lc).join('.');
      }
      if (v && typeof v === 'object' && v.k === 'fn') return Object.assign({}, v, { name: lc(v.name) });
      return v;
    });
  }
  const isAggCall = n => n.k === 'fn' && !n.over && (AGG[n.name] || (n.name === 'count'));
  function walk(node, fn) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, fn)); return; }
    if (fn(node) === false) return;
    for (const k of Object.keys(node)) {
      if (k === 'q' || k === 'over' && false) continue;
      const v = node[k];
      if (v && typeof v === 'object') walk(v, fn);
    }
  }
  function collectAggs(nodes) {
    const out = [];
    walk(nodes, n => {
      if (n.k === 'subq' || n.k === 'exists' || (n.k === 'in' && n.q)) { if (n.k === 'in') walk(n.e, x => { if (isAggCall(x)) { out.push(x); return false; } }); return false; }
      if (n.k === 'lambda') return false;
      if (isAggCall(n)) { out.push(n); return false; }
    });
    return out;
  }
  function collectWindows(nodes) {
    const out = [];
    walk(nodes, n => { if (n.k === 'subq' || n.k === 'exists') return false; if (n.k === 'fn' && n.over) { out.push(n); return false; } });
    return out;
  }
  const hasGenerator = e => e.k === 'fn' && GENERATORS.has(e.name);
  const UNIT_FNS = new Set(['datediff', 'date_diff', 'timestampdiff', 'dateadd', 'date_add', 'timestampadd']);
  /* Static shape of a generator argument, so output columns are known when the query is planned. */
  function staticShape(arg, scope) {
    if (arg.k === 'fn' && ['map', 'str_to_map', 'map_from_arrays', 'map_from_entries'].includes(arg.name)) return { map: true };
    if (arg.k === 'fn' && arg.name === 'array' && arg.args.length) {
      const el = arg.args[0];
      if (el.k === 'fn' && el.name === 'named_struct') return { fields: el.args.filter((_, i) => i % 2 === 0).map(x => String(x.v)) };
      if (el.k === 'fn' && el.name === 'struct') return { fields: el.args.map((a, i) => (a.k === 'col' ? a.parts[a.parts.length - 1] : `col${i + 1}`)) };
    }
    if (arg.k === 'fn' && arg.name === 'from_json' && arg.args[1] && arg.args[1].k === 'lit') {
      try { const t = X.parseType(arg.args[1].v); if (t.base === 'MAP') return { map: true }; if (t.base === 'ARRAY' && t.el.base === 'STRUCT') return { fields: t.el.fields.map(f => f.name) }; } catch (e) { /* reported at compile time */ }
    }
    if (arg.k === 'col') {
      try { const r = scope.resolve(arg.parts); if (r && !r.rest.length) { let s = scope; for (let d = 0; d < r.depth; d++) s = s.parent; const t = s.cols[r.index] && s.cols[r.index].type; if (t && t.base === 'MAP') return { map: true }; if (t && t.base === 'ARRAY' && t.el && t.el.base === 'STRUCT' && t.el.fields && t.el.fields.length) return { fields: t.el.fields.map(f => f.name) }; } } catch (e) { /* ignore */ }
    }
    return {};
  }
  function generatorCols(g, name, arg, scope) {
    const shape = staticShape(arg, scope);
    const base = name.replace('_outer', '');
    if (base === 'explode' && shape.map) return ['key', 'value'];
    if (base === 'posexplode' && shape.map) return ['pos', 'key', 'value'];
    if (base === 'inline') return shape.fields || ['col1'];
    return g.cols;
  }

  /* ================= the database ================= */
  class Database {
    constructor() { this.tables = new Map(); this.stats = { rowsScanned: 0 }; this.indexes = new Map(); this.meter = new Meter(); this.timeout = DEFAULT_TIMEOUT; this.readOnly = false; }
    indexesFor(name) { return Array.from(this.indexes.values()).filter(d => lc(d.table) === lc(name)); }
    table(nameParts, quiet) {
      const name = lc(Array.isArray(nameParts) ? nameParts[nameParts.length - 1] : nameParts);
      const t = this.tables.get(name);
      if (!t && !quiet) {
        const sug = suggest(name, Array.from(this.tables.values()).map(x => x.name));
        throw new SqlError('TABLE_OR_VIEW_NOT_FOUND', `The table or view ${bt(Array.isArray(nameParts) ? nameParts.join('.') : nameParts)} cannot be found. Verify the spelling and correctness of the schema and catalog.${sug.length ? ` Did you mean one of: ${sug.slice(0, 3).map(bt).join(', ')}?` : ''}`);
      }
      return t;
    }
    createTable(name, cols, rows) {
      this.tables.set(lc(name), { name, cols: cols.map(c => (typeof c === 'string' ? { name: c, type: { base: 'STRING' } } : c)), rows: rows || [] });
    }
    clone() { const d = new Database(); this.tables.forEach((t, k) => d.tables.set(k, { name: t.name, cols: t.cols, rows: t.rows.map(r => r.slice()), view: t.view, temp: t.temp, description: t.description, version: (t.version || 0) + 1 })); this.indexes.forEach((v, k) => d.indexes.set(k, v)); d.timeout = this.timeout; return d; }
    /* a cheap copy that shares row data: for read-only use, with its own index set */
    fork() { const d = new Database(); d.tables = this.tables; this.indexes.forEach((v, k) => d.indexes.set(k, v)); d.timeout = this.timeout; d.readOnly = true; return d; }

    /* Run a script. Returns one result per statement: {columns, rows, kind, message}. */
    execute(sql, opts) {
      const statements = X.parse(sql);
      const results = [];
      for (const st of statements) {
        const t0 = Date.now();
        this.meter = new Meter(this.timeout);
        this.lastPlan = null;
        const r = this.run(st, opts || {});
        r.ms = Date.now() - t0;
        r.work = this.meter.work;
        if (this.lastPlan) r.plan = this.lastPlan;
        r.statement = st.text;
        results.push(r);
      }
      return results;
    }
    query(sql) { const r = this.execute(sql); return r[r.length - 1]; }
    run(st) {
      if (this.readOnly && ['insert', 'update', 'delete', 'merge', 'truncate', 'createTable', 'createView'].includes(st.k) || (this.readOnly && st.k === 'drop' && st.kind !== 'index'))
        throw new SqlError('READ_ONLY', 'This lab is read-only: data changes are disabled. You can run queries, EXPLAIN [ANALYZE], CREATE INDEX and DROP INDEX.');
      switch (st.k) {
        case 'query': { const plan = planQuery(st.q, { db: this, ctes: new Map() }, null); const rows = plan.run(null); this.lastPlan = plan.node; return { kind: 'rows', columns: plan.cols.filter(c => !c.hidden).map(c => c.name), rows: rows.map(r => r.filter((_, i) => !plan.cols[i].hidden)) }; }
        case 'explain': {
          if (st.st.k !== 'query') throw new SqlError('UNSUPPORTED_FEATURE', 'EXPLAIN works on queries (SELECT, WITH, VALUES).');
          const plan = planQuery(st.st.q, { db: this, ctes: new Map() }, null);
          if (st.analyze) plan.run(null);
          this.lastPlan = plan.node;
          return { kind: 'plan', columns: ['QUERY PLAN'], rows: explainLines(plan.node, st.analyze).map(l => [l]).concat(st.analyze ? [[`Total work: ${fmtWork(this.meter.work)}`]] : []) };
        }
        case 'createIndex': {
          const t = this.table(st.table);
          if (t.view) throw new SqlError('EXPECT_TABLE_NOT_VIEW', `${bt(t.name)} is a view; indexes go on tables.`);
          const name = lc(st.name);
          if (this.indexes.has(name)) { if (st.ifNotExists) return msg(`Index ${st.name} already exists; nothing changed.`); throw new SqlError('INDEX_ALREADY_EXISTS', `Index ${bt(st.name)} already exists.`); }
          [...st.cols.map(c => c.name), ...st.include].forEach(c => { if (!t.cols.some(x => lc(x.name) === lc(c))) throw new SqlError('UNRESOLVED_COLUMN.WITH_SUGGESTION', `Column ${bt(c)} does not exist in ${bt(t.name)}. Did you mean one of the following? [${suggest(c, t.cols.map(x => x.name)).map(bt).join(', ')}].`); });
          const def = { name: st.name, table: t.name, cols: st.cols, include: st.include, where: st.where, whereText: st.where ? sqlOf(st.where) : null, unique: st.unique };
          if (st.where) planTableAccess(t, t.name, { k: 'table', name: [t.name] }, { db: this, ctes: new Map() }, null); // validates columns
          const data = buildIndex(this, def);
          if (st.unique) for (let i = 1; i < data.entries.length; i++) if (!data.entries[i].k.some(v => v == null) && !cmpKey(data.entries[i].k, data.entries[i - 1].k, def.cols.length)) throw new SqlError('UNIQUE_CONSTRAINT_VIOLATION', `Could not create unique index ${bt(st.name)}: key (${def.cols.map(c => c.name).join(', ')}) = (${data.entries[i].k.join(', ')}) is duplicated.`);
          this.indexes.set(name, def);
          return msg(`Index ${st.name} created on ${t.name} (${def.cols.map(c => c.name + (c.desc ? ' DESC' : '')).join(', ')})${def.include.length ? ` INCLUDE (${def.include.join(', ')})` : ''}${def.where ? ` WHERE ${def.whereText}` : ''}: ${data.n.toLocaleString()} entries.`);
        }
        case 'insert': return this.insert(st);
        case 'update': return this.update(st);
        case 'delete': return this.del(st);
        case 'merge': return this.merge(st);
        case 'createTable': return this.ddlCreate(st);
        case 'createView': {
          const name = st.name[st.name.length - 1];
          if (this.tables.has(lc(name)) && !st.orReplace) { if (st.ifNotExists) return msg('View already exists; nothing changed.'); throw new SqlError('TABLE_OR_VIEW_ALREADY_EXISTS', `Cannot create table or view ${bt(name)} because it already exists. Choose a different name, drop the existing object, or add CREATE OR REPLACE.`); }
          const plan = planQuery(st.q, { db: this, ctes: new Map() }, null);
          this.tables.set(lc(name), { name, cols: plan.cols.filter(c => !c.hidden).map(c => ({ name: c.name, type: { base: 'STRING' } })), rows: [], view: st.q, temp: st.temp });
          return msg(`${st.temp ? 'Temporary view' : 'View'} ${name} created.`);
        }
        case 'drop': {
          const name = st.name[st.name.length - 1];
          const t = this.tables.get(lc(name));
          if (st.kind === 'index') { const k = lc(name); if (!this.indexes.has(k)) { if (st.ifExists) return msg('Nothing to drop.'); throw new SqlError('INDEX_NOT_FOUND', `Index ${bt(name)} does not exist.`); } this.indexes.delete(k); return msg(`Index ${name} dropped.`); }
          if (!t) { if (st.ifExists) return msg('Nothing to drop.'); this.table(st.name); }
          if (st.kind === 'view' && !t.view) throw new SqlError('WRONG_COMMAND_FOR_OBJECT_TYPE', `${bt(name)} is a table. Use DROP TABLE instead.`);
          if (st.kind === 'table' && t.view) throw new SqlError('WRONG_COMMAND_FOR_OBJECT_TYPE', `${bt(name)} is a view. Use DROP VIEW instead.`);
          this.tables.delete(lc(name));
          return msg(`${st.kind === 'view' ? 'View' : 'Table'} ${name} dropped.`);
        }
        case 'truncate': { const t = this.table(st.name); t.rows = []; return msg(`Table ${t.name} truncated.`); }
        case 'show': return { kind: 'rows', columns: ['tableName', 'isTemporary'], rows: Array.from(this.tables.values()).map(t => [t.name, !!t.temp]).sort() };
        case 'describe': { const t = this.table(st.name); if (t.view) { const p = planQuery(t.view, { db: this, ctes: new Map() }, null); return { kind: 'rows', columns: ['col_name', 'data_type'], rows: p.cols.filter(c => !c.hidden).map(c => [c.name, 'view column']) }; } return { kind: 'rows', columns: ['col_name', 'data_type', 'nullable'], rows: t.cols.map(c => [c.name, X.typeName(c.type).toLowerCase(), !c.notNull]) }; }
        case 'noop': return msg(st.note);
        default: throw new SqlError('UNSUPPORTED_FEATURE', 'This statement is not supported in the lab.');
      }
    }
    coerceRow(t, values, cols) {
      const out = t.cols.map(c => (c.def ? null : null));
      const targets = cols ? cols.map(n => { const i = t.cols.findIndex(c => lc(c.name) === lc(n)); if (i < 0) throw new SqlError('UNRESOLVED_COLUMN.WITH_SUGGESTION', `A column with name ${bt(n)} cannot be resolved in table ${bt(t.name)}. Did you mean one of the following? [${suggest(n, t.cols.map(c => c.name)).map(bt).join(', ')}].`); return i; }) : t.cols.map((_, i) => i);
      if (values.length !== targets.length) throw new SqlError('INSERT_COLUMN_ARITY_MISMATCH.' + (values.length > targets.length ? 'TOO_MANY_DATA_COLUMNS' : 'NOT_ENOUGH_DATA_COLUMNS'), `Cannot write to ${bt(t.name)}, the reason is ${values.length > targets.length ? 'too many' : 'not enough'} data columns: table columns: ${targets.map(i => bt(t.cols[i].name)).join(', ')}; data columns: ${values.length} values.`);
      targets.forEach((ti, k) => { out[ti] = castValue(values[k], t.cols[ti].type, false); });
      t.cols.forEach((c, i) => { if (out[i] == null && c.notNull) throw new SqlError('DELTA_NOT_NULL_CONSTRAINT_VIOLATED', `NOT NULL constraint violated for column: ${c.name}.`); });
      return out;
    }
    insert(st) {
      const t = this.table(st.name);
      if (t.view) throw new SqlError('EXPECT_TABLE_NOT_VIEW', `${bt(t.name)} is a view. INSERT expects a table.`);
      const plan = planQuery(st.q, { db: this, ctes: new Map() }, null);
      const rows = plan.run(null).map(r => r.filter((_, i) => !plan.cols[i].hidden));
      const coerced = rows.map(r => this.coerceRow(t, r, st.cols));
      if (st.overwrite) t.rows = coerced; else t.rows.push(...coerced);
      t.version = (t.version || 0) + 1;
      return { kind: 'rows', columns: ['num_affected_rows', 'num_inserted_rows'], rows: [[coerced.length, coerced.length]] };
    }
    tableScope(t, alias) { return new Scope(t.cols.map(c => ({ name: c.name, table: alias || t.name })), null); }
    update(st) {
      const t = this.table(st.name);
      const scope = this.tableScope(t, st.alias);
      const ctx = { db: this, ctes: new Map() };
      const where = st.where ? compile(st.where, scope, ctx) : null;
      const sets = st.set.map(s => { const i = t.cols.findIndex(c => lc(c.name) === lc(s.col)); if (i < 0) throw unresolved([s.col], scope); return { i, f: compile(s.e, scope, ctx) }; });
      let n = 0;
      t.rows = t.rows.map(r => {
        const env = { row: r };
        if (where && !truthy(where(env))) return r;
        n++;
        const nr = r.slice();
        sets.forEach(s => { nr[s.i] = castValue(s.f(env), t.cols[s.i].type, false); if (nr[s.i] == null && t.cols[s.i].notNull) throw new SqlError('DELTA_NOT_NULL_CONSTRAINT_VIOLATED', `NOT NULL constraint violated for column: ${t.cols[s.i].name}.`); });
        return nr;
      });
      t.version = (t.version || 0) + 1;
      return { kind: 'rows', columns: ['num_affected_rows'], rows: [[n]] };
    }
    del(st) {
      const t = this.table(st.name);
      const scope = this.tableScope(t, st.alias);
      const where = st.where ? compile(st.where, scope, { db: this, ctes: new Map() }) : null;
      const before = t.rows.length;
      t.rows = t.rows.filter(r => !(where ? truthy(where({ row: r })) : true));
      t.version = (t.version || 0) + 1;
      return { kind: 'rows', columns: ['num_affected_rows'], rows: [[before - t.rows.length]] };
    }
    merge(st) {
      const t = this.table(st.target.name);
      const ctx = { db: this, ctes: new Map() };
      const src = planFrom(st.source, ctx, null);
      const srcRows = src.run(null);
      const tAlias = st.target.alias || t.name;
      const tCols = t.cols.map(c => ({ name: c.name, table: tAlias }));
      const both = new Scope(tCols.concat(src.cols), null);
      const srcOnly = new Scope(src.cols, null);
      const on = compile(st.on, both, ctx);
      const nT = t.cols.length;
      const nullT = t.cols.map(() => null), nullS = src.cols.map(() => null);
      const clause = c => {
        const sc = c.kind === 'notMatched' ? srcOnly : both;
        const out = { kind: c.kind, action: c.action, cond: c.cond ? compile(c.cond, sc, ctx) : null };
        const srcIndex = name => { const i = src.cols.findIndex(x => lc(x.name) === lc(name) && !x.hidden); if (i < 0) throw new SqlError('UNRESOLVED_COLUMN.WITH_SUGGESTION', `Cannot resolve ${bt(name)} in the MERGE source for \`${c.action === 'insert' ? 'INSERT *' : 'UPDATE SET *'}\`. The source must have every target column. Did you mean one of the following? [${suggest(name, src.cols.map(x => x.name)).map(bt).join(', ')}].`); return i; };
        if (c.action === 'update') out.sets = c.star ? t.cols.map((col, i) => { const si = srcIndex(col.name); return { i, f: env => env.row[nT + si] }; }) : c.set.map(s => { const i = t.cols.findIndex(col => lc(col.name) === lc(s.col)); if (i < 0) throw unresolved([s.col], both); return { i, f: compile(s.e, both, ctx) }; });
        if (c.action === 'insert') {
          if (c.star) out.values = t.cols.map(col => { const si = srcIndex(col.name); return env => env.row[si]; });
          else { if (c.cols.length !== c.values.length) throw new SqlError('INSERT_COLUMN_ARITY_MISMATCH', 'The number of INSERT columns and VALUES must match.'); out.cols = c.cols; out.valueFns = c.values.map(v => compile(v, srcOnly, ctx)); }
        }
        return out;
      };
      const clauses = st.clauses.map(clause);
      const matched = clauses.filter(c => c.kind === 'matched'), notMatched = clauses.filter(c => c.kind === 'notMatched'), bySource = clauses.filter(c => c.kind === 'notMatchedBySource');
      const srcHit = new Array(srcRows.length).fill(false);
      let upd = 0, del = 0, ins = 0;
      const newRows = [];
      for (const tr of t.rows) {
        const hits = [];
        srcRows.forEach((sr, j) => { if (truthy(on({ row: tr.concat(sr) }))) hits.push(j); });
        hits.forEach(j => { srcHit[j] = true; });
        if (hits.length > 1 && matched.length) throw new SqlError('DELTA_MULTIPLE_SOURCE_ROW_MATCHING_TARGET_ROW_IN_MERGE', `Cannot perform Merge as multiple source rows matched and attempted to modify the same target row in the Delta table in possibly conflicting ways. ${hits.length} source rows matched one target row. Deduplicate the source first, for example with QUALIFY ROW_NUMBER() OVER (PARTITION BY <key> ORDER BY <newest first>) = 1.`);
        if (hits.length) {
          const env = { row: tr.concat(srcRows[hits[0]]) };
          const c = matched.find(m => !m.cond || truthy(m.cond(env)));
          if (!c) { newRows.push(tr); continue; }
          if (c.action === 'delete') { del++; continue; }
          const nr = tr.slice(); c.sets.forEach(s => { nr[s.i] = castValue(s.f(env), t.cols[s.i].type, false); }); upd++; newRows.push(nr); continue;
        }
        const env = { row: tr.concat(nullS) };
        const c = bySource.find(m => !m.cond || truthy(m.cond(env)));
        if (!c) { newRows.push(tr); continue; }
        if (c.action === 'delete') { del++; continue; }
        const nr = tr.slice(); c.sets.forEach(s => { nr[s.i] = castValue(s.f(env), t.cols[s.i].type, false); }); upd++; newRows.push(nr);
      }
      srcRows.forEach((sr, j) => {
        if (srcHit[j]) return;
        const env = { row: sr };
        const c = notMatched.find(m => !m.cond || truthy(m.cond(env)));
        if (!c) return;
        if (c.values) newRows.push(this.coerceRow(t, c.values.map(f => f(env))));
        else newRows.push(this.coerceRow(t, c.valueFns.map(f => f(env)), c.cols));
        ins++;
      });
      void nullT;
      t.rows = newRows;
      t.version = (t.version || 0) + 1;
      return { kind: 'rows', columns: ['num_affected_rows', 'num_updated_rows', 'num_deleted_rows', 'num_inserted_rows'], rows: [[upd + del + ins, upd, del, ins]] };
    }
    ddlCreate(st) {
      const name = st.name[st.name.length - 1];
      const exists = this.tables.has(lc(name));
      if (exists && !st.orReplace) { if (st.ifNotExists) return msg(`Table ${name} already exists; nothing changed.`); throw new SqlError('TABLE_OR_VIEW_ALREADY_EXISTS', `Cannot create table or view ${bt(name)} because it already exists. Choose a different name, drop the existing object, add the IF NOT EXISTS clause to tolerate pre-existing objects, or add the OR REPLACE clause.`); }
      if (st.q) {
        const plan = planQuery(st.q, { db: this, ctes: new Map() }, null);
        const rows = plan.run(null).map(r => r.filter((_, i) => !plan.cols[i].hidden));
        const vis = plan.cols.filter(c => !c.hidden);
        const cols = st.cols || vis.map((c, i) => { const v = rows.map(r => r[i]).find(x => x != null); const ty = v == null ? 'STRING' : typeOf(v); return { name: c.name, type: { base: ty.startsWith('ARRAY') ? 'ARRAY' : ty === 'STRUCT' ? 'STRUCT' : ty === 'MAP' ? 'MAP' : ty, el: { base: 'STRING' }, fields: [] } }; });
        const names = new Set();
        cols.forEach(c => { if (names.has(lc(c.name))) throw new SqlError('COLUMN_ALREADY_EXISTS', `The column ${bt(c.name)} already exists. Give each output column a unique alias.`); names.add(lc(c.name)); });
        this.tables.set(lc(name), { name, cols, rows: st.cols ? [] : rows, temp: st.temp });
        if (st.cols) this.tables.get(lc(name)).rows = rows.map(r => this.coerceRow(this.tables.get(lc(name)), r));
        return { kind: 'rows', columns: ['num_affected_rows', 'num_inserted_rows'], rows: [[rows.length, rows.length]] };
      }
      this.tables.set(lc(name), { name, cols: st.cols, rows: [], temp: st.temp });
      return msg(`Table ${name} created.`);
    }
  }
  const msg = m => ({ kind: 'message', columns: [], rows: [], message: m });

  /* ================= cost meter, plan nodes, indexes and access paths ================= */
  /* Work units approximate microseconds of a single-node engine. They are charged by the operators that do
     the work, so EXPLAIN ANALYZE can show where a query spends its time. */
  const COST = { seqRow: 1, seek: 4, indexEntry: 0.3, heapFetch: 1.5, hashBuild: 1, hashProbe: 0.5, match: 0.1, nlPair: 0.2,
    aggRow: 0.5, sortRow: 0.2, sortLog: 0.1, windowRow: 0.6, distinctRow: 0.5, subplanRun: 2, cteRow: 0.1, outRow: 0.05 };
  COST.nlPair = 1; COST.match = 1;
  const DEFAULT_TIMEOUT = 5e6; // a 5-second statement timeout, in simulated work
  class Meter {
    constructor(cap) { this.cap = cap == null ? DEFAULT_TIMEOUT : cap; this.work = 0; }
    charge(node, u) {
      this.work += u;
      if (node) node.work += u;
      if (this.work > this.cap) throw new SqlError('QUERY_CANCELED', `canceling statement due to statement timeout: the query did more than ${fmtWork(this.cap)} of work and was stopped. Look at EXPLAIN ANALYZE for the operator doing the most work.`);
    }
  }
  const fmtWork = u => (u >= 1e6 ? `${(u / 1e6).toFixed(u >= 1e7 ? 0 : 1)} s` : u >= 1e3 ? `${(u / 1e3).toFixed(u >= 1e4 ? 0 : 1)} ms` : `${Math.round(u)} µs`);
  const mkNode = (op, detail) => ({ op, detail: detail || '', children: [], rows: 0, loops: 0, work: 0, notes: [] });
  const meterOf = ctx => ctx.db.meter || (ctx.db.meter = new Meter());

  /* SQL text for an expression, for plan details */
  function sqlOf(e) {
    if (!e) return '';
    switch (e.k) {
      case 'col': return e.parts.join('.');
      case 'lit': return e.v == null ? 'NULL' : typeof e.v === 'string' ? `'${e.v}'` : String(e.v);
      case 'bin': return `${sqlOf(e.l)} ${e.op} ${sqlOf(e.r)}`;
      case 'un': return e.op === 'NOT' ? `NOT (${sqlOf(e.e)})` : `${e.op}${sqlOf(e.e)}`;
      case 'fn': return e.star ? `${e.name}(*)` : `${e.name}(${e.distinct ? 'DISTINCT ' : ''}${e.args.map(sqlOf).join(', ')})`;
      case 'isnull': return `${sqlOf(e.e)} IS ${e.not ? 'NOT ' : ''}NULL`;
      case 'between': return `${sqlOf(e.e)} ${e.not ? 'NOT ' : ''}BETWEEN ${sqlOf(e.lo)} AND ${sqlOf(e.hi)}`;
      case 'in': return `${sqlOf(e.e)} ${e.not ? 'NOT ' : ''}IN (${e.list ? e.list.map(sqlOf).join(', ') : 'subquery'})`;
      case 'like': return `${sqlOf(e.e)} ${e.not ? 'NOT ' : ''}${e.op} ${e.pat ? sqlOf(e.pat) : '…'}`;
      case 'cast': return `CAST(${sqlOf(e.e)} AS ${X.typeName(e.type)})`;
      case 'exists': return 'EXISTS (subquery)';
      case 'subq': return '(subquery)';
      case 'case': return 'CASE … END';
      case 'interval': return `INTERVAL ${typeof e.v === 'number' ? e.v : sqlOf(e.v)} ${e.unit}`;
      case 'distinctfrom': return `${sqlOf(e.l)} IS ${e.not ? 'NOT ' : ''}DISTINCT FROM ${sqlOf(e.r)}`;
      default: return '…';
    }
  }
  const conjuncts = e => { const out = []; const split = x => { if (x && x.k === 'bin' && x.op === 'AND') { split(x.l); split(x.r); } else if (x) out.push(x); }; split(e); return out; };
  const hasSubquery = e => { let hit = false; walk(e, n => { if (n.k === 'subq' || n.k === 'exists' || (n.k === 'in' && n.q)) { hit = true; return false; } }); return hit; };

  /* ---------- B-tree indexes ---------- */
  const indexCache = new Map();
  function cmpKey(a, b, n) {
    for (let i = 0; i < n; i++) {
      const x = a[i], y = b[i];
      if (x == null || y == null) { if (x == null && y == null) continue; return x == null ? -1 : 1; }
      const c = compare(x, y); if (c) return c;
    }
    return 0;
  }
  function buildIndex(db, def) {
    const t = db.table(def.table);
    const key = `${lc(t.name)}#${t.version || 0}#${def.cols.map(c => lc(c.name)).join(',')}#${def.whereText || ''}`;
    if (indexCache.has(key)) return indexCache.get(key);
    const colIdx = def.cols.map(c => t.cols.findIndex(x => lc(x.name) === lc(c.name)));
    let pred = null;
    if (def.where) { const sc = new Scope(t.cols.map(c => ({ name: c.name, table: t.name })), null); pred = compile(def.where, sc, { db, ctes: new Map() }); }
    const entries = [];
    t.rows.forEach((r, i) => { if (!pred || truthy(pred({ row: r }))) entries.push({ k: colIdx.map(j => r[j]), r: i }); });
    entries.sort((a, b) => cmpKey(a.k, b.k, colIdx.length) || a.r - b.r);
    let distinctLead = 0; for (let i = 0; i < entries.length; i++) if (i === 0 || cmpKey(entries[i].k, entries[i - 1].k, 1)) distinctLead++;
    const data = { entries, colIdx, n: entries.length, distinctLead };
    indexCache.set(key, data);
    return data;
  }
  /* first entry with key prefix >= v (or > v when strict) on the first `n` columns */
  function lowerBound(entries, v, n, strict) {
    let lo = 0, hi = entries.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; const c = cmpKey(entries[mid].k, v, n); if (c < 0 || (strict && c === 0)) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /* ---------- sargable predicates ---------- */
  /* A conjunct is sargable when one side is a bare column of this table and the other side does not
     reference this table (literals, parameters and outer references are fine). */
  function analyzeSarg(e, scope, t) {
    const own = n => { let hit = false; walk(n, x => { if (x.k === 'col') { try { const r = scope.resolveLocal(x.parts); if (r) hit = true; } catch (err) { hit = true; } } if (x.k === 'subq' || x.k === 'exists') return false; }); return hit; };
    const bare = n => { if (n.k !== 'col') return -1; try { const r = scope.resolveLocal(n.parts); return r && !r.rest.length ? r.index : -1; } catch (err) { return -1; } };
    const castBlocks = (ci, valNode) => { const ty = t.cols[ci] && t.cols[ci].type && t.cols[ci].type.base; return ty === 'STRING' && valNode.k === 'lit' && typeof valNode.v === 'number'; };
    const flip = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' };
    if (e.k === 'bin' && ['=', '<', '<=', '>', '>='].includes(e.op)) {
      let ci = bare(e.l), val = e.r, op = e.op;
      if (ci < 0) { ci = bare(e.r); val = e.l; op = flip[e.op]; }
      if (ci >= 0 && !own(val)) return castBlocks(ci, val) ? { blocked: ci, why: `${sqlOf(e)} compares a text column with a number, so every row's value must be converted` } : { col: ci, op: op === '=' ? 'eq' : op, vals: [val] };
    }
    if (e.k === 'between' && !e.not) { const ci = bare(e.e); if (ci >= 0 && !own(e.lo) && !own(e.hi)) return { col: ci, op: 'between', vals: [e.lo, e.hi] }; }
    if (e.k === 'in' && e.list && !e.not) { const ci = bare(e.e); if (ci >= 0 && e.list.every(v => !own(v))) return e.list.some(v => castBlocks(ci, v)) ? { blocked: ci, why: `${sqlOf(e)} compares a text column with numbers` } : { col: ci, op: 'in', vals: e.list }; }
    if (e.k === 'like' && !e.not && e.op === 'LIKE' && e.pat && e.pat.k === 'lit' && typeof e.pat.v === 'string') {
      const ci = bare(e.e);
      if (ci >= 0) {
        const m = /^[^%_\\]*/.exec(e.pat.v)[0];
        if (m.length) return { col: ci, op: 'prefix', vals: [{ k: 'lit', v: m }] };
        return { blocked: ci, why: `${sqlOf(e)} starts with a wildcard, so the index order cannot narrow the search` };
      }
    }
    // a column of this table inside a function, arithmetic or cast: not sargable
    let wrapped = -1;
    walk(e, x => { if (x.k === 'subq' || x.k === 'exists') return false; if ((x.k === 'fn' || x.k === 'cast' || (x.k === 'bin' && ['+', '-', '*', '/', '||'].includes(x.op))) ) { walk(x, y => { if (y.k === 'col' && wrapped < 0) { const ci = bare(y); if (ci >= 0) wrapped = ci; } }); return false; } });
    if (wrapped >= 0) return { blocked: wrapped, why: `${sqlOf(e)} wraps the column in an expression, so its index cannot be used` };
    if (e.k === 'bin' && e.op === 'OR') { let ci = -1; walk(e, y => { if (y.k === 'col' && ci < 0) ci = bare(y); }); if (ci >= 0) return { blocked: ci, why: `${sqlOf(e)}: an OR across conditions cannot use a single index range` }; }
    if (e.k === 'bin' && e.op === '<>') { const ci = bare(e.l) >= 0 ? bare(e.l) : bare(e.r); if (ci >= 0) return { blocked: ci, why: `${sqlOf(e)}: "not equal" matches almost everything, so an index does not help` }; }
    return null;
  }

  /* ---------- the base-table access node ---------- */
  function planTableAccess(t, alias, f, ctx, outer) {
    const db = ctx.db;
    const cols = t.cols.map(c => ({ name: c.name, table: alias, type: c.type }));
    const scope = new Scope(cols, outer);
    const pushed = (ctx.pushdown && ctx.pushdown.get(f)) || [];
    const hints = (ctx.accessHints && ctx.accessHints.get(f)) || {};
    const residual = pushed.map(e => compile(e, scope, ctx));
    const sargs = pushed.map(e => analyzeSarg(e, scope, t));
    sargs.forEach(sg => { if (sg && sg.vals) sg.fns = sg.vals.map(v => compile(v, scope, ctx)); });
    const pushedFps = pushed.map(e => fingerprint(e, scope));
    const node = mkNode('Seq Scan', `on ${t.name}${alias && lc(alias) !== lc(t.name) ? ' ' + alias : ''}`);
    if (pushed.length) node.filter = pushed.map(sqlOf).join(' AND ');
    const defs = () => db.indexesFor(t.name).filter(d => !d.where || pushedFps.includes(fingerprint(d.where, scope)));
    const required = hints.required; // Set of lower-case column names, or null for all
    const covering = d => required && Array.from(required).every(c => d.cols.some(x => lc(x.name) === c) || d.include.some(x => lc(x) === c));
    const blockedNotes = () => sargs.filter(s => s && s.blocked != null).filter(s => db.indexesFor(t.name).some(d => lc(d.cols[0].name) === lc(t.cols[s.blocked].name))).map(s => s.why);

    /* choose an access path for this execution, using exact counts from the index */
    function choose(env) {
      const n = t.rows.length;
      let best = { kind: 'seq', cost: n * COST.seqRow, est: n };
      if (!pushed.length && hints.limitHint != null && !hints.order) best.cost = Math.min(n, hints.limitHint) * COST.seqRow;
      for (const d of defs()) {
        const data = buildIndex(db, d);
        const ranges = rangesFor(d, data, env);
        if (ranges) {
          const matches = ranges.reduce((a, r) => a + (r[1] - r[0]), 0);
          const cov = covering(d);
          let cost = ranges.length * (COST.seek + Math.log2(data.n + 2)) + matches * (COST.indexEntry + (cov ? 0 : COST.heapFetch));
          if (hints.limitHint != null && !hints.order && pushed.length === ranges.prefixUsed) cost = ranges.length * (COST.seek + Math.log2(data.n + 2)) + Math.min(matches, hints.limitHint) * (COST.indexEntry + (cov ? 0 : COST.heapFetch));
          if (cost < best.cost) best = { kind: cov ? 'indexOnly' : 'index', d, data, ranges, cost, est: matches, cov };
        }
        if (hints.order && hints.limitHint != null) {
          const o = orderedRange(d, data, env, hints.order);
          if (o) {
            const cov = covering(d);
            const cost = COST.seek + Math.log2(data.n + 2) + Math.min(o.span, hints.limitHint * 4) * (COST.indexEntry + (cov ? 0 : COST.heapFetch));
            if (cost < best.cost || best.kind === 'seq') best = { kind: 'ordered', d, data, ordered: o, cost, cov };
          }
        }
      }
      return best;
    }
    /* key ranges for the equality prefix and an optional range on the next column, or null */
    function rangesFor(d, data, env) {
      const k = d.cols.length;
      const eqVals = [];
      let i = 0, inList = null, range = null;
      for (; i < k; i++) {
        const ci = t.cols.findIndex(c => lc(c.name) === lc(d.cols[i].name));
        const s = sargs.find(x => x && x.col === ci && (x.op === 'eq' || (x.op === 'in' && !inList)));
        if (s) { if (s.op === 'in') { inList = { pos: i, vals: s.fns.map(f2 => f2(env)) }; eqVals.push(null); } else eqVals.push(s.fns[0](env)); continue; }
        const r = sargs.filter(x => x && x.col === ci && ['lt', '<', '<=', '>', '>=', 'between', 'prefix'].includes(x.op));
        if (r.length) range = { pos: i, preds: r };
        break;
      }
      if (!eqVals.length && !range) return null;
      const prefixSets = inList ? inList.vals.filter(v => v != null).map(v => eqVals.map((x, j) => (j === inList.pos ? v : x))) : [eqVals];
      const out = [];
      for (const pre of prefixSets) {
        if (pre.some(v => v == null)) continue; // = NULL never matches
        let lo = lowerBound(data.entries, pre, pre.length, false), hi = lowerBound(data.entries, pre, pre.length, true);
        if (range) {
          const p = pre.length;
          for (const s of range.preds) {
            const v = s.fns.map(f2 => f2(env));
            const at = (val, strict) => { const key = pre.concat([val]); let a = lo, b = hi; while (a < b) { const m = (a + b) >> 1; const c = cmpKey(data.entries[m].k, key, p + 1); if (c < 0 || (strict && c === 0)) a = m + 1; else b = m; } return a; };
            if (v.some(x => x == null)) { hi = lo; continue; }
            if (s.op === '>') lo = Math.max(lo, at(v[0], true));
            else if (s.op === '>=') lo = Math.max(lo, at(v[0], false));
            else if (s.op === '<') hi = Math.min(hi, at(v[0], false));
            else if (s.op === '<=') hi = Math.min(hi, at(v[0], true));
            else if (s.op === 'between') { lo = Math.max(lo, at(v[0], false)); hi = Math.min(hi, at(v[1], true)); }
            else if (s.op === 'prefix') { lo = Math.max(lo, at(v[0], false)); hi = Math.min(hi, at(v[0] + '\uffff', true)); }
          }
          // skip NULLs in the range column
          while (lo < hi && data.entries[lo].k[p] == null) lo++;
        }
        if (hi > lo) out.push([lo, hi]); else out.push([lo, lo]);
      }
      out.prefixUsed = eqVals.length + (range ? range.preds.length : 0);
      return out;
    }
    /* an index that returns rows in the ORDER BY order: equality prefix, then the order columns */
    function orderedRange(d, data, env, order) {
      let p = 0; const pre = [];
      while (p < d.cols.length) {
        const ci = t.cols.findIndex(c => lc(c.name) === lc(d.cols[p].name));
        const s = sargs.find(x => x && x.col === ci && x.op === 'eq');
        if (!s || order.some(o => o.col === ci)) break;
        pre.push(s.fns[0](env)); p++;
      }
      if (order.length > d.cols.length - p) return null;
      let reverse = null;
      for (let i = 0; i < order.length; i++) {
        const ci = t.cols.findIndex(c => lc(c.name) === lc(d.cols[p + i].name));
        if (order[i].col !== ci) return null;
        const r = order[i].desc !== !!d.cols[p + i].desc;
        if (reverse == null) reverse = r; else if (reverse !== r) return null;
      }
      if (pre.some(v => v == null)) return null;
      let lo = pre.length ? lowerBound(data.entries, pre, pre.length, false) : 0, hi = pre.length ? lowerBound(data.entries, pre, pre.length, true) : data.entries.length;
      const firstCi = order[0].col;
      for (const sg of sargs.filter(x => x && x.col === firstCi && ['<', '<=', '>', '>=', 'between'].includes(x.op))) {
        const v = sg.fns.map(f2 => f2(env));
        if (v.some(x => x == null)) { hi = lo; continue; }
        const at = (val, strict) => { const key = pre.concat([val]); let a = lo, b = hi; while (a < b) { const m2 = (a + b) >> 1; const c = cmpKey(data.entries[m2].k, key, p + 1); if (c < 0 || (strict && c === 0)) a = m2 + 1; else b = m2; } return a; };
        if (sg.op === '>') lo = Math.max(lo, at(v[0], true)); else if (sg.op === '>=') lo = Math.max(lo, at(v[0], false));
        else if (sg.op === '<') hi = Math.min(hi, at(v[0], false)); else if (sg.op === '<=') hi = Math.min(hi, at(v[0], true));
        else { lo = Math.max(lo, at(v[0], false)); hi = Math.min(hi, at(v[1], true)); }
      }
      return { lo, hi, reverse, span: Math.max(0, hi - lo) };
    }

    const passes = env => { for (const f2 of residual) if (!truthy(f2(env))) return false; return true; };
    const plan = {
      cols, node, isBase: true, table: t, alias, scope, pushed, residual, sargs,
      run(env) {
        const m = meterOf(ctx);
        node.loops++;
        const best = choose({ row: [], parent: env });
        const out = [];
        const lim = hints.limitHint;
        if (best.kind === 'seq') {
          node.op = 'Seq Scan';
          for (const r of t.rows) {
            m.charge(node, COST.seqRow); node.read = (node.read || 0) + 1;
            if (!residual.length || passes({ row: r, parent: env })) { out.push(r); if (lim != null && !hints.order && out.length >= lim) break; }
          }
        } else if (best.kind === 'ordered') {
          node.op = best.cov ? 'Index Only Scan' : 'Index Scan'; node.index = best.d.name; node.ordered = true;
          const { lo, hi, reverse } = best.ordered, E = best.data.entries;
          m.charge(node, COST.seek + Math.log2(best.data.n + 2));
          for (let i = reverse ? hi - 1 : lo; reverse ? i >= lo : i < hi; i += reverse ? -1 : 1) {
            m.charge(node, COST.indexEntry + (best.cov ? 0 : COST.heapFetch)); node.read = (node.read || 0) + 1;
            const r = t.rows[E[i].r];
            if (!residual.length || passes({ row: r, parent: env })) { out.push(r); if (out.length >= lim) break; }
          }
          out.orderedBy = hints.order;
        } else {
          node.op = best.cov ? 'Index Only Scan' : 'Index Scan'; node.index = best.d.name; node.ordered = false;
          const E = best.data.entries;
          for (const [lo, hi] of best.ranges) {
            m.charge(node, COST.seek + Math.log2(best.data.n + 2));
            for (let i = lo; i < hi; i++) {
              m.charge(node, COST.indexEntry + (best.cov ? 0 : COST.heapFetch)); node.read = (node.read || 0) + 1;
              const r = t.rows[E[i].r];
              if (!residual.length || passes({ row: r, parent: env })) { out.push(r); if (lim != null && !hints.order && out.length >= lim) break; }
            }
            if (lim != null && !hints.order && out.length >= lim) break;
          }
        }
        node.rows += out.length;
        node.notes = blockedNotes();
        return out;
      },
      /* expected rows and cost of a full execution, without executing */
      estimate(env) { const b = choose({ row: [], parent: env }); return { cost: b.cost, rows: b.kind === 'seq' ? (pushed.length ? t.rows.length * 0.5 : t.rows.length) : b.est }; },
      /* an index whose leading column is `ci`, for index nested loop joins */
      lookupOn(ci) {
        const d = defs().find(x => lc(x.cols[0].name) === lc(t.cols[ci].name));
        if (!d) return null;
        const data = buildIndex(db, d);
        return {
          d, data, cov: covering(d),
          fetch(v, env) {
            const m = meterOf(ctx);
            m.charge(node, COST.seek + Math.log2(data.n + 2));
            if (v == null) return [];
            const lo = lowerBound(data.entries, [v], 1, false), hi = lowerBound(data.entries, [v], 1, true);
            const out = [];
            for (let i = lo; i < hi; i++) { m.charge(node, COST.indexEntry + (this.cov ? 0 : COST.heapFetch)); node.read = (node.read || 0) + 1; const r = t.rows[data.entries[i].r]; if (!residual.length || passes({ row: r, parent: env })) out.push(r); }
            node.rows += out.length;
            return out;
          },
        };
      },
    };
    return plan;
  }

  /* ---------- predicate pushdown ---------- */
  /* Base tables in a FROM tree, and whether an outer join makes them nullable (WHERE filters on a
     nullable side cannot be pushed below the join without changing results). */
  function baseTables(f, db, ctes, nullable, out) {
    out = out || [];
    if (!f) return out;
    if (f.k === 'table') {
      const name = lc(f.name[f.name.length - 1]);
      const t = f.name.length === 1 && ctes.has(name) ? null : db.table(f.name, true);
      if (t && !t.view) out.push({ f, alias: lc(f.alias || f.name[f.name.length - 1]), t, nullable });
    } else if (f.k === 'join') {
      baseTables(f.l, db, ctes, nullable || f.type === 'right' || f.type === 'full', out);
      if (f.type !== 'semi' && f.type !== 'anti') baseTables(f.r, db, ctes, nullable || f.type === 'left' || f.type === 'full', out);
      else baseTables(f.r, db, ctes, true, out);
    }
    return out;
  }
  /* every alias introduced by a FROM tree (base tables, CTE references, derived tables, VALUES, functions) */
  function fromAliases(f, out) {
    out = out || new Set();
    if (!f) return out;
    if (f.k === 'join') { fromAliases(f.l, out); fromAliases(f.r, out); return out; }
    if (f.k === 'table') out.add(lc(f.alias || f.name[f.name.length - 1]));
    else if (f.alias) out.add(lc(f.alias));
    else out.add('#anon');
    return out;
  }
  /* which base table a conjunct belongs to, or null */
  function ownerOf(e, bases, locals) {
    const nonBase = locals ? Array.from(locals).filter(a => !bases.some(b => b.alias === a)) : [];
    if (hasSubquery(e) || collectAggs([e]).length || collectWindows([e]).length) return null;
    let owner = null, ok = true;
    walk(e, n => {
      if (n.k !== 'col') return;
      let hits;
      if (n.parts.length >= 2) hits = bases.filter(b => b.alias === lc(n.parts[0]) && b.t.cols.some(c => lc(c.name) === lc(n.parts[1])));
      else hits = bases.filter(b => b.t.cols.some(c => lc(c.name) === lc(n.parts[0])));
      if (hits.length > 1) { ok = false; return; }
      if (!hits.length) {
        // a column of a derived table or CTE in this FROM clause is not an outer reference
        if (n.parts.length >= 2 ? nonBase.includes(lc(n.parts[0])) : nonBase.length) ok = false;
        return; // otherwise an outer reference: a constant for this query
      }
      if (owner && owner !== hits[0]) ok = false; else owner = hits[0];
    });
    return ok ? owner : null;
  }
  /* columns of `alias` the query needs, for index-only scans; null means all of them */
  function requiredColumns(q, base, bases) {
    let all = false;
    const need = new Set();
    walk(q, n => {
      if (n.k === 'star' && (!n.table || lc(n.table) === base.alias)) all = true;
      if (n.k === 'col') {
        if (n.parts.length >= 2 && lc(n.parts[0]) === base.alias) need.add(lc(n.parts[1]));
        else if (n.parts.length === 1 && base.t.cols.some(c => lc(c.name) === lc(n.parts[0])) && bases.filter(b => b.t.cols.some(c => lc(c.name) === lc(n.parts[0]))).length <= 1) need.add(lc(n.parts[0]));
      }
      if (n.k === 'join' && n.using) n.using.forEach(u => need.add(lc(u)));
    });
    return all ? null : need;
  }

  /* ---------- EXPLAIN ---------- */
  function explainLines(node, analyze, depth, out) {
    out = out || []; depth = depth || 0;
    const pad = depth ? '  '.repeat(depth - 1) + '->  ' : '';
    let line = `${pad}${node.op}${node.index ? ` using ${node.index}` : ''} ${node.detail || ''}`.trimEnd();
    if (analyze) line += `  (rows=${node.loops > 1 ? Math.round(node.rows / node.loops) : node.rows} loops=${node.loops}${node.work >= 1 ? ` work=${fmtWork(node.work)}` : ''})`;
    out.push(line);
    const ind = '  '.repeat(depth) + (depth ? '    ' : '  ');
    if (node.ordered) out.push(`${ind}Order: index order (no sort needed)`);
    if (node.cond) out.push(`${ind}${node.condLabel || 'Cond'}: ${node.cond}`);
    if (node.filter) out.push(`${ind}Filter: ${node.filter}`);
    if (analyze && node.read != null && node.read > node.rows) out.push(`${ind}${/Index/.test(node.op) ? 'Index entries read' : 'Rows read'}: ${node.read.toLocaleString('en-US')} (removed by filter: ${(node.read - node.rows).toLocaleString('en-US')})`);
    if (node.sortKey) out.push(`${ind}Sort Key: ${node.sortKey}`);
    if (node.groupKey) out.push(`${ind}Group Key: ${node.groupKey}`);
    (node.notes || []).forEach(n => out.push(`${ind}Note: ${n}`));
    node.children.forEach(c => explainLines(c, analyze, depth + 1, out));
    (node.subplans || []).forEach((c, i) => { out.push(`${ind}SubPlan ${i + 1}${analyze ? ` (runs=${c.loops})` : ''}`); explainLines(c, analyze, depth + 2, out); });
    return out;
  }

  /* ================= planning ================= */
  /* plan = { cols: [{name, table, hidden}], run(outerEnv) → rows } */
  function planQuery(q, ctx, outer) {
    switch (q.k) {
      case 'with': return planWith(q, ctx, outer);
      case 'select': return planSelect(q, ctx, outer);
      case 'setop': return planSetop(q, ctx, outer);
      case 'wrap': {
        const inner = planQuery(q.q, ctx, outer);
        if (!q.orderBy && q.limit == null && q.offset == null) return inner;
        const scope = new Scope(inner.cols.map(c => ({ name: c.name, table: null, hidden: c.hidden })), outer);
        const order = q.orderBy ? q.orderBy.map(o => orderTerm(o, scope, ctx, inner.cols)) : null;
        const lim = limits(q, ctx);
        const node = mkNode(order ? 'Sort' : 'Limit'); node.children.push(inner.node || mkNode('?'));
        if (order) node.sortKey = q.orderBy.map(o => sqlOf(o.e) + (o.desc ? ' DESC' : '')).join(', ');
        return { cols: inner.cols, node, get correlated() { return inner.correlated; }, run(env) { let rows = inner.run(env); node.loops++; if (order) { meterOf(ctx).charge(node, rows.length * COST.sortRow + rows.length * Math.log2(rows.length + 1) * COST.sortLog); rows = sortRows(rows.map(r => ({ out: r, env: { row: r, parent: env } })), order).map(x => x.out); } const out = lim(rows); node.rows += out.length; return out; } };
      }
      default: throw new SqlError('INTERNAL_ERROR', 'Unknown query node ' + q.k);
    }
  }
  function planWith(q, ctx, outer) {
    const ctes = new Map(ctx.ctes);
    const inner = Object.assign({}, ctx, { ctes });
    for (const c of q.w.ctes) {
      const name = lc(c.name);
      if (q.w.recursive && c.q.k === 'setop' && c.q.op === 'UNION' && referencesTable(c.q.r, name)) {
        const anchor = planQuery(c.q.l, inner, outer);
        const cols = (c.cols || anchor.cols.map(x => x.name)).map(n => ({ name: n }));
        const state = { rows: [] };
        ctes.set(name, { cols, rows: () => state.rows, recursiveState: state });
        const step = planQuery(c.q.r, inner, outer);
        if (step.cols.length !== cols.length) throw new SqlError('NUM_COLUMNS_MISMATCH', `The recursive member of CTE ${bt(c.name)} returns ${step.cols.length} columns, but the anchor returns ${cols.length}.`);
        let cache = null;
        const rnode = mkNode('Recursive Union', c.name); rnode.children.push(anchor.node || mkNode('?'), step.node || mkNode('?'));
        ctes.set(name, { cols, node: rnode, rows: env => {
          if (state.running) return state.rows;
          if (cache && !anchor.correlated) return cache;
          state.running = true;
          let all = anchor.run(env), work = all;
          const seen = c.q.all ? null : new Set(all.map(r => keyOf(r)));
          for (let it = 0; work.length; it++) {
            if (it > 1000) { state.running = false; throw new SqlError('RECURSION_LEVEL_LIMIT_EXCEEDED', `Recursion level limit 1000 reached in CTE ${bt(c.name)}. Check the recursive member has a terminating condition.`); }
            state.rows = work;
            let next = step.run(env);
            if (seen) next = next.filter(r => { const k = keyOf(r); if (seen.has(k)) return false; seen.add(k); return true; });
            all = all.concat(next); work = next;
            if (all.length > 200000) break;
          }
          state.running = false; state.rows = all; cache = all;
          return all;
        } });
        continue;
      }
      const p = planQuery(c.q, inner, outer);
      const cnode = mkNode('CTE', c.name); cnode.children.push(p.node || mkNode('?'));
      const cols = c.cols ? c.cols.map(n => ({ name: n })) : p.cols.map(x => ({ name: x.name, hidden: x.hidden }));
      if (c.cols && c.cols.length !== p.cols.filter(x => !x.hidden).length) throw new SqlError('NUM_COLUMNS_MISMATCH', `CTE ${bt(c.name)} declares ${c.cols.length} columns but its query returns ${p.cols.length}.`);
      let cache = null, cacheEnv;
      ctes.set(name, { cols, node: cnode, rows: env => { if (cache && (!p.correlated || cacheEnv === env)) return cache; cache = p.run(env); cacheEnv = env; cnode.loops++; cnode.rows += cache.length; return cache; } });
    }
    const body = planQuery(q.q, inner, outer);
    return body;
  }
  function referencesTable(q, name) { let hit = false; walk(q, n => { if (n.k === 'table' && lc(n.name[n.name.length - 1]) === name) hit = true; }); return hit; }

  function planSetop(q, ctx, outer) {
    const l = planQuery(q.l, ctx, outer), r = planQuery(q.r, ctx, outer);
    const lv = l.cols.filter(c => !c.hidden), rv = r.cols.filter(c => !c.hidden);
    if (lv.length !== rv.length) throw new SqlError('NUM_COLUMNS_MISMATCH', `${q.op} can only be performed on inputs with the same number of columns, but the first input has ${lv.length} columns and the second input has ${rv.length} columns.`);
    const strip = (p, rows) => rows.map(row => row.filter((_, i) => !p.cols[i].hidden));
    const node = mkNode(q.op === 'UNION' && q.all ? 'Append' : `HashSetOp ${q.op}${q.all ? ' ALL' : ''}`);
    node.children.push(l.node || mkNode('?'), r.node || mkNode('?'));
    return {
      cols: lv.map(c => ({ name: c.name })),
      node,
      get correlated() { return l.correlated || r.correlated; },
      run(env) {
        const a = strip(l, l.run(env)), b = strip(r, r.run(env));
        node.loops++;
        if (!(q.op === 'UNION' && q.all)) meterOf(ctx).charge(node, (a.length + b.length) * COST.distinctRow);
        if (q.op === 'UNION') { if (q.all) { node.rows += a.length + b.length; return a.concat(b); } const seen = new Set(); return a.concat(b).filter(row => { const k = keyOf(row); if (seen.has(k)) return false; seen.add(k); return true; }); }
        const counts = new Map(); b.forEach(row => { const k = keyOf(row); counts.set(k, (counts.get(k) || 0) + 1); });
        const out = [], emitted = new Set();
        for (const row of a) {
          const k = keyOf(row), c = counts.get(k) || 0;
          if (q.op === 'INTERSECT') { if (c > 0) { if (q.all) { out.push(row); counts.set(k, c - 1); } else if (!emitted.has(k)) { out.push(row); emitted.add(k); } } }
          else if (q.all) { if (c > 0) counts.set(k, c - 1); else out.push(row); }
          else if (!c && !emitted.has(k)) { out.push(row); emitted.add(k); }
        }
        return out;
      },
    };
  }

  /* ---------- FROM ---------- */
  function planFrom(f, ctx, outer) {
    switch (f.k) {
      case 'table': {
        const name = lc(f.name[f.name.length - 1]);
        const alias = f.alias || f.name[f.name.length - 1];
        if (f.name.length === 1 && ctx.ctes.has(name)) {
          const c = ctx.ctes.get(name);
          const node = mkNode('CTE Scan', `on ${f.name[0]}${f.alias ? ' ' + f.alias : ''}`);
          if (c.node && !c.node.shown) { node.children.push(c.node); c.node.shown = true; }
          return { cols: c.cols.map(x => ({ name: x.name, table: alias, hidden: x.hidden })), node, run: env => { const rows = c.rows(env); node.loops++; node.rows += rows.length; meterOf(ctx).charge(node, rows.length * COST.cteRow); return rows; } };
        }
        const t = ctx.db.table(f.name);
        if (t.view) {
          const p = planQuery(t.view, { db: ctx.db, ctes: new Map() }, null);
          const node = mkNode('View Scan', `on ${t.name}`); node.children.push(p.node);
          return { cols: p.cols.map(x => ({ name: x.name, table: alias, hidden: x.hidden })), node, run: () => { const rows = p.run(null); node.loops++; node.rows += rows.length; return rows; } };
        }
        return planTableAccess(t, alias, f, ctx, outer);
      }
      case 'subquery': {
        const p = planQuery(f.q, ctx, outer);
        const names = f.colAliases || p.cols.map(c => c.name);
        if (f.colAliases && f.colAliases.length !== p.cols.filter(c => !c.hidden).length) throw new SqlError('NUM_COLUMNS_MISMATCH', `The derived table ${bt(f.alias)} has ${p.cols.length} columns but ${f.colAliases.length} column aliases.`);
        const node = mkNode('Subquery Scan', f.alias ? `on ${f.alias}` : ''); node.children.push(p.node);
        return { cols: p.cols.map((c, i) => ({ name: names[i], table: f.alias || null, hidden: c.hidden })), node, run: env => { const rows = p.run(env); node.loops++; node.rows += rows.length; return rows; }, correlated: p.correlated, lateral: f.lateral, plan: p };
      }
      case 'values': {
        const scope = new Scope([], outer);
        const rows = f.rows.map(r => r.map(e => compile(e, scope, ctx)));
        const width = f.rows[0].length;
        if (f.rows.some(r => r.length !== width)) throw new SqlError('INVALID_INLINE_TABLE.NUM_COLUMNS_MISMATCH', 'All rows of an inline table must have the same number of columns.');
        const names = f.colAliases || Array.from({ length: width }, (_, i) => `col${i + 1}`);
        const node = mkNode('Values Scan', `${f.rows.length} row${f.rows.length === 1 ? '' : 's'}`);
        return { cols: names.map(n => ({ name: n, table: f.alias || null })), node, run: env => { node.loops++; node.rows += rows.length; return rows.map(r => r.map(fn => fn(env))); } };
      }
      case 'tvf': return planTvf(f, ctx, outer);
      case 'join': return planJoin(f, ctx, outer);
      default: throw new SqlError('INTERNAL_ERROR', 'Unknown FROM item ' + f.k);
    }
  }
  function planTvf(f, ctx, outer) {
    const scope = new Scope([], outer);
    const args = f.args.map(a => compile(a, scope, ctx));
    const alias = f.alias || null;
    const named = (names) => (f.colAliases || names).map(n => ({ name: n, table: alias }));
    if (f.name === 'range') {
      return { cols: named(['id']), node: mkNode('Function Scan', 'range'), run: env => { const v = args.map(a => a(env)); let [s, e, st] = v.length === 1 ? [0, v[0], 1] : [v[0], v[1], v[2] || 1]; const out = []; for (let i = s; st > 0 ? i < e : i > e; i += st) out.push([i]); return out; } };
    }
    if (GENERATORS.has(f.name)) {
      const gen = generator(f.name);
      const probe = { cols: generatorCols(gen, f.name, f.args[0], scope) };
      return { cols: named(probe.cols), node: mkNode('Function Scan', f.name), run: env => { const out = []; gen.expand(args[0](env), out, []); return out; }, dynamicCols: gen.dynamic };
    }
    throw new SqlError('UNRESOLVED_ROUTINE', `Cannot resolve table function ${bt(f.name)}. Supported here: range, explode, explode_outer, posexplode, inline.`);
  }
  function generator(name) {
    const outer = name.endsWith('_outer');
    const base = name.replace('_outer', '');
    return {
      cols: base === 'posexplode' ? ['pos', 'col'] : base === 'inline' ? [] : ['col'],
      dynamic: base === 'inline',
      expand(v, out, prefix) {
        if ((base === 'explode' || base === 'posexplode') && v instanceof Map) { if (!v.size && outer) out.push(prefix.concat(base === 'posexplode' ? [null, null, null] : [null, null])); let i = 0; v.forEach((x, k) => out.push(prefix.concat(base === 'posexplode' ? [i++, k, x] : [k, x]))); return; }
        const arr = v == null ? [] : Array.isArray(v) ? v : (() => { throw new SqlError('DATATYPE_MISMATCH.UNEXPECTED_INPUT_TYPE', `${name} expects an ARRAY or MAP, got ${typeOf(v)}.`); })();
        if (!arr.length) { if (outer) out.push(prefix.concat(base === 'posexplode' ? [null, null] : [null])); return; }
        arr.forEach((x, i) => {
          if (base === 'posexplode') out.push(prefix.concat([i, x]));
          else if (base === 'inline') out.push(prefix.concat(x == null ? [] : Object.values(x)));
          else out.push(prefix.concat([x]));
        });
      },
    };
  }
  function planJoin(j, ctx, outer) {
    // push single-table ON conditions into the right-hand scan (safe for inner, left, semi and anti joins)
    if (j.on && j.r.k === 'table' && ['inner', 'left', 'semi', 'anti'].includes(j.type)) {
      const bases = baseTables(j, ctx.db, ctx.ctes, false).map(b => Object.assign({}, b, { nullable: false }));
      const rb = bases.find(b => b.f === j.r);
      if (rb) {
        ctx.pushdown = ctx.pushdown || new Map();
        const list = ctx.pushdown.get(j.r) || [];
        const locals = fromAliases(j);
        conjuncts(j.on).forEach(c => { if (ownerOf(c, bases, locals) === rb) list.push(c); });
        ctx.pushdown.set(j.r, list);
      }
    }
    const L = planFrom(j.l, ctx, outer);
    const lscope = new Scope(L.cols, outer);
    const R = j.r.lateral || (j.r.k === 'tvf' && j.r.lateral) ? planFrom(j.r, ctx, lscope) : planFrom(j.r, ctx, outer);
    const lateral = !!(j.r.lateral);
    const type = j.type;
    let cols = type === 'semi' || type === 'anti' ? L.cols.slice() : L.cols.concat(R.cols);
    let using = j.using;
    if (j.natural) using = L.cols.filter(c => !c.hidden && R.cols.some(r => !r.hidden && lc(r.name) === lc(c.name))).map(c => c.name);
    const scope = new Scope(L.cols.concat(R.cols), outer);
    let cond = null, equi = null;
    if (using) {
      const pairs = using.map(u => {
        const li = L.cols.findIndex(c => !c.hidden && lc(c.name) === lc(u)), ri = R.cols.findIndex(c => !c.hidden && lc(c.name) === lc(u));
        if (li < 0 || ri < 0) throw new SqlError('UNRESOLVED_USING_COLUMN_FOR_JOIN', `USING column ${bt(u)} cannot be resolved on the ${li < 0 ? 'left' : 'right'} side of the join. The ${li < 0 ? 'left' : 'right'}-side columns: [${(li < 0 ? L : R).cols.map(c => bt(c.name)).join(', ')}].`);
        return [li, ri];
      });
      equi = pairs.map(([li, ri]) => Object.assign([env => env.row[li], env => env.row[ri]], { rci: ri }));
      equi.idx = pairs;
      cond = env => pairs.every(([li, ri]) => { const a = env.row[li], b = env.row[L.cols.length + ri]; return a != null && b != null && compare(a, b) === 0; });
    } else if (j.on) {
      cond = compile(j.on, scope, ctx);
      equi = extractEqui(j.on, L.cols.length, scope, ctx);
    }
    const nl = L.cols.length, nr = R.cols.length;
    const nullsL = new Array(nl).fill(null), nullsR = new Array(nr).fill(null);
    let outCols = cols;
    let project = null;
    if (using && type !== 'semi' && type !== 'anti') {
      const pairs = equi.idx;
      const merged = pairs.map(([li]) => ({ name: L.cols[li].name, table: null }));
      const hideL = new Set(pairs.map(p => p[0])), hideR = new Set(pairs.map(p => nl + p[1]));
      outCols = merged.concat(L.cols.map((c, i) => (hideL.has(i) ? Object.assign({}, c, { hidden: true, usingHidden: true }) : c)), R.cols.map((c, i) => (hideR.has(nl + i) ? Object.assign({}, c, { hidden: true, usingHidden: true }) : c)));
      project = row => pairs.map(([li, ri]) => (row[li] != null ? row[li] : row[nl + ri])).concat(row);
      // qualified access (o.id) must still work for hidden using columns
      outCols.forEach(c => { if (c.usingHidden) c.qualifiedOnly = true; });
    }
    const label = { inner: '', left: 'Left', right: 'Right', full: 'Full', semi: 'Semi', anti: 'Anti', cross: '' }[type];
    const node = mkNode('Hash Join', label ? `(${label.toLowerCase()})` : '');
    node.children.push(L.node || mkNode('?'), R.node || mkNode('?'));
    node.condLabel = 'Join Cond'; node.cond = using ? `USING (${using.join(', ')})` : j.on ? sqlOf(j.on) : null;
    const lookupCol = equi && equi.length && equi[0].rci != null ? equi[0].rci : null;
    return {
      cols: outCols.map(c => (c.qualifiedOnly ? Object.assign({}, c, { hidden: true }) : c)),
      node,
      get correlated() { return L.correlated || (!lateral && R.correlated); },
      run(env) {
        const m = meterOf(ctx);
        node.loops++;
        const lrows = L.run(env);
        const out = [];
        const emit = row => out.push(project ? project(row) : row);
        if (lateral) {
          node.op = 'Nested Loop'; node.detail = `(lateral${label ? ', ' + label.toLowerCase() : ''})`;
          for (const lr of lrows) {
            const rrows = R.run({ row: lr, parent: env });
            let any = false;
            for (const rr of rrows) { m.charge(node, COST.nlPair); const row = lr.concat(rr); if (!cond || truthy(cond({ row, parent: env }))) { any = true; if (type === 'semi') { emit(lr); break; } if (type !== 'anti') emit(row); } }
            if (!any && (type === 'left' || type === 'anti')) emit(type === 'anti' ? lr : lr.concat(nullsR));
          }
          node.rows += out.length;
          return out;
        }
        /* index nested loop: probe an index on the inner table for each outer row, when cheaper than hashing it */
        if (R.isBase && lookupCol != null && !['right', 'full', 'cross'].includes(type)) {
          const lk = R.lookupOn(lookupCol);
          if (lk) {
            const est = R.estimate(env);
            const perKey = lk.data.n / Math.max(1, lk.data.distinctLead);
            const inl = lrows.length * (COST.seek + Math.log2(lk.data.n + 2) + perKey * (COST.indexEntry + (lk.cov ? 0 : COST.heapFetch)));
            const hash = est.cost + est.rows * COST.hashBuild + lrows.length * COST.hashProbe;
            if (inl < hash) {
              node.op = 'Nested Loop'; node.detail = label ? `(${label.toLowerCase()})` : '';
              R.node.op = lk.cov ? 'Index Only Scan' : 'Index Scan'; R.node.index = lk.d.name; R.node.ordered = false;
              R.node.loops += lrows.length;
              for (const lr of lrows) {
                const key = equi[0][0]({ row: lr, parent: env });
                const cands = lk.fetch(key, env);
                let any = false;
                for (const rr of cands) {
                  const row = lr.concat(rr);
                  if (!cond || truthy(cond({ row, parent: env }))) { any = true; if (type === 'semi' || type === 'anti') break; emit(row); }
                }
                if (type === 'semi' && any) emit(lr);
                if (type === 'anti' && !any) emit(lr);
                if (!any && type === 'left') emit(lr.concat(nullsR));
              }
              node.rows += out.length;
              return out;
            }
          }
        }
        const rrows = R.run(env);
        node.op = equi && equi.length && type !== 'cross' ? 'Hash Join' : 'Nested Loop';
        node.detail = label ? `(${label.toLowerCase()})` : '';
        const rMatched = type === 'right' || type === 'full' ? new Array(rrows.length).fill(false) : null;
        let index = null;
        if (equi && equi.length && type !== 'cross') {
          index = new Map();
          m.charge(node, rrows.length * COST.hashBuild + lrows.length * COST.hashProbe);
          rrows.forEach((rr, ri) => {
            const k = equi.map(([, rf]) => rf({ row: rr, parent: env }));
            if (k.some(v => v == null)) return;
            const key = k.map(keyOf).join('\u0003');
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(ri);
          });
        }
        if (!index && !rMatched && type !== 'semi' && type !== 'anti') {
          const buf = new Array(nl + nr), cenv = { row: buf, parent: env };
          for (const lr of lrows) {
            for (let i = 0; i < nl; i++) buf[i] = lr[i];
            let any = false;
            for (let ri = 0; ri < rrows.length; ri++) {
              m.charge(node, COST.nlPair);
              const rr = rrows[ri];
              for (let i = 0; i < nr; i++) buf[nl + i] = rr[i];
              if (type === 'cross' || !cond || truthy(cond(cenv))) { any = true; emit(buf.slice()); }
            }
            if (!any && type === 'left') emit(lr.concat(nullsR));
          }
          node.rows += out.length;
          return out;
        }
        const buf = new Array(nl + nr), cenv = { row: buf, parent: env }, lenv = { row: null, parent: env };
        for (const lr of lrows) {
          let candidates = null;
          if (index) { lenv.row = lr; const k = equi.map(([lf]) => lf(lenv)); candidates = k.some(v => v == null) ? [] : index.get(k.map(keyOf).join('\u0003')) || []; }
          for (let i = 0; i < nl; i++) buf[i] = lr[i];
          let any = false;
          const total = candidates ? candidates.length : rrows.length;
          for (let c = 0; c < total; c++) {
            const ri = candidates ? candidates[c] : c;
            m.charge(node, index ? COST.match : COST.nlPair);
            const rr = rrows[ri];
            for (let i = 0; i < nr; i++) buf[nl + i] = rr[i];
            if (type === 'cross' || !cond || truthy(cond(cenv))) {
              any = true;
              if (rMatched) rMatched[ri] = true;
              if (type === 'semi' || type === 'anti') break;
              emit(buf.slice());
            }
          }
          if (type === 'semi' && any) emit(lr);
          if (type === 'anti' && !any) emit(lr);
          if (!any && (type === 'left' || type === 'full')) emit(lr.concat(nullsR));
        }
        if (rMatched) rrows.forEach((rr, i) => { if (!rMatched[i]) emit(nullsL.concat(rr)); });
        node.rows += out.length;
        return out;
      },
    };
  }
  /* Find `left.col = right.col` conjuncts so the join can use a hash index. */
  function extractEqui(on, nl, scope, ctx) {
    const conj = [];
    const split = e => { if (e.k === 'bin' && e.op === 'AND') { split(e.l); split(e.r); } else conj.push(e); };
    split(on);
    const out = [];
    for (const c of conj) {
      if (c.k !== 'bin' || c.op !== '=') continue;
      const side = e => { let s = null, ok = true; walk(e, n => { if (n.k === 'subq' || n.k === 'exists') { ok = false; return false; } if (n.k === 'col') { try { const r = scope.resolve(n.parts); if (!r || r.depth > 0) return; const sd = r.index < nl ? 'L' : 'R'; if (s && s !== sd) ok = false; s = sd; } catch (e2) { ok = false; } } }); return ok ? s : 'X'; };
      const a = side(c.l), b = side(c.r);
      if ((a === 'L' && b === 'R') || (a === 'R' && b === 'L')) {
        const [le, re] = a === 'L' ? [c.l, c.r] : [c.r, c.l];
        const lf = compile(le, scope, ctx), rfRaw = compile(re, scope, ctx);
        const pad = new Array(nl).fill(null);
        let rci = null;
        if (re.k === 'col') { try { const r = scope.resolve(re.parts); if (r && r.depth === 0 && !r.rest.length && r.index >= nl) rci = r.index - nl; } catch (e3) { rci = null; } }
        out.push(Object.assign([lf, env => rfRaw({ row: pad.concat(env.row), parent: env.parent })], { rci }));
      }
    }
    return out;
  }

  /* ---------- SELECT ---------- */
  function planSelect(q, ctx, outer) {
    const boundary = { correlated: false };
    const existsHint = ctx.limitOne; ctx.limitOne = false;
    ctx.subStack = ctx.subStack || [];
    ctx.subStack.push([]);
    /* predicate pushdown and access hints for base tables */
    const bases = q.from ? baseTables(q.from, ctx.db, ctx.ctes, false) : [];
    const whereConj = conjuncts(q.where);
    let unpushed = whereConj.length;
    ctx.pushdown = ctx.pushdown || new Map(); ctx.accessHints = ctx.accessHints || new Map();
    const pushedSet = new Set();
    const localSet = q.from ? fromAliases(q.from) : new Set();
    whereConj.forEach(c => { const o = ownerOf(c, bases, localSet); if (o && !o.nullable) { const l = ctx.pushdown.get(o.f) || []; l.push(c); ctx.pushdown.set(o.f, l); unpushed--; pushedSet.add(c); } });
    bases.forEach(b => ctx.accessHints.set(b.f, Object.assign({}, ctx.accessHints.get(b.f) || {}, { required: requiredColumns(q, b, bases) })));
    const simple = q.from && q.from.k === 'table' && bases.length === 1 && !(q.laterals || []).length && !q.groupBy && !q.groupAll && !q.distinct
      && !collectAggs(q.items.map(i => i.e).concat(q.having ? [q.having] : [], (q.orderBy || []).map(o => o.e))).length && !collectWindows(q.items.map(i => i.e).concat((q.orderBy || []).map(o => o.e))).length && !q.items.some(i => hasGenerator(i.e)) && !unpushed;
    let orderedCandidate = false;
    if (simple) {
      const lit = e => (e && e.k === 'lit' && typeof e.v === 'number' ? e.v : null);
      const limitN = lit(q.limit), offN = q.offset ? lit(q.offset) : 0;
      const h = ctx.accessHints.get(bases[0].f);
      if (existsHint && !q.orderBy) h.limitHint = 1;
      else if (limitN != null && offN != null) {
        h.limitHint = limitN + offN;
        if (q.orderBy) {
          const t = bases[0].t;
          const ord = q.orderBy.map(o => {
            if (o.e.k !== 'col') return null;
            const name = o.e.parts[o.e.parts.length - 1];
            if (o.e.parts.length > 1 && lc(o.e.parts[0]) !== bases[0].alias) return null;
            const ci = t.cols.findIndex(c => lc(c.name) === lc(name));
            if (ci < 0 || (o.nulls && o.nulls !== (o.desc ? 'last' : 'first'))) return null;
            return { col: ci, desc: !!o.desc };
          });
          if (ord.every(Boolean) && !q.items.some(it => it.alias && !Array.isArray(it.alias) && q.orderBy.some(o => o.e.k === 'col' && o.e.parts.length === 1 && lc(o.e.parts[0]) === lc(it.alias) && !(it.e.k === 'col' && lc(it.e.parts[it.e.parts.length - 1]) === lc(it.alias))))) { h.order = ord; orderedCandidate = true; }
          else delete h.limitHint;
        }
      }
    }
    let from = q.from ? planFrom(q.from, ctx, outer) : { cols: [], node: mkNode('Result'), run: () => [[]] };
    // LATERAL VIEW explode(...)
    for (const lv of q.laterals || []) {
      const base = from;
      const scope = new Scope(base.cols, outer);
      if (lv.fn.k !== 'fn' || !GENERATORS.has(lv.fn.name)) throw new SqlError('UNSUPPORTED_GENERATOR', 'LATERAL VIEW needs a generator function such as explode, posexplode or inline.');
      const gen = generator(lv.outer && !lv.fn.name.endsWith('_outer') ? lv.fn.name + '_outer' : lv.fn.name);
      const arg = compile(lv.fn.args[0], scope, ctx);
      const names = lv.cols.length ? lv.cols : generatorCols(gen, lv.fn.name, lv.fn.args[0], scope);
      const gnode = mkNode('Generate', sqlOf(lv.fn)); gnode.children.push(base.node || mkNode('?'));
      from = { cols: base.cols.concat(names.map(n => ({ name: n, table: lv.alias }))), node: gnode, run: env => { const out = []; for (const r of base.run(env)) gen.expand(arg({ row: r, parent: env }), out, r); gnode.loops++; gnode.rows += out.length; return out; }, get correlated() { return base.correlated; } };
    }
    const S0 = new Scope(from.cols, outer, boundary);
    const where = q.where ? compile(q.where, S0, ctx, { noAgg: 'WHERE' }) : null;
    if (q.where) checkNoWindow(q.where, 'WHERE');

    // expand stars against the FROM scope
    const items = [];
    for (const it of q.items) {
      if (it.e.k === 'star') {
        const tbl = it.e.table;
        if (tbl && !from.cols.some(c => lc(c.table || '') === lc(tbl))) throw new SqlError('CANNOT_RESOLVE_STAR_EXPAND', `Cannot resolve ${bt(tbl)}.* given input columns ${from.cols.filter(c => !c.hidden).map(c => bt(c.name)).join(', ')}.`);
        if (!q.from) throw new SqlError('INVALID_USAGE_OF_STAR_OR_REGEX', 'Invalid usage of `*` in a query without FROM.');
        const except = (it.e.except || []).map(lc);
        except.forEach(x => { if (!from.cols.some(c => lc(c.name) === x)) throw new SqlError('UNRESOLVED_COLUMN.WITH_SUGGESTION', `A column with name ${bt(x)} in SELECT * EXCEPT cannot be resolved. Did you mean one of the following? [${suggest(x, from.cols.map(c => c.name)).map(bt).join(', ')}].`); });
        from.cols.forEach((c, i) => {
          if (tbl ? lc(c.table || '') !== lc(tbl) || (c.hidden && !c.qualifiedOnly) : c.hidden) return;
          if (except.includes(lc(c.name))) return;
          items.push({ e: { k: 'colref', index: i, name: c.name }, alias: c.name, star: true });
        });
      } else items.push(it);
    }
    const resolveGroupRef = e => {
      if (e.k === 'lit' && typeof e.v === 'number' && Number.isInteger(e.v)) {
        const it = items[e.v - 1];
        if (!it) throw new SqlError('GROUP_BY_POS_OUT_OF_RANGE', `GROUP BY position ${e.v} is not in select list (valid range is [1, ${items.length}]).`);
        return it.e;
      }
      if (e.k === 'col' && e.parts.length === 1) {
        let inFrom = false; try { inFrom = !!S0.resolveLocal(e.parts); } catch (x) { inFrom = true; }
        if (!inFrom) { const it = items.find(x => x.alias && !Array.isArray(x.alias) && lc(x.alias) === lc(e.parts[0])); if (it) return it.e; }
      }
      return e;
    };
    const postGroupNodes = items.map(i => i.e).concat(q.having ? [q.having] : [], q.qualify ? [q.qualify] : [], (q.orderBy || []).map(o => o.e));
    const aggs = collectAggs(postGroupNodes);
    const grouped = !!(q.groupBy || q.groupAll || aggs.length);
    let groupExprs = [];
    if (q.groupAll) groupExprs = items.filter(i => !collectAggs([i.e]).length && !collectWindows([i.e]).length && !(i.e.k === 'lit')).map(i => i.e);
    else if (q.groupBy) groupExprs = q.groupBy.map(resolveGroupRef);
    groupExprs.forEach(e => { if (collectAggs([e]).length) throw new SqlError('GROUP_BY_AGGREGATE', `Aggregate functions are not allowed in GROUP BY, but found ${exprName(collectAggs([e])[0])}.`); });

    let S1 = S0, groupRun = null;
    if (grouped) {
      const keyFps = groupExprs.map(e => fingerprint(e, S0));
      const keyFns = groupExprs.map(e => compile(e, S0, ctx));
      const aggList = [];
      const aggFps = [];
      aggs.forEach(a => { const fp = fingerprint(a, S0); if (!aggFps.includes(fp)) { aggFps.push(fp); aggList.push(a); } });
      const aggImpl = aggList.map(a => compileAgg(a, S0, ctx));
      const sets = q.groupingSets ? q.groupingSets.map(set => set.map(e => fingerprint(resolveGroupRef(e), S0))) : null;
      const nk = groupExprs.length;
      const cols = groupExprs.map((e, i) => ({ name: exprName(e), table: null, keyIndex: i })).concat(aggList.map(a => ({ name: exprName(a) })), [{ name: '__grouping_id', hidden: true }]);
      S1 = new Scope(cols, outer, boundary);
      S1.group = { keyFps, aggFps, S0, nk };
      S1.resolver = parts => {
        let r;
        try { r = S0.resolveLocal(parts); } catch (e) { throw e; }
        if (!r) return null;
        const fp = `#c0:${r.index}:`;
        const ki = keyFps.indexOf(fingerprint({ k: 'col', parts: parts.slice(0, parts.length - r.rest.length) }, S0));
        if (ki >= 0) return { index: ki, rest: r.rest };
        const kExact = keyFps.indexOf(fingerprint({ k: 'col', parts }, S0));
        if (kExact >= 0) return { index: kExact, rest: [] };
        void fp;
        throw new SqlError('MISSING_AGGREGATION', `The non-aggregating expression ${bt(parts.join('.'))} is based on columns which are not participating in the GROUP BY clause. Add the columns or the expression to the GROUP BY, aggregate the expression, or use \`any_value(${parts.join('.')})\` if you do not care which of the values within a group is returned.`);
      };
      groupRun = rows => {
        const out = [];
        const doSet = (setFps, gid) => {
          const groups = new Map();
          const active = setFps ? keyFps.map(fp => setFps.includes(fp)) : keyFps.map(() => true);
          for (const env of rows) {
            const keys = keyFns.map((f, i) => (active[i] ? f(env) : null));
            const k = keys.map(keyOf).join('\u0003');
            let g = groups.get(k);
            if (!g) { g = { keys, envs: [] }; groups.set(k, g); }
            g.envs.push(env);
          }
          if (!groups.size && !nk) groups.set('', { keys: [], envs: [] });
          for (const g of groups.values()) out.push(g.keys.concat(aggImpl.map(a => a(g.envs)), [gid]));
        };
        if (sets) sets.forEach((s, i) => doSet(s, keyFps.reduce((m, fp, j) => m | (s.includes(fp) ? 0 : 1 << (nk - 1 - j)), 0)));
        else doSet(null, 0);
        return out;
      };
    }
    const aliasMap = new Map();
    items.forEach(it => { if (it.alias && !Array.isArray(it.alias) && !it.star && !hasGenerator(it.e)) aliasMap.set(lc(it.alias), it.e); });
    const having = q.having ? compile(q.having, S1, ctx, { aliases: aliasMap }) : null;

    // window functions
    const winNodes = collectWindows(items.map(i => i.e).concat(q.qualify ? [q.qualify] : [], (q.orderBy || []).map(o => o.e)));
    let S2 = S1, windowRun = null;
    if (winNodes.length) {
      const fps = [], uniqNodes = [];
      winNodes.forEach(w => { const fp = fingerprint(w, S1); if (!fps.includes(fp)) { fps.push(fp); uniqNodes.push(w); } });
      const impl = uniqNodes.map(w => compileWindow(w, S1, ctx, q.windows || {}));
      S2 = new Scope(S1.cols.concat(uniqNodes.map(w => ({ name: exprName(w) }))), outer, boundary);
      S2.resolver = S1.resolver ? parts => S1.resolver(parts) : null;
      if (!S2.resolver) S2.resolver = parts => S1.resolveLocal(parts);
      S2.windowFps = { fps, base: S1.cols.length, S1 };
      if (S1.group) S2.group = S1.group;
      windowRun = envs => {
        const cols = impl.map(f => f(envs));
        return envs.map((env, i) => ({ row: env.row.concat(cols.map(c => c[i])), parent: env.parent }));
      };
    }
    const qualify = q.qualify ? compile(q.qualify, S2, ctx, { aliases: aliasMap }) : null;

    // projection
    const genIdx = items.findIndex(i => hasGenerator(i.e));
    if (items.filter(i => hasGenerator(i.e)).length > 1) throw new SqlError('UNSUPPORTED_GENERATOR.MULTI_GENERATOR', 'Only one generator is allowed per SELECT clause. Use LATERAL VIEW for the others.');
    const outCols = [];
    const proj = items.map((it, idx) => {
      if (idx === genIdx) {
        const g = generator(it.e.name);
        const arg = compile(it.e.args[0], S2, ctx);
        const names = Array.isArray(it.alias) ? it.alias : it.alias ? [it.alias] : generatorCols(g, it.e.name, it.e.args[0], S2);
        names.forEach(n => outCols.push({ name: n }));
        return { gen: g, arg, width: names.length };
      }
      const earlier = new Map(); items.slice(0, idx).forEach(x => { if (x.alias && !Array.isArray(x.alias) && !x.star && !hasGenerator(x.e)) earlier.set(lc(x.alias), x.e); });
      const f = it.e.k === 'colref' ? (S2 === S0 ? env => env.row[it.e.index] : compile({ k: 'col', parts: [from.cols[it.e.index].table, from.cols[it.e.index].name].filter(Boolean) }, S2, ctx)) : compile(it.e, S2, ctx, { aliases: earlier });
      outCols.push({ name: Array.isArray(it.alias) ? it.alias[0] : it.alias || exprName(it.e) });
      return { f };
    });
    const outScope = new Scope(outCols.map(c => ({ name: c.name, table: null })), outer);
    const order = q.orderBy ? q.orderBy.map(o => orderTerm(o, S2, ctx, outCols, items, q.distinct)) : null;
    const lim = limits(q, ctx);
    void outScope;

    /* plan nodes, top-down */
    let top = from.node || mkNode('Result');
    const unpushedConj = whereConj.filter(c => !pushedSet.has(c));
    const fnode = unpushedConj.length ? Object.assign(mkNode('Filter'), { filter: unpushedConj.map(sqlOf).join(' AND '), children: [top] }) : null; if (fnode) top = fnode;
    const anode = groupRun ? Object.assign(mkNode(groupExprs.length ? 'HashAggregate' : 'Aggregate'), { groupKey: groupExprs.map(sqlOf).join(', ') || null, children: [top] }) : null; if (anode) top = anode;
    const hnode = having ? Object.assign(mkNode('Filter'), { filter: sqlOf(q.having), children: [top] }) : null; if (hnode) top = hnode;
    const wnode = windowRun ? Object.assign(mkNode('WindowAgg', `${winNodes.length} window function${winNodes.length > 1 ? 's' : ''}`), { children: [top] }) : null; if (wnode) top = wnode;
    const dnode = q.distinct ? Object.assign(mkNode('Unique'), { children: [top] }) : null; if (dnode) top = dnode;
    const snode = order ? Object.assign(mkNode('Sort'), { sortKey: q.orderBy.map(o => sqlOf(o.e) + (o.desc ? ' DESC' : '')).join(', '), children: [top] }) : null; if (snode) top = snode;
    const lnode = q.limit != null || q.offset != null ? Object.assign(mkNode('Limit', `${q.limit ? sqlOf(q.limit) : 'ALL'}${q.offset ? ' OFFSET ' + sqlOf(q.offset) : ''}`), { children: [top] }) : null; if (lnode) top = lnode;
    top.subplans = ctx.subStack.pop();
    const sortCost = n => n * COST.sortRow + n * Math.log2(n + 1) * COST.sortLog;

    return {
      cols: outCols,
      node: top,
      get correlated() { return boundary.correlated || !!from.correlated; },
      run(outerEnv) {
        const m = meterOf(ctx);
        const fromRows = from.run(outerEnv);
        const indexOrdered = orderedCandidate && fromRows.orderedBy;
        let envs = fromRows.map(row => ({ row, parent: outerEnv }));
        if (where) envs = envs.filter(e => truthy(where(e)));
        if (fnode) { fnode.loops++; fnode.rows += envs.length; }
        if (groupRun) { m.charge(anode, envs.length * COST.aggRow); envs = groupRun(envs).map(row => ({ row, parent: outerEnv })); anode.loops++; anode.rows += envs.length; }
        if (having) { envs = envs.filter(e => truthy(having(e))); hnode.loops++; hnode.rows += envs.length; }
        if (windowRun) { m.charge(wnode, winNodes.length * (envs.length * COST.windowRow + sortCost(envs.length))); envs = windowRun(envs); wnode.loops++; wnode.rows += envs.length; }
        if (qualify) envs = envs.filter(e => truthy(qualify(e)));
        let rows = [];
        for (const env of envs) {
          if (genIdx < 0) { rows.push({ out: proj.map(p => p.f(env)), env }); continue; }
          const pre = proj.slice(0, genIdx).map(p => p.f(env)), post = proj.slice(genIdx + 1).map(p => p.f(env));
          const tmp = [];
          proj[genIdx].gen.expand(proj[genIdx].arg(env), tmp, []);
          tmp.forEach(g => rows.push({ out: pre.concat(g.slice(0, proj[genIdx].width), post), env }));
        }
        if (q.distinct) { m.charge(dnode, rows.length * COST.distinctRow); const seen = new Set(); rows = rows.filter(r => { const k = keyOf(r.out); if (seen.has(k)) return false; seen.add(k); return true; }); dnode.loops++; dnode.rows += rows.length; }
        if (order) {
          snode.loops++;
          if (indexOrdered) { snode.op = 'Sort (skipped: rows arrive in index order)'; }
          else { snode.op = 'Sort'; m.charge(snode, sortCost(rows.length)); rows = sortRows(rows, order); }
          snode.rows += rows.length;
        }
        const out = lim(rows.map(r => r.out));
        if (lnode) { lnode.loops++; lnode.rows += out.length; }
        m.charge(null, out.length * COST.outRow);
        if (!lnode && !snode && !dnode && !wnode && !hnode && !anode && !fnode) { /* top is the FROM node */ }
        return out;
      },
    };
  }
  function checkNoWindow(node, where) { if (collectWindows([node]).length) throw new SqlError('UNSUPPORTED_EXPR_FOR_WINDOW', `Window functions are not allowed in ${where}. Compute them in a subquery or CTE, or filter them with QUALIFY.`); }
  function limits(q, ctx) {
    const scope = new Scope([], null);
    const l = q.limit != null ? compile(q.limit, scope, ctx)({}) : null;
    const o = q.offset != null ? compile(q.offset, scope, ctx)({}) : 0;
    if (l != null && (typeof l !== 'number' || l < 0)) throw new SqlError('INVALID_LIMIT_LIKE_EXPRESSION.IS_NEGATIVE', 'The limit expression must be equal to or greater than 0.');
    return rows => (o || l != null ? rows.slice(o || 0, l == null ? undefined : (o || 0) + l) : rows);
  }
  /* ORDER BY: output ordinals and aliases first, then any expression over the source. */
  function orderTerm(o, scope, ctx, outCols, items, distinct) {
    let f;
    if (o.e.k === 'lit' && typeof o.e.v === 'number' && Number.isInteger(o.e.v)) {
      const i = o.e.v - 1;
      if (i < 0 || i >= outCols.length) throw new SqlError('ORDER_BY_POS_OUT_OF_RANGE', `ORDER BY position ${o.e.v} is not in select list (valid range is [1, ${outCols.length}]).`);
      f = (env, out) => out[i];
    } else if (o.e.k === 'col' && o.e.parts.length === 1 && outCols.some(c => lc(c.name) === lc(o.e.parts[0]))) {
      const matches = outCols.map((c, i) => [c, i]).filter(([c]) => lc(c.name) === lc(o.e.parts[0]));
      const i = matches[0][1];
      f = (env, out) => out[i];
    } else {
      if (distinct) {
        const fp = items ? fingerprint(o.e, scope) : null;
        const i = items ? items.findIndex(it => fingerprint(it.e, scope) === fp) : -1;
        if (i >= 0) f = (env, out) => out[i];
        else f = compileWithAliases(o.e, scope, ctx, outCols);
      } else f = compileWithAliases(o.e, scope, ctx, outCols);
    }
    return { f, desc: o.desc, nulls: o.nulls || (o.desc ? 'last' : 'first') };
  }
  function compileWithAliases(e, scope, ctx, outCols) {
    const s = new Scope(scope.cols, scope.parent);
    Object.assign(s, { resolver: scope.resolver, group: scope.group, windowFps: scope.windowFps });
    const g = compile(e, s, ctx, { outCols });
    return (env, out) => g(Object.assign({}, env, { out }));
  }
  function sortRows(rows, order) {
    const decorated = rows.map((r, idx) => ({ r, idx, keys: order.map(o => o.f(r.env || { row: r.out }, r.out)) }));
    decorated.sort((a, b) => {
      for (let i = 0; i < order.length; i++) {
        const x = a.keys[i], y = b.keys[i], o = order[i];
        if (x == null || y == null) { if (x == null && y == null) continue; return (x == null) === (o.nulls === 'first') ? -1 : 1; }
        const c = compare(x, y);
        if (c) return o.desc ? -c : c;
      }
      return a.idx - b.idx;
    });
    return decorated.map(d => d.r);
  }

  /* ---------- aggregates ---------- */
  function compileAgg(a, S0, ctx) {
    const name = a.name;
    if (name === 'count' && a.star) {
      const filt = a.filter ? compile(a.filter, S0, ctx) : null;
      return envs => (filt ? envs.filter(e => truthy(filt(e))).length : envs.length);
    }
    if (!AGG[name]) throw new SqlError('UNRESOLVED_ROUTINE', `Cannot resolve aggregate ${bt(name)}.`);
    a.args.forEach(arg => { if (collectAggs([arg]).length) throw new SqlError('NESTED_AGGREGATE_FUNCTION', 'It is not allowed to use an aggregate function in the argument of another aggregate function. Use the inner aggregate in a subquery.'); });
    let args = a.args;
    if ((name === 'percentile_cont' || name === 'percentile_disc') && a.withinGroup) args = [a.args[0], a.withinGroup[0].e];
    const argFns = args.map(x => compile(x, S0, ctx));
    const filt = a.filter ? compile(a.filter, S0, ctx) : null;
    const orderFns = a.withinGroup ? a.withinGroup.map(o => ({ f: compile(o.e, S0, ctx), desc: o.desc, nulls: o.nulls || (o.desc ? 'last' : 'first') })) : null;
    const impl = AGG[name];
    const argc = { count: [1, 9], sum: [1, 1], avg: [1, 1], min: [1, 1], max: [1, 1], max_by: [2, 2], min_by: [2, 2], count_if: [1, 1], percentile: [2, 3], percentile_approx: [2, 3], string_agg: [1, 2], listagg: [1, 2] }[name];
    if (argc && (args.length < argc[0] || args.length > argc[1])) throw new SqlError('WRONG_NUM_ARGS.WITHOUT_SUGGESTION', `The \`${name}\` requires ${argc[0] === argc[1] ? argc[0] : `${argc[0]} to ${argc[1]}`} parameters but the actual number is ${args.length}.`);
    return envs => {
      let es = filt ? envs.filter(e => truthy(filt(e))) : envs;
      if (orderFns) es = sortRows(es.map(e => ({ env: e, out: null })), orderFns.map(o => ({ f: env => o.f(env), desc: o.desc, nulls: o.nulls }))).map(x => x.env);
      let tuples = es.map(e => argFns.map(f => f(e)));
      if (a.distinct) { const seen = new Set(); tuples = tuples.filter(t => { if (t.some(v => v == null)) return false; const k = keyOf(t); if (seen.has(k)) return false; seen.add(k); return true; }); }
      return impl(tuples, false, a.ignoreNulls);
    };
  }

  /* ---------- window functions ---------- */
  function compileWindow(w, S, ctx, named) {
    let spec = w.over.ref && !w.over.partition ? named[w.over.ref] : w.over;
    if (w.over.ref && w.over.partition) { const base = named[w.over.ref]; spec = Object.assign({}, base, { order: w.over.order.length ? w.over.order : base.order, frame: w.over.frame || base.frame }); }
    if (!spec) throw new SqlError('MISSING_WINDOW_SPECIFICATION', `Window specification ${bt(w.over.ref)} is not defined in the WINDOW clause.`);
    const name = w.name;
    if (!WINDOW_ONLY.has(name) && !AGG[name] && name !== 'count') throw new SqlError('UNSUPPORTED_EXPR_FOR_WINDOW', `Expression ${bt(name)} not supported within a window function.`);
    if (['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead'].includes(name) && !spec.order.length) throw new SqlError('MISSING_ORDER_BY_FOR_WINDOW', `Window function ${bt(name)} requires the window to be ordered. Add ORDER BY to the OVER clause, for example ${name}() OVER (PARTITION BY … ORDER BY …).`);
    const part = spec.partition.map(e => compile(e, S, ctx));
    const ord = spec.order.map(o => ({ f: compile(o.e, S, ctx), desc: o.desc, nulls: o.nulls || (o.desc ? 'last' : 'first') }));
    const args = (w.args || []).map(a => compile(a, S, ctx));
    const filt = w.filter ? compile(w.filter, S, ctx) : null;
    const frame = spec.frame || (spec.order.length ? { unit: 'RANGE', start: { t: 'up' }, end: { t: 'cur' } } : { unit: 'ROWS', start: { t: 'up' }, end: { t: 'uf' } });
    const constant = node => compile(node, new Scope([], null), ctx)({});
    const fs = frame.start.n ? constant(frame.start.n) : 0, fe = frame.end.n ? constant(frame.end.n) : 0;
    return envs => {
      const out = new Array(envs.length);
      const parts = new Map();
      envs.forEach((e, i) => { const k = part.map(f => keyOf(f(e))).join('\u0003'); if (!parts.has(k)) parts.set(k, []); parts.get(k).push(i); });
      for (const idxs of parts.values()) {
        const keys = idxs.map(i => ord.map(o => o.f(envs[i])));
        const order = idxs.map((_, j) => j).sort((a, b) => {
          for (let t = 0; t < ord.length; t++) {
            const x = keys[a][t], y = keys[b][t], o = ord[t];
            if (x == null || y == null) { if (x == null && y == null) continue; return (x == null) === (o.nulls === 'first') ? -1 : 1; }
            const c = compare(x, y); if (c) return o.desc ? -c : c;
          }
          return a - b;
        });
        const rowsI = order.map(j => idxs[j]);
        const k = order.map(j => keys[j]);
        const n = rowsI.length;
        const peerEq = (a, b) => ord.every((_, t) => { const x = k[a][t], y = k[b][t]; return (x == null && y == null) || (x != null && y != null && compare(x, y) === 0); });
        const peerStart = new Array(n), peerEnd = new Array(n);
        for (let i = 0; i < n; i++) peerStart[i] = i > 0 && peerEq(i, i - 1) ? peerStart[i - 1] : i;
        for (let i = n - 1; i >= 0; i--) peerEnd[i] = i < n - 1 && peerEq(i, i + 1) ? peerEnd[i + 1] : i;
        const val = (pos, a) => args[a](envs[rowsI[pos]]);
        const bounds = i => {
          let s, e;
          if (frame.unit === 'ROWS') {
            s = frame.start.t === 'up' ? 0 : frame.start.t === 'cur' ? i : frame.start.t === 'p' ? i - fs : frame.start.t === 'f' ? i + fs : n;
            e = frame.end.t === 'uf' ? n - 1 : frame.end.t === 'cur' ? i : frame.end.t === 'p' ? i - fe : frame.end.t === 'f' ? i + fe : -1;
          } else {
            if ((frame.start.t === 'p' || frame.start.t === 'f' || frame.end.t === 'p' || frame.end.t === 'f')) {
              const cur = k[i][0];
              const sgn = ord[0] && ord[0].desc ? -1 : 1;
              const within = (j, lo, hi) => { const v = k[j][0]; if (v == null || cur == null) return false; const d = (typeof v === 'number' ? v - cur : X.num(v) - X.num(cur)) * sgn; return d >= lo && d <= hi; };
              const lo = frame.start.t === 'up' ? -Infinity : frame.start.t === 'cur' ? 0 : frame.start.t === 'p' ? -fs : fs;
              const hi = frame.end.t === 'uf' ? Infinity : frame.end.t === 'cur' ? 0 : frame.end.t === 'p' ? -fe : fe;
              s = n; e = -1;
              for (let j = 0; j < n; j++) if (within(j, lo, hi)) { if (j < s) s = j; e = j; }
              if (s > e) { s = 1; e = 0; }
            } else {
              s = frame.start.t === 'up' ? 0 : peerStart[i];
              e = frame.end.t === 'uf' ? n - 1 : peerEnd[i];
            }
          }
          return [Math.max(0, s), Math.min(n - 1, e)];
        };
        let rank = 0, dense = 0;
        for (let i = 0; i < n; i++) {
          let v;
          switch (name) {
            case 'row_number': v = i + 1; break;
            case 'rank': if (peerStart[i] === i) rank = i + 1; v = rank; break;
            case 'dense_rank': if (peerStart[i] === i) dense++; v = dense; break;
            case 'percent_rank': v = n === 1 ? 0 : peerStart[i] / (n - 1); break;
            case 'cume_dist': v = (peerEnd[i] + 1) / n; break;
            case 'ntile': { const b = args[0](envs[rowsI[i]]); const size = Math.floor(n / b), rem = n % b; let acc = 0, t = 1; for (; t <= b; t++) { acc += size + (t <= rem ? 1 : 0); if (i < acc) break; } v = t; break; }
            case 'lag': case 'lead': {
              const off = args[1] ? args[1](envs[rowsI[i]]) : 1;
              const j = name === 'lag' ? i - off : i + off;
              v = j >= 0 && j < n ? val(j, 0) : args[2] ? args[2](envs[rowsI[i]]) : null;
              if (w.ignoreNulls && j >= 0 && j < n) { let jj = i; let c = 0; v = args[2] ? args[2](envs[rowsI[i]]) : null; while (true) { jj += name === 'lag' ? -1 : 1; if (jj < 0 || jj >= n) break; const x = val(jj, 0); if (x != null && ++c === off) { v = x; break; } } }
              break;
            }
            case 'nth_value': { const [s, e] = bounds(i); const nth = args[1](envs[rowsI[i]]); let c = 0; v = null; for (let j = s; j <= e; j++) { const x = val(j, 0); if (w.ignoreNulls && x == null) continue; if (++c === nth) { v = x; break; } } break; }
            default: {
              const [s, e] = bounds(i);
              const tuples = [];
              for (let j = s; j <= e; j++) { const env = envs[rowsI[j]]; if (filt && !truthy(filt(env))) continue; tuples.push(w.star ? [] : args.map(a => a(env))); }
              let t = tuples;
              if (w.distinct) { const seen = new Set(); t = tuples.filter(x => { if (x.some(y => y == null)) return false; const kk = keyOf(x); if (seen.has(kk)) return false; seen.add(kk); return true; }); }
              const impl = name === 'count' ? AGG.count : AGG[name];
              v = impl(t, !!w.star, !!w.ignoreNulls);
            }
          }
          out[rowsI[i]] = v;
        }
      }
      return out;
    };
  }

  /* ================= expressions ================= */
  function compile(node, scope, ctx, opts) {
    opts = opts || {};
    // In grouped or windowed scopes, whole expressions can match a group key, an aggregate or a window result.
    if (scope.windowFps && node.k === 'fn' && node.over) {
      const fp = fingerprint(node, scope.windowFps.S1);
      const i = scope.windowFps.fps.indexOf(fp);
      if (i >= 0) { const idx = scope.windowFps.base + i; return env => env.row[idx]; }
    }
    if (scope.group && node.k !== 'lit') {
      const fp = fingerprint(node, scope.group.S0);
      const ki = scope.group.keyFps.indexOf(fp);
      if (ki >= 0) return env => env.row[ki];
      const ai = scope.group.aggFps.indexOf(fp);
      if (ai >= 0) { const idx = scope.group.nk + ai; return env => env.row[idx]; }
    }
    if (opts.noAgg && isAggCall(node)) throw new SqlError('INVALID_WHERE_CONDITION', `The ${opts.noAgg} condition ${bt(exprName(node))} contains an aggregate function. Use HAVING to filter on aggregates, or QUALIFY for window functions.`);
    const c = n => compile(n, scope, ctx, opts);
    switch (node.k) {
      case 'lit': { const v = node.v; return () => v; }
      case 'colref': { const i = node.index; return env => env.row[i]; }
      case 'col': {
        if (opts.outCols && node.parts.length === 1) {
          let local = null; try { local = scope.resolve(node.parts); } catch (e) { local = null; }
          if (!local) { const i = opts.outCols.findIndex(oc => lc(oc.name) === lc(node.parts[0])); if (i >= 0) return env => env.out[i]; }
        }
        if (opts.lambda) { const li = opts.lambda.findIndex(p => lc(p) === lc(node.parts[0])); if (li >= 0) { const rest = node.parts.slice(1); return env => fieldPath(env.lambda[li], rest); } }
        let r;
        try { r = scope.resolve(node.parts); }
        catch (err) { if (err.cls === 'MISSING_AGGREGATION' && opts.aliases && node.parts.length === 1 && opts.aliases.has(lc(node.parts[0]))) r = null; else throw err; }
        if (!r && opts.aliases && node.parts.length === 1 && opts.aliases.has(lc(node.parts[0]))) {
          const target = opts.aliases.get(lc(node.parts[0]));
          const rest = new Map(opts.aliases); rest.delete(lc(node.parts[0]));
          return compile(target, scope, ctx, Object.assign({}, opts, { aliases: rest }));
        }
        if (!r) {
          if (node.parts.length === 1 && /^(current_date|current_timestamp|current_user|now)$/i.test(node.parts[0])) { const f = SCALAR[lc(node.parts[0])] || (() => 'lab_user'); return () => f(); }
          throw unresolved(node.parts, scope);
        }
        const { depth, index, rest } = r;
        if (!rest.length) return depth === 0 ? env => env.row[index] : env => fetch(env, depth, index);
        return env => fieldPath(fetch(env, depth, index), rest);
      }
      case 'field': { const e = c(node.e), name = node.name; return env => fieldPath(e(env), [name]); }
      case 'index': {
        const e = c(node.e), i = c(node.idx);
        return env => { const a = e(env), k = i(env); if (a == null || k == null) return null; if (a instanceof Map) { for (const [kk, v] of a) if (compare(kk, k) === 0) return v; return null; } if (X.isStruct(a)) return a[k] === undefined ? null : a[k]; if (!Array.isArray(a)) throw new SqlError('DATATYPE_MISMATCH.UNEXPECTED_INPUT_TYPE', `Cannot index into ${typeOf(a)}.`); if (k < 0 || k >= a.length) throw new SqlError('INVALID_ARRAY_INDEX', `The index ${k} is out of bounds. The array has ${a.length} elements. Use the SQL function \`get()\` to tolerate accessing element at invalid index and return NULL instead.`); return a[k]; };
      }
      case 'un': {
        const e = c(node.e);
        if (node.op === 'NOT') return env => { const v = e(env); return v == null ? null : !truthy(v); };
        if (node.op === '-') return env => { const v = e(env); return v == null ? null : v instanceof Interval ? new Interval(-v.months, -v.days, -v.ms) : -X.num(v); };
        return env => { const v = e(env); return v == null ? null : ~v; };
      }
      case 'bin': return compileBin(node, c);
      case 'isnull': { const e = c(node.e), not = node.not; return env => (e(env) == null) !== not; }
      case 'istrue': { const e = c(node.e); return env => (e(env) === node.v) !== node.not; }
      case 'distinctfrom': { const l = c(node.l), r = c(node.r), not = node.not; return env => { const a = l(env), b = r(env); const same = (a == null && b == null) || (a != null && b != null && compare(a, b) === 0); return not ? same : !same; }; }
      case 'between': { const e = c(node.e), lo = c(node.lo), hi = c(node.hi), not = node.not; return env => { const v = e(env), a = lo(env), b = hi(env); if (v == null || a == null || b == null) return null; const r = compare(v, a) >= 0 && compare(v, b) <= 0; return not ? !r : r; }; }
      case 'like': {
        const e = c(node.e), not = node.not;
        const test = (v, p) => (node.op === 'RLIKE' ? javaRe(p).test(v) : likeRe(p, node.op === 'ILIKE', node.escape).test(v));
        if (node.pats) { const pats = node.pats.map(c); return env => { const v = e(env); if (v == null) return null; const res = pats.map(p => { const pv = p(env); return pv == null ? null : test(X.toStr(v), pv); }); const r = node.quant === 'ALL' ? (res.includes(false) ? false : res.includes(null) ? null : true) : (res.includes(true) ? true : res.includes(null) ? null : false); return r == null ? null : not ? !r : r; }; }
        const p = c(node.pat);
        return env => { const v = e(env), pv = p(env); if (v == null || pv == null) return null; const r = test(X.toStr(v), pv); return not ? !r : r; };
      }
      case 'in': {
        const e = c(node.e), not = node.not;
        const decide = (v, list) => { if (v == null) return null; let sawNull = false; for (const x of list) { if (x == null) { sawNull = true; continue; } if (compare(v, x) === 0) return !not; } return sawNull ? null : not; };
        /* an uncorrelated IN subquery is computed once and probed like a hash set */
        const decideFast = (v, list, set) => { if (v == null) return list.length ? null : not; if (typeof v !== 'object' && set.has(keyOf(v))) return !not; if (typeof v === 'object') return decide(v, list); return set.hasNull ? null : not; };
        if (node.list) { const list = node.list.map(c); return env => decide(e(env), list.map(f => f(env))); }
        const sub = planSub(node.q, scope, ctx);
        if (sub.cols.filter(x => !x.hidden).length !== 1) throw new SqlError('DATATYPE_MISMATCH.INVALID_IN_SUBQUERY', `The number of columns in the IN subquery (${sub.cols.length}) does not match the left side (1).`);
        let cache = null;
        let inSet = null;
        return env => {
          if (!sub.correlated && cache) return decideFast(e(env), cache, inSet);
          meterOf(ctx).charge(sub.node, COST.subplanRun);
          const vals = sub.run(env).map(r => r[0]);
          if (!sub.correlated) { cache = vals; inSet = new Map(); vals.forEach(v => { if (v != null) inSet.set(keyOf(v), true); }); inSet.hasNull = vals.some(v => v == null); return decideFast(e(env), cache, inSet); }
          return decide(e(env), vals);
        };
      }
      case 'exists': {
        const dec = decorrelateExists(node.q, scope, ctx);
        if (dec) return dec;
        ctx.limitOne = true; const sub = planSub(node.q, scope, ctx); ctx.limitOne = false; let cache = null; return env => { if (!sub.correlated && cache != null) return cache; meterOf(ctx).charge(sub.node, COST.subplanRun); const r = sub.run(env).length > 0; if (!sub.correlated) cache = r; return r; }; }
      case 'subq': {
        const sub = planSub(node.q, scope, ctx);
        if (sub.cols.filter(x => !x.hidden).length !== 1) throw new SqlError('INVALID_SUBQUERY_EXPRESSION.SCALAR_SUBQUERY_RETURN_MORE_THAN_ONE_OUTPUT_COLUMN', `A scalar subquery must return exactly one column, but this one returns ${sub.cols.length}.`);
        let cache, cached = false;
        return env => {
          if (!sub.correlated && cached) return cache;
          meterOf(ctx).charge(sub.node, COST.subplanRun);
          const rows = sub.run(env);
          if (rows.length > 1) throw new SqlError('SCALAR_SUBQUERY_TOO_MANY_ROWS', 'More than one row returned by a subquery used as an expression. Aggregate the subquery, or add a filter so it returns at most one row.');
          const v = rows.length ? rows[0][0] : null;
          if (!sub.correlated) { cache = v; cached = true; }
          return v;
        };
      }
      case 'case': {
        const base = node.base ? c(node.base) : null;
        const whens = node.whens.map(([w, t]) => [c(w), c(t)]);
        const els = node.else ? c(node.else) : () => null;
        return env => {
          if (base) { const b = base(env); for (const [w, t] of whens) { const v = w(env); if (b != null && v != null && compare(b, v) === 0) return t(env); } return els(env); }
          for (const [w, t] of whens) if (truthy(w(env))) return t(env);
          return els(env);
        };
      }
      case 'cast': { const e = c(node.e), t = node.type, tr = !!node.try; return env => castValue(e(env), t, tr); }
      case 'interval': {
        const v = typeof node.v === 'number' ? () => node.v : c(node.v);
        const unit = node.unit;
        return env => { const n = X.num(v(env)); switch (unit) { case 'YEAR': return new Interval(12 * n, 0, 0); case 'MONTH': return new Interval(n, 0, 0); case 'WEEK': return new Interval(0, 7 * n, 0); case 'DAY': return new Interval(0, n, 0); case 'HOUR': return new Interval(0, 0, n * 3600000); case 'MINUTE': return new Interval(0, 0, n * 60000); case 'SECOND': return new Interval(0, 0, n * 1000); default: throw new SqlError('INVALID_INTERVAL_FORMAT', `Unknown interval unit ${unit}.`); } };
      }
      case 'fn': return compileFn(node, scope, ctx, opts);
      case 'lambda': throw new SqlError('INVALID_LAMBDA_FUNCTION_CALL', 'A lambda function can only be used as an argument to a higher-order function such as transform, filter or aggregate.');
      case 'star': throw new SqlError('INVALID_USAGE_OF_STAR_OR_REGEX', 'Invalid usage of `*` in an expression. Use `*` only in the SELECT list or in count(*).');
      default: throw new SqlError('INTERNAL_ERROR', 'Cannot compile ' + node.k);
    }
  }
  function fieldPath(v, rest) {
    for (const name of rest) {
      if (v == null) return null;
      if (Array.isArray(v)) { v = v.map(x => (x == null ? null : fieldPath(x, [name]))); continue; }
      if (v instanceof Map) { let hit = null; v.forEach((x, k) => { if (lc(k) === lc(name)) hit = x; }); v = hit; continue; }
      if (!X.isStruct(v)) throw new SqlError('INVALID_EXTRACT_BASE_FIELD_TYPE', `Can't extract a value from ${typeOf(v)}. Need a complex type [STRUCT, ARRAY, MAP] but got ${typeOf(v)}.`);
      const key = Object.keys(v).find(k => lc(k) === lc(name));
      if (key === undefined) throw new SqlError('FIELD_NOT_FOUND', `No such struct field ${bt(name)} in ${Object.keys(v).map(bt).join(', ')}.`);
      v = v[key];
    }
    return v;
  }
  /* EXISTS (SELECT … FROM t WHERE t.col = <outer expression> AND <local conditions>): run the inner query once,
     hash its keys, and probe per outer row, as PostgreSQL, SQL Server, Oracle and MySQL do for semi-joins. */
  function decorrelateExists(q, scope, ctx) {
    if (q.k !== 'select' || !q.from || q.from.k !== 'table' || q.groupBy || q.groupAll || q.having || q.distinct || q.orderBy || q.limit != null || q.qualify || (q.laterals || []).length) return null;
    const name = lc(q.from.name[q.from.name.length - 1]);
    if (q.from.name.length === 1 && ctx.ctes.has(name)) return null;
    const t = ctx.db.table(q.from.name, true);
    if (!t || t.view) return null;
    if (collectAggs(q.items.map(i => i.e)).length || collectWindows(q.items.map(i => i.e)).length) return null;
    const alias = q.from.alias || t.name;
    const tscope = new Scope(t.cols.map(c => ({ name: c.name, table: alias })), scope);
    const side = e => { let local = false, outerRef = false, bad = false; walk(e, n => { if (n.k === 'subq' || n.k === 'exists' || (n.k === 'in' && n.q)) { bad = true; return false; } if (n.k === 'col') { try { const r = tscope.resolve(n.parts); if (!r) bad = true; else if (r.depth === 0) local = true; else outerRef = true; } catch (err) { bad = true; } } }); return bad ? 'bad' : local && outerRef ? 'mixed' : outerRef ? 'outer' : 'local'; };
    let corr = null; const localConj = [];
    for (const c of conjuncts(q.where)) {
      const k = side(c);
      if (k === 'local') { localConj.push(c); continue; }
      if (k === 'mixed' && !corr && c.k === 'bin' && c.op === '=') {
        const l = side(c.l), r = side(c.r);
        if (l === 'local' && r === 'outer' && c.l.k === 'col') { corr = { inner: c.l, outer: c.r }; continue; }
        if (r === 'local' && l === 'outer' && c.r.k === 'col') { corr = { inner: c.r, outer: c.l }; continue; }
      }
      return null;
    }
    if (!corr) return null;
    const innerQ = { k: 'select', distinct: false, items: [{ e: corr.inner, alias: null }], from: q.from, laterals: [], where: localConj.reduce((a, c) => (a ? { k: 'bin', op: 'AND', l: a, r: c } : c), null) };
    const subCtx = Object.assign({}, ctx, { subStack: [] });
    const inner = planQuery(innerQ, subCtx, null);
    const node = mkNode('Hashed SubPlan', `semi-join on ${sqlOf(corr.inner)} = ${sqlOf(corr.outer)}`);
    node.children.push(inner.node);
    if (ctx.subStack && ctx.subStack.length) ctx.subStack[ctx.subStack.length - 1].push(node);
    const outerFn = compile(corr.outer, scope, ctx);
    let set = null;
    return env => {
      const m = meterOf(ctx);
      if (!set) {
        const rows = inner.run(null);
        m.charge(node, rows.length * COST.hashBuild);
        set = new Set(); rows.forEach(r => { if (r[0] != null) set.add(keyOf(r[0])); });
        node.loops = 1; node.rows = set.size;
      }
      m.charge(node, COST.hashProbe);
      const v = outerFn(env);
      return v != null && set.has(keyOf(v));
    };
  }
  function planSub(q, scope, ctx) {
    const p = planQuery(q, ctx, scope);
    if (!p.node) p.node = mkNode('Subquery');
    if (ctx.subStack && ctx.subStack.length) ctx.subStack[ctx.subStack.length - 1].push(p.node);
    return p;
  }
  function compileBin(node, c) {
    const op = node.op;
    const l = c(node.l), r = c(node.r);
    switch (op) {
      case 'AND': return env => { const a = l(env); if (a === false) return false; const b = r(env); if (b === false) return false; return a == null || b == null ? null : true; };
      case 'OR': return env => { const a = l(env); if (a === true) return true; const b = r(env); if (b === true) return true; return a == null || b == null ? null : false; };
      case '=': return env => { const a = l(env), b = r(env); return a == null || b == null ? null : compare(a, b) === 0; };
      case '<>': return env => { const a = l(env), b = r(env); return a == null || b == null ? null : compare(a, b) !== 0; };
      case '<': return env => { const a = l(env), b = r(env); return a == null || b == null ? null : compare(a, b) < 0; };
      case '>': return env => { const a = l(env), b = r(env); return a == null || b == null ? null : compare(a, b) > 0; };
      case '<=': return env => { const a = l(env), b = r(env); return a == null || b == null ? null : compare(a, b) <= 0; };
      case '>=': return env => { const a = l(env), b = r(env); return a == null || b == null ? null : compare(a, b) >= 0; };
      case '<=>': return env => { const a = l(env), b = r(env); return (a == null && b == null) || (a != null && b != null && compare(a, b) === 0); };
      case '||': return env => { const a = l(env), b = r(env); if (a == null || b == null) return null; if (Array.isArray(a) && Array.isArray(b)) return a.concat(b); return X.toStr(a) + X.toStr(b); };
      case '&': return env => { const a = l(env), b = r(env); return a == null || b == null ? null : a & b; };
      case '|': return env => { const a = l(env), b = r(env); return a == null || b == null ? null : a | b; };
      case '^': return env => { const a = l(env), b = r(env); return a == null || b == null ? null : a ^ b; };
      default: return env => arith(op, l(env), r(env));
    }
  }
  function compileFn(node, scope, ctx, opts) {
    const name = node.name;
    if (node.over) throw new SqlError('UNSUPPORTED_EXPR_FOR_WINDOW', `Window function ${bt(name)} is not allowed here. Window functions are allowed in SELECT, QUALIFY and ORDER BY.`);
    if (isAggCall(node) || name === 'count') {
      if (scope.group) throw new SqlError('MISSING_AGGREGATION', `Aggregate ${bt(exprName(node))} could not be matched to the grouping.`);
      throw new SqlError('MISSING_GROUP_BY', `Aggregate function ${bt(exprName(node))} is not allowed here. Use it in SELECT, HAVING or ORDER BY of an aggregating query, or inside a subquery.`);
    }
    if (WINDOW_ONLY.has(name)) throw new SqlError('WINDOW_FUNCTION_WITHOUT_OVER_CLAUSE', `${bt(name)} is a window function and requires an OVER clause, for example ${name}() OVER (PARTITION BY … ORDER BY …).`);
    if (GENERATORS.has(name)) throw new SqlError('UNSUPPORTED_GENERATOR.NOT_GENERATOR', `The generator ${bt(name)} is not supported in this position. Use it as a top-level item in SELECT, in LATERAL VIEW, or in FROM.`);
    if (name === 'grouping' || name === 'grouping_id') {
      if (!scope.group) throw new SqlError('UNSUPPORTED_GROUPING_EXPRESSION', 'grouping()/grouping_id() can only be used with GROUP BY ROLLUP, CUBE or GROUPING SETS.');
      const gidIndex = scope.cols.findIndex(col => col.name === '__grouping_id');
      if (name === 'grouping_id') return env => env.row[gidIndex];
      const fp = fingerprint(node.args[0], scope.group.S0);
      const ki = scope.group.keyFps.indexOf(fp);
      if (ki < 0) throw new SqlError('GROUPING_COLUMN_MISMATCH', 'The column of grouping() must be one of the grouping columns.');
      const bit = scope.group.nk - 1 - ki;
      return env => (env.row[gidIndex] >> bit) & 1;
    }
    if (HIGHER_ORDER[name] && node.args.some(a => a.k === 'lambda')) {
      const args = node.args.map(a => {
        if (a.k !== 'lambda') return { f: compile(a, scope, ctx, opts) };
        const body = compile(a.body, scope, ctx, Object.assign({}, opts, { lambda: (opts.lambda || []).concat([]).length ? a.params.concat(opts.lambda) : a.params }));
        return { lambda: body, n: a.params.length, outerLambda: opts.lambda ? opts.lambda.length : 0 };
      });
      const impl = HIGHER_ORDER[name];
      return env => impl(...args.map(a => (a.f ? a.f(env) : (...vals) => a.lambda(Object.assign({}, env, { lambda: vals.slice(0, a.n).concat(env.lambda || []) }))))) ;
    }
    if (UNIT_FNS.has(name) && node.args.length === 3 && node.args[0].k === 'col' && node.args[0].parts.length === 1) node = Object.assign({}, node, { args: [{ k: 'lit', v: node.args[0].parts[0].toUpperCase() }].concat(node.args.slice(1)) });
    if (name === 'from_json') {
      if (node.args.length < 2 || node.args[1].k !== 'lit' || typeof node.args[1].v !== 'string') throw new SqlError('INVALID_SCHEMA.NON_STRING_LITERAL', 'from_json needs a schema as a string literal, for example from_json(payload, \'STRUCT<id: INT, tags: ARRAY<STRING>>\').');
      let type;
      try { type = X.parseType(node.args[1].v); } catch (e) { throw new SqlError('INVALID_SCHEMA.PARSE_ERROR', `The schema ${node.args[1].v} is invalid: ${e.message}`); }
      const js = compile(node.args[0], scope, ctx, opts);
      const conv = (v, t) => {
        if (v == null) return null;
        if (t.base === 'STRUCT') { if (typeof v !== 'object' || Array.isArray(v)) return null; const o = {}; t.fields.forEach(f => { const k = Object.keys(v).find(x => lc(x) === lc(f.name)); o[f.name] = k === undefined ? null : conv(v[k], f.type); }); return o; }
        if (t.base === 'ARRAY') return Array.isArray(v) ? v.map(x => conv(x, t.el)) : null;
        if (t.base === 'MAP') { if (typeof v !== 'object' || Array.isArray(v)) return null; const m = new Map(); Object.keys(v).forEach(k => m.set(k, conv(v[k], t.vt))); return m; }
        if (typeof v === 'object') return t.base === 'STRING' ? JSON.stringify(v) : null;
        return castValue(t.base === 'STRING' ? String(v) : v, t, true);
      };
      return env => { const s = js(env); if (s == null) return null; let v; try { v = JSON.parse(s); } catch (e) { return null; } return conv(v, type); };
    }
    if (name === 'struct') {
      const names = node.args.map((a, i) => (a.k === 'col' ? a.parts[a.parts.length - 1] : a.k === 'field' ? a.name : `col${i + 1}`));
      const fns = node.args.map(a => compile(a, scope, ctx, opts));
      return env => { const o = {}; fns.forEach((f, i) => { o[names[i]] = f(env); }); return o; };
    }
    const impl = SCALAR[name];
    if (!impl) {
      const known = Object.keys(SCALAR).concat(Object.keys(AGG), Array.from(WINDOW_ONLY), Object.keys(HIGHER_ORDER));
      throw new SqlError('UNRESOLVED_ROUTINE', `Cannot resolve routine ${bt(name)} on search path [\`system\`.\`builtin\`, \`system\`.\`session\`]. Did you mean ${suggest(name, known).slice(0, 3).map(bt).join(', ')}?`);
    }
    if (node.star) throw new SqlError('INVALID_USAGE_OF_STAR_OR_REGEX', `Invalid usage of '*' in ${name}.`);
    if (node.distinct) throw new SqlError('INVALID_DISTINCT', `DISTINCT is only valid in aggregate functions, not in ${name}.`);
    const args = node.args.map(a => compile(a, scope, ctx, opts));
    const n = args.length;
    if (n === 0) return () => impl();
    if (n === 1) { const a0 = args[0]; return env => impl(a0(env)); }
    if (n === 2) { const [a0, a1] = args; return env => impl(a0(env), a1(env)); }
    return env => impl(...args.map(f => f(env)));
  }

  /* ---------- display ---------- */
  function display(v) {
    if (v == null) return 'NULL';
    if (typeof v === 'number') return X.fmtNum(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v) || v instanceof Map || X.isStruct(v)) return JSON.stringify(jsonish(v));
    return String(v);
  }
  function jsonish(v) {
    if (v == null) return null;
    if (Array.isArray(v)) return v.map(jsonish);
    if (v instanceof Map) { const o = {}; v.forEach((x, k) => { o[X.toStr(k)] = jsonish(x); }); return o; }
    if (X.isStruct(v)) { const o = {}; Object.keys(v).forEach(k => { o[k] = jsonish(v[k]); }); return o; }
    if (typeof v === 'number') return Number(X.fmtNum(v));
    return v instanceof X.SqlDate || v instanceof X.SqlTs ? String(v) : v;
  }

  const indexSize = (db, d) => buildIndex(db, d).n;
  Object.assign(X, { Database, display, planQuery, exprName, explainLines, fmtWork, COST, Meter, sqlOf, indexSize });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : global);
