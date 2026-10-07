# 6. How the lab's engine works

The playground runs on a SQL engine written in JavaScript, extended for this lab with B-tree indexes, a cost-based planner, `EXPLAIN ANALYZE` and a work meter. Its planner deliberately does what nearly every engine does, and no more, so the techniques you practise transfer.

## What the planner does

- **Access paths.** For each table it compares a sequential scan with every usable index, using exact counts from the index:
  - index range scans for equality, `IN`, ranges, `BETWEEN` and `LIKE 'prefix%'`;
  - index-only scans when the index covers every column the query uses;
  - ordered index scans that skip the sort and stop at the `LIMIT` (including keyset ranges);
  - partial indexes when the query repeats the index's condition.
- **Sargability.** Predicates on functions, arithmetic or casts of a column, leading-wildcard `LIKE`, `OR` across columns, `<>`, and a text column compared with a number cannot use an index, and the plan explains why in a Note.
- **Pushdown.** WHERE conditions on a single table are applied in that table's scan, below joins, except on the nullable side of an outer join, where that would change results. Single-table ON conditions are pushed into the inner side of inner, left, semi and anti joins.
- **Joins.** Hash joins for equality joins. At run time, an index nested loop when an index on the inner join key makes that cheaper (typically when the outer side is small). Plain nested loops for non-equality joins.
- **Subqueries.**
  - Uncorrelated subqueries run once and are cached; `IN` lists from them are probed as hash sets.
  - `EXISTS` with one equality correlation runs as a hashed semi-join.
  - Other correlated subqueries run once per outer row, shown as `SubPlan (runs=N)`.
  - An uncorrelated `EXISTS` stops at its first row.

## What it does not do

These are deliberate, and documented so you do not over-learn the lab:
- **No join reordering.** Joins run in the order written. Real optimizers reorder joins, so the lab has no challenges about join order.
- **No predicate pushdown into derived tables, CTEs or views.** Real engines often do this; no challenge depends on it.
- **No decorrelation of scalar subqueries.** PostgreSQL behaves the same way; SQL Server and Oracle often decorrelate. The set-based rewrite is faster everywhere.
- **No estimation errors.** Real planners work from statistics and can be misled; the lab uses exact counts, so it isolates the techniques from estimation problems.
- **No buffer cache, parallelism, memory limits or I/O model.** Work units model CPU-like effort on a single node.

## The cost model

| Operation | Work units |
|---|---|
| Read a row in a sequential scan | 1 |
| Index seek | 4 + log₂(entries) |
| Read an index entry | 0.3 |
| Fetch a row after an index entry (not for index-only scans) | 1.5 |
| Hash join: build per row / probe per row / per candidate pair | 1 / 0.5 / 1 |
| Nested loop, per pair | 1 |
| Aggregate per row | 0.5 |
| Sort | 0.2 per row + 0.1 × log₂(n) per row |
| Window functions | 0.6 per row + a sort, per window |
| DISTINCT / set operations | 0.5 per row |
| Correlated subquery, per run | 2 (plus its own work) |
| Maintaining one index entry on insert (index challenges) | 6 |

One unit is roughly a microsecond on a single-node engine, so 5,000,000 units is the 5-second statement timeout.

## How it is verified

| Suite | Checks |
|---|---|
| `tests/differential_sqlite.py` | 101 queries return identical results on the engine and on SQLite, and every query runs **twice** on the engine, without and with 14 indexes, so access paths, index nested loops, pushdown and decorrelation never change a result. |
| `tests/engine.test.js` | 104 checks of SQL semantics SQLite cannot cover (dialect functions, generators, MERGE, error classes). |
| `tests/planner.test.js` | The planner's choices: sargability notes, covering, ordered and partial indexes, keyset ranges, join selection, decorrelation, outer-join pushdown safety, timeouts. |
| `tests/challenges.test.js` | Every challenge: the slow query misses the target or times out; solutions and alternatives return exactly the slow query's result and meet the target; traps and cheats (schema changes, different results) are rejected. |

The SQL dialect is inherited from the engine's previous project, so it accepts standard SQL plus a few Databricks extensions (`QUALIFY`, `GROUP BY ALL`). Challenges use only portable SQL.
