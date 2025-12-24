// netlify/functions/leads-list.js
import {
  json,
  handleOptions,
  getLeadsStore,
  requireJwt,
  requireAdmin,
  mapLimit,
} from "./_utils.js";

export default async (req, context) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  if (req.method !== "GET") return json(405, { ok: false, error: "Method not allowed" });

  // Require Bearer token + verified identity user
  const jwt = requireJwt(req, context);
  if (!jwt.ok) return json(jwt.status, { ok: false, error: jwt.error });

  // Enforce admin allowlist/role
  const admin = requireAdmin(context);
  if (!admin.ok) return json(admin.status, { ok: false, error: admin.error });

  const url = new URL(req.url);
  const status = (url.searchParams.get("status") || "").trim().toLowerCase();
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();

  // archived filter: archived=true/false/all (default false)
  const archivedParam = (url.searchParams.get("archived") || "").trim().toLowerCase();
  const archivedMode = archivedParam || "false";

  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || "50")));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || "0"));

  const store = getLeadsStore();
  const { blobs } = await store.list({ prefix: "leads/" });

  // Newest-first ordering by key ISO timestamp prefix
  const keys = blobs.map((b) => b.key).sort((a, b) => (a > b ? -1 : 1));

  const records = await mapLimit(keys, 20, async (key) => {
    return await store.get(key, { type: "json" });
  });

  const filtered = records
    .filter(Boolean)
    .filter((r) => {
      if (archivedMode === "all") return true;
      if (archivedMode === "true") return Boolean(r.archived) === true;
      // default / "false"
      return Boolean(r.archived) === false;
    })
    .filter((r) => (status ? String(r.status || "").toLowerCase() === status : true))
    .filter((r) => {
      if (!q) return true;
      const hay = [
        r?.lead?.name,
        r?.lead?.phone,
        r?.lead?.instagram,
        r?.lead?.service,
        r?.lead?.availability,
        r?.lead?.notes,
        r?.status,
        r?.internal_notes,
        ...(Array.isArray(r?.tags) ? r.tags : []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });

  const page = filtered.slice(offset, offset + limit);

  return json(200, { ok: true, total: filtered.length, offset, limit, leads: page });
};
