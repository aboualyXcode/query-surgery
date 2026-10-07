# 2. Sargable predicates

A predicate is **sargable** (Search ARGument ABLE) when an index can narrow the search with it. The rule underneath is simple: a B-tree index is sorted by the column's raw values, so only conditions on the **bare column** can use that order.

| Not sargable | Sargable rewrite |
|---|---|
| `WHERE year(order_ts) = 2025` | `WHERE order_ts >= '2025-01-01' AND order_ts < '2026-01-01'` |
| `WHERE CAST(order_ts AS DATE) = '2025-06-15'` | `WHERE order_ts >= '2025-06-15' AND order_ts < '2025-06-16'` |
| `WHERE total * 1.1 > 3000` | `WHERE total > 3000 / 1.1` |
| `WHERE lower(email) LIKE 'amara.%'` | `WHERE email LIKE 'amara.%'` (store normalized data), or an expression index |
| `WHERE code = 4321` on a text column | `WHERE code = '0004321'` |
| `WHERE a = 1 OR b = 2` | `… WHERE a = 1 UNION ALL … WHERE b = 2 AND a <> 1` |
| `WHERE email LIKE '%@example.com'` | A reversed-value column, a trigram or full-text index |

## Functions on columns

`year(col)`, `CAST(col AS …)`, `date_trunc(…, col)`, `lower(col)`, `col + 0`, `COALESCE(col, …)`: the engine must compute the expression for every row before it can compare, so the index order is useless. Move the work to the constant side.

When you genuinely need to search by an expression, most engines let you index it:

- **PostgreSQL, Oracle, SQLite:** expression indexes, `CREATE INDEX ON customers (lower(email))`.
- **MySQL 8:** functional key parts, `CREATE INDEX i ON customers ((lower(email)))`.
- **SQL Server:** an indexed computed column.

## Implicit conversions

Comparing values of different types forces a conversion. When the engine converts the **column** (MySQL and SQL Server do this for a text column compared with a number), every row is converted and the index is skipped. ORMs that bind a parameter with the wrong type (`nvarchar` against a `varchar` column in SQL Server is the classic) cause the same scan. Match parameter types to column types.

## Ranges: half-open is safest

`col >= start AND col < next_start` covers a day, month or year exactly, whatever the timestamp precision. `BETWEEN '…' AND '… 23:59:59'` silently misses fractional seconds.

## OR across columns

One index range cannot answer `a = 1 OR b = 2`. Some engines combine two index scans (bitmap OR in PostgreSQL, index merge in MySQL); others scan. Splitting into `UNION ALL`, with the second branch excluding the first branch's rows, works everywhere. `UNION` works too but pays for deduplication.

## LIKE

`LIKE 'prefix%'` is a range scan. A leading wildcard is not: no index order can find "anything ending in …". Note that some collations prevent the prefix optimization (PostgreSQL needs `text_pattern_ops` or the C collation).

## Negations

`<>`, `NOT IN` and `NOT LIKE` match most of the table; even when an index could serve them, scanning is usually cheaper. Rewrite them as positive conditions when the excluded set is the large one.

**Practise:** the six Sargable predicates challenges.
