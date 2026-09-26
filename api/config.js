// ═══════════════════════════════════════════════════════════════════
// /api/config.js — dual purpose (kept as one function to stay within the
// Vercel plan's serverless-function limit):
//
//   GET  → serves public frontend config (Turnstile SITE key) as JS.
//          Loaded early in <head>:  <script src="/api/config.js"></script>
//          Sets: window.PILLIER_CONFIG = { turnstileSiteKey: '...' }
//
//   POST → captures a Resources ebook download lead: stores it in Supabase
//          (service key, bypasses RLS) AND emails a notification via Resend.
//          Best-effort + non-blocking — the visitor's download never waits.
//
// SETUP (Vercel → Settings → Environment Variables):
//   TURNSTILE_SITE_KEY    (existing — Cloudflare Turnstile site key)
//   SUPABASE_URL          (existing)
//   SUPABASE_SERVICE_KEY  (existing)
//   RESEND_API_KEY        (NEW — https://resend.com, "Sending access" key)
//   LEAD_NOTIFY_TO        (optional — inbox to alert; default dyken@pillier.com.br)
//   LEAD_NOTIFY_FROM      (optional — verified sender; default noreply@pillier.com.br)
//   ZOHO_WTL_URL          (optional — Zoho Web-to-Lead action URL, e.g. https://crm.zoho.eu/crm/WebToLeadForm)
//   ZOHO_WTL_ID           (optional — Web-to-Lead hidden field xnQsjsdp)
//   ZOHO_WTL_TOKEN        (optional — Web-to-Lead hidden field xmIwtLD)
//   ZOHO_WTL_RETURN       (optional — redirect target after submit; default /recursos)
// ═══════════════════════════════════════════════════════════════════

import { applyRateLimit } from './_rate-limit.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rzdoeehbpdgjxtfbbmwp.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const NOTIFY_TO = process.env.LEAD_NOTIFY_TO || 'dyken@pillier.com.br';
const NOTIFY_FROM = process.env.LEAD_NOTIFY_FROM || 'Pillier <noreply@pillier.com.br>';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'POST') return handleLead(req, res);

  // ---- GET: public frontend config ----
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  const turnstileSiteKey = (process.env.TURNSTILE_SITE_KEY || '').replace(/[^\w-]/g, '');
  return res.status(200).send('window.PILLIER_CONFIG = { turnstileSiteKey: "' + turnstileSiteKey + '" };');
}

// ---- POST: resources download lead ----
async function handleLead(req, res) {
  if (!applyRateLimit(req, res, 'lead', 30)) return;
  try {
    const body = req.body || JSON.parse(await getBody(req));
    const name = str(body.name).slice(0, 120);
    const email = str(body.email).slice(0, 160).toLowerCase();
    const company = str(body.company).slice(0, 160);
    const report_id = body.report_id != null ? String(body.report_id).slice(0, 12) : '';
    const report_title = str(body.report_title).slice(0, 200);
    const lang = str(body.lang).slice(0, 8);
    const source = str(body.source || 'resources').slice(0, 40);

    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'invalid_lead' });
    }

    const ip = str(req.headers['x-forwarded-for']).split(',')[0].trim();
    const ua = str(req.headers['user-agent']).slice(0, 300);

    // 1) Store the lead (service key bypasses RLS).
    let stored = false, storeErr = '';
    if (!SERVICE_KEY) { storeErr = 'no_service_key'; }
    else {
      const insert = (row) => fetch(SUPABASE_URL + '/rest/v1/leads', {
        method: 'POST',
        headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      try {
        const r = await insert({ name, email, company, report_id, report_title, lang, source, ip, user_agent: ua });
        stored = r.ok;
        if (!r.ok) {
          const t = await r.text();
          storeErr = r.status + ': ' + t.slice(0, 300);
          // Schema drift (e.g. table missing the ip/user_agent columns) → retry with core columns only,
          // so a lead is never dropped just because an optional column is absent.
          if (/Could not find the '.*' column/.test(t)) {
            const r2 = await insert({ name, email, company, report_id, report_title, lang, source });
            stored = r2.ok;
            storeErr = r2.ok ? '' : 'retry ' + r2.status + ': ' + (await r2.text()).slice(0, 200);
          }
          if (!stored) console.error('[lead] supabase insert failed', storeErr);
        }
      } catch (e) { storeErr = 'exception: ' + e.message; console.error('[lead] supabase error', e.message); }
    }

    // 2) Notify by email.
    let emailed = false;
    if (RESEND_KEY) {
      try {
        const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
        const html =
          '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a2b33;line-height:1.6">' +
          '<h2 style="margin:0 0 12px;color:#0a95d6">Novo download de relatório</h2>' +
          '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
          row('Nome', esc(name)) + row('E-mail', '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>') +
          row('Empresa', esc(company) || '—') + row('Relatório', esc(report_title || report_id) || '—') +
          row('Idioma', esc(lang) || '—') + row('Origem', esc(source)) + row('Quando', esc(when)) +
          '</table><p style="margin-top:16px;color:#6b7c84;font-size:12px">Enviado automaticamente pela página Recursos da Pillier.</p></div>';
        const er = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], reply_to: email, subject: 'Novo lead: ' + (report_title || 'Relatório') + ' — ' + name, html }),
        });
        emailed = er.ok;
        if (!er.ok) console.error('[lead] resend failed', er.status, (await er.text()).slice(0, 200));
      } catch (e) { console.error('[lead] resend error', e.message); }
    }

    // 3) Push to Zoho CRM via Web-to-Lead (no OAuth needed). Non-blocking.
    let zoho = false, zohoErr = '';
    const ZWTL_URL = process.env.ZOHO_WTL_URL;      // e.g. https://crm.zoho.eu/crm/WebToLeadForm
    const ZWTL_ID = process.env.ZOHO_WTL_ID;        // hidden field: xnQsjsdp
    const ZWTL_TOKEN = process.env.ZOHO_WTL_TOKEN;  // hidden field: xmIwtLD
    if (ZWTL_URL && ZWTL_ID && ZWTL_TOKEN) {
      try {
        const form = new URLSearchParams();
        form.set('xnQsjsdp', ZWTL_ID);
        form.set('xmIwtLD', ZWTL_TOKEN);
        form.set('actionType', 'TGVhZHM=');          // base64("Leads")
        form.set('returnURL', process.env.ZOHO_WTL_RETURN || 'https://pillier.com.br/recursos');
        form.set('Last Name', name || 'Lead');       // required by Zoho Leads
        form.set('Company', company || 'Não informado'); // required by Zoho Leads
        form.set('Email', email);
        form.set('Lead Source', 'Website - Ebook');
        form.set('Description', 'Baixou "' + (report_title || report_id) + '" (' + lang + ') · origem: ' + source);
        const zr = await fetch(ZWTL_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'manual' });
        zoho = zr.status >= 200 && zr.status < 400; // WebToLead redirects (3xx) to returnURL on success
        if (!zoho) { zohoErr = 'zoho ' + zr.status; console.error('[lead] zoho wtl failed', zr.status); }
      } catch (e) { zohoErr = 'exception: ' + e.message; console.error('[lead] zoho error', e.message); }
    }

    console.log('[lead]', email, '| stored:', stored, '| emailed:', emailed, '| zoho:', zoho, '|', report_title);
    return res.status(200).json({ ok: true, stored, emailed, zoho, store_error: storeErr || undefined, zoho_error: zohoErr || undefined });
  } catch (err) {
    console.error('[lead] error', err.message);
    return res.status(200).json({ ok: false, error: 'server_error' });
  }
}

function row(k, v) {
  return '<tr><td style="padding:4px 16px 4px 0;color:#6b7c84;font-weight:bold;vertical-align:top">' + esc(k) + '</td><td style="padding:4px 0;color:#1a2b33">' + v + '</td></tr>';
}
function str(v) { return (v === null || v === undefined) ? '' : String(v); }
function esc(s) { return str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function getBody(req) { return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d || '{}')); }); }
