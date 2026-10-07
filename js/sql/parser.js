/* parser.js: lexer and recursive-descent parser for the Databricks SQL subset the lab supports.
   Produces a plain-object AST consumed by engine.js. Errors use Databricks error classes. */
(function (root) {
  'use strict';

  class SqlError extends Error {
    constructor(cls, message, pos) { super(`[${cls}] ${message}`); this.cls = cls; this.pos = pos; }
  }

  /* ---------- lexer ---------- */
  const OPS = ['<=>', '<>', '!=', '>=', '<=', '||', '::', '->', '=>', '==', '<', '>', '=', '+', '-', '*', '/', '%', '(', ')', ',', '.', ';', '[', ']', ':', '&', '|', '^', '~', '{', '}'];
  function lex(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      const start = i;
      if (c === "'" || c === '"') {
        let s = ''; i++;
        while (i < n) {
          if (src[i] === '\\' && i + 1 < n) { const e = src[i + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; i += 2; continue; }
          if (src[i] === c) { if (src[i + 1] === c) { s += c; i += 2; continue; } break; }
          s += src[i++];
        }
        if (i >= n) throw new SqlError('PARSE_SYNTAX_ERROR', `Syntax error: unterminated string starting at position ${start}.`, start);
        i++;
        toks.push({ t: 'str', v: s, pos: start });
        continue;
      }
      if (c === '`') {
        const e = src.indexOf('`', i + 1);
        if (e < 0) throw new SqlError('PARSE_SYNTAX_ERROR', 'Syntax error: unterminated backtick identifier.', start);
        toks.push({ t: 'id', v: src.slice(i + 1, e), quoted: true, pos: start });
        i = e + 1; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        let m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?([LDYS]|BD)?/i.exec(src.slice(i));
        toks.push({ t: 'num', v: Number(m[1] + (m[2] || '')), raw: m[0], decimal: /\./.test(m[1]) || /BD$/i.test(m[0]), pos: start });
        i += m[0].length; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))[0];
        toks.push({ t: 'id', v: m, u: m.toUpperCase(), pos: start });
        i += m.length; continue;
      }
      const op = OPS.find(o => src.startsWith(o, i));
      if (!op) throw new SqlError('PARSE_SYNTAX_ERROR', `Syntax error at or near '${c}'.`, start);
      toks.push({ t: 'op', v: op, pos: start });
      i += op.length;
    }
    toks.push({ t: 'eof', pos: n });
    return toks;
  }

  const RESERVED = new Set(('SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET JOIN ON USING INNER LEFT RIGHT FULL OUTER CROSS SEMI ANTI ' +
    'UNION INTERSECT EXCEPT MINUS AS AND OR NOT IN IS NULL LIKE ILIKE RLIKE REGEXP BETWEEN CASE WHEN THEN ELSE END EXISTS DISTINCT ALL ' +
    'WITH QUALIFY WINDOW OVER PARTITION TRUE FALSE INTERVAL LATERAL NATURAL INSERT UPDATE DELETE MERGE INTO VALUES SET CREATE DROP TABLE ' +
    'PIVOT UNPIVOT CLUSTER SORT DISTRIBUTE').split(' '));

  /* ---------- parser ---------- */
  class Parser {
    constructor(src) { this.src = src; this.toks = lex(src); this.i = 0; }
    get t() { return this.toks[this.i]; }
    peek(k) { return this.toks[this.i + (k || 0)]; }
    next() { return this.toks[this.i++]; }
    isKw(w, k) { const t = this.peek(k); return t.t === 'id' && !t.quoted && t.u === w; }
    isOp(o, k) { const t = this.peek(k); return t.t === 'op' && t.v === o; }
    acceptKw(...ws) { for (const w of ws) { if (!this.isKw(w)) return false; } ws.forEach(() => this.i++); return true; }
    acceptKwSeq(ws) { for (let k = 0; k < ws.length; k++) if (!this.isKw(ws[k], k)) return false; this.i += ws.length; return true; }
    acceptOp(o) { if (this.isOp(o)) { this.i++; return true; } return false; }
    fail(msg) {
      const t = this.t;
      const near = t.t === 'eof' ? 'end of input' : `'${t.t === 'str' ? "'" + t.v + "'" : t.raw || t.v}'`;
      throw new SqlError('PARSE_SYNTAX_ERROR', msg || `Syntax error at or near ${near}.`, t.pos);
    }
    expectKw(w) { if (!this.acceptKw(w)) this.fail(`Syntax error at or near ${this.t.t === 'eof' ? 'end of input' : `'${this.t.v}'`}: expected ${w}.`); }
    expectOp(o) { if (!this.acceptOp(o)) this.fail(`Syntax error at or near ${this.t.t === 'eof' ? 'end of input' : `'${this.t.v}'`}: expected '${o}'.`); }
    ident() {
      const t = this.t;
      if (t.t !== 'id' || (!t.quoted && RESERVED.has(t.u))) this.fail();
      this.i++; return t.v;
    }
    isIdent(k) { const t = this.peek(k); return t.t === 'id' && (t.quoted || !RESERVED.has(t.u)); }
    qname() { const parts = [this.ident()]; while (this.isOp('.') && this.isIdent(1)) { this.i++; parts.push(this.ident()); } return parts; }

    /* statements */
    script() {
      const out = [];
      while (this.t.t !== 'eof') {
        if (this.acceptOp(';')) continue;
        const start = this.t.pos;
        const st = this.statement();
        st.text = this.src.slice(start, this.t.pos).trim();
        out.push(st);
        if (this.t.t !== 'eof' && !this.acceptOp(';')) this.fail();
      }
      return out;
    }
    statement() {
      if (this.isKw('SELECT') || this.isKw('WITH') || this.isOp('(') || this.isKw('VALUES') || this.isKw('FROM') || this.isKw('TABLE')) return { k: 'query', q: this.query() };
      if (this.isKw('INSERT')) return this.insert();
      if (this.isKw('UPDATE')) return this.update();
      if (this.isKw('DELETE')) return this.del();
      if (this.isKw('MERGE')) return this.merge();
      if (this.isKw('CREATE')) return this.create();
      if (this.isKw('DROP')) return this.drop();
      if (this.acceptKw('TRUNCATE')) { this.expectKw('TABLE'); return { k: 'truncate', name: this.qname() }; }
      if (this.acceptKw('SHOW')) { if (this.acceptKw('TABLES') || this.acceptKw('VIEWS')) return { k: 'show' }; this.fail(); }
      if (this.acceptKw('DESCRIBE') || this.acceptKw('DESC')) { this.acceptKw('TABLE'); return { k: 'describe', name: this.qname() }; }
      if (this.isKw('USE')) { this.i++; this.acceptKw('CATALOG') || this.acceptKw('SCHEMA'); this.qname(); return { k: 'noop', note: 'USE is accepted and ignored: everything lives in one schema here.' }; }
      if (this.isKw('EXPLAIN')) { this.i++; const analyze = this.acceptKw('ANALYZE'); return { k: 'explain', analyze, st: this.statement() }; }
      this.fail();
    }
    insert() {
      this.expectKw('INSERT');
      let overwrite = false;
      if (this.acceptKw('OVERWRITE')) { overwrite = true; this.acceptKw('TABLE'); } else { this.expectKw('INTO'); this.acceptKw('TABLE'); }
      const name = this.qname();
      let cols = null;
      if (this.isOp('(') && !(this.isKw('SELECT', 1) || this.isKw('WITH', 1) || this.isKw('VALUES', 1))) { this.i++; cols = [this.ident()]; while (this.acceptOp(',')) cols.push(this.ident()); this.expectOp(')'); }
      return { k: 'insert', name, cols, overwrite, q: this.query() };
    }
    update() {
      this.expectKw('UPDATE');
      const name = this.qname();
      const alias = this.optAlias();
      this.expectKw('SET');
      const set = [];
      do { const col = this.qname(); this.expectOp('='); set.push({ col: col[col.length - 1], e: this.expr() }); } while (this.acceptOp(','));
      const where = this.acceptKw('WHERE') ? this.expr() : null;
      return { k: 'update', name, alias, set, where };
    }
    del() {
      this.expectKw('DELETE'); this.expectKw('FROM');
      const name = this.qname();
      const alias = this.optAlias();
      return { k: 'delete', name, alias, where: this.acceptKw('WHERE') ? this.expr() : null };
    }
    merge() {
      this.expectKw('MERGE'); this.acceptKw('WITH') && this.acceptKw('SCHEMA') && this.acceptKw('EVOLUTION');
      this.expectKw('INTO');
      const target = { name: this.qname() }; target.alias = this.optAlias();
      this.expectKw('USING');
      const source = this.tablePrimary();
      this.expectKw('ON');
      const on = this.expr();
      const clauses = [];
      while (this.acceptKw('WHEN')) {
        const c = {};
        if (this.acceptKw('MATCHED')) c.kind = 'matched';
        else { this.expectKw('NOT'); this.expectKw('MATCHED'); c.kind = 'notMatched'; if (this.acceptKw('BY')) { if (this.acceptKw('SOURCE')) c.kind = 'notMatchedBySource'; else this.expectKw('TARGET'); } }
        if (this.acceptKw('AND')) c.cond = this.expr();
        this.expectKw('THEN');
        if (this.acceptKw('DELETE')) c.action = 'delete';
        else if (this.acceptKw('UPDATE')) {
          this.expectKw('SET'); c.action = 'update';
          if (this.acceptOp('*')) c.star = true;
          else { c.set = []; do { const col = this.qname(); this.expectOp('='); c.set.push({ col: col[col.length - 1], e: this.expr() }); } while (this.acceptOp(',')); }
        } else if (this.acceptKw('INSERT')) {
          c.action = 'insert';
          if (this.acceptOp('*')) c.star = true;
          else {
            this.expectOp('('); c.cols = [this.qname().pop()]; while (this.acceptOp(',')) c.cols.push(this.qname().pop()); this.expectOp(')');
            this.expectKw('VALUES'); this.expectOp('('); c.values = [this.expr()]; while (this.acceptOp(',')) c.values.push(this.expr()); this.expectOp(')');
          }
        } else this.fail();
        clauses.push(c);
      }
      if (!clauses.length) this.fail('Syntax error: MERGE needs at least one WHEN clause.');
      return { k: 'merge', target, source, on, clauses };
    }
    create() {
      this.expectKw('CREATE');
      let orReplace = false, temp = false;
      if (this.acceptKw('OR')) { this.expectKw('REPLACE'); orReplace = true; }
      if (this.isKw('SCHEMA') || this.isKw('DATABASE') || this.isKw('CATALOG')) { this.i++; this.acceptKwSeq(['IF', 'NOT', 'EXISTS']); this.qname(); if (this.acceptKw('COMMENT')) this.next(); return { k: 'noop', note: 'Schemas are accepted and ignored here: every table lives in one schema.' }; }
      if (this.acceptKw('TEMPORARY') || this.acceptKw('TEMP')) temp = true;
      const unique = this.acceptKw('UNIQUE');
      if (this.acceptKw('INDEX')) {
        const ifNotExists = this.acceptKwSeq(['IF', 'NOT', 'EXISTS']);
        const name = this.ident();
        this.expectKw('ON');
        const table = this.qname();
        this.expectOp('(');
        const cols = [];
        do { const c = this.ident(); const desc = this.acceptKw('DESC'); if (!desc) this.acceptKw('ASC'); cols.push({ name: c, desc }); } while (this.acceptOp(','));
        this.expectOp(')');
        let include = [];
        if (this.acceptKw('INCLUDE')) { this.expectOp('('); do { include.push(this.ident()); } while (this.acceptOp(',')); this.expectOp(')'); }
        const where = this.acceptKw('WHERE') ? this.expr() : null;
        return { k: 'createIndex', name, table, cols, include, where, unique, ifNotExists, orReplace };
      }
      if (unique) this.fail('Syntax error: expected INDEX after UNIQUE.');
      if (this.acceptKw('VIEW')) {
        const ifNotExists = this.acceptKwSeq(['IF', 'NOT', 'EXISTS']);
        const name = this.qname();
        if (this.acceptKw('COMMENT')) this.next();
        this.expectKw('AS');
        return { k: 'createView', name, orReplace, temp, ifNotExists, q: this.query() };
      }
      this.expectKw('TABLE');
      const ifNotExists = this.acceptKwSeq(['IF', 'NOT', 'EXISTS']);
      const name = this.qname();
      let cols = null;
      if (this.acceptOp('(')) {
        cols = [];
        do {
          if (this.isKw('CONSTRAINT') || this.isKw('PRIMARY') || this.isKw('FOREIGN')) { this.skipBalanced(); continue; }
          const cname = this.ident();
          const type = this.typeName();
          const col = { name: cname, type, notNull: false };
          while (!this.isOp(',') && !this.isOp(')')) {
            if (this.acceptKw('NOT')) { this.expectKw('NULL'); col.notNull = true; }
            else if (this.acceptKw('COMMENT')) this.next();
            else if (this.acceptKw('DEFAULT')) col.def = this.expr();
            else if (this.acceptKw('GENERATED')) { this.skipUntilColEnd(); col.generated = true; }
            else if (this.acceptKw('PRIMARY')) { this.expectKw('KEY'); }
            else this.fail();
          }
          cols.push(col);
        } while (this.acceptOp(','));
        this.expectOp(')');
      }
      while (this.acceptKw('USING') ? (this.ident(), true) : this.acceptKw('COMMENT') ? (this.next(), true) : this.acceptKw('CLUSTER') ? (this.expectKw('BY'), this.skipBalanced(), true) : this.acceptKw('PARTITIONED') ? (this.expectKw('BY'), this.skipBalanced(), true) : this.acceptKw('TBLPROPERTIES') ? (this.skipBalanced(), true) : false);
      let q = null;
      if (this.acceptKw('AS')) q = this.query();
      if (!cols && !q) this.fail('Syntax error: CREATE TABLE needs a column list or AS SELECT.');
      return { k: 'createTable', name, cols, q, orReplace, ifNotExists, temp };
    }
    skipBalanced() {
      if (this.isKw('AUTO') || this.isKw('NONE')) { this.i++; return; }
      let depth = 0;
      do {
        if (this.isOp('(')) depth++;
        else if (this.isOp(')')) depth--;
        if (this.t.t === 'eof') this.fail();
        this.i++;
      } while (depth > 0);
      while (!this.isOp(',') && !this.isOp(')') && depth === 0 && this.t.t !== 'eof' && !this.isKw('AS') && !this.isKw('USING') && !this.isKw('COMMENT') && !this.isKw('CLUSTER') && !this.isKw('TBLPROPERTIES') && !this.isOp(';')) {
        if (this.isOp('(')) this.skipBalanced(); else this.i++;
      }
    }
    skipUntilColEnd() { let depth = 0; while (this.t.t !== 'eof' && !(depth === 0 && (this.isOp(',') || this.isOp(')')))) { if (this.isOp('(')) depth++; if (this.isOp(')')) depth--; this.i++; } }
    drop() {
      this.expectKw('DROP');
      const kind = this.acceptKw('TABLE') ? 'table' : this.acceptKw('VIEW') ? 'view' : this.acceptKw('INDEX') ? 'index' : this.fail();
      const ifExists = this.acceptKwSeq(['IF', 'EXISTS']);
      return { k: 'drop', kind, name: this.qname(), ifExists };
    }
    typeName() {
      const t = this.ident().toUpperCase();
      if (t === 'ARRAY') { this.expectOp('<'); const el = this.typeName(); this.expectOp('>'); return { base: 'ARRAY', el }; }
      if (t === 'MAP') { this.expectOp('<'); const kt = this.typeName(); this.expectOp(','); const vt = this.typeName(); this.expectOp('>'); return { base: 'MAP', kt, vt }; }
      if (t === 'STRUCT') {
        this.expectOp('<'); const fields = [];
        do { const fname = this.ident(); this.acceptOp(':'); fields.push({ name: fname, type: this.typeName() }); } while (this.acceptOp(','));
        this.expectOp('>'); return { base: 'STRUCT', fields };
      }
      const ty = { base: { INTEGER: 'INT', LONG: 'BIGINT', SHORT: 'SMALLINT', BYTE: 'TINYINT', REAL: 'FLOAT', NUMERIC: 'DECIMAL', DEC: 'DECIMAL', VARCHAR: 'STRING', CHAR: 'STRING', TEXT: 'STRING', BOOL: 'BOOLEAN', TIMESTAMP_NTZ: 'TIMESTAMP', TIMESTAMP_LTZ: 'TIMESTAMP' }[t] || t };
      if (this.acceptOp('(')) { ty.p = this.next().v; if (this.acceptOp(',')) ty.s = this.next().v; this.expectOp(')'); }
      const known = ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DOUBLE', 'FLOAT', 'DECIMAL', 'STRING', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'BINARY', 'VARIANT'];
      if (!known.includes(ty.base)) throw new SqlError('UNSUPPORTED_DATATYPE', `Unsupported data type "${t}".`, this.t.pos);
      if (ty.base === 'DECIMAL' && ty.s == null) ty.s = ty.p == null ? 0 : 0;
      return ty;
    }

    /* queries */
    query() {
      let w = null;
      if (this.acceptKw('WITH')) {
        w = { recursive: this.acceptKw('RECURSIVE'), ctes: [] };
        do {
          const name = this.ident();
          let cols = null;
          if (this.acceptOp('(')) { cols = [this.ident()]; while (this.acceptOp(',')) cols.push(this.ident()); this.expectOp(')'); }
          this.expectKw('AS'); this.expectOp('(');
          const q = this.query(); this.expectOp(')');
          w.ctes.push({ name, cols, q });
        } while (this.acceptOp(','));
      }
      let q = this.setExpr();
      if (this.isKw('ORDER') || this.isKw('LIMIT') || this.isKw('OFFSET')) {
        if (q.k !== 'select' || q.orderBy || q.limit != null) q = { k: 'wrap', q };
        this.tail(q);
      }
      if (w) q = { k: 'with', w, q };
      return q;
    }
    tail(q) {
      if (this.acceptKw('ORDER')) { this.expectKw('BY'); q.orderBy = this.orderList(); }
      if (this.acceptKw('LIMIT')) { if (this.acceptKw('ALL')) q.limit = null; else q.limit = this.expr(); }
      if (this.acceptKw('OFFSET')) q.offset = this.expr();
    }
    orderList() {
      const out = [];
      do {
        const e = this.expr();
        const o = { e, desc: false, nulls: null };
        if (this.acceptKw('DESC')) o.desc = true; else this.acceptKw('ASC');
        if (this.acceptKw('NULLS')) o.nulls = this.acceptKw('FIRST') ? 'first' : (this.expectKw('LAST'), 'last');
        out.push(o);
      } while (this.acceptOp(','));
      return out;
    }
    setExpr() {
      let l = this.setTerm();
      while (this.isKw('UNION') || this.isKw('EXCEPT') || this.isKw('MINUS')) {
        const op = this.next().u === 'UNION' ? 'UNION' : 'EXCEPT';
        const all = this.acceptKw('ALL'); if (!all) this.acceptKw('DISTINCT');
        l = { k: 'setop', op, all, l, r: this.setTerm() };
      }
      return l;
    }
    setTerm() {
      let l = this.setPrimary();
      while (this.isKw('INTERSECT')) {
        this.i++;
        const all = this.acceptKw('ALL'); if (!all) this.acceptKw('DISTINCT');
        l = { k: 'setop', op: 'INTERSECT', all, l, r: this.setPrimary() };
      }
      return l;
    }
    setPrimary() {
      if (this.isOp('(')) { this.i++; const q = this.query(); this.expectOp(')'); return q.k === 'select' ? q : { k: 'wrap', q }; }
      if (this.isKw('VALUES')) { const v = this.valuesClause(); return { k: 'select', items: [{ e: { k: 'star' } }], from: v }; }
      if (this.acceptKw('TABLE')) return { k: 'select', items: [{ e: { k: 'star' } }], from: { k: 'table', name: this.qname() } };
      return this.select();
    }
    valuesClause() {
      this.expectKw('VALUES');
      const rows = [];
      do {
        if (this.acceptOp('(')) { const r = [this.expr()]; while (this.acceptOp(',')) r.push(this.expr()); this.expectOp(')'); rows.push(r); }
        else rows.push([this.expr()]);
      } while (this.acceptOp(','));
      return { k: 'values', rows };
    }
    select() {
      if (this.isKw('FROM')) { // FROM-first syntax is not supported; give a clear message
        this.fail('Syntax error: a query must start with SELECT (or WITH).');
      }
      this.expectKw('SELECT');
      const q = { k: 'select', distinct: false };
      if (this.acceptKw('DISTINCT')) q.distinct = true; else this.acceptKw('ALL');
      q.items = [];
      do { q.items.push(this.selectItem()); } while (this.acceptOp(','));
      if (this.acceptKw('FROM')) q.from = this.fromClause();
      q.laterals = [];
      while (this.isKw('LATERAL') && this.isKw('VIEW', 1)) {
        this.i += 2;
        const outer = this.acceptKw('OUTER');
        const fn = this.expr();
        const alias = this.isIdent() && !this.isKw('AS') ? this.ident() : null;
        let cols = [];
        if (this.acceptKw('AS')) { cols.push(this.ident()); while (this.acceptOp(',')) cols.push(this.ident()); }
        q.laterals.push({ fn, alias, cols, outer });
      }
      if (this.acceptKw('WHERE')) q.where = this.expr();
      if (this.acceptKw('GROUP')) {
        this.expectKw('BY');
        if (this.acceptKw('ALL')) q.groupAll = true;
        else {
          q.groupBy = [];
          if (this.isKw('ROLLUP') || this.isKw('CUBE') || this.isKw('GROUPING')) {
            if (this.acceptKw('ROLLUP') || (this.isKw('CUBE') && this.next())) {
              const kind = this.toks[this.i - 1].u;
              this.expectOp('('); const cols = [this.expr()]; while (this.acceptOp(',')) cols.push(this.expr()); this.expectOp(')');
              q.groupBy = cols;
              q.groupingSets = kind === 'ROLLUP' ? cols.map((_, i) => cols.slice(0, cols.length - i)).concat([[]]) : powerSet(cols);
            } else {
              this.expectKw('GROUPING'); this.expectKw('SETS'); this.expectOp('(');
              const sets = [];
              do {
                if (this.acceptOp('(')) { const s = []; if (!this.isOp(')')) { do { s.push(this.expr()); } while (this.acceptOp(',')); } this.expectOp(')'); sets.push(s); }
                else sets.push([this.expr()]);
              } while (this.acceptOp(','));
              this.expectOp(')');
              const all = []; sets.forEach(s => s.forEach(e => { if (!all.some(x => same(x, e))) all.push(e); }));
              q.groupBy = all; q.groupingSets = sets;
            }
          } else {
            do { q.groupBy.push(this.expr()); } while (this.acceptOp(','));
            if (this.acceptKw('WITH')) { const kind = this.next().u; const cols = q.groupBy; q.groupingSets = kind === 'ROLLUP' ? cols.map((_, i) => cols.slice(0, cols.length - i)).concat([[]]) : powerSet(cols); }
          }
        }
      }
      if (this.acceptKw('HAVING')) q.having = this.expr();
      if (this.acceptKw('WINDOW')) {
        q.windows = {};
        do { const name = this.ident(); this.expectKw('AS'); this.expectOp('('); q.windows[name.toLowerCase()] = this.windowSpec(); this.expectOp(')'); } while (this.acceptOp(','));
      }
      if (this.acceptKw('QUALIFY')) q.qualify = this.expr();
      if (this.isKw('WINDOW') && !q.windows) {
        this.i++; q.windows = {};
        do { const name = this.ident(); this.expectKw('AS'); this.expectOp('('); q.windows[name.toLowerCase()] = this.windowSpec(); this.expectOp(')'); } while (this.acceptOp(','));
      }
      return q;
    }
    selectItem() {
      if (this.isOp('*')) { this.i++; return { e: { k: 'star', except: this.starExcept() } }; }
      if (this.isIdent() && this.isOp('.', 1) && this.isOp('*', 2)) { const tbl = this.ident(); this.i += 2; return { e: { k: 'star', table: tbl, except: this.starExcept() } }; }
      const e = this.expr();
      let alias = null;
      if (this.acceptKw('AS')) {
        if (this.acceptOp('(')) { alias = [this.ident()]; while (this.acceptOp(',')) alias.push(this.ident()); this.expectOp(')'); }
        else alias = this.ident();
      } else if (this.isIdent() && !this.isKw('FROM')) alias = this.ident();
      return { e, alias };
    }
    starExcept() {
      if (!this.isKw('EXCEPT') || !this.isOp('(', 1)) return null;
      this.i += 2; const cols = [this.qname()]; while (this.acceptOp(',')) cols.push(this.qname()); this.expectOp(')');
      return cols.map(c => c[c.length - 1]);
    }
    optAlias() {
      if (this.acceptKw('AS')) return this.ident();
      if (this.isIdent() && !['SET', 'USING', 'WHERE', 'ON'].includes(this.t.u)) return this.ident();
      return null;
    }
    fromClause() {
      let l = this.tableRef();
      while (this.acceptOp(',')) l = { k: 'join', type: 'cross', l, r: this.tableRef() };
      return l;
    }
    tableRef() {
      let l = this.tablePrimary();
      for (;;) {
        let type = null, natural = false;
        if (this.acceptKw('NATURAL')) natural = true;
        if (this.acceptKw('CROSS')) type = 'cross';
        else if (this.acceptKw('INNER')) type = 'inner';
        else if (this.isKw('LEFT') || this.isKw('RIGHT') || this.isKw('FULL')) {
          type = this.next().u.toLowerCase();
          if (type === 'left' && this.acceptKw('SEMI')) type = 'semi';
          else if (type === 'left' && this.acceptKw('ANTI')) type = 'anti';
          else this.acceptKw('OUTER');
        } else if (this.acceptKw('SEMI')) type = 'semi';
        else if (this.acceptKw('ANTI')) type = 'anti';
        if (!type && !this.isKw('JOIN')) { if (natural) this.fail(); break; }
        this.expectKw('JOIN');
        type = type || 'inner';
        const lateral = this.acceptKw('LATERAL');
        const r = this.tablePrimary(lateral);
        const j = { k: 'join', type, l, r, natural };
        if (type !== 'cross' && !natural) {
          if (this.acceptKw('ON')) j.on = this.expr();
          else if (this.acceptKw('USING')) { this.expectOp('('); j.using = [this.ident()]; while (this.acceptOp(',')) j.using.push(this.ident()); this.expectOp(')'); }
          else if (!lateral) this.fail(`Syntax error at or near ${this.t.t === 'eof' ? 'end of input' : `'${this.t.v}'`}: a ${type.toUpperCase()} JOIN needs ON or USING.`);
        }
        l = j;
      }
      return l;
    }
    tablePrimary(lateral) {
      let node;
      if (this.isOp('(')) {
        this.i++;
        if (this.isKw('SELECT') || this.isKw('WITH') || this.isKw('VALUES') || this.isOp('(')) { node = { k: 'subquery', q: this.query(), lateral }; this.expectOp(')'); }
        else { node = this.tableRef(); this.expectOp(')'); return node; }
      } else if (this.isKw('VALUES')) node = this.valuesClause();
      else if (this.isKw('LATERAL')) { this.i++; return this.tablePrimary(true); }
      else {
        const name = this.qname();
        if (this.isOp('(')) { this.i++; const args = []; if (!this.isOp(')')) { do { args.push(this.expr()); } while (this.acceptOp(',')); } this.expectOp(')'); node = { k: 'tvf', name: name[name.length - 1].toLowerCase(), args, lateral }; }
        else node = { k: 'table', name };
      }
      if (this.acceptKw('AS') || (this.isIdent() && !this.isJoinWord())) {
        node.alias = this.ident();
        if (this.isOp('(') && this.isIdent(1)) { this.i++; node.colAliases = [this.ident()]; while (this.acceptOp(',')) node.colAliases.push(this.ident()); this.expectOp(')'); }
      }
      return node;
    }
    isJoinWord() { return ['NATURAL', 'CROSS', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'SEMI', 'ANTI', 'JOIN', 'ON', 'USING', 'WHEN', 'LATERAL', 'SET'].includes(this.t.u); }

    /* expressions, lowest to highest precedence */
    expr() { return this.orExpr(); }
    orExpr() { let l = this.andExpr(); while (this.acceptKw('OR')) l = { k: 'bin', op: 'OR', l, r: this.andExpr() }; return l; }
    andExpr() { let l = this.notExpr(); while (this.acceptKw('AND')) l = { k: 'bin', op: 'AND', l, r: this.notExpr() }; return l; }
    notExpr() { if (this.acceptKw('NOT') || this.acceptOp('!')) return { k: 'un', op: 'NOT', e: this.notExpr() }; return this.predicate(); }
    predicate() {
      let l = this.comparison();
      for (;;) {
        if (this.isKw('IS')) {
          this.i++;
          const not = this.acceptKw('NOT');
          if (this.acceptKw('NULL')) { l = { k: 'isnull', e: l, not }; continue; }
          if (this.acceptKw('TRUE')) { l = { k: 'istrue', e: l, v: true, not }; continue; }
          if (this.acceptKw('FALSE')) { l = { k: 'istrue', e: l, v: false, not }; continue; }
          if (this.acceptKw('DISTINCT')) { this.expectKw('FROM'); l = { k: 'distinctfrom', l, r: this.comparison(), not }; continue; }
          this.fail();
        }
        const not = this.isKw('NOT') && (this.isKw('IN', 1) || this.isKw('BETWEEN', 1) || this.isKw('LIKE', 1) || this.isKw('ILIKE', 1) || this.isKw('RLIKE', 1) || this.isKw('REGEXP', 1));
        if (not) this.i++;
        if (this.acceptKw('IN')) {
          this.expectOp('(');
          if (this.isKw('SELECT') || this.isKw('WITH')) { const q = this.query(); this.expectOp(')'); l = { k: 'in', e: l, q, not }; }
          else { const list = [this.expr()]; while (this.acceptOp(',')) list.push(this.expr()); this.expectOp(')'); l = { k: 'in', e: l, list, not }; }
          continue;
        }
        if (this.acceptKw('BETWEEN')) { const lo = this.comparison(); this.expectKw('AND'); l = { k: 'between', e: l, lo, hi: this.comparison(), not }; continue; }
        if (this.isKw('LIKE') || this.isKw('ILIKE') || this.isKw('RLIKE') || this.isKw('REGEXP')) {
          const op = this.next().u === 'REGEXP' ? 'RLIKE' : this.toks[this.i - 1].u;
          let quant = null;
          if ((op === 'LIKE' || op === 'ILIKE') && (this.isKw('ANY') || this.isKw('ALL') || this.isKw('SOME'))) { quant = this.next().u === 'ALL' ? 'ALL' : 'ANY'; }
          if (quant) { this.expectOp('('); const pats = [this.expr()]; while (this.acceptOp(',')) pats.push(this.expr()); this.expectOp(')'); l = { k: 'like', op, e: l, pats, quant, not }; continue; }
          const pat = this.comparison();
          let escape = null;
          if (this.acceptKw('ESCAPE')) escape = this.next().v;
          l = { k: 'like', op, e: l, pat, escape, not };
          continue;
        }
        if (not) this.fail();
        return l;
      }
    }
    comparison() {
      let l = this.bitOr();
      for (;;) {
        const t = this.t;
        if (t.t === 'op' && ['=', '==', '<>', '!=', '<', '>', '<=', '>=', '<=>'].includes(t.v)) {
          this.i++;
          const op = t.v === '==' ? '=' : t.v === '!=' ? '<>' : t.v;
          l = { k: 'bin', op, l, r: this.bitOr() };
          continue;
        }
        return l;
      }
    }
    bitOr() { let l = this.additive(); while (this.isOp('||') || this.isOp('|') || this.isOp('&') || this.isOp('^')) { const op = this.next().v; l = { k: 'bin', op, l, r: this.additive() }; } return l; }
    additive() { let l = this.multiplicative(); while (this.isOp('+') || this.isOp('-')) { const op = this.next().v; l = { k: 'bin', op, l, r: this.multiplicative() }; } return l; }
    multiplicative() {
      let l = this.unary();
      while (this.isOp('*') || this.isOp('/') || this.isOp('%') || this.isKw('DIV')) { const op = this.next().v; l = { k: 'bin', op: op.toUpperCase() === 'DIV' ? 'DIV' : op, l, r: this.unary() }; }
      return l;
    }
    unary() {
      if (this.acceptOp('-')) { const e = this.unary(); return e.k === 'lit' && typeof e.v === 'number' ? { k: 'lit', v: -e.v, decimal: e.decimal } : { k: 'un', op: '-', e }; }
      if (this.acceptOp('+')) return this.unary();
      if (this.acceptOp('~')) return { k: 'un', op: '~', e: this.unary() };
      return this.postfix();
    }
    postfix() {
      let e = this.primary();
      for (;;) {
        if (this.isOp('::')) { this.i++; e = { k: 'cast', e, type: this.typeName() }; continue; }
        if (this.isOp('[')) { this.i++; const idx = this.expr(); this.expectOp(']'); e = { k: 'index', e, idx }; continue; }
        if (this.isOp('.') && this.isIdent(1) && e.k !== 'col') { this.i++; e = { k: 'field', e, name: this.ident() }; continue; }
        if (this.isOp(':') && (this.isIdent(1) || this.peek(1).t === 'str' || this.isOp('[', 1))) { // JSON path: raw:customer.city
          this.i++; let path = '$';
          for (;;) {
            if (this.isIdent()) path += '.' + this.ident();
            else if (this.acceptOp('[')) { const t = this.next(); path += t.t === 'num' ? `[${t.v}]` : `['${t.v}']`; this.expectOp(']'); }
            else if (this.t.t === 'str') path += `['${this.next().v}']`;
            if (this.isOp('.') && this.isIdent(1)) { this.i++; continue; }
            if (this.isOp('[')) continue;
            break;
          }
          e = { k: 'fn', name: 'get_json_object', args: [e, { k: 'lit', v: path }], jsonPath: true };
          continue;
        }
        return e;
      }
    }
    primary() {
      const t = this.t;
      if (t.t === 'num') { this.i++; return { k: 'lit', v: t.v, decimal: t.decimal }; }
      if (t.t === 'str') { this.i++; let v = t.v; while (this.t.t === 'str') v += this.next().v; return { k: 'lit', v }; }
      if (t.t === 'op' && t.v === '(') {
        this.i++;
        if (this.isKw('SELECT') || this.isKw('WITH')) { const q = this.query(); this.expectOp(')'); return { k: 'subq', q }; }
        if (this.isIdent() && (this.isOp(')', 1) && this.isOp('->', 2) || this.isOp(',', 1))) {
          const save = this.i;
          try {
            const params = [this.ident()]; while (this.acceptOp(',')) params.push(this.ident());
            this.expectOp(')'); this.expectOp('->');
            return { k: 'lambda', params, body: this.expr() };
          } catch (e) { this.i = save; }
        }
        const e = this.expr();
        if (this.isOp(',')) { const items = [e]; while (this.acceptOp(',')) items.push(this.expr()); this.expectOp(')'); return { k: 'fn', name: 'struct', args: items }; }
        this.expectOp(')');
        return e;
      }
      if (t.t !== 'id') this.fail();
      if (!t.quoted) {
        switch (t.u) {
          case 'NULL': this.i++; return { k: 'lit', v: null };
          case 'TRUE': this.i++; return { k: 'lit', v: true };
          case 'FALSE': this.i++; return { k: 'lit', v: false };
          case 'CASE': return this.caseExpr();
          case 'EXISTS':
            if (this.isOp('(', 1) && (this.isKw('SELECT', 2) || this.isKw('WITH', 2) || this.isOp('(', 2))) { this.i++; this.expectOp('('); const q = this.query(); this.expectOp(')'); return { k: 'exists', q }; }
            break;
          case 'CAST': case 'TRY_CAST': {
            this.i++; this.expectOp('('); const e = this.expr(); this.expectKw('AS'); const type = this.typeName(); this.expectOp(')');
            return { k: 'cast', e, type, try: t.u === 'TRY_CAST' };
          }
          case 'INTERVAL': {
            this.i++;
            let v, unit;
            if (this.t.t === 'str') { const s = this.next().v.trim(); const m = /^(-?\d+)\s*([a-z]+)?$/i.exec(s); v = Number(m ? m[1] : s); unit = m && m[2] ? m[2] : this.ident(); }
            else { v = this.unary(); unit = this.ident(); }
            return { k: 'interval', v, unit: unit.toUpperCase().replace(/S$/, '') };
          }
          case 'DATE': case 'TIMESTAMP': case 'TIMESTAMP_NTZ':
            if (this.peek(1).t === 'str') { this.i++; const s = this.next().v; return { k: 'cast', e: { k: 'lit', v: s }, type: { base: t.u === 'DATE' ? 'DATE' : 'TIMESTAMP' } }; }
            break;
          case 'CURRENT_DATE': case 'CURRENT_TIMESTAMP':
            if (!this.isOp('(', 1)) { this.i++; return { k: 'fn', name: t.u.toLowerCase(), args: [] }; }
            break;
          case 'EXTRACT': {
            this.i++; this.expectOp('('); const field = this.ident(); this.expectKw('FROM'); const e = this.expr(); this.expectOp(')');
            return { k: 'fn', name: 'extract', args: [{ k: 'lit', v: field.toUpperCase() }, e] };
          }
          case 'ARRAY':
            if (this.isOp('[', 1)) { this.i += 2; const items = []; if (!this.isOp(']')) { do { items.push(this.expr()); } while (this.acceptOp(',')); } this.expectOp(']'); return { k: 'fn', name: 'array', args: items }; }
            break;
          default: break;
        }
      }
      if (this.isOp('(', 1) && (t.quoted || !RESERVED.has(t.u) || ['LEFT', 'RIGHT', 'IF', 'REPLACE', 'EXISTS'].includes(t.u))) return this.funcCall();
      if (!t.quoted && RESERVED.has(t.u)) this.fail();
      const parts = [this.next().v];
      while (this.isOp('.') && this.isIdent(1)) { this.i++; parts.push(this.ident()); }
      return { k: 'col', parts };
    }
    caseExpr() {
      this.expectKw('CASE');
      const node = { k: 'case', whens: [] };
      if (!this.isKw('WHEN')) node.base = this.expr();
      while (this.acceptKw('WHEN')) { const c = this.expr(); this.expectKw('THEN'); node.whens.push([c, this.expr()]); }
      if (!node.whens.length) this.fail('Syntax error: CASE needs at least one WHEN.');
      if (this.acceptKw('ELSE')) node.else = this.expr();
      this.expectKw('END');
      return node;
    }
    funcCall() {
      const name = this.next().v.toLowerCase();
      this.expectOp('(');
      const node = { k: 'fn', name, args: [] };
      if (this.acceptOp('*')) node.star = true;
      else if (!this.isOp(')')) {
        if (this.acceptKw('DISTINCT')) node.distinct = true; else this.acceptKw('ALL');
        do {
          if (this.isIdent() && this.isOp('->', 1)) { const p = this.ident(); this.i++; node.args.push({ k: 'lambda', params: [p], body: this.expr() }); }
          else node.args.push(this.expr());
        } while (this.acceptOp(','));
        if (this.acceptKw('IGNORE')) { this.expectKw('NULLS'); node.ignoreNulls = true; }
      }
      this.expectOp(')');
      if (this.acceptKw('IGNORE')) { this.expectKw('NULLS'); node.ignoreNulls = true; } else if (this.acceptKw('RESPECT')) this.expectKw('NULLS');
      if (this.acceptKw('WITHIN')) { this.expectKw('GROUP'); this.expectOp('('); this.expectKw('ORDER'); this.expectKw('BY'); node.withinGroup = this.orderList(); this.expectOp(')'); }
      if (this.acceptKw('FILTER')) { this.expectOp('('); this.expectKw('WHERE'); node.filter = this.expr(); this.expectOp(')'); }
      if (this.acceptKw('OVER')) {
        if (this.isIdent()) node.over = { ref: this.ident().toLowerCase() };
        else { this.expectOp('('); node.over = this.windowSpec(); this.expectOp(')'); }
      }
      return node;
    }
    windowSpec() {
      const w = { partition: [], order: [], frame: null };
      if (this.isIdent() && !this.isKw('PARTITION') && !this.isKw('ORDER') && !this.isKw('ROWS') && !this.isKw('RANGE')) w.ref = this.ident().toLowerCase();
      if (this.acceptKw('PARTITION') || this.acceptKw('DISTRIBUTE')) { this.expectKw('BY'); do { w.partition.push(this.expr()); } while (this.acceptOp(',')); }
      if (this.acceptKw('ORDER') || this.acceptKw('SORT')) { this.expectKw('BY'); w.order = this.orderList(); }
      if (this.isKw('ROWS') || this.isKw('RANGE')) {
        const unit = this.next().u;
        const bound = () => {
          if (this.acceptKw('UNBOUNDED')) { if (this.acceptKw('PRECEDING')) return { t: 'up' }; this.expectKw('FOLLOWING'); return { t: 'uf' }; }
          if (this.acceptKw('CURRENT')) { this.expectKw('ROW'); return { t: 'cur' }; }
          const n = this.expr();
          if (this.acceptKw('PRECEDING')) return { t: 'p', n };
          this.expectKw('FOLLOWING'); return { t: 'f', n };
        };
        if (this.acceptKw('BETWEEN')) { const s = bound(); this.expectKw('AND'); w.frame = { unit, start: s, end: bound() }; }
        else w.frame = { unit, start: bound(), end: { t: 'cur' } };
      }
      return w;
    }
  }

  function powerSet(cols) { const out = []; for (let m = (1 << cols.length) - 1; m >= 0; m--) out.push(cols.filter((_, i) => m & (1 << (cols.length - 1 - i)))); return out; }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function parse(src) { return new Parser(src).script(); }
  function parseType(src) { const p = new Parser(src); const t = p.typeName(); if (p.t.t !== 'eof') p.fail(); return t; }
  function parseExpr(src) { const p = new Parser(src); const e = p.expr(); if (p.t.t !== 'eof') p.fail(); return e; }

  root.SQLX = root.SQLX || {};
  Object.assign(root.SQLX, { parse, parseExpr, parseType, lex, SqlError, RESERVED });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : global);
