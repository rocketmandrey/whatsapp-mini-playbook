#!/usr/bin/env node
// Remote HTTP entrypoint (Claude mobile/web via custom connector).
// Auth = secret in URL path: only /<WA_MCP_SECRET>/mcp is served. Streamable HTTP transport.
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './lib.mjs';

const PORT = Number(process.env.WA_MCP_PORT || 8796);
const SECRET = process.env.WA_MCP_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error('FATAL: WA_MCP_SECRET missing or too short (need >=16 chars).');
  process.exit(1);
}
const MCP_PATH = `/${SECRET}/mcp`;

// session-id -> transport
const transports = {};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : undefined); } catch { resolve(null); } });
  });
}

const httpServer = createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  // public, unauthenticated health check
  if (url === '/healthz') { res.writeHead(200).end('ok'); return; }

  // everything else must hit the secret path
  if (url !== MCP_PATH) { res.writeHead(404).end('not found'); return; }

  const sessionId = req.headers['mcp-session-id'];

  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      let transport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports[sid] = transport; },
        });
        transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
        await createMcpServer().connect(transport);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null }));
        return;
      }
      await transport.handleRequest(req, res, body);
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId || !transports[sessionId]) { res.writeHead(400).end('Invalid or missing session'); return; }
      await transports[sessionId].handleRequest(req, res);
    } else {
      res.writeHead(405).end('method not allowed');
    }
  } catch (err) {
    console.error('request error:', err.message);
    if (!res.headersSent) res.writeHead(500).end('internal error');
  }
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.error(`WhatsApp MCP HTTP server on 127.0.0.1:${PORT}, path /<secret>/mcp`);
});
