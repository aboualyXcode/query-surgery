/* functions.js: value types, ANSI-mode casting and comparison, and the built-in function library
   (scalar, aggregate, window, generator). Behaviour follows Databricks SQL with ANSI mode on, the
   default on SQL warehouses: invalid casts and division by zero raise errors; try_* variants return NULL. */
(function (root) {
  'use strict';
  const { SqlError } = root.SQLX;

  /* ---------- value types ---------- */
  const DAY = 86400000;
  class SqlDate { constructor(d) { this.d = d; } toString() { return new Date(this.d * DAY).toISOString().slice(0, 10); } }
  class SqlTs { constructor(ms) { this.ms = ms; } toString() { return new Date(this.ms).toISOString().replace('T', ' ').replace(/\.000Z$/, '').replace(/Z$/, ''); } }
  class Interval { constructor(months, days, ms) { this.months = months || 0; this.days = days || 0; this.ms = ms || 0; }
    toString() { const p = []; if (this.months) p.push(`${this.months} months`); if (this.days) p.push(`${this.days} days`); if (this.ms) p.push(`${this.ms / 1000} seconds`); return 'INTERVAL ' + (p.join(' ') || '0 seconds'); } }
  const isDate = v => v instanceof SqlDate, isTs = v => v instanceof SqlTs;
  const isStruct = v => v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof SqlDate) && !(v instanceof SqlTs) && !(v instanceof Interval) && !(v instanceof Map);

  function typeOf(v) {
    if (v == null) return 'VOID';
    if (typeof v === 'boolean') return 'BOOLEAN';
    if (typeof v === 'number') return Number.isInteger(v) ? 'BIGINT' : 'DOUBLE';
    if (typeof v === 'string') return 'STRING';
    if (isDate(v)) return 'DATE';
    if (isTs(v)) return 'TIMESTAMP';
    if (v instanceof Interval) return 'INTERVAL';
    if (Array.isArray(v)) return `ARRAY<${v.length ? typeOf(v.find(x => x != null)) : 'VOID'}>`;
    if (v instanceof Map) return 'MAP';
    return 'STRUCT';
  }
  const typeName = t => (t.base === 'DECIMAL' ? `DECIMAL(${t.p == null ? 10 : t.p},${t.s || 0})` : t.base === 'ARRAY' ? `ARRAY<${typeName(t.el)}>` : t.base === 'STRUCT' ? 'STRUCT<…>' : t.base === 'MAP' ? 'MAP<…>' : t.base);

  /* ---------- parsing dates ---------- */
  function parseDateStr(s) {
    const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?\s*$/.exec(s);
    if (!m) return null;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const ms = Date.UTC(y, mo - 1, d, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0);
    const chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCDate() !== d) return null;
    return { ms, hasTime: m[4] != null };
  }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function patternTokens(fmt) { return fmt.match(/'[^']*'|y+|M+|d+|H+|h+|m+|s+|S+|E+|a|Q+|D+|./g) || []; }
  function formatTs(ms, fmt) {
    const d = new Date(ms);
    const pad = (n, w) => String(n).padStart(w, '0');
    return patternTokens(fmt).map(t => {
      if (t[0] === "'") return t.slice(1, -1);
      switch (t[0]) {
        case 'y': return t.length === 2 ? pad(d.getUTCFullYear() % 100, 2) : pad(d.getUTCFullYear(), t.length);
        case 'M': return t.length >= 4 ? MONTHS[d.getUTCMonth()] : t.length === 3 ? MONTHS[d.getUTCMonth()].slice(0, 3) : pad(d.getUTCMonth() + 1, t.length);
        case 'd': return pad(d.getUTCDate(), t.length);
        case 'D': return pad(Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1, t.length);
        case 'H': return pad(d.getUTCHours(), t.length);
        case 'h': return pad(d.getUTCHours() % 12 || 12, t.length);
        case 'm': return pad(d.getUTCMinutes(), t.length);
        case 's': return pad(d.getUTCSeconds(), t.length);
        case 'S': return pad(d.getUTCMilliseconds(), 3).slice(0, t.length);
        case 'E': return t.length >= 4 ? DAYS[d.getUTCDay()] : DAYS[d.getUTCDay()].slice(0, 3);
        case 'a': return d.getUTCHours() < 12 ? 'AM' : 'PM';
        case 'Q': return String(Math.floor(d.getUTCMonth() / 3) + 1);
        default: return t;
      }
    }).join('');
  }
  function parseWithPattern(s, fmt) {
    let i = 0; const v = { y: 1970, M: 1, d: 1, H: 0, m: 0, s: 0, S: 0, pm: null };
    for (const t of patternTokens(fmt)) {
      if (t[0] === "'") { if (s.substr(i, t.length - 2) !== t.slice(1, -1)) return null; i += t.length - 2; continue; }
      if (/^[yMdHhmsS]/.test(t) && !(t[0] === 'M' && t.length >= 3)) {
        const fixed = t.length > 1 && t[0] !== 'y' ? t.length : null;
        const m = (fixed ? new RegExp(`^\\d{${fixed}}`) : /^\d+/).exec(s.slice(i)); if (!m) return null;
        const n = +m[0]; i += m[0].length;
        const key = t[0] === 'h' ? 'H' : t[0];
        v[key] = key === 'y' && t.length === 2 ? 2000 + n : n;
        continue;
      }
      if (t[0] === 'M') { const idx = MONTHS.findIndex(mn => s.slice(i).toLowerCase().startsWith((t.length === 3 ? mn.slice(0, 3) : mn).toLowerCase())); if (idx < 0) return null; v.M = idx + 1; i += t.length === 3 ? 3 : MONTHS[idx].length; continue; }
      if (t[0] === 'E') { const idx = DAYS.findIndex(dn => s.slice(i).toLowerCase().startsWith((t.length >= 4 ? dn : dn.slice(0, 3)).toLowerCase())); if (idx < 0) return null; i += t.length >= 4 ? DAYS[idx].length : 3; continue; }
      if (t === 'a') { const ap = s.substr(i, 2).toUpperCase(); if (ap !== 'AM' && ap !== 'PM') return null; v.pm = ap === 'PM'; i += 2; continue; }
      if (s[i] !== t) return null; i++;
    }
    if (i !== s.length) return null;
    if (v.pm != null) v.H = (v.H % 12) + (v.pm ? 12 : 0);
    const ms = Date.UTC(v.y, v.M - 1, v.d, v.H, v.m, v.s, v.S);
    if (new Date(ms).getUTCDate() !== v.d || v.M < 1 || v.M > 12) return null;
    return ms;
  }

  /* ---------- casting ---------- */
  const castFail = (v, from, to) => new SqlError('CAST_INVALID_INPUT', `The value ${typeof v === 'string' ? `'${v}'` : String(v)} of the type "${from}" cannot be cast to "${to}" because it is malformed. Correct the value as per the syntax, or change its target type. Use \`try_cast\` to tolerate malformed input and return NULL instead.`);
  function castValue(v, type, tryMode) {
    if (v == null) return null;
    const to = typeName(type);
    const fail = () => { if (tryMode) return null; throw castFail(v, typeOf(v), to); };
    switch (type.base) {
      case 'STRING': return toStr(v);
      case 'BOOLEAN':
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (['true', 't', 'yes', 'y', '1'].includes(s)) return true; if (['false', 'f', 'no', 'n', '0'].includes(s)) return false; }
        return fail();
      case 'INT': case 'BIGINT': case 'SMALLINT': case 'TINYINT': {
        let n;
        if (typeof v === 'number') n = Math.trunc(v);
        else if (typeof v === 'boolean') n = v ? 1 : 0;
        else if (typeof v === 'string') { const s = v.trim(); if (!/^[+-]?\d+(\.\d*)?$/.test(s)) return fail(); n = Math.trunc(Number(s)); }
        else if (isDate(v) || isTs(v) || Array.isArray(v)) return fail();
        else return fail();
        const lim = { TINYINT: 127, SMALLINT: 32767, INT: 2147483647, BIGINT: Number.MAX_SAFE_INTEGER }[type.base];
        if (Math.abs(n) > lim + 1) { if (tryMode) return null; throw new SqlError('CAST_OVERFLOW', `The value ${v} of the type "${typeOf(v)}" cannot be cast to "${to}" due to an overflow. Use \`try_cast\` to tolerate overflow and return NULL instead.`); }
        return n;
      }
      case 'DOUBLE': case 'FLOAT': case 'DECIMAL': {
        let n;
        if (typeof v === 'number') n = v;
        else if (typeof v === 'boolean') n = v ? 1 : 0;
        else if (typeof v === 'string') { const s = v.trim(); if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return fail(); n = Number(s); }
        else return fail();
        if (type.base === 'DECIMAL') {
          const scale = type.s || 0;
          n = roundHalfUp(n, scale);
          const p = type.p == null ? 10 : type.p;
          if (Math.abs(n) >= Math.pow(10, p - scale)) { if (tryMode) return null; throw new SqlError('NUMERIC_VALUE_OUT_OF_RANGE', `${v} cannot be represented as ${to}. Use \`try_cast\` to return NULL instead.`); }
        }
        return n;
      }
      case 'DATE': {
        if (isDate(v)) return v;
        if (isTs(v)) return new SqlDate(Math.floor(v.ms / DAY));
        if (typeof v === 'string') { const p = parseDateStr(v); if (!p) return fail(); return new SqlDate(Math.floor(p.ms / DAY)); }
        return fail();
      }
      case 'TIMESTAMP': {
        if (isTs(v)) return v;
        if (isDate(v)) return new SqlTs(v.d * DAY);
        if (typeof v === 'string') { const p = parseDateStr(v); if (!p) return fail(); return new SqlTs(p.ms); }
        if (typeof v === 'number') return new SqlTs(v * 1000);
        return fail();
      }
      case 'ARRAY': if (!Array.isArray(v)) return fail(); return v.map(x => castValue(x, type.el, tryMode));
      case 'STRUCT': { if (!isStruct(v)) return fail(); const vals = Object.values(v); const o = {}; type.fields.forEach((f, i) => { o[f.name] = castValue(v[f.name] !== undefined ? v[f.name] : vals[i], f.type, tryMode); }); return o; }
      case 'MAP': return v;
      default: return v;
    }
  }
  function roundHalfUp(n, d) { const f = Math.pow(10, d); const x = Math.abs(n) * f; let r = Math.round(x); if (Math.abs(x - Math.floor(x) - 0.5) < 1e-9) r = Math.floor(x) + 1; return Math.sign(n) * r / f; }
  function toStr(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return fmtNum(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return '[' + v.map(x => (x == null ? 'null' : toStr(x))).join(',') + ']';
    if (v instanceof Map) return '{' + Array.from(v, ([k, x]) => `${toStr(k)} -> ${x == null ? 'null' : toStr(x)}`).join(', ') + '}';
    if (isStruct(v)) return '{' + Object.values(v).map(x => (x == null ? 'null' : toStr(x))).join(', ') + '}';
    return String(v);
  }
  function fmtNum(n) {
    if (!Number.isFinite(n)) return Number.isNaN(n) ? 'NaN' : n > 0 ? 'Infinity' : '-Infinity';
    if (Number.isInteger(n)) return String(n);
    const r = Number(n.toPrecision(15));
    return String(r);
  }

  /* ---------- comparison ---------- */
  function coercePair(a, b) {
    if (typeof a === typeof b) return [a, b];
    if (typeof a === 'number' && typeof b === 'string') { const n = castValue(b, { base: 'DOUBLE' }); return [a, n]; }
    if (typeof a === 'string' && typeof b === 'number') { const n = castValue(a, { base: 'DOUBLE' }); return [n, b]; }
    if (isDate(a) && typeof b === 'string') return [a, castValue(b, { base: parseDateStr(b) && parseDateStr(b).hasTime ? 'TIMESTAMP' : 'DATE' })];
    if (typeof a === 'string' && isDate(b)) return [castValue(a, { base: parseDateStr(a) && parseDateStr(a).hasTime ? 'TIMESTAMP' : 'DATE' }), b];
    if (isTs(a) && typeof b === 'string') return [a, castValue(b, { base: 'TIMESTAMP' })];
    if (typeof a === 'string' && isTs(b)) return [castValue(a, { base: 'TIMESTAMP' }), b];
    if (typeof a === 'boolean' && typeof b === 'string') return [a, castValue(b, { base: 'BOOLEAN' })];
    if (typeof a === 'string' && typeof b === 'boolean') return [castValue(a, { base: 'BOOLEAN' }), b];
    return [a, b];
  }
  /* Returns negative, zero or positive; callers handle NULL before calling. */
  function compare(a, b) {
    [a, b] = coercePair(a, b);
    if (isDate(a) && isTs(b)) a = new SqlTs(a.d * DAY);
    if (isTs(a) && isDate(b)) b = new SqlTs(b.d * DAY);
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    if (isDate(a) && isDate(b)) return a.d - b.d;
    if (isTs(a) && isTs(b)) return a.ms - b.ms;
    if (a instanceof Interval && b instanceof Interval) {
      if ((a.months || b.months) && (a.days || a.ms || b.days || b.ms)) throw new SqlError('DATATYPE_MISMATCH.BINARY_OP_DIFF_TYPES', 'Cannot compare a year-month interval with a day-time interval.');
      const x = a.months * 31 * DAY + a.days * DAY + a.ms, y = b.months * 31 * DAY + b.days * DAY + b.ms;
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] == null || b[i] == null) { if (a[i] == null && b[i] == null) continue; return a[i] == null ? -1 : 1; }
        const c = compare(a[i], b[i]); if (c) return c;
      }
      return a.length - b.length;
    }
    if (isStruct(a) && isStruct(b)) {
      const av = Object.values(a), bv = Object.values(b);
      for (let i = 0; i < Math.min(av.length, bv.length); i++) {
        if (av[i] == null || bv[i] == null) { if (av[i] == null && bv[i] == null) continue; return av[i] == null ? -1 : 1; }
        const c = compare(av[i], bv[i]); if (c) return c;
      }
      return av.length - bv.length;
    }
    throw new SqlError('DATATYPE_MISMATCH.BINARY_OP_DIFF_TYPES', `Cannot compare ${typeOf(a)} with ${typeOf(b)}.`);
  }
  /* A canonical key for grouping, DISTINCT, joins on equality and set operations. */
  function keyOf(v) {
    if (v == null) return 'N';
    if (typeof v === 'number') return 'n' + (Object.is(v, -0) ? 0 : Number(v.toPrecision(15)));
    if (typeof v === 'string') return 's' + v;
    if (typeof v === 'boolean') return v ? 'T' : 'F';
    if (isDate(v)) return 'd' + v.d;
    if (isTs(v)) return 't' + v.ms;
    if (Array.isArray(v)) return '[' + v.map(keyOf).join('\u0001') + ']';
    if (v instanceof Map) return 'm' + Array.from(v, ([k, x]) => keyOf(k) + '\u0002' + keyOf(x)).join('\u0001');
    if (v instanceof Interval) return 'i' + v.months + ':' + v.days + ':' + v.ms;
    return '{' + Object.keys(v).map(k => k + '\u0002' + keyOf(v[k])).join('\u0001') + '}';
  }
  const num = (v, fn) => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return castValue(v, { base: 'DOUBLE' });
    if (typeof v === 'boolean') throw new SqlError('DATATYPE_MISMATCH.UNEXPECTED_INPUT_TYPE', `Function ${fn || 'arithmetic'} requires a numeric argument, got BOOLEAN.`);
    throw new SqlError('DATATYPE_MISMATCH.UNEXPECTED_INPUT_TYPE', `Function ${fn || 'arithmetic'} requires a numeric argument, got ${typeOf(v)}.`);
  };
  const str = v => (v == null ? null : toStr(v));
  const toDate = v => (v == null ? null : isDate(v) ? v : castValue(v, { base: 'DATE' }));
  const toTs = v => (v == null ? null : isTs(v) ? v : castValue(v, { base: 'TIMESTAMP' }));

  /* ---------- arithmetic ---------- */
  function addMonthsMs(ms, months) {
    const d = new Date(ms);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  }
  function addInterval(v, iv, sign) {
    if (isDate(v) && !iv.ms) { let ms = v.d * DAY; if (iv.months) ms = addMonthsMs(ms, sign * iv.months); return new SqlDate(Math.floor(ms / DAY) + sign * iv.days); }
    const base = isDate(v) ? v.d * DAY : v.ms;
    let ms = base; if (iv.months) ms = addMonthsMs(ms, sign * iv.months);
    return new SqlTs(ms + sign * (iv.days * DAY + iv.ms));
  }
  function arith(op, a, b) {
    if (a == null || b == null) return null;
    if (a instanceof Interval || b instanceof Interval) {
      if ((isDate(a) || isTs(a)) && b instanceof Interval) return addInterval(a, b, op === '-' ? -1 : 1);
      if (a instanceof Interval && (isDate(b) || isTs(b)) && op === '+') return addInterval(b, a, 1);
      if (a instanceof Interval && b instanceof Interval) { const s = op === '-' ? -1 : 1; return new Interval(a.months + s * b.months, a.days + s * b.days, a.ms + s * b.ms); }
      if (a instanceof Interval && typeof b === 'number' && op === '*') return new Interval(a.months * b, a.days * b, a.ms * b);
    }
    if (isDate(a) && typeof b === 'number' && (op === '+' || op === '-')) return new SqlDate(a.d + (op === '+' ? b : -b));
    if (isDate(a) && isDate(b) && op === '-') return new Interval(0, a.d - b.d, 0);
    if (isTs(a) && isTs(b) && op === '-') return new Interval(0, 0, a.ms - b.ms);
    const x = num(a), y = num(b);
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': if (y === 0) throw divZero(); return x / y;
      case 'DIV': if (y === 0) throw divZero(); return Math.trunc(x / y);
      case '%': if (y === 0) throw divZero(); return x % y;
      default: throw new SqlError('INTERNAL_ERROR', 'Unknown operator ' + op);
    }
  }
  const divZero = () => new SqlError('DIVIDE_BY_ZERO', 'Division by zero. Use `try_divide` to tolerate divisor being 0 and return NULL instead. If necessary set "ansi_mode" to "false" to bypass this error.');

  /* ---------- LIKE and regex ---------- */
  const reCache = new Map();
  function likeRe(pat, ci, esc) {
    const k = pat + '|' + ci + '|' + esc;
    if (reCache.has(k)) return reCache.get(k);
    let s = '';
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i];
      if (esc && c === esc && i + 1 < pat.length) { s += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
      if (c === '\\' && !esc && i + 1 < pat.length) { s += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
      s += c === '%' ? '[\\s\\S]*' : c === '_' ? '[\\s\\S]' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    const re = new RegExp('^' + s + '$', ci ? 'i' : '');
    reCache.set(k, re); return re;
  }
  function javaRe(p, flags) {
    try { return new RegExp(p.replace(/\(\?i\)/g, ''), (flags || '') + (/\(\?i\)/.test(p) ? 'i' : '')); }
    catch (e) { throw new SqlError('INVALID_PARAMETER_VALUE.PATTERN', `The value of parameter(s) \`regexp\` is invalid: ${p}`); }
  }

  /* ---------- JSON ---------- */
  function jsonPath(obj, path) {
    if (!/^\$/.test(path)) return undefined;
    const parts = path.slice(1).match(/\.[^.[\]]+|\[\d+\]|\['[^']*'\]|\[\*\]/g) || [];
    let cur = [obj], wildcard = false;
    for (const p of parts) {
      const next = [];
      for (const c of cur) {
        if (c == null) continue;
        if (p === '[*]') { if (Array.isArray(c)) { wildcard = true; next.push(...c); } continue; }
        const key = p[0] === '.' ? p.slice(1) : p.startsWith("['") ? p.slice(2, -2) : Number(p.slice(1, -1));
        if (typeof key === 'number') { if (Array.isArray(c) && key < c.length) next.push(c[key]); }
        else if (typeof c === 'object' && !Array.isArray(c) && key in c) next.push(c[key]);
        else if (Array.isArray(c) && wildcard) c.forEach(x => { if (x && typeof x === 'object' && key in x) next.push(x[key]); });
      }
      cur = next;
    }
    if (wildcard) return cur;
    return cur.length ? cur[0] : undefined;
  }
  function getJson(js, path) {
    if (js == null || path == null) return null;
    let o;
    try { o = typeof js === 'string' ? JSON.parse(js) : js; } catch (e) { return null; }
    const v = jsonPath(o, path);
    if (v === undefined || v === null) return null;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  function toJsonValue(v) {
    if (v == null) return null;
    if (isDate(v) || isTs(v)) return v.toString();
    if (Array.isArray(v)) return v.map(toJsonValue);
    if (v instanceof Map) { const o = {}; v.forEach((x, k) => { o[toStr(k)] = toJsonValue(x); }); return o; }
    if (isStruct(v)) { const o = {}; Object.keys(v).forEach(k => { o[k] = toJsonValue(v[k]); }); return o; }
    return v;
  }

  /* ---------- the scalar library ---------- */
  const argc = (name, args, min, max) => {
    if (args.length < min || args.length > (max == null ? min : max)) throw new SqlError('WRONG_NUM_ARGS.WITHOUT_SUGGESTION', `The \`${name}\` requires ${max == null || max === min ? min : `${min} or ${max === Infinity ? 'more' : max}`} parameters but the actual number is ${args.length}.`);
  };
  const N = f => (...a) => (a.some(x => x == null) ? null : f(...a));
  const unitMs = { SECOND: 1000, MINUTE: 60000, HOUR: 3600000, DAY: DAY, WEEK: 7 * DAY };
  function truncTs(ms, unit) {
    const d = new Date(ms); unit = String(unit).toUpperCase();
    switch (unit) {
      case 'YEAR': case 'YYYY': case 'YY': return Date.UTC(d.getUTCFullYear(), 0, 1);
      case 'QUARTER': return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
      case 'MONTH': case 'MM': case 'MON': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      case 'WEEK': { const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); }
      case 'DAY': case 'DD': return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      case 'HOUR': return Math.floor(ms / 3600000) * 3600000;
      case 'MINUTE': return Math.floor(ms / 60000) * 60000;
      case 'SECOND': return Math.floor(ms / 1000) * 1000;
      default: throw new SqlError('INVALID_PARAMETER_VALUE.DATETIME_UNIT', `The value of parameter \`unit\` is invalid: '${unit}'.`);
    }
  }
  const msOf = v => (isDate(v) ? v.d * DAY : toTs(v).ms);
  function isoWeek(ms) { const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7; const th = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3); const y = new Date(th).getUTCFullYear(); return 1 + Math.floor((th - Date.UTC(y, 0, 4) + ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7) * DAY) / (7 * DAY)); }
  function dateDiffUnit(unit, a, b) {
    unit = String(unit).toUpperCase().replace(/S$/, '');
    const s = msOf(a), e = msOf(b);
    if (unit === 'MONTH' || unit === 'QUARTER' || unit === 'YEAR') {
      const ds = new Date(s), de = new Date(e);
      let m = (de.getUTCFullYear() - ds.getUTCFullYear()) * 12 + de.getUTCMonth() - ds.getUTCMonth();
      const restS = s - Date.UTC(ds.getUTCFullYear(), ds.getUTCMonth(), 1), restE = e - Date.UTC(de.getUTCFullYear(), de.getUTCMonth(), 1);
      if (m > 0 && restE < restS) m--; else if (m < 0 && restE > restS) m++;
      return unit === 'MONTH' ? m : unit === 'QUARTER' ? Math.trunc(m / 3) : Math.trunc(m / 12);
    }
    if (!unitMs[unit]) throw new SqlError('INVALID_PARAMETER_VALUE.DATETIME_UNIT', `The value of parameter \`unit\` is invalid: '${unit}'.`);
    return Math.trunc((e - s) / unitMs[unit]);
  }
  function sortArr(a, asc) { return a.slice().sort((x, y) => (x == null ? (y == null ? 0 : (asc ? -1 : 1)) : y == null ? (asc ? 1 : -1) : (asc ? 1 : -1) * compare(x, y))); }
  const uniq = a => { const seen = new Set(), out = []; a.forEach(x => { const k = keyOf(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }); return out; };

  const SCALAR = {
    /* conditional and null handling */
    coalesce: (...a) => { for (const x of a) if (x != null) return x; return null; },
    nullif: (a, b) => (a != null && b != null && compare(a, b) === 0 ? null : a),
    ifnull: (a, b) => (a == null ? b : a),
    nvl: (a, b) => (a == null ? b : a),
    nvl2: (a, b, c) => (a == null ? c : b),
    if: (c, a, b) => (c === true ? a : b),
    iff: (c, a, b) => (c === true ? a : b),
    isnull: a => a == null,
    isnotnull: a => a != null,
    zeroifnull: a => (a == null ? 0 : a),
    nullifzero: a => (a === 0 ? null : a),
    greatest: (...a) => { let m = null; a.forEach(x => { if (x != null && (m == null || compare(x, m) > 0)) m = x; }); return m; },
    least: (...a) => { let m = null; a.forEach(x => { if (x != null && (m == null || compare(x, m) < 0)) m = x; }); return m; },
    typeof: a => typeOf(a).toLowerCase(),

    /* math */
    abs: N(a => Math.abs(num(a))),
    ceil: N((a, d) => (d ? Math.ceil(num(a) * 10 ** d) / 10 ** d : Math.ceil(num(a)))),
    ceiling: N(a => Math.ceil(num(a))),
    floor: N((a, d) => (d ? Math.floor(num(a) * 10 ** d) / 10 ** d : Math.floor(num(a)))),
    round: (a, d) => (a == null ? null : roundHalfUp(num(a, 'round'), d == null ? 0 : d)),
    bround: (a, d) => { if (a == null) return null; const f = 10 ** (d || 0); const x = num(a) * f; const r = Math.round(x); return (Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : r) / f; },
    sqrt: N(a => Math.sqrt(num(a))),
    power: N((a, b) => Math.pow(num(a), num(b))),
    pow: N((a, b) => Math.pow(num(a), num(b))),
    exp: N(a => Math.exp(num(a))),
    ln: N(a => (num(a) <= 0 ? null : Math.log(num(a)))),
    log: (a, b) => (b === undefined ? (a == null || a <= 0 ? null : Math.log(a)) : a == null || b == null ? null : Math.log(num(b)) / Math.log(num(a))),
    log10: N(a => (num(a) <= 0 ? null : Math.log10(num(a)))),
    log2: N(a => (num(a) <= 0 ? null : Math.log2(num(a)))),
    sign: N(a => Math.sign(num(a))),
    signum: N(a => Math.sign(num(a))),
    mod: N((a, b) => arith('%', a, b)),
    pmod: N((a, b) => { const r = arith('%', a, b); return r < 0 ? r + Math.abs(b) : r; }),
    try_divide: (a, b) => (a == null || b == null || num(b) === 0 ? null : num(a) / num(b)),
    try_add: (a, b) => (a == null || b == null ? null : arith('+', a, b)),
    try_subtract: (a, b) => (a == null || b == null ? null : arith('-', a, b)),
    try_multiply: (a, b) => (a == null || b == null ? null : arith('*', a, b)),
    div: N((a, b) => arith('DIV', a, b)),
    pi: () => Math.PI,
    e: () => Math.E,
    width_bucket: N((v, lo, hi, n) => (v < lo ? 0 : v >= hi ? n + 1 : Math.floor(((v - lo) / (hi - lo)) * n) + 1)),

    /* strings */
    upper: N(a => str(a).toUpperCase()), ucase: N(a => str(a).toUpperCase()),
    lower: N(a => str(a).toLowerCase()), lcase: N(a => str(a).toLowerCase()),
    length: N(a => (Array.isArray(a) ? a.length : Array.from(str(a)).length)),
    char_length: N(a => Array.from(str(a)).length), character_length: N(a => Array.from(str(a)).length),
    trim: (a, chars) => (a == null ? null : chars == null ? str(a).trim() : str(a).replace(new RegExp(`^[${chars.replace(/[\]\\^-]/g, '\\$&')}]+|[${chars.replace(/[\]\\^-]/g, '\\$&')}]+$`, 'g'), '')),
    ltrim: N(a => str(a).replace(/^\s+/, '')),
    rtrim: N(a => str(a).replace(/\s+$/, '')),
    btrim: N(a => str(a).trim()),
    substring: (s, pos, len) => {
      if (s == null || pos == null) return null;
      const a = Array.from(str(s)); let p = num(pos);
      let start = p > 0 ? p - 1 : p < 0 ? Math.max(a.length + p, 0) : 0;
      if (len == null) return a.slice(start).join('');
      if (len < 0) return '';
      return a.slice(start, start + num(len)).join('');
    },
    left: N((s, n) => (n <= 0 ? '' : Array.from(str(s)).slice(0, n).join(''))),
    right: N((s, n) => (n <= 0 ? '' : Array.from(str(s)).slice(-n).join(''))),
    concat: (...a) => {
      if (a.some(x => x == null)) return null;
      if (a.length && a.every(x => Array.isArray(x))) return [].concat(...a);
      return a.map(str).join('');
    },
    concat_ws: (sep, ...a) => { if (sep == null) return null; const parts = []; a.forEach(x => { if (Array.isArray(x)) x.forEach(y => { if (y != null) parts.push(str(y)); }); else if (x != null) parts.push(str(x)); }); return parts.join(sep); },
    replace: (s, a, b) => (s == null || a == null ? null : a === '' ? str(s) : str(s).split(a).join(b == null ? '' : b)),
    translate: N((s, from, to) => Array.from(str(s)).map(c => { const i = from.indexOf(c); return i < 0 ? c : i < to.length ? to[i] : ''; }).join('')),
    instr: N((s, sub) => str(s).indexOf(sub) + 1),
    locate: (sub, s, pos) => (sub == null || s == null ? null : str(s).indexOf(sub, (pos || 1) - 1) + 1),
    position: (sub, s, pos) => (sub == null || s == null ? null : str(s).indexOf(sub, (pos || 1) - 1) + 1),
    lpad: (s, n, p) => { if (s == null || n == null) return null; p = p == null ? ' ' : p; s = str(s); if (s.length >= n) return s.slice(0, n); if (!p) return s; return (p.repeat(Math.ceil(n / p.length))).slice(0, n - s.length) + s; },
    rpad: (s, n, p) => { if (s == null || n == null) return null; p = p == null ? ' ' : p; s = str(s); if (s.length >= n) return s.slice(0, n); if (!p) return s; return s + (p.repeat(Math.ceil(n / p.length))).slice(0, n - s.length); },
    repeat: N((s, n) => str(s).repeat(Math.max(0, n))),
    reverse: N(a => (Array.isArray(a) ? a.slice().reverse() : Array.from(str(a)).reverse().join(''))),
    split: (s, re, limit) => { if (s == null || re == null) return null; let parts = str(s).split(javaRe(re)); if (limit > 0 && parts.length > limit) { const rx = javaRe(re, 'g'); const out = []; let last = 0, m; while (out.length < limit - 1 && (m = rx.exec(s)) !== null) { out.push(s.slice(last, m.index)); last = m.index + m[0].length; if (m[0] === '') rx.lastIndex++; } out.push(s.slice(last)); parts = out; } return parts; },
    split_part: N((s, d, n) => { const parts = str(s).split(d); if (n === 0) throw new SqlError('INVALID_INDEX_OF_ZERO', 'The index 0 is invalid. An index shall be either < 0 or > 0 (the first element has index 1).'); const i = n > 0 ? n - 1 : parts.length + n; return i >= 0 && i < parts.length ? parts[i] : ''; }),
    regexp_extract: (s, p, idx) => { if (s == null || p == null) return null; const m = javaRe(p).exec(str(s)); if (!m) return ''; const g = idx == null ? 1 : idx; if (g >= m.length) throw new SqlError('INVALID_PARAMETER_VALUE.REGEX_GROUP_INDEX', `The value of parameter \`idx\` is invalid: the regex has ${m.length - 1} groups but the index is ${g}.`); return m[g] == null ? '' : m[g]; },
    regexp_extract_all: (s, p, idx) => { if (s == null || p == null) return null; const rx = javaRe(p, 'g'); const g = idx == null ? 1 : idx; const out = []; let m; while ((m = rx.exec(str(s))) !== null) { out.push(m[g] == null ? '' : m[g]); if (m[0] === '') rx.lastIndex++; } return out; },
    regexp_replace: (s, p, r) => (s == null || p == null || r == null ? null : str(s).replace(javaRe(p, 'g'), r.replace(/\$(\d)/g, '$$$1'))),
    regexp_like: N((s, p) => javaRe(p).test(str(s))),
    regexp_count: N((s, p) => (str(s).match(javaRe(p, 'g')) || []).length),
    regexp_substr: N((s, p) => { const m = javaRe(p).exec(str(s)); return m ? m[0] : null; }),
    initcap: N(s => str(s).toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase())),
    contains: N((s, x) => (Array.isArray(s) ? s.some(v => v != null && compare(v, x) === 0) : str(s).includes(str(x)))),
    startswith: N((s, x) => str(s).startsWith(str(x))),
    endswith: N((s, x) => str(s).endsWith(str(x))),
    ascii: N(s => (str(s).length ? str(s).codePointAt(0) : 0)),
    chr: N(n => String.fromCodePoint(n)), char: N(n => String.fromCodePoint(n)),
    format_number: N((n, d) => Number(num(n)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })),
    format_string: (f, ...a) => { if (f == null) return null; let i = 0; return f.replace(/%(-?\d*)(?:\.(\d+))?([sdf%])/g, (m, w, p, t) => { if (t === '%') return '%'; const v = a[i++]; let out = v == null ? 'null' : t === 'd' ? String(Math.trunc(v)) : t === 'f' ? Number(v).toFixed(p == null ? 6 : +p) : str(v); if (w) { const n = Math.abs(+w); out = w[0] === '-' ? out.padEnd(n) : out.padStart(n); } return out; }); },
    md5: N(s => (root.SQLX.md5 ? root.SQLX.md5(str(s)) : null)),
    len: N(a => Array.from(str(a)).length),
    soundex: N(s => s),

    /* dates and times */
    current_date: () => root.SQLX.NOW ? new SqlDate(Math.floor(root.SQLX.NOW / DAY)) : new SqlDate(Math.floor(Date.now() / DAY)),
    current_timestamp: () => new SqlTs(root.SQLX.NOW || Date.now()),
    now: () => new SqlTs(root.SQLX.NOW || Date.now()),
    curdate: () => new SqlDate(Math.floor((root.SQLX.NOW || Date.now()) / DAY)),
    to_date: (s, fmt) => {
      if (s == null) return null;
      if (isDate(s)) return s; if (isTs(s)) return new SqlDate(Math.floor(s.ms / DAY));
      if (fmt == null) { const p = parseDateStr(str(s)); if (!p) throw new SqlError('CAST_INVALID_INPUT', `The value '${s}' of the type "STRING" cannot be cast to "DATE" because it is malformed. Use \`try_cast\` to tolerate malformed input and return NULL instead.`); return new SqlDate(Math.floor(p.ms / DAY)); }
      const ms = parseWithPattern(str(s), fmt);
      if (ms == null) throw new SqlError('CANNOT_PARSE_TIMESTAMP', `Text '${s}' could not be parsed with the pattern '${fmt}'. Use \`try_to_timestamp\` to tolerate invalid input string and return NULL instead.`);
      return new SqlDate(Math.floor(ms / DAY));
    },
    to_timestamp: (s, fmt) => {
      if (s == null) return null;
      if (isTs(s)) return s; if (isDate(s)) return new SqlTs(s.d * DAY);
      if (fmt == null) return castValue(s, { base: 'TIMESTAMP' });
      const ms = parseWithPattern(str(s), fmt);
      if (ms == null) throw new SqlError('CANNOT_PARSE_TIMESTAMP', `Text '${s}' could not be parsed with the pattern '${fmt}'. Use \`try_to_timestamp\` to tolerate invalid input string and return NULL instead.`);
      return new SqlTs(ms);
    },
    try_to_timestamp: (s, fmt) => { try { return SCALAR.to_timestamp(s, fmt); } catch (e) { return null; } },
    date_format: N((d, fmt) => formatTs(msOf(d), fmt)),
    date_trunc: N((unit, d) => new SqlTs(truncTs(msOf(d), unit))),
    trunc: N((d, unit) => new SqlDate(Math.floor(truncTs(msOf(d), unit) / DAY))),
    date_add: (d, n, x) => { if (x !== undefined) return SCALAR.dateadd(d, n, x); return d == null || n == null ? null : new SqlDate(toDate(d).d + num(n)); },
    date_sub: N((d, n) => new SqlDate(toDate(d).d - num(n))),
    dateadd: (unit, n, d) => { if (d === undefined) return SCALAR.date_add(unit, n); if (n == null || d == null) return null; const u = String(unit).toUpperCase().replace(/S$/, ''); const ms = msOf(d); if (u === 'MONTH' || u === 'QUARTER' || u === 'YEAR') { const r = new SqlTs(addMonthsMs(ms, n * (u === 'YEAR' ? 12 : u === 'QUARTER' ? 3 : 1))); return isDate(d) ? new SqlDate(Math.floor(r.ms / DAY)) : r; } if (!unitMs[u]) throw new SqlError('INVALID_PARAMETER_VALUE.DATETIME_UNIT', `The value of parameter \`unit\` is invalid: '${unit}'.`); const r = new SqlTs(ms + n * unitMs[u]); return isDate(d) && unitMs[u] % DAY === 0 ? new SqlDate(Math.floor(r.ms / DAY)) : r; },
    timestampadd: (unit, n, d) => SCALAR.dateadd(unit, n, d),
    datediff: (a, b, c) => { if (c !== undefined) return a == null || b == null || c == null ? null : dateDiffUnit(a, b, c); return a == null || b == null ? null : toDate(a).d - toDate(b).d; },
    timestampdiff: N((unit, a, b) => dateDiffUnit(unit, a, b)),
    date_diff: (a, b, c) => SCALAR.datediff(a, b, c),
    add_months: N((d, n) => new SqlDate(Math.floor(addMonthsMs(toDate(d).d * DAY, n) / DAY))),
    months_between: N((a, b) => { const x = new Date(msOf(a)), y = new Date(msOf(b)); const m = (x.getUTCFullYear() - y.getUTCFullYear()) * 12 + x.getUTCMonth() - y.getUTCMonth(); const lastX = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate() === x.getUTCDate(), lastY = new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth() + 1, 0)).getUTCDate() === y.getUTCDate(); if (x.getUTCDate() === y.getUTCDate() || (lastX && lastY)) return m; return roundHalfUp(m + (x.getUTCDate() - y.getUTCDate()) / 31 + ((x.getUTCHours() * 3600 + x.getUTCMinutes() * 60 + x.getUTCSeconds()) - (y.getUTCHours() * 3600 + y.getUTCMinutes() * 60 + y.getUTCSeconds())) / (31 * 86400), 8); }),
    last_day: N(d => { const x = new Date(toDate(d).d * DAY); return new SqlDate(Math.floor(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0) / DAY)); }),
    next_day: N((d, dow) => { const t = DAYS.findIndex(x => x.toLowerCase().startsWith(String(dow).toLowerCase().slice(0, 2))); const base = toDate(d).d; const cur = new Date(base * DAY).getUTCDay(); return new SqlDate(base + (((t - cur + 7) % 7) || 7)); }),
    year: N(d => new Date(msOf(d)).getUTCFullYear()),
    quarter: N(d => Math.floor(new Date(msOf(d)).getUTCMonth() / 3) + 1),
    month: N(d => new Date(msOf(d)).getUTCMonth() + 1),
    day: N(d => new Date(msOf(d)).getUTCDate()),
    dayofmonth: N(d => new Date(msOf(d)).getUTCDate()),
    dayofweek: N(d => new Date(msOf(d)).getUTCDay() + 1),
    weekday: N(d => (new Date(msOf(d)).getUTCDay() + 6) % 7),
    dayofyear: N(d => { const ms = msOf(d); return Math.floor((ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) / DAY) + 1; }),
    weekofyear: N(d => isoWeek(msOf(d))),
    hour: N(d => new Date(msOf(d)).getUTCHours()),
    minute: N(d => new Date(msOf(d)).getUTCMinutes()),
    second: N(d => new Date(msOf(d)).getUTCSeconds()),
    extract: N((f, d) => { const m = { YEAR: 'year', YEARS: 'year', QUARTER: 'quarter', MONTH: 'month', MONTHS: 'month', WEEK: 'weekofyear', DAY: 'day', DAYS: 'day', DAYOFWEEK: 'dayofweek', DOW: 'dayofweek', DOY: 'dayofyear', HOUR: 'hour', MINUTE: 'minute', SECOND: 'second' }[String(f).toUpperCase()]; if (!m) throw new SqlError('INVALID_PARAMETER_VALUE.DATETIME_UNIT', `The value of parameter \`field\` is invalid: '${f}'.`); return SCALAR[m](d); }),
    date_part: N((f, d) => SCALAR.extract(f, d)),
    make_date: N((y, m, d) => { const ms = Date.UTC(y, m - 1, d); if (new Date(ms).getUTCDate() !== d) throw new SqlError('DATETIME_FIELD_OUT_OF_BOUNDS', `Invalid date: ${y}-${m}-${d}.`); return new SqlDate(Math.floor(ms / DAY)); }),
    make_timestamp: N((y, mo, d, h, mi, s) => new SqlTs(Date.UTC(y, mo - 1, d, h, mi, Math.floor(s), Math.round((s % 1) * 1000)))),
    unix_timestamp: (d, fmt) => (d === undefined ? Math.floor((root.SQLX.NOW || Date.now()) / 1000) : d == null ? null : Math.floor((fmt ? parseWithPattern(str(d), fmt) : msOf(d)) / 1000)),
    from_unixtime: (n, fmt) => (n == null ? null : formatTs(num(n) * 1000, fmt || 'yyyy-MM-dd HH:mm:ss')),
    timestamp_seconds: N(n => new SqlTs(num(n) * 1000)),
    unix_date: N(d => toDate(d).d),
    date_from_unix_date: N(n => new SqlDate(n)),
    make_interval: (y, m, w, d, h, mi, s) => new Interval((y || 0) * 12 + (m || 0), (w || 0) * 7 + (d || 0), ((h || 0) * 3600 + (mi || 0) * 60 + (s || 0)) * 1000),

    /* arrays, maps and structs */
    array: (...a) => a,
    size: a => (a == null ? null : Array.isArray(a) ? a.length : a instanceof Map ? a.size : null),
    cardinality: a => (a == null ? null : Array.isArray(a) ? a.length : a instanceof Map ? a.size : null),
    array_size: N(a => a.length),
    array_contains: (a, v) => { if (a == null || v == null) return null; let sawNull = false; for (const x of a) { if (x == null) sawNull = true; else if (compare(x, v) === 0) return true; } return sawNull ? null : false; },
    element_at: (a, i) => {
      if (a == null || i == null) return null;
      if (a instanceof Map) { for (const [k, v] of a) if (compare(k, i) === 0) return v; return null; }
      if (i === 0) throw new SqlError('INVALID_INDEX_OF_ZERO', 'The index 0 is invalid. An index shall be either < 0 or > 0 (the first element has index 1).');
      const idx = i > 0 ? i - 1 : a.length + i;
      if (idx < 0 || idx >= a.length) throw new SqlError('INVALID_ARRAY_INDEX_IN_ELEMENT_AT', `The index ${i} is out of bounds. The array has ${a.length} elements. Use \`try_element_at\` to tolerate accessing element at invalid index and return NULL instead.`);
      return a[idx];
    },
    try_element_at: (a, i) => { try { return SCALAR.element_at(a, i); } catch (e) { return null; } },
    get: (a, i) => (a == null || i == null || i < 0 || i >= a.length ? null : a[i]),
    array_position: N((a, v) => { const i = a.findIndex(x => x != null && compare(x, v) === 0); return i + 1; }),
    array_distinct: N(a => uniq(a)),
    array_sort: (a, cmp) => (a == null ? null : sortArr(a, true)),
    sort_array: (a, asc) => (a == null ? null : sortArr(a, asc !== false)),
    array_join: (a, sep, nullRep) => (a == null || sep == null ? null : a.filter(x => x != null || nullRep != null).map(x => (x == null ? nullRep : str(x))).join(sep)),
    array_union: N((a, b) => uniq(a.concat(b))),
    array_intersect: N((a, b) => { const kb = new Set(b.map(keyOf)); return uniq(a.filter(x => kb.has(keyOf(x)))); }),
    array_except: N((a, b) => { const kb = new Set(b.map(keyOf)); return uniq(a.filter(x => !kb.has(keyOf(x)))); }),
    arrays_overlap: N((a, b) => { const kb = new Set(b.filter(x => x != null).map(keyOf)); return a.some(x => x != null && kb.has(keyOf(x))); }),
    array_remove: N((a, v) => a.filter(x => x == null || compare(x, v) !== 0)),
    array_append: (a, v) => (a == null ? null : a.concat([v])),
    array_prepend: (a, v) => (a == null ? null : [v].concat(a)),
    array_compact: N(a => a.filter(x => x != null)),
    array_max: N(a => SCALAR.greatest(...a)),
    array_min: N(a => SCALAR.least(...a)),
    array_repeat: N((v, n) => Array(Math.max(0, n)).fill(v)),
    slice: N((a, s, l) => { if (s === 0) throw new SqlError('INVALID_PARAMETER_VALUE.START', 'The value of parameter `start` is invalid: start must not be 0. SQL array indices start at 1.'); const st = s > 0 ? s - 1 : Math.max(a.length + s, 0); return a.slice(st, st + l); }),
    flatten: N(a => [].concat(...a.map(x => x || []))),
    arrays_zip: (...arrs) => { if (arrs.some(a => a == null)) return null; const n = Math.max(...arrs.map(a => a.length)); return Array.from({ length: n }, (_, i) => { const o = {}; arrs.forEach((a, j) => { o[String(j)] = a[i] === undefined ? null : a[i]; }); return o; }); },
    sequence: (start, stop, step) => {
      if (start == null || stop == null) return null;
      const out = [];
      if (typeof start === 'number') {
        const st = step == null ? (stop >= start ? 1 : -1) : step;
        if (st === 0 || (stop - start) * st < 0) throw new SqlError('INVALID_PARAMETER_VALUE.SEQUENCE_STEP', 'The value of parameter `step` is invalid: the step must move from start towards stop.');
        for (let v = start; st > 0 ? v <= stop : v >= stop; v += st) { out.push(v); if (out.length > 100000) break; }
        return out;
      }
      const iv = step instanceof Interval ? step : new Interval(0, 1, 0);
      let cur = isDate(start) ? start : toTs(start);
      const end = isDate(start) ? toDate(stop) : toTs(stop);
      while (compare(cur, end) <= 0) { out.push(cur); cur = addInterval(cur, iv, 1); if (out.length > 100000) break; }
      return out;
    },
    named_struct: (...a) => { const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; },
    map: (...a) => { const m = new Map(); for (let i = 0; i < a.length; i += 2) m.set(a[i], a[i + 1]); return m; },
    map_keys: N(m => Array.from(m.keys())),
    map_values: N(m => Array.from(m.values())),
    map_from_arrays: N((k, v) => { const m = new Map(); k.forEach((x, i) => m.set(x, v[i])); return m; }),
    map_from_entries: N(a => { const m = new Map(); a.forEach(e => { const v = Object.values(e); m.set(v[0], v[1]); }); return m; }),
    map_entries: N(m => Array.from(m, ([key, value]) => ({ key, value }))),
    map_contains_key: N((m, k) => Array.from(m.keys()).some(x => compare(x, k) === 0)),
    str_to_map: (s, pd, kd) => { if (s == null) return null; const m = new Map(); str(s).split(pd || ',').forEach(p => { const i = p.indexOf(kd || ':'); if (i < 0) m.set(p, null); else m.set(p.slice(0, i), p.slice(i + (kd || ':').length)); }); return m; },

    /* JSON */
    get_json_object: (js, path) => getJson(js, path),
    json_array_length: N(js => { try { const v = JSON.parse(js); return Array.isArray(v) ? v.length : null; } catch (e) { return null; } }),
    json_object_keys: N(js => { try { const v = JSON.parse(js); return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : null; } catch (e) { return null; } }),
    to_json: N(v => JSON.stringify(toJsonValue(v))),
  };
  SCALAR.substr = SCALAR.substring;

  /* Functions whose arguments are lambdas are evaluated by the engine with this helper. */
  const HIGHER_ORDER = {
    transform: (arr, f) => (arr == null ? null : arr.map((x, i) => f(x, i))),
    filter: (arr, f) => (arr == null ? null : arr.filter((x, i) => f(x, i) === true)),
    exists: (arr, f) => { if (arr == null) return null; let sawNull = false; for (let i = 0; i < arr.length; i++) { const r = f(arr[i], i); if (r === true) return true; if (r == null) sawNull = true; } return sawNull ? null : false; },
    forall: (arr, f) => { if (arr == null) return null; let sawNull = false; for (let i = 0; i < arr.length; i++) { const r = f(arr[i], i); if (r === false) return false; if (r == null) sawNull = true; } return sawNull ? null : true; },
    aggregate: (arr, init, merge, finish) => { if (arr == null) return null; let acc = init; arr.forEach(x => { acc = merge(acc, x); }); return finish ? finish(acc) : acc; },
    reduce: (arr, init, merge, finish) => HIGHER_ORDER.aggregate(arr, init, merge, finish),
    array_sort: (arr, f) => (arr == null ? null : arr.slice().sort((a, b) => f(a, b))),
    zip_with: (a, b, f) => (a == null || b == null ? null : Array.from({ length: Math.max(a.length, b.length) }, (_, i) => f(a[i] === undefined ? null : a[i], b[i] === undefined ? null : b[i]))),
    map_filter: (m, f) => { if (m == null) return null; const o = new Map(); m.forEach((v, k) => { if (f(k, v) === true) o.set(k, v); }); return o; },
    transform_values: (m, f) => { if (m == null) return null; const o = new Map(); m.forEach((v, k) => o.set(k, f(k, v))); return o; },
  };

  /* ---------- aggregates ---------- */
  const numsOf = vals => vals.filter(v => v != null).map(v => num(v));
  function percentile(vals, p) {
    const s = numsOf(vals).sort((a, b) => a - b);
    if (!s.length) return null;
    const pos = (s.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  const variance = (vals, samp) => { const s = numsOf(vals); if (s.length < (samp ? 2 : 1)) return null; const m = s.reduce((a, b) => a + b, 0) / s.length; return s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - (samp ? 1 : 0)); };
  /* Each aggregate receives the list of argument tuples for its group (after FILTER and DISTINCT). */
  const AGG = {
    count: (rows, star) => (star ? rows.length : rows.filter(r => r.every(v => v != null)).length),
    sum: rows => { const v = numsOf(rows.map(r => r[0])); return v.length ? v.reduce((a, b) => a + b, 0) : null; },
    avg: rows => { const v = numsOf(rows.map(r => r[0])); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; },
    min: rows => { let m = null; rows.forEach(r => { if (r[0] != null && (m == null || compare(r[0], m) < 0)) m = r[0]; }); return m; },
    max: rows => { let m = null; rows.forEach(r => { if (r[0] != null && (m == null || compare(r[0], m) > 0)) m = r[0]; }); return m; },
    count_if: rows => rows.filter(r => r[0] === true).length,
    bool_or: rows => { const v = rows.map(r => r[0]).filter(x => x != null); return v.length ? v.some(x => x) : null; },
    bool_and: rows => { const v = rows.map(r => r[0]).filter(x => x != null); return v.length ? v.every(x => x) : null; },
    max_by: rows => { let best = null, bv = null; rows.forEach(r => { if (r[1] != null && (bv == null || compare(r[1], bv) > 0)) { bv = r[1]; best = r[0]; } }); return best; },
    min_by: rows => { let best = null, bv = null; rows.forEach(r => { if (r[1] != null && (bv == null || compare(r[1], bv) < 0)) { bv = r[1]; best = r[0]; } }); return best; },
    collect_list: rows => rows.map(r => r[0]).filter(v => v != null),
    collect_set: rows => uniq(rows.map(r => r[0]).filter(v => v != null)),
    first: (rows, star, ignoreNulls) => { for (const r of rows) if (!ignoreNulls || r[0] != null) return r[0]; return null; },
    last: (rows, star, ignoreNulls) => { for (let i = rows.length - 1; i >= 0; i--) if (!ignoreNulls || rows[i][0] != null) return rows[i][0]; return null; },
    any_value: rows => { for (const r of rows) if (r[0] != null) return r[0]; return null; },
    approx_count_distinct: rows => new Set(rows.filter(r => r[0] != null).map(r => keyOf(r[0]))).size,
    median: rows => percentile(rows.map(r => r[0]), 0.5),
    percentile: rows => (rows.length ? percentile(rows.map(r => r[0]), rows[0][1]) : null),
    percentile_approx: rows => { const s = numsOf(rows.map(r => r[0])).sort((a, b) => a - b); if (!s.length) return null; const p = rows[0][1]; const idx = Math.max(0, Math.ceil(p * s.length) - 1); return s[idx]; },
    stddev: rows => { const v = variance(rows.map(r => r[0]), true); return v == null ? null : Math.sqrt(v); },
    stddev_pop: rows => { const v = variance(rows.map(r => r[0]), false); return v == null ? null : Math.sqrt(v); },
    variance: rows => variance(rows.map(r => r[0]), true),
    var_pop: rows => variance(rows.map(r => r[0]), false),
    corr: rows => { const p = rows.filter(r => r[0] != null && r[1] != null).map(r => [num(r[0]), num(r[1])]); if (p.length < 2) return null; const mx = p.reduce((a, r) => a + r[0], 0) / p.length, my = p.reduce((a, r) => a + r[1], 0) / p.length; let sxy = 0, sxx = 0, syy = 0; p.forEach(([x, y]) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }); return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null; },
    string_agg: rows => { const v = rows.filter(r => r[0] != null); return v.length ? v.map(r => str(r[0])).join(rows[0][1] == null ? '' : rows[0][1]) : null; },
    percentile_cont: rows => (rows.length ? percentile(rows.map(r => r[1]), rows[0][0]) : null),
    percentile_disc: rows => { const s = numsOf(rows.map(r => r[1])).sort((a, b) => a - b); if (!s.length) return null; return s[Math.max(0, Math.ceil(rows[0][0] * s.length) - 1)]; },
  };
  Object.assign(AGG, { mean: AGG.avg, array_agg: AGG.collect_list, some: AGG.bool_or, any: AGG.bool_or, every: AGG.bool_and, first_value: AGG.first, last_value: AGG.last, stddev_samp: AGG.stddev, std: AGG.stddev, var_samp: AGG.variance, listagg: AGG.string_agg, count_distinct: AGG.count });

  const WINDOW_ONLY = new Set(['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'nth_value']);
  const GENERATORS = new Set(['explode', 'explode_outer', 'posexplode', 'posexplode_outer', 'inline', 'inline_outer']);

  Object.assign(root.SQLX, {
    SqlDate, SqlTs, Interval, DAY, isDate, isTs, isStruct, typeOf, typeName, castValue, compare, keyOf, toStr, fmtNum, num, str, toDate, toTs,
    arith, likeRe, javaRe, SCALAR, HIGHER_ORDER, AGG, WINDOW_ONLY, GENERATORS, roundHalfUp, getJson, parseDateStr, formatTs,
  });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : global);
