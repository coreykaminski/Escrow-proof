#!/usr/bin/env -S npx tsx
/**
 * Proof Desk MCP server over stdio.
 *
 *   PROOFDESK_API_KEY=pd_test_… PROOFDESK_BASE_URL=http://localhost:8787 npm start -w @proofdesk/mcp
 *
 * Claude Desktop / Claude Code config:
 *   { "mcpServers": { "proof-desk": { "command": "npx", "args": ["tsx", "<repo>/apps/mcp/src/main.ts"],
 *       "env": { "PROOFDESK_API_KEY": "pd_test_…", "PROOFDESK_BASE_URL": "http://localhost:8787" } } } }
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProofDesk } from "@proofdesk/sdk";
import { createServer } from "./server.ts";

const apiKey = process.env.PROOFDESK_API_KEY;
if (!apiKey) {
  console.error("Set PROOFDESK_API_KEY (a pd_test_… key for the sandbox).");
  process.exit(1);
}
const pd = new ProofDesk({
  apiKey,
  baseUrl: process.env.PROOFDESK_BASE_URL ?? "http://localhost:8787",
});
await createServer(pd).connect(new StdioServerTransport());
// stdout carries the protocol; log to stderr only.
console.error(`Proof Desk MCP server ready (${pd.livemode ? "live" : "sandbox"}).`);
