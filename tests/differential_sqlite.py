#!/usr/bin/env python3
"""Differential test: run the same queries on the lab's JavaScript engine and on SQLite, over the
same Stagedoor dataset, and require identical results. Every query runs twice on the engine, without
and with a set of indexes, so index access paths, index nested loops and pushdown are checked too. Covers the large subset of SQL both dialects
share; queries whose spelling differs carry a SQLite-specific version.

Usage: python3 tests/differential_sqlite.py      (needs Node.js; uses Python's built-in sqlite3)
"""
import json, os, sqlite3, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (id, databricks_sql, sqlite_sql_or_None, ordered)
Q = [
  # --- filtering, projection, sorting
  ("filter", "SELECT customer_id, full_name, city FROM customers WHERE country = 'DE' AND loyalty_tier IN ('Gold','Platinum')", None, False),
  ("order_nulls", "SELECT customer_id, referred_by FROM customers ORDER BY referred_by DESC NULLS LAST, customer_id LIMIT 15", None, True),
  ("order_nulls_first", "SELECT customer_id, email FROM customers ORDER BY email NULLS FIRST, customer_id LIMIT 6", None, True),
  ("between", "SELECT order_id FROM orders WHERE order_ts BETWEEN '2025-06-01 00:00:00' AND '2025-06-30 23:59:59' ORDER BY order_id", None, True),
  ("distinct", "SELECT DISTINCT country, loyalty_tier FROM customers", None, False),
  ("limit_offset", "SELECT order_id FROM orders ORDER BY order_id LIMIT 5 OFFSET 10", None, True),
  ("case", "SELECT order_id, CASE WHEN status = 'PAID' THEN 'revenue' WHEN status IN ('CANCELLED','REFUNDED') THEN 'lost' ELSE 'pending' END AS bucket FROM orders WHERE order_id < 10050", None, False),
  ("simple_case", "SELECT event_id, CASE genre WHEN 'Rock' THEN 1 WHEN 'Metal' THEN 1 ELSE 0 END AS loud FROM events", None, False),
  ("coalesce", "SELECT customer_id, COALESCE(email, 'missing') AS email FROM customers WHERE customer_id % 29 = 0", None, False),
  ("nullif", "SELECT order_id, NULLIF(channel, 'web') AS ch FROM orders WHERE order_id < 10020", None, False),
  # Spark rounds the decimal representation of a double half-up (round(186.235, 2) = 186.24); SQLite rounds the
  # binary value (186.23). The engine follows Spark, so SQLite gets a nudge to compare like for like.
  ("arith", "SELECT order_id, line_no, quantity * unit_price AS total, ROUND(quantity * unit_price * 1.19, 2) AS gross FROM order_items WHERE order_id < 10030", "SELECT order_id, line_no, quantity * unit_price AS total, ROUND(quantity * unit_price * 1.19 + 1e-9, 2) AS gross FROM order_items WHERE order_id < 10030", False),
  ("division", "SELECT event_id, base_price / 3 AS third FROM events", "SELECT event_id, base_price / 3.0 AS third FROM events", False),
  ("int_division", "SELECT order_id, quantity DIV 2 AS pairs FROM order_items WHERE order_id < 10020", "SELECT order_id, quantity / 2 AS pairs FROM order_items WHERE order_id < 10020", False),
  ("modulo", "SELECT customer_id, customer_id % 7 AS bucket FROM customers WHERE customer_id < 30", None, False),
  ("is_null", "SELECT COUNT(*) FROM customers WHERE email IS NULL", None, False),
  ("is_not_null", "SELECT COUNT(*) FROM orders WHERE promo_code IS NOT NULL", None, False),
  ("distinct_from", "SELECT COUNT(*) FROM orders WHERE promo_code IS DISTINCT FROM 'SPRING10'", None, False),
  ("not_distinct", "SELECT COUNT(*) FROM orders WHERE promo_code IS NOT DISTINCT FROM NULL", None, False),
  ("like", "SELECT customer_id FROM customers WHERE full_name LIKE 'A%' AND full_name LIKE '%a %'", "SELECT customer_id FROM customers WHERE full_name GLOB 'A*' AND full_name GLOB '*a *'", False),
  ("like_underscore", "SELECT name FROM venues WHERE name LIKE '_e%'", "SELECT name FROM venues WHERE name GLOB '?e*'", False),
  ("strings", "SELECT customer_id, UPPER(city), LOWER(country), LENGTH(full_name), SUBSTRING(full_name, 1, 3), REPLACE(full_name, ' ', '_') FROM customers WHERE customer_id < 15", "SELECT customer_id, UPPER(city), LOWER(country), LENGTH(full_name), SUBSTR(full_name, 1, 3), REPLACE(full_name, ' ', '_') FROM customers WHERE customer_id < 15", False),
  ("concat_op", "SELECT customer_id, city || ', ' || country AS loc FROM customers WHERE customer_id < 12", None, False),
  ("trim", "SELECT signup_id, TRIM(email) FROM raw_signups", None, False),
  ("substring_neg", "SELECT name, SUBSTRING(name, -4) FROM venues", "SELECT name, SUBSTR(name, -4) FROM venues", False),
  ("instr", "SELECT name, INSTR(name, 'a') FROM venues", None, False),
  ("cast_int", "SELECT CAST(base_price AS INT), CAST('42' AS INT) + 1 FROM events WHERE event_id < 106", "SELECT CAST(base_price AS INTEGER), CAST('42' AS INTEGER) + 1 FROM events WHERE event_id < 106", False),
  ("abs_round", "SELECT ROUND(AVG(base_price), 2), ABS(MIN(base_price) - MAX(base_price)) FROM events", None, False),
  ("in_list_null", "SELECT COUNT(*) FROM customers WHERE referred_by IN (1, 2, NULL)", None, False),
  ("not_in_null", "SELECT COUNT(*) FROM customers WHERE customer_id NOT IN (SELECT referred_by FROM customers)", None, False),
  ("not_in_filtered", "SELECT COUNT(*) FROM customers WHERE customer_id NOT IN (SELECT referred_by FROM customers WHERE referred_by IS NOT NULL)", None, False),
  # --- aggregation
  ("count_star_col", "SELECT COUNT(*), COUNT(email), COUNT(DISTINCT city), COUNT(DISTINCT country) FROM customers", None, False),
  ("group_basic", "SELECT status, COUNT(*) AS n FROM orders GROUP BY status", None, False),
  ("group_multi", "SELECT channel, status, COUNT(*) FROM orders GROUP BY channel, status", None, False),
  ("group_ordinal", "SELECT channel, COUNT(*) FROM orders GROUP BY 1", None, False),
  ("group_expr", "SELECT customer_id % 3 AS b, SUM(customer_id) FROM customers GROUP BY customer_id % 3", None, False),
  ("having", "SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id HAVING COUNT(*) >= 12", None, False),
  ("sum_avg_min_max", "SELECT event_id, SUM(quantity), AVG(quantity), MIN(unit_price), MAX(unit_price) FROM order_items JOIN orders USING (order_id) GROUP BY event_id", None, False),
  ("filter_clause", "SELECT channel, COUNT(*) FILTER (WHERE status = 'PAID') AS paid, COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled FROM orders GROUP BY channel", None, False),
  ("sum_case", "SELECT channel, SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) FROM orders GROUP BY channel", None, False),
  ("empty_agg", "SELECT COUNT(*), SUM(amount), MAX(amount) FROM payments WHERE amount < 0", None, False),
  ("empty_group", "SELECT method, COUNT(*) FROM payments WHERE amount < 0 GROUP BY method", None, False),
  ("agg_distinct_sum", "SELECT SUM(DISTINCT quantity), COUNT(DISTINCT ticket_type) FROM order_items", None, False),
  ("group_null_key", "SELECT promo_code, COUNT(*) FROM orders GROUP BY promo_code", None, False),
  ("avg_nulls", "SELECT AVG(referred_by), COUNT(referred_by) FROM customers", None, False),
  # --- joins
  ("inner_join", "SELECT o.order_id, c.full_name, e.artist FROM orders o JOIN customers c ON c.customer_id = o.customer_id JOIN events e ON e.event_id = o.event_id WHERE o.order_id < 10040", None, False),
  ("left_join_nulls", "SELECT c.customer_id, COUNT(o.order_id) AS orders FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.customer_id", None, False),
  ("left_join_anti_pattern", "SELECT c.customer_id FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id WHERE o.order_id IS NULL", None, False),
  ("left_join_on_filter", "SELECT c.customer_id, COUNT(o.order_id) FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id AND o.status = 'REFUNDED' GROUP BY c.customer_id", None, False),
  ("using", "SELECT order_id, orders.status, amount FROM orders JOIN payments USING (order_id) WHERE order_id < 10050", None, False),
  ("ambiguous_rejected", "SELECT order_id, status FROM orders JOIN payments USING (order_id)", None, False),
  ("self_join", "SELECT e.name, m.name AS manager FROM employees e LEFT JOIN employees m ON m.employee_id = e.manager_id", None, False),
  ("non_equi_join", "SELECT o.order_id, f.usd_rate FROM orders o JOIN fx_rates f ON f.currency = 'EUR' AND o.order_ts >= f.valid_from AND o.order_ts < f.valid_to WHERE o.order_id < 10030", "SELECT o.order_id, f.usd_rate FROM orders o JOIN fx_rates f ON f.currency = 'EUR' AND substr(o.order_ts,1,10) >= f.valid_from AND substr(o.order_ts,1,10) < f.valid_to WHERE o.order_id < 10030", False),
  ("cross_join", "SELECT COUNT(*) FROM venues CROSS JOIN (SELECT DISTINCT genre FROM events) g", None, False),
  ("full_join", "SELECT p.order_id AS paid, r.order_id AS refunded FROM (SELECT DISTINCT order_id FROM payments WHERE order_id < 10100) p FULL OUTER JOIN (SELECT order_id FROM refunds WHERE order_id < 10100 OR order_id = 99999) r ON p.order_id = r.order_id", None, False),
  ("right_join", "SELECT r.refund_id, o.status FROM orders o RIGHT JOIN refunds r ON r.order_id = o.order_id", None, False),
  ("join_fanout", "SELECT o.order_id, SUM(p.amount) AS paid, COUNT(*) AS n FROM orders o JOIN payments p ON p.order_id = o.order_id GROUP BY o.order_id HAVING COUNT(*) > 1", None, False),
  ("multi_condition_join", "SELECT COUNT(*) FROM orders o JOIN payments p ON p.order_id = o.order_id AND p.status = 'SETTLED' AND o.status = 'PAID'", None, False),
  # --- subqueries
  ("scalar_subq", "SELECT event_id, base_price, base_price - (SELECT AVG(base_price) FROM events) AS diff FROM events", None, False),
  ("correlated_scalar", "SELECT c.customer_id, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.customer_id) AS n FROM customers c", None, False),
  ("correlated_max", "SELECT o.order_id, o.customer_id FROM orders o WHERE o.order_ts = (SELECT MAX(i.order_ts) FROM orders i WHERE i.customer_id = o.customer_id)", None, False),
  ("exists", "SELECT c.customer_id FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id AND o.status = 'REFUNDED')", None, False),
  ("not_exists", "SELECT c.customer_id FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)", None, False),
  ("in_subq", "SELECT event_id FROM events WHERE venue_id IN (SELECT venue_id FROM venues WHERE capacity > 3000)", None, False),
  ("derived_table", "SELECT tier, AVG(n) FROM (SELECT c.loyalty_tier AS tier, c.customer_id, COUNT(o.order_id) AS n FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.loyalty_tier, c.customer_id) t GROUP BY tier", None, False),
  ("having_subq", "SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id HAVING COUNT(*) > (SELECT AVG(n) FROM (SELECT COUNT(*) AS n FROM orders GROUP BY customer_id) x)", None, False),
  # --- CTEs and set operations
  ("cte", "WITH paid AS (SELECT * FROM orders WHERE status = 'PAID'), per_c AS (SELECT customer_id, COUNT(*) AS n FROM paid GROUP BY customer_id) SELECT n, COUNT(*) FROM per_c GROUP BY n", None, False),
  ("cte_reuse", "WITH t AS (SELECT event_id, COUNT(*) AS n FROM orders GROUP BY event_id) SELECT a.event_id FROM t a WHERE a.n = (SELECT MAX(n) FROM t)", None, False),
  ("recursive_org", "WITH RECURSIVE chain(employee_id, name, depth) AS (SELECT employee_id, name, 0 FROM employees WHERE manager_id IS NULL UNION ALL SELECT e.employee_id, e.name, c.depth + 1 FROM employees e JOIN chain c ON e.manager_id = c.employee_id) SELECT depth, COUNT(*) FROM chain GROUP BY depth", None, False),
  ("recursive_numbers", "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12) SELECT SUM(i), MAX(i) FROM n", None, False),
  ("union_all", "SELECT customer_id FROM orders WHERE status = 'REFUNDED' UNION ALL SELECT customer_id FROM support_tickets WHERE priority = 'urgent'", None, False),
  ("union", "SELECT city FROM customers UNION SELECT city FROM venues", None, False),
  ("intersect", "SELECT customer_id FROM orders INTERSECT SELECT customer_id FROM support_tickets", None, False),
  ("except", "SELECT customer_id FROM customers EXCEPT SELECT customer_id FROM orders", None, False),
  ("union_order", "SELECT name AS n FROM venues UNION SELECT artist FROM events ORDER BY n LIMIT 8", None, True),
  # --- window functions
  ("row_number", "SELECT order_id, customer_id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_ts, order_id) AS rn FROM orders", None, False),
  ("rank_dense", "SELECT event_id, base_price, RANK() OVER (ORDER BY base_price DESC) AS r, DENSE_RANK() OVER (ORDER BY base_price DESC) AS dr FROM events", None, False),
  ("running_sum", "SELECT order_id, paid_ts, SUM(amount) OVER (ORDER BY paid_ts, payment_id) AS running FROM payments", None, False),
  ("running_range_peers", "SELECT payment_id, SUM(amount) OVER (ORDER BY method) AS s FROM payments", None, False),
  ("moving_avg_rows", "SELECT snapshot_date, event_id, AVG(seats_remaining) OVER (PARTITION BY event_id ORDER BY snapshot_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS ma FROM seat_inventory", None, False),
  ("following_frame", "SELECT snapshot_date, event_id, SUM(seats_remaining) OVER (PARTITION BY event_id ORDER BY snapshot_date ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS s FROM seat_inventory", None, False),
  ("whole_partition", "SELECT order_id, quantity, SUM(quantity) OVER (PARTITION BY order_id) AS total, 1.0 * quantity / SUM(quantity) OVER (PARTITION BY order_id) AS share FROM order_items", None, False),
  ("lag_lead", "SELECT event_id, snapshot_date, seats_remaining - LAG(seats_remaining) OVER (PARTITION BY event_id ORDER BY snapshot_date) AS delta, LEAD(snapshot_date) OVER (PARTITION BY event_id ORDER BY snapshot_date) AS next_day FROM seat_inventory", None, False),
  ("lag_default", "SELECT employee_id, LAG(salary, 2, 0) OVER (ORDER BY employee_id) FROM employees", None, False),
  ("first_last_value", "SELECT event_id, snapshot_date, FIRST_VALUE(seats_remaining) OVER w AS first_s, LAST_VALUE(seats_remaining) OVER (PARTITION BY event_id ORDER BY snapshot_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_s FROM seat_inventory WINDOW w AS (PARTITION BY event_id ORDER BY snapshot_date)", "SELECT event_id, snapshot_date, FIRST_VALUE(seats_remaining) OVER w AS first_s, LAST_VALUE(seats_remaining) OVER (PARTITION BY event_id ORDER BY snapshot_date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_s FROM seat_inventory WINDOW w AS (PARTITION BY event_id ORDER BY snapshot_date)", False),
  ("ntile", "SELECT customer_id, NTILE(4) OVER (ORDER BY customer_id) FROM customers", None, False),
  ("percent_rank_cume", "SELECT employee_id, PERCENT_RANK() OVER (ORDER BY salary), CUME_DIST() OVER (ORDER BY salary) FROM employees", None, False),
  ("window_on_agg", "SELECT channel, COUNT(*) AS n, SUM(COUNT(*)) OVER () AS total, RANK() OVER (ORDER BY COUNT(*) DESC) AS r FROM orders GROUP BY channel", None, False),
  ("top_n_per_group", "SELECT * FROM (SELECT event_id, customer_id, COUNT(*) AS n, ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY COUNT(*) DESC, customer_id) AS rn FROM orders GROUP BY event_id, customer_id) WHERE rn <= 2", None, False),
  ("count_window", "SELECT order_id, COUNT(*) OVER (PARTITION BY customer_id) FROM orders WHERE order_id < 10100", None, False),
  ("gaps_islands", "SELECT event_id, MIN(snapshot_date), MAX(snapshot_date), COUNT(*) FROM (SELECT event_id, snapshot_date, date_add(snapshot_date, -ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY snapshot_date)) AS grp FROM seat_inventory) GROUP BY event_id, grp", "SELECT event_id, MIN(snapshot_date), MAX(snapshot_date), COUNT(*) FROM (SELECT event_id, snapshot_date, date(snapshot_date, '-' || ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY snapshot_date) || ' days') AS grp FROM seat_inventory) GROUP BY event_id, grp", False),
  # --- dates
  ("month_trunc", "SELECT date_format(order_ts, 'yyyy-MM') AS m, COUNT(*) FROM orders GROUP BY 1", "SELECT strftime('%Y-%m', order_ts) AS m, COUNT(*) FROM orders GROUP BY 1", False),
  ("datediff", "SELECT ticket_id, datediff(closed_ts, opened_ts) FROM support_tickets", "SELECT ticket_id, CAST(julianday(substr(closed_ts,1,10)) - julianday(substr(opened_ts,1,10)) AS INTEGER) FROM support_tickets", False),
  ("year_month_fns", "SELECT YEAR(signup_date), MONTH(signup_date), COUNT(*) FROM customers GROUP BY 1, 2", "SELECT CAST(strftime('%Y', signup_date) AS INTEGER), CAST(strftime('%m', signup_date) AS INTEGER), COUNT(*) FROM customers GROUP BY 1, 2", False),
  ("date_compare", "SELECT COUNT(*) FROM events WHERE event_date >= DATE'2026-01-01'", "SELECT COUNT(*) FROM events WHERE event_date >= '2026-01-01'", False),
  ("date_add_fn", "SELECT event_id, date_add(event_date, 7) FROM events", "SELECT event_id, date(event_date, '+7 days') FROM events", False),
  ("hours_between", "SELECT ticket_id, (unix_timestamp(closed_ts) - unix_timestamp(opened_ts)) / 3600 AS hrs FROM support_tickets WHERE closed_ts IS NOT NULL", "SELECT ticket_id, (strftime('%s', closed_ts) - strftime('%s', opened_ts)) / 3600.0 AS hrs FROM support_tickets WHERE closed_ts IS NOT NULL", False),
  # --- JSON
  ("json_extract", "SELECT event_seq, get_json_object(payload, '$.event'), get_json_object(payload, '$.device.os') FROM app_events", "SELECT event_seq, json_extract(payload, '$.event'), json_extract(payload, '$.device.os') FROM app_events", False),
  ("json_colon", "SELECT payload:event AS ev, COUNT(*) FROM app_events GROUP BY 1", "SELECT json_extract(payload, '$.event') AS ev, COUNT(*) FROM app_events GROUP BY 1", False),
  # --- DML round trips (compare final state)
  ("dml_update", "CREATE TABLE t AS SELECT customer_id, loyalty_tier FROM customers; UPDATE t SET loyalty_tier = 'Gold' WHERE loyalty_tier = 'Silver' AND customer_id < 50; SELECT loyalty_tier, COUNT(*) FROM t GROUP BY 1", None, False),
  ("dml_delete", "CREATE TABLE t2 AS SELECT * FROM payments; DELETE FROM t2 WHERE status = 'FAILED'; SELECT COUNT(*), SUM(amount) FROM t2", None, False),
  ("dml_insert_select", "CREATE TABLE t3 (k STRING, n INT); INSERT INTO t3 SELECT channel, COUNT(*) FROM orders GROUP BY channel; INSERT INTO t3 VALUES ('manual', 1); SELECT * FROM t3", "CREATE TABLE t3 (k TEXT, n INTEGER); INSERT INTO t3 SELECT channel, COUNT(*) FROM orders GROUP BY channel; INSERT INTO t3 VALUES ('manual', 1); SELECT * FROM t3", False),
]

def node_results(queries):
  script = r"""
const fs = require('fs');
global.window = undefined;
['parser','functions','engine'].forEach(f => require(process.argv[1] + '/js/sql/' + f + '.js'));
require(process.argv[1] + '/tests/fixtures/stagedoor-small.js');
const X = global.SQLX;
const qs = JSON.parse(fs.readFileSync(0, 'utf8'));
const norm = v => v == null ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v instanceof X.SqlDate || v instanceof X.SqlTs) ? String(v) : v;
const out = { data: X.dataset.build().map(t => ({ name: t.name, cols: t.cols, rows: t.rows })), results: {} };
const INDEXES = `CREATE INDEX i1 ON orders (customer_id); CREATE INDEX i2 ON orders (status, order_ts); CREATE INDEX i3 ON orders (order_ts);
CREATE INDEX i4 ON customers (country, city) INCLUDE (customer_id); CREATE INDEX i5 ON payments (order_id); CREATE INDEX i6 ON order_items (order_id, line_no);
CREATE INDEX i7 ON refunds (order_id); CREATE INDEX i8 ON employees (manager_id); CREATE INDEX i9 ON seat_inventory (event_id, snapshot_date);
CREATE INDEX i10 ON events (venue_id); CREATE INDEX i11 ON customers (referred_by); CREATE INDEX i12 ON support_tickets (customer_id) WHERE priority = 'urgent';
CREATE INDEX i13 ON customers (full_name); CREATE INDEX i14 ON fx_rates (currency, valid_from)`;
for (const q of qs) {
  for (const variant of ['plain', 'indexed']) {
    const db = X.dataset.load(new X.Database());
    if (variant === 'indexed') db.execute(INDEXES);
    const key = variant === 'plain' ? q.id : q.id + '@indexed';
    try { const rs = db.execute(q.sql); const r = rs[rs.length - 1]; out.results[key] = { rows: r.rows.map(row => row.map(norm)) }; }
    catch (e) { out.results[key] = { error: e.message }; }
  }
}
process.stdout.write(JSON.stringify(out));
"""
  p = subprocess.run(["node", "-e", script, ROOT], input=json.dumps([{"id": q[0], "sql": q[1]} for q in queries]), capture_output=True, text=True)
  if p.returncode != 0:
    print(p.stderr); sys.exit(1)
  return json.loads(p.stdout)

def sqlite_db(data):
  con = sqlite3.connect(":memory:")
  for t in data:
    if t["name"] == "carts": continue
    cols = ", ".join(f'{c["name"]} {"INTEGER" if c["type"] in ("INT","BOOLEAN") else "REAL" if c["type"] == "DOUBLE" else "TEXT"}' for c in t["cols"])
    con.execute(f'CREATE TABLE {t["name"]} ({cols})')
    con.executemany(f'INSERT INTO {t["name"]} VALUES ({",".join("?" * len(t["cols"]))})',
                    [[(1 if v else 0) if isinstance(v, bool) else v for v in row] for row in t["rows"]])
  return con

def norm(v):
  if isinstance(v, float):
    if v == int(v) and abs(v) < 1e15: return int(v)
    return round(v, 6)
  return v

def main():
  out = node_results(Q)
  failures = 0
  for qid, dbx, lite, ordered in Q:
    con = sqlite_db(out["data"])
    try:
      cur = None
      for stmt in [s for s in (lite or dbx).split(";") if s.strip()]:
        cur = con.execute(stmt)
      expected = [[norm(v) for v in row] for row in cur.fetchall()]
    except Exception as e:
      got = out["results"][qid]
      if "error" in got: print(f"  ok   {qid:24} both reject: {got['error'][:70]}"); continue
      print(f"  FAIL {qid}: SQLite rejects ({e}) but the engine accepted it"); failures += 1; continue
    got = out["results"][qid]
    gi = out["results"][qid + "@indexed"]
    if json.dumps(gi, sort_keys=True, default=str) != json.dumps(got, sort_keys=True, default=str) and not (sorted(map(json.dumps, gi.get("rows", []))) == sorted(map(json.dumps, got.get("rows", []))) and not ordered):
      print(f"  FAIL {qid}: indexes changed the result"); failures += 1; continue
    if "error" in got:
      print(f"  FAIL {qid}: engine error {got['error']}"); failures += 1; continue
    actual = [[norm(v) for v in row] for row in got["rows"]]
    key = lambda r: json.dumps(r, sort_keys=True, default=str)
    a, e = (actual, expected) if ordered else (sorted(actual, key=key), sorted(expected, key=key))
    if a != e:
      failures += 1
      print(f"  FAIL {qid}: {len(actual)} rows vs SQLite {len(expected)}")
      for i, (x, y) in enumerate(zip(a, e)):
        if x != y: print(f"     first difference at row {i}: engine {x} | sqlite {y}"); break
    else:
      print(f"  ok   {qid:24} {len(actual):>5} rows")
  print(f"\n{len(Q) - failures} of {len(Q)} queries match SQLite." if failures else f"\nAll {len(Q)} queries match SQLite.")
  sys.exit(1 if failures else 0)

if __name__ == "__main__":
  main()
