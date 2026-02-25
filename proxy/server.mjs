#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.CLAWPOST_PROXY_HOST?.trim() || "127.0.0.1";
const PORT = Number.parseInt(process.env.CLAWPOST_PROXY_PORT ?? "8788", 10);
const UPSTREAM_URL = process.env.CLAWPOST_UPSTREAM_URL?.trim();
const UPSTREAM_API_KEY = process.env.CLAWPOST_UPSTREAM_API_KEY?.trim();
const LOCAL_AUTH_TOKEN = process.env.CLAWPOST_PROXY_AUTH_TOKEN?.trim() || "";

if (!UPSTREAM_URL) {
  console.error("Missing CLAWPOST_UPSTREAM_URL");
  process.exit(1);
}

if (!UPSTREAM_API_KEY) {
  console.error("Missing CLAWPOST_UPSTREAM_API_KEY");
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`Invalid CLAWPOST_PROXY_PORT: ${process.env.CLAWPOST_PROXY_PORT ?? ""}`);
  process.exit(1);
}

let upstream;
try {
  upstream = new URL(UPSTREAM_URL);
} catch {
  console.error(`Invalid CLAWPOST_UPSTREAM_URL: ${UPSTREAM_URL}`);
  process.exit(1);
}

const upstreamPathPrefix = upstream.pathname.replace(/\/+$/, "");
const proxyDir = dirname(fileURLToPath(import.meta.url));
const openApiPath = join(proxyDir, "openapi.yaml");

function isApiPath(pathname) {
  return pathname.startsWith("/api/");
}

function isAuthorized(req) {
  if (!LOCAL_AUTH_TOKEN) return true;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader === `Bearer ${LOCAL_AUTH_TOKEN}`) return true;

  const proxyToken = req.headers["x-proxy-token"];
  if (typeof proxyToken === "string" && proxyToken === LOCAL_AUTH_TOKEN) return true;

  return false;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Proxy-Token");
}

function writeJson(res, status, payload) {
  setCors(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildUpstreamUrl(pathname, search) {
  return `${upstream.origin}${upstreamPathPrefix}${pathname}${search}`;
}

function copyResponseHeaders(sourceHeaders) {
  const headers = {};
  for (const [key, value] of sourceHeaders.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === "transfer-encoding" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "content-encoding"
    ) {
      continue;
    }

    headers[key] = value;
  }
  return headers;
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method ?? "GET";
    const incomingUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (method === "OPTIONS") {
      setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (incomingUrl.pathname === "/" || incomingUrl.pathname === "/health") {
      writeJson(res, 200, {
        ok: true,
        proxy: "clawpost-local-proxy",
        upstream: `${upstream.origin}${upstreamPathPrefix || "/"}`,
      });
      return;
    }

    if (incomingUrl.pathname === "/openapi.yaml") {
      const content = await readFile(openApiPath, "utf8");
      setCors(res);
      res.writeHead(200, { "Content-Type": "text/yaml; charset=utf-8" });
      res.end(content);
      return;
    }

    if (!isApiPath(incomingUrl.pathname)) {
      writeJson(res, 404, {
        error: "Not found",
        hint: "Use /api/*, /health, or /openapi.yaml",
      });
      return;
    }

    if (!isAuthorized(req)) {
      writeJson(res, 401, { error: "Unauthorized proxy request" });
      return;
    }

    const targetUrl = buildUpstreamUrl(incomingUrl.pathname, incomingUrl.search);
    const headers = new Headers();

    for (const [name, rawValue] of Object.entries(req.headers)) {
      if (!rawValue) continue;
      const lower = name.toLowerCase();
      if (
        lower === "host" ||
        lower === "connection" ||
        lower === "content-length" ||
        lower === "x-api-key" ||
        lower === "authorization" ||
        lower === "x-proxy-token"
      ) {
        continue;
      }

      const value = Array.isArray(rawValue) ? rawValue.join(",") : rawValue;
      headers.set(name, value);
    }

    headers.set("X-API-Key", UPSTREAM_API_KEY);

    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? await readRequestBody(req) : undefined;

    const upstreamResponse = await fetch(targetUrl, {
      method,
      headers,
      body: body && body.length > 0 ? body : undefined,
      redirect: "follow",
    });

    const responseBytes = Buffer.from(await upstreamResponse.arrayBuffer());
    const responseHeaders = copyResponseHeaders(upstreamResponse.headers);
    responseHeaders["Content-Length"] = String(responseBytes.length);
    setCors(res);
    res.writeHead(upstreamResponse.status, responseHeaders);
    res.end(responseBytes);
  } catch (error) {
    console.error("Proxy request failed", error);
    writeJson(res, 502, { error: "Bad gateway" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Clawpost proxy listening on http://${HOST}:${PORT}`);
  console.log(`Forwarding /api/* to ${upstream.origin}${upstreamPathPrefix || "/"}`);
  if (LOCAL_AUTH_TOKEN) {
    console.log("Local proxy auth enabled (Bearer token or X-Proxy-Token)");
  }
});
