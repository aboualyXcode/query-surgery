# 4. Query rewrites

Some slow queries are slow because of their shape, not their indexes. No index makes a quadratic algorithm linear, and optimizers rewrite far less than people assume. These rewrites apply on every engine.

## Correlated subqueries: the N+1 inside the database

```sql
-- runs both subqueries once per customer
SELECT c.customer_id,
       (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.customer_id) AS orders,
       (SELECT SUM(total_amount) FROM orders o WHERE o.customer_id = c.customer_id) AS spent
FROM customers c;
```

Aggregate once and join:

```sql
SELECT c.customer_id, COALESCE(s.orders, 0) AS orders, s.spent
FROM customers c
LEFT JOIN (SELECT customer_id, COUNT(*) AS orders, SUM(total_amount) AS spent
           FROM orders GROUP BY customer_id) s ON s.customer_id = c.customer_id;
```

Keep the semantics: a LEFT JOIN preserves customers without orders, and a count over nothing must become 0. SQL Server and Oracle decorrelate many scalar subqueries automatically; PostgreSQL executes them as per-row SubPlans. Write the set-based form and you are fast everywhere.

## Window functions instead of self-joins

| Problem | Quadratic form | Window form |
|---|---|---|
| Running total | Self-join on `b.id <= a.id` | `SUM(x) OVER (PARTITION BY k ORDER BY id ROWS UNBOUNDED PRECEDING)` |
| Latest row per group | `WHERE ts = (SELECT MAX(ts) … correlated)` | `ROW_NUMBER() OVER (PARTITION BY k ORDER BY ts DESC) = 1` |
| Top N per group | `(SELECT COUNT(*) … bigger) < N` | `ROW_NUMBER() … <= N` |
| Compare to group average | `x > (SELECT AVG(x) … correlated)` | `x > AVG(x) OVER (PARTITION BY k)` |

A window function sorts once and computes in a single pass. Add a tie-breaker to `ORDER BY` so results are deterministic.

## Semi-joins instead of JOIN + DISTINCT

`SELECT DISTINCT c.* FROM customers c JOIN orders o …` materializes every match and then deduplicates. The question is "does a match exist?":

```sql
SELECT c.* FROM customers c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.customer_id AND …);
```

Most optimizers run `EXISTS` and `IN (subquery)` as hashed semi-joins (the lab does too). `NOT EXISTS` is the safe anti-join; `NOT IN` returns nothing when the subquery yields a single NULL.

## Existence checks

`COUNT(*) > 0` finds every match; `EXISTS` stops at the first. In application code, prefer `SELECT 1 … LIMIT 1` to fetching a count to test for zero.

## Aggregate before joining

Joining 60,000 orders to customers and then grouping by country moves 60,000 rows through the join. Aggregating orders per customer first moves at most 5,000. This works for additive measures (counts, sums); rebuild averages from sums and counts. Few optimizers do this "eager aggregation" on their own.

## Compute once

Any expression that does not depend on the current row (a subquery for a global average, a lookup table, a date boundary) should be computed once: a CTE, a derived table joined once, or a variable. Correlated subqueries that recompute the same value per row are the most expensive way to get a constant.

## UNION ALL versus UNION

`UNION` deduplicates, which costs a sort or hash of everything. When the branches cannot overlap, or duplicates are correct, use `UNION ALL`.

## What optimizers usually do for you

Good optimizers already:
- push filters into joins and many subqueries;
- choose join algorithms and join order;
- remove unused joins on unique keys;
- turn `IN`/`EXISTS` into semi-joins.

They usually do **not**:
- rewrite self-joins as window functions;
- aggregate before joining;
- make non-sargable predicates sargable;
- page efficiently with `OFFSET`.

Spend your effort on the second list.

**Practise:** the seven Query rewrites challenges.
