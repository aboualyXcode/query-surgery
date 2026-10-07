/* data.js: the Stagedoor dataset for Query Surgery. Deterministic and big enough that the difference
   between a good and a bad plan is dramatic: 5,000 customers, 60,000 orders, ~110,000 order lines and
   120,000 activity-log rows. Only primary keys are indexed; each challenge adds its own indexes. */
(function (root) {
  'use strict';
  function rng(seed) { let a = seed | 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const DAY = 86400000, D0 = Date.UTC(2024, 0, 1);
  const iso = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const day = ms => new Date(ms).toISOString().slice(0, 10);

  function build() {
    const r = rng(424242);
    const pick = a => a[Math.floor(r() * a.length)];
    const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    const countries = [['DE', ['Berlin', 'Hamburg', 'Munich']], ['PT', ['Lisbon', 'Porto']], ['JP', ['Osaka', 'Tokyo']], ['US', ['Austin', 'Chicago', 'Seattle']], ['GB', ['London', 'Leeds']], ['ES', ['Madrid', 'Seville']], ['KE', ['Nairobi']], ['CA', ['Toronto', 'Vancouver']]];
    const first = ['Amara', 'Diego', 'Hana', 'Layla', 'Noah', 'Priya', 'Tomas', 'Wanjiru', 'Yuki', 'Elena', 'Sam', 'Omar', 'Lucia', 'Kenji', 'Zara', 'Felix', 'Ines', 'Malik', 'Sofia', 'Arjun'];
    const last = ['Okafor', 'Ramos', 'Sato', 'Hassan', 'Fischer', 'Nair', 'Silva', 'Kamau', 'Tanaka', 'Ruiz', 'Carter', 'Haddad', 'Moreno', 'Ito', 'Ali', 'Weber', 'Costa', 'Owusu', 'Rossi', 'Mehta'];

    const customers = [];
    for (let i = 1; i <= 5000; i++) {
      const [cc, cities] = pick(countries);
      const f = pick(first), l = pick(last);
      customers.push([i, String(i).padStart(7, '0'), `${f.toLowerCase()}.${l.toLowerCase()}${i}@example.com`, `${f} ${l}`, cc, pick(cities), day(D0 + int(0, 900) * DAY), pick(['standard', 'standard', 'standard', 'silver', 'silver', 'gold', 'platinum'])]);
    }
    const venues = [];
    for (let i = 1; i <= 40; i++) { const [cc, cities] = countries[i % countries.length]; venues.push([i, `Venue ${i}`, cities[i % cities.length], cc, int(800, 9000)]); }
    const genres = ['Rock', 'Pop', 'Jazz', 'Electronic', 'Indie', 'Metal', 'R&B', 'Classical'];
    const events = [];
    for (let i = 1; i <= 300; i++) events.push([i, `Artist ${1 + (i * 7) % 120}`, int(1, 40), day(D0 + int(30, 1000) * DAY), pick(genres), int(25, 220)]);

    const orders = [], items = [], refunds = [];
    let lineTotal = 0;
    for (let o = 1; o <= 60000; o++) {
      // a few heavy customers, like real marketplaces
      const c = r() < 0.08 ? int(1, 40) : int(1, 5000);
      const ev = events[int(0, events.length - 1)];
      const t = D0 + Math.floor((o / 60000) * 950 * DAY) + int(0, 86399) * 1000;
      const status = pick(['PAID', 'PAID', 'PAID', 'PAID', 'PAID', 'PAID', 'PAID', 'PLACED', 'CANCELLED', 'REFUNDED']);
      const n = int(1, 3);
      let total = 0;
      for (let k = 1; k <= n; k++) { const q = int(1, 4), price = ev[5] * (k === 1 ? 1 : pick([1, 1.5, 2.5])); items.push([o, k, q, price]); total += q * price; lineTotal++; }
      orders.push([o, c, ev[0], iso(t), status, pick(['web', 'web', 'app', 'app', 'partner']), Math.round(total * 100) / 100]);
      if (status === 'REFUNDED') refunds.push([refunds.length + 1, o, iso(t + int(1, 20) * DAY), Math.round(total * 100) / 100]);
    }
    const activity = [];
    for (let i = 1; i <= 120000; i++) {
      const t = D0 + Math.floor((i / 120000) * 950 * DAY) + int(0, 3599) * 1000;
      activity.push([i, int(1, 5000), pick(['login', 'view_event', 'view_event', 'search', 'add_to_cart', 'checkout', 'logout']), iso(t), pick(['web', 'ios', 'android'])]);
    }
    void lineTotal;
    return [
      { name: 'customers', cols: [['customer_id', 'INT'], ['customer_code', 'STRING'], ['email', 'STRING'], ['full_name', 'STRING'], ['country', 'STRING'], ['city', 'STRING'], ['signup_date', 'DATE'], ['tier', 'STRING']], rows: customers, pk: ['customer_id'], description: 'One row per customer. customer_code is the legacy CRM id, stored as text.' },
      { name: 'venues', cols: [['venue_id', 'INT'], ['name', 'STRING'], ['city', 'STRING'], ['country', 'STRING'], ['capacity', 'INT']], rows: venues, pk: ['venue_id'], description: 'One row per venue.' },
      { name: 'events', cols: [['event_id', 'INT'], ['artist', 'STRING'], ['venue_id', 'INT'], ['event_date', 'DATE'], ['genre', 'STRING'], ['base_price', 'DOUBLE']], rows: events, pk: ['event_id'], description: 'One row per concert.' },
      { name: 'orders', cols: [['order_id', 'INT'], ['customer_id', 'INT'], ['event_id', 'INT'], ['order_ts', 'TIMESTAMP'], ['status', 'STRING'], ['channel', 'STRING'], ['total_amount', 'DOUBLE']], rows: orders, pk: ['order_id'], description: 'One row per order. A few customers place many orders.' },
      { name: 'order_items', cols: [['order_id', 'INT'], ['line_no', 'INT'], ['quantity', 'INT'], ['unit_price', 'DOUBLE']], rows: items, pk: ['order_id', 'line_no'], description: 'One row per order line.' },
      { name: 'refunds', cols: [['refund_id', 'INT'], ['order_id', 'INT'], ['refund_ts', 'TIMESTAMP'], ['amount', 'DOUBLE']], rows: refunds, pk: ['refund_id'], description: 'One row per refund.' },
      { name: 'activity_log', cols: [['log_id', 'INT'], ['customer_id', 'INT'], ['action', 'STRING'], ['created_at', 'TIMESTAMP'], ['device', 'STRING']], rows: activity, pk: ['log_id'], description: 'App and web activity, newest last. 120,000 rows.' },
    ];
  }

  let cached = null;
  function load(db) {
    const X = root.SQLX;
    if (!cached) cached = build();
    for (const t of cached) {
      const cols = t.cols.map(([name, base]) => ({ name, type: { base } }));
      const conv = t.cols.map(([, base]) => (base === 'DATE' ? v => X.castValue(v, { base: 'DATE' }) : base === 'TIMESTAMP' ? v => X.castValue(v, { base: 'TIMESTAMP' }) : null));
      if (!t.converted) { t.converted = t.rows.map(row => row.map((v, i) => (v == null || !conv[i] ? v : conv[i](v)))); }
      db.createTable(t.name, cols, t.converted);
      const tb = db.tables.get(t.name);
      tb.description = t.description; tb.pk = t.pk;
    }
    const saved = db.timeout; db.timeout = Infinity;
    db.execute(cached.map(t => `CREATE UNIQUE INDEX ${t.name}_pkey ON ${t.name} (${t.pk.join(', ')})`).join(';\n'));
    db.timeout = saved;
    return db;
  }
  root.SQLX = root.SQLX || {};
  root.SQLX.dataset = { build, load };
  root.SQLX.NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : global);
