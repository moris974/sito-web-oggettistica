'use strict';
/**
 * Testi e aspetto del sito modificabili dal pannello admin (scheda "Aspetto del sito").
 * Salvati come JSON nella tabella impostazioni; tutto ciò che arriva dall'admin viene
 * validato qui e "escapato" prima di finire nell'HTML.
 */
const { HttpError, escapeHtml: esc } = require('./util');

const THEMES = {
  rosso: { label: 'Rosso natalizio', cls: 'from-red-950 via-red-900 to-amber-950' },
  verde: { label: 'Verde bosco', cls: 'from-emerald-950 via-emerald-900 to-teal-950' },
  blu: { label: 'Blu notte', cls: 'from-slate-900 via-blue-900 to-indigo-950' },
  rosa: { label: 'Rosa antico', cls: 'from-rose-900 via-pink-800 to-fuchsia-950' },
  nero: { label: 'Grafite', cls: 'from-slate-950 via-slate-800 to-zinc-900' },
};

const DEFAULT_CONTENT = {
  // testata
  brandMain: 'G&T',
  brandAccent: 'Artigianato',
  brandTagline: 'Fatto a Mano in Italia',
  navQuoteLabel: 'Ordini su misura',
  floatQuoteLabel: 'Richiedi su misura',
  // riquadro principale
  heroVisible: true,
  heroTheme: 'rosso',
  heroImage: '',
  badgeLabel: 'G&T Fatto a Mano',
  badge2Label: 'Pagamenti protetti',
  heroTitle: 'Fiocchi Natalizi Extra Large & Bomboniere Artigianali',
  heroText:
    'Creazioni uniche fatte a mano da G&T con sconti esclusivi in formato coupon. Pagamenti sicuri e ordini personalizzati via WhatsApp.',
  btn1Label: 'Scopri le offerte',
  btn2Label: 'Preventivo WhatsApp',
  // piè di pagina
  footerNote: '',
  footerLinksTitle: 'Informazioni',
  footerLinks: [],
  footerPayTitle: 'Pagamenti',
  footerPayText:
    'Carta, PayPal e bonifico. I dati di pagamento sono gestiti direttamente dai circuiti Stripe e PayPal: il sito non li vede né li conserva.',
  copyrightText: '',
  showAdminLink: true,
};

/** Legge il contenuto salvato (o i valori predefiniti) dalle impostazioni. */
function contentFrom(settings) {
  let saved = {};
  try {
    const parsed = JSON.parse(settings.content || '{}');
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch {
    /* JSON rovinato: si torna ai predefiniti */
  }
  const c = { ...DEFAULT_CONTENT, ...saved };
  if (!THEMES[c.heroTheme]) c.heroTheme = DEFAULT_CONTENT.heroTheme;
  if (!Array.isArray(c.footerLinks)) c.footerLinks = [];
  return c;
}

/* ------------------------------ validazione ------------------------------ */

function text(v, min, max, label) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min || s.length > max) {
    throw new HttpError(400, min > 0 ? `${label}: da ${min} a ${max} caratteri.` : `${label}: massimo ${max} caratteri.`);
  }
  return s;
}

function validLink(raw) {
  const u = typeof raw === 'string' ? raw.trim() : '';
  if (u.length < 1 || u.length > 300) throw new HttpError(400, 'Link del piè di pagina: da 1 a 300 caratteri.');
  if (/^https:\/\//i.test(u)) {
    try {
      new URL(u);
      return u;
    } catch {
      /* link non valido */
    }
  } else if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(u)) return u;
  else if (/^tel:\+?[\d\s()-]{5,25}$/i.test(u)) return u;
  else if (/^\/(?!\/)[\w\-./?=&#%]*$/.test(u)) return u;
  throw new HttpError(400, 'Link non valido: usa https://…, mailto:…, tel:… oppure un percorso interno come /privacy.');
}

/** Controlla e normalizza il contenuto inviato dall'admin. validImageRef arriva da server.js. */
function parseContent(b, validImageRef) {
  if (!THEMES[b.heroTheme]) throw new HttpError(400, 'Colore del riquadro non valido.');
  const links = Array.isArray(b.footerLinks) ? b.footerLinks : [];
  if (links.length > 8) throw new HttpError(400, 'Puoi aggiungere al massimo 8 link nel piè di pagina.');
  return {
    brandMain: text(b.brandMain, 1, 30, 'Nome in testata'),
    brandAccent: text(b.brandAccent ?? '', 0, 40, 'Nome in testata (parte colorata)'),
    brandTagline: text(b.brandTagline ?? '', 0, 60, 'Sottotitolo in testata'),
    navQuoteLabel: text(b.navQuoteLabel, 1, 40, 'Pulsante ordini su misura'),
    floatQuoteLabel: text(b.floatQuoteLabel, 1, 40, 'Pulsante WhatsApp fluttuante'),
    heroVisible: b.heroVisible !== false,
    heroTheme: b.heroTheme,
    heroImage: validImageRef(b.heroImage),
    badgeLabel: text(b.badgeLabel ?? '', 0, 40, 'Etichetta gialla'),
    badge2Label: text(b.badge2Label ?? '', 0, 40, 'Seconda etichetta'),
    heroTitle: text(b.heroTitle ?? '', 0, 140, 'Titolo'),
    heroText: text(b.heroText ?? '', 0, 400, 'Testo sotto il titolo'),
    btn1Label: text(b.btn1Label ?? '', 0, 30, 'Primo pulsante'),
    btn2Label: text(b.btn2Label ?? '', 0, 30, 'Secondo pulsante'),
    footerNote: text(b.footerNote ?? '', 0, 300, 'Nota nel piè di pagina'),
    footerLinksTitle: text(b.footerLinksTitle, 1, 40, 'Titolo colonna link'),
    footerLinks: links.map((l) => ({ label: text(l && l.label, 1, 40, 'Testo del link'), url: validLink(l && l.url) })),
    footerPayTitle: text(b.footerPayTitle ?? '', 0, 40, 'Titolo colonna pagamenti'),
    footerPayText: text(b.footerPayText ?? '', 0, 400, 'Testo colonna pagamenti'),
    copyrightText: text(b.copyrightText ?? '', 0, 150, 'Riga del copyright'),
    showAdminLink: b.showAdminLink !== false,
  };
}

/* ------------------------------ HTML generato dal server ------------------------------ */

function heroHtml(c) {
  if (!c.heroVisible) return '';
  const theme = THEMES[c.heroTheme].cls;
  const img = c.heroImage
    ? `<img src="${esc(c.heroImage)}" alt="" class="absolute inset-0 w-full h-full object-cover opacity-30 pointer-events-none">`
    : '';
  const badge1 = c.badgeLabel
    ? `<span class="bg-amber-400 text-slate-950 text-xs font-extrabold px-3 py-1 rounded-full uppercase tracking-wider">${esc(c.badgeLabel)}</span>`
    : '';
  const badge2 = c.badge2Label
    ? `<span class="bg-emerald-600/80 text-white text-[11px] px-2.5 py-0.5 rounded-full flex items-center gap-1"><i class="fa-solid fa-shield"></i> ${esc(c.badge2Label)}</span>`
    : '';
  const badges = badge1 || badge2 ? `<div class="flex flex-wrap items-center gap-2 mb-3">${badge1}${badge2}</div>` : '';
  const title = c.heroTitle ? `<h1 class="text-3xl md:text-5xl font-serif font-bold leading-tight mb-4">${esc(c.heroTitle)}</h1>` : '';
  const par = c.heroText ? `<p class="text-amber-100 text-sm md:text-base mb-6">${esc(c.heroText)}</p>` : '';
  const b1 = c.btn1Label
    ? `<a href="#prodotti" class="bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold px-6 py-3 rounded-lg transition shadow-md flex items-center gap-2"><i class="fa-solid fa-tag"></i> ${esc(c.btn1Label)}</a>`
    : '';
  const b2 = c.btn2Label
    ? `<button type="button" data-action="quote" class="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-6 py-3 rounded-lg transition shadow-md flex items-center gap-2"><i class="fa-brands fa-whatsapp text-xl"></i> ${esc(c.btn2Label)}</button>`
    : '';
  const buttons = b1 || b2 ? `<div class="flex flex-wrap gap-3">${b1}${b2}</div>` : '';
  return `<section class="relative rounded-2xl bg-gradient-to-r ${theme} text-white p-6 md:p-10 mb-10 shadow-xl overflow-hidden border border-amber-500/20">${img}<div class="relative z-10 max-w-2xl">${badges}${title}${par}${buttons}</div></section>`;
}

function taglineHtml(c) {
  return c.brandTagline
    ? `<span class="text-[10px] text-emerald-700 font-bold uppercase tracking-widest flex items-center gap-1 mt-0.5"><i class="fa-solid fa-circle-check"></i> ${esc(c.brandTagline)}</span>`
    : '';
}

function footerLinksHtml(c) {
  return c.footerLinks
    .map((l) => {
      const external = /^https:/i.test(l.url);
      return `<li><a class="hover:text-amber-300 underline" href="${esc(l.url)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(l.label)}</a></li>`;
    })
    .join('');
}

function footerNoteHtml(c) {
  return c.footerNote ? `<p class="mt-2 text-amber-100/70">${esc(c.footerNote)}</p>` : '';
}

function footerPayHtml(c) {
  if (!c.footerPayTitle && !c.footerPayText) return '';
  return `<div>${c.footerPayTitle ? `<p class="font-bold text-amber-100 mb-1">${esc(c.footerPayTitle)}</p>` : ''}${c.footerPayText ? `<p>${esc(c.footerPayText)}</p>` : ''}</div>`;
}

const adminLinkHtml = (c) => (c.showAdminLink ? ' &middot; <a href="/admin" class="hover:text-amber-300">Area riservata</a>' : '');

module.exports = {
  THEMES,
  DEFAULT_CONTENT,
  contentFrom,
  parseContent,
  heroHtml,
  taglineHtml,
  footerLinksHtml,
  footerNoteHtml,
  footerPayHtml,
  adminLinkHtml,
};
