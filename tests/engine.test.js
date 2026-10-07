#!/usr/bin/env node
/* SQL semantics that SQLite cannot check (dialect functions, generators, MERGE, error classes). Expected values come from the examples in the
   Databricks SQL reference wherever one exists. Usage: node tests/engine.test.js */
'use strict';
const path = require('path');
global.window = undefined;
['parser', 'functions', 'engine'].forEach(f => require(path.join(__dirname, '..', 'js', 'sql', f + '.js')));
require(path.join(__dirname, 'fixtures', 'stagedoor-small.js'));
const X = global.SQLX;
let checks = 0, failures = 0;
const fresh = () => X.dataset.load(new X.Database());
const show = v => JSON.stringify(v, (k, x) => (x instanceof X.SqlDate || x instanceof X.SqlTs ? String(x) : x instanceof Map ? Object.fromEntries(x) : x));
function val(sql, db) { const r = (db || fresh()).query(sql); return r.rows.map(row => row.map(v => (v instanceof X.SqlDate || v instanceof X.SqlTs ? String(v) : v))); }
function eq(sql, expected, db) {
  checks++;
  let got;
  try { got = val(sql, db); } catch (e) { failures++; console.log(`  FAIL ${sql}\n       threw ${e.message}`); return; }
  const g = show(expected.length && !Array.isArray(expected[0]) ? got.map(r => r[0]) : got);
  if (g !== show(expected)) { failures++; console.log(`  FAIL ${sql}\n       got      ${g}\n       expected ${show(expected)}`); }
}
function err(sql, cls, db) {
  checks++;
  try { (db || fresh()).execute(sql); failures++; console.log(`  FAIL expected [${cls}] from: ${sql}`); }
  catch (e) { if (e.cls !== cls && !String(e.cls).startsWith(cls)) { failures++; console.log(`  FAIL ${sql}\n       expected [${cls}], got ${e.message}`); } }
}
const section = s => console.log(s);

section('Arithmetic and ANSI mode');
eq('SELECT 7 / 2', [3.5]);
eq('SELECT 7 DIV 2', [3]);
eq('SELECT try_divide(1, 0)', [null]);
err('SELECT 1 / 0', 'DIVIDE_BY_ZERO');
err("SELECT CAST('abc' AS INT)", 'CAST_INVALID_INPUT');
eq("SELECT try_cast('abc' AS INT), try_cast('12' AS INT)", [[null, 12]]);
err("SELECT CAST('2026-02-30' AS DATE)", 'CAST_INVALID_INPUT');
eq('SELECT round(2.675, 2), round(-2.5), bround(2.5), bround(3.5)', [[2.68, -3, 2, 4]]);
eq("SELECT CAST(12.345 AS DECIMAL(5,2)), CAST('7.9' AS INT)", [[12.35, 7]]);
eq('SELECT 5 % 3, -5 % 3, pmod(-5, 3)', [[2, -2, 1]]);
eq('SELECT greatest(3, NULL, 7), least(3, NULL, 7), coalesce(NULL, NULL, 4)', [[7, 3, 4]]);
eq("SELECT nvl2(NULL, 'a', 'b'), nullif(5, 5), ifnull(NULL, 'x')", [['b', null, 'x']]);

section('Strings and regular expressions');
eq("SELECT concat_ws('-', 'a', NULL, 'b'), concat('a', NULL)", [['a-b', null]]);
eq("SELECT initcap('sPark sql'), lpad('hi', 5, '??'), lpad('hi', 1, '??'), rpad('hi', 5, '??')", [['Spark Sql', '???hi', 'h', 'hi???']]);
eq("SELECT split('oneAtwoBthreeC', '[ABC]')", [[['one', 'two', 'three', '']]]);
eq("SELECT split_part('a,b,c', ',', 2), split_part('a,b,c', ',', -1), split_part('a,b,c', ',', 5)", [['b', 'c', '']]);
eq("SELECT regexp_extract('100-200', '(\\\\d+)-(\\\\d+)', 1), regexp_extract('foo', '(\\\\d+)', 1)", [['100', '']]);
eq("SELECT regexp_replace('100-200', '(\\\\d+)', 'num'), regexp_extract_all('a1b22c333', '(\\\\d+)', 1)", [['num-num', ['1', '22', '333']]]);
eq("SELECT 'Spark' RLIKE '^S.*k$', 'spark' ILIKE 'SP%', 'a_c' LIKE 'a\\\\_c', 'abc' LIKE 'a\\\\_c'", [[true, true, true, false]]);
eq("SELECT 'apple' LIKE ANY ('b%', 'a%'), 'apple' LIKE ALL ('a%', '%e')", [[true, true]]);
eq("SELECT substring('Spark SQL', 5), substring('Spark SQL', -3), substring('Spark SQL', 5, 1), left('Spark', 2), right('Spark', 3)", [['k SQL', 'SQL', 'k', 'Sp', 'ark']]);
eq("SELECT trim('  x  '), ltrim('  x'), rtrim('x  '), length('Tomás'), upper('ß')", [['x', 'x', 'x', 5, 'SS']]);
eq("SELECT format_string('%s has %d items costing %.2f', 'cart', 3, 9.5)", [['cart has 3 items costing 9.50']]);

section('Dates and timestamps');
eq("SELECT date_format(DATE'2016-04-08', 'y'), date_format(TIMESTAMP'2026-03-05 14:07:09', 'yyyy-MM-dd HH:mm:ss EEE MMM')", [['2016', '2026-03-05 14:07:09 Thu Mar']]);
eq("SELECT add_months(DATE'2016-08-31', 1), last_day(DATE'2009-01-12'), datediff(DATE'2009-07-31', DATE'2009-07-30')", [['2016-09-30', '2009-01-31', 1]]);
eq("SELECT months_between(TIMESTAMP'1997-02-28 10:30:00', DATE'1996-10-30')", [3.94959677]);
eq("SELECT date_trunc('MONTH', TIMESTAMP'2015-03-05 09:32:05'), date_trunc('WEEK', DATE'2026-03-05'), trunc(DATE'2019-08-04', 'YEAR')", [['2015-03-01 00:00:00', '2026-03-02 00:00:00', '2019-01-01']]);
eq("SELECT date_add(DATE'2016-07-30', 1), date_sub(DATE'2016-07-30', 1), DATE'2026-01-31' + INTERVAL 1 MONTH, TIMESTAMP'2026-01-01 23:00:00' + INTERVAL 2 HOURS", [['2016-07-31', '2016-07-29', '2026-02-28', '2026-01-02 01:00:00']]);
eq("SELECT dayofweek(DATE'2009-07-30'), weekday(DATE'2009-07-30'), dayofyear(DATE'2016-04-09'), weekofyear(DATE'2008-02-20'), quarter(DATE'2016-08-31')", [[5, 3, 100, 8, 3]]);
eq("SELECT to_date('2009-07-30 04:17:52'), to_date('2016-12-31', 'yyyy-MM-dd'), to_date('31/12/2016', 'dd/MM/yyyy'), to_timestamp('2016-12-31 00:12:00')", [['2009-07-30', '2016-12-31', '2016-12-31', '2016-12-31 00:12:00']]);
err("SELECT to_date('12/31/2016', 'dd/MM/yyyy')", 'CANNOT_PARSE_TIMESTAMP');
eq("SELECT try_to_timestamp('nope', 'yyyy-MM-dd')", [null]);
eq("SELECT datediff(MONTH, DATE'2021-01-31', DATE'2021-03-01'), timestampdiff(HOUR, TIMESTAMP'2026-01-01 00:00:00', TIMESTAMP'2026-01-02 06:00:00'), dateadd(DAY, 3, DATE'2026-02-27')", [[1, 30, '2026-03-02']]);
eq("SELECT extract(YEAR FROM DATE'2026-03-05'), extract(HOUR FROM TIMESTAMP'2026-03-05 17:00:00'), make_date(2026, 2, 28)", [[2026, 17, '2026-02-28']]);
eq("SELECT current_date()", ['2026-07-01']);
eq("SELECT sequence(DATE'2026-01-30', DATE'2026-02-02')", [[['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']]]);
eq("SELECT sequence(1, 9, 4), sequence(5, 1)", [[[1, 5, 9], [5, 4, 3, 2, 1]]]);

section('Arrays, maps, structs and higher-order functions');
eq('SELECT array_contains(array(1, 2, 3), 2), element_at(array(1, 2, 3), 2), element_at(array(1, 2, 3), -1), size(array(1, 2)), size(NULL)', [[true, 2, 3, 2, null]]);
err('SELECT element_at(array(1, 2, 3), 5)', 'INVALID_ARRAY_INDEX_IN_ELEMENT_AT');
err('SELECT array(1, 2, 3)[5]', 'INVALID_ARRAY_INDEX');
eq('SELECT array(10, 20, 30)[0], get(array(1, 2), 9), try_element_at(array(1), 3)', [[10, null, null]]);
eq('SELECT array_distinct(array(1, 2, 2, 3)), array_union(array(1, 2), array(2, 3)), array_intersect(array(1, 2, 3), array(2, 3, 4)), array_except(array(1, 2, 3), array(2))', [[[1, 2, 3], [1, 2, 3], [2, 3], [1, 3]]]);
eq("SELECT sort_array(array(3, NULL, 1)), sort_array(array(3, 1, 2), false), array_join(array('a', NULL, 'b'), ','), array_join(array('a', NULL), ',', '?')", [[[null, 1, 3], [3, 2, 1], 'a,b', 'a,?']]);
eq('SELECT transform(array(1, 2, 3), x -> x + 1), transform(array(1, 2, 3), (x, i) -> x + i), filter(array(1, 2, 3), x -> x % 2 = 1)', [[[2, 3, 4], [1, 3, 5], [1, 3]]]);
eq('SELECT exists(array(1, 2, 3), x -> x % 2 = 0), forall(array(1, 2, 3), x -> x % 2 = 0), aggregate(array(1, 2, 3), 0, (acc, x) -> acc + x), aggregate(array(1, 2, 3), 0, (acc, x) -> acc + x, acc -> acc * 10)', [[true, false, 6, 60]]);
eq("SELECT named_struct('a', 1, 'b', 2).b, struct(1, 'x'), map('a', 1, 'b', 2)['b'], map_keys(map('a', 1)), element_at(map('k', 'v'), 'k')", [[2, { col1: 1, col2: 'x' }, 2, ['a'], 'v']]);
eq('SELECT slice(array(1, 2, 3, 4), 2, 2), flatten(array(array(1, 2), array(3))), arrays_overlap(array(1, 2), array(2, 9)), array_position(array(3, 2, 1), 1)', [[[2, 3], [1, 2, 3], true, 3]]);

section('Generators and LATERAL VIEW');
eq('SELECT explode(array(10, 20))', [10, 20]);
eq('SELECT posexplode(array(10, 20))', [[0, 10], [1, 20]]);
eq("SELECT explode(map('a', 1, 'b', 2))", [['a', 1], ['b', 2]]);
eq("SELECT inline(array(struct(1, 'a'), struct(2, 'b')))", [[1, 'a'], [2, 'b']]);
eq('SELECT id, x FROM VALUES (1, array(5, 6)), (2, array()) AS t(id, arr) LATERAL VIEW explode(arr) e AS x', [[1, 5], [1, 6]]);
eq('SELECT id, x FROM VALUES (1, array(5, 6)), (2, array()) AS t(id, arr) LATERAL VIEW OUTER explode(arr) e AS x', [[1, 5], [1, 6], [2, null]]);
eq('SELECT * FROM explode(array(1, 2)) AS t(v)', [1, 2]);
eq('SELECT id FROM range(3)', [0, 1, 2]);
eq('SELECT cart_id, item.event_id FROM carts LATERAL VIEW explode(items) AS item WHERE cart_id = 2 ORDER BY item.event_id', val("SELECT cart_id, ev FROM (SELECT cart_id, explode(transform(items, i -> i.event_id)) AS ev FROM carts WHERE cart_id = 2) ORDER BY ev"));

section('Databricks query syntax');
eq("SELECT c, SUM(v) FROM VALUES ('a', 1), ('a', 2), ('b', 5) AS t(c, v) GROUP BY ALL ORDER BY c", [['a', 3], ['b', 5]]);
eq("SELECT c, v FROM VALUES ('a', 1), ('a', 2), ('b', 5) AS t(c, v) QUALIFY ROW_NUMBER() OVER (PARTITION BY c ORDER BY v DESC) = 1 ORDER BY c", [['a', 2], ['b', 5]]);
eq("SELECT c, v, ROW_NUMBER() OVER (PARTITION BY c ORDER BY v) AS rn FROM VALUES ('a', 1), ('a', 2) AS t(c, v) QUALIFY rn = 2", [['a', 2, 2]]);
eq("SELECT * EXCEPT (b) FROM VALUES (1, 2, 3) AS t(a, b, c)", [[1, 3]]);
eq('SELECT c.customer_id FROM customers c LEFT SEMI JOIN orders o ON o.customer_id = c.customer_id WHERE c.customer_id < 5 ORDER BY 1', val('SELECT DISTINCT c.customer_id FROM customers c JOIN orders o ON o.customer_id = c.customer_id WHERE c.customer_id < 5 ORDER BY 1'));
eq('SELECT COUNT(*) FROM customers c LEFT ANTI JOIN orders o ON o.customer_id = c.customer_id', val('SELECT COUNT(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id)').map(r => r[0]));
eq('SELECT x * 2 AS d, d + 1 AS e FROM VALUES (1), (2) AS t(x)', [[2, 3], [4, 5]]);
eq("SELECT k, SUM(v) AS total FROM VALUES ('a', 1), ('b', 9) AS t(k, v) GROUP BY k HAVING total > 5", [['b', 9]]);
eq("SELECT raw:user.id, raw:items[0].qty, raw:device['os'] FROM VALUES ('{\"user\":{\"id\":7},\"items\":[{\"qty\":3}],\"device\":{\"os\":\"ios\"}}') AS t(raw)", [['7', '3', 'ios']]);
eq("SELECT get_json_object('{\"a\":[1,2]}', '$.a'), get_json_object('{\"a\":1}', '$.missing'), to_json(named_struct('x', 1, 'y', array(1, 2)))", [['[1,2]', null, '{"x":1,"y":[1,2]}']]);
eq("SELECT r, p, SUM(x) FROM VALUES ('E', 'a', 1), ('E', 'b', 2), ('W', 'a', 3) AS t(r, p, x) GROUP BY CUBE (r, p) ORDER BY r NULLS LAST, p NULLS LAST", [['E', 'a', 1], ['E', 'b', 2], ['E', null, 3], ['W', 'a', 3], ['W', null, 3], [null, 'a', 4], [null, 'b', 2], [null, null, 6]]);
eq("SELECT k, max_by(v, ts), min_by(v, ts), collect_list(v), collect_set(k), count_if(v > 1) FROM VALUES ('a', 1, 3), ('a', 2, 1) AS t(k, v, ts) GROUP BY k", [['a', 1, 2, [1, 2], ['a'], 1]]);
eq('SELECT percentile(x, 0.5), median(x), percentile_approx(x, 0.5), percentile_approx(x, 0.1) FROM VALUES (0), (1), (2), (10) AS t(x)', [[1.5, 1.5, 1, 0]]);
eq("SELECT string_agg(k, '|') WITHIN GROUP (ORDER BY k DESC) FROM VALUES ('a'), ('c'), ('b') AS t(k)", ['c|b|a']);
eq('SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM VALUES (1), (2), (3), (10) AS t(x)', [2.5]);
eq("SELECT typeof(1), typeof(1.5), typeof('a'), typeof(DATE'2026-01-01'), typeof(array(1))", [['bigint', 'double', 'string', 'date', 'array<bigint>']]);
eq("SELECT 'a' || 'b', array(1) || array(2)", [['ab', [1, 2]]]);
eq('SELECT x FROM VALUES (3), (1), (NULL), (2) AS t(x) ORDER BY x DESC', [3, 2, 1, null]);
eq('SELECT x FROM VALUES (3), (1), (NULL), (2) AS t(x) ORDER BY x', [null, 1, 2, 3]);

section('Error classes learners will meet');
err('SELECT customer_id, city FROM customers GROUP BY customer_id', 'MISSING_AGGREGATION');
err('SELECT * FROM customer', 'TABLE_OR_VIEW_NOT_FOUND');
err('SELECT custmer_id FROM customers', 'UNRESOLVED_COLUMN');
err('SELECT customer_id FROM customers c JOIN orders o ON c.customer_id = o.customer_id', 'AMBIGUOUS_REFERENCE');
err('SELECT * FROM orders WHERE ROW_NUMBER() OVER (ORDER BY order_id) = 1', 'UNSUPPORTED_EXPR_FOR_WINDOW');
err('SELECT * FROM orders WHERE COUNT(*) > 1', 'INVALID_WHERE_CONDITION');
err('SELECT ROW_NUMBER() FROM orders', 'WINDOW_FUNCTION_WITHOUT_OVER_CLAUSE');
err('SELECT ROW_NUMBER() OVER (PARTITION BY customer_id) FROM orders', 'MISSING_ORDER_BY_FOR_WINDOW');
err('SELECT (SELECT order_id FROM orders)', 'SCALAR_SUBQUERY_TOO_MANY_ROWS');
err('SELECT a FROM VALUES (1) AS t(a) UNION SELECT 1, 2', 'NUM_COLUMNS_MISMATCH');
err('SELECT SUM(COUNT(*)) FROM orders', 'NESTED_AGGREGATE_FUNCTION');
err('SELECT foo(1)', 'UNRESOLVED_ROUTINE');
err('SELEC 1', 'PARSE_SYNTAX_ERROR');
err('SELECT 1 FROM orders ORDER BY 3', 'ORDER_BY_POS_OUT_OF_RANGE');

section('DML, MERGE and DDL');
{
  const db = fresh();
  db.execute("CREATE TABLE dim (id INT NOT NULL, name STRING, tier STRING); INSERT INTO dim VALUES (1, 'a', 'x'), (2, 'b', 'x')");
  eq("MERGE INTO dim d USING (SELECT 2 AS id, 'B' AS name, 'y' AS tier UNION ALL SELECT 3, 'c', 'x') s ON d.id = s.id WHEN MATCHED AND d.tier <> s.tier THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *", [[2, 1, 0, 1]], db);
  eq('SELECT * FROM dim ORDER BY id', [[1, 'a', 'x'], [2, 'B', 'y'], [3, 'c', 'x']], db);
  eq("MERGE INTO dim d USING (SELECT 3 AS id) s ON d.id = s.id WHEN MATCHED THEN DELETE WHEN NOT MATCHED BY SOURCE AND d.id = 1 THEN UPDATE SET tier = 'gone'", [[2, 1, 1, 0]], db);
  eq('SELECT id, tier FROM dim ORDER BY id', [[1, 'gone'], [2, 'y']], db);
  err("MERGE INTO dim d USING (SELECT 2 AS id, 'p' AS name, 'q' AS tier UNION ALL SELECT 2, 'r', 's') s ON d.id = s.id WHEN MATCHED THEN UPDATE SET *", 'DELTA_MULTIPLE_SOURCE_ROW_MATCHING_TARGET_ROW_IN_MERGE', db);
  err('INSERT INTO dim VALUES (NULL, \'n\', \'t\')', 'DELTA_NOT_NULL_CONSTRAINT_VIOLATED', db);
  err("INSERT INTO dim VALUES ('abc', 'n', 't')", 'CAST_INVALID_INPUT', db);
  err('INSERT INTO dim VALUES (9, \'n\')', 'INSERT_COLUMN_ARITY_MISMATCH', db);
  eq("INSERT INTO dim (id, name) VALUES (9, 'n')", [[1, 1]], db);
  eq("UPDATE dim SET tier = upper(name) WHERE tier IS NULL", [[1]], db);
  eq("DELETE FROM dim WHERE id > 5", [[1]], db);
  err('CREATE TABLE dim (x INT)', 'TABLE_OR_VIEW_ALREADY_EXISTS', db);
  eq("CREATE OR REPLACE TEMP VIEW v AS SELECT id FROM dim WHERE id < 2; SELECT * FROM v", [1], db);
  eq('CREATE TABLE ctas AS SELECT status, COUNT(*) AS n FROM orders GROUP BY status; SELECT COUNT(*) FROM ctas', [4], db);
  err('CREATE TABLE bad AS SELECT 1 AS a, 2 AS a', 'COLUMN_ALREADY_EXISTS', db);
}

console.log(failures ? `\n${failures} of ${checks} checks failed` : `\nAll ${checks} checks passed.`);
process.exit(failures ? 1 : 0);
