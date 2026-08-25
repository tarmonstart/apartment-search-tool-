"use strict";
// Polite HTTP helpers: retries with backoff, timeouts, gzip, and a shared
// concurrency pool. Everything the collectors do goes through here.
const https = require("https");
const zlib = require("zlib");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rawGet(url, { timeout = 20000, headers = {}, binary = false, method = "GET", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          "User-Agent": UA,
          "Accept-Language": "lv,en;q=0.8,ru;q=0.6",
          "Accept-Encoding": "gzip, deflate",
          ...(body != null ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        // follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return resolve(rawGet(next, { timeout, headers, binary }));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          const e = new Error(`HTTP ${res.statusCode} for ${url}`);
          e.statusCode = res.statusCode;
          return reject(e);
        }
        let stream = res;
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        const chunks = [];
        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve(binary ? buf : buf.toString("utf8"));
        });
        stream.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("timeout: " + url)));
    req.end(body == null ? undefined : body);
  });
}

// Retry on transient failures (timeouts, 5xx, connection resets). A 404 is
// final — retrying it just wastes the site's time and ours.
async function get(url, opts = {}) {
  const tries = opts.tries ?? 3;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await rawGet(url, opts);
    } catch (e) {
      lastErr = e;
      if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) throw e;
      if (i < tries - 1) await sleep(500 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

const getText = (url, opts) => get(url, opts);
const getBuffer = (url, opts) => get(url, { ...opts, binary: true });
async function getJSON(url, opts) {
  return JSON.parse(await get(url, { ...opts, headers: { Accept: "application/json", ...(opts && opts.headers) } }));
}
// JSON-in, JSON-out POST — varianti.lv's list API is POST-only.
async function postJSON(url, payload, opts) {
  return JSON.parse(
    await get(url, {
      ...opts,
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(opts && opts.headers),
      },
    })
  );
}

// Run `worker` over `items` with bounded concurrency and a per-task delay,
// so we never hammer a site. Failures are swallowed per-item: one dead
// listing must not abort a whole run.
async function pool(items, worker, concurrency = 4, delayMs = 400, onProgress) {
  const queue = [...items];
  let done = 0;
  const results = [];
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        results.push(await worker(item));
      } catch (e) {
        results.push(null);
      }
      done++;
      if (onProgress) onProgress(done, items.length);
      if (delayMs) await sleep(delayMs);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { UA, sleep, get, getText, getJSON, getBuffer, postJSON, pool };
