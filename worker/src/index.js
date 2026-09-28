// DimGDPS proxy worker
// - /anything  -> https://dimgdps.ps.fhgdps.com/anything (GDPS API passthrough)
// - /audio-proxy?url=<song url> -> streams the remote audio file (NG / CDN)
// Adds permissive CORS so GitHub Pages can talk to the GDPS.

const GDPS_ORIGIN = "https://dimgdps.ps.fhgdps.com";

const AUDIO_HOST_SUFFIXES = [
  "ngfiles.com",
  "newgrounds.com",
  "b-cdn.net",
  "soundcloud.com",
  "sndcdn.com",
  "fhgdps.com",
  "boomlings.com",
  "geometrydashfiles.com"
];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS, HEAD",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
  "access-control-max-age": "86400"
};

function corsResponse(body, status, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { status, headers });
}

function isAudioHostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return AUDIO_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith("." + suffix)
  );
}

async function proxyAudio(request, url) {
  const target = url.searchParams.get("url");
  if (!target) return corsResponse("missing url param", 400);
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return corsResponse("bad url param", 400);
  }
  if (targetUrl.protocol !== "https:") return corsResponse("only https allowed", 400);
  if (!isAudioHostAllowed(targetUrl.hostname)) return corsResponse("host not allowed", 403);

  const upstreamHeaders = new Headers();
  upstreamHeaders.set("accept", "*/*");
  const range = request.headers.get("range");
  if (range) upstreamHeaders.set("range", range);
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) upstreamHeaders.set("if-none-match", ifNoneMatch);

  const upstream = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "follow"
  });

  const headers = new Headers();
  for (const name of ["content-type", "content-length", "content-disposition", "cache-control", "last-modified", "etag", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function proxyGdps(request, url) {
  const targetUrl = GDPS_ORIGIN + url.pathname + url.search;

  const method = request.method.toUpperCase();
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");
  headers.delete("cookie");

  const init = { method, headers, redirect: "follow" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(targetUrl, init);

  const headersOut = new Headers();
  for (const name of ["content-type", "content-length", "cache-control", "date", "server"]) {
    const value = upstream.headers.get(name);
    if (value) headersOut.set(name, value);
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) headersOut.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers: headersOut });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/audio-proxy") {
      try {
        return await proxyAudio(request, url);
      } catch (err) {
        return corsResponse("audio upstream error: " + err.message, 502);
      }
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return corsResponse(JSON.stringify({ ok: true, service: "dimgdps-proxy" }), 200, {
        "content-type": "application/json"
      });
    }

    try {
      return await proxyGdps(request, url);
    } catch (err) {
      return corsResponse("gdps upstream error: " + err.message, 502);
    }
  }
};
