#!/usr/bin/env bun

import { createEnv } from "@t3-oss/env-core";
import { config as loadDotEnv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const proxyDir = dirname(fileURLToPath(import.meta.url));
loadDotEnv({ path: join(proxyDir, ".env"), override: false, quiet: true });

const env = createEnv({
  server: {
    CLAWPOST_UPSTREAM_URL: z.string().url(),
    CLAWPOST_UPSTREAM_API_KEY: z.string().min(1),
    CLAWPOST_PROXY_HOST: z.string().default("127.0.0.1"),
    CLAWPOST_PROXY_PORT: z
      .string()
      .default("8788")
      .transform((value, ctx) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "CLAWPOST_PROXY_PORT must be an integer from 1 to 65535",
          });
          return z.NEVER;
        }

        return parsed;
      }),
    CLAWPOST_PROXY_AUTH_TOKEN: z.string().default(""),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

const upstream = new URL(env.CLAWPOST_UPSTREAM_URL);
const upstreamPathPrefix = upstream.pathname.replace(/\/+$/, "");
const openApiPath = join(proxyDir, "openapi.yaml");

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Proxy-Token",
};

const REQUEST_HEADER_BLOCKLIST = new Set([
  "host",
  "connection",
  "content-length",
  "x-api-key",
  "authorization",
  "x-proxy-token",
]);

const RESPONSE_HEADER_BLOCKLIST = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function applyCors(headers: Headers): Headers {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

function jsonResponse(status: number, payload: unknown): Response {
  const body = JSON.stringify(payload);
  const headers = applyCors(new Headers());
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(body, { status, headers });
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isAuthorized(request: Request): boolean {
  if (!env.CLAWPOST_PROXY_AUTH_TOKEN) return true;

  const authHeader = request.headers.get("authorization");
  if (authHeader === `Bearer ${env.CLAWPOST_PROXY_AUTH_TOKEN}`) {
    return true;
  }

  const proxyToken = request.headers.get("x-proxy-token");
  if (proxyToken === env.CLAWPOST_PROXY_AUTH_TOKEN) {
    return true;
  }

  return false;
}

function buildUpstreamUrl(pathname: string, search: string): string {
  return `${upstream.origin}${upstreamPathPrefix}${pathname}${search}`;
}

function buildUpstreamHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (REQUEST_HEADER_BLOCKLIST.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }
  headers.set("X-API-Key", env.CLAWPOST_UPSTREAM_API_KEY);
  return headers;
}

function buildDownstreamHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of upstreamHeaders) {
    if (RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase())) continue;
    headers.set(name, value);
  }
  return applyCors(headers);
}

const server = Bun.serve({
  hostname: env.CLAWPOST_PROXY_HOST,
  port: env.CLAWPOST_PROXY_PORT,
  async fetch(request) {
    const method = request.method.toUpperCase();
    const incomingUrl = new URL(request.url);

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: applyCors(new Headers()) });
    }

    if (incomingUrl.pathname === "/" || incomingUrl.pathname === "/health") {
      return jsonResponse(200, {
        ok: true,
        proxy: "clawpost-local-proxy",
        upstream: `${upstream.origin}${upstreamPathPrefix || "/"}`,
      });
    }

    if (incomingUrl.pathname === "/openapi.yaml") {
      try {
        const content = await Bun.file(openApiPath).text();
        const headers = applyCors(new Headers());
        headers.set("Content-Type", "text/yaml; charset=utf-8");
        return new Response(content, { status: 200, headers });
      } catch (error) {
        console.error("Unable to read openapi.yaml", error);
        return jsonResponse(500, { error: "Proxy OpenAPI spec unavailable" });
      }
    }

    if (!isApiPath(incomingUrl.pathname)) {
      return jsonResponse(404, {
        error: "Not found",
        hint: "Use /api/*, /health, or /openapi.yaml",
      });
    }

    if (!isAuthorized(request)) {
      return jsonResponse(401, { error: "Unauthorized proxy request" });
    }

    try {
      const targetUrl = buildUpstreamUrl(incomingUrl.pathname, incomingUrl.search);
      const headers = buildUpstreamHeaders(request);
      const hasBody = method !== "GET" && method !== "HEAD";

      const upstreamResponse = await fetch(targetUrl, {
        method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: "follow",
      });

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: buildDownstreamHeaders(upstreamResponse.headers),
      });
    } catch (error) {
      console.error("Proxy request failed", error);
      return jsonResponse(502, { error: "Bad gateway" });
    }
  },
});

console.log(`Clawpost proxy listening on http://${env.CLAWPOST_PROXY_HOST}:${server.port}`);
console.log(`Forwarding /api/* to ${upstream.origin}${upstreamPathPrefix || "/"}`);
if (env.CLAWPOST_PROXY_AUTH_TOKEN) {
  console.log("Local proxy auth enabled (Bearer token or X-Proxy-Token)");
}
