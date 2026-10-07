# 1. Reading query plans

Every optimization starts with the plan: what the engine actually did, how many rows each step produced, and where the time went. Guessing from the SQL text is how people "optimize" the wrong part.

## Ask for the plan, with real numbers

| Engine | Estimated plan | Plan with actual rows and time |
|---|---|---|
| PostgreSQL | `EXPLAIN query` | `EXPLAIN (ANALYZE, BUFFERS) query` |
| MySQL 8 | `EXPLAIN query` | `EXPLAIN ANALYZE query` |
| SQL Server | Estimated execution plan | Actual execution plan, `SET STATISTICS IO, TIME ON` |
| Oracle | `EXPLAIN PLAN FOR …` | `DBMS_XPLAN.DISPLAY_CURSOR` with `ALLSTATS LAST` |
| SQLite | `EXPLAIN QUERY PLAN query` | — |
| Databricks / Spark | `EXPLAIN FORMATTED query` | Query profile in the UI |

`ANALYZE` variants **run the query**. Be careful with statements that change data.

## How to read one

Plans are trees: each operator consumes its children's rows. Read from the most indented line upwards.

```
HashAggregate  (rows=4 loops=1 work=30 ms)
  Group Key: c.country
->  Hash Join  (rows=60000 loops=1 work=69 ms)
      Join Cond: o.customer_id = c.customer_id
  ->  Seq Scan on customers c  (rows=5000 loops=1 work=5.0 ms)
  ->  Seq Scan on orders o  (rows=60000 loops=1 work=60 ms)
```

For each operator, ask:

1. **How many rows did it produce, and how many did it read to get them?** "Rows removed by filter" (in the lab: *Index entries read*, *Rows read*) far above the output means wasted reading.
2. **How many times did it run?** `loops=5000` under a SubPlan is the N+1 problem.
3. **How much of the total work is it?** Fix the biggest node first. The lab highlights nodes doing over 40% of the work.

## Operators you will meet

| Operator | Means | Watch for |
|---|---|---|
| Seq Scan | Read every row of a table | Fine for small tables or most of a table; a smell when the result is a handful of rows |
| Index Scan | Walk part of an index, fetch matching rows from the table | Many entries read for few rows returned: wrong column order or a weak filter |
| Index Only Scan | Answer from the index alone | The goal for hot queries; impossible with `SELECT *` |
| Hash Join | Build a hash table on one side, probe with the other | Large builds; fine for big joins |
| Nested Loop + Index Scan | For each outer row, look up matches by index | Great when the outer side is small; disastrous without an index |
| Sort | Sort the rows | Avoidable when an index already provides the order and there is a LIMIT |
| HashAggregate | Group rows in a hash table | Grouping more rows than necessary (aggregate before joining) |
| SubPlan (runs=N) | A subquery executed per row | N in the thousands: decorrelate it |

## Estimates versus reality

Real optimizers choose plans from **estimated** row counts based on statistics. When estimates are badly wrong (stale statistics, correlated columns, functions in predicates), they choose badly. Compare estimated and actual rows in `EXPLAIN ANALYZE`; keep statistics fresh (`ANALYZE`, `UPDATE STATISTICS`, auto-stats). The lab's planner uses exact counts, so it isolates the techniques from estimation errors; [chapter 6](06-how-the-engine-works.md) explains.

## Work units in the lab

The lab reports **work** instead of wall time, so results are deterministic: 1 unit ≈ 1 µs on a single-node engine. Reading a row costs 1, an index seek about 4 plus log₂(entries), each index entry 0.3, each table fetch after an index 1.5, and so on. Queries over 5 s of work are cancelled, like a statement timeout.
