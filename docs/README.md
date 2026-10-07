# The guide

| Chapter | Covers |
|---|---|
| [1. Reading query plans](01-reading-plans.md) | Getting real plans on each engine, reading operators, rows read versus returned, loops, work units |
| [2. Sargable predicates](02-sargable-predicates.md) | Functions on columns, implicit conversions, half-open ranges, OR, LIKE, expression indexes |
| [3. Index design](03-index-design.md) | Composite column order, covering and index-only scans, order-providing, partial and foreign-key indexes, what indexes cost |
| [4. Query rewrites](04-query-rewrites.md) | N+1 subqueries, window functions instead of self-joins, semi-joins, existence checks, eager aggregation, computing once |
| [5. Pagination and top-N](05-pagination-and-top-n.md) | Top-N with indexes, why OFFSET is slow, keyset pagination, top-N per group |
| [6. How the lab's engine works](06-how-the-engine-works.md) | What the planner does and does not do, the cost model, how it is verified |
