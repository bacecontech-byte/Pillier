// /api/lead.js — Resources ebook lead capture.
// Stores each download lead in Supabase (service key, bypasses RLS) AND emails
// a notification via Resend, so the team is alerted the moment someone
// downloads a report. Never blocks the visitor's download: the client fires
// this best-effort and always proceeds to the file.
//
// Env (Vercel → Project → Settings → Environment Variables):
//   SUPABASE_URL          (already set; falls back to the project URL)
//   SUPABASE_SERVICE_KEY  (already set — used by other /api functions)
//   RESEND_API_KEY        (NEW — from https://resend.com, free tier)
//   LEAD_NOTIFY_TO        (optional — where to send alerts; default contact@pillier.com.br)
//   LEAD_NOTIFY_FROM      (optional — verified sender; default Resend's test sender)

import { applyRateLimit } from './_rate-limit.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rzdoeehbpdgjxtfbbmwp.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const NOTIFY_TO = process.env.LEAD_NOTIFY_TO || 'contact@pillier.com.br';
const NOTIFY_FROM = process.env.LEAD_NOTIFY_FROM || 'Pillier Leads <onboarding@resend.dev>';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  // Light rate limit — a form submit, not an expensive call.
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

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ua = str(req.headers['user-agent']).slice(0, 300);

    // 1) Store the lead (best-effort; never blocks the notification/download).
    let stored = false;
    if (SERVICE_KEY) {
      try {
        const r = await fetch(SUPABASE_URL + '/rest/v1/leads', {
          method: 'POST',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: 'Bearer ' + SERVICE_KEY,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ name, email, company, report_id, report_title, lang, source, ip, user_agent: ua }),
        });
        stored = r.ok;
        if (!r.ok) console.error('[lead] supabase insert failed', r.status, (await r.text()).slice(0, 200));
      } catch (e) { console.error('[lead] supabase error', e.message); }
    }

    // 2) Notify by email (best-effort).
    let emailed = false;
    if (RESEND_KEY) {
      try {
        const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
        const html =
          '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a2b33;line-height:1.6">' +
          '<h2 style="margin:0 0 12px;color:#0a95d6">Novo download de relatório</h2>' +
          '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
          row('Nome', name) + row('E-mail', '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>') +
          row('Empresa', company || '—') + row('Relatório', report_title || report_id || '—') +
          row('Idioma', lang || '—') + row('Origem', source) + row('Quando', when) +
          '</table>' +
          '<p style="margin-top:16px;color:#6b7c84;font-size:12px">Enviado automaticamente pela página Recursos da Pillier.</p></div>';
        const er = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: NOTIFY_FROM,
            to: [NOTIFY_TO],
            reply_to: email,
            subject: 'Novo lead: ' + (report_title || 'Relatório') + ' — ' + name,
            html,
          }),
        });
        emailed = er.ok;
        if (!er.ok) console.error('[lead] resend failed', er.status, (await er.text()).slice(0, 200));
      } catch (e) { console.error('[lead] resend error', e.message); }
    }

    console.log('[lead]', email, '| stored:', stored, '| emailed:', emailed, '|', report_title);
    return res.status(200).json({ ok: true, stored, emailed });
  } catch (err) {
    console.error('[lead] error', err.message);
    // Still 200 so the client never blocks the download on our account.
    return res.status(200).json({ ok: false, error: 'server_error' });
  }
}

function row(k, v) {
  return '<tr><td style="padding:4px 16px 4px 0;color:#6b7c84;font-weight:bold;vertical-align:top">' + esc(k) +
    '</td><td style="padding:4px 0;color:#1a2b33">' + v + '</td></tr>';
}
function str(v) { return (v === null || v === undefined) ? '' : String(v); }
function esc(s) { return str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function getBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d || '{}')); });
}
