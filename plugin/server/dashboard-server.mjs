#!/usr/bin/env node
// The browser dashboard's server for the autoresearch mod: pi-autoresearch@939ede8
// index.ts:2771-2966 (template and logo injection, the routes, SSE and
// broadcastDashboardUpdate), which pi ran in its own process. A mod has no server API,
// so this runs as a helper under node >= 18 or bun (F9) and adds only what that needs:
//
//   POST /notify?token=T   broadcast `jsonl-updated` (the mod calls it after each write)
//   POST /page?token=T     {"title", "jsonlPath"}: a new export of the same workDir
//   --parent-pid PID       exit once that process is gone (and whenever this helper is
//                          orphaned), so it never outlives Claude Code
//   stdout line 1          {"port":N,"token":"…"} once listening, or {"error":"…"}
//
//   dashboard-server.mjs --jsonl FILE --template FILE --logo FILE --title TEXT [--parent-pid PID]

import { randomBytes } from "node:crypto";
import { readFile, readFileSync } from "node:fs";
import { createServer } from "node:http";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`bad argument ${name ?? ""}`);
    args[name.slice(2)] = value;
  }
  for (const required of ["jsonl", "template", "logo", "title"]) {
    if (args[required] === undefined) throw new Error(`missing --${required}`);
  }
  return args;
}

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }) + "\n");
  process.exit(1);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// ported from pi-autoresearch@939ede8 index.ts:2771-2818
const TITLE_PLACEHOLDER = "__AUTORESEARCH_TITLE__";
const LOGO_PLACEHOLDER = "__AUTORESEARCH_LOGO__";

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function injectDataIntoTemplate(template, title) {
  const escapedTitle = escapeHtml(title);
  return template.replace(TITLE_PLACEHOLDER, () => escapedTitle);
}

let logoDataUrl;
let template;
try {
  logoDataUrl = `data:image/webp;base64,${readFileSync(args.logo).toString("base64")}`;
  template = readFileSync(args.template, "utf-8");
} catch (error) {
  fail(`cannot read the dashboard assets: ${error instanceof Error ? error.message : String(error)}`);
}

// upstream wrote the page to a temp file per export and served it; here it is kept in memory
let jsonlPath = args.jsonl;
let html = "";
function renderPage(title) {
  html = injectDataIntoTemplate(template, title).replace(LOGO_PLACEHOLDER, () => logoDataUrl);
}
renderPage(args.title);

const token = randomBytes(16).toString("hex");
const sseClients = new Set();

// ported from pi-autoresearch@939ede8 index.ts:2860-2912
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
};

function registerSseClient(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 1000\n\n");
  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
}

function broadcastDashboardUpdate() {
  for (const res of sseClients) {
    try {
      res.write("event: jsonl-updated\n");
      res.write(`data: ${Date.now()}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "POST" && (url.pathname === "/notify" || url.pathname === "/page")) {
    if (url.searchParams.get("token") !== token) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (url.pathname === "/page") {
      try {
        const page = JSON.parse(await readBody(req));
        if (typeof page.title === "string") renderPage(page.title);
        if (typeof page.jsonlPath === "string") jsonlPath = page.jsonlPath;
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
    } else {
      await readBody(req).catch(() => "");
    }
    broadcastDashboardUpdate();
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }

  if (url.pathname === "/events") {
    registerSseClient(res);
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"] });
    res.end(html);
    return;
  }

  if (url.pathname === "/autoresearch.jsonl") {
    readFile(jsonlPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".jsonl"] });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.on("error", (error) => fail(`Failed to bind dashboard server: ${error.message}`));

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") fail("Failed to bind dashboard server");
  process.stdout.write(JSON.stringify({ port: address.port, token }) + "\n");
});

// Never outlive Claude Code: the parent it was given, and the one it started under.
function shutdown() {
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }
  server.close();
  process.exit(0);
}

const startParent = process.ppid;
const parentPid = args["parent-pid"] ? Number(args["parent-pid"]) : null;
setInterval(() => {
  if (process.ppid !== startParent) shutdown();
  if (parentPid) {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (error?.code !== "EPERM") shutdown();
    }
  }
}, 1000).unref();

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, shutdown);
