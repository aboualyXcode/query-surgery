# 3. Index design

An index is a sorted copy of some columns, plus a pointer to each row. It speeds up reads that can use its order, and slows down every write to the table. Index design is choosing which sorted copies are worth their cost.

## Composite indexes: order by how the columns are filtered

A composite index `(a, b, c)` is sorted by `a`, then `b` within `a`, then `c`. It can narrow the search with:

- equality on a leading prefix (`a = ?`, `a = ? AND b = ?`);
- then **one** range on the next column (`a = ? AND b > ?`).

Put **equality columns first and the range column last**. `(status, order_ts)` answers `status = 'REFUNDED' AND order_ts in 2025` by jumping to exactly those rows; `(order_ts, status)` must read every 2025 order and check its status. In `EXPLAIN ANALYZE`, many index entries read for few rows returned is the signature of a wrong column order.

"Most selective column first" is a myth when the less selective column is filtered by equality and the other by range.

## Covering indexes and index-only scans

If an index contains every column a query needs, the engine never visits the table: an **index-only scan**. For queries returning many rows this removes one random read per row.

- **PostgreSQL, SQL Server:** `CREATE INDEX … (key_cols) INCLUDE (other_cols)` adds payload columns that are not part of the key.
- **MySQL (InnoDB), Oracle, SQLite:** append the columns to the key. InnoDB secondary indexes also carry the primary key.
- `SELECT *` defeats covering. Select the columns you need.

## Indexes that provide order

An index on `(customer_id, order_ts)` stores each customer's orders in time order. `WHERE customer_id = ? ORDER BY order_ts DESC LIMIT 20` reads 20 entries and stops: no sort, regardless of how many orders the customer has. B-trees can be walked backwards, so a single-column DESC rarely needs a DESC index; mixed directions (`ORDER BY a ASC, b DESC`) do.

## Partial (filtered) indexes

`CREATE INDEX … ON orders (order_ts) WHERE status = 'PLACED'` indexes only the rows a hot query cares about: smaller, faster to maintain, and fully cached. Supported by PostgreSQL and SQLite; SQL Server calls them filtered indexes. The query must include the same condition for the planner to use the index.

## Foreign keys

Primary keys are indexed automatically; foreign keys usually are not (PostgreSQL, SQL Server and Oracle do not create them; MySQL InnoDB does). An unindexed foreign key makes every "children of this parent" lookup a scan, and every delete of a parent row scan the child table.

## What indexes cost

- **Writes:** every insert updates every index; updates touch indexes containing changed columns; deletes remove entries.
- **Space and cache:** indexes compete with data for memory.
- **Planning:** more choices for the optimizer, occasionally worse ones.

Drop indexes that:
- duplicate the leading prefix of another (`(a)` when `(a, b)` exists);
- serve no query;
- index a column with a handful of values that queries never filter on alone.

Check real usage before dropping:

| Engine | Usage statistics |
|---|---|
| PostgreSQL | `pg_stat_user_indexes` |
| SQL Server | `sys.dm_db_index_usage_stats` |
| MySQL | `sys.schema_unused_indexes` |
| Oracle | index monitoring |

## A process

1. Collect the hot queries, with frequencies (`pg_stat_statements`, Query Store, performance_schema, AWR).
2. For each, design the ideal index: equality columns, then range or order columns, then included columns.
3. Merge overlapping designs into fewer indexes that serve several queries.
4. Weigh total read savings against write and storage costs.
5. Verify with `EXPLAIN ANALYZE`, and monitor.

**Practise:** the six Index design challenges. They grade the whole workload, including index maintenance.
