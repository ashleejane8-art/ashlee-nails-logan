// netlify/functions/leads-create.js
import OpenAI from "openai";
import twilio from "twilio";

import {
  json,
  handleOptions,
  getLeadsStore,
  newLeadKey,
  readJsonSafe,
  sanitizeString,
  normalizePhone,
  normalizeInstagram,
  originFromReq,
  getClientIp,
  rateKeyForIp,
  isPayloadTooLarge,
} from "./_utils.js";

const BOOKING_SCRIPT = "To schedule, call Paul Mitchell Logan Guest Services at (435) 752-3599 or use their 'Book a Service' option online, and request Ashlee Christensen by name.";

function validatePayload(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid JSON body" };

  const name = sanitizeString(body.name || body.full_name, 80);
  const phone = normalizePhone(body.phone || body.mobile || body.phone_number);
  const instagram = normalizeInstagram(body.instagram || body.ig);

  if (!name) return { ok: false, error: "Missing name" };
  if (!phone && !instagram) return { ok: false, error: "Provide phone or instagram" };

  const service = sanitizeString(body.service || body.requested_service, 100);
  const availability = sanitizeString(body.availability || body.timeframe, 160);
  const notes = sanitizeString(body.notes || body.message || body.details, 1000);

  const contact_preference = sanitizeString(body.contact_preference, 40);
  const budget = sanitizeString(body.budget, 40);
  const length = sanitizeString(body.length, 40);
  const style = sanitizeString(body.style, 80);

  return {
    ok: true,
    lead: {
      name,
      phone,
      instagram,
      service,
      availability,
      notes,
      contact_preference,
      budget,
      length,
      style,
    },
  };
}

function fallbackDm(name) {
  const first = sanitizeString(name, 40) || "there";
  return (
    `Hi ${first} — thanks for reaching out. What style/length are you wanting, and what days/times work best? ` +
    `

${BOOKING_SCRIPT}`
  );
}

async function generateSuggestedDm(lead) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const model = process.env.OPENAI_MODEL || "gpt-5.2";
  const openai = new OpenAI({ apiKey });

    const instructions = [
    "You are Ashlee’s assistant for a nail business in Logan, Utah.",
    "Ashlee is a Paul Mitchell student and can only accept bookings through the Paul Mitchell clinic process right now.",
    "Write a short, professional, friendly Instagram DM (2–4 sentences).",
    "No emojis.",
    "Explain the clinic-only booking constraint and give a clear next step.",
    "Keep under 550 characters.",
    "Return only the DM text.",
    "Include this official booking method verbatim: " + BOOKING_SCRIPT,
    "Do not mention pricing.",
  ].join(" ");

  const input = [
    "Lead details:",
    "Booking script:",
    BOOKING_SCRIPT,
    `Name: ${lead.name}`,
    `Instagram: ${lead.instagram || "N/A"}`,
    `Phone: ${lead.phone || "N/A"}`,
    `Service: ${lead.service || "N/A"}`,
    `Availability: ${lead.availability || "N/A"}`,
    `Notes: ${lead.notes || "N/A"}`,
  ].join("\n");

  const resp = await openai.responses.create({ model, instructions, input });
  const text = (resp.output_text || "").trim();
  return text.length > 550 ? text.slice(0, 550) : text;
}

async function sendSmsToAshlee({ lead, suggested_dm, adminLink }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const to = process.env.ASHLEE_SMS_TO || "+12086509024";

  if (!sid || !token || !from || !to) {
    return { ok: false, error: "Twilio env vars missing" };
  }

  const client = twilio(sid, token);

  const lines = [];
  lines.push(`New nail lead: ${lead.name}`);
  if (lead.instagram) lines.push(`IG: ${lead.instagram}`);
  if (lead.phone) lines.push(`Phone: ${lead.phone}`);
  if (lead.service) lines.push(`Service: ${lead.service}`);
  if (lead.availability) lines.push(`Avail: ${lead.availability}`);
  if (lead.notes) lines.push(`Notes: ${lead.notes}`);
  if (suggested_dm) lines.push(`Suggested DM: ${suggested_dm}`);
  lines.push(`Booking: ${BOOKING_SCRIPT}`);
  lines.push(`Booking phone: (435) 752-3599`);
  if (adminLink) lines.push(`Admin: ${adminLink}`);

  await client.messages.create({ from, to, body: lines.join("\n") });
  return { ok: true };
}

export default async (req, context) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  // Basic payload size guard (pre-parse)
  if (isPayloadTooLarge(req, 10000)) {
    return json(413, { ok: false, error: "Payload too large" });
  }

  const body = await readJsonSafe(req);
  // Honeypot support: if body.hp is non-empty => reject
  if (body && typeof body === "object") {
    const hp = sanitizeString(body.hp, 200);
    if (hp) return json(400, { ok: false, error: "Spam detected" });
  }

  // Secondary payload size guard (post-parse)
  try {
    const approx = JSON.stringify(body || "").length;
    if (approx > 10000) return json(413, { ok: false, error: "Payload too large" });
  } catch {}

  const validated = validatePayload(body);
  if (!validated.ok) return json(400, { ok: false, error: validated.error });

  const store = getLeadsStore();
  const now = new Date();

  // Rate limit: per IP allow max 3 requests / 10 minutes (persisted in Blobs)
  const WINDOW_MS = 10 * 60 * 1000;
  const MAX_REQ = 3;
  const ip = getClientIp(req, context);
  if (ip) {
    const rk = rateKeyForIp(ip);
    if (rk) {
      try {
        const nowMs = now.getTime();
        const prev = await store.get(rk, { type: "json" });
        const windowStartMs = prev?.window_start_at ? Date.parse(prev.window_start_at) : 0;
        let count = Number(prev?.count || 0);
        const inWindow = windowStartMs && (nowMs - windowStartMs) < WINDOW_MS;
        if (!inWindow) {
          // reset window
          count = 0;
        }
        if (inWindow && count >= MAX_REQ) {
          return json(429, { ok: false, error: "Too many requests" });
        }
        const next = {
          window_start_at: inWindow ? new Date(windowStartMs).toISOString() : now.toISOString(),
          count: inWindow ? (count + 1) : 1,
          last_submit_at: now.toISOString(),
        };
        await store.setJSON(rk, next);
      } catch {
        // If rate limit read/write fails, continue (best effort)
      }
    }
  }

  const key = newLeadKey(now);

  const leadRecord = {
    id: key,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    status: "new",
    archived: false,
    lead: validated.lead,
    suggested_dm: "",
    internal_notes: "",
    tags: [],
    meta: {
      referrer: req.headers.get("referer") || "",
      user_agent: req.headers.get("user-agent") || "",
      ip: context?.ip || "",
    },
    booking: {
      constraint: "Paul Mitchell clinic only",
      location: "Logan, UT",
    },
  };

  // OpenAI (best-effort, exactly one call)
  try {
    leadRecord.suggested_dm = await generateSuggestedDm(leadRecord.lead);
    if (!leadRecord.suggested_dm) leadRecord.suggested_dm = fallbackDm(leadRecord.lead.name);
  } catch {
    leadRecord.suggested_dm = fallbackDm(leadRecord.lead.name);
  }

  // Always store the lead
  await store.setJSON(key, leadRecord, {
    metadata: { status: leadRecord.status, archived: "false" },
  });

  // Twilio SMS (best-effort)
  try {
    const origin = originFromReq(req);
    const adminLink = origin ? `${origin}/admin.html` : "";
    await sendSmsToAshlee({
      lead: leadRecord.lead,
      suggested_dm: leadRecord.suggested_dm,
      adminLink,
    });
  } catch {
    // swallow
  }

  return json(200, { ok: true, id: key, suggested_dm: leadRecord.suggested_dm });
};
