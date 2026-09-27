// Local server: static files + GDPS API proxy (avoids CORS)
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const GDPS_ORIGIN = process.env.GDPS_ORIGIN || "https://dimgdps.ps.fhgdps.com";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".fnt": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".map": "application/json"
};

function readRequestBody(req, callback) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => callback(Buffer.concat(chunks)));
  function fail() { callback(Buffer.alloc(0)); }
  req.on("error", fail);
}

function proxyTo(res, targetUrl, reqMethod, reqBody, reqHeaders, redirectCount) {
  redirectCount = redirectCount || 0;
  let target;
  try {
    target = new URL(targetUrl);
  } catch (e) {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    res.end("Bad proxy target");
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
    res.end("Unsupported protocol");
    return;
  }

  const forwardHeaders = {
    "Host": target.host,
    "Accept": reqHeaders["accept"] || "*/*",
    "Accept-Language": reqHeaders["accept-language"] || "*",
    "Connection": "close"
  };
  if (reqHeaders["content-type"]) forwardHeaders["Content-Type"] = reqHeaders["content-type"];
  if (reqHeaders["user-agent"]) forwardHeaders["User-Agent"] = reqHeaders["user-agent"];
  if (reqHeaders["range"]) forwardHeaders["Range"] = reqHeaders["range"];
  if (reqBody && reqBody.length && reqMethod !== "GET" && reqMethod !== "HEAD") {
    forwardHeaders["Content-Length"] = String(reqBody.length);
  }

  const transport = target.protocol === "https:" ? https : http;
  const request = transport.request(
    target,
    { method: reqMethod, headers: forwardHeaders, timeout: 30000 },
    (upstream) => {
      const status = upstream.statusCode || 502;
      if (status >= 300 && status < 400 && upstream.headers.location && redirectCount < 5) {
        upstream.resume();
        const next = new URL(upstream.headers.location, target).toString();
        proxyTo(res, next, reqMethod, reqBody, reqHeaders, redirectCount + 1);
        return;
      }
      const outHeaders = {};
      for (const name of ["content-type", "content-length", "content-disposition", "cache-control", "last-modified", "etag", "accept-ranges"]) {
        if (upstream.headers[name]) outHeaders[name] = upstream.headers[name];
      }
      outHeaders["Access-Control-Allow-Origin"] = "*";
      outHeaders["Access-Control-Allow-Headers"] = "*";
      outHeaders["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      res.writeHead(status, outHeaders);
      upstream.pipe(res);
      upstream.on("error", () => { res.end(); });
    }
  );
  request.on("timeout", () => request.destroy(new Error("proxy timeout")));
  request.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Access-Control-Allow-Origin": "*" });
      res.end("Proxy error: " + err.message);
    } else {
      res.end();
    }
  });
  if (reqBody && reqBody.length && reqMethod !== "GET" && reqMethod !== "HEAD") {
    request.write(reqBody);
  }
  request.end();
}

function serveStatic(req, res, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (e) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (decoded.includes("\0")) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  let filePath = path.normalize(path.join(ROOT, decoded));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    // SPA fallback for extension-less paths, otherwise 404
    if (!path.extname(decoded)) {
      filePath = path.join(ROOT, "index.html");
    } else {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  fs.stat(filePath, (err, stat) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { "ETag": etag });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "ETag": etag,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600"
    });
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => res.end());
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const host = req.headers["host"] || "localhost";
  let url;
  try {
    url = new URL(req.url, "http://" + host);
  } catch (e) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  // CORS preflight for proxy endpoints
  if (req.method === "OPTIONS" && url.pathname.startsWith("/gd")) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "86400"
    });
    res.end();
    return;
  }

  // audio-proxy: forward directly to the remote song/sfx URL
  if (url.pathname === "/gd/audio-proxy") {
    const target = url.searchParams.get("url");
    if (!target) {
      res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
      res.end("Missing url parameter");
      return;
    }
    readRequestBody(req, (body) => {
      proxyTo(res, target, req.method, body, req.headers);
    });
    return;
  }

  // cloudflare song-id worker proxy: /gd/ws?id=XXX -> https://fetchsongid.lasokar.workers.dev/?id=XXX
  if (url.pathname === "/gd/ws" || url.pathname.startsWith("/gd/ws/")) {
    const songId = url.searchParams.get("id");
    if (!songId) {
      res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
      res.end("Missing id parameter");
      return;
    }
    const target = "https://fetchsongid.lasokar.workers.dev/?id=" + encodeURIComponent(songId);
    return proxyTo(res, target, req.method, Buffer.alloc(0), req.headers);
  }

  // GDPS API proxy: /gd/getGJLevels21.php -> https://dimgdps.ps.fhgdps.com/getGJLevels21.php
  if (url.pathname === "/gd" || url.pathname.startsWith("/gd/")) {
    const target = GDPS_ORIGIN + url.pathname.slice(3) + url.search;
    readRequestBody(req, (body) => {
      proxyTo(res, target, req.method, body, req.headers);
    });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log("DimGDPS-Web running at http://localhost:" + PORT);
  console.log("GDPS proxy target: " + GDPS_ORIGIN);
});
