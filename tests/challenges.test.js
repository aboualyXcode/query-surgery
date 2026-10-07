#!/usr/bin/env node
/* Every challenge must be sound:
   rewrite challenges: the slow query misses the target (or times out); the solution and the alternative return
   exactly the slow query's result (when it finishes) and meet the target; rewrites that cheat are rejected.
   index challenges: no change misses the target; the solution and alternative meet it within budget; traps fail.
   Usage: node tests/challenges.test.js [id] */
'use strict';
const path = require('path');
global.window = undefined;
['sql/parser', 'sql/functions', 'sql/engine', 'data', 'challenges'].forEach(f => require(path.join(__dirname, '..', 'js', f + '.js')));
const X = global.SQLX, S = X.surgery;
const only = process.argv[2];
let checks = 0, failures = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.log('  FAIL ' + m); } };
const ids = new Set();
for (const c of X.CHALLENGES) {
  if (only && c.id !== only) continue;
  ok(!ids.has(c.id), `${c.id}: unique id`); ids.add(c.id);
  ok(X.TRACKS.some(t => t.id === c.track), `${c.id}: known track`);
  ok(typeof c.target === 'number' && c.target > 0, `${c.id}: has a target`);
  if (c.mode === 'rewrite') {
    const slow = S.grade(c, c.slow);
    ok(!slow.ok, `${c.id}: the slow query misses the target (${slow.work != null ? X.fmtWork(slow.work) : slow.error})`);
    const db = S.prepared(c);
    let slowRows = null;
    try { slowRows = S.runQuery(db, c.slow).rows; } catch (e) { ok(/statement timeout/.test(e.message), `${c.id}: the slow query either finishes or times out (${e.message.slice(0, 60)})`); }
    const exp = S.expected(c);
    if (slowRows) ok(S.sameRows(slowRows, exp.rows, c.ordered), `${c.id}: the solution returns exactly the slow query's result`);
    const sol = S.grade(c, c.solution), alt = S.grade(c, c.alt);
    ok(sol.ok, `${c.id}: the solution passes (${sol.message || sol.error})`);
    ok(alt.ok, `${c.id}: the alternative passes (${alt.message || alt.error})`);
    ok(!S.grade(c, 'CREATE INDEX cheat ON orders (order_id); ' + c.slow).ok, `${c.id}: schema changes are refused in a rewrite challenge`);
    ok(!S.grade(c, c.solution.replace(/SELECT/i, 'SELECT DISTINCT 1 AS wrong,')).ok, `${c.id}: a different result is rejected`);
  } else {
    const none = S.grade(c, c.starter || '');
    ok(!none.ok, `${c.id}: changing nothing misses the target (${X.fmtWork(none.total || 0)})`);
    const sol = S.grade(c, c.solution), alt = S.grade(c, c.alt);
    ok(sol.ok, `${c.id}: the solution passes (${sol.message || sol.error})`);
    ok(alt.ok, `${c.id}: the alternative passes (${alt.message || alt.error})`);
    (c.traps || []).forEach(t => { const g = S.grade(c, t); ok(!g.ok, `${c.id}: trap rejected: ${t.slice(0, 70)} (${g.message || g.error})`); });
    ok(!S.grade(c, 'SELECT 1').ok, `${c.id}: queries are refused in an index challenge`);
  }
  if (!only) process.stdout.write('.');
}
console.log(`\n${ids.size} challenges in ${X.TRACKS.length} tracks.`);
console.log(failures ? `${failures} of ${checks} checks failed` : `All ${checks} checks passed.`);
process.exit(failures ? 1 : 0);
