// netlify/functions/_utils.js
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

/**
 * CORS + JSON helpers
 */
function preferredOrigin() {
  // Netlify sets URL/DEPLOY_PRIME_URL to the site origin.
  // If unavailable (local/dev), fall back to "*".
  const o = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  try {
    return o ? new URL(o).origin : "";
  } catch {
    return "";
  }
}

export function corsHeaders() {
  const origin = preferredOrigin();
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  };
}

export function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

export function handleOptions(req) {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }
  return null;
}

/**
 * Storage
 * IMPORTANT: Create store inside the handler/request path.
 */
export function getLeadsStore() {
  const name = process.env.LEADS_STORE_NAME || "ashlee-leads";
  return getStore({ name, consistency: "strong" });
}

/**
 * Keying: leads/<timestamp>_<uuid>
 */
export function newLeadKey(now = new Date()) {
  return `leads/${now.toISOString()}_${crypto.randomUUID()}`;
}

// strict pattern prevents arbitrary blob reads/writes
const LEAD_KEY_RE =
  /^leads\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[0-9a-fA-F-]{36}$/;

export function assertLeadKey(key) {
  return typeof key === "string" && key.length < 220 && LEAD_KEY_RE.test(key);
}

/**
 * Safe JSON parse
 */
export async function readJsonSafe(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * Sanitizers
 */
export function sanitizeString(v, maxLen = 500) {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

export function normalizeInstagram(v) {
  const raw = sanitizeString(v, 60).replace(/^@/, "");
  return raw ? `@${raw}` : "";
}

export function normalizePhone(raw) {
  const s = sanitizeString(raw, 50);
  if (!s) return "";

  // Accept +E.164
  if (s.startsWith("+")) {
    const digits = s.replace(/[^\d+]/g, "");
    if (/^\+\d{10,15}$/.test(digits)) return digits;
    return "";
  }

  // Default: US normalization
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

export function originFromReq(req) {
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

export function getClientIp(req, context) {
  // Netlify provides context.ip; fall back to common headers if present.
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "";
  // If x-forwarded-for contains a list, take the first.
  return String(ip).split(",")[0].trim();
}

export function rateKeyForIp(ip) {
  // Normalize to a blob-safe key fragment (avoid ":" and other separators)
  const s = sanitizeString(ip, 80);
  if (!s) return "";
  return `rate/${s.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

export function isHoneypotTripped(body) {
  if (!body || typeof body !== "object") return false;
  const keys = ["hp", "honeypot", "website", "company", "confirm_email"];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      const v = sanitizeString(body[k], 200);
      if (v) return true;
    }
  }
  return false;
}

export function isPayloadTooLarge(req, maxBytes = 10000) {
  // Fast path: Content-Length header
  const cl = req.headers.get("content-length");
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) return true;
  }
  return false;
}


/**
 * Auth helpers
 * Admin endpoints must require:
 * - Authorization: Bearer <Netlify Identity JWT>
 * - Netlify injects verified user into context.clientContext.user
 */
export function requireJwt(req, context) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const user = context?.clientContext?.user;
  if (!user) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true, user };
}

/**
 * Allowlist by ADMIN_EMAILS and/or ADMIN_ROLE
 */
export function requireAdmin(context) {
  const user = context?.clientContext?.user;
  if (!user) return { ok: false, status: 401, error: "Unauthorized" };

  const email = (user.email || "").toLowerCase();

  const allow = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const requiredRole = (process.env.ADMIN_ROLE || "").trim();

  const roles =
    user?.app_metadata?.roles ||
    user?.user_metadata?.roles ||
    [];

  const emailAllowed = allow.length > 0 ? allow.includes(email) : false;
  const roleAllowed = requiredRole ? roles.includes(requiredRole) : false;

  if (!emailAllowed && !roleAllowed) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  return { ok: true, user: { email, roles } };
}

/**
 * Concurrency helper
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}
