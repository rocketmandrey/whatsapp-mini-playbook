import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import qrcode from 'qrcode-terminal';

// Load .env
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const TARGET_GROUP = process.env.TARGET_GROUP_NAME || '';   // optional: mirror ONE group into whatsapp.db
const HTTP_PORT = Number(process.env.QR_PORT || 8795);
// Main DB: ALL chats go here — groups AND private 1-on-1 DMs (read by the
// MCP/connector). The optional whatsapp.db mirror below only fills when
// TARGET_GROUP_NAME is set.
const ALL_DB_PATH = process.env.ALL_DB_PATH || '/root/whatsapp-mcp/all_chats.db';

// === Database Setup ===
const db = new Database('whatsapp.db');
db.pragma('journal_mode = WAL');

const schema = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    group_name TEXT,
    sender_id TEXT,
    sender_name TEXT,
    sender_phone TEXT,
    message_text TEXT,
    message_type TEXT DEFAULT 'text',
    timestamp INTEGER NOT NULL,
    is_summarized INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_summarized ON messages(is_summarized);
  CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id);

  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL,
    message_count INTEGER,
    summary_text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`;
db.exec(schema);

const insertMsg = db.prepare(`
  INSERT OR IGNORE INTO messages (id, group_id, group_name, sender_id, sender_name, sender_phone, message_text, message_type, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Second DB for ALL groups.
const allDb = new Database(ALL_DB_PATH);
allDb.pragma('journal_mode = WAL');
allDb.exec(schema);
const insertAll = allDb.prepare(`
  INSERT OR IGNORE INTO messages (id, group_id, group_name, sender_id, sender_name, sender_phone, message_text, message_type, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

console.log('📦 Databases initialized: all_chats.db (all chats: groups + DMs) + whatsapp.db (optional mirror)');

// === State ===
let currentQR = null;
let isReady = false;
let targetGroupId = null;
let messageCount = 0;
let allCount = 0;

// === HTTP Server for QR code ===
const httpServer = createServer((req, res) => {
  if (req.url === '/' || req.url === '/qr') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

    if (isReady) {
      res.end(`
        <html><body style="background:#111;color:#0f0;font-family:monospace;text-align:center;padding:40px">
          <h1>✅ WhatsApp Connected!</h1>
          <p>Mirror-group messages: ${messageCount}</p>
          <p>All-groups messages: ${allCount}</p>
          <script>setTimeout(()=>location.reload(), 5000)</script>
        </body></html>
      `);
    } else if (currentQR) {
      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(currentQR)}`;
      res.end(`
        <html><body style="background:#111;color:#fff;font-family:monospace;text-align:center;padding:20px">
          <h1>📱 Scan QR with WhatsApp</h1>
          <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
          <br>
          <img src="${qrImageUrl}" style="border:10px solid white;border-radius:10px">
          <br><br>
          <p style="color:#888">QR refreshes automatically. Page auto-reloads every 10s.</p>
          <script>setTimeout(()=>location.reload(), 10000)</script>
        </body></html>
      `);
    } else {
      res.end(`
        <html><body style="background:#111;color:#ff0;font-family:monospace;text-align:center;padding:40px">
          <h1>⏳ Waiting for QR code...</h1>
          <p>WhatsApp is initializing. Please wait.</p>
          <script>setTimeout(()=>location.reload(), 3000)</script>
        </body></html>
      `);
    }
  } else if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isReady ? 'connected' : (currentQR ? 'waiting_for_scan' : 'initializing'),
      leonMessages: messageCount,
      allMessages: allCount,
      targetGroup: targetGroupId || null
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`🌐 QR code page: http://<SERVER_IP>:${HTTP_PORT}`);
});

// === WhatsApp Client ===
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './wa_session' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--single-process',
    ],
    executablePath: '/usr/bin/chromium-browser',
  },
});

client.on('qr', (qr) => {
  currentQR = qr;
  console.log(`\n📱 QR code ready! Open: http://<SERVER_IP>:${HTTP_PORT}\n`);
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  currentQR = null;
  console.log('🔐 Authenticated! Session saved.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Auth failure:', msg);
  process.exit(1);
});

client.on('ready', async () => {
  isReady = true;
  currentQR = null;
  console.log('✅ WhatsApp client ready!');

  // Find the optional mirror group (TARGET_GROUP_NAME) for whatsapp.db
  if (TARGET_GROUP) {
    const chats = await client.getChats();
    for (const chat of chats) {
      if (chat.isGroup) {
        console.log(`  📋 Group: "${chat.name}" (${chat.id._serialized})`);
        if (chat.name && chat.name.includes(TARGET_GROUP)) {
          targetGroupId = chat.id._serialized;
          console.log(`\n🎯 Mirror group found: "${chat.name}" → ${targetGroupId}\n`);
          break;
        }
      }
    }

    if (!targetGroupId) {
      console.log(`\n⚠️ Mirror group "${TARGET_GROUP}" not found.`);
      console.log('Will match dynamically when messages arrive.\n');
    }
  }
});

// 'message_create' fires for BOTH incoming AND outgoing (fromMe) messages, in
// EVERY chat (groups + DMs). This is what makes "see all my WhatsApp" work —
// the old 'message' event only delivered incoming messages.
client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    // NOTE: no isGroup filter — we record groups AND private 1-on-1 chats.

    const chatId = chat.id._serialized;
    const text = msg.body || '';
    if (!text.trim()) return;

    const contact = await msg.getContact();
    const senderPhone = msg.fromMe ? 'me' : (contact.number || contact.id.user || 'unknown');
    const senderName = msg.fromMe ? 'Me' : (contact.pushname || contact.name || senderPhone);
    const timestamp = msg.timestamp || Math.floor(Date.now() / 1000);
    let msgType = 'text';
    if (msg.hasMedia) msgType = msg.type || 'media';

    // chat.name is reliable for BOTH groups (group name) and DMs (the other
    // contact's name), regardless of message direction.
    const chatName = chat.name || (chat.isGroup ? '(group)' : 'DM');

    const row = [
      msg.id._serialized, chatId, chatName,
      contact.id._serialized, senderName, senderPhone, text, msgType, timestamp,
    ];

    // 1) ALL chats (groups + DMs) -> all_chats.db (for the MCP/connector)
    const allInfo = insertAll.run(...row);
    if (allInfo.changes > 0) allCount++;

    // 2) optional mirror group: dynamic match by TARGET_GROUP_NAME substring
    if (chat.isGroup && TARGET_GROUP && !targetGroupId && chat.name && chat.name.includes(TARGET_GROUP)) {
      targetGroupId = chatId;
      console.log(`🎯 Mirror group matched: "${chat.name}" → ${targetGroupId}`);
    }

    // 3) mirror group -> whatsapp.db (only that one group)
    if (targetGroupId && chatId === targetGroupId) {
      const info = insertMsg.run(...row);
      if (info.changes > 0) {
        messageCount++;
        const time = new Date(timestamp * 1000).toLocaleTimeString('ru-RU');
        console.log(`💬 [${time}] ${senderName}: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);
      }
    }
  } catch (err) {
    if (!err.message?.includes('UNIQUE')) {
      console.error('Message handler error:', err.message);
    }
  }
});

client.on('disconnected', (reason) => {
  isReady = false;
  console.log('⚠️ Disconnected:', reason);
  console.log('🔄 Restarting in 10 seconds...');
  setTimeout(() => client.initialize(), 10000);
});

// === Admin / control API (localhost only) — full read + SEND ===
// Bound to 127.0.0.1 so it is NOT publicly reachable. Optionally token-gated
// via BRIDGE_TOKEN (defense in depth). The MCP server (lib.mjs) calls this.
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8799);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';

function chatIdFor(to) {
  const t = String(to || '').trim();
  if (t.includes('@')) return t;                  // already a serialized id (…@c.us / …@g.us)
  const digits = t.replace(/[^\d]/g, '');
  return digits ? `${digits}@c.us` : null;        // bare phone number
}

const adminServer = createServer(async (req, res) => {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (BRIDGE_TOKEN) {
      const tok = req.headers['x-bridge-token'] || u.searchParams.get('token');
      if (tok !== BRIDGE_TOKEN) return json(401, { error: 'unauthorized' });
    }
    if (u.pathname === '/health') return json(200, { ready: isReady });
    if (!isReady) return json(503, { error: 'whatsapp not ready yet' });

    if (u.pathname === '/me' && req.method === 'GET') {
      const info = client.info;
      return json(200, { number: info?.wid?.user, name: info?.pushname, platform: info?.platform });
    }

    if (u.pathname === '/chats' && req.method === 'GET') {
      const limit = Math.min(Number(u.searchParams.get('limit') || 200), 1000);
      const chats = await client.getChats();
      const out = chats.slice(0, limit).map(c => ({
        id: c.id._serialized, name: c.name, isGroup: c.isGroup,
        unread: c.unreadCount, timestamp: c.timestamp,
        last: c.lastMessage ? (c.lastMessage.body || '').slice(0, 140) : null,
      }));
      return json(200, { count: out.length, chats: out });
    }

    if (u.pathname === '/history' && req.method === 'GET') {
      const target = u.searchParams.get('chat');
      const limit = Math.min(Number(u.searchParams.get('limit') || 50), 300);
      if (!target) return json(400, { error: 'chat required' });
      const chat = await client.getChatById(chatIdFor(target) || target);
      const msgs = await chat.fetchMessages({ limit });
      return json(200, {
        chat: chat.name, id: chat.id._serialized,
        messages: msgs.map(m => ({
          ts: m.timestamp, fromMe: m.fromMe,
          from: m.fromMe ? 'Me' : (m._data?.notifyName || m.author || m.from),
          text: m.body, type: m.type,
        })),
      });
    }

    if (u.pathname === '/send' && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const { to, text } = JSON.parse(body || '{}');
      if (!to || !text) return json(400, { error: 'to and text required' });
      let chatId = chatIdFor(to);
      if (!chatId) return json(400, { error: `cannot resolve recipient: ${to}` });
      if (/^\d+@c\.us$/.test(chatId)) {            // bare phone → verify it's on WhatsApp
        const numId = await client.getNumberId(chatId.split('@')[0]);
        if (!numId) return json(404, { error: `not on WhatsApp: ${to}` });
        chatId = numId._serialized;
      }
      const sent = await client.sendMessage(chatId, text);
      console.log(`📤 Sent to ${chatId}: ${text.substring(0, 60)}`);
      return json(200, { sent: true, to: chatId, id: sent.id?._serialized });
    }

    return json(404, { error: 'not found' });
  } catch (err) {
    return json(500, { error: err.message });
  }
});

adminServer.listen(ADMIN_PORT, '127.0.0.1', () => {
  console.log(`🔧 Admin/control API on 127.0.0.1:${ADMIN_PORT} (/me, /chats, /history, /send)`);
});

// Graceful shutdown
function shutdown() {
  console.log('\n🛑 Shutting down...');
  httpServer.close();
  adminServer.close();
  client.destroy().then(() => {
    db.close();
    allDb.close();
    process.exit(0);
  }).catch(() => {
    db.close();
    allDb.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`🚀 WhatsApp Bridge starting...`);
console.log(TARGET_GROUP
  ? `🎯 Mirror group: "${TARGET_GROUP}" → whatsapp.db | all chats → all_chats.db`
  : `🎯 All chats → all_chats.db (no mirror group set)`);
console.log('⏳ Initializing Chromium (30-60 seconds)...\n');
client.initialize();
