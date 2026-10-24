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

  // ---- GET /sitemap.xml (rewritten here): every public page + every ebook, in PT / EN / FR ----
  if (req.query && req.query.sitemap) return handleSitemap(req, res);
  // ---- GET /llms.txt (rewritten here): plain-text summary of Pillier for AI assistants ----
  if (req.query && req.query.llms) return handleLlms(req, res);

  // ---- GET: public frontend config ----
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  const turnstileSiteKey = (process.env.TURNSTILE_SITE_KEY || '').replace(/[^\w-]/g, '');
  return res.status(200).send('window.PILLIER_CONFIG = { turnstileSiteKey: "' + turnstileSiteKey + '" };');
}

// ---- Sitemap: built from the ebook catalog inside index.html, so a newly published ebook
// is listed automatically (no list to maintain here). ----
async function handleSitemap(req, res) {
  const base = 'https://pillier.com.br';
  const pages = [
    { pt: '/', en: '/en', fr: '/fr', pr: '1.0' },
    { pt: '/produto', en: '/en/product', fr: '/fr/produit', pr: '0.9' },
    { pt: '/planos', en: '/en/plans', fr: '/fr/plans', pr: '0.8' },
    { pt: '/recursos', en: '/en/resources', fr: '/fr/ressources', pr: '0.8' },
  ];
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'pillier.com.br';
    const r = await fetch('https://' + host + '/index.html');
    const html = r.ok ? await r.text() : '';
    const block = html.slice(html.indexOf('var RES_EBOOKS'), html.indexOf('];', html.indexOf('var RES_EBOOKS')));
    const seen = new Set();
    for (const m of block.matchAll(/\{id:\d+,slug:"([a-z0-9-]+)"/g)) {
      if (seen.has(m[1])) continue; seen.add(m[1]);
      pages.push({ pt: '/recursos/' + m[1], en: '/en/resources/' + m[1], fr: '/fr/ressources/' + m[1], pr: '0.7' });
    }
  } catch (e) { /* ebooks left out this time; the main pages are still listed */ }
  const alt = (p) => ['pt-BR:pt', 'en:en', 'fr:fr', 'x-default:pt']
    .map((x) => { const [hl, k] = x.split(':'); return '<xhtml:link rel="alternate" hreflang="' + hl + '" href="' + base + p[k] + '"/>'; }).join('');
  const urls = [];
  for (const p of pages) for (const k of ['pt', 'en', 'fr'])
    urls.push('<url><loc>' + base + p[k] + '</loc>' + alt(p) + '<priority>' + (k === 'pt' ? p.pr : (p.pr - 0.2).toFixed(1)) + '</priority></url>');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + urls.join('\n') + '\n</urlset>\n');
}

// ---- llms.txt: what Pillier is, in plain text, for AI assistants (ChatGPT, Claude, Perplexity, Gemini).
// The ebook list is read from the catalog in index.html, so new ebooks appear automatically. ----
async function handleLlms(req, res) {
  const base = 'https://pillier.com.br';
  let ebooks = [];
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'pillier.com.br';
    const r = await fetch('https://' + host + '/index.html');
    const html = r.ok ? await r.text() : '';
    const a = html.indexOf('var RES_EBOOKS');
    const block = html.slice(a, html.indexOf('];', a));
    for (const part of block.split(/\n\s*\{id:/).slice(1)) {
      const slug = (part.match(/slug:"([a-z0-9-]+)"/) || [])[1];
      const title = (part.match(/title:\[(?:"(?:[^"\\]|\\.)*",){2}"((?:[^"\\]|\\.)*)"\]/) || [])[1];
      const sum = (part.match(/pt:\["((?:[^"\\]|\\.)*)"/) || [])[1];
      if (slug && title) ebooks.push({ slug, title: title.replace(/\\"/g, '"'), sum: (sum || '').replace(/\\"/g, '"') });
    }
  } catch (e) { /* summary still served without the ebook list */ }
  const L = [];
  L.push('# Pillier');
  L.push('');
  L.push('> Pillier é uma plataforma de gestão de obra com inteligência artificial para construtoras, engenheiros e arquitetos no Brasil: RDO digital (relatório diário de obra) gerado a partir de fotos e áudios do canteiro, registro de incidentes com causa provável, solução e normas aplicáveis (ABNT NBR, NR), financeiro da obra com histórico de preços, documentos e base de conhecimento. Site em português, com versões em inglês e francês.');
  L.push('');
  L.push('Pillier (English): an AI construction management platform for builders, engineers and architects. Photos and voice notes from the job site become the daily report (RDO), incident records with probable cause, fix and applicable standards, plus project finance, documents and a searchable knowledge base.');
  L.push('');
  L.push('## O que a Pillier faz');
  L.push('- RDO digital: o relatório diário de obra é montado a partir das capturas do dia (atividades, equipe, ocorrências, fotos) e assinado eletronicamente pelo responsável.');
  L.push('- Captura de incidentes por foto ou voz: a IA descreve o problema, a causa provável, a solução recomendada e as normas provavelmente aplicáveis (ABNT NBR, NR-18, NR-35; DTU, NF e Eurocódigos para obras na França).');
  L.push('- Pillier IA: assistente especializado em construção que responde com base nos registros da própria obra e da empresa.');
  L.push('- Financeiro da obra: despesas, notas e histórico de preços de materiais.');
  L.push('- Plantas e documentos, base de conhecimento pesquisável, colaboração em equipe em tempo real.');
  L.push('- Funciona no navegador do celular, pode ser instalada como aplicativo e salva capturas sem internet para sincronizar depois.');
  L.push('');
  L.push('## Para quem');
  L.push('Engenheiros e arquitetos autônomos, pequenas e médias construtoras, empreiteiras, empresas de infraestrutura e incorporadoras.');
  L.push('');
  L.push('## Planos');
  L.push('- Profissional: R$ 399/mês, até 5 membros: projetos ilimitados, captura por foto e voz, RDO digital, Pillier IA, financeiro, base de conhecimento, colaboração em tempo real');
  L.push('- Enterprise: equipes com mais de 5 membros, preço sob consulta (SSO, integrações ERP/BIM, SLA)');
  L.push('- Teste grátis, sem cartão de crédito: ' + base + '/planos');
  L.push('');
  L.push('## Páginas');
  L.push('- [Início](' + base + '/): visão geral');
  L.push('- [Produto](' + base + '/produto): agentes de IA, fluxo de captura, setores atendidos');
  L.push('- [Planos e preços](' + base + '/planos)');
  L.push('- [Recursos](' + base + '/recursos): ebooks gratuitos sobre gestão de obra');
  L.push('- [Agendar demonstração](https://cal.com/pillier-ai-demo/30min)');
  if (ebooks.length) {
    L.push('');
    L.push('## Ebooks gratuitos (português)');
    for (const e of ebooks) L.push('- [' + e.title + '](' + base + '/recursos/' + e.slug + ')' + (e.sum ? ': ' + e.sum : ''));
  }
  L.push('');
  L.push('## Versões em outros idiomas');
  L.push('- English: ' + base + '/en');
  L.push('- Français: ' + base + '/fr');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  return res.status(200).send(L.join('\n') + '\n');
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
    const type = str(body.type || 'lead');
    const role = str(body.role).slice(0, 80);
    const pagesRead = str(body.pages_read).slice(0, 20);
    const alsoRead = str(body.also_read).slice(0, 500);
    const origin = str(body.origin).slice(0, 80);
    const hot = body.hot === true;
    const returning = body.returning === true;
    // Reading activity after sign-up (no new lead): update the lead row, and alert once when it turns hot.
    if (type === 'progress' || type === 'hot') return handleProgress(req, res, body, type);

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
        const details = { role, pages_read: pagesRead, also_read: alsoRead, origin, hot };
        let r = await insert({ name, email, company, report_id, report_title, lang, source, ip, user_agent: ua, role, details });
        // Tables created before the role/details columns existed: retry without them.
        if (!r.ok) { const t0 = await r.clone().text(); if (/Could not find the '(role|details)' column/.test(t0)) r = await insert({ name, email, company, report_id, report_title, lang, source, ip, user_agent: ua }); }
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
          '<h2 style="margin:0 0 12px;color:#0a95d6">Novo lead: ' + esc(report_title || 'Relatório') + (hot ? ' <span style="display:inline-block;background:#fee2e2;color:#b91c1c;font-size:11px;border-radius:999px;padding:2px 8px;vertical-align:middle">QUENTE</span>' : '') + '</h2>' +
          '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
          row('Nome', esc(name)) + row('E-mail', '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>') +
          row('Empresa', esc(company) || '—') + row('Cargo', esc(role) || '—') + row('Liberou com', esc(report_title || report_id) || '—') +
          row('Leitura', esc(pagesRead) ? esc(pagesRead) + ' páginas (prévia)' : '—') + row('Também leu', esc(alsoRead) || '—') + row('Origem', esc(origin) || '—') + (returning ? row('Visita', 'Voltou: já tinha se cadastrado antes') : '') +
          row('Idioma', esc(lang) || '—') + row('Origem', esc(source)) + row('Quando', esc(when)) +
          '</table><p style="margin-top:16px;color:#6b7c84;font-size:12px">Um cadastro libera todos os ebooks. O progresso de leitura continua sendo salvo na tabela leads (coluna details). Você recebe outro e-mail se o lead ficar quente.</p></div>';
        const er = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], reply_to: email, subject: (returning ? 'Lead voltou: ' : 'Novo lead: ') + (report_title || 'Relatório') + ' — ' + name, html }),
        });
        emailed = er.ok;
        if (!er.ok) console.error('[lead] resend failed', er.status, (await er.text()).slice(0, 200));
      } catch (e) { console.error('[lead] resend error', e.message); }
    }

    // 3) Push to Zoho CRM via Web-to-Lead (no OAuth needed). Non-blocking.
    let zoho = false, zohoErr = '';
    // Web-to-Lead tokens are public by design (embedded in the public form HTML),
    // so they default here; env vars override if you'd rather manage them in Vercel.
    const ZWTL_URL = process.env.ZOHO_WTL_URL || 'https://crm.zoho.eu/crm/WebToLeadForm';
    const ZWTL_ID = process.env.ZOHO_WTL_ID || '14e7e4f4726242ce3ec3c7b29a12d336404d5e754d9d79ddaf19cad2d8512d69';
    const ZWTL_TOKEN = process.env.ZOHO_WTL_TOKEN || 'e936c6f18af5ef20320986a2ffa3b77f9cfae828a6d5bd52e5b8691dc711c7cf9d9eab3b343bdea9952f2eae4da37f4b';
    if (ZWTL_URL && ZWTL_ID && ZWTL_TOKEN) {
      try {
        const form = new URLSearchParams();
        form.set('xnQsjsdp', ZWTL_ID);
        form.set('xmIwtLD', ZWTL_TOKEN);
        form.set('actionType', 'TGVhZHM=');          // base64("Leads")
        form.set('returnURL', process.env.ZOHO_WTL_RETURN || 'https://www.pillier.com.br');
        form.set('aG9uZXlwb3Q', '');                  // honeypot — must stay empty
        form.set('Last Name', name || 'Lead');       // required by Zoho Leads
        form.set('Company', company || 'Não informado'); // required by Zoho Leads
        form.set('Email', email);
        form.set('Lead Source', 'Site Web');         // must match a Zoho picklist option
        form.set('Description', 'Liberou "' + (report_title || report_id) + '" (' + lang + ')' + (role ? ' · cargo: ' + role : '') + (origin ? ' · origem: ' + origin : '') + (alsoRead ? ' · também leu: ' + alsoRead : '') + (hot ? ' · LEAD QUENTE' : ''));
        if (role) form.set('Designation', role);
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

// ---- reading progress after sign-up: update the newest lead row; one "hot lead" alert ----
async function handleProgress(req, res, body, type) {
  try {
    const email = str(body.email).slice(0, 160).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
    const details = Array.isArray(body.details) ? body.details.slice(0, 50).map((d) => ({ id: d && d.id, title: str(d && d.title).slice(0, 200), pages: str(d && d.pages).slice(0, 12), downloaded: !!(d && d.downloaded) })) : [];
    let updated = false;
    if (SERVICE_KEY) {
      try {
        const u = await fetch(SUPABASE_URL + '/rest/v1/leads?email=eq.' + encodeURIComponent(email) + '&source=eq.resources', {
          method: 'PATCH',
          headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ details: { reading: details, origin: str(body.origin).slice(0, 80), role: str(body.role).slice(0, 80), updated_at: new Date().toISOString() } }),
        });
        updated = u.ok; // false when the table has no `details` column yet — harmless
      } catch (e) { /* best effort */ }
    }
    let emailed = false;
    if (type === 'hot' && RESEND_KEY) {
      const lines = details.map((d) => esc(d.title) + ' — ' + esc(d.pages) + ' páginas' + (d.downloaded ? ' · baixou o PDF' : '')).join('<br>');
      const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a2b33;line-height:1.6">' +
        '<h2 style="margin:0 0 12px;color:#b91c1c">Lead quente: ' + esc(body.name) + '</h2>' +
        '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">' +
        row('Nome', esc(body.name)) + row('E-mail', '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a>') + row('Empresa', esc(body.company) || '—') + row('Cargo', esc(body.role) || '—') +
        row('Leitura', lines || '—') + row('Origem', esc(body.origin) || '—') +
        '</table><p style="margin-top:16px;color:#6b7c84;font-size:12px">Quente = leu um ebook inteiro, baixou o PDF ou abriu 2+ ebooks. Bom momento para entrar em contato.</p></div>';
      try {
        const er = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], reply_to: email, subject: 'Lead quente: ' + str(body.name).slice(0, 80) + ' — ' + str(body.company || '').slice(0, 80), html }),
        });
        emailed = er.ok;
      } catch (e) { /* best effort */ }
    }
    return res.status(200).json({ ok: true, updated, emailed });
  } catch (err) {
    return res.status(200).json({ ok: false, error: 'server_error' });
  }
}

function row(k, v) {
  return '<tr><td style="padding:4px 16px 4px 0;color:#6b7c84;font-weight:bold;vertical-align:top">' + esc(k) + '</td><td style="padding:4px 0;color:#1a2b33">' + v + '</td></tr>';
}
function str(v) { return (v === null || v === undefined) ? '' : String(v); }
function esc(s) { return str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function getBody(req) { return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d || '{}')); }); }
