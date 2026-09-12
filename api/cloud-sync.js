// /api/cloud-sync.js — Cloud storage sync for BaceTech
// Handles OAuth flows and file uploads for Google Drive, OneDrive, Dropbox, S3, GCP, WebDAV

import { applyRateLimit } from './_rate-limit.js';

const SUPABASE_URL = process.env.SUPABASE_URL || "https://rzdoeehbpdgjxtfbbmwp.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PROVIDERS = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.file",
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },
  onedrive: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "Files.ReadWrite.All offline_access",
    clientId: process.env.ONEDRIVE_CLIENT_ID,
    clientSecret: process.env.ONEDRIVE_CLIENT_SECRET,
  },
  dropbox: {
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropbox.com/oauth2/token",
    clientId: process.env.DROPBOX_APP_KEY,
    clientSecret: process.env.DROPBOX_APP_SECRET,
  }
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Rate limit: 30 requests per minute per IP
  // OAuth flows + file uploads shouldn't spike above this
  if (!applyRateLimit(req, res, 'cloud-sync', 30)) return;

  const { action } = req.query;

  // Base URL to build OAuth redirect URIs from. Must match what is registered
  // in each provider's console. Set CLOUD_REDIRECT_BASE in Vercel (e.g.
  // https://pillier.com.br); otherwise we derive it from the incoming request.
  const appBase = (process.env.CLOUD_REDIRECT_BASE
    || (req.headers.origin)
    || ('https://' + (req.headers.host || 'pillier.com.br'))).replace(/\/$/, '');

  try {
    // ── GET AUTH URL (start OAuth flow) ──
    if (action === "auth-url") {
      const { provider, company_id } = req.body || JSON.parse(await getBody(req));
      const p = PROVIDERS[provider];
      if (!p) return res.status(400).json({ error: "Unknown provider" });
      if (!p.clientId) return res.status(400).json({ error: provider + " not configured (missing client ID in env)" });

      // URL-safe base64 (base64url) — standard base64's +,/,= get corrupted when
      // Google returns `state` in the redirect URL (+ becomes a space).
      const state = Buffer.from(JSON.stringify({ provider, company_id })).toString("base64url");
      const redirectUri = `${appBase}/api/cloud-sync?action=callback`;
      const params = new URLSearchParams({
        client_id: p.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: p.scope || "",
        state,
        access_type: "offline",
        prompt: "consent",
      });
      if (provider === "dropbox") params.set("token_access_type", "offline");
      return res.status(200).json({ url: p.authUrl + "?" + params.toString() });
    }

    // ── OAUTH CALLBACK ──
    if (action === "callback") {
      const code = req.query.code;
      const stateRaw = req.query.state;
      if (req.query.error) return res.redirect(302, appBase + "/#cloud-error=" + encodeURIComponent(req.query.error));
      if (!code || !stateRaw) return res.redirect(302, appBase + "/#cloud-error=missing_code");
      // Decode state robustly: base64url, else standard base64 with the +→space fix.
      let parsed = null;
      try { parsed = JSON.parse(Buffer.from(stateRaw, "base64url").toString()); }
      catch (e) { try { parsed = JSON.parse(Buffer.from(String(stateRaw).replace(/ /g, "+"), "base64").toString()); } catch (e2) { parsed = null; } }
      if (!parsed || !parsed.provider) return res.redirect(302, appBase + "/#cloud-error=bad_state");
      const provider = parsed.provider, company_id = parsed.company_id;
      const p = PROVIDERS[provider];
      if (!p) return res.redirect(302, appBase + "/#cloud-error=unknown_provider");
      if (!p.clientSecret) return res.redirect(302, appBase + "/#cloud-error=missing_client_secret");
      const redirectUri = `${appBase}/api/cloud-sync?action=callback`;

      try {
        const tokenRes = await fetch(p.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
        });
        const tokens = await tokenRes.json();
        if (!tokens || tokens.error || !tokens.access_token) {
          return res.redirect(302, appBase + "/#cloud-error=" + encodeURIComponent((tokens && (tokens.error_description || tokens.error)) || "token_exchange_failed"));
        }
        await saveTokens(company_id, provider, tokens);
        return res.redirect(302, appBase + "/#cloud-connected=" + provider);
      } catch (e) {
        return res.redirect(302, appBase + "/#cloud-error=" + encodeURIComponent(e.message || "callback_error"));
      }
    }

    // ── SAVE CREDENTIALS (S3, GCP, WebDAV — no OAuth) ──
    if (action === "save-credentials") {
      const { company_id, provider, credentials } = req.body || JSON.parse(await getBody(req));
      await saveTokens(company_id, provider, { credentials, type: "static" });
      return res.status(200).json({ ok: true });
    }

    // ── CHECK CONNECTION STATUS ──
    if (action === "status") {
      const { company_id } = req.body || JSON.parse(await getBody(req));
      const connections = await getConnections(company_id);
      return res.status(200).json({ connections });
    }

    // ── SYNC FILE (upload incident to cloud) ──
    if (action === "sync") {
      const { company_id, provider, project, category, tab, docType, filename, content: fileContent, contentType, photoBase64, binBase64, binName, binMime } = req.body || JSON.parse(await getBody(req));

      const conn = await getConnection(company_id, provider);
      if (!conn) return res.status(400).json({ error: "Not connected" });

      let tokens = conn.tokens;

      // Refresh token if expired (OAuth providers)
      if (tokens.access_token && tokens.expires_at && Date.now() > tokens.expires_at) {
        tokens = await refreshToken(provider, tokens);
        await saveTokens(company_id, provider, tokens);
      }

      // Unified per-site folder architecture:
      //   Pillier / <Construction Site> / Meus arquivos / <Category> / <file>
      //   Pillier / <Construction Site> / Plantas & Documentos / <Plantas | Laudos & Especificações> / <file>
      const folderPath = buildFolderPath(project, tab, category, docType, filename, contentType);

      // Upload based on provider — return the real error (200 body) so the app can surface it.
      let result;
      try {
        if (provider === "google") result = await uploadGoogleDrive(tokens, folderPath, filename, fileContent, contentType, photoBase64);
        else if (provider === "onedrive") result = await uploadOneDrive(tokens, folderPath, filename, fileContent, contentType, photoBase64);
        else if (provider === "dropbox") result = await uploadDropbox(tokens, folderPath, filename, fileContent, photoBase64);
        else if (provider === "s3") result = await uploadS3(tokens.credentials, folderPath, filename, fileContent, contentType, photoBase64);
        else if (provider === "gcp") result = await uploadGCP(tokens.credentials, folderPath, filename, fileContent, contentType, photoBase64);
        else if (provider === "webdav") result = await uploadWebDAV(tokens.credentials, folderPath, filename, fileContent, photoBase64);

        // Mirror the ORIGINAL uploaded file (PDF / blueprint / photo) alongside the summary.
        if (binBase64 && binName) {
          await uploadBinary(provider, tokens, folderPath, binName, binMime || "application/octet-stream", binBase64);
        }
      } catch (e) {
        return res.status(200).json({ ok: false, error: "" + (e.message || e), folderPath, provider });
      }

      return res.status(200).json({ ok: true, folderPath, result });
    }

    // ── DISCONNECT ──
    if (action === "disconnect") {
      const { company_id, provider } = req.body || JSON.parse(await getBody(req));
      await deleteConnection(company_id, provider);
      return res.status(200).json({ ok: true });
    }

    // ── APP INTEGRATIONS (Customization) ─────────────────────────────────
    // Stored in the same cloud_connections table under a provider key
    // prefixed with "app:" (e.g. app:slack). Config is a webhook URL or API key.

    // Save/update an app integration
    if (action === "save-integration") {
      const { company_id, app, config } = req.body || JSON.parse(await getBody(req));
      if (!company_id || !app) return res.status(400).json({ error: "Missing company_id or app" });
      await saveTokens(company_id, "app:" + app, { config: config || {}, type: "integration" });
      return res.status(200).json({ ok: true });
    }

    // List connected app integrations
    if (action === "list-integrations") {
      const { company_id } = req.body || JSON.parse(await getBody(req));
      const all = await getConnections(company_id);
      const apps = (all || [])
        .filter((c) => c.provider && c.provider.indexOf("app:") === 0)
        .map((c) => ({ app: c.provider.slice(4), updated_at: c.updated_at }));
      return res.status(200).json({ apps });
    }

    // Remove an app integration
    if (action === "delete-integration") {
      const { company_id, app } = req.body || JSON.parse(await getBody(req));
      await deleteConnection(company_id, "app:" + app);
      return res.status(200).json({ ok: true });
    }

    // Push a single test message to ONE connected app (used by the "Send test" button).
    if (action === "notify") {
      const { company_id, app, incident } = req.body || JSON.parse(await getBody(req));
      const conn = await getConnection(company_id, "app:" + app);
      const config = conn && conn.tokens && conn.tokens.config;
      if (!config) return res.status(400).json({ error: "Not connected: " + app });
      const inc = normalizeIncident(incident);
      const out = await dispatchToApp(app, config, inc);
      console.log("[integrations] test notify", app, out.ok ? "OK" : "FAILED", out.error || "");
      return res.status(200).json(out);
    }

    // Fan-out an incident to EVERY connected app (Slack, Teams, WhatsApp, Google
    // Calendar, Procore, Autodesk, Jira, Zapier). Called when a capture is saved.
    // All third-party requests happen here, server-side — no browser CORS.
    if (action === "dispatch") {
      const { company_id, incident } = req.body || JSON.parse(await getBody(req));
      if (!company_id) return res.status(400).json({ error: "Missing company_id" });
      const all = await getConnections(company_id, true);
      const apps = (all || []).filter((c) => c.provider && c.provider.indexOf("app:") === 0);
      const inc = normalizeIncident(incident);
      const results = {};
      await Promise.all(apps.map(async (c) => {
        const appId = c.provider.slice(4);
        const config = c.tokens && c.tokens.config;
        if (!config) { results[appId] = { ok: false, error: "no config" }; return; }
        try {
          const out = await dispatchToApp(appId, config, inc);
          results[appId] = out;
          console.log("[integrations] dispatch", appId, out.ok ? "OK" : "FAILED", out.error || "");
        } catch (e) {
          results[appId] = { ok: false, error: e.message };
          console.error("[integrations] dispatch", appId, "THREW", e.message);
        }
      }));
      const sent = Object.keys(results).filter((k) => results[k].ok).length;
      console.log("[integrations] dispatch complete —", sent + "/" + apps.length, "delivered");
      return res.status(200).json({ ok: true, dispatched: sent, total: apps.length, results });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("cloud-sync error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ── App-integration dispatch (Slack / Teams / WhatsApp / GCal / Procore /
//    Autodesk / Jira / Zapier) ──────────────────────────────────────────────

// Normalize whatever the client sends into a stable incident shape.
export function normalizeIncident(raw) {
  raw = raw || {};
  const sevRaw = ("" + (raw.severity || raw.sev || "")).toLowerCase();
  const sevMap = { low: "Baixa", medium: "Média", high: "Alta", critical: "Crítica",
    faible: "Baixa", moyen: "Média", "élevé": "Alta", critique: "Crítica",
    baixa: "Baixa", "média": "Média", media: "Média", alta: "Alta", "crítica": "Crítica" };
  const emoji = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢", critique: "🔴", "élevé": "🟠", moyen: "🟡", faible: "🟢", "crítica": "🔴", alta: "🟠", "média": "🟡", baixa: "🟢" };
  return {
    title: ("" + (raw.title || "Incidente")).slice(0, 300),
    severity: sevMap[sevRaw] || raw.severity || "—",
    severityKey: sevRaw || "medium",
    severityEmoji: emoji[sevRaw] || "⚠️",
    category: ("" + (raw.category || raw.cat || "—")).slice(0, 120),
    project: ("" + (raw.project || "—")).slice(0, 200),
    description: ("" + (raw.description || raw.desc || "")).slice(0, 3000),
    action: ("" + (raw.action || "")).slice(0, 3000),
    user_name: ("" + (raw.user_name || raw.user || "Pillier")).slice(0, 120),
    photo_url: raw.photo_url || null,
    url: raw.app_url || raw.url || "https://pillier.com.br",
    at: raw.captured_at || new Date().toISOString(),
  };
}

// Plain-text summary reused by Slack fallback, Teams summary, WhatsApp and Zapier.
function incidentText(inc) {
  let t = inc.severityEmoji + " *" + inc.title + "*\n";
  t += "Severidade: " + inc.severity + "  |  Categoria: " + inc.category + "\n";
  t += "Obra: " + inc.project + "\n";
  if (inc.description) t += "\n" + inc.description + "\n";
  if (inc.action) t += "\nAção recomendada: " + inc.action + "\n";
  t += "\nRegistrado por " + inc.user_name + " · Pillier";
  return t;
}

async function postJSON(url, body, headers) {
  const r = await fetch(url, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: JSON.stringify(body),
  });
  let detail = "";
  if (!r.ok) { try { detail = (await r.text()).slice(0, 300); } catch (e) {} }
  return { ok: r.ok, status: r.status, detail };
}

// Route one incident to one app using its stored config. Returns {ok, error?}.
export async function dispatchToApp(app, config, inc) {
  config = config || {};
  try {
    if (app === "slack") return await dispatchSlack(config, inc);
    if (app === "teams") return await dispatchTeams(config, inc);
    if (app === "zapier") return await dispatchZapier(config, inc);
    if (app === "whatsapp") return await dispatchWhatsApp(config, inc);
    if (app === "jira") return await dispatchJira(config, inc);
    if (app === "gcal") return await dispatchGCal(config, inc);
    if (app === "procore") return await dispatchGeneric(config, inc, "procore");
    if (app === "autodesk") return await dispatchGeneric(config, inc, "autodesk");
    return { ok: false, error: "unknown app: " + app };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Slack — Block Kit message via Incoming Webhook.
async function dispatchSlack(config, inc) {
  if (!config.webhookUrl) return { ok: false, error: "no webhookUrl" };
  const fields = [
    { type: "mrkdwn", text: "*Severidade:*\n" + inc.severityEmoji + " " + inc.severity },
    { type: "mrkdwn", text: "*Categoria:*\n" + inc.category },
    { type: "mrkdwn", text: "*Obra:*\n" + inc.project },
    { type: "mrkdwn", text: "*Registrado por:*\n" + inc.user_name },
  ];
  const blocks = [
    { type: "header", text: { type: "plain_text", text: (inc.severityEmoji + " " + inc.title).slice(0, 150), emoji: true } },
    { type: "section", fields },
  ];
  if (inc.description) blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Descrição:*\n" + inc.description.slice(0, 2900) } });
  if (inc.action) blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Ação recomendada:*\n" + inc.action.slice(0, 2900) } });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Pillier · " + new Date(inc.at).toLocaleString("pt-BR") }] });
  const r = await postJSON(config.webhookUrl, { text: inc.severityEmoji + " " + inc.title + " — " + inc.project, blocks });
  return r.ok ? { ok: true } : { ok: false, error: "slack " + r.status + " " + r.detail };
}

// Teams — Adaptive Card (Workflows/Power Automate). Falls back to the legacy
// MessageCard format if the webhook rejects the modern payload.
async function dispatchTeams(config, inc) {
  if (!config.webhookUrl) return { ok: false, error: "no webhookUrl" };
  const facts = [
    { title: "Severidade", value: inc.severityEmoji + " " + inc.severity },
    { title: "Categoria", value: inc.category },
    { title: "Obra", value: inc.project },
    { title: "Registrado por", value: inc.user_name },
  ];
  const cardBody = [
    { type: "TextBlock", size: "Large", weight: "Bolder", text: inc.title, wrap: true },
    { type: "FactSet", facts },
  ];
  if (inc.description) cardBody.push({ type: "TextBlock", text: inc.description, wrap: true, spacing: "Medium" });
  if (inc.action) cardBody.push({ type: "TextBlock", text: "**Ação recomendada:** " + inc.action, wrap: true, isSubtle: true });
  const adaptive = {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard", version: "1.4",
        body: cardBody,
        actions: [{ type: "Action.OpenUrl", title: "Abrir no Pillier", url: inc.url }],
        msteams: { width: "Full" },
      },
    }],
  };
  let r = await postJSON(config.webhookUrl, adaptive);
  if (r.ok) return { ok: true };
  // Fallback: legacy Office 365 connector MessageCard.
  const messageCard = {
    "@type": "MessageCard", "@context": "http://schema.org/extensions",
    themeColor: "2cbeff", summary: inc.title,
    title: inc.severityEmoji + " " + inc.title,
    sections: [{ facts: facts.map((f) => ({ name: f.title, value: f.value })), text: inc.description || "", markdown: true }],
    potentialAction: [{ "@type": "OpenUri", name: "Abrir no Pillier", targets: [{ os: "default", uri: inc.url }] }],
  };
  const r2 = await postJSON(config.webhookUrl, messageCard);
  return r2.ok ? { ok: true } : { ok: false, error: "teams " + r.status + "/" + r2.status + " " + (r2.detail || r.detail) };
}

// Zapier / generic webhook — flat event payload any automation can map.
async function dispatchZapier(config, inc) {
  if (!config.webhookUrl) return { ok: false, error: "no webhookUrl" };
  const r = await postJSON(config.webhookUrl, {
    event: "incident.captured", source: "Pillier",
    title: inc.title, severity: inc.severity, severity_key: inc.severityKey,
    category: inc.category, project: inc.project,
    description: inc.description, recommended_action: inc.action,
    user_name: inc.user_name, photo_url: inc.photo_url, url: inc.url, captured_at: inc.at,
    summary: incidentText(inc),
  });
  return r.ok ? { ok: true } : { ok: false, error: "zapier " + r.status + " " + r.detail };
}

// WhatsApp Business Cloud API — one text message per recipient.
async function dispatchWhatsApp(config, inc) {
  const token = config.token || config.apiKey;
  if (!token || !config.phoneNumberId) {
    // Allow a webhook bridge as an alternative.
    if (config.webhookUrl) return dispatchZapier(config, inc);
    return { ok: false, error: "missing token/phoneNumberId" };
  }
  const recipients = ("" + (config.recipients || "")).split(/[,\s;]+/).map((s) => s.trim().replace(/[^0-9]/g, "")).filter(Boolean);
  if (!recipients.length) return { ok: false, error: "no recipients" };
  const url = "https://graph.facebook.com/v19.0/" + config.phoneNumberId + "/messages";
  let okAny = false, err = "";
  for (const to of recipients) {
    const r = await postJSON(url, { messaging_product: "whatsapp", to, type: "text", text: { body: incidentText(inc).replace(/\*/g, "*") } }, { Authorization: "Bearer " + token });
    if (r.ok) okAny = true; else err = "whatsapp " + r.status + " " + r.detail;
  }
  return okAny ? { ok: true } : { ok: false, error: err };
}

// Jira Cloud — create an issue via Basic auth (email:apiToken). No OAuth needed.
async function dispatchJira(config, inc) {
  if (config.webhookUrl && !config.apiToken) return dispatchZapier(config, inc);
  const site = ("" + (config.site || "")).replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!site || !config.email || !config.apiToken || !config.projectKey) return { ok: false, error: "missing site/email/apiToken/projectKey" };
  const auth = Buffer.from(config.email + ":" + config.apiToken).toString("base64");
  // Atlassian Document Format body.
  const paras = [];
  const push = (label, val) => { if (val) paras.push({ type: "paragraph", content: [{ type: "text", text: label + ": ", marks: [{ type: "strong" }] }, { type: "text", text: val }] }); };
  push("Obra", inc.project); push("Severidade", inc.severity); push("Categoria", inc.category);
  if (inc.description) paras.push({ type: "paragraph", content: [{ type: "text", text: inc.description }] });
  push("Ação recomendada", inc.action); push("Registrado por", inc.user_name);
  const body = {
    fields: {
      project: { key: config.projectKey },
      summary: ("[" + inc.severity + "] " + inc.title).slice(0, 250),
      issuetype: { name: config.issueType || "Task" },
      description: { type: "doc", version: 1, content: paras.length ? paras : [{ type: "paragraph", content: [{ type: "text", text: inc.title }] }] },
    },
  };
  const r = await postJSON("https://" + site + "/rest/api/3/issue", body, { Authorization: "Basic " + auth, Accept: "application/json" });
  return r.ok ? { ok: true } : { ok: false, error: "jira " + r.status + " " + r.detail };
}

// Google Calendar — create an event. Prefers a webhook bridge (no OAuth secret);
// supports a direct OAuth access token for advanced setups.
async function dispatchGCal(config, inc) {
  if (config.webhookUrl && !config.accessToken) return dispatchZapier(config, inc);
  if (!config.accessToken) return { ok: false, error: "missing accessToken (or set a webhookUrl bridge)" };
  const calId = config.calendarId || "primary";
  const start = new Date(inc.at);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const body = {
    summary: "[Pillier] " + inc.title,
    description: incidentText(inc) + "\n\n" + inc.url,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };
  const r = await postJSON("https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) + "/events", body, { Authorization: "Bearer " + config.accessToken });
  return r.ok ? { ok: true } : { ok: false, error: "gcal " + r.status + " " + r.detail };
}

// Procore / Autodesk — no generic incoming webhook and OAuth needs a registered
// app + refresh dance we can't complete server-side without the customer's client
// secret. The reliable, verified path is a webhook bridge (Zapier/Make/Power
// Automate → Procore Observation / ACC Issue). A direct REST endpoint is also
// honored if the customer supplies { apiUrl, accessToken }.
async function dispatchGeneric(config, inc, name) {
  if (config.webhookUrl) return dispatchZapier(config, inc);
  if (config.apiUrl && config.accessToken) {
    const r = await postJSON(config.apiUrl, {
      title: inc.title, severity: inc.severity, category: inc.category,
      project: inc.project, description: inc.description, recommended_action: inc.action,
      user_name: inc.user_name, url: inc.url, captured_at: inc.at, source: "Pillier",
    }, { Authorization: "Bearer " + config.accessToken });
    return r.ok ? { ok: true } : { ok: false, error: name + " " + r.status + " " + r.detail };
  }
  return { ok: false, error: name + ": set a webhookUrl (recommended) or apiUrl+accessToken" };
}

// ── Helper functions ─────────────────────────────────────────────────────

function sanitize(s) { return (s || "general").replace(/[^a-zA-Z0-9\-_ ]/g, "").substring(0, 50); }

// Folder-name cleaner that PRESERVES accents & "&" (so folders read "Elétrica",
// "Plantas & Documentos", "Segurança"), only stripping path/filesystem-unsafe chars.
function sanitizeFolder(s) {
  return (("" + (s || "")).replace(/[\/\\\r\n\t]+/g, " ").replace(/[<>:"|?* -]/g, "").replace(/\.+$/, "").trim().substring(0, 60)) || "Geral";
}

// Decide which "Plantas & Documentos" subfolder a document belongs in.
function docSubfolder(filename, contentType) {
  const n = ("" + (filename || "")).toLowerCase();
  const ct = "" + (contentType || "");
  if (/\.(dwg|dxf|ifc|rvt)$/.test(n) || ct.indexOf("image") === 0 || /planta|plan|blueprint|layout|desenho|arquitet/.test(n)) return "Plantas";
  return "Laudos & Especificações";
}

// Build the destination folder path for a synced file.
//   tab "docs"  → Plantas & Documentos
//   otherwise   → Meus arquivos / <category>
function buildFolderPath(project, tab, category, docType, filename, contentType) {
  const site = sanitizeFolder(project);
  if (tab === "docs" || tab === "documents") {
    const sub = docType ? sanitizeFolder(docType) : docSubfolder(filename, contentType);
    return "Pillier/" + site + "/Plantas & Documentos/" + sub;
  }
  return "Pillier/" + site + "/Meus arquivos/" + sanitizeFolder(category || "Documentação");
}

// JSON with non-ASCII escaped to \uXXXX — required for Dropbox-API-Arg headers,
// which must be pure ASCII even when paths contain accents.
function asciiHeader(obj) {
  return JSON.stringify(obj).replace(/[-￿]/g, function (c) { return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4); });
}

// Standard project folder structure. Maps an incident category (any language)
// or an explicit section to one of the fixed top-level folders.
const CLOUD_SECTIONS = {
  structure: "Structure", estrutura: "Structure", structurel: "Structure",
  incident: "Incidents", incidente: "Incidents", incidents: "Incidents",
  report: "Reports", reports: "Reports", relatorio: "Reports", rapport: "Reports",
  media: "Media", midia: "Media", photo: "Media", photos: "Media", foto: "Media",
  document: "Documents", documents: "Documents", documento: "Documents", documentos: "Documents",
};
function sectionFor(category, explicit) {
  if (explicit) {
    const e = ("" + explicit).toLowerCase();
    return CLOUD_SECTIONS[e] || sanitize(explicit);
  }
  const key = ("" + (category || "")).toLowerCase();
  return CLOUD_SECTIONS[key] || "Incidents";
}

function getBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => data += chunk);
    req.on("end", () => resolve(data));
  });
}

async function supabaseRequest(method, path, body) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "return=representation" : undefined,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function saveTokens(companyId, provider, tokens) {
  // Add expiry timestamp
  if (tokens.expires_in) tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  // Upsert
  const existing = await supabaseRequest("GET", `cloud_connections?company_id=eq.${companyId}&provider=eq.${provider}`);
  if (existing && existing.length > 0) {
    await supabaseRequest("PATCH", `cloud_connections?company_id=eq.${companyId}&provider=eq.${provider}`, { tokens, updated_at: new Date().toISOString() });
  } else {
    await supabaseRequest("POST", "cloud_connections", { company_id: companyId, provider, tokens, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
}

export async function getConnections(companyId, withTokens) {
  const select = withTokens ? "provider,tokens,updated_at" : "provider,updated_at";
  return supabaseRequest("GET", `cloud_connections?company_id=eq.${companyId}&select=${select}`);
}

async function getConnection(companyId, provider) {
  const r = await supabaseRequest("GET", `cloud_connections?company_id=eq.${companyId}&provider=eq.${provider}`);
  return r && r[0];
}

async function deleteConnection(companyId, provider) {
  await supabaseRequest("DELETE", `cloud_connections?company_id=eq.${companyId}&provider=eq.${provider}`);
}

async function refreshToken(provider, tokens) {
  const p = PROVIDERS[provider];
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const newTokens = await res.json();
  return { ...tokens, ...newTokens, expires_at: Date.now() + (newTokens.expires_in || 3600) * 1000 };
}

// ── Google Drive upload ──
async function uploadGoogleDrive(tokens, folderPath, filename, content, contentType, photoBase64) {
  // Build (or find) the full nested folder path; throws if a folder can't be created.
  const parentId = await driveEnsureFolder(tokens, folderPath);
  // Upload report file
  const boundary = "bacetech_boundary";
  const metadata = JSON.stringify({ name: filename, parents: [parentId] });
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${contentType || "text/plain"}\r\n\r\n${content}\r\n--${boundary}--`;
  const uploadRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const uploaded = await uploadRes.json();
  // Upload photo if provided
  if (photoBase64) {
    const photoData = photoBase64.split(",")[1] || photoBase64;
    const photoMeta = JSON.stringify({ name: filename.replace(".txt", ".jpg"), parents: [parentId] });
    const photoBody = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${photoMeta}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Transfer-Encoding: base64\r\n\r\n${photoData}\r\n--${boundary}--`;
    await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": `multipart/related; boundary=${boundary}` },
      body: photoBody,
    });
  }
  return { fileId: uploaded.id };
}

// ── OneDrive upload ──
async function uploadOneDrive(tokens, folderPath, filename, content, contentType, photoBase64) {
  const path = folderPath.split("/").map(encodeURIComponent).join("/"); // encode accents & "&" per segment
  const encName = encodeURIComponent(filename);
  await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${path}/${encName}:/content`, {
    method: "PUT",
    headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": contentType || "text/plain" },
    body: content,
  });
  if (photoBase64) {
    const photoData = Buffer.from((photoBase64.split(",")[1] || photoBase64), "base64");
    await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${path}/${encodeURIComponent(filename.replace(".txt", ".jpg"))}:/content`, {
      method: "PUT",
      headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": "image/jpeg" },
      body: photoData,
    });
  }
  return { ok: true };
}

// ── Dropbox upload ──
async function uploadDropbox(tokens, folderPath, filename, content, photoBase64) {
  await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + tokens.access_token,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": asciiHeader({ path: "/" + folderPath + "/" + filename, mode: "overwrite", autorename: true }),
    },
    body: content,
  });
  if (photoBase64) {
    const photoData = Buffer.from((photoBase64.split(",")[1] || photoBase64), "base64");
    await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + tokens.access_token,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": asciiHeader({ path: "/" + folderPath + "/" + filename.replace(".txt", ".jpg"), mode: "overwrite", autorename: true }),
      },
      body: photoData,
    });
  }
  return { ok: true };
}

// ── AWS S3 upload ──
async function uploadS3(creds, folderPath, filename, content, contentType, photoBase64) {
  // Uses pre-signed URL approach — client provides bucket, region, access key, secret
  // For simplicity, we use the AWS SDK pattern
  const { bucket, region, accessKeyId, secretAccessKey } = creds;
  // Note: For production, use AWS SDK. This is a simplified version.
  return { ok: true, note: "S3 upload requires AWS SDK — install in production" };
}

// ── GCP Cloud Storage upload ──
async function uploadGCP(creds, folderPath, filename, content, contentType, photoBase64) {
  const { bucket, serviceAccountKey } = creds;
  return { ok: true, note: "GCP upload requires google-cloud/storage SDK" };
}

// ── WebDAV upload (on-premise) ──
async function uploadWebDAV(creds, folderPath, filename, content, photoBase64) {
  const { url, username, password } = creds;
  const auth = Buffer.from(username + ":" + password).toString("base64");
  // Create folders
  const parts = folderPath.split("/");
  let currentPath = url.replace(/\/$/, "");
  for (const folder of parts) {
    currentPath += "/" + encodeURIComponent(folder);
    await fetch(currentPath, { method: "MKCOL", headers: { Authorization: "Basic " + auth } }).catch(() => {});
  }
  // Upload file
  await fetch(currentPath + "/" + encodeURIComponent(filename), {
    method: "PUT",
    headers: { Authorization: "Basic " + auth, "Content-Type": "text/plain" },
    body: content,
  });
  if (photoBase64) {
    const photoData = Buffer.from((photoBase64.split(",")[1] || photoBase64), "base64");
    await fetch(currentPath + "/" + encodeURIComponent(filename.replace(".txt", ".jpg")), {
      method: "PUT",
      headers: { Authorization: "Basic " + auth, "Content-Type": "image/jpeg" },
      body: photoData,
    });
  }
  return { ok: true };
}

// ── Original-file mirroring (binary): upload the raw PDF/blueprint/photo ──────
async function driveEnsureFolder(tokens, folderPath) {
  const parts = folderPath.split("/").filter(Boolean);
  let parentId = "root";
  for (const folder of parts) {
    // Properly URL-encode the whole query (names contain spaces / accents / "&").
    const q = `name='${folder.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const s = await fetch("https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id)&q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + tokens.access_token } });
    const sd = await s.json();
    if (sd && sd.files && sd.files.length > 0) { parentId = sd.files[0].id; continue; }
    const c = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: folder, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
    });
    const cj = await c.json();
    if (!cj || !cj.id) throw new Error("Drive folder create failed for '" + folder + "': " + JSON.stringify(cj && cj.error || cj));
    parentId = cj.id;
  }
  return parentId;
}

async function uploadBinary(provider, tokens, folderPath, name, mime, base64) {
  const data = base64.indexOf(",") > -1 ? base64.split(",")[1] : base64;
  if (provider === "google") {
    const parentId = await driveEnsureFolder(tokens, folderPath);
    const boundary = "pillier_bin_boundary";
    const meta = JSON.stringify({ name, parents: [parentId] });
    const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\nContent-Transfer-Encoding: base64\r\n\r\n${data}\r\n--${boundary}--`;
    const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", { method: "POST", headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    const j = await r.json(); return { fileId: j.id };
  }
  if (provider === "onedrive") {
    const path = folderPath.split("/").map(encodeURIComponent).join("/");
    await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${path}/${encodeURIComponent(name)}:/content`, { method: "PUT", headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": mime }, body: Buffer.from(data, "base64") });
    return { ok: true };
  }
  if (provider === "dropbox") {
    await fetch("https://content.dropboxapi.com/2/files/upload", { method: "POST", headers: { Authorization: "Bearer " + tokens.access_token, "Content-Type": "application/octet-stream", "Dropbox-API-Arg": asciiHeader({ path: "/" + folderPath + "/" + name, mode: "overwrite", autorename: true }) }, body: Buffer.from(data, "base64") });
    return { ok: true };
  }
  if (provider === "webdav") {
    const creds = tokens.credentials; const auth = Buffer.from(creds.username + ":" + creds.password).toString("base64");
    let cur = creds.url.replace(/\/$/, "");
    for (const f of folderPath.split("/")) { cur += "/" + encodeURIComponent(f); await fetch(cur, { method: "MKCOL", headers: { Authorization: "Basic " + auth } }).catch(() => {}); }
    await fetch(cur + "/" + encodeURIComponent(name), { method: "PUT", headers: { Authorization: "Basic " + auth, "Content-Type": mime }, body: Buffer.from(data, "base64") });
    return { ok: true };
  }
  return { ok: false, note: "binary mirror not supported for " + provider };
}
