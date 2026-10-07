/* data.js: the Stagedoor dataset every challenge runs against. Deterministic (same seed, same rows)
   so expected answers are stable. It is deliberately imperfect in the ways production data is:
   duplicate payments, refunds without payments, customers with no orders, messy raw sign-ups,
   JSON app events, nested carts, NULLs where you least want them, and gaps in daily snapshots. */
(function (root) {
  'use strict';
  function rng(seed) { let a = seed | 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const T = (name, cols, rows, description) => ({ name, description, cols: cols.map(c => { const [n, t] = c.split(' '); return { name: n, type: t }; }), rows });

  function build() {
    const r = rng(20260305);
    const pick = a => a[Math.floor(r() * a.length)];
    const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    const pad = n => String(n).padStart(2, '0');
    const date = ms => new Date(ms).toISOString().slice(0, 10);
    const ts = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const D0 = Date.UTC(2025, 0, 1), DAY = 86400000;
    const money = n => Math.round(n * 100) / 100;

    const cities = [['Berlin', 'DE'], ['Lisbon', 'PT'], ['Osaka', 'JP'], ['Cairo', 'EG'], ['Austin', 'US'], ['Toronto', 'CA'], ['Nairobi', 'KE'], ['Madrid', 'ES'], ['London', 'GB'], ['Chicago', 'US']];
    const first = ['Amara', 'Diego', 'Hana', 'Layla', 'Noah', 'Priya', 'Tomás', 'Wanjiru', 'Yuki', 'Elena', 'Sam', 'Omar', 'Lucía', 'Kenji', 'Zara', 'Felix', 'Ines', 'Malik', 'Sofia', 'Arjun', 'Chloe', 'Mateo', 'Aisha', 'Lena'];
    const last = ['Okafor', 'Ramos', 'Sato', 'Hassan', 'Fischer', 'Nair', 'Silva', 'Kamau', 'Tanaka', 'Ruiz', 'Carter', 'Haddad', 'Moreno', 'Ito', 'Ali', 'Weber', 'Costa', 'Owusu', 'Rossi', 'Mehta', 'Martin', 'Lopez', 'Bello', 'Novak'];

    /* customers */
    const customers = [];
    for (let i = 1; i <= 120; i++) {
      const [city, country] = pick(cities);
      const fn = first[(i * 7) % first.length], ln = last[(i * 11) % last.length];
      const signup = D0 + int(0, 420) * DAY;
      customers.push([i, `${fn} ${ln}`, i % 29 === 0 ? null : `${fn}.${ln}${i}@example.com`.toLowerCase().replace(/[áéíóú]/g, c => 'aeiou'['áéíóú'.indexOf(c)]), city, country, date(signup), pick(['Bronze', 'Bronze', 'Bronze', 'Silver', 'Silver', 'Gold', 'Platinum']), i > 10 && r() < 0.25 ? int(1, i - 1) : null, r() < 0.9]);
    }

    /* venues and events */
    const venues = [
      [1, 'Olympia Hall', 'Berlin', 'DE', 4200], [2, 'Coliseu', 'Lisbon', 'PT', 3000], [3, 'Zepp Bayside', 'Osaka', 'JP', 2800], [4, 'Cairo Opera Garden', 'Cairo', 'EG', 5000],
      [5, 'Moody Theater', 'Austin', 'US', 2750], [6, 'Massey Hall', 'Toronto', 'CA', 2500], [7, 'Carnivore Grounds', 'Nairobi', 'KE', 8000], [8, 'La Riviera', 'Madrid', 'ES', 2500],
      [9, 'Roundhouse', 'London', 'GB', 3300], [10, 'Metro', 'Chicago', 'US', 1100],
    ];
    const artists = [['Aurora Vale', 'Indie'], ['The Ferrymen', 'Rock'], ['Kaito & Mira', 'Pop'], ['Desert Static', 'Electronic'], ['Nia Sol', 'R&B'], ['Glass Harbor', 'Indie'], ['Brass Republic', 'Jazz'], ['Luma', 'Electronic'], ['Iron Orchard', 'Metal'], ['Velvet Ash', 'Rock']];
    const events = [];
    for (let i = 1; i <= 30; i++) {
      const [artist, genre] = artists[(i - 1) % artists.length];
      const v = venues[(i * 3) % venues.length];
      events.push([100 + i, artist, `${artist} ${pick(['Live', 'World Tour', 'Unplugged', 'Night', 'Farewell Show'])}`, v[0], date(D0 + int(60, 540) * DAY), genre, money(int(35, 160) + pick([0, 0.5, 0.99]))]);
    }
    const ticketTypes = [['General', 1], ['VIP', 2.5], ['Balcony', 1.3]];

    /* orders, items, payments, refunds */
    const orders = [], items = [], payments = [], refunds = [];
    let payId = 5001, refundId = 7001;
    for (let o = 1; o <= 900; o++) {
      const c = customers[int(0, customers.length - 1)];
      if (c[0] % 17 === 0) { o--; if (r() < 0.98) continue; } // a few customers never order
      const ev = pick(events);
      const signup = Date.parse(c[5]);
      const t = Math.max(signup, Date.parse(ev[4]) - int(1, 150) * DAY) + int(0, 86399) * 1000;
      const status = pick(['PAID', 'PAID', 'PAID', 'PAID', 'PAID', 'PAID', 'PLACED', 'CANCELLED', 'REFUNDED']);
      const channel = pick(['web', 'web', 'app', 'app', 'partner']);
      orders.push([10000 + o, c[0], ev[0], ts(t), status, channel, r() < 0.12 ? pick(['SPRING10', 'VIP20', 'FRIENDS']) : null]);
      const lines = int(1, 3);
      let total = 0;
      for (let l = 1; l <= lines; l++) {
        const [tt, mult] = ticketTypes[l === 1 ? 0 : int(0, 2)];
        const q = int(1, 4), price = money(ev[6] * mult);
        items.push([10000 + o, l, tt, q, price]);
        total += q * price;
      }
      total = money(total);
      if (status === 'PAID' || status === 'REFUNDED') {
        payments.push([payId++, 10000 + o, ts(t + int(30, 3600) * 1000), total, pick(['card', 'card', 'card', 'paypal', 'apple_pay']), 'SETTLED']);
        if (r() < 0.04) payments.push([payId++, 10000 + o, ts(t + int(3601, 7200) * 1000), total, 'card', 'SETTLED']); // duplicate charge
        if (status === 'REFUNDED') refunds.push([refundId++, 10000 + o, ts(t + int(2, 20) * DAY), total, pick(['event_cancelled', 'customer_request', 'duplicate_charge'])]);
      }
      if (status === 'PLACED' && r() < 0.3) payments.push([payId++, 10000 + o, ts(t + 600000), total, 'card', 'FAILED']);
    }
    refunds.push([refundId++, 99999, ts(D0 + 400 * DAY), 50, 'customer_request']); // orphan refund: no such order
    /* card declined, then retried successfully: a FAILED attempt next to a SETTLED charge */
    orders.filter((o, i) => o[4] === 'PAID' && i % 23 === 5).forEach(o => {
      const settled = payments.find(p => p[1] === o[0] && p[5] === 'SETTLED');
      payments.push([payId++, o[0], ts(Date.parse(settled[2] + 'Z') - 120000), settled[3], 'card', 'FAILED']);
    });

    /* web sessions (page views) for sessionization and funnels */
    const views = [];
    let viewId = 1;
    for (let s = 0; s < 260; s++) {
      const c = r() < 0.8 ? int(1, 120) : null;
      let t = D0 + int(200, 500) * DAY + int(0, 86399) * 1000;
      const n = int(1, 9);
      const ev = pick(events)[0];
      const funnel = ['home', 'event', 'seats', 'checkout', 'confirmation'];
      const depth = Math.min(funnel.length, 1 + Math.floor(r() * r() * 6));
      for (let k = 0; k < n; k++) {
        const page = k < depth ? funnel[k] : pick(['home', 'event', 'search', 'faq']);
        views.push([viewId++, c, ts(t), page, page === 'event' || page === 'seats' || page === 'checkout' ? ev : null, pick(['mobile', 'desktop', 'desktop'])]);
        t += (r() < 0.12 ? int(31, 180) * 60 : int(5, 600)) * 1000; // occasional long gap = new session
      }
    }
    views.sort((a, b) => (a[2] < b[2] ? -1 : 1)).forEach((v, i) => { v[0] = i + 1; });

    /* employees: an org chart for recursive queries */
    const employees = [
      [1, 'Rhea Calloway', 'CEO', null, 'Executive', '2019-03-01', 310000],
      [2, 'Marcus Dube', 'VP Engineering', 1, 'Engineering', '2019-06-15', 240000], [3, 'Ana Ferreira', 'VP Operations', 1, 'Operations', '2020-01-10', 225000],
      [4, 'Jonas Berg', 'Data Platform Lead', 2, 'Engineering', '2020-04-01', 190000], [5, 'Mei Lin', 'Backend Lead', 2, 'Engineering', '2020-09-12', 185000],
      [6, 'Kofi Mensah', 'Support Manager', 3, 'Operations', '2021-02-01', 140000], [7, 'Lara Novak', 'Finance Manager', 3, 'Finance', '2021-05-20', 150000],
      [8, 'Ibrahim Khalil', 'Data Engineer', 4, 'Engineering', '2021-08-01', 150000], [9, 'Sara Lind', 'Analytics Engineer', 4, 'Engineering', '2022-01-15', 140000],
      [10, 'Tom Becker', 'Data Engineer', 4, 'Engineering', '2023-03-01', 135000], [11, 'Ravi Iyer', 'Backend Engineer', 5, 'Engineering', '2021-11-01', 145000],
      [12, 'Nora Ahmed', 'Backend Engineer', 5, 'Engineering', '2022-06-01', 140000], [13, 'Leo Martins', 'Support Agent', 6, 'Operations', '2022-02-01', 62000],
      [14, 'Grace Obi', 'Support Agent', 6, 'Operations', '2022-09-01', 60000], [15, 'Hugo Park', 'Support Agent', 6, 'Operations', '2023-07-01', 58000],
      [16, 'Elif Demir', 'Financial Analyst', 7, 'Finance', '2022-04-01', 98000], [17, 'Daniel Cho', 'Junior Data Engineer', 8, 'Engineering', '2024-02-01', 105000],
      [18, 'Mia Kowalski', 'Support Agent', 6, 'Operations', '2024-05-01', 57000], [19, 'Owen Price', 'Backend Engineer', 5, 'Engineering', '2024-08-01', 132000],
      [20, 'Aylin Kaya', 'Analytics Engineer', 4, 'Engineering', '2025-01-06', 128000],
    ];

    /* support tickets */
    const tickets = [];
    for (let i = 1; i <= 150; i++) {
      const opened = D0 + int(100, 500) * DAY + int(0, 86399) * 1000;
      const closed = r() < 0.85 ? opened + int(600, 6 * DAY / 1000) * 1000 : null;
      tickets.push([i, int(1, 120), ts(opened), closed ? ts(closed) : null, pick(['low', 'low', 'medium', 'medium', 'high', 'urgent']), closed ? 'closed' : pick(['open', 'pending']), [13, 14, 15, 18][int(0, 3)]]);
    }

    /* daily seat inventory with gaps (missing snapshot days) */
    const inventory = [];
    for (const ev of events.slice(0, 6)) {
      let seats = venues.find(v => v[0] === ev[3])[4];
      const start = Date.parse(ev[4]) - 20 * DAY;
      for (let d = 0; d <= 20; d++) {
        seats = Math.max(0, seats - int(0, Math.ceil(seats / 6)));
        if (r() < 0.15) continue; // the snapshot job failed that day
        inventory.push([ev[0], date(start + d * DAY), seats]);
      }
    }

    /* messy raw sign-ups for cleaning challenges */
    const rawSignups = [
      [1, '  Amara.Okafor1@Example.com ', 'amara okafor', '2025-01-03', 'de', '+49 30 1234567'],
      [2, 'diego.ramos2@example.com', 'DIEGO RAMOS', '03/01/2025', 'PT', '351-21-000-1111'],
      [3, 'hana.sato3@example.com', 'Hana  Sato', '2025-01-05', 'jp ', '(81) 6 1111 2222'],
      [4, 'not-an-email', 'Layla Hassan', 'yesterday', 'EG', null],
      [5, 'noah.fischer5@example.com', 'noah fischer', '2025-13-01', 'DE', '0049 30 7654321'],
      [6, 'AMARA.OKAFOR1@EXAMPLE.COM', 'Amara Okafor', '2025-01-03', 'DE', '+49 30 1234567'],
      [7, 'priya.nair6@example.com', 'Priya Nair', '2025-02-10', 'CA', '+1 416 555 0100'],
      [8, '', 'Unknown', '2025-02-11', null, null],
      [9, 'tomas.silva7@example.com', 'Tomás Silva', '2025-02-12T09:30:00', 'pt', '+351 21 999 8888'],
      [10, 'wanjiru.kamau8@example.com', 'wanjiru KAMAU', '12/02/2025', 'KE', '+254 20 123 4567'],
    ];

    /* JSON app events (semi-structured) */
    const appEvents = [];
    for (let i = 1; i <= 80; i++) {
      const c = int(1, 120);
      const kind = pick(['search', 'add_to_cart', 'add_to_cart', 'purchase', 'app_open']);
      const payload = { user: { id: c, tier: customers[c - 1][6] }, event: kind, device: { os: pick(['ios', 'android', 'web']), version: pick(['5.2.0', '5.3.1', '5.4.0']) } };
      if (kind === 'search') payload.query = pick(['aurora vale', 'jazz berlin', 'metal', 'luma tickets']);
      if (kind === 'add_to_cart' || kind === 'purchase') payload.items = Array.from({ length: int(1, 3) }, () => ({ event_id: pick(events)[0], qty: int(1, 4) }));
      appEvents.push([i, ts(D0 + int(300, 500) * DAY + int(0, 86399) * 1000), JSON.stringify(payload)]);
    }

    /* carts with nested arrays of structs */
    const carts = [];
    for (let i = 1; i <= 40; i++) {
      const lines = Array.from({ length: int(0, 4) }, () => { const ev = pick(events); return { event_id: ev[0], ticket_type: pick(['General', 'VIP', 'Balcony']), qty: int(1, 4), unit_price: ev[6] }; });
      carts.push([i, int(1, 120), ts(D0 + int(400, 500) * DAY + int(0, 86399) * 1000), lines, lines.length ? Array.from(new Set(lines.map(l => l.ticket_type))) : []]);
    }

    /* currency rates valid over date ranges (for range joins) */
    const fx = [
      ['EUR', '2025-01-01', '2025-06-30', 1.08], ['EUR', '2025-07-01', '2025-12-31', 1.12], ['EUR', '2026-01-01', '9999-12-31', 1.10],
      ['GBP', '2025-01-01', '2025-12-31', 1.27], ['GBP', '2026-01-01', '9999-12-31', 1.25],
      ['JPY', '2025-01-01', '9999-12-31', 0.0066], ['CAD', '2025-01-01', '9999-12-31', 0.73], ['USD', '2025-01-01', '9999-12-31', 1.0],
    ];

    return [
      T('customers', ['customer_id INT', 'full_name STRING', 'email STRING', 'city STRING', 'country STRING', 'signup_date DATE', 'loyalty_tier STRING', 'referred_by INT', 'marketing_opt_in BOOLEAN'], customers, 'One row per customer. referred_by points at another customer.'),
      T('venues', ['venue_id INT', 'name STRING', 'city STRING', 'country STRING', 'capacity INT'], venues, 'One row per venue.'),
      T('events', ['event_id INT', 'artist STRING', 'event_name STRING', 'venue_id INT', 'event_date DATE', 'genre STRING', 'base_price DOUBLE'], events, 'One row per concert.'),
      T('orders', ['order_id INT', 'customer_id INT', 'event_id INT', 'order_ts TIMESTAMP', 'status STRING', 'channel STRING', 'promo_code STRING'], orders, 'One row per order. status is PLACED, PAID, CANCELLED or REFUNDED.'),
      T('order_items', ['order_id INT', 'line_no INT', 'ticket_type STRING', 'quantity INT', 'unit_price DOUBLE'], items, 'One row per order line.'),
      T('payments', ['payment_id INT', 'order_id INT', 'paid_ts TIMESTAMP', 'amount DOUBLE', 'method STRING', 'status STRING'], payments, 'One row per payment attempt. Some orders were charged twice.'),
      T('refunds', ['refund_id INT', 'order_id INT', 'refund_ts TIMESTAMP', 'amount DOUBLE', 'reason STRING'], refunds, 'One row per refund. One refund points at an order that does not exist.'),
      T('page_views', ['view_id INT', 'customer_id INT', 'viewed_ts TIMESTAMP', 'page STRING', 'event_id INT', 'device STRING'], views, 'Clickstream. customer_id is NULL for anonymous visitors.'),
      T('employees', ['employee_id INT', 'name STRING', 'title STRING', 'manager_id INT', 'department STRING', 'hire_date DATE', 'salary INT'], employees, 'Org chart. manager_id points at another employee.'),
      T('support_tickets', ['ticket_id INT', 'customer_id INT', 'opened_ts TIMESTAMP', 'closed_ts TIMESTAMP', 'priority STRING', 'status STRING', 'agent_id INT'], tickets, 'One row per ticket. closed_ts is NULL while open.'),
      T('seat_inventory', ['event_id INT', 'snapshot_date DATE', 'seats_remaining INT'], inventory, 'Daily snapshot of unsold seats. Some days are missing.'),
      T('raw_signups', ['signup_id INT', 'email STRING', 'full_name STRING', 'signup_date STRING', 'country STRING', 'phone STRING'], rawSignups, 'Raw, unvalidated sign-up form data.'),
      T('app_events', ['event_seq INT', 'event_ts TIMESTAMP', 'payload STRING'], appEvents, 'Mobile app events as JSON strings.'),
      T('carts', ['cart_id INT', 'customer_id INT', 'updated_ts TIMESTAMP', 'items ARRAY', 'ticket_types ARRAY'], carts, 'Shopping carts. items is an array of structs.'),
      T('fx_rates', ['currency STRING', 'valid_from DATE', 'valid_to DATE', 'usd_rate DOUBLE'], fx, 'Exchange rates to USD, each valid for a date range.'),
    ];
  }

  /* Load the dataset into a Database, converting dates and timestamps to engine types. */
  function load(db) {
    const X = root.SQLX;
    for (const t of build()) {
      const cols = t.cols.map(c => ({ name: c.name, type: c.type === 'ARRAY' ? (c.name === 'items' ? { base: 'ARRAY', el: { base: 'STRUCT', fields: [{ name: 'event_id', type: { base: 'INT' } }, { name: 'ticket_type', type: { base: 'STRING' } }, { name: 'qty', type: { base: 'INT' } }, { name: 'unit_price', type: { base: 'DOUBLE' } }] } } : { base: 'ARRAY', el: { base: 'STRING' } }) : { base: c.type } }));
      const rows = t.rows.map(row => row.map((v, i) => {
        const ty = t.cols[i].type;
        if (v == null) return null;
        if (ty === 'DATE') return X.castValue(v, { base: 'DATE' });
        if (ty === 'TIMESTAMP') return X.castValue(v, { base: 'TIMESTAMP' });
        return v;
      }));
      db.createTable(t.name, cols, rows);
      db.tables.get(t.name).description = t.description;
    }
    return db;
  }

  root.SQLX = root.SQLX || {};
  root.SQLX.dataset = { build, load, NOW: Date.UTC(2026, 6, 1, 12, 0, 0) };
  root.SQLX.NOW = Date.UTC(2026, 6, 1, 12, 0, 0);
})(typeof window !== 'undefined' ? window : global);
