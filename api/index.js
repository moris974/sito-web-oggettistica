'use strict';
// Punto di ingresso per Vercel: tutte le richieste (pagine, API, webhook, immagini)
// vengono instradate qui da vercel.json e gestite dallo stesso codice usato in locale.
const { vercelHandler } = require('../server');

module.exports = vercelHandler;

// Il webhook Stripe ha bisogno del corpo "grezzo" per verificare la firma:
// non lasciamo che Vercel lo interpreti prima di noi.
module.exports.config = { api: { bodyParser: false } };
