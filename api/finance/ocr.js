// /api/finance/ocr.js — Receipt / invoice OCR for the Financeiro module.
// Sends the receipt image to Gemini vision with a strict-JSON prompt and returns
// the four fields the ExpenseCaptureModal needs (vendor, category, amount,
// method) plus a couple of useful extras (currency, date, line items).
//
// Reuses the same GEMINI_API_KEY already configured for /api/gemini — no extra
// setup. Falls back cleanly with ok:false so the client can still let the user
// type the fields by hand.

import { applyRateLimit } from '../_rate-limit.js';

// The five categories the modal offers — the model must map to one of these.
const CATEGORIES = ['Material Básico', 'Mão de Obra', 'Equipamentos', 'Transporte', 'Outros'];
const METHODS = ['Pix', 'Cartão', 'Dinheiro', 'Boleto', 'Virement'];
// Dependent sub-categories per category (canonical PT, must match the client).
const SUBCATS = {
  'Transporte': ['Combustível', 'Óleo/Manutenção', 'Pedágio', 'Frete/Carreto', 'Outros Transporte'],
  'Material Básico': ['Cimento', 'Areia/Brita', 'Tijolo/Bloco', 'Aço/Ferragem', 'Madeira', 'Outros Básico'],
  'Mão de Obra': ['Diária Pedreiro', 'Ajudante', 'Empreiteiro', 'Horas Extras', 'Alimentação Equipe'],
  'Equipamentos': ['Aluguel Betoneira', 'Andaimes', 'Gerador', 'Ferramentas Elétricas', 'Manutenção'],
  'Outros': ['Taxas/Cartório', 'EPI/Segurança', 'Limpeza', 'Administrativo', 'Diversos'],
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  // Vision is the expensive path — cap it like /api/gemini does.
  if (!applyRateLimit(req, res, 'finance-ocr', 20)) return;

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(200).json({ ok: false, error: 'not_configured' });

  try {
    let { image } = req.body || {};
    if (!image) return res.status(400).json({ ok: false, error: 'missing_image' });
    const match = String(image).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return res.status(400).json({ ok: false, error: 'bad_image' });

    const prompt =
      'You are an OCR extraction engine for construction-site receipts and invoices ' +
      '(cupons fiscais, notas, faturas) in Portuguese, French or English. ' +
      'Read the image and return ONLY a compact JSON object, no markdown, with exactly these keys: ' +
      '{"vendor": string, "category": one of ' + JSON.stringify(CATEGORIES) + ', ' +
      '"subcategory": string, ' +
      '"amount": number (the grand total, dot decimal, no thousands separators, no currency symbol), ' +
      '"currency": one of ["BRL","EUR","USD"], ' +
      '"method": one of ' + JSON.stringify(METHODS) + ' or "", ' +
      '"date": "YYYY-MM-DD" or "", ' +
      '"items": array of up to 6 {"name":string,"total":number}}. ' +
      'Infer category from the vendor and line items (building materials → "Material Básico", ' +
      'tools/machines → "Equipamentos", freight/fuel → "Transporte", labour/services → "Mão de Obra", ' +
      'else "Outros"). Then pick "subcategory" as EXACTLY one value from this map for the chosen ' +
      'category (verbatim, keep accents): ' + JSON.stringify(SUBCATS) + '. ' +
      'For example a fuel station (Posto, TotalEnergies, Shell, Ipiranga) → category "Transporte", ' +
      'subcategory "Combustível"; a cement invoice → "Material Básico" / "Cimento". ' +
      'If a field is unreadable use "" (or 0 for amount). Return JSON only.';

    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType: match[1], data: match[2] } },
            ],
          }],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.1,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(200).json({ ok: false, error: (data && data.error && data.error.message) || 'gemini_error' });
    }

    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n').trim();
    const parsed = safeParse(text);
    if (!parsed) return res.status(200).json({ ok: false, error: 'parse_failed', raw: text.slice(0, 400) });

    // Normalize / clamp to the allowed enums so the client can trust the values.
    const category = CATEGORIES.indexOf(parsed.category) >= 0 ? parsed.category : 'Outros';
    const subOptions = SUBCATS[category] || [];
    const subcategory = subOptions.indexOf(parsed.subcategory) >= 0 ? parsed.subcategory : '';
    const out = {
      vendor: str(parsed.vendor).slice(0, 120),
      category: category,
      subcategory: subcategory,
      amount: num(parsed.amount),
      currency: ['BRL', 'EUR', 'USD'].indexOf(parsed.currency) >= 0 ? parsed.currency : '',
      method: METHODS.indexOf(parsed.method) >= 0 ? parsed.method : '',
      date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || '') ? parsed.date : '',
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, 6).map((it) => ({ name: str(it && it.name).slice(0, 80), total: num(it && it.total) })) : [],
    };
    console.log('[finance-ocr] extracted', out.vendor, out.amount, out.currency, out.category, out.subcategory);
    return res.status(200).json({ ok: true, data: out });
  } catch (err) {
    console.error('[finance-ocr] error', err.message);
    return res.status(500).json({ ok: false, error: 'server_error: ' + (err.message || 'unknown') });
  }
}

function str(v) { return (v === null || v === undefined) ? '' : String(v); }
function num(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  const n = parseFloat(String(v).replace(/[^0-9.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}
function safeParse(t) {
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
  return null;
}
