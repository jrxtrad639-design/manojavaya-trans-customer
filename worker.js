const DEFAULT_USD_RATE = 16500;
const BOOKING_PUBLIC_METHODS = new Set(['POST']);
const ORDER_STATUSES = new Set([
  'Pending', 'Quoted', 'Awaiting Confirmation', 'Confirmed', 'Driver Assigned',
  'Accepted', 'In Progress', 'Completed', 'Cancelled', 'Rejected'
]);

const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    ...extraHeaders
  }
});

const now = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

function configuredUsdRate(env) {
  const n = Number(env.USD_RATE || DEFAULT_USD_RATE);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USD_RATE;
}

function normalizePhone(phone) {
  let s = String(phone || '').trim().replace(/[^0-9+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('0')) s = '62' + s.slice(1);
  return s;
}

function formatIdr(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(2)} USD`;
}

function requestRow(r) {
  return {
    request_id: r.request_id,
    client_request_id: r.client_request_id || '',
    customer_id: r.customer_id,
    customer: { customer_id: r.customer_id, name: r.customer_name, phone: r.customer_phone },
    source: { channel: r.source_channel, campaign: r.source_campaign || '' },
    pickup: { address: r.pickup },
    destination: { address: r.destination },
    trip: { date: r.trip_date, time: r.trip_time, passengers: Number(r.passengers || 1) },
    notes: r.notes || '',
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
}

function orderRow(r) {
  const usdRate = Number(r.usd_rate || DEFAULT_USD_RATE);
  return {
    id: r.id,
    bookingRequestId: r.booking_request_id,
    source: r.source,
    customer: r.customer,
    phone: r.phone,
    pickup: r.pickup,
    destination: r.destination,
    date: r.date,
    time: r.time,
    passengers: Number(r.passengers || 1),
    notes: r.notes || '',
    distance: Number(r.distance || 0),
    rate: Number(r.rate || 0),
    price: Number(r.price || 0),
    usdRate,
    priceUsd: Number(r.price || 0) / usdRate,
    status: r.status,
    createdAt: Number(r.created_at_ms || Date.now()),
    created_at: r.created_at,
    updated_at: r.updated_at || null
  };
}

async function ensureColumn(db, table, column, definition) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = (info.results || []).some(c => c.name === column);
  if (!exists) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

async function init(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS customers (
      customer_id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS booking_requests (
      request_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL, source_channel TEXT NOT NULL, source_campaign TEXT,
      pickup TEXT NOT NULL, destination TEXT NOT NULL, trip_date TEXT NOT NULL,
      trip_time TEXT NOT NULL, passengers INTEGER NOT NULL DEFAULT 1, notes TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, assigned_driver_id TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, booking_request_id TEXT, source TEXT, customer TEXT NOT NULL,
      phone TEXT, pickup TEXT, destination TEXT, date TEXT, time TEXT,
      passengers INTEGER DEFAULT 1, notes TEXT, distance REAL DEFAULT 0, rate REAL DEFAULT 0,
      price REAL DEFAULT 0, usd_rate REAL DEFAULT 16500,
      status TEXT DEFAULT 'Pending', created_at_ms INTEGER, created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, request_id TEXT, customer_id TEXT, direction TEXT,
      message_type TEXT, message TEXT, created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
    )`)
  ]);

  // Safe migrations for databases created by the previous Worker version.
  await ensureColumn(db, 'orders', 'usd_rate', 'REAL DEFAULT 16500');
  await ensureColumn(db, 'orders', 'updated_at', 'TEXT');
  await ensureColumn(db, 'booking_requests', 'client_request_id', 'TEXT');
  await ensureColumn(db, 'booking_requests', 'assigned_driver_id', 'TEXT');
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_requests_client_request_id ON booking_requests(client_request_id) WHERE client_request_id IS NOT NULL AND client_request_id <> ''`).run();
}

function bearerToken(request) {
  const value = request.headers.get('Authorization') || '';
  if (!value.toLowerCase().startsWith('bearer ')) return '';
  return value.slice(7).trim();
}

function driverAuth(request, env) {
  const expected = String(env.DRIVER_API_TOKEN || '').trim();
  if (!expected) return { ok: false, status: 503, error: 'Driver API authentication is not configured.' };
  const token = bearerToken(request);
  if (!token || token !== expected) return { ok: false, status: 401, error: 'Unauthorized' };
  return {
    ok: true,
    driverId: String(env.DRIVER_ID || 'primary-driver').trim()
  };
}

function isDriverRoute(path, method) {
  if (path === '/api/driver-profile') return true;
  if (path === '/api/booking-requests' && method === 'GET') return true;
  if (/^\/api\/booking-requests\/[^/]+\/(accept|reject)$/.test(path)) return true;
  if (/^\/api\/orders\/[^/]+\/quote$/.test(path)) return true;
  if (/^\/api\/orders\/[^/]+$/.test(path) && method === 'PATCH') return true;
  if (path === '/api/orders' && method === 'GET') return true;
  if (path === '/api/messages' && method === 'GET') return true;
  return false;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
        }
      });
    }

    if (!env.DB) return json({ error: 'D1 database binding DB is not configured.' }, 500);

    try {
      await init(env.DB);
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'GET' && path === '/') {
        return json({ ok: true, service: 'Manojavaya Trans Gateway', status: 'online', version: 'V1.1.4-compatible' });
      }
      if (request.method === 'GET' && path === '/api/health') {
        return json({ ok: true, service: 'Manojavaya Trans Gateway', database: 'D1', version: 'V1.1.4-compatible' });
      }

      // Driver endpoints are protected. Customer booking creation remains public.
      if (isDriverRoute(path, request.method)) {
        const auth = driverAuth(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
      }

      // DRIVER PROFILE
      if (path === '/api/driver-profile') {
        if (request.method === 'GET') {
          const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='driver_phone'`).first();
          return json({ phone: row?.value || '' });
        }
        if (request.method === 'POST') {
          const x = await body(request);
          const phone = String(x.phone || '').trim();
          await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('driver_phone',?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
            .bind(phone, now()).run();
          return json({ ok: true, phone });
        }
      }

      // CUSTOMER -> BOOKING REQUEST. Public endpoint kept compatible with the existing Customer app.
      if (request.method === 'POST' && path === '/api/booking-requests') {
        const x = await body(request);
        for (const k of ['name', 'phone', 'pickup', 'destination', 'date', 'time']) {
          if (!String(x[k] || '').trim()) return json({ error: `Missing ${k}` }, 400);
        }

        const t = now();
        const phone = normalizePhone(x.phone);
        const name = String(x.name).trim();
        const clientRequestId = String(x.client_request_id || '').trim().slice(0, 100) || makeId('CLI');
        const passengers = Number(x.passengers);

        if (!/^62\d{7,14}$/.test(phone)) return json({ error: 'Please provide a valid WhatsApp number.' }, 400);
        if (!Number.isInteger(passengers) || passengers < 1 || passengers > 16) {
          return json({ error: 'Passengers must be a whole number from 1 to 16.' }, 400);
        }

        // Idempotency: a retry of the same customer submission must return the
        // original booking instead of creating a second booking.
        const existing = await env.DB.prepare(
          `SELECT * FROM booking_requests WHERE client_request_id=?`
        ).bind(clientRequestId).first();
        if (existing) return json(requestRow(existing), 200);

        // INSERT OR IGNORE prevents two simultaneous requests for the same
        // customer phone from racing on the UNIQUE customers.phone constraint.
        const customerId = makeId('CUS');
        await env.DB.prepare(`INSERT OR IGNORE INTO customers(customer_id,name,phone,created_at,updated_at) VALUES(?,?,?,?,?)`)
          .bind(customerId, name, phone, t, t).run();
        let c = await env.DB.prepare(`SELECT * FROM customers WHERE phone=?`).bind(phone).first();
        if (!c) return json({ error: 'Could not create customer record. Please try again.' }, 500);

        await env.DB.prepare(`UPDATE customers SET name=?, updated_at=? WHERE phone=?`)
          .bind(name, t, phone).run();
        c.name = name;
        c.updated_at = t;

        const r = {
          request_id: makeId('BR'),
          client_request_id: clientRequestId,
          customer_id: c.customer_id,
          customer_name: name,
          customer_phone: phone,
          source_channel: 'WHATSAPP',
          source_campaign: String(x.source || 'WHATSAPP_QR'),
          pickup: String(x.pickup).trim(),
          destination: String(x.destination).trim(),
          trip_date: String(x.date).trim(),
          trip_time: String(x.time).trim(),
          passengers,
          notes: String(x.notes || '').trim(),
          status: 'PENDING',
          created_at: t,
          updated_at: t,
          assigned_driver_id: String(env.DRIVER_ID || 'primary-driver').trim()
        };

        const inboundMsg = `Thank you for choosing Manojavaya Trans! We have received your booking request for ${r.trip_date} at ${r.trip_time}. Our team is reviewing your trip details and will confirm shortly.`;

        // Booking + message are written atomically. If anything fails, the
        // booking is not partially created and the customer can safely retry.
        try {
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO booking_requests(
              request_id,client_request_id,customer_id,customer_name,customer_phone,source_channel,source_campaign,
              pickup,destination,trip_date,trip_time,passengers,notes,status,created_at,updated_at,assigned_driver_id
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
              .bind(r.request_id, r.client_request_id, r.customer_id, r.customer_name, r.customer_phone, r.source_channel,
                r.source_campaign, r.pickup, r.destination, r.trip_date, r.trip_time, r.passengers,
                r.notes, r.status, r.created_at, r.updated_at, r.assigned_driver_id),
            env.DB.prepare(`INSERT INTO messages(id,request_id,customer_id,direction,message_type,message,created_at)
              VALUES(?,?,?,?,?,?,?)`)
              .bind(makeId('MSG'), r.request_id, r.customer_id, 'INBOUND', 'BOOKING_FORM', inboundMsg, t)
          ]);
        } catch (insertErr) {
          // A concurrent duplicate may win the unique idempotency index.
          const duplicate = await env.DB.prepare(
            `SELECT * FROM booking_requests WHERE client_request_id=?`
          ).bind(clientRequestId).first();
          if (duplicate) return json(requestRow(duplicate), 200);
          throw insertErr;
        }

        return json(requestRow(r), 201);
      }

      // DRIVER -> INCOMING BOOKINGS
      if (request.method === 'GET' && path === '/api/booking-requests') {
        const status = url.searchParams.get('status');
        const driverId = String(driverAuth(request, env).driverId || 'primary-driver').trim();
        const q = status
          ? env.DB.prepare(`SELECT * FROM booking_requests WHERE status=? AND (assigned_driver_id=? OR assigned_driver_id IS NULL) ORDER BY rowid DESC`).bind(status, driverId)
          : env.DB.prepare(`SELECT * FROM booking_requests WHERE (assigned_driver_id=? OR assigned_driver_id IS NULL) ORDER BY rowid DESC`).bind(driverId);
        const result = await q.all();
        return json((result.results || []).map(requestRow));
      }

      // DRIVER -> ACCEPT / REJECT
      const bookingAction = path.match(/^\/api\/booking-requests\/([^/]+)\/(accept|reject)$/);
      if (request.method === 'POST' && bookingAction) {
        const rid = decodeURIComponent(bookingAction[1]);
        const action = bookingAction[2];
        const auth = driverAuth(request, env);
        const r = await env.DB.prepare(`SELECT * FROM booking_requests WHERE request_id=?`).bind(rid).first();
        if (!r) return json({ error: 'Booking request not found' }, 404);
        if (r.assigned_driver_id && r.assigned_driver_id !== auth.driverId) return json({ error: 'Booking is not assigned to this driver.' }, 403);
        if (r.status !== 'PENDING') return json({ error: 'Request is no longer pending' }, 409);

        const t = now();
        if (action === 'reject') {
          await env.DB.prepare(`UPDATE booking_requests SET status='REJECTED', updated_at=? WHERE request_id=?`)
            .bind(t, rid).run();
          return json({ request: requestRow({ ...r, status: 'REJECTED', updated_at: t }) });
        }

        const x = await body(request);
        const distance = Number(x.distance || 0);
        const rate = Number(x.rate || 0);
        const price = Number(x.price || 0);
        const usdRate = Number(x.usdRate || configuredUsdRate(env));
        if (!Number.isFinite(distance) || distance < 0) {
          return json({ error: 'A valid distance in Km is required.' }, 400);
        }
        if (!Number.isFinite(rate) || rate <= 0) {
          return json({ error: 'A valid fare per Km in IDR is required.' }, 400);
        }
        if (!Number.isFinite(price) || price <= 0) {
          return json({ error: 'A valid fare in IDR is required before accepting the booking.' }, 400);
        }
        if (!Number.isFinite(usdRate) || usdRate <= 0) {
          return json({ error: 'A valid USD exchange rate is required.' }, 400);
        }

        const orderId = makeId('ORD');
        const order = {
          id: orderId,
          booking_request_id: rid,
          source: r.source_channel || 'WHATSAPP_QR',
          customer: r.customer_name,
          phone: r.customer_phone,
          pickup: r.pickup,
          destination: r.destination,
          date: r.trip_date,
          time: r.trip_time,
          passengers: r.passengers,
          notes: r.notes || '',
          distance,
          rate,
          price,
          usd_rate: usdRate,
          status: 'Pending',
          created_at_ms: Date.now(),
          created_at: t,
          updated_at: t
        };

        const outboundMsg = `Great news, ${r.customer_name}! Your booking with Manojavaya Trans is confirmed. Your fare is ${formatIdr(price)} (~${formatUsd(price / usdRate).replace(' USD','')}). Our driver has accepted your ride from ${r.pickup} to ${r.destination} on ${r.trip_date} at ${r.trip_time}. We look forward to serving you!`;
        // Accept is atomic: order creation, request transition and audit/message
        // are committed together so the two systems cannot drift apart.
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO orders(
            id,booking_request_id,source,customer,phone,pickup,destination,date,time,passengers,
            notes,distance,rate,price,usd_rate,status,created_at_ms,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(order.id, order.booking_request_id, order.source, order.customer, order.phone,
              order.pickup, order.destination, order.date, order.time, order.passengers, order.notes,
              order.distance, order.rate, order.price, order.usd_rate, order.status,
              order.created_at_ms, order.created_at, order.updated_at),
          env.DB.prepare(`UPDATE booking_requests SET status='CONVERTED', updated_at=? WHERE request_id=?`)
            .bind(t, rid),
          env.DB.prepare(`INSERT INTO messages(id,request_id,customer_id,direction,message_type,message,created_at)
            VALUES(?,?,?,?,?,?,?)`)
            .bind(makeId('MSG'), rid, r.customer_id, 'OUTBOUND', 'BOOKING_ACCEPTED', outboundMsg, t)
        ]);

        return json({
          request: requestRow({ ...r, status: 'CONVERTED', updated_at: t }),
          order: orderRow(order)
        });
      }

      // DRIVER -> PRICE QUOTE
      const quoteMatch = path.match(/^\/api\/orders\/([^/]+)\/quote$/);
      if (request.method === 'POST' && quoteMatch) {
        const orderId = decodeURIComponent(quoteMatch[1]);
        const x = await body(request);
        const price = Number(x.price || 0);
        const distance = Number(x.distance || 0);
        const rate = Number(x.rate || 0);
        const usdRate = Number(x.usdRate || configuredUsdRate(env));

        if (!Number.isFinite(price) || price <= 0) return json({ error: 'Please provide a valid price in IDR' }, 400);
        if (!Number.isFinite(usdRate) || usdRate <= 0) return json({ error: 'Please provide a valid USD exchange rate' }, 400);

        const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`).bind(orderId).first();
        if (!order) return json({ error: 'Order not found' }, 404);

        const t = now();
        const priceUsd = price / usdRate;
        const priceQuoteMsg = `Hello ${order.customer}! Here is the rate quote for your trip with Manojavaya Trans:\n\n• Pickup: ${order.pickup}\n• Destination: ${order.destination}\n• Date & Time: ${order.date} at ${order.time}\n• Passengers: ${order.passengers}\n\nTotal Price: ${formatIdr(price)} (~${formatUsd(priceUsd)})\n\n*Note: Payment in IDR cash or local bank transfer is preferred upon arrival.\n\nPlease reply to this message to confirm your trip. Thank you!`;

        await env.DB.prepare(`UPDATE orders SET price=?, distance=?, rate=?, usd_rate=?, updated_at=?, status='Quoted' WHERE id=?`)
          .bind(price, distance, rate, usdRate, t, orderId).run();

        let customerId = null;
        if (order.booking_request_id) {
          const br = await env.DB.prepare(`SELECT customer_id FROM booking_requests WHERE request_id=?`)
            .bind(order.booking_request_id).first();
          customerId = br?.customer_id || null;
        }

        await env.DB.prepare(`INSERT INTO messages(id,request_id,customer_id,direction,message_type,message,created_at)
          VALUES(?,?,?,?,?,?,?)`)
          .bind(makeId('MSG'), order.booking_request_id, customerId, 'OUTBOUND', 'PRICE_QUOTE', priceQuoteMsg, t).run();

        return json({
          ok: true,
          message: priceQuoteMsg,
          price_idr: formatIdr(price),
          price_usd: formatUsd(priceUsd),
          usdRate,
          order: orderRow({ ...order, price, distance, rate, usd_rate: usdRate, status: 'Quoted', updated_at: t })
        });
      }

      // DRIVER -> ORDERS
      if (request.method === 'GET' && path === '/api/orders') {
        const source = url.searchParams.get('source');
        const q = source
          ? env.DB.prepare(`SELECT * FROM orders WHERE source=? ORDER BY rowid DESC`).bind(source)
          : env.DB.prepare(`SELECT * FROM orders ORDER BY rowid DESC`);
        const result = await q.all();
        return json((result.results || []).map(orderRow));
      }

      // DRIVER -> UPDATE ORDER STATUS
      const orderPatchMatch = path.match(/^\/api\/orders\/([^/]+)$/);
      if (request.method === 'PATCH' && orderPatchMatch) {
        const orderId = decodeURIComponent(orderPatchMatch[1]);
        const x = await body(request);
        const status = String(x.status || '').trim();
        if (!ORDER_STATUSES.has(status)) return json({ error: 'Invalid order status' }, 400);

        const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`).bind(orderId).first();
        if (!order) return json({ error: 'Order not found' }, 404);

        const t = now();
        await env.DB.prepare(`UPDATE orders SET status=?, updated_at=? WHERE id=?`)
          .bind(status, t, orderId).run();
        return json({ ok: true, id: orderId, status, updated_at: t });
      }

      // DRIVER -> MESSAGES
      if (request.method === 'GET' && path === '/api/messages') {
        const requestId = url.searchParams.get('request_id');
        const customerId = url.searchParams.get('customer_id');
        let query = `SELECT * FROM messages ORDER BY rowid DESC`;
        let binding = [];

        if (requestId) {
          query = `SELECT * FROM messages WHERE request_id=? ORDER BY rowid ASC`;
          binding = [requestId];
        } else if (customerId) {
          query = `SELECT * FROM messages WHERE customer_id=? ORDER BY rowid ASC`;
          binding = [customerId];
        }

        const stmt = env.DB.prepare(query);
        const result = binding.length ? await stmt.bind(...binding).all() : await stmt.all();
        return json(result.results || []);
      }

      return json({ error: 'Route not found' }, 404);
    } catch (err) {
      return json({ error: err?.message || 'Internal server error' }, 500);
    }
  }
};
