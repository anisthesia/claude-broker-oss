import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import "dotenv/config";

const BROKER_URL = process.env.BROKER_URL || "http://localhost:8080/mcp";
const SECRET = process.env.SHARED_SECRET || "";

async function connect(name) {
  const transport = new StreamableHTTPClientTransport(new URL(BROKER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${SECRET}` } },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function main() {
  console.log(`[test] connecting two clients to ${BROKER_URL}`);

  const mac     = await connect("mac-session");
  const windows = await connect("windows-session");

  console.log("[test] listing tools on mac client");
  const tools = await mac.client.listTools();
  console.log("  tools:", tools.tools.map(t => t.name).join(", "));

  const channel = `test-${Date.now()}`;
  console.log(`[test] mac → send 'hello from mac' on channel ${channel}`);
  const sendRes = await mac.client.callTool({
    name: "send_message",
    arguments: { channel, sender: "mac", content: "hello from mac" },
  });
  console.log("  ", sendRes.content[0].text);

  console.log(`[test] windows → send 'hi from windows' on channel ${channel}`);
  await windows.client.callTool({
    name: "send_message",
    arguments: { channel, sender: "windows", content: "hi from windows" },
  });

  console.log(`[test] mac → read_messages on ${channel}`);
  const readRes = await mac.client.callTool({
    name: "read_messages",
    arguments: { channel },
  });
  console.log("---");
  console.log(readRes.content[0].text);
  console.log("---");

  console.log("[test] list_channels");
  const chans = await mac.client.callTool({ name: "list_channels", arguments: {} });
  console.log(chans.content[0].text);

  console.log("[test] purge");
  const purge = await mac.client.callTool({ name: "purge_channel", arguments: { channel } });
  console.log(" ", purge.content[0].text);

  await mac.transport.close();
  await windows.transport.close();
  console.log("[test] OK");
}

main().catch(e => { console.error("[test] FAIL:", e); process.exit(1); });
