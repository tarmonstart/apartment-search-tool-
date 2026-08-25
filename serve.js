#!/usr/bin/env node
"use strict";
// ---------------------------------------------------------------------------
// Tiny LAN server so the report can be used on a phone.
//
//   node serve.js          → http://<this-pc>:8877  on your home Wi-Fi
//
// Serving over http also upgrades saving: the report POSTs every verdict to
// /api/state, which merges it straight into state/user-state.json through the
// same machinery the finder itself uses. No Export step, on any device.
//
// Scope: your local network only. There is no auth — do not port-forward it.
// ---------------------------------------------------------------------------
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadUserState, saveUserState, countVerdicts } = require("./lib/state");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8877);

// Only what the phone actually needs — this is not a general file server.
const FILES = {
  "/": { file: "listings.html", type: "text/html; charset=utf-8" },
  "/listings.html": { file: "listings.html", type: "text/html; charset=utf-8" },
  "/listings.csv": { file: "listings.csv", type: "text/csv; charset=utf-8" },
};

function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");

  if (req.method === "GET" && u.pathname === "/api/ping") {
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  if (req.method === "POST" && u.pathname === "/api/state") {
    let body = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2e6) { req.destroy(); return; } // a verdict file is a few KB
      body += c;
    });
    req.on("end", () => {
      try {
        const d = JSON.parse(body);
        if (!d || typeof d !== "object" || (!d.pile && !d.visited))
          throw new Error("not a state object");
        // Drop it where the finder already looks for exports, then run the
        // canonical merge immediately — one code path for every save.
        const inbox = path.join(ROOT, "state", "user-state.from-http.json");
        fs.mkdirSync(path.dirname(inbox), { recursive: true });
        fs.writeFileSync(inbox, JSON.stringify(d));
        const merged = loadUserState(ROOT, {});
        saveUserState(ROOT, merged);
        fs.unlinkSync(inbox); // absorbed into the canonical file
        const c = countVerdicts(merged.pile);
        console.log(
          `  saved: ${c.like} liked · ${c.maybe} maybe · ${c.discard} discarded ` +
          `(from ${req.socket.remoteAddress})`
        );
        send(res, 200, JSON.stringify({ ok: true, verdicts: c }));
      } catch (e) {
        send(res, 400, JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    });
    return;
  }

  const hit = req.method === "GET" && FILES[u.pathname];
  if (hit) {
    fs.readFile(path.join(ROOT, hit.file), (err, buf) => {
      if (err) return send(res, 404, "not built yet — run: node find-rentals.js", "text/plain");
      send(res, 200, buf, hit.type);
    });
    return;
  }

  send(res, 404, "not found", "text/plain");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Rīga rentals — phone server\n");
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(nets))
    for (const n of list || [])
      if (n.family === "IPv4" && !n.internal) addrs.push(n.address);
  console.log("  on this PC:     http://localhost:" + PORT);
  for (const a of addrs)
    console.log("  on your phone:  http://" + a + ":" + PORT + "   (same Wi-Fi)");
  console.log("\n  verdicts made in the browser save straight to state/user-state.json.");
  console.log("  Ctrl+C stops it. LAN only — do not port-forward this.");
});
