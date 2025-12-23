// netlify/functions/leads-update.js
import {
  json,
  handleOptions,
  getLeadsStore,
  requireJwt,
  requireAdmin,
  readJsonSafe,
  sanitizeString,
  assertLeadKey,
} from "./_utils.js";

const VALID_STATUSES = new Set(["new", "contacted", "booked", "closed", "noshow"]);

function normalizeStatus(raw) {
  return sanitizeString(raw, 30).toLowerCase();
}

function coercePatch(body) {
  // Contract: { id, patch: { status, internal_notes, tags, archived } }
  if (body && typeof body === "object" && body.patch && typeof body.patch === "object") {
    return body.patch;
  }
  return {};
}

function applyPatch(existing, patchRaw) {
  const patch = patchRaw && typeof patchRaw === "object" ? patchRaw : {};
  const out = { ...existing };

  if (patch.status != null) {
    const s = normalizeStatus(patch.status);
    if (!VALID_STATUSES.has(s)) throw new Error("Invalid status");
    out.status = s;
  }

  if (patch.internal_notes != null) out.internal_notes = sanitizeString(patch.internal_notes, 2000);

  if (patch.tags != null) {
    const tags = Array.isArray(patch.tags) ? patch.tags : [];
    out.tags = tags.map((t) => sanitizeString(t, 40)).filter(Boolean).slice(0, 25);
  }

  if (patch.archived != null) out.archived = Boolean(patch.archived);

  const nowIso = new Date().toISOString();
  out.updated_at = nowIso;

  // optional lifecycle stamps
  if (existing.status !== out.status) {
    if (out.status === "contacted" && !out.contacted_at) out.contacted_at = nowIso;
    if ((out.status === "closed" || out.status === "booked") && !out.closed_at) {
      out.closed_at = nowIso;
    }
  }

  return out;
}

export default async (req, context) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  if (req.method !== "POST" && req.method !== "PATCH") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  // Require Bearer token + verified identity user
  const jwt = requireJwt(req, context);
  if (!jwt.ok) return json(jwt.status, { ok: false, error: jwt.error });

  // Enforce admin allowlist/role
  const admin = requireAdmin(context);
  if (!admin.ok) return json(admin.status, { ok: false, error: admin.error });

  const body = await readJsonSafe(req);
  if (!body || typeof body !== "object") return json(400, { ok: false, error: "Invalid JSON body" });

  const id = body.id;
  if (!assertLeadKey(id)) return json(400, { ok: false, error: "Invalid lead id" });

  const patch = coercePatch(body);

  // Pre-validate status if present
  if (patch.status != null) {
    const s = normalizeStatus(patch.status);
    if (!VALID_STATUSES.has(s)) {
      return json(400, {
        ok: false,
        error: `Invalid status. Must be one of: ${Array.from(VALID_STATUSES).join(", ")}`,
      });
    }
  }

  const store = getLeadsStore();
  const existing = await store.get(id, { type: "json" });
  if (!existing) return json(404, { ok: false, error: "Lead not found" });

  let updated;
  try {
    updated = applyPatch(existing, patch);
  } catch (e) {
    return json(400, { ok: false, error: e?.message || "Invalid patch" });
  }

  await store.setJSON(id, updated, {
    metadata: {
      status: String(updated.status || "new"),
      archived: updated.archived ? "true" : "false",
    },
  });

  return json(200, { ok: true, lead: updated });
};
