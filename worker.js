const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  }
});

const now = () => new Date().toISOString();
const makeId = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;

// Nilai tukar estimasi (1 USD dalam IDR)
const USD_RATE = 16000; 

let isInitialized = false;

async function ensureColumn(db, table, column, definition) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = (info.results || []).some(r => r.name === column);
  if (!exists) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function init(db) {
  if (isInitialized) return;
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
      status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, booking_request_id TEXT, source TEXT, customer TEXT NOT NULL,
      phone TEXT, pickup TEXT, destination TEXT, date TEXT, time TEXT,
      passengers INTEGER DEFAULT 1, notes TEXT, distance REAL DEFAULT 0, rate REAL DEFAULT 0,
      price REAL DEFAULT 0, status TEXT DEFAULT 'Pending', created_at_ms INTEGER,
      created_at TEXT, updated_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, request_id TEXT, customer_id TEXT, direction TEXT,
      message_type TEXT, message TEXT, created_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
    )`)
  ]);

  // Migrate databases created by earlier versions without breaking existing data.
  await ensureColumn(db, 'booking_requests', 'client_request_id', 'TEXT');
  await ensureColumn(db, 'orders', 'updated_at', 'TEXT');
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_requests_client_request_id
    ON booking_requests(client_request_id) WHERE client_request_id IS NOT NULL`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_booking_requests_status_created
    ON booking_requests(status, created_at)`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_booking_request_id
    ON orders(booking_request_id) WHERE booking_request_id IS NOT NULL`).run();

  isInitialized = true;
}

function requestRow(r) {
  return {
    request_id: r.request_id,
    customer_id: r.customer_id,
    customer: { customer_id: r.customer_id, name: r.customer_name, phone: r.customer_phone },
    source: { channel: r.source_channel, campaign: r.source_campaign || '' },
    pickup: { address: r.pickup },
    destination: { address: r.destination },
    trip: { date: r.trip_date, time: r.trip_time, passengers: r.passengers },
    notes: r.notes || '', status: r.status, created_at: r.created_at, updated_at: r.updated_at,
    client_request_id: r.client_request_id || null
  };
}

function orderRow(r) {
  return {
    id: r.id, bookingRequestId: r.booking_request_id, source: r.source,
    customer: r.customer, phone: r.phone, pickup: r.pickup, destination: r.destination,
    date: r.date, time: r.time, passengers: r.passengers, notes: r.notes || '',
    distance: Number(r.distance || 0), rate: Number(r.rate || 0), price: Number(r.price || 0),
    status: r.status, createdAt: Number(r.created_at_ms || Date.now()), created_at: r.created_at,
    updated_at: r.updated_at || null
  };
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

    try {
      if (!env.DB) return json({ error: 'D1 database binding DB is not configured.' }, 500);
      await init(env.DB);

      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/') return json({ ok: true, service: 'Manojavaya Trans Gateway', status: 'online' });
      if (request.method === 'GET' && path === '/api/health') return json({ ok: true, service: 'Manojavaya Trans Gateway', database: 'D1' });

      // DRIVER PROFILE & SETTINGS
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

      // BOOKING REQUESTS
      if (request.method === 'POST' && path === '/api/booking-requests') {
        const x = await body(request);
        for (const k of ['name','phone','pickup','destination','date','time']) {
          if (!String(x[k] || '').trim()) return json({ error: `Missing ${k}` }, 400);
        }
        const t = now();
        const clientRequestId = String(x.client_request_id || '').trim().slice(0, 120) || null;
        if (clientRequestId) {
          const existing = await env.DB.prepare(`SELECT * FROM booking_requests WHERE client_request_id=?`)
            .bind(clientRequestId).first();
          if (existing) return json(requestRow(existing), 200);
        }
        const phone = String(x.phone).trim();
        const name = String(x.name).trim();
        let c = await env.DB.prepare(`SELECT * FROM customers WHERE phone=?`).bind(phone).first();
        if (!c) {
          c = { customer_id: makeId('CUS'), name, phone, created_at: t, updated_at: t };
          await env.DB.prepare(`INSERT INTO customers(customer_id,name,phone,created_at,updated_at) VALUES(?,?,?,?,?)`)
            .bind(c.customer_id,c.name,c.phone,c.created_at,c.updated_at).run();
        } else {
          await env.DB.prepare(`UPDATE customers SET name=?, updated_at=? WHERE phone=?`).bind(name,t,phone).run();
          c.name = name; c.updated_at = t;
        }
        const r = {
          request_id: makeId('BR'), customer_id: c.customer_id, customer_name: name, customer_phone: phone,
          source_channel: 'WHATSAPP', source_campaign: String(x.source || 'WHATSAPP_QR'),
          pickup: String(x.pickup).trim(), destination: String(x.destination).trim(),
          trip_date: String(x.date).trim(), trip_time: String(x.time).trim(),
          passengers: Math.max(1, Number(x.passengers) || 1), notes: String(x.notes || '').trim(),
          status: 'PENDING', created_at: t, updated_at: t, client_request_id: clientRequestId
        };
        await env.DB.prepare(`INSERT INTO booking_requests(request_id,customer_id,customer_name,customer_phone,source_channel,source_campaign,pickup,destination,trip_date,trip_time,passengers,notes,status,created_at,updated_at,client_request_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(r.request_id,r.customer_id,r.customer_name,r.customer_phone,r.source_channel,r.source_campaign,r.pickup,r.destination,r.trip_date,r.trip_time,r.passengers,r.notes,r.status,r.created_at,r.updated_at,r.client_request_id).run();
        
        const inboundMsg = `Thank you for choosing Manojavaya Trans! We have received your booking request for ${r.trip_date} at ${r.trip_time}. Our team is reviewing your trip details and will confirm shortly.`;
        
        try {
          await env.DB.prepare(`INSERT INTO messages(id,request_id,customer_id,direction,message_type,message,created_at) VALUES(?,?,?,?,?,?,?)`)
            .bind(makeId('MSG'),r.request_id,r.customer_id,'INBOUND','BOOKING_FORM',inboundMsg,t).run();
        } catch (_) {}
        return json(requestRow(r), 201);
      }

      if (request.method === 'GET' && path === '/api/booking-requests') {
        const status = url.searchParams.get('status');
        const q = status
          ? env.DB.prepare(`SELECT * FROM booking_requests WHERE status=? ORDER BY rowid DESC`).bind(status)
          : env.DB.prepare(`SELECT * FROM booking_requests ORDER BY rowid DESC`);
        const result = await q.all();
        return json((result.results || []).map(requestRow));
      }

      // ACCEPT / REJECT BOOKING
      const match = path.match(/^\/api\/booking-requests\/([^/]+)\/(accept|reject)$/);
      if (request.method === 'POST' && match) {
        const rid = decodeURIComponent(match[1]);
        const action = match[2];
        const r = await env.DB.prepare(`SELECT * FROM booking_requests WHERE request_id=?`).bind(rid).first();
        if (!r) return json({ error: 'Booking request not found' }, 404);
        if (r.status !== 'PENDING') return json({ error: 'Request is no longer pending' }, 409);
        const t = now();

        // Conditional update prevents two Driver sessions from accepting the same request.
        const nextStatus = action === 'reject' ? 'REJECTED' : 'CONVERTED';
        const changed = await env.DB.prepare(`UPDATE booking_requests SET status=?, updated_at=? WHERE request_id=? AND status='PENDING'`)
          .bind(nextStatus, t, rid).run();
        if (!changed.meta?.changes) return json({ error: 'Request is no longer pending' }, 409);

        if (action === 'reject') {
          return json({ request: requestRow({ ...r, status: nextStatus, updated_at: t }) });
        }

        let order = await env.DB.prepare(`SELECT * FROM orders WHERE booking_request_id=?`).bind(rid).first();
        if (!order) {
          order = {
            id: makeId('ORD'), booking_request_id: rid, source: 'WHATSAPP_QR', customer: r.customer_name,
            phone: r.customer_phone, pickup: r.pickup, destination: r.destination, date: r.trip_date,
            time: r.trip_time, passengers: r.passengers, notes: r.notes || '', distance: 0, rate: 0,
            price: 0, status: 'Pending', created_at_ms: Date.now(), created_at: t, updated_at: t
          };
          await env.DB.prepare(`INSERT INTO orders(id,booking_request_id,source,customer,phone,pickup,destination,date,time,passengers,notes,distance,rate,price,status,created_at_ms,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(order.id,order.booking_request_id,order.source,order.customer,order.phone,order.pickup,order.destination,order.date,order.time,order.passengers,order.notes,order.distance,order.rate,order.price,order.status,order.created_at_ms,order.created_at,order.updated_at).run();
        }

        const outboundMsg = `Great news, ${r.customer_name}! Your booking with Manojavaya Trans is confirmed. Our driver has accepted your ride from ${r.pickup} to ${r.destination} on ${r.trip_date} at ${r.trip_time}. We look forward to serving you!`;
        await env.DB.prepare(`INSERT INTO messages(id,request_id,customer_id,direction,message_type,message,created_at) VALUES(?,?,?,?,?,?,?)`)
          .bind(makeId('MSG'),rid,r.customer_id,'OUTBOUND','BOOKING_ACCEPTED',outboundMsg,t).run();
        return json({ request: requestRow({ ...r, status: nextStatus, updated_at: t }), order: orderRow(order) });
      }

      // ORDERS MANAGEMENT
      const quoteMatch = path.match(/^\/api\/orders\/([^/]+)\/quote$/);
      if (request.method === 'POST' && quoteMatch) {
        const orderId = decodeURIComponent(quoteMatch[1]);
        const x = await body(request);
        const price = Number(x.price || 0);
        const distance = Number(x.distance || 0);
        const rate = Number(x.rate || 0);

        if (!price || price <= 0) {
          return json({ error: 'Please provide a valid price in IDR' }, 400);
        }

        const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`).bind(orderId).first();
        if (!order) return json({ error: 'Order not found' }, 404);

        const t = now();
        const formattedPriceIDR = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(price);
        const priceUSD = (price / USD_RATE).toFixed(2);
        const formattedPriceUSD = `$${priceUSD} USD`;

        await env.DB.prepare(`UPDATE orders SET price=?, distance=?, rate=?, updated_at=? WHERE id=?`)
          .bind(price, distance, rate, t, orderId).run();

        const priceQuoteMsg = `Hello ${order.customer}! Here is the rate quote for your trip with Manojavaya Trans:

• Pickup: ${order.pickup}
• Destination: ${order.destination}
• Date & Time: ${order.date} at ${order.time}
• Passengers: ${order.passengers}

 Total Price: ${formattedPriceIDR} (~${formattedPriceUSD})

*Note: Payment in IDR cash or local bank transfer is preferred upon arrival.

Please reply to this message to confirm your trip. Thank you!`;

        await env.DB.prepare(`INSERT INTO messages(id,request_id,customer_id,direction,message_type,message,created_at) VALUES(?,?,?,?,?,?,?)`)
          .bind(makeId('MSG'), order.booking_request_id, null, 'OUTBOUND', 'PRICE_QUOTE', priceQuoteMsg, t).run();

        return json({
          ok: true,
          message: priceQuoteMsg,
          price_idr: formattedPriceIDR,
          price_usd: formattedPriceUSD,
          order: { ...order, price, distance, rate }
        });
      }

      if (request.method === 'GET' && path === '/api/orders') {
        const source = url.searchParams.get('source');
        const q = source
          ? env.DB.prepare(`SELECT * FROM orders WHERE source=? ORDER BY rowid DESC`).bind(source)
          : env.DB.prepare(`SELECT * FROM orders ORDER BY rowid DESC`);
        const result = await q.all();
        return json((result.results || []).map(orderRow));
      }

      // UPDATE STATUS ORDER (PATCH /api/orders/:id)
      const orderPatchMatch = path.match(/^\/api\/orders\/([^/]+)$/);
      if (request.method === 'PATCH' && orderPatchMatch) {
        const orderId = decodeURIComponent(orderPatchMatch[1]);
        const x = await body(request);
        const status = x.status;
        
        if (!status) return json({ error: 'Status is required' }, 400);

        const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`).bind(orderId).first();
        if (!order) return json({ error: 'Order not found' }, 404);

        await env.DB.prepare(`UPDATE orders SET status=? WHERE id=?`).bind(status, orderId).run();
        return json({ ok: true, id: orderId, status });
      }

      // MESSAGES API
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
        const result = binding.length > 0 ? await stmt.bind(...binding).all() : await stmt.all();
        return json(result.results || []);
      }

      return json({ error: 'Route not found' }, 404);
    } catch (err) {
      return json({ error: err?.message || 'Internal server error' }, 500);
    }
  }
};
