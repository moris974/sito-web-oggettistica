'use strict';
(() => {
  /* ------------------------------ utilità ------------------------------ */
  const app = document.getElementById('app');
  const money = (c) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(c / 100);
  const toCents = (v) => {
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
  };
  const fromCents = (c) => (c / 100).toFixed(2);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const icon = (c) => h('i', { class: c, 'aria-hidden': 'true' });

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(options.headers || {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* vuoto */
    }
    if (!res.ok) {
      const err = new Error(data.error || 'Errore imprevisto.');
      err.status = res.status;
      if (res.status === 401 && path !== '/api/admin/login') showLogin();
      throw err;
    }
    return data;
  }

  const inputCls = 'w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-red-600 bg-white';
  const btn = (text, cls, onclick, extra = {}) => h('button', { type: 'button', class: cls, onclick, ...extra }, text);
  const card = (...kids) => h('div', { class: 'bg-white p-6 rounded-xl border border-amber-200 shadow-sm' }, ...kids);
  const title = (ic, text) => h('h3', { class: 'text-lg font-bold text-slate-900 mb-4 flex items-center gap-2' }, icon(ic + ' text-red-700'), text);

  function labeled(label, input, wrap = '') {
    return h('div', { class: wrap }, h('label', { class: 'block text-xs font-semibold text-slate-700 mb-1' }, label), input);
  }
  const msgBox = () => h('p', { class: 'hidden text-xs font-bold mt-2', role: 'status' });
  function say(box, text, ok) {
    box.textContent = text;
    box.className = 'text-xs font-bold mt-2 ' + (ok ? 'text-emerald-700' : 'text-red-700');
  }

  /** Ridimensiona un'immagine lato client e la restituisce come data URL. */
  function fileToDataUrl(file, { maxW, maxH, keepAlpha }) {
    return new Promise((resolve, reject) => {
      const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];
      if (!allowed.includes(file.type)) return reject(new Error('Formato non supportato (PNG, JPG, WEBP, GIF, SVG).'));
      if (file.size > 12 * 1024 * 1024) return reject(new Error('File troppo grande (max 12 MB).'));
      if ((file.type === 'image/svg+xml' || file.type === 'image/gif') && file.size > 1.5 * 1024 * 1024) {
        return reject(new Error('SVG e GIF non possono superare 1,5 MB: usa un PNG o JPG, che viene ridimensionato in automatico.'));
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Impossibile leggere il file.'));
      reader.onload = () => {
        if (file.type === 'image/svg+xml' || file.type === 'image/gif') return resolve(reader.result);
        const img = new Image();
        img.onerror = () => reject(new Error('Immagine non valida.'));
        img.onload = () => {
          const ratio = Math.min(1, maxW / img.width, maxH / img.height);
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * ratio));
          c.height = Math.max(1, Math.round(img.height * ratio));
          const ctx = c.getContext('2d');
          const png = keepAlpha && file.type !== 'image/jpeg';
          if (!png) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, c.width, c.height);
          }
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const out = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88);
          if (out.length > 2.6 * 1024 * 1024) return reject(new Error('Immagine troppo pesante anche dopo il ridimensionamento: prova con un file più semplice o più piccolo.'));
          resolve(out);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  async function uploadImage(file, opts) {
    const dataUrl = await fileToDataUrl(file, opts);
    return (await api('/api/admin/upload', { method: 'POST', body: { dataUrl } })).url;
  }

  /* ------------------------------ login ------------------------------ */
  function showLogin() {
    const err = h('p', { class: 'hidden mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg text-center font-bold', role: 'alert' });
    const user = h('input', { type: 'text', required: true, autocomplete: 'username', class: inputCls });
    const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password', class: inputCls });
    const form = h(
      'form',
      { class: 'space-y-4' },
      labeled('Utente', user),
      labeled('Password', pass),
      h('button', { type: 'submit', class: 'w-full bg-red-800 hover:bg-red-900 text-white font-bold py-2.5 rounded-lg text-sm shadow transition flex items-center justify-center gap-2' }, icon('fa-solid fa-shield-halved'), 'Accedi')
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      try {
        await api('/api/admin/login', { method: 'POST', body: { username: user.value, password: pass.value } });
        showDashboard();
      } catch (e2) {
        err.textContent = e2.message;
        err.classList.remove('hidden');
        pass.value = '';
      }
    });
    app.replaceChildren(
      h(
        'div',
        { class: 'max-w-md mx-auto bg-white p-8 rounded-2xl shadow-xl border border-red-200 mt-10' },
        h('div', { class: 'text-center mb-6' }, h('div', { class: 'w-14 h-14 bg-red-100 text-red-700 rounded-full flex items-center justify-center mx-auto mb-3 text-2xl border-2 border-red-300' }, icon('fa-solid fa-lock')), h('h1', { class: 'text-2xl font-serif font-bold text-slate-900' }, 'Area riservata'), h('p', { class: 'text-xs text-slate-500 mt-1' }, 'Gestione ordini, articoli, coupon e impostazioni.')),
        err,
        form,
        h('p', { class: 'mt-4 text-center text-xs' }, h('a', { href: '/', class: 'text-slate-500 hover:text-red-700 underline' }, '← Torna al negozio'))
      )
    );
    user.focus();
  }

  /* ------------------------------ dashboard ------------------------------ */
  const tabs = { orders: 'Ordini', products: 'Articoli', coupons: 'Coupon', look: 'Aspetto del sito', settings: 'Impostazioni' };
  let currentTab = 'orders';

  async function showDashboard() {
    const body = h('div', { id: 'tab-body', class: 'space-y-6' });
    const nav = h('div', { class: 'flex flex-wrap gap-2 mb-6' });
    const draw = () => {
      nav.replaceChildren(
        ...Object.entries(tabs).map(([k, label]) =>
          h('button', { type: 'button', class: 'px-4 py-2 rounded-full text-sm font-semibold shadow-sm transition ' + (k === currentTab ? 'bg-red-700 text-white' : 'bg-white text-slate-700 hover:bg-amber-100'), onclick: () => { currentTab = k; draw(); renderTab(body); } }, label)
        )
      );
    };
    draw();
    app.replaceChildren(
      h(
        'div',
        { class: 'flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-5 rounded-xl border border-amber-200 shadow-sm gap-3 mb-6' },
        h('div', {}, h('span', { class: 'bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 rounded uppercase' }, 'Sessione attiva'), h('h1', { class: 'text-2xl font-serif font-bold text-slate-900 mt-1' }, 'Pannello di gestione')),
        h('div', { class: 'flex gap-2' }, h('a', { href: '/', class: 'bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold px-4 py-2 rounded-lg transition flex items-center gap-2' }, icon('fa-solid fa-store'), 'Vedi il negozio'), btn([icon('fa-solid fa-right-from-bracket'), ' Esci'], 'bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold px-4 py-2 rounded-lg transition', async () => { await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {}); showLogin(); }))
      ),
      nav,
      body
    );
    renderTab(body);
  }

  function renderTab(body) {
    body.replaceChildren(h('p', { class: 'text-slate-400 py-10 text-center' }, 'Caricamento…'));
    const fn = { orders: renderOrders, products: renderProducts, coupons: renderCoupons, look: renderLook, settings: renderSettings }[currentTab];
    fn(body).catch((e) => body.replaceChildren(h('p', { class: 'text-red-700 text-sm py-6' }, e.message)));
  }

  /* ------------------------------ ordini ------------------------------ */
  const STATUS = {
    pending: ['In attesa di pagamento', 'bg-amber-100 text-amber-800'],
    awaiting_payment: ['In attesa di bonifico', 'bg-amber-100 text-amber-800'],
    paid: ['Pagato', 'bg-emerald-100 text-emerald-800'],
    shipped: ['Spedito', 'bg-sky-100 text-sky-800'],
    cancelled: ['Annullato', 'bg-slate-200 text-slate-600'],
  };
  const PROVIDER = { stripe: 'Carta (Stripe)', paypal: 'PayPal', bank: 'Bonifico' };
  let ordersFilter = '';

  function waLink(phone, text) {
    let d = String(phone).replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.length === 10 && d.startsWith('3')) d = '39' + d;
    return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
  }

  async function renderOrders(body) {
    const data = await api('/api/admin/orders' + (ordersFilter ? `?status=${ordersFilter}` : ''));
    const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
    const chip = (key, label, n) => h('button', { type: 'button', class: 'px-3 py-1.5 rounded-full text-xs font-semibold border transition ' + (ordersFilter === key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 hover:bg-amber-100'), onclick: () => { ordersFilter = key; renderTab(body); } }, `${label} (${n})`);

    const list = data.orders.map((o) => {
      const [stLabel, stCls] = STATUS[o.status] || [o.status, 'bg-slate-100'];
      const act = async (status) => {
        if (status === 'cancelled' && !confirm(`Annullare l'ordine ${o.id}? Gli articoli torneranno in magazzino.`)) return;
        try { await api(`/api/admin/orders/${o.id}`, { method: 'PATCH', body: { status } }); renderTab(body); } catch (e) { alert(e.message); }
      };
      const noteIn = h('input', { class: inputCls, maxlength: 500, placeholder: 'Nota interna (es. numero di tracking)', value: o.adminNote || '' });
      return h(
        'details',
        { class: 'bg-white border border-amber-200 rounded-xl shadow-sm' },
        h(
          'summary',
          { class: 'p-4 cursor-pointer flex flex-wrap items-center gap-3 text-sm' },
          h('span', { class: 'font-mono font-bold' }, o.id),
          h('span', { class: 'text-xs text-slate-500' }, o.createdAt + ' UTC'),
          h('span', { class: 'font-semibold' }, o.customer.name),
          h('span', { class: 'px-2 py-0.5 rounded text-[10px] font-bold uppercase ' + stCls }, stLabel),
          h('span', { class: 'text-xs text-slate-500' }, PROVIDER[o.provider] || o.provider),
          h('span', { class: 'ml-auto font-bold text-red-700' }, money(o.totalCents))
        ),
        h(
          'div',
          { class: 'px-4 pb-4 space-y-3 text-sm border-t border-slate-100 pt-3' },
          h('ul', { class: 'list-disc pl-5 text-xs space-y-0.5' }, o.items.map((i) => h('li', {}, `${i.qty} × ${i.title} — ${money(i.unitCents)}`))),
          h('p', { class: 'text-xs text-slate-500' }, `Spedizione ${money(o.shippingCents)}${o.coupon ? ` · Coupon ${o.coupon} (−${money(o.discountCents)})` : ''}`),
          h('div', { class: 'grid sm:grid-cols-2 gap-3 text-xs bg-amber-50/60 rounded-lg p-3' }, h('div', {}, h('b', {}, 'Spedire a: '), `${o.customer.name}, ${o.customer.address}, ${o.customer.zip} ${o.customer.city}`), h('div', {}, h('b', {}, 'Contatti: '), o.customer.email, ' · ', o.customer.phone), o.notes ? h('div', { class: 'sm:col-span-2' }, h('b', {}, 'Note cliente: '), o.notes) : null),
          o.adminNote && /ATTENZIONE|annullamento/.test(o.adminNote) ? h('p', { class: 'text-xs font-bold text-red-700' }, o.adminNote) : null,
          h('div', { class: 'flex flex-wrap gap-2 items-center' },
            ['pending', 'awaiting_payment'].includes(o.status) ? btn('Segna come pagato', 'bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold px-3 py-2 rounded-lg', () => act('paid')) : null,
            o.status === 'paid' ? btn('Segna come spedito', 'bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold px-3 py-2 rounded-lg', () => act('shipped')) : null,
            o.status !== 'cancelled' && o.status !== 'shipped' ? btn('Annulla ordine', 'bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-xs font-bold px-3 py-2 rounded-lg', () => act('cancelled')) : null,
            h('a', { href: waLink(o.customer.phone, `Ciao ${o.customer.name}, ti scriviamo per il tuo ordine ${o.id}.`), target: '_blank', rel: 'noopener', class: 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-300 text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1' }, icon('fa-brands fa-whatsapp'), 'Scrivi al cliente'),
            h('a', { href: `mailto:${o.customer.email}?subject=${encodeURIComponent('Il tuo ordine ' + o.id)}`, class: 'bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold px-3 py-2 rounded-lg' }, icon('fa-solid fa-envelope'), ' Email')
          ),
          h('div', { class: 'flex gap-2' }, noteIn, btn('Salva nota', 'bg-slate-900 text-white text-xs font-bold px-3 rounded-lg whitespace-nowrap', async () => { try { await api(`/api/admin/orders/${o.id}`, { method: 'PATCH', body: { adminNote: noteIn.value } }); noteIn.classList.add('ring-2', 'ring-emerald-500'); } catch (e) { alert(e.message); } }))
        )
      );
    });

    body.replaceChildren(
      h('div', { class: 'flex flex-wrap items-center gap-2' }, chip('', 'Tutti', total), ...Object.entries(STATUS).map(([k, [label]]) => chip(k, label, data.counts[k] || 0)), h('a', { href: '/api/admin/orders/export.csv', class: 'ml-auto bg-white border text-slate-700 hover:bg-amber-100 text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1' }, icon('fa-solid fa-file-csv'), 'Esporta CSV')),
      list.length ? h('div', { class: 'space-y-3' }, list) : card(h('p', { class: 'text-center text-slate-500 text-sm py-8' }, 'Nessun ordine per ora.'))
    );
  }

  /* ------------------------------ articoli ------------------------------ */
  let cats = {};
  async function renderProducts(body) {
    const [{ products }, cfg] = await Promise.all([api('/api/admin/products'), fetch('/api/config').then((r) => r.json())]);
    cats = cfg.categories;
    let editing = null;

    const msg = msgBox();
    const f = {
      title: h('input', { class: inputCls, required: true, maxlength: 120, placeholder: 'Es. Fiocco Natalizio Rosso Velluto' }),
      category: h('select', { class: inputCls }, Object.entries(cats).map(([k, v]) => h('option', { value: k }, v))),
      price: h('input', { class: inputCls, required: true, inputmode: 'decimal', placeholder: '28,00' }),
      stock: h('input', { class: inputCls, required: true, type: 'number', min: 0, max: 100000, placeholder: '10' }),
      image: h('input', { class: inputCls, placeholder: 'https://… oppure carica un file' }),
      desc: h('textarea', { class: inputCls, rows: 3, maxlength: 1000, placeholder: 'Realizzato a mano con materiali di prima qualità…' }),
      active: h('input', { type: 'checkbox', checked: true }),
    };
    const preview = h('img', { class: 'hidden h-24 w-24 object-cover rounded-lg border border-amber-200', alt: 'Anteprima' });
    const showPreview = () => {
      if (f.image.value) { preview.src = f.image.value; preview.classList.remove('hidden'); } else preview.classList.add('hidden');
    };
    f.image.addEventListener('change', showPreview);
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', class: 'text-xs' });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      say(msg, 'Caricamento immagine…', true);
      try {
        f.image.value = await uploadImage(file.files[0], { maxW: 1200, maxH: 1200, keepAlpha: false });
        showPreview();
        say(msg, 'Immagine caricata. Ricorda di salvare l\'articolo.', true);
      } catch (e) { say(msg, e.message, false); }
    });

    const formTitle = h('span', {}, 'Nuovo articolo');
    const reset = () => {
      editing = null;
      formTitle.textContent = 'Nuovo articolo';
      f.title.value = ''; f.price.value = ''; f.stock.value = ''; f.image.value = ''; f.desc.value = ''; f.active.checked = true; f.category.selectedIndex = 0; file.value = '';
      showPreview();
    };
    const form = h('form', { class: 'space-y-3' },
      labeled('Nome articolo', f.title),
      labeled('Categoria', f.category),
      h('div', { class: 'grid grid-cols-2 gap-3' }, labeled('Prezzo (€, IVA inclusa)', f.price), labeled('Stock disponibile', f.stock)),
      labeled('Immagine', h('div', { class: 'space-y-2' }, f.image, file, preview)),
      labeled('Descrizione', f.desc),
      h('label', { class: 'flex items-center gap-2 text-xs font-semibold text-slate-700' }, f.active, 'Visibile nel negozio'),
      h('div', { class: 'flex gap-2' },
        h('button', { type: 'submit', class: 'flex-1 bg-red-700 hover:bg-red-800 text-white font-bold py-2.5 rounded-lg text-sm shadow transition' }, 'Salva articolo'),
        btn('Annulla', 'bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 rounded-lg text-sm', reset)),
      msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const priceCents = toCents(f.price.value);
      if (!Number.isFinite(priceCents) || priceCents < 0) return say(msg, 'Prezzo non valido.', false);
      const payload = { title: f.title.value, category: f.category.value, priceCents, stock: Number(f.stock.value), image: f.image.value.trim(), description: f.desc.value, active: f.active.checked };
      try {
        if (editing) await api(`/api/admin/products/${editing}`, { method: 'PUT', body: payload });
        else await api('/api/admin/products', { method: 'POST', body: payload });
        renderTab(body);
      } catch (e2) { say(msg, e2.message, false); }
    });

    const rows = products.map((p) => h('tr', { class: p.active ? '' : 'opacity-50' },
      h('td', { class: 'p-3 font-semibold' }, p.title, p.active ? null : h('span', { class: 'ml-2 text-[10px] uppercase text-slate-500' }, '(nascosto)')),
      h('td', { class: 'p-3 text-[10px] uppercase text-slate-500' }, cats[p.category] || p.category),
      h('td', { class: 'p-3' }, money(p.priceCents)),
      h('td', { class: 'p-3 font-bold ' + (p.stock === 0 ? 'text-red-600' : '') }, `${p.stock} pz`),
      h('td', { class: 'p-3 text-right whitespace-nowrap' },
        btn('Modifica', 'text-sky-700 hover:underline font-bold mr-3', () => {
          editing = p.id; formTitle.textContent = `Modifica: ${p.title}`;
          f.title.value = p.title; f.category.value = p.category; f.price.value = fromCents(p.priceCents).replace('.', ','); f.stock.value = p.stock; f.image.value = p.image; f.desc.value = p.description; f.active.checked = p.active; showPreview();
          form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }),
        btn('Elimina', 'text-red-600 hover:text-red-800 font-bold', async () => {
          if (!confirm(`Eliminare "${p.title}" dal catalogo? I coupon collegati verranno eliminati.`)) return;
          try { await api(`/api/admin/products/${p.id}`, { method: 'DELETE' }); renderTab(body); } catch (e) { alert(e.message); }
        }))));

    body.replaceChildren(h('div', { class: 'grid grid-cols-1 lg:grid-cols-3 gap-8' },
      card(title('fa-solid fa-plus-circle', formTitle), form),
      h('div', { class: 'lg:col-span-2' }, card(title('fa-solid fa-list-check', 'Catalogo e magazzino'), h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full text-left text-xs text-slate-700' },
        h('thead', { class: 'bg-amber-50 uppercase text-amber-900 text-[10px] font-bold' }, h('tr', {}, ['Articolo', 'Categoria', 'Prezzo', 'Stock', ''].map((t) => h('th', { class: 'p-3' }, t)))),
        h('tbody', { class: 'divide-y divide-slate-100' }, rows)))))));
  }

  /* ------------------------------ coupon ------------------------------ */
  async function renderCoupons(body) {
    const [{ coupons }, { products }] = await Promise.all([api('/api/admin/coupons'), api('/api/admin/products')]);
    const msg = msgBox();
    const f = {
      code: h('input', { class: inputCls + ' uppercase font-mono', required: true, maxlength: 30, placeholder: 'NATALE15' }),
      percent: h('input', { class: inputCls, type: 'number', min: 1, max: 90, required: true, placeholder: '15' }),
      product: h('select', { class: inputCls }, h('option', { value: '' }, 'Tutto il carrello'), products.map((p) => h('option', { value: p.id }, p.title))),
      expires: h('input', { class: inputCls, type: 'date' }),
    };
    const form = h('form', { class: 'space-y-3' },
      labeled('Codice', f.code), labeled('Sconto (%)', f.percent), labeled('Vale per', f.product), labeled('Scade il (facoltativo)', f.expires),
      h('button', { type: 'submit', class: 'w-full bg-red-700 hover:bg-red-800 text-white font-bold py-2.5 rounded-lg text-sm shadow' }, 'Crea coupon'), msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/coupons', { method: 'POST', body: { code: f.code.value, percent: Number(f.percent.value), productId: f.product.value || null, expiresAt: f.expires.value || null } });
        renderTab(body);
      } catch (e2) { say(msg, e2.message, false); }
    });
    const name = (id) => products.find((p) => p.id === id)?.title || '—';
    const rows = coupons.map((c) => h('tr', { class: c.active ? '' : 'opacity-50' },
      h('td', { class: 'p-3 font-mono font-bold text-red-700' }, c.code),
      h('td', { class: 'p-3' }, `−${c.percent}%`),
      h('td', { class: 'p-3' }, c.productId ? name(c.productId) : 'Tutto il carrello'),
      h('td', { class: 'p-3' }, c.expiresAt || 'Mai'),
      h('td', { class: 'p-3' }, c.uses),
      h('td', { class: 'p-3 text-right whitespace-nowrap' },
        btn(c.active ? 'Disattiva' : 'Attiva', 'text-sky-700 hover:underline font-bold mr-3', async () => {
          try { await api(`/api/admin/coupons/${c.code}`, { method: 'PUT', body: { percent: c.percent, productId: c.productId, expiresAt: c.expiresAt, active: !c.active } }); renderTab(body); } catch (e) { alert(e.message); }
        }),
        btn('Elimina', 'text-red-600 hover:text-red-800 font-bold', async () => {
          if (!confirm(`Eliminare il coupon ${c.code}?`)) return;
          try { await api(`/api/admin/coupons/${c.code}`, { method: 'DELETE' }); renderTab(body); } catch (e) { alert(e.message); }
        }))));
    body.replaceChildren(h('div', { class: 'grid grid-cols-1 lg:grid-cols-3 gap-8' },
      card(title('fa-solid fa-ticket', 'Nuovo coupon'), form),
      h('div', { class: 'lg:col-span-2' }, card(title('fa-solid fa-tags', 'Coupon attivi'), h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full text-left text-xs text-slate-700' },
        h('thead', { class: 'bg-amber-50 uppercase text-amber-900 text-[10px] font-bold' }, h('tr', {}, ['Codice', 'Sconto', 'Vale per', 'Scadenza', 'Usi', ''].map((t) => h('th', { class: 'p-3' }, t)))),
        h('tbody', { class: 'divide-y divide-slate-100' }, rows)))))));
  }

  /* ------------------------------ aspetto del sito ------------------------------ */
  async function renderLook(body) {
    const { content: c, defaults, themes } = await api('/api/admin/content');
    const msg = msgBox();
    const txt = (v, extra = {}) => h('input', { class: inputCls, value: v ?? '', ...extra });
    const f = {
      brandMain: txt(c.brandMain, { maxlength: 30, required: true }),
      brandAccent: txt(c.brandAccent, { maxlength: 40 }),
      brandTagline: txt(c.brandTagline, { maxlength: 60 }),
      navQuoteLabel: txt(c.navQuoteLabel, { maxlength: 40, required: true }),
      floatQuoteLabel: txt(c.floatQuoteLabel, { maxlength: 40, required: true }),
      heroVisible: h('input', { type: 'checkbox', checked: c.heroVisible }),
      badgeLabel: txt(c.badgeLabel, { maxlength: 40 }),
      badge2Label: txt(c.badge2Label, { maxlength: 40 }),
      heroTitle: txt(c.heroTitle, { maxlength: 140 }),
      heroText: h('textarea', { class: inputCls, rows: 3, maxlength: 400 }),
      btn1Label: txt(c.btn1Label, { maxlength: 30 }),
      btn2Label: txt(c.btn2Label, { maxlength: 30 }),
      footerNote: h('textarea', { class: inputCls, rows: 2, maxlength: 300 }),
      footerLinksTitle: txt(c.footerLinksTitle, { maxlength: 40, required: true }),
      footerPayTitle: txt(c.footerPayTitle, { maxlength: 40 }),
      footerPayText: h('textarea', { class: inputCls, rows: 3, maxlength: 400 }),
      copyrightText: txt(c.copyrightText, { maxlength: 150, placeholder: '© 2026 Nome del negozio (se vuoto)' }),
      showAdminLink: h('input', { type: 'checkbox', checked: c.showAdminLink }),
    };
    f.heroText.value = c.heroText;
    f.footerNote.value = c.footerNote;
    f.footerPayText.value = c.footerPayText;

    // colore del riquadro
    let theme = c.heroTheme;
    const swatches = h('div', { class: 'flex flex-wrap gap-2' });
    const drawThemes = () => swatches.replaceChildren(...Object.entries(themes).map(([key, t]) =>
      h('button', { type: 'button', title: t.label, 'aria-pressed': String(theme === key), class: 'w-24 rounded-lg border-2 overflow-hidden text-[10px] font-bold text-slate-700 ' + (theme === key ? 'border-red-700 ring-2 ring-red-300' : 'border-slate-200 hover:border-slate-400'), onclick: () => { theme = key; drawThemes(); } },
        h('div', { class: 'h-8 bg-gradient-to-r ' + t.cls }), h('div', { class: 'py-1 bg-white' }, t.label))));
    drawThemes();

    // immagine di sfondo del riquadro
    let heroImage = c.heroImage || '';
    const heroPrev = h('img', { alt: 'Anteprima sfondo', class: 'h-20 w-40 object-cover rounded-lg border border-amber-200 ' + (heroImage ? '' : 'hidden'), src: heroImage || undefined });
    const heroFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'text-xs' });
    const heroMsg = msgBox();
    heroFile.addEventListener('change', async () => {
      if (!heroFile.files[0]) return;
      say(heroMsg, 'Caricamento immagine…', true);
      try {
        heroImage = await uploadImage(heroFile.files[0], { maxW: 1600, maxH: 900, keepAlpha: false });
        heroPrev.src = heroImage; heroPrev.classList.remove('hidden');
        say(heroMsg, 'Immagine caricata. Premi "Salva modifiche" per pubblicarla.', true);
      } catch (e) { say(heroMsg, e.message, false); }
    });
    const heroRemove = btn('Togli immagine', 'text-xs text-red-600 hover:underline font-bold', () => {
      heroImage = ''; heroPrev.classList.add('hidden'); heroFile.value = '';
      say(heroMsg, 'Immagine rimossa. Premi "Salva modifiche" per pubblicare.', true);
    });

    // link del piè di pagina
    let links = (c.footerLinks || []).map((l) => ({ ...l }));
    const linksBox = h('div', { class: 'space-y-2' });
    const drawLinks = () => {
      linksBox.replaceChildren(
        ...links.map((l, i) => {
          const lab = h('input', { class: inputCls, maxlength: 40, placeholder: 'Testo (es. Instagram)', value: l.label });
          const url = h('input', { class: inputCls, maxlength: 300, placeholder: 'https://…', value: l.url });
          lab.addEventListener('input', () => { links[i].label = lab.value; });
          url.addEventListener('input', () => { links[i].url = url.value; });
          return h('div', { class: 'flex gap-2' }, lab, url, btn('✕', 'px-3 rounded-lg bg-slate-100 hover:bg-red-100 text-slate-600 font-bold', () => { links.splice(i, 1); drawLinks(); }, { 'aria-label': 'Rimuovi link' }));
        }),
        links.length < 8 ? btn('+ Aggiungi un link', 'text-xs font-bold text-sky-700 hover:underline', () => { links.push({ label: '', url: '' }); drawLinks(); }) : null
      );
    };
    drawLinks();

    const collect = () => ({
      brandMain: f.brandMain.value, brandAccent: f.brandAccent.value, brandTagline: f.brandTagline.value,
      navQuoteLabel: f.navQuoteLabel.value, floatQuoteLabel: f.floatQuoteLabel.value,
      heroVisible: f.heroVisible.checked, heroTheme: theme, heroImage,
      badgeLabel: f.badgeLabel.value, badge2Label: f.badge2Label.value, heroTitle: f.heroTitle.value, heroText: f.heroText.value,
      btn1Label: f.btn1Label.value, btn2Label: f.btn2Label.value,
      footerNote: f.footerNote.value, footerLinksTitle: f.footerLinksTitle.value,
      footerLinks: links.filter((l) => l.label.trim() || l.url.trim()),
      footerPayTitle: f.footerPayTitle.value, footerPayText: f.footerPayText.value,
      copyrightText: f.copyrightText.value, showAdminLink: f.showAdminLink.checked,
    });

    const save = async (payload, okText) => {
      try {
        await api('/api/admin/content', { method: 'PUT', body: payload });
        say(msg, okText, true);
        return true;
      } catch (e) { say(msg, e.message, false); return false; }
    };

    const hint = (t) => h('p', { class: 'text-[11px] text-slate-500 -mt-1' }, t);
    const section = (ic, t, ...kids) => card(title(ic, t), h('div', { class: 'space-y-3' }, ...kids));

    const form = h('form', { class: 'space-y-8' },
      section('fa-solid fa-window-maximize', 'Testata (in alto)',
        hint('Il logo e il messaggio della barra scura in alto si cambiano da Impostazioni.'),
        h('div', { class: 'grid sm:grid-cols-2 gap-3' }, labeled('Nome (parte scura)', f.brandMain), labeled('Nome (parte rossa)', f.brandAccent)),
        labeled('Sottotitolo sotto il nome (vuoto = nascosto)', f.brandTagline),
        h('div', { class: 'grid sm:grid-cols-2 gap-3' }, labeled('Pulsante "su misura" in alto', f.navQuoteLabel), labeled('Pulsante WhatsApp fluttuante', f.floatQuoteLabel))),
      section('fa-solid fa-rectangle-ad', 'Riquadro principale (la parte colorata)',
        h('label', { class: 'flex items-center gap-2 text-sm font-semibold text-slate-700' }, f.heroVisible, 'Mostra il riquadro nella pagina iniziale'),
        labeled('Colore', swatches),
        labeled('Immagine di sfondo (facoltativa)', h('div', { class: 'space-y-2' }, heroFile, heroPrev, h('div', {}, heroRemove), heroMsg)),
        h('div', { class: 'grid sm:grid-cols-2 gap-3' }, labeled('Etichetta gialla (vuoto = nascosta)', f.badgeLabel), labeled('Seconda etichetta (vuoto = nascosta)', f.badge2Label)),
        labeled('Titolo grande', f.heroTitle),
        labeled('Testo sotto il titolo', f.heroText),
        h('div', { class: 'grid sm:grid-cols-2 gap-3' }, labeled('Primo pulsante (porta ai prodotti; vuoto = nascosto)', f.btn1Label), labeled('Secondo pulsante (apre il preventivo; vuoto = nascosto)', f.btn2Label))),
      section('fa-solid fa-shoe-prints', 'Piè di pagina',
        hint('Ragione sociale, partita IVA, sede ed email si cambiano da Impostazioni.'),
        labeled('Nota sotto i dati del venditore (es. orari, vuoto = nascosta)', f.footerNote),
        labeled('Titolo della colonna dei link', f.footerLinksTitle),
        labeled('Link aggiuntivi (Termini e Privacy ci sono già). Accettati https://, mailto:, tel: o /percorso', linksBox),
        labeled('Titolo della colonna pagamenti (vuoto = nascosto)', f.footerPayTitle),
        labeled('Testo della colonna pagamenti', f.footerPayText),
        labeled('Riga del copyright', f.copyrightText),
        h('label', { class: 'flex items-center gap-2 text-sm font-semibold text-slate-700' }, f.showAdminLink, 'Mostra il link "Area riservata" nel piè di pagina (puoi sempre aprire /admin scrivendolo)')),
      h('div', { class: 'flex flex-wrap items-center gap-3' },
        h('button', { type: 'submit', class: 'bg-red-700 hover:bg-red-800 text-white font-bold px-6 py-2.5 rounded-lg text-sm shadow transition' }, 'Salva modifiche'),
        btn('Ripristina testi originali', 'bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-2.5 rounded-lg text-sm', async () => {
          if (!confirm('Ripristinare tutti i testi e i colori originali del sito?')) return;
          if (await save(defaults, 'Testi originali ripristinati.')) renderTab(body);
        }),
        h('a', { href: '/', target: '_blank', rel: 'noopener', class: 'text-sm font-bold text-sky-700 hover:underline' }, 'Apri il sito in una nuova scheda ↗')),
      msg);
    form.addEventListener('submit', async (e) => { e.preventDefault(); await save(collect(), 'Modifiche pubblicate! Ricarica il sito per vederle.'); });

    body.replaceChildren(form);
  }

  /* ------------------------------ impostazioni ------------------------------ */
  async function renderSettings(body) {
    const { settings: s, payments } = await api('/api/admin/settings');
    const msg = msgBox();
    const f = {
      shopName: h('input', { class: inputCls, required: true, maxlength: 100, value: s.shopName }),
      announcement: h('input', { class: inputCls, maxlength: 200, value: s.announcement }),
      whatsapp: h('input', { class: inputCls, required: true, value: s.whatsapp, placeholder: '393401234567' }),
      shipping: h('input', { class: inputCls, inputmode: 'decimal', value: fromCents(s.shippingCents).replace('.', ',') }),
      free: h('input', { class: inputCls, inputmode: 'decimal', value: fromCents(s.freeShippingOverCents).replace('.', ',') }),
      iban: h('input', { class: inputCls + ' font-mono', value: s.bankIban, placeholder: 'IT00 X000 0000 0000 0000 0000 000' }),
      holder: h('input', { class: inputCls, value: s.bankHolder, maxlength: 100 }),
      legalName: h('input', { class: inputCls, value: s.legalName, maxlength: 150 }),
      vat: h('input', { class: inputCls, value: s.vat, maxlength: 40 }),
      email: h('input', { class: inputCls, type: 'email', value: s.contactEmail, maxlength: 120 }),
      address: h('input', { class: inputCls, value: s.businessAddress, maxlength: 200 }),
    };

    // logo
    let logoUrl = s.logo;
    const logoPrev = h('img', { src: logoUrl, alt: 'Logo', class: 'max-h-24 w-auto object-contain rounded-lg border border-amber-200 bg-white p-1' });
    const logoMsg = msgBox();
    const logoFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', class: 'hidden', id: 'logo-file' });
    const dz = h('label', { for: 'logo-file', class: 'flex flex-col items-center justify-center w-full px-4 py-6 border-2 border-dashed border-amber-300 rounded-xl cursor-pointer bg-amber-50/40 hover:bg-amber-50 transition text-center' },
      icon('fa-solid fa-cloud-arrow-up text-3xl text-amber-500 mb-2'), h('span', { class: 'text-sm font-bold text-slate-800' }, 'Clicca per scegliere il logo o trascinalo qui'), h('span', { class: 'text-[11px] text-slate-500 mt-1' }, 'PNG, JPG, WEBP, GIF o SVG · viene ridimensionato in automatico'));
    const handleLogo = async (file) => {
      if (!file) return;
      say(logoMsg, 'Caricamento…', true);
      try {
        const url = await uploadImage(file, { maxW: 900, maxH: 300, keepAlpha: true });
        logoUrl = url; logoPrev.src = url;
        await saveSettings(true);
        say(logoMsg, 'Logo caricato e pubblicato sul sito!', true);
      } catch (e) { say(logoMsg, e.message, false); }
    };
    logoFile.addEventListener('change', () => handleLogo(logoFile.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('bg-amber-100'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('bg-amber-100'); }));
    dz.addEventListener('drop', (e) => handleLogo(e.dataTransfer.files[0]));
    const logoUrlIn = h('input', { class: inputCls, type: 'url', placeholder: 'https://tuosito.it/logo.png' });

    async function saveSettings(silent) {
      const shippingCents = toCents(f.shipping.value || '0');
      const freeShippingOverCents = toCents(f.free.value || '0');
      if (![shippingCents, freeShippingOverCents].every((n) => Number.isFinite(n) && n >= 0)) throw new Error('Importi di spedizione non validi.');
      await api('/api/admin/settings', { method: 'PUT', body: { shopName: f.shopName.value, announcement: f.announcement.value, logo: logoUrl, whatsapp: f.whatsapp.value, shippingCents, freeShippingOverCents, bankIban: f.iban.value, bankHolder: f.holder.value, legalName: f.legalName.value, vat: f.vat.value, contactEmail: f.email.value, businessAddress: f.address.value } });
      if (!silent) say(msg, 'Impostazioni salvate.', true);
    }
    const form = h('form', { class: 'space-y-3' },
      labeled('Nome del negozio', f.shopName), labeled('Messaggio nella barra in alto', f.announcement),
      labeled('Numero WhatsApp (con prefisso, solo cifre)', f.whatsapp),
      h('div', { class: 'grid grid-cols-2 gap-3' }, labeled('Spedizione (€)', f.shipping), labeled('Gratis oltre (€, 0 = mai)', f.free)),
      h('p', { class: 'text-xs font-bold text-slate-700 pt-2' }, 'Bonifico bancario (lascia vuoto l\'IBAN per disattivarlo)'),
      labeled('IBAN', f.iban), labeled('Intestatario', f.holder),
      h('p', { class: 'text-xs font-bold text-slate-700 pt-2' }, 'Dati del venditore (obbligatori per legge nel sito)'),
      labeled('Ragione sociale / nome e cognome', f.legalName), labeled('Partita IVA / Codice fiscale', f.vat), labeled('Email di contatto', f.email), labeled('Sede / indirizzo', f.address),
      h('button', { type: 'submit', class: 'w-full bg-red-700 hover:bg-red-800 text-white font-bold py-2.5 rounded-lg text-sm shadow' }, 'Salva impostazioni'), msg);
    form.addEventListener('submit', async (e) => { e.preventDefault(); try { await saveSettings(false); } catch (e2) { say(msg, e2.message, false); } });

    // password
    const pm = msgBox();
    const cur = h('input', { type: 'password', class: inputCls, autocomplete: 'current-password', required: true });
    const nw = h('input', { type: 'password', class: inputCls, autocomplete: 'new-password', required: true, minlength: 10 });
    const pf = h('form', { class: 'space-y-3' }, labeled('Password attuale', cur), labeled('Nuova password (min. 10 caratteri)', nw), h('button', { type: 'submit', class: 'w-full bg-slate-900 text-white font-bold py-2.5 rounded-lg text-sm' }, 'Cambia password'), pm);
    pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/admin/password', { method: 'POST', body: { currentPassword: cur.value, newPassword: nw.value } }); cur.value = ''; nw.value = ''; say(pm, 'Password aggiornata.', true); } catch (e2) { say(pm, e2.message, false); }
    });

    const flag = (ok, text, hint) => h('li', { class: 'flex items-start gap-2' }, icon(ok ? 'fa-solid fa-circle-check text-emerald-600 mt-0.5' : 'fa-solid fa-circle-xmark text-red-500 mt-0.5'), h('span', {}, h('b', {}, text), hint ? h('span', { class: 'block text-slate-500' }, hint) : null));

    body.replaceChildren(h('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-8' },
      h('div', { class: 'space-y-8' },
        card(title('fa-solid fa-image', 'Logo del sito'),
          h('div', { class: 'grid sm:grid-cols-3 gap-4' }, h('div', { class: 'flex items-center justify-center bg-amber-50/60 border border-amber-200 rounded-xl p-3' }, logoPrev), h('div', { class: 'sm:col-span-2 space-y-3' }, dz, logoFile, logoMsg,
            h('div', { class: 'flex gap-2' }, logoUrlIn, btn('Usa URL', 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-3 rounded-lg text-sm whitespace-nowrap', async () => {
              if (!logoUrlIn.value) return;
              try { logoUrl = logoUrlIn.value.trim(); logoPrev.src = logoUrl; await saveSettings(true); say(logoMsg, 'Logo aggiornato.', true); } catch (e) { say(logoMsg, e.message, false); }
            })),
            btn('Ripristina logo G&T originale', 'bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold px-4 py-2 rounded-lg text-sm', async () => {
              try { logoUrl = '/img/logo-default.svg'; logoPrev.src = logoUrl; await saveSettings(true); say(logoMsg, 'Logo originale ripristinato.', true); } catch (e) { say(logoMsg, e.message, false); }
            })))),
        card(title('fa-solid fa-key', 'Sicurezza'), pf),
        card(title('fa-solid fa-credit-card', 'Stato dei pagamenti'), h('ul', { class: 'space-y-3 text-xs' },
          flag(payments.stripe, 'Carte (Stripe)', payments.stripe ? null : 'Imposta STRIPE_SECRET_KEY nelle variabili d\'ambiente.'),
          flag(payments.stripeWebhook, 'Webhook Stripe', payments.stripeWebhook ? `Endpoint: ${payments.baseUrl}/api/webhooks/stripe` : 'Imposta STRIPE_WEBHOOK_SECRET: senza, i pagamenti non vengono confermati.'),
          flag(payments.paypal, 'PayPal', payments.paypal ? null : 'Imposta PAYPAL_CLIENT_ID e PAYPAL_CLIENT_SECRET.'),
          flag(Boolean(s.bankIban), 'Bonifico', s.bankIban ? null : 'Inserisci un IBAN per attivarlo.')))),
      card(title('fa-solid fa-store', 'Negozio, spedizione e dati legali'), form)));
  }

  /* ------------------------------ avvio ------------------------------ */
  api('/api/admin/me').then(showDashboard).catch(showLogin);
})();
