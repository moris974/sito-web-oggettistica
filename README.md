# G&T Hobbistica e Artigianato — e-commerce

Negozio online completo per creazioni artigianali (fiocchi natalizi, bomboniere, articoli da mercatino):
catalogo, carrello, coupon, spedizione, pagamenti **Stripe / PayPal / bonifico**, gestione ordini e pannello admin.

- Backend Node.js senza framework. In locale usa **SQLite**; in produzione usa **Postgres** (gratis con Neon).
- Frontend in HTML + JavaScript puro, Tailwind da CDN.
- Prezzi, sconti, spedizione e stock sono calcolati **solo dal server**: il browser non può alterarli.

> ⚠️ **Vercel gratuito (piano Hobby) è solo per uso personale e non commerciale.**
> Va bene per costruire e provare il sito (anche con pagamenti di test), ma **non per vendere davvero**.
> Prima di incassare serve Vercel Pro oppure un altro hosting (vedi `render.yaml`). Controlla sempre i termini del servizio.

## Struttura della repo (importante per GitHub)

Nella pagina principale della repo devono vedersi **queste cartelle e questi file**:

```
api/          lib/          public/        test/         views/
package.json  server.js     vercel.json    README.md     render.yaml
.env.example  .gitignore    .vercelignore
```

Se vedi file come `shop.js` o `db.js` sparsi nella radice, sono stati caricati senza le cartelle: vanno caricati **trascinando le cartelle intere**.

## Provarlo in locale

Serve Node.js 22. 

```bash
cp .env.example .env
npm start            # http://localhost:3000
npm test             # test di integrazione
npm run test:pg-sim  # la stessa suite attraverso l'adapter Postgres (finto driver)
```

Al primo avvio, se `ADMIN_PASSWORD` è vuota, viene generata una password casuale e stampata una sola volta nel terminale.

## Metterlo online su Vercel (per provare)

1. Carica il codice su GitHub (con le cartelle, vedi sopra) e importa la repo in Vercel: non servono comandi di build.
2. **Storage → Create → Neon (Postgres)** e collegalo al progetto: Vercel aggiunge da solo `DATABASE_URL`.
3. **Settings → Environment Variables**: aggiungi `ADMIN_PASSWORD` (almeno 10 caratteri). Per i pagamenti: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`.
4. **Redeploy**, poi apri `/admin` e accedi con `admin` + la password scelta.

Se la pagina mostra un errore di testo, il messaggio dice cosa manca (`ADMIN_PASSWORD` o `DATABASE_URL`); i dettagli sono in *Deployments → Logs*.

Limiti del piano gratuito: Neon Free ha 0,5 GB e va in pausa dopo 5 minuti senza visite (la prima richiesta può essere più lenta, i dati restano). Le foto sono salvate nel database e ridimensionate automaticamente.

## Pagamenti

- **Stripe**: chiave segreta in `STRIPE_SECRET_KEY`. Dashboard Stripe → *Sviluppatori → Webhook*: endpoint `https://TUO-DOMINIO/api/webhooks/stripe`, eventi `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`; copia il `whsec_…` in `STRIPE_WEBHOOK_SECRET`. **Senza webhook i pagamenti non risultano mai "pagati".** Carta di prova: `4242 4242 4242 4242`.
- **PayPal**: Client ID e Secret da developer.paypal.com (Sandbox per provare, Live per incassare).
- **Bonifico**: inserisci l'IBAN in *Impostazioni*.

Un metodo compare nel carrello solo se è configurato.

## Pannello admin (`/admin`)

Ordini (stati, WhatsApp al cliente, note, export CSV), articoli con upload foto, coupon (per carrello o per articolo, con scadenza), **aspetto del sito**, impostazioni (logo da file, spedizione, IBAN, dati legali, cambio password, stato pagamenti).

### Aspetto del sito (scheda "Aspetto del sito")

Da qui modifichi senza toccare il codice:

- **Testata**: nome in due colori, sottotitolo, testo dei pulsanti "su misura" e WhatsApp.
- **Riquadro principale (la parte colorata)**: mostra/nascondi, 5 colori, immagine di sfondo, etichette, titolo, testo e pulsanti (un campo lasciato vuoto nasconde quell'elemento).
- **Piè di pagina**: nota, titolo e link aggiuntivi (Instagram, Facebook, email, telefono, fino a 8), colonna pagamenti, riga del copyright, link "Area riservata".
- **Ripristina testi originali** riporta tutto com'era.

Logo e messaggio della barra scura si cambiano da *Impostazioni*, insieme ai dati del venditore (ragione sociale, P.IVA, sede, email) che compaiono nel piè di pagina.
I link accettati sono `https://…`, `mailto:…`, `tel:…` e percorsi interni come `/privacy`.

Lo stock viene riservato alla creazione dell'ordine e rimesso in magazzino se l'ordine viene annullato, scade la sessione Stripe o un pagamento resta incompleto oltre 45 minuti.

## Sicurezza

Password con hash `scrypt`, sessioni casuali, cookie `HttpOnly` + `SameSite=Strict`, limite ai tentativi di login (salvato nel database), difesa CSRF, prezzi ricalcolati dal server, importi dei pagamenti verificati, firma HMAC dei webhook Stripe, interfaccia senza `innerHTML` con dati dinamici, upload immagini verificati e serviti in sandbox, CSV protetto da formula injection.

## Limiti noti

- Nessuna email automatica (né al cliente né a te): controlla il pannello Ordini.
- Nessuna fatturazione/scontrino elettronico né IVA per paese; spedizione a tariffa unica con soglia gratuita.
- Tailwind da CDN: la CSP include `'unsafe-eval'` per questo motivo.
- `/termini` e `/privacy` sono modelli orientativi: falli verificare da un professionista e compila i dati del venditore in Impostazioni.
- Verificato con test automatici (Stripe/PayPal simulati; Postgres con un finto driver). Da provare da te: deploy su Vercel, collegamento a Neon, pagamenti con le chiavi di test, interfaccia nel browser.

## Checklist prima di vendere

- [ ] Piano di hosting che consente l'uso commerciale
- [ ] Password admin cambiata; dati venditore, WhatsApp, spedizione (e IBAN) compilati
- [ ] Logo caricato, articoli reali con foto e stock
- [ ] Pagamento di prova Stripe (test) → ordine **Pagato**; prova PayPal Sandbox
- [ ] Passaggio alle chiavi live e acquisto reale di piccolo importo
- [ ] Testi legali verificati; backup/export periodico del database
