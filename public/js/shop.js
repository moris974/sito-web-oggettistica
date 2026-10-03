'use strict';
(() => {
  /* ------------------------------ utilità ------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const money = (cents) => new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
  const PLACEHOLDER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#fef3c7"/><text x="200" y="160" text-anchor="middle" font-family="Georgia,serif" font-size="28" fill="#b45309">G&amp;T</text></svg>'
    );

  /** Crea elementi DOM senza mai usare innerHTML con dati dinamici (niente XSS). */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const icon = (cls) => h('i', { class: cls, 'aria-hidden': 'true' });

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* risposta vuota */
    }
    if (!res.ok) {
      const err = new Error(data.error || 'Si è verificato un errore. Riprova.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ------------------------------ stato ------------------------------ */
  const state = {
    config: null,
    products: [],
    category: 'all',
    cart: { items: [], coupon: '' },
    quote: null,
    quoteSeq: 0,
  };

  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem('gt_cart_v2') || '{}');
      const items = Array.isArray(raw.items) ? raw.items : [];
      state.cart.items = items
        .map((i) => ({ id: Number(i.id), qty: Number(i.qty) }))
        .filter((i) => Number.isInteger(i.id) && Number.isInteger(i.qty) && i.qty > 0 && i.qty < 100);
      state.cart.coupon = typeof raw.coupon === 'string' ? raw.coupon.slice(0, 40) : '';
    } catch {
      state.cart = { items: [], coupon: '' };
    }
  }
  function saveCart() {
    try {
      localStorage.setItem('gt_cart_v2', JSON.stringify(state.cart));
    } catch {
      /* storage pieno o disabilitato: il carrello resta solo in memoria */
    }
  }
  const cartCount = () => state.cart.items.reduce((a, i) => a + i.qty, 0);

  /* ------------------------------ modale ------------------------------ */
  const modal = $('#modal');
  const modalBox = $('#modal-box');
  let lastFocus = null;

  function openModal(...content) {
    lastFocus = document.activeElement;
    modalBox.replaceChildren(
      h('button', { type: 'button', class: 'absolute top-4 right-4 text-slate-400 hover:text-slate-600 text-lg', 'aria-label': 'Chiudi', onclick: closeModal }, icon('fa-solid fa-xmark')),
      ...content
    );
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const first = modalBox.querySelector('input, select, textarea, button:not([aria-label="Chiudi"])');
    (first || modalBox.querySelector('button'))?.focus();
  }
  function closeModal() {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalBox.replaceChildren();
    lastFocus?.focus?.();
  }
  modal.addEventListener('mousedown', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!modal.classList.contains('hidden')) closeModal();
      else closeCart();
    }
  });

  /* ------------------------------ catalogo ------------------------------ */
  function applyConfig() {
    const c = state.config;
    $('#announcement').textContent = c.announcement || '';
    const logo = $('#site-logo');
    logo.onerror = () => {
      logo.onerror = null;
      logo.src = '/img/logo-default.svg';
    };
    logo.src = c.logo;
    document.title = `${c.shopName} | Creazioni Fatte a Mano`;
  }

  function renderFilters() {
    const wrap = $('#filters');
    const cats = [['all', 'Tutti gli articoli'], ...Object.entries(state.config.categories)];
    wrap.replaceChildren(
      ...cats.map(([key, label]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(state.category === key),
            class:
              'px-4 py-2 rounded-full text-xs font-semibold shadow-sm transition ' +
              (state.category === key ? 'bg-red-700 text-white' : 'bg-white text-slate-700 hover:bg-amber-100'),
            onclick: () => {
              state.category = key;
              renderFilters();
              renderProducts();
            },
          },
          label
        )
      )
    );
  }

  function productCard(p) {
    const out = p.stock <= 0;
    const withCoupon = p.coupon ? Math.round((p.priceCents * (100 - p.coupon.percent)) / 100) : null;
    const img = h('img', { src: p.image || PLACEHOLDER, alt: p.title, loading: 'lazy', class: 'w-full h-full object-cover' });
    img.addEventListener('error', () => {
      img.src = PLACEHOLDER;
    });

    return h(
      'article',
      { class: 'bg-white rounded-2xl border border-amber-200/80 shadow-sm hover:shadow-md transition overflow-hidden flex flex-col justify-between' },
      h(
        'div',
        {},
        h(
          'div',
          { class: 'relative h-52 bg-slate-100 overflow-hidden' },
          img,
          p.coupon && !out ? h('span', { class: 'absolute top-3 left-3 bg-red-700 text-white text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider shadow' }, `Coupon -${p.coupon.percent}%`) : null,
          out ? h('span', { class: 'absolute inset-0 bg-slate-900/55 text-white font-bold flex items-center justify-center tracking-wide' }, 'ESAURITO') : null
        ),
        h(
          'div',
          { class: 'p-5' },
          h('h3', { class: 'font-serif font-bold text-slate-900 text-base mb-1' }, p.title),
          h('p', { class: 'text-xs text-slate-500 mb-4 line-clamp-3' }, p.description),
          p.coupon
            ? h(
                'div',
                { class: 'bg-amber-50 p-2.5 rounded-lg border border-amber-200 border-dashed flex justify-between items-center mb-4 gap-2' },
                h('span', { class: 'text-[10px] text-amber-800 font-bold uppercase' }, 'Codice coupon:'),
                h(
                  'button',
                  {
                    type: 'button',
                    title: 'Copia e applica al carrello',
                    class: 'bg-white px-2 py-0.5 rounded border border-amber-300 font-mono text-xs font-bold text-red-700 hover:bg-amber-100',
                    onclick: () => {
                      state.cart.coupon = p.coupon.code;
                      saveCart();
                      $('#coupon-input').value = p.coupon.code;
                      showToastInCart(`Coupon ${p.coupon.code} pronto: si applica quando aggiungi l'articolo.`, true);
                      refreshQuote();
                    },
                  },
                  p.coupon.code
                )
              )
            : null,
          h(
            'div',
            { class: 'flex items-baseline gap-2 mb-2' },
            h('span', { class: 'text-xl font-bold text-red-700' }, money(p.priceCents)),
            withCoupon !== null ? h('span', { class: 'text-xs text-emerald-700 font-semibold' }, `${money(withCoupon)} con il coupon`) : null
          ),
          !out && p.stock <= 5 ? h('p', { class: 'text-[11px] text-amber-700 font-semibold' }, `Ultimi ${p.stock} pezzi disponibili`) : null
        )
      ),
      h(
        'div',
        { class: 'p-5 pt-0 space-y-2' },
        h(
          'button',
          {
            type: 'button',
            disabled: out,
            class: 'w-full bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-xs font-bold py-2.5 rounded-lg transition flex items-center justify-center gap-2',
            onclick: () => addToCart(p.id),
          },
          icon('fa-solid fa-cart-plus'),
          out ? 'Non disponibile' : 'Aggiungi al carrello'
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'w-full bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-300 text-xs font-bold py-2 rounded-lg transition flex items-center justify-center gap-1',
            onclick: () => openQuoteModal(`Vorrei un preventivo per l'articolo: "${p.title}".`),
          },
          icon('fa-brands fa-whatsapp text-sm'),
          'Ordina su misura'
        )
      )
    );
  }

  function renderProducts() {
    const list = state.category === 'all' ? state.products : state.products.filter((p) => p.category === state.category);
    $('#prodotti').replaceChildren(...list.map(productCard));
    $('#empty-msg').classList.toggle('hidden', list.length > 0);
  }

  /* ------------------------------ carrello ------------------------------ */
  const drawer = $('#cart-drawer');
  const backdrop = $('#cart-backdrop');

  function openCart() {
    drawer.classList.remove('translate-x-full');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.classList.remove('hidden');
    refreshQuote();
  }
  function closeCart() {
    drawer.classList.add('translate-x-full');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.classList.add('hidden');
  }

  function addToCart(id) {
    const p = state.products.find((x) => x.id === id);
    if (!p || p.stock <= 0) return;
    const line = state.cart.items.find((i) => i.id === id);
    const next = (line ? line.qty : 0) + 1;
    if (next > p.stock) {
      openCart();
      showToastInCart(`Disponibili solo ${p.stock} pezzi di questo articolo.`, false);
      return;
    }
    if (line) line.qty = next;
    else state.cart.items.push({ id, qty: 1 });
    saveCart();
    openCart();
  }

  function setQty(id, qty) {
    const p = state.products.find((x) => x.id === id);
    if (qty <= 0) state.cart.items = state.cart.items.filter((i) => i.id !== id);
    else {
      const line = state.cart.items.find((i) => i.id === id);
      if (!line) return;
      if (p && qty > p.stock) {
        showToastInCart(`Disponibili solo ${p.stock} pezzi.`, false);
        return;
      }
      line.qty = Math.min(99, qty);
    }
    saveCart();
    refreshQuote();
  }

  function showToastInCart(text, ok) {
    const el = $('#cart-msg');
    el.textContent = text;
    el.className = 'text-xs font-semibold ' + (ok ? 'text-emerald-700' : 'text-red-700');
  }
  function clearCartMsg() {
    $('#cart-msg').className = 'hidden text-xs font-semibold';
    $('#cart-msg').textContent = '';
  }

  async function refreshQuote() {
    $('#cart-count').textContent = String(cartCount());
    const seq = ++state.quoteSeq;
    if (state.cart.items.length === 0) {
      state.quote = null;
      renderCart();
      return;
    }
    try {
      const q = await api('/api/cart/quote', { method: 'POST', body: { items: state.cart.items, coupon: state.cart.coupon } });
      if (seq !== state.quoteSeq) return;
      state.quote = q;
    } catch (e) {
      if (seq !== state.quoteSeq) return;
      const couponProblem = state.cart.coupon && /coupon/i.test(e.message);
      if (couponProblem) {
        state.cart.coupon = '';
        $('#coupon-input').value = '';
        saveCart();
        showToastInCart(e.message, false);
        return refreshQuote();
      }
      state.quote = null;
      showToastInCart(e.message, false);
    }
    renderCart();
  }

  function renderCart() {
    const box = $('#cart-items');
    const summary = $('#cart-summary');
    const q = state.quote;
    $('#go-checkout').disabled = !q;
    $('#coupon-input').value = state.cart.coupon || '';

    if (state.cart.items.length === 0) {
      box.replaceChildren(h('div', { class: 'text-center text-slate-400 py-16' }, icon('fa-solid fa-basket-shopping text-4xl mb-3'), h('p', { class: 'text-sm' }, 'Il carrello è vuoto.')));
      summary.replaceChildren();
      return;
    }
    if (!q) {
      box.replaceChildren(h('p', { class: 'text-sm text-slate-500 py-6' }, 'Aggiornamento del carrello…'));
      summary.replaceChildren();
      return;
    }

    box.replaceChildren(
      ...q.lines.map((l) => {
        const img = h('img', { src: l.image || PLACEHOLDER, alt: '', class: 'w-14 h-14 rounded object-cover' });
        img.addEventListener('error', () => {
          img.src = PLACEHOLDER;
        });
        const qtyBtn = (label, text, delta) =>
          h('button', { type: 'button', class: 'w-6 h-6 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 text-sm leading-none', 'aria-label': label, onclick: () => setQty(l.id, l.qty + delta) }, text);
        return h(
          'div',
          { class: 'flex gap-3 py-3 items-center' },
          img,
          h(
            'div',
            { class: 'flex-1 min-w-0' },
            h('h4', { class: 'text-xs font-bold text-slate-900' }, l.title),
            h(
              'p',
              { class: 'text-[11px] text-slate-500' },
              l.discounted ? [h('span', { class: 'line-through mr-1' }, money(l.listUnitCents)), h('span', { class: 'text-emerald-700 font-semibold' }, money(l.unitCents))] : money(l.unitCents)
            ),
            h('div', { class: 'flex items-center gap-2 mt-1' }, qtyBtn('Diminuisci quantità', '−', -1), h('span', { class: 'text-xs w-5 text-center font-semibold' }, l.qty), qtyBtn('Aumenta quantità', '+', 1), h('button', { type: 'button', class: 'ml-2 text-[11px] text-red-600 hover:underline', onclick: () => setQty(l.id, 0) }, 'Rimuovi'))
          ),
          h('span', { class: 'text-xs font-bold text-red-700 whitespace-nowrap' }, money(l.lineCents))
        );
      })
    );

    const row = (label, value, cls = '') => h('div', { class: 'flex justify-between ' + cls }, h('dt', {}, label), h('dd', {}, value));
    summary.replaceChildren(
      row('Subtotale', money(q.subtotalCents)),
      q.discountCents > 0 ? row(`Sconto${q.coupon ? ' (' + q.coupon.code + ')' : ''}`, '−' + money(q.discountCents), 'text-emerald-700 font-semibold') : null,
      row('Spedizione', q.shippingCents === 0 ? 'Gratuita' : money(q.shippingCents)),
      q.freeShippingRemainingCents > 0 ? h('p', { class: 'text-[11px] text-amber-700' }, `Aggiungi ${money(q.freeShippingRemainingCents)} per la spedizione gratuita.`) : null,
      row('Totale (IVA inclusa)', money(q.totalCents), 'font-bold text-base text-slate-900 pt-1 border-t border-slate-200')
    );
  }

  /* ------------------------------ checkout ------------------------------ */
  function field(id, label, attrs = {}) {
    const input = attrs.tag === 'textarea'
      ? h('textarea', { id, name: id, rows: 2, class: 'w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-red-600', ...attrs.props })
      : h('input', { id, name: id, class: 'w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-red-600', ...attrs.props });
    return h('div', { class: attrs.wrap || '' }, h('label', { for: id, class: 'block text-xs font-semibold text-slate-700 mb-1' }, label), input);
  }

  function openCheckout() {
    const q = state.quote;
    if (!q) return;
    const methods = state.config.methods;
    closeCart();

    if (methods.length === 0) {
      openModal(
        h('h3', { class: 'text-xl font-serif font-bold mb-2' }, 'Pagamenti non ancora attivi'),
        h('p', { class: 'text-sm text-slate-600 mb-4' }, 'Al momento non è possibile pagare online. Puoi inviarci il tuo ordine su WhatsApp e ti risponderemo subito.'),
        h('button', { type: 'button', class: 'bg-emerald-600 text-white font-bold px-4 py-2 rounded-lg text-sm', onclick: () => openQuoteModal('Vorrei ordinare gli articoli del mio carrello.') }, 'Scrivici su WhatsApp')
      );
      return;
    }

    const err = h('p', { id: 'co-error', class: 'hidden p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg font-semibold', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'w-full bg-red-700 hover:bg-red-800 disabled:opacity-60 text-white font-bold py-3 rounded-xl text-sm shadow transition flex items-center justify-center gap-2' }, icon('fa-solid fa-lock'), `Conferma e paga ${money(q.totalCents)}`);

    const form = h(
      'form',
      { class: 'space-y-3', novalidate: false },
      field('co-name', 'Nome e cognome', { props: { required: true, maxlength: 100, autocomplete: 'name' } }),
      h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, field('co-email', 'Email', { props: { type: 'email', required: true, maxlength: 120, autocomplete: 'email' } }), field('co-phone', 'Telefono', { props: { type: 'tel', required: true, maxlength: 30, autocomplete: 'tel' } })),
      field('co-address', 'Indirizzo di spedizione', { props: { required: true, maxlength: 200, autocomplete: 'street-address' } }),
      h('div', { class: 'grid grid-cols-3 gap-3' }, field('co-zip', 'CAP', { props: { required: true, maxlength: 10, autocomplete: 'postal-code' } }), field('co-city', 'Città', { wrap: 'col-span-2', props: { required: true, maxlength: 80, autocomplete: 'address-level2' } })),
      field('co-notes', 'Note (facoltative)', { tag: 'textarea', props: { maxlength: 500 } }),
      h(
        'fieldset',
        { class: 'space-y-2' },
        h('legend', { class: 'text-xs font-semibold text-slate-700 mb-1' }, 'Metodo di pagamento'),
        ...methods.map((m, i) =>
          h('label', { class: 'flex items-center gap-2 text-sm border rounded-lg px-3 py-2 cursor-pointer hover:bg-amber-50' }, h('input', { type: 'radio', name: 'provider', value: m.id, checked: i === 0 }), m.label)
        )
      ),
      h(
        'label',
        { class: 'flex items-start gap-2 text-xs text-slate-600' },
        h('input', { type: 'checkbox', id: 'co-terms', required: true, class: 'mt-0.5' }),
        h('span', {}, 'Ho letto e accetto i ', h('a', { href: '/termini', target: '_blank', rel: 'noopener', class: 'underline text-red-700' }, 'Termini di vendita'), ' e l\'', h('a', { href: '/privacy', target: '_blank', rel: 'noopener', class: 'underline text-red-700' }, 'Informativa privacy'), '.')
      ),
      err,
      submit
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      submit.disabled = true;
      const v = (id) => form.querySelector('#' + id).value;
      try {
        const res = await api('/api/checkout', {
          method: 'POST',
          body: {
            items: state.cart.items,
            coupon: state.cart.coupon,
            provider: form.querySelector('input[name=provider]:checked').value,
            acceptTerms: form.querySelector('#co-terms').checked,
            customer: { name: v('co-name'), email: v('co-email'), phone: v('co-phone'), address: v('co-address'), zip: v('co-zip'), city: v('co-city'), notes: v('co-notes') },
          },
        });
        if (res.url) {
          window.location.assign(res.url);
          return;
        }
        state.cart = { items: [], coupon: '' };
        saveCart();
        await refreshQuote();
        showBankInstructions(res);
      } catch (e2) {
        err.textContent = e2.message;
        err.classList.remove('hidden');
        submit.disabled = false;
        if (e2.status === 409 || e2.status === 400) {
          // stock o coupon cambiati: riallinea catalogo e carrello
          loadProducts().then(refreshQuote);
        }
      }
    });

    openModal(h('h3', { class: 'text-xl font-serif font-bold mb-1' }, 'Dati per la consegna'), h('p', { class: 'text-xs text-slate-500 mb-4' }, `Totale ordine: ${money(q.totalCents)} (IVA inclusa)`), form);
  }

  function showBankInstructions(res) {
    const row = (l, v) => h('div', { class: 'flex justify-between gap-4 py-1.5 border-b border-slate-100 text-sm' }, h('span', { class: 'text-slate-500' }, l), h('span', { class: 'font-mono font-semibold text-right break-all' }, v));
    openModal(
      h('div', { class: 'text-center mb-4' }, icon('fa-solid fa-circle-check text-4xl text-emerald-600'), h('h3', { class: 'text-xl font-serif font-bold mt-2' }, 'Ordine ricevuto!')),
      h('p', { class: 'text-sm text-slate-600 mb-3' }, `Il tuo ordine ${res.orderId} è registrato. Per confermarlo effettua il bonifico con questi dati: spediremo appena riceviamo il pagamento.`),
      row('Importo', money(res.bank.totalCents)),
      row('IBAN', res.bank.iban),
      res.bank.holder ? row('Intestatario', res.bank.holder) : null,
      row('Causale', res.bank.reason),
      h('button', { type: 'button', class: 'mt-5 w-full bg-slate-900 text-white font-bold py-2.5 rounded-lg text-sm', onclick: closeModal }, 'Ho capito')
    );
  }

  /* ------------------------------ ritorno dai pagamenti ------------------------------ */
  async function handleReturn() {
    const params = new URLSearchParams(location.search);
    const order = params.get('ordine');
    const esito = params.get('esito');
    if (!esito) return;
    history.replaceState(null, '', location.pathname);

    if (esito === 'annullato') {
      openModal(h('h3', { class: 'text-xl font-serif font-bold mb-2' }, 'Pagamento annullato'), h('p', { class: 'text-sm text-slate-600 mb-4' }, 'Nessun addebito è stato effettuato. Il tuo carrello è ancora qui: puoi riprovare quando vuoi.'), h('button', { type: 'button', class: 'bg-slate-900 text-white font-bold px-4 py-2 rounded-lg text-sm', onclick: () => { closeModal(); openCart(); } }, 'Torna al carrello'));
      return;
    }
    if (esito === 'ko' || !order || !/^GT-[A-Z0-9]{8}$/.test(order)) {
      openModal(h('h3', { class: 'text-xl font-serif font-bold mb-2' }, 'Pagamento non riuscito'), h('p', { class: 'text-sm text-slate-600 mb-4' }, 'Non siamo riusciti a confermare il pagamento. Se ti risulta un addebito, scrivici su WhatsApp indicando il numero ordine.'), h('button', { type: 'button', class: 'bg-slate-900 text-white font-bold px-4 py-2 rounded-lg text-sm', onclick: closeModal }, 'Chiudi'));
      return;
    }

    // esito ok: il webhook può arrivare qualche secondo dopo il redirect
    openModal(h('div', { class: 'text-center py-4' }, icon('fa-solid fa-spinner fa-spin text-3xl text-amber-600'), h('p', { class: 'mt-3 text-sm text-slate-600' }, 'Stiamo confermando il tuo pagamento…')));
    let status = 'pending';
    for (let i = 0; i < 12; i++) {
      try {
        status = (await api(`/api/orders/${order}/status`)).status;
      } catch {
        break;
      }
      if (status === 'paid' || status === 'shipped') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (status === 'paid' || status === 'shipped') {
      state.cart = { items: [], coupon: '' };
      saveCart();
      refreshQuote();
      openModal(
        h('div', { class: 'text-center' }, icon('fa-solid fa-circle-check text-5xl text-emerald-600'), h('h3', { class: 'text-xl font-serif font-bold mt-3 mb-1' }, 'Grazie per il tuo ordine!'), h('p', { class: 'text-sm text-slate-600 mb-1' }, `Pagamento confermato. Numero ordine: ${order}`), h('p', { class: 'text-xs text-slate-500 mb-5' }, 'Ti contatteremo per la spedizione.'), h('button', { type: 'button', class: 'bg-slate-900 text-white font-bold px-5 py-2 rounded-lg text-sm', onclick: closeModal }, 'Continua lo shopping'))
      );
    } else {
      openModal(h('h3', { class: 'text-xl font-serif font-bold mb-2' }, 'Pagamento in verifica'), h('p', { class: 'text-sm text-slate-600 mb-4' }, `Non abbiamo ancora ricevuto la conferma per l'ordine ${order}. Di solito arriva entro pochi minuti; se non vedi nulla scrivici su WhatsApp con il numero ordine.`), h('button', { type: 'button', class: 'bg-slate-900 text-white font-bold px-4 py-2 rounded-lg text-sm', onclick: closeModal }, 'Chiudi'));
    }
  }

  /* ------------------------------ preventivo WhatsApp ------------------------------ */
  function openQuoteModal(prefill = '') {
    const types = ['Fiocchi Natalizi Extra Large', 'Bomboniere fatte a mano', 'Ghirlande Fuoriporta', 'Lotto Articoli per Mercatino'];
    const form = h(
      'form',
      { class: 'space-y-4' },
      field('q-name', 'Nome e cognome', { props: { required: true, maxlength: 80, placeholder: 'Es. Laura Rossi' } }),
      h('div', {}, h('label', { for: 'q-type', class: 'block text-xs font-semibold text-slate-700 mb-1' }, 'Articolo o evento'), h('select', { id: 'q-type', class: 'w-full px-3 py-2 border rounded-lg text-sm outline-none' }, types.map((t) => h('option', { value: t }, t)))),
      field('q-details', 'Dettagli della richiesta', { tag: 'textarea', props: { required: true, maxlength: 800, rows: 3, placeholder: 'Es. Desidero 40 bomboniere con nastri in raso verde…' } }),
      h('button', { type: 'submit', class: 'w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg text-sm shadow transition flex items-center justify-center gap-2' }, icon('fa-brands fa-whatsapp text-lg'), 'Invia richiesta via WhatsApp')
    );
    form.querySelector('#q-details').value = prefill;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = `Ciao ${state.config.shopName}! Sono ${form.querySelector('#q-name').value.trim()}. Vorrei un preventivo per: ${form.querySelector('#q-type').value}.\n\nDettagli:\n${form.querySelector('#q-details').value.trim()}`;
      window.open(`https://wa.me/${state.config.whatsapp}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      closeModal();
    });
    openModal(h('div', { class: 'text-center mb-5' }, h('h3', { class: 'text-xl font-serif font-bold' }, 'Preventivo personalizzato'), h('p', { class: 'text-xs text-slate-500 mt-1' }, 'Quantità per cerimonie o personalizzazioni su misura.')), form);
  }

  /* ------------------------------ avvio ------------------------------ */
  async function loadProducts() {
    state.products = (await api('/api/products')).products;
    renderProducts();
  }

  async function init() {
    loadCart();
    try {
      const [config] = await Promise.all([api('/api/config'), loadProducts()]);
      state.config = config;
    } catch (e) {
      $('#prodotti').replaceChildren(h('p', { class: 'col-span-full text-center text-red-700 py-16' }, 'Impossibile caricare il catalogo. Ricarica la pagina tra qualche istante.'));
      return;
    }
    applyConfig();
    renderFilters();
    renderProducts();

    // elimina dal carrello gli articoli non più in vendita
    const ids = new Set(state.products.map((p) => p.id));
    state.cart.items = state.cart.items.filter((i) => ids.has(i.id));
    saveCart();
    await refreshQuote();

    $('#open-cart').addEventListener('click', openCart);
    $('#close-cart').addEventListener('click', closeCart);
    backdrop.addEventListener('click', closeCart);
    $('#go-checkout').addEventListener('click', openCheckout);
    document.querySelectorAll('[data-action=quote]').forEach((b) => b.addEventListener('click', () => openQuoteModal()));
    $('#coupon-form').addEventListener('submit', (e) => {
      e.preventDefault();
      clearCartMsg();
      const code = $('#coupon-input').value.trim().toUpperCase();
      state.cart.coupon = code;
      saveCart();
      if (!code) return refreshQuote();
      if (state.cart.items.length === 0) return showToastInCart('Aggiungi prima un articolo al carrello.', false);
      refreshQuote().then(() => {
        if (state.cart.coupon) showToastInCart(`Coupon ${state.cart.coupon} applicato.`, true);
      });
    });
    handleReturn();
  }

  init();
})();
