// Shared WhatsApp MCP logic: tool defs + handlers + server factory.
// Reads the bridge archive, lists live chats, and CAN SEND via the bridge.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';

// Load .env (the stdio entrypoint doesn't), so BRIDGE_TOKEN is available.
for (const p of ['/root/whatsapp-mcp/.env']) {
  if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
}

// Default to the ALL-chats DB (groups + DMs) written by the patched bridge.
// Override with WA_DB_PATH=/root/whatsapp/whatsapp.db for León-only.
const DB_PATH = process.env.WA_DB_PATH || '/root/whatsapp-mcp/all_chats.db';
const DRAFTS_DB_PATH = process.env.WA_DRAFTS_DB_PATH || '/root/whatsapp-mcp/drafts.db';

// Live control channel to the bridge (whatsapp-web.js client): read-all + send.
const BRIDGE_URL = process.env.WA_BRIDGE_URL || 'http://127.0.0.1:8799';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
async function bridge(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(BRIDGE_TOKEN ? { 'x-bridge-token': BRIDGE_TOKEN } : {}) };
  let r;
  try { r = await fetch(`${BRIDGE_URL}${path}`, { ...opts, headers }); }
  catch (e) { throw new Error(`bridge unreachable (${BRIDGE_URL}): ${e.message}`); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `bridge HTTP ${r.status}`);
  return data;
}

const dbRO = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const dbRW = new Database(DRAFTS_DB_PATH);
dbRW.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT,
    group_name TEXT,
    reply_to TEXT,
    draft_text TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function resolveGroup(group) {
  if (!group) return null;
  const byId = dbRO.prepare('SELECT group_id, group_name FROM messages WHERE group_id = ? LIMIT 1').get(group);
  if (byId) return byId;
  return dbRO.prepare(
    'SELECT group_id, group_name FROM messages WHERE lower(group_name) LIKE lower(?) ORDER BY timestamp DESC LIMIT 1'
  ).get(`%${group}%`) || null;
}

export const TOOLS = [
  {
    name: 'whatsapp',
    description: 'WhatsApp — the ONE tool for everything WhatsApp: read messages, summarize/recap a group, search, list chats, and SEND messages to anyone. Always use THIS tool for any WhatsApp request (read, recap, catch up, summarize, search, who is linked, list chats, send/reply/message). Pick what to do with the `action` field.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['whoami', 'list_chats', 'list_groups', 'read_group', 'summarize_group', 'search_messages', 'fetch_history', 'send_message', 'save_draft', 'list_drafts'],
          description: 'What to do: whoami (which number is linked) | list_chats (all live chats) | list_groups (archived groups) | read_group (read a group/chat messages) | summarize_group (recap N days) | search_messages (find text) | fetch_history (live pull) | send_message (REALLY send) | save_draft | list_drafts.',
        },
        group: { type: 'string', description: 'For read_group/summarize_group/save_draft: WhatsApp group/chat name (substring ok) or group_id.' },
        chat: { type: 'string', description: 'For fetch_history: chat id (…@c.us / …@g.us) or phone number.' },
        query: { type: 'string', description: 'For search_messages: text to find in WhatsApp messages.' },
        to: { type: 'string', description: 'For send_message: recipient — phone number (digits, country code, no +) or chat id (…@c.us / …@g.us).' },
        text: { type: 'string', description: 'For send_message/save_draft: the message text.' },
        days: { type: 'number', description: 'For summarize_group: how many days back (default 7).' },
        since_hours: { type: 'number', description: 'For read_group: only last N hours (168 = week, 24 = today).' },
        limit: { type: 'number', description: 'Max items/messages to return.' },
        reply_to: { type: 'string', description: 'For save_draft: optional sender/message being replied to.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'whoami',
    description: 'WhatsApp: show which WhatsApp account is currently linked (your own WhatsApp number/name). Live via the bridge.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_chats',
    description: 'WhatsApp: list ALL live WhatsApp chats (groups AND private DMs) the linked account has — not just the archive. Use to browse WhatsApp conversations or find a chat/contact id. Live via the bridge.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max chats (default 200, max 1000).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_history',
    description: 'WhatsApp: fetch recent messages of ANY WhatsApp chat live from the phone (works even if not in the local archive). Prefer read_group for archived groups. Identify the chat by id (…@c.us / …@g.us), a phone number, or — for groups — a name via list_chats first.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id (…@c.us / …@g.us) or a bare phone number.' },
        limit: { type: 'number', description: 'Max messages (default 50, max 300).' },
      },
      required: ['chat'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: 'SEND a WhatsApp message to anyone — a phone number (digits, with country code, no +), or a chat id (…@c.us for a person / …@g.us for a group). This REALLY sends from the linked account. Use save_draft instead if the user only wants to review first.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient: phone number (e.g. 79991234567) or chat id (…@c.us / …@g.us).' },
        text: { type: 'string', description: 'Message text to send.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_groups',
    description: 'WhatsApp: list all WhatsApp groups/chats in the archive with message counts and last activity. Use to find a WhatsApp group by name before reading it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_group',
    description: 'WhatsApp: READ / GET the recent MESSAGES of a WhatsApp group or chat (the actual message history / conversation). Use this whenever the user wants to read a WhatsApp chat, see what was written, catch up, recap, or SUMMARIZE a WhatsApp group/conversation over a period. NOT email, NOT Slack — WhatsApp only. Identify the chat by name substring or group_id. Returns messages chronological (newest last). Use since_hours for "last week" (168) / "today" (24).',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'WhatsApp group/chat name (substring ok) or group_id. Omit to use the only group if there is just one.' },
        limit: { type: 'number', description: 'Max messages (default 50, max 500).' },
        since_hours: { type: 'number', description: 'Only messages from the last N hours (e.g. 168 = last week, 24 = today).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_messages',
    description: 'WhatsApp: SEARCH / FIND text inside WhatsApp message history (which WhatsApp chat mentioned X, find a message). WhatsApp only — not email/Slack. Case-insensitive substring match over message bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for in WhatsApp messages.' },
        group: { type: 'string', description: 'Optional: restrict to a WhatsApp group/chat (name substring or id).' },
        limit: { type: 'number', description: 'Max results (default 50).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'summarize_group',
    description: 'WhatsApp: SUMMARIZE a WhatsApp group/chat — get a recap / digest / brief of what happened in a WhatsApp conversation over the last N days. One-shot: it reads the messages itself and returns them grouped, ready to summarize. Use this whenever the user wants a summary / recap / "what happened this week" / catch-up of a WhatsApp group. WhatsApp only.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'WhatsApp group/chat name (substring ok) or group_id. Omit to use the only group if there is just one.' },
        days: { type: 'number', description: 'How many days back to cover (default 7 = last week).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_summaries',
    description: 'List periodic group summaries produced by the summarizer.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max summaries (default 10).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'save_draft',
    description: 'Save a DRAFT reply for a group. Does NOT send to WhatsApp — only stores it for the user to review/copy.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group name (substring ok) or group_id.' },
        text: { type: 'string', description: 'The draft message text.' },
        reply_to: { type: 'string', description: 'Optional: sender/message this draft replies to.' },
      },
      required: ['group', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_drafts',
    description: 'List saved drafts (newest first).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max drafts (default 20).' } },
      additionalProperties: false,
    },
  },
];

const fmtTs = (t) => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

export async function handle(name, args = {}) {
  // Unified entrypoint: `whatsapp({ action, ... })` dispatches to the per-action
  // logic below. This is the tool the mobile client should always pick.
  if (name === 'whatsapp') {
    const { action, ...rest } = args;
    if (!action) throw new Error('`action` is required (e.g. read_group, summarize_group, send_message).');
    return handle(action, rest);
  }
  switch (name) {
    case 'whoami': {
      const me = await bridge('/me');
      return { linked_number: me.number, name: me.name, platform: me.platform };
    }
    case 'list_chats': {
      const limit = Math.min(args.limit || 200, 1000);
      const data = await bridge(`/chats?limit=${limit}`);
      return { count: data.count, chats: data.chats.map(c => ({
        id: c.id, name: c.name, type: c.isGroup ? 'group' : 'dm',
        unread: c.unread, last: c.last,
      })) };
    }
    case 'fetch_history': {
      const limit = Math.min(args.limit || 50, 300);
      const data = await bridge(`/history?chat=${encodeURIComponent(args.chat)}&limit=${limit}`);
      return { chat: data.chat, id: data.id, count: data.messages.length, messages: data.messages.map(m => ({
        time: fmtTs(m.ts), from: m.from, text: m.text, type: m.type,
      })) };
    }
    case 'send_message': {
      const data = await bridge('/send', { method: 'POST', body: JSON.stringify({ to: args.to, text: args.text }) });
      return { sent: true, to: data.to, id: data.id, text: args.text };
    }
    case 'list_groups': {
      const rows = dbRO.prepare(`
        SELECT group_id, group_name, COUNT(*) AS messages,
               MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
        FROM messages GROUP BY group_id ORDER BY last_ts DESC
      `).all();
      return rows.map(r => ({ group_id: r.group_id, group_name: r.group_name, messages: r.messages, first: fmtTs(r.first_ts), last: fmtTs(r.last_ts) }));
    }
    case 'read_group': {
      let g = args.group ? resolveGroup(args.group) : null;
      if (!g && !args.group) {
        const groups = dbRO.prepare('SELECT DISTINCT group_id, group_name FROM messages').all();
        if (groups.length === 1) g = groups[0];
        else throw new Error('Multiple groups present — specify `group`. Use list_groups.');
      }
      if (!g) throw new Error(`Group not found: ${args.group}`);
      const limit = Math.min(args.limit || 50, 500);
      const params = [g.group_id];
      let where = 'group_id = ?';
      if (args.since_hours) { where += ' AND timestamp >= ?'; params.push(Math.floor(Date.now() / 1000) - args.since_hours * 3600); }
      const rows = dbRO.prepare(
        `SELECT timestamp, sender_name, message_text, message_type FROM messages WHERE ${where} ORDER BY timestamp DESC LIMIT ?`
      ).all(...params, limit);
      rows.reverse();
      return { group_name: g.group_name, group_id: g.group_id, count: rows.length, messages: rows.map(r => ({ time: fmtTs(r.timestamp), from: r.sender_name, text: r.message_text, type: r.message_type })) };
    }
    case 'summarize_group': {
      let g = args.group ? resolveGroup(args.group) : null;
      if (!g && !args.group) {
        const groups = dbRO.prepare('SELECT DISTINCT group_id, group_name FROM messages').all();
        if (groups.length === 1) g = groups[0];
        else throw new Error('Multiple groups present — specify `group`. Use list_groups.');
      }
      if (!g) throw new Error(`Group not found: ${args.group}`);
      const days = args.days || 7;
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      const rows = dbRO.prepare(
        'SELECT timestamp, sender_name, message_text FROM messages WHERE group_id = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 2000'
      ).all(g.group_id, since);
      const bySender = {};
      for (const r of rows) bySender[r.sender_name] = (bySender[r.sender_name] || 0) + 1;
      const top = Object.entries(bySender).sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([name, n]) => ({ sender: name, messages: n }));
      // Compact transcript the model can turn into a brief in one shot.
      const transcript = rows.map(r => `[${fmtTs(r.timestamp)}] ${r.sender_name}: ${r.message_text}`).join('\n');
      return {
        group_name: g.group_name,
        period_days: days,
        message_count: rows.length,
        participants: top,
        instruction: 'Write a SHORT brief in the user\'s language: the few things that actually matter (events, dates, decisions, action items). Skip chit-chat.',
        transcript,
      };
    }
    case 'search_messages': {
      const limit = Math.min(args.limit || 50, 500);
      const params = [`%${args.query}%`];
      let where = 'message_text LIKE ?';
      if (args.group) { const g = resolveGroup(args.group); if (g) { where += ' AND group_id = ?'; params.push(g.group_id); } }
      const rows = dbRO.prepare(
        `SELECT timestamp, group_name, sender_name, message_text FROM messages WHERE ${where} ORDER BY timestamp DESC LIMIT ?`
      ).all(...params, limit);
      return rows.map(r => ({ time: fmtTs(r.timestamp), group: r.group_name, from: r.sender_name, text: r.message_text }));
    }
    case 'list_summaries': {
      const limit = Math.min(args.limit || 10, 100);
      return dbRO.prepare(
        'SELECT period_start, period_end, message_count, summary_text, created_at FROM summaries ORDER BY id DESC LIMIT ?'
      ).all(limit).map(r => ({ period: `${fmtTs(r.period_start)} → ${fmtTs(r.period_end)}`, messages: r.message_count, summary: r.summary_text, created_at: r.created_at }));
    }
    case 'save_draft': {
      const g = resolveGroup(args.group);
      const info = dbRW.prepare('INSERT INTO drafts (group_id, group_name, reply_to, draft_text) VALUES (?, ?, ?, ?)')
        .run(g?.group_id || null, g?.group_name || args.group, args.reply_to || null, args.text);
      return { saved: true, id: info.lastInsertRowid, group: g?.group_name || args.group, text: args.text, note: 'Draft stored only — NOT sent to WhatsApp.' };
    }
    case 'list_drafts': {
      const limit = Math.min(args.limit || 20, 200);
      return dbRW.prepare('SELECT id, group_name, reply_to, draft_text, status, created_at FROM drafts ORDER BY id DESC LIMIT ?').all(limit);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Build a fresh MCP Server wired to the tool handlers.
// Expose ONLY the single umbrella `whatsapp` tool to clients, so mobile
// tool-search has exactly one WhatsApp tool to find — it cannot pick the wrong
// one. The per-action tools still exist in TOOLS and handle() still accepts
// them directly, but they are hidden from tools/list.
export const PUBLIC_TOOLS = TOOLS.filter(t => t.name === 'whatsapp');

export function createMcpServer() {
  const server = new Server({ name: 'whatsapp', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PUBLIC_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await handle(req.params.name, req.params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });
  return server;
}
