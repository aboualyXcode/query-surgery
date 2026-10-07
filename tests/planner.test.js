#!/usr/bin/env node
/* The planner's behaviour, which the challenges rely on. Usage: node tests/planner.test.js */
'use strict';
const path = require('path');
global.window = undefined;
['sql/parser', 'sql/functions', 'sql/engine', 'data'].forEach(f => require(path.join(__dirname, '..', 'js', f + '.js')));
const X = global.SQLX;
const db = X.dataset.load(new X.Database());
db.timeout = Infinity;
db.execute(`CREATE INDEX o_cust ON orders (customer_id); CREATE INDEX o_ts ON orders (order_ts); CREATE INDEX o_status_ts ON orders (status, order_ts);
CREATE INDEX c_code ON customers (customer_code); CREATE INDEX c_email ON customers (email); CREATE INDEX o_cust_cover ON orders (customer_id) INCLUDE (total_amount);
CREATE INDEX o_placed ON orders (order_ts) WHERE status = 'PLACED'`);
db.timeout = 5e6;
let checks = 0, failures = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.log('  FAIL ' + m); } };
const plan = sql => db.execute('EXPLAIN ANALYZE ' + sql)[0].rows.map(r => r[0]).join('\n');
const work = sql => db.execute(sql)[0].work;

console.log('Sargable and non-sargable predicates');
ok(/Index Scan using o_cust|Index Only Scan using o_cust/.test(plan('SELECT order_id FROM orders WHERE customer_id = 17')), 'equality uses an index');
ok(/Seq Scan on orders[\s\S]*wraps the column in an expression/.test(plan('SELECT order_id FROM orders WHERE year(order_ts) = 2025')), 'a function on the column forces a scan, with a note');
ok(/Index Scan using o_ts/.test(plan("SELECT order_id FROM orders WHERE order_ts >= TIMESTAMP '2026-07-01 00:00:00'")), 'a range uses the index');
ok(/Seq Scan on customers[\s\S]*compares a text column with a number/.test(plan('SELECT * FROM customers WHERE customer_code = 42')), 'text column = number is not sargable');
ok(/Index Scan using c_code/.test(plan("SELECT * FROM customers WHERE customer_code = '0000042'")), 'text column = text uses the index');
ok(/Index Scan using c_email/.test(plan("SELECT * FROM customers WHERE email LIKE 'amara.%'")), 'LIKE with a prefix uses the index');
ok(/Seq Scan[\s\S]*starts with a wildcard/.test(plan("SELECT * FROM customers WHERE email LIKE '%@example.com'")), 'a leading wildcard does not');
ok(/Seq Scan[\s\S]*OR across conditions/.test(plan('SELECT order_id FROM orders WHERE customer_id = 17 OR event_id = 4')), 'OR across columns does not use an index range');
ok(/Index Scan using o_cust|Index Only Scan using o_cust/.test(plan('SELECT order_id FROM orders WHERE customer_id IN (17, 18, 19)')), 'IN lists use multiple seeks');

console.log('Covering, ordered and partial indexes');
ok(/Index Only Scan using o_cust_cover/.test(plan('SELECT customer_id, total_amount FROM orders WHERE customer_id = 7')), 'a covering index gives an index-only scan');
ok(/Index Scan using o_cust/.test(plan('SELECT * FROM orders WHERE customer_id = 7')) && !/Index Only/.test(plan('SELECT * FROM orders WHERE customer_id = 7')), 'SELECT * cannot be index-only');
const topn = plan('SELECT order_id, order_ts FROM orders ORDER BY order_ts DESC LIMIT 10');
ok(/Sort \(skipped/.test(topn) && /rows=10 loops=1/.test(topn), 'top-N walks the index backwards and stops after 10 rows');
ok(/Sort Key/.test(plan('SELECT order_id FROM orders ORDER BY total_amount LIMIT 10')) && !/skipped/.test(plan('SELECT order_id FROM orders ORDER BY total_amount LIMIT 10')), 'without a matching index, the rows are sorted');
ok(/using o_placed/.test(plan("SELECT order_id FROM orders WHERE status = 'PLACED' ORDER BY order_ts LIMIT 5")), 'a partial index is used by a query with its condition');
ok(!/using o_placed/.test(plan("SELECT order_id FROM orders WHERE status = 'PAID' ORDER BY order_ts LIMIT 5")), 'and not by other queries');
ok(work("SELECT order_id FROM orders WHERE status = 'REFUNDED' AND order_ts >= TIMESTAMP '2026-01-01 00:00:00'") < work("SELECT order_id FROM orders WHERE order_ts >= TIMESTAMP '2026-01-01 00:00:00'"), 'equality-then-range composite beats the range alone');
const keyset = work('SELECT log_id FROM activity_log WHERE log_id > 100000 ORDER BY log_id LIMIT 50'), offset = work('SELECT log_id FROM activity_log ORDER BY log_id LIMIT 50 OFFSET 100000');
ok(keyset * 100 < offset, `keyset pagination is far cheaper than OFFSET (${X.fmtWork(keyset)} vs ${X.fmtWork(offset)})`);

console.log('Joins, subqueries and early termination');
ok(/Nested Loop[\s\S]*Index (Only )?Scan using o_cust/.test(plan('SELECT c.full_name, o.order_id FROM customers c JOIN orders o ON o.customer_id = c.customer_id WHERE c.customer_id < 10')), 'a small outer side uses an index nested loop');
ok(/Hash Join/.test(plan('SELECT c.country, SUM(o.event_id) FROM customers c JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.country')), 'a large join that needs uncovered columns uses a hash join');
ok(/Hashed SubPlan/.test(plan("SELECT COUNT(*) FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id AND o.status = 'REFUNDED')")), 'a correlated EXISTS becomes a hashed semi-join');
ok(/SubPlan 1 \(runs=5000\)/.test(plan('SELECT c.customer_id, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.customer_id) AS n FROM customers c')), 'a scalar subquery in SELECT runs once per row');
ok(work("SELECT EXISTS (SELECT 1 FROM activity_log WHERE action = 'checkout')") < 100, 'an uncorrelated EXISTS stops at the first match');
const lj = db.execute("SELECT COUNT(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id AND o.status = 'REFUNDED' WHERE c.country = 'KE'")[0].rows[0][0];
const lj2 = db.execute("SELECT COUNT(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id WHERE c.country = 'KE' AND (o.status = 'REFUNDED' OR o.status IS NULL)")[0].rows[0][0];
ok(lj >= lj2, 'ON conditions are pushed into the right side of a LEFT JOIN without losing unmatched rows');
const wnull = db.execute("SELECT COUNT(*) FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id WHERE o.order_id IS NULL")[0].rows[0][0];
const anti = db.execute("SELECT COUNT(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)")[0].rows[0][0];
ok(wnull === anti, 'a WHERE filter on the nullable side of a LEFT JOIN is not pushed below the join');

console.log('Timeouts and index validation');
let err = null; try { db.execute('SELECT COUNT(*) FROM activity_log a JOIN customers b ON b.customer_id <= a.customer_id'); } catch (e) { err = e; }
ok(err && err.cls === 'QUERY_CANCELED', 'a runaway query hits the statement timeout');
err = null; try { db.execute('CREATE UNIQUE INDEX bad ON orders (customer_id)'); } catch (e) { err = e; } ok(err && err.cls === 'UNIQUE_CONSTRAINT_VIOLATION', 'a unique index on duplicate values is refused');
err = null; try { db.execute('CREATE INDEX bad ON orders (no_such_column)'); } catch (e) { err = e; } ok(err && /does not exist/.test(err.message), 'unknown index columns are refused');
const fork = db.fork(); err = null; try { fork.execute('DELETE FROM orders'); } catch (e) { err = e; } ok(err && err.cls === 'READ_ONLY', 'the lab database is read-only');
console.log(failures ? `\n${failures} of ${checks} checks failed` : `\nAll ${checks} checks passed.`);
process.exit(failures ? 1 : 0);
