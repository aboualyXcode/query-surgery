# 5. Pagination and top-N

Fetching "the first 20" or "the next page" looks cheap and often is not. The difference between a fast and a slow version is whether the engine can stop early.

## Top-N needs an index in the right order

`ORDER BY order_ts DESC LIMIT 10` on a table without a suitable index reads and sorts everything. With an index on `order_ts`, the engine walks the index from the end, returns 10 rows and stops. With a filter, the index must start with the filter's equality columns: `(customer_id, order_ts)` for `WHERE customer_id = ? ORDER BY order_ts DESC LIMIT 20`.

In the lab's plans, `Sort (skipped: rows arrive in index order)` and a scan with `rows=10` confirm it.

## OFFSET reads what it skips

`LIMIT 50 OFFSET 100000` produces 100,050 rows and throws away 100,000. Every page is slower than the last, and rows inserted between requests shift the pages, so users see duplicates or miss rows.

## Keyset (seek) pagination

Continue from the last row the client saw:

```sql
-- page 1
SELECT log_id, … FROM activity_log ORDER BY log_id LIMIT 50;
-- next page: the client sends the last log_id it received
SELECT log_id, … FROM activity_log WHERE log_id > :last_id ORDER BY log_id LIMIT 50;
```

Every page costs the same, however deep. For a non-unique sort column, page on a tuple that is unique:

```sql
WHERE (created_at, log_id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, log_id DESC
LIMIT 50
```

(Row-value comparison is supported by PostgreSQL, MySQL and SQLite; elsewhere expand it to `created_at < :c OR (created_at = :c AND log_id < :id)`.) Index `(created_at, log_id)` to match.

The trade-off: no "jump to page 237". Use keyset pagination for feeds, infinite scroll, exports and APIs; keep OFFSET for small, shallow result sets.

## Top-N per group

"The three largest orders per event" with a correlated count is quadratic per group. Rank with a window function instead:

```sql
SELECT * FROM (
  SELECT o.*, ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY total_amount DESC, order_id) AS rn
  FROM orders o
) ranked WHERE rn <= 3;
```

When the number of groups is small and each group is indexed by the ranking column, a `LATERAL` join (PostgreSQL, MySQL 8, Oracle) or `CROSS APPLY` (SQL Server) with `ORDER BY … LIMIT 3` per group can beat ranking everything.

**Practise:** the two Pagination and top-N challenges.
