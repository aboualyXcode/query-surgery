/* challenges.js: Query Surgery challenges. Two modes:
   - rewrite: the slow query is given; your query must return exactly the same result while doing at most
     `target` work units. Only queries are allowed (no CREATE INDEX).
   - index: the workload is fixed; you write CREATE INDEX / DROP INDEX statements. The weighted work of the
     workload plus the cost of maintaining indexes on writes must fit the target, within the budgets.
   Targets are calibrated by tests/challenges.test.js: the slow query misses them, the solutions meet them. */
(function (root) {
  'use strict';
  const X = root.SQLX = root.SQLX || {};
  X.TRACKS = [
    { id: 'sargable', title: 'Sargable predicates', blurb: 'Write conditions an index can use.' },
    { id: 'indexes', title: 'Index design', blurb: 'Choose columns, order, coverage and scope. Drop what costs more than it saves.' },
    { id: 'rewrites', title: 'Query rewrites', blurb: 'Remove N+1 subqueries, quadratic self-joins and wasted work.' },
    { id: 'paging', title: 'Pagination and top-N', blurb: 'Fetch pages and top rows without reading everything.' },
    { id: 'capstone', title: 'Capstone', blurb: 'Everything at once.' },
  ];
  X.CHALLENGES = [];
  const add = (track, c) => X.CHALLENGES.push(Object.assign({ track, mode: 'rewrite', ordered: false, setup: '', hints: [] }, c));

  /* ===================== Sargable predicates ===================== */
  add('sargable', {
    id: 'function-on-column', target: 10000, level: 1, title: 'Orders in March 2025',
    scenario: 'The finance dashboard counts March orders. There is an index on <code>orders(order_ts)</code>, but the query reads all 60,000 orders.',
    setup: 'CREATE INDEX orders_order_ts ON orders (order_ts)',
    slow: `SELECT COUNT(*) AS orders, ROUND(SUM(total_amount), 2) AS revenue
FROM orders
WHERE year(order_ts) = 2025 AND month(order_ts) = 3`,
    solution: `SELECT COUNT(*) AS orders, ROUND(SUM(total_amount), 2) AS revenue
FROM orders
WHERE order_ts >= TIMESTAMP '2025-03-01 00:00:00'
  AND order_ts <  TIMESTAMP '2025-04-01 00:00:00'`,
    alt: `SELECT COUNT(*) AS orders, ROUND(SUM(total_amount), 2) AS revenue FROM orders WHERE order_ts BETWEEN TIMESTAMP '2025-03-01 00:00:00' AND TIMESTAMP '2025-03-31 23:59:59'`,
    hints: ['Run EXPLAIN ANALYZE: why is the index not used?', 'An index on order_ts is sorted by order_ts, not by year(order_ts). Express the condition as a range on the bare column.'],
    explain: 'A B-tree index is ordered by the column\'s values. Wrapping the column in a function (<code>year()</code>, <code>CAST</code>, <code>date_trunc</code>, <code>lower</code>) hides that order, so the engine must compute the function for every row. A half-open range (<code>&gt;= start AND &lt; next start</code>) on the bare column is sargable and avoids end-of-day edge cases.',
  });
  add('sargable', {
    id: 'implicit-cast', target: 200, level: 1, title: 'The customer lookup that scans everyone',
    scenario: 'Support looks customers up by their legacy CRM code. The column is text (<code>\'0004321\'</code>), there is an index on it, and the lookup still scans every customer.',
    setup: 'CREATE INDEX customers_code ON customers (customer_code)',
    slow: `SELECT customer_id, full_name, email
FROM customers
WHERE customer_code = 4321`,
    solution: `SELECT customer_id, full_name, email
FROM customers
WHERE customer_code = '0004321'`,
    alt: `SELECT customer_id, full_name, email FROM customers WHERE customer_code IN ('0004321')`,
    hints: ['What type is customer_code? What type is 4321?', 'When a text column is compared with a number, many engines convert the column, row by row.'],
    explain: 'Comparing a text column with a number makes MySQL, SQL Server and others convert the <i>column</i> to a number for every row, which defeats the index. Other engines raise an error instead. Compare like with like: pass the value with the column\'s type. ORMs that bind parameters with the wrong type cause the same problem.',
  });
  add('sargable', {
    id: 'arithmetic-on-column', target: 10000, level: 1, title: 'Orders over 3,000 with tax',
    scenario: 'A fraud rule flags orders whose total including 10% tax exceeds 3,000. There is an index on <code>total_amount</code>.',
    setup: 'CREATE INDEX orders_total ON orders (total_amount)',
    slow: `SELECT order_id, total_amount
FROM orders
WHERE total_amount * 1.1 > 3000`,
    solution: `SELECT order_id, total_amount
FROM orders
WHERE total_amount > 3000 / 1.1`,
    alt: `SELECT order_id, total_amount FROM orders WHERE total_amount > 2727.2727272727`,
    hints: ['Move the arithmetic to the other side of the comparison.'],
    explain: 'Algebra makes predicates sargable: <code>col * 1.1 &gt; 3000</code> is <code>col &gt; 3000 / 1.1</code>, and the right-hand side is computed once. Check the edge cases when you rearrange (division, rounding, negative numbers) before trusting a rewrite.',
  });
  add('sargable', {
    id: 'cast-to-date', target: 2000, level: 2, title: 'Everything sold on one day',
    scenario: 'The daily close report lists the orders placed on 15 June 2025. It casts the timestamp to a date, and reads the whole table.',
    setup: 'CREATE INDEX orders_order_ts ON orders (order_ts)',
    slow: `SELECT order_id, customer_id, total_amount
FROM orders
WHERE CAST(order_ts AS DATE) = DATE '2025-06-15'`,
    solution: `SELECT order_id, customer_id, total_amount
FROM orders
WHERE order_ts >= TIMESTAMP '2025-06-15 00:00:00'
  AND order_ts <  TIMESTAMP '2025-06-16 00:00:00'`,
    alt: `SELECT order_id, customer_id, total_amount FROM orders WHERE order_ts >= DATE '2025-06-15' AND order_ts < DATE '2025-06-16'`,
    hints: ['A day is a range of timestamps.'],
    explain: '<code>CAST(ts AS DATE) = d</code> is one of the most common non-sargable predicates. The equivalent range, from midnight to the next midnight, uses the index. Prefer <code>&lt;</code> the next day over <code>&lt;= 23:59:59</code>, which silently misses fractional seconds.',
  });
  add('sargable', {
    id: 'lower-on-column', target: 1500, level: 2, title: 'Emails starting with "amara."',
    scenario: 'Marketing searches customers by email prefix. Emails are already stored in lower case, there is an index on <code>email</code>, and the search still scans everyone.',
    setup: 'CREATE INDEX customers_email ON customers (email)',
    slow: `SELECT customer_id, email
FROM customers
WHERE lower(email) LIKE 'amara.%'`,
    solution: `SELECT customer_id, email
FROM customers
WHERE email LIKE 'amara.%'`,
    alt: `SELECT customer_id, email FROM customers WHERE email >= 'amara.' AND email < 'amara/'`,
    hints: ['Is lower() needed, given how the data is stored?', 'A LIKE pattern with a fixed prefix is a range on the index; a leading wildcard is not.'],
    explain: '<code>LIKE \'prefix%\'</code> is a range scan; <code>LIKE \'%suffix\'</code> and functions on the column are not. If you need case-insensitive search, normalize the data on write, or use an expression index where your engine supports one (PostgreSQL, Oracle, MySQL 8 functional indexes, SQL Server computed columns).',
  });
  add('sargable', {
    id: 'or-to-union', target: 3000, level: 2, title: 'One customer or one event',
    scenario: 'An account manager wants every order either placed by customer 17 or for event 42. Both columns are indexed, but the OR forces a full scan.',
    setup: 'CREATE INDEX orders_customer ON orders (customer_id); CREATE INDEX orders_event ON orders (event_id)',
    slow: `SELECT order_id, customer_id, event_id
FROM orders
WHERE customer_id = 17 OR event_id = 42`,
    solution: `SELECT order_id, customer_id, event_id FROM orders WHERE customer_id = 17
UNION ALL
SELECT order_id, customer_id, event_id FROM orders WHERE event_id = 42 AND customer_id <> 17`,
    alt: `SELECT order_id, customer_id, event_id FROM orders WHERE customer_id = 17 UNION SELECT order_id, customer_id, event_id FROM orders WHERE event_id = 42`,
    hints: ['Each condition on its own can use its own index.', 'If you combine with UNION ALL, make sure a row matching both conditions is not returned twice.'],
    explain: 'An OR across different columns cannot be answered by one index range. Splitting it into a UNION ALL lets each branch use its index; excluding the first branch\'s rows from the second avoids duplicates without the cost of UNION\'s deduplication. Some engines do this automatically (index OR / bitmap OR), many do not.',
  });

  /* ===================== Index design ===================== */
  const ix = (track, c) => add(track, Object.assign({ mode: 'index' }, c));
  ix('indexes', {
    id: 'composite-order', target: 600000, level: 2, title: 'Column order in a composite index',
    scenario: 'The refunds team runs this all day. You may add <b>one</b> index.',
    workload: [{ sql: `SELECT order_id, total_amount FROM orders WHERE status = 'REFUNDED' AND order_ts >= TIMESTAMP '2025-01-01 00:00:00' AND order_ts < TIMESTAMP '2026-01-01 00:00:00'`, perHour: 60 }],
    budget: { maxNew: 1 },
    solution: 'CREATE INDEX orders_status_ts ON orders (status, order_ts)',
    alt: 'CREATE INDEX orders_status_ts_cover ON orders (status, order_ts) INCLUDE (total_amount)',
    traps: ['CREATE INDEX orders_ts_status ON orders (order_ts, status)'],
    hints: ['An index is searched left to right: equality columns first, then the range column.', 'With the range column first, the index cannot use the status condition to narrow the range.'],
    explain: 'In a composite B-tree, equality columns go first and the range column last: <code>(status, order_ts)</code> jumps straight to REFUNDED orders in 2025. <code>(order_ts, status)</code> must read every order in 2025 and check the status of each. Order index columns by how they are filtered, not by how selective they look.',
  });
  ix('indexes', {
    id: 'covering-index', target: 700000, level: 2, title: 'Make the dashboard index-only',
    scenario: 'A dashboard tile sums each customer\'s spending since July 2026 every minute. An index on <code>order_ts</code> already exists, but every match is fetched from the table. You may add one index.',
    setup: 'CREATE INDEX orders_order_ts ON orders (order_ts)',
    workload: [{ sql: `SELECT customer_id, ROUND(SUM(total_amount), 2) AS spent FROM orders WHERE order_ts >= TIMESTAMP '2026-04-01 00:00:00' GROUP BY customer_id`, perHour: 60 }],
    budget: { maxNew: 1 },
    solution: 'CREATE INDEX orders_ts_cover ON orders (order_ts) INCLUDE (customer_id, total_amount)',
    alt: 'CREATE INDEX orders_ts_cust_amount ON orders (order_ts, customer_id, total_amount)',
    traps: ['CREATE INDEX orders_ts_cust ON orders (order_ts, customer_id)'],
    hints: ['EXPLAIN ANALYZE shows Index Scan: every matching entry is followed by a lookup in the table.', 'If the index contains every column the query needs, the table is never touched (Index Only Scan).'],
    explain: 'A covering index holds every column a query uses, so the engine answers from the index alone and skips one random table read per row. <code>INCLUDE</code> (PostgreSQL, SQL Server) adds columns without making them part of the key; elsewhere, append them to the key. Covering everything is not free: wider indexes cost space and write time.',
  });
  ix('indexes', {
    id: 'partial-index', target: 400000, level: 3, title: 'A small index for the open-orders queue',
    scenario: 'The fulfilment queue shows the 50 oldest unpaid (PLACED) orders, every few seconds. Storage is tight: your new indexes may hold <b>at most 10,000 entries</b> in total, so a full index on 60,000 orders is too big.',
    workload: [{ sql: `SELECT order_id, customer_id, order_ts FROM orders WHERE status = 'PLACED' ORDER BY order_ts LIMIT 50`, perHour: 1200 }],
    budget: { maxNew: 1, maxEntries: 10000 },
    solution: "CREATE INDEX orders_placed_ts ON orders (order_ts) WHERE status = 'PLACED'",
    alt: "CREATE INDEX orders_placed_ts_cover ON orders (order_ts) INCLUDE (customer_id) WHERE status = 'PLACED'",
    traps: ['CREATE INDEX orders_status_ts ON orders (status, order_ts)'],
    hints: ['Only a small fraction of orders are PLACED.', 'A partial (filtered) index only contains rows matching its WHERE clause, and can be used by queries with the same condition.'],
    explain: 'Partial indexes (PostgreSQL, SQLite; filtered indexes in SQL Server) index only the rows a hot query cares about: smaller, cheaper to maintain, and here also in the right order, so the queue reads exactly 50 entries. The query must include the same condition as the index for the planner to use it.',
  });
  ix('indexes', {
    id: 'foreign-key-index', target: 300000, level: 1, title: 'Index the foreign key',
    scenario: 'The account page loads a customer\'s orders, and the support tool counts orders per customer for a short list of VIPs. Neither has an index to use. You may add one index.',
    workload: [
      { sql: 'SELECT order_id, order_ts, total_amount FROM orders WHERE customer_id = 4242', perHour: 600 },
      { sql: 'SELECT c.customer_id, c.full_name, COUNT(o.order_id) AS orders FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id WHERE c.customer_id IN (11, 222, 3333, 4444) GROUP BY c.customer_id, c.full_name', perHour: 120 },
    ],
    budget: { maxNew: 1 },
    solution: 'CREATE INDEX orders_customer ON orders (customer_id)',
    alt: 'CREATE INDEX orders_customer_ts ON orders (customer_id, order_ts)',
    hints: ['Which column do both queries look orders up by?'],
    explain: 'Primary keys are indexed automatically; foreign keys usually are not (PostgreSQL, SQL Server and Oracle do not create them). An unindexed foreign key turns every "orders of this customer" lookup into a full scan, and makes deletes on the parent table slow too.',
  });
  ix('indexes', {
    id: 'top-n-per-customer', target: 400000, level: 2, title: 'A customer\'s 20 latest orders',
    scenario: 'The mobile app\'s order history shows a customer\'s 20 most recent orders. Heavy customers have thousands of orders, so filtering by customer and then sorting is slow. You may add one index.',
    workload: [{ sql: 'SELECT order_id, order_ts, total_amount FROM orders WHERE customer_id = 7 ORDER BY order_ts DESC LIMIT 20', perHour: 3000 }],
    budget: { maxNew: 1 },
    solution: 'CREATE INDEX orders_customer_ts ON orders (customer_id, order_ts)',
    alt: 'CREATE INDEX orders_customer_ts_desc ON orders (customer_id, order_ts DESC) INCLUDE (total_amount)',
    traps: ['CREATE INDEX orders_customer ON orders (customer_id)'],
    hints: ['An index on (customer_id) finds the customer\'s rows, but they still have to be sorted.', 'An index on (customer_id, order_ts) stores each customer\'s rows already in time order.'],
    explain: 'An index whose columns are the equality filter followed by the ORDER BY columns returns rows already sorted, so the engine reads 20 entries and stops: no sort, no matter how many orders the customer has. B-trees can be read in either direction, so ASC versus DESC rarely matters for a single column.',
  });
  ix('indexes', {
    id: 'too-many-indexes', target: 395000, level: 3, title: 'Indexes that cost more than they save',
    scenario: 'Over the years <code>orders</code> collected seven extra indexes. Every insert (6,000 an hour) must update all of them. The read workload is below. <b>Drop</b> the indexes that do not pay for themselves.',
    setup: `CREATE INDEX orders_customer ON orders (customer_id);
CREATE INDEX orders_customer_ts ON orders (customer_id, order_ts);
CREATE INDEX orders_status ON orders (status);
CREATE INDEX orders_channel ON orders (channel);
CREATE INDEX orders_ts ON orders (order_ts);
CREATE INDEX orders_event ON orders (event_id);
CREATE INDEX orders_total ON orders (total_amount)`,
    workload: [
      { sql: 'SELECT order_id, order_ts FROM orders WHERE customer_id = 7 ORDER BY order_ts DESC LIMIT 20', perHour: 3000 },
      { sql: "SELECT COUNT(*) FROM orders WHERE order_ts >= TIMESTAMP '2026-08-01 00:00:00'", perHour: 60 },
      { sql: 'SELECT order_id FROM orders WHERE event_id = 42', perHour: 200 },
    ],
    writes: { table: 'orders', perHour: 6000 },
    budget: { allowCreate: false },
    starter: '-- DROP INDEX the ones that are not worth their write cost\n',
    solution: 'DROP INDEX orders_customer; DROP INDEX orders_status; DROP INDEX orders_channel; DROP INDEX orders_total',
    alt: 'DROP INDEX orders_total; DROP INDEX orders_channel; DROP INDEX orders_status; DROP INDEX orders_customer',
    traps: ['DROP INDEX orders_customer_ts; DROP INDEX orders_status; DROP INDEX orders_channel; DROP INDEX orders_total', 'DROP INDEX orders_status; DROP INDEX orders_channel; DROP INDEX orders_total'],
    hints: ['An index on (customer_id) is redundant when (customer_id, order_ts) exists: the composite serves every query the single-column one does.', 'Which indexes does no query in the workload use?'],
    explain: 'Every index is paid for on every insert, update and delete. Indexes that duplicate the prefix of another index, serve no query, or index a low-selectivity column like status rarely earn their keep. Check usage statistics before dropping (pg_stat_user_indexes, sys.dm_db_index_usage_stats, sys schema in MySQL).',
  });

  /* ===================== Rewrites ===================== */
  add('rewrites', {
    id: 'n-plus-one', target: 400000, level: 2, title: 'One subquery per customer',
    scenario: 'The CRM export lists every customer with their order count and total spend. Two correlated subqueries run once per customer, each scanning the orders table.',
    slow: `SELECT c.customer_id, c.full_name,
       (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.customer_id) AS orders,
       (SELECT ROUND(SUM(o.total_amount), 2) FROM orders o WHERE o.customer_id = c.customer_id) AS spent
FROM customers c`,
    solution: `SELECT c.customer_id, c.full_name, COALESCE(s.orders, 0) AS orders, s.spent
FROM customers c
LEFT JOIN (
  SELECT customer_id, COUNT(*) AS orders, ROUND(SUM(total_amount), 2) AS spent
  FROM orders
  GROUP BY customer_id
) s ON s.customer_id = c.customer_id`,
    alt: `SELECT c.customer_id, c.full_name, COUNT(o.order_id) AS orders, ROUND(SUM(o.total_amount), 2) AS spent FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id GROUP BY c.customer_id, c.full_name`,
    hints: ['How many times does each subquery run, and what does each run read?', 'Aggregate orders once per customer, then join.', 'Customers without orders must keep a count of 0 and a NULL spend.'],
    explain: 'A correlated subquery in the SELECT list runs once per outer row: the database version of the N+1 problem. Some optimizers decorrelate simple cases; many do not, especially with several subqueries. Aggregating once and joining reads each table once. Watch the edge cases: a LEFT JOIN keeps customers without orders, and COUNT of nothing must become 0.',
  });
  add('rewrites', {
    id: 'latest-per-group', target: 400000, level: 2, title: 'Each customer\'s latest order',
    scenario: 'The churn model needs every customer\'s most recent order. The query finds it with a correlated MAX, once per order.',
    slow: `SELECT o.customer_id, o.order_id, o.order_ts
FROM orders o
WHERE o.order_ts = (SELECT MAX(o2.order_ts) FROM orders o2 WHERE o2.customer_id = o.customer_id)`,
    solution: `SELECT customer_id, order_id, order_ts
FROM (
  SELECT customer_id, order_id, order_ts,
         ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_ts DESC, order_id DESC) AS rn
  FROM orders
) ranked
WHERE rn = 1`,
    alt: `SELECT o.customer_id, o.order_id, o.order_ts FROM orders o JOIN (SELECT customer_id, MAX(order_ts) AS last_ts FROM orders GROUP BY customer_id) m ON m.customer_id = o.customer_id AND m.last_ts = o.order_ts`,
    hints: ['The subquery runs once for each of the 60,000 orders.', 'A window function ranks every customer\'s orders in one pass.'],
    explain: 'Greatest-row-per-group is a classic: the correlated version is quadratic without an index and still runs 60,000 lookups with one. <code>ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)</code> answers it in one sort; joining to a grouped MAX is the portable alternative. Add a tie-breaker so "latest" is deterministic.',
  });
  add('rewrites', {
    id: 'running-total', target: 1000000, level: 3, title: 'A running total by self-join',
    scenario: 'The cohort report computes each customer\'s cumulative activity count by joining the activity log to itself. It hits the statement timeout.',
    slow: `SELECT a.log_id, a.customer_id, COUNT(*) AS actions_so_far
FROM activity_log a
JOIN activity_log b ON b.customer_id = a.customer_id AND b.log_id <= a.log_id
GROUP BY a.log_id, a.customer_id`,
    solution: `SELECT log_id, customer_id,
       COUNT(*) OVER (PARTITION BY customer_id ORDER BY log_id ROWS UNBOUNDED PRECEDING) AS actions_so_far
FROM activity_log`,
    alt: `SELECT log_id, customer_id, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY log_id) AS actions_so_far FROM activity_log`,
    hints: ['For a customer with n actions, the self-join produces n × (n + 1) / 2 rows.', 'A window function with ORDER BY computes a running aggregate in one pass.'],
    explain: 'Running totals, ranks and "so far" counts by self-join (or by correlated subquery) are quadratic in the group size. Window functions compute them in a single pass over sorted rows. Every major engine supports them, including MySQL 8, SQLite 3.25 and later, and all the warehouses.',
  });
  add('rewrites', {
    id: 'distinct-fanout', target: 90000, level: 2, title: 'DISTINCT hiding a join explosion',
    scenario: 'Marketing wants customers who bought anything in 2026. The query joins customers to all their orders, producing tens of thousands of rows, then removes the duplicates.',
    setup: 'CREATE INDEX orders_customer ON orders (customer_id)',
    slow: `SELECT DISTINCT c.customer_id, c.email
FROM customers c
JOIN orders o ON o.customer_id = c.customer_id
WHERE o.order_ts >= TIMESTAMP '2026-01-01 00:00:00'`,
    solution: `SELECT c.customer_id, c.email
FROM customers c
WHERE c.customer_id IN (SELECT customer_id FROM orders WHERE order_ts >= TIMESTAMP '2026-01-01 00:00:00')`,
    alt: `SELECT c.customer_id, c.email FROM customers c WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id AND o.order_ts >= TIMESTAMP '2026-01-01 00:00:00')`,
    hints: ['The question is "does a matching order exist?", not "list every matching order".', 'A semi-join (IN or EXISTS) stops at the first match and never duplicates customers.'],
    explain: 'JOIN + DISTINCT computes every match and then throws most of them away. A semi-join (IN, EXISTS) states the real question and lets the engine stop at the first match. Most optimizers treat IN and EXISTS similarly; the important part is not joining to the many side at all.',
  });
  add('rewrites', {
    id: 'count-for-existence', target: 1000, level: 1, title: 'Counting to answer yes or no',
    scenario: 'A health check asks "has anyone checked out since the deploy?" by counting every matching row in the 120,000-row activity log.',
    slow: `SELECT CASE WHEN (SELECT COUNT(*) FROM activity_log WHERE action = 'checkout' AND created_at >= TIMESTAMP '2024-01-01 00:00:00') > 0
            THEN 'yes' ELSE 'no' END AS any_checkout`,
    solution: `SELECT CASE WHEN EXISTS (SELECT 1 FROM activity_log WHERE action = 'checkout' AND created_at >= TIMESTAMP '2024-01-01 00:00:00')
            THEN 'yes' ELSE 'no' END AS any_checkout`,
    alt: `SELECT CASE WHEN (SELECT COUNT(*) FROM (SELECT 1 FROM activity_log WHERE action = 'checkout' AND created_at >= TIMESTAMP '2024-01-01 00:00:00' LIMIT 1) x) > 0 THEN 'yes' ELSE 'no' END AS any_checkout`,
    hints: ['COUNT(*) must read every matching row. Does the question need the count?'],
    explain: '<code>EXISTS</code> can stop at the first matching row; <code>COUNT(*) &gt; 0</code> must find all of them. The same applies in application code: <code>SELECT 1 … LIMIT 1</code> instead of fetching a count to test for zero.',
  });
  add('rewrites', {
    id: 'repeated-aggregate', target: 400000, level: 3, title: 'Above-average orders, one subquery per row',
    scenario: 'Revenue analysts want orders that are above their event\'s average order value. The query recomputes the event average for each of the 60,000 orders.',
    slow: `SELECT o.order_id, o.event_id, o.total_amount
FROM orders o
WHERE o.total_amount > (SELECT AVG(o2.total_amount) FROM orders o2 WHERE o2.event_id = o.event_id)`,
    solution: `SELECT order_id, event_id, total_amount
FROM (
  SELECT order_id, event_id, total_amount,
         AVG(total_amount) OVER (PARTITION BY event_id) AS event_avg
  FROM orders
) x
WHERE total_amount > event_avg`,
    alt: `SELECT o.order_id, o.event_id, o.total_amount FROM orders o JOIN (SELECT event_id, AVG(total_amount) AS event_avg FROM orders GROUP BY event_id) a ON a.event_id = o.event_id WHERE o.total_amount > a.event_avg`,
    hints: ['There are only 300 events, but the average is recomputed 60,000 times.', 'Compute each event\'s average once, with a window function or a grouped subquery, and compare.'],
    explain: 'A correlated aggregate in WHERE recomputes the same value for every row of the group. Computing it once per group, as a window aggregate or a grouped derived table, turns 60,000 aggregations into 300.',
  });
  add('rewrites', {
    id: 'aggregate-before-join', target: 150000, level: 2, title: 'Aggregate first, join second',
    scenario: 'The regional report joins all 60,000 orders to customers and then groups by country. The join does far more work than the answer needs.',
    slow: `SELECT c.country, COUNT(*) AS orders, ROUND(SUM(o.total_amount), 2) AS revenue
FROM orders o
JOIN customers c ON c.customer_id = o.customer_id
GROUP BY c.country`,
    solution: `SELECT c.country, SUM(s.orders) AS orders, ROUND(SUM(s.revenue), 2) AS revenue
FROM (
  SELECT customer_id, COUNT(*) AS orders, SUM(total_amount) AS revenue
  FROM orders
  GROUP BY customer_id
) s
JOIN customers c ON c.customer_id = s.customer_id
GROUP BY c.country`,
    alt: `WITH s AS (SELECT customer_id, COUNT(*) AS orders, SUM(total_amount) AS revenue FROM orders GROUP BY customer_id) SELECT c.country, SUM(s.orders) AS orders, ROUND(SUM(s.revenue), 2) AS revenue FROM s JOIN customers c ON c.customer_id = s.customer_id GROUP BY c.country`,
    hints: ['How many rows enter the join? How many would if orders were summarized per customer first?'],
    explain: 'Pre-aggregating the large side to the join key ("eager aggregation") shrinks the join from 60,000 rows to at most 5,000. Few optimizers do this automatically. It works for additive measures (counts, sums); averages must be rebuilt from sums and counts.',
  });

  /* ===================== Pagination and top-N ===================== */
  add('paging', {
    id: 'keyset-pagination', target: 2000, level: 2, title: 'Page 2,001 of the activity feed',
    scenario: 'The admin feed pages through the activity log, 50 rows at a time, with OFFSET. Page 2,001 reads and discards 100,000 rows. The previous page ended at <code>log_id = 100000</code>.',
    slow: `SELECT log_id, customer_id, action, created_at
FROM activity_log
ORDER BY log_id
LIMIT 50 OFFSET 100000`,
    solution: `SELECT log_id, customer_id, action, created_at
FROM activity_log
WHERE log_id > 100000
ORDER BY log_id
LIMIT 50`,
    alt: `SELECT log_id, customer_id, action, created_at FROM activity_log WHERE log_id >= 100001 ORDER BY log_id LIMIT 50`,
    ordered: true,
    hints: ['OFFSET n still reads the first n rows, then throws them away.', 'Remember where the last page ended, and continue from there.'],
    explain: 'Keyset (seek) pagination continues from the last key seen: <code>WHERE key &gt; :last ORDER BY key LIMIT n</code>. Every page costs the same, however deep, and rows inserted meanwhile do not shift pages. For non-unique sort columns, page on a tuple such as <code>(created_at, id)</code>.',
  });
  add('paging', {
    id: 'top-n-per-group', target: 400000, level: 3, title: 'The three biggest orders per event',
    scenario: 'The events team wants each event\'s three largest orders. The query counts, for every order, how many orders of the same event are larger.',
    slow: `SELECT o.event_id, o.order_id, o.total_amount
FROM orders o
WHERE (SELECT COUNT(*) FROM orders o2
       WHERE o2.event_id = o.event_id
         AND (o2.total_amount > o.total_amount OR (o2.total_amount = o.total_amount AND o2.order_id < o.order_id))) < 3`,
    solution: `SELECT event_id, order_id, total_amount
FROM (
  SELECT event_id, order_id, total_amount,
         ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY total_amount DESC, order_id) AS rn
  FROM orders
) ranked
WHERE rn <= 3`,
    alt: `SELECT event_id, order_id, total_amount FROM (SELECT event_id, order_id, total_amount, RANK() OVER (PARTITION BY event_id ORDER BY total_amount DESC, order_id) AS r FROM orders) x WHERE r <= 3`,
    hints: ['For each of 60,000 orders, the subquery reads every order of the same event.', 'ROW_NUMBER over each event\'s orders, sorted by amount, ranks them in one pass.'],
    explain: 'Top-N per group by counting "how many are bigger than me" is quadratic per group. A window ranking computes it in one sort. Make the ordering total (here with order_id) so ties are resolved deterministically.',
  });

  /* ===================== Capstone ===================== */
  add('capstone', {
    id: 'capstone-report', target: 60000, level: 3, title: 'Capstone: the VIP report that times out',
    scenario: 'The weekly VIP report lists gold and platinum customers who ordered in Q2 2026, with their Q2 order count, Q2 spend and latest Q2 order. It combines non-sargable dates, three correlated subqueries and a DISTINCT over a join. Indexes exist on <code>orders(customer_id)</code> and <code>orders(order_ts)</code>.',
    setup: 'CREATE INDEX orders_customer ON orders (customer_id); CREATE INDEX orders_order_ts ON orders (order_ts)',
    slow: `SELECT DISTINCT c.customer_id, c.full_name, c.tier,
       (SELECT COUNT(*) FROM orders o2 WHERE o2.customer_id = c.customer_id AND year(o2.order_ts) = 2026 AND quarter(o2.order_ts) = 2) AS q2_orders,
       (SELECT ROUND(SUM(o2.total_amount), 2) FROM orders o2 WHERE o2.customer_id = c.customer_id AND year(o2.order_ts) = 2026 AND quarter(o2.order_ts) = 2) AS q2_spend,
       (SELECT MAX(o2.order_ts) FROM orders o2 WHERE o2.customer_id = c.customer_id AND year(o2.order_ts) = 2026 AND quarter(o2.order_ts) = 2) AS last_q2_order
FROM customers c
JOIN orders o ON o.customer_id = c.customer_id
WHERE c.tier IN ('gold', 'platinum')
  AND year(o.order_ts) = 2026 AND quarter(o.order_ts) = 2`,
    solution: `SELECT c.customer_id, c.full_name, c.tier, q.q2_orders, q.q2_spend, q.last_q2_order
FROM (
  SELECT customer_id, COUNT(*) AS q2_orders, ROUND(SUM(total_amount), 2) AS q2_spend, MAX(order_ts) AS last_q2_order
  FROM orders
  WHERE order_ts >= TIMESTAMP '2026-04-01 00:00:00' AND order_ts < TIMESTAMP '2026-07-01 00:00:00'
  GROUP BY customer_id
) q
JOIN customers c ON c.customer_id = q.customer_id
WHERE c.tier IN ('gold', 'platinum')`,
    alt: `SELECT c.customer_id, c.full_name, c.tier, COUNT(*) AS q2_orders, ROUND(SUM(o.total_amount), 2) AS q2_spend, MAX(o.order_ts) AS last_q2_order FROM customers c JOIN orders o ON o.customer_id = c.customer_id WHERE c.tier IN ('gold', 'platinum') AND o.order_ts >= TIMESTAMP '2026-04-01 00:00:00' AND o.order_ts < TIMESTAMP '2026-07-01 00:00:00' GROUP BY c.customer_id, c.full_name, c.tier`,
    hints: ['Start with the dates: which predicates can use orders(order_ts)?', 'The three subqueries compute three aggregates of the same rows. Compute them once, grouped by customer.', 'Once you aggregate per customer, the DISTINCT is unnecessary.'],
    explain: 'Real slow queries combine several problems, and fixes compound: a sargable date range shrinks the input, one grouped aggregation replaces three correlated subqueries, and grouping makes DISTINCT redundant. Fix the largest cost first, re-measure, repeat.',
  });

  /* ---------------- grading ---------------- */
  const INDEX_WRITE_COST = 6; // work units to maintain one index entry on insert
  let pristine = null;
  const base = () => { if (!pristine) pristine = X.dataset.load(new X.Database()); return pristine.fork(); };
  function prepared(ch) { const db = base(); if (ch.setup) { db.timeout = Infinity; db.execute(ch.setup); db.timeout = 5e6; } return db; }
  const norm = v => (v == null ? null : typeof v === 'number' ? Number(v.toFixed(4)) : v instanceof X.SqlDate || v instanceof X.SqlTs ? String(v) : typeof v === 'object' ? JSON.stringify(v) : v);
  const key = r => JSON.stringify(r.map(norm));
  function sameRows(a, b, ordered) {
    if (a.length !== b.length) return false;
    const ka = a.map(key), kb = b.map(key);
    if (!ordered) { ka.sort(); kb.sort(); }
    return ka.every((k, i) => k === kb[i]);
  }
  function runQuery(db, sql) {
    const stmts = X.parse(sql);
    if (!stmts.length) throw Object.assign(new Error('Write a query to run.'), { cls: 'EMPTY' });
    stmts.forEach(st => { if (st.k !== 'query' && st.k !== 'explain') throw Object.assign(new Error(`[NOT_ALLOWED] Only queries are allowed in a rewrite challenge (no ${st.k === 'createIndex' ? 'CREATE INDEX' : st.k.toUpperCase()}). Change the query, not the schema.`), { cls: 'NOT_ALLOWED' }); });
    const res = db.execute(sql);
    return res[res.length - 1];
  }
  const expectedCache = new Map();
  function expected(ch) {
    if (expectedCache.has(ch.id)) return expectedCache.get(ch.id);
    let r;
    if (ch.mode === 'rewrite') { const db = prepared(ch); r = runQuery(db, ch.solution); }
    else r = workloadCost(ch, ch.solution);
    expectedCache.set(ch.id, r);
    return r;
  }
  function workloadCost(ch, ddl) {
    const db = prepared(ch);
    const before = new Set(db.indexes.keys());
    if (ddl && ddl.trim()) {
      const stmts = X.parse(ddl);
      stmts.forEach(st => {
        const ok = st.k === 'createIndex' || (st.k === 'drop' && st.kind === 'index');
        if (!ok) throw Object.assign(new Error('[NOT_ALLOWED] Only CREATE INDEX and DROP INDEX are allowed in an index challenge: the queries are fixed.'), { cls: 'NOT_ALLOWED' });
        if (st.k === 'createIndex' && ch.budget && ch.budget.allowCreate === false) throw Object.assign(new Error('[NOT_ALLOWED] This challenge is about removing indexes: CREATE INDEX is not allowed.'), { cls: 'NOT_ALLOWED' });
      });
      db.timeout = Infinity; db.execute(ddl); db.timeout = 5e6;
    }
    const created = Array.from(db.indexes.keys()).filter(k => !before.has(k));
    const queries = ch.workload.map(w => {
      try { const r = db.execute(w.sql)[0]; return { sql: w.sql, perHour: w.perHour, work: r.work, rows: r.rows, plan: r.plan }; }
      catch (e) { return { sql: w.sql, perHour: w.perHour, work: Infinity, error: e.message }; }
    });
    const tableName = ch.writes ? ch.writes.table : null;
    const extra = Array.from(db.indexes.values()).filter(d => tableName && d.table === tableName && !/_pkey$/.test(d.name));
    const writeCost = ch.writes ? ch.writes.perHour * extra.length * INDEX_WRITE_COST : 0;
    const readCost = queries.reduce((a, q) => a + q.work * q.perHour, 0);
    const entries = created.reduce((a, k) => { const d = db.indexes.get(k); return a + X.indexSize(db, d); }, 0);
    return { queries, readCost, writeCost, total: readCost + writeCost, created, entries, db, indexes: Array.from(db.indexes.values()) };
  }
  function grade(ch, sql) {
    if (ch.mode === 'rewrite') {
      const exp = expected(ch);
      const db = prepared(ch);
      let got;
      try { got = runQuery(db, sql); } catch (e) { return { ok: false, error: e.message, cls: e.cls }; }
      if (got.kind === 'plan') return { ok: false, got, message: 'That was an EXPLAIN. Submit the query itself.' };
      const same = sameRows(got.rows, exp.rows, ch.ordered) && got.columns.length === exp.columns.length;
      const fast = got.work <= ch.target;
      return { ok: same && fast, same, fast, got, work: got.work, target: ch.target,
        message: !same ? (got.rows.length !== exp.rows.length ? `Different result: your query returns ${got.rows.length} rows, the original returns ${exp.rows.length}.` : got.columns.length !== exp.columns.length ? `Different result: ${got.columns.length} columns instead of ${exp.columns.length}.` : 'Different result: same number of rows, but some values differ. An optimization must not change the answer.')
          : !fast ? `Same result, but it did ${X.fmtWork(got.work)} of work. The target is ${X.fmtWork(ch.target)}.` : `Same result with ${X.fmtWork(got.work)} of work (target ${X.fmtWork(ch.target)}).` };
    }
    let w;
    try { w = workloadCost(ch, sql); } catch (e) { return { ok: false, error: e.message, cls: e.cls }; }
    const b = ch.budget || {};
    const problems = [];
    if (b.maxNew != null && w.created.length > b.maxNew) problems.push(`You created ${w.created.length} indexes; the budget is ${b.maxNew}.`);
    if (b.maxEntries != null && w.entries > b.maxEntries) problems.push(`Your new indexes hold ${w.entries.toLocaleString()} entries; the budget is ${b.maxEntries.toLocaleString()}.`);
    const errs = w.queries.filter(q => q.error);
    if (errs.length) problems.push(`A workload query failed: ${errs[0].error}`);
    const fast = w.total <= ch.target;
    return { ok: !problems.length && fast, workload: w, total: w.total, target: ch.target, problems,
      message: problems.length ? problems.join(' ') : fast ? `The workload costs ${X.fmtWork(w.total)} per hour (target ${X.fmtWork(ch.target)}).` : `The workload costs ${X.fmtWork(w.total)} per hour; the target is ${X.fmtWork(ch.target)}.` };
  }
  X.surgery = { grade, expected, prepared, workloadCost, runQuery, sameRows, base, INDEX_WRITE_COST };
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : global);
