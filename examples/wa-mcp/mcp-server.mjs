#!/usr/bin/env node
// stdio entrypoint (Claude Code CLI + Claude Desktop). Logic lives in lib.mjs.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './lib.mjs';

const server = createMcpServer();
await server.connect(new StdioServerTransport());
console.error('WhatsApp MCP server running (stdio, read + drafts).');
