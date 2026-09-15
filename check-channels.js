import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET = process.env.SHARED_SECRET || "";

async function main() {
  const headers = SECRET ? { Authorization: `Bearer ${SECRET}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), { requestInit: { headers } });
  const client = new Client({ name: "check-channels", version: "1.0.0" });
  await client.connect(transport);

  const res = await client.callTool({ name: "list_channels", arguments: {} });
  console.log("Raw res:", res);
  console.log("Content:", res.content[0]);
  const text = res.content[0].text;
  console.log("Text:", text);
  console.log("Text type:", typeof text);
  
  await transport.close();
}

main().catch(err => { console.error(err); process.exit(1); });
