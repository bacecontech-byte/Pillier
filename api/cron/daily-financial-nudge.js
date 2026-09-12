// /api/cron/daily-financial-nudge.js
// End-of-day (17:30 site time) financial check-in.
//
// GET  (Vercel Cron): for every company with the nudge enabled, aggregates the
//      day's pending expenses and fans a "close the day" notice out to every
//      connected app (WhatsApp / Slack / Teams / Zapier) via the shared dispatch
//      layer in ../cloud-sync.js.
// POST (client "Send test"): sends one nudge immediately for a single company,
//      using the counts the client already has — works even before the finance
//      tables are provisioned.
//
// Schedule (vercel.json): "30 20 * * *" — 20:30 UTC ≈ 17:30 America/Sao_Paulo.
// Set CRON_SECRET in Vercel to lock the GET path to Vercel Cron.

import { dispatchToApp, normalizeIncident, getConnections } from '../cloud-sync.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rzdoeehbpdgjxtfbbmwp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const APP_URL = (process.env.CLOUD_REDIRECT_BASE || 'https://www.pillier.com.br').replace(/\/$/, '');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Manual test from the app (one company, counts supplied) ──
    if (req.method === 'POST') {
      const body = req.body || {};
      const companyId = body.company_id;
      if (!companyId) return res.status(400).json({ ok: false, error: 'missing company_id' });
      const nudge = buildNudge({
        obra: body.obra || 'Obra',
        pending: body.pending_count != null ? body.pending_count : 0,
        amount: body.amount != null ? body.amount : 0,
        currency: body.currency || 'BRL',
        lang: body.lang || 'pt',
      });
      const result = await fanOut(companyId, nudge);
      console.log('[fin-nudge] manual test', companyId, JSON.stringify(result));
      return res.status(200).json({ ok: true, test: true, nudge: nudge.message, result });
    }

    // ── Scheduled run (Vercel Cron) ──
    const secret = process.env.CRON_SECRET;
    const authed = !!req.headers['x-vercel-cron']
      || (secret && req.headers.authorization === 'Bearer ' + secret)
      || !secret; // if no secret configured, allow (dev)
    if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!SUPABASE_KEY) return res.status(200).json({ ok: false, error: 'not_configured' });

    const settings = await sb('finance_settings?nudge_enabled=eq.true&select=company_id,budget_monthly');
    if (!Array.isArray(settings)) return res.status(200).json({ ok: true, companies: 0, note: 'finance_settings unavailable' });

    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const iso = dayStart.toISOString();
    let sent = 0;
    for (const s of settings) {
      const rows = await sb('expenses?company_id=eq.' + s.company_id + '&status=eq.pending&created_at=gte.' + iso + '&select=amount,currency,project');
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) continue;
      const amount = list.reduce((a, r) => a + (Number(r.amount) || 0), 0);
      const obra = (list[0] && list[0].project) || 'Obra';
      const currency = (list[0] && list[0].currency) || 'BRL';
      const nudge = buildNudge({ obra, pending: list.length, amount, currency, lang: 'pt' });
      const result = await fanOut(s.company_id, nudge);
      if (result.dispatched) sent++;
      console.log('[fin-nudge]', s.company_id, list.length, 'pending', JSON.stringify(result));
    }
    return res.status(200).json({ ok: true, companies: settings.length, notified: sent });
  } catch (err) {
    console.error('[fin-nudge] error', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// Build the localized notice as an incident-shaped object the dispatch layer
// already knows how to turn into per-app payloads.
function buildNudge({ obra, pending, amount, currency, lang }) {
  const money = fmtMoney(amount, currency);
  const link = APP_URL + '/#financeiro/despesas';
  const L = {
    pt: {
      title: 'Fechamento do dia — ' + obra,
      msg: 'Olá! Você tem ' + pending + ' recibo(s) e despesa(s) pendentes (' + money + ') para o fechamento do dia na ' + obra + '. Clique para validar.',
      action: 'Validar e fechar o dia',
    },
    en: {
      title: 'End-of-day close — ' + obra,
      msg: 'Hi! You have ' + pending + ' receipt(s)/expense(s) pending (' + money + ') for today’s close on ' + obra + '. Tap to review.',
      action: 'Review and close the day',
    },
    fr: {
      title: 'Clôture du jour — ' + obra,
      msg: 'Bonjour ! Vous avez ' + pending + ' reçu(s)/dépense(s) en attente (' + money + ') pour la clôture du jour sur ' + obra + '. Cliquez pour valider.',
      action: 'Valider et clôturer',
    },
  }[lang] || null;
  const t = L || { title: 'Fechamento do dia — ' + obra, msg: '', action: 'Validar' };
  return {
    message: t.msg,
    incident: {
      title: t.title, severity: 'medium', category: 'Financeiro', project: obra,
      description: t.msg, action: t.action, user_name: 'Pillier', app_url: link,
    },
  };
}

// Fan the nudge out to every connected app for the company.
async function fanOut(companyId, nudge) {
  const conns = await getConnections(companyId, true);
  const apps = (conns || []).filter((c) => c.provider && c.provider.indexOf('app:') === 0);
  const inc = normalizeIncident(nudge.incident);
  const results = {};
  let dispatched = 0;
  await Promise.all(apps.map(async (c) => {
    const appId = c.provider.slice(4);
    const config = c.tokens && c.tokens.config;
    if (!config) { results[appId] = { ok: false, error: 'no config' }; return; }
    try {
      const out = await dispatchToApp(appId, config, inc);
      results[appId] = out;
      if (out.ok) dispatched++;
    } catch (e) { results[appId] = { ok: false, error: e.message }; }
  }));
  return { dispatched, total: apps.length, results };
}

function fmtMoney(v, currency) {
  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? 'US$' : 'R$';
  return sym + ' ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function sb(path) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}
