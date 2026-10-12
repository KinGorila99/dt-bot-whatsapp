const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function loadForEvaluation(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === 'cors') return () => (req, res, next) => next && next();
  if (request === 'axios') return { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
  if (request === 'firebase-admin') return { apps: [], initializeApp() {}, credential: { cert() { return {}; } }, firestore() { return null; }, auth() { return null; } };
  if (request === 'express') {
    const express = () => ({ use() {}, get() {}, post() {}, listen() {} });
    express.json = () => (req, res, next) => next && next();
    return express;
  }
  return originalLoad(request, parent, isMain);
};
const {
  isFriendlyGreetingText,
  isCourtesyText,
  isSprNewRequestOrQuestion,
  buildSprAdvisorReviewReply,
  getSprMissingRequestFields,
  buildSprMissingRequestReply,
  buildSprCatalogContext,
  isSprLikelyPieceFollowUp,
  buildSprCatalogReply,
  buildSprCatalogFallbackReply,
  findSprCatalogRecoveryMatches,
  findSprEngineMatches,
  normalizeSprProduct
} = require('../index.js');
Module._load = originalLoad;

const cases = [
  ['Hola, buenos días', true, 'greeting'],
  ['Gracias, te agradezco mucho', true, 'courtesy'],
  ['Busco amortiguador Nissan Versa 2015', true, 'new part'],
  ['¿Tienen horario el sábado?', true, 'new FAQ question'],
  ['Gracias, ¿tienen disponible otra pieza?', true, 'courtesy plus new question'],
  ['Gracias', false, 'courtesy does not resume'],
  ['Ok, recibido', false, 'acknowledgement does not resume'],
  ['El asesor ya me atendió', false, 'advisor update does not resume']
];
const failures = [];
for (const [text, expected, label] of cases) {
  const actual = label === 'greeting'
    ? isFriendlyGreetingText(text)
    : label === 'courtesy'
      ? isCourtesyText(text)
      : isSprNewRequestOrQuestion(text);
  if (actual !== expected) failures.push({ text, expected, actual, label });
}

const advisorReply = buildSprAdvisorReviewReply('Cliente');
if (!/asesor/i.test(advisorReply) || !/pausadas/i.test(advisorReply) || /no tenemos/i.test(advisorReply)) {
  failures.push({ advisorReply });
}

for (const conversationalTurn of ['HOLA', 'Buenos días', 'Gracias, te agradezco']) {
  const fields = getSprMissingRequestFields(conversationalTurn);
  if (fields.length || buildSprMissingRequestReply(fields, conversationalTurn)) {
    failures.push({ conversationalTurn, fields });
  }
}

const missing = getSprMissingRequestFields('SENTRA 2018');
const missingReply = buildSprMissingRequestReply(missing, 'SENTRA 2018');
if (missing.join('|') !== 'pieza|marca'
  || !/YA TENGO REGISTRADO.*SENTRA 2018/i.test(missingReply)
  || !/qu[eé] pieza necesitas/i.test(missingReply)
  || !/1️⃣|2️⃣|3️⃣/.test(missingReply)) {
  failures.push({ missing, missingReply });
}

const combinedContext = buildSprCatalogContext(['SENTRA 2018'], 'FARO DERECHO');
if (!/sentra 2018 faro derecho/i.test(combinedContext)) {
  failures.push({ combinedContext });
}

const completePieceVehicleFields = getSprMissingRequestFields('FARO VERSA 2020');
const completePieceReply = buildSprCatalogReply([
  {
    title: 'FARO DERECHO NISSAN VERSA 2020-2025 TYC',
    regularPrice: 1740,
    offerPrice: 1740,
    available: true,
    url: 'https://sprautopartes.mx/products/faro-derecho-nissan-versa-2020',
    image: 'https://cdn.shopify.com/s/files/1/0000/products/faro-versa.jpg'
  }
], 'faro versa 2020');
if (completePieceVehicleFields.length
  || !/precio normal/i.test(completePieceReply)
  || !/\$1,740\.00/.test(completePieceReply)
  || !/https:\/\/sprautopartes\.mx\/products\/faro-derecho-nissan-versa-2020/.test(completePieceReply)
  || !/🖼️ Foto y detalles: https:\/\/cdn\.shopify\.com/i.test(completePieceReply)
  || /asesor/i.test(completePieceReply)) {
  failures.push({ completePieceVehicleFields, completePieceReply });
}

const normalizedWithImage = normalizeSprProduct({
  title: 'FARO DERECHO NISSAN VERSA 2020',
  handle: 'faro-derecho-nissan-versa-2020',
  price: '1740',
  image: { src: 'https://cdn.shopify.com/s/files/1/0000/products/faro.jpg' }
});
if (normalizedWithImage.image !== 'https://cdn.shopify.com/s/files/1/0000/products/faro.jpg') {
  failures.push({ normalizedWithImage });
}

const recoveryCatalog = [
  normalizeSprProduct({
    title: 'FARO DERECHO NISSAN VERSA 2015-2019 TYC',
    handle: 'faro-derecho-nissan-versa-2015',
    price: 1740,
    tags: 'NISSAN VERSA 2015 2019'
  }),
  normalizeSprProduct({
    title: 'ESPEJO DERECHO NISSAN VERSA 2015-2019',
    handle: 'espejo-derecho-nissan-versa-2015',
    price: 900,
    tags: 'NISSAN VERSA 2015 2019'
  })
];
const recoveryMatches = findSprCatalogRecoveryMatches(recoveryCatalog, 'faro derecho nissan versa 2020');
if (!recoveryMatches.length || !/faro/i.test(recoveryMatches[0].title) || /espejo/i.test(recoveryMatches[0].title)) {
  failures.push({ recoveryMatches: recoveryMatches.map(item => item.title) });
}

const orientationCatalog = [
  normalizeSprProduct({
    title: 'PUERTA TRASERA DERECHA MITSUBISHI MIRAGE 2015-2018',
    handle: 'puerta-trasera-derecha-mirage',
    price: 7062,
    tags: 'MITSUBISHI MIRAGE 2015 2018'
  }),
  normalizeSprProduct({
    title: 'PUERTA TRASERA IZQUIERDA MITSUBISHI MIRAGE 2015-2018',
    handle: 'puerta-trasera-izquierda-mirage',
    price: 7062,
    tags: 'MITSUBISHI MIRAGE 2015 2018'
  })
];
const orientationMatches = findSprEngineMatches(
  orientationCatalog,
  'puerta trasera lado copiloto Mitsubishi Mirage 2015 hatchback'
);
if (orientationMatches.length !== 1 || !/derecha/i.test(orientationMatches[0].title)) {
  failures.push({ orientationMatches: orientationMatches.map(item => item.title) });
}

const fallbackReply = buildSprCatalogFallbackReply('puerta Mitsubishi Mirage 2015');
if (!/precio, foto y enlace/i.test(fallbackReply) || /no tenemos|asesor|lo voy a buscar/i.test(fallbackReply)) {
  failures.push({ fallbackReply });
}

const genericVehicleCases = [
  ['VERSA 2017', 'FARO IZQUIERDO'],
  ['TIGUAN 2019', 'ESPEJO DERECHO'],
  ['LOBO 2020', 'AMORTIGUADORES DELANTEROS'],
  ['SILVERADO 2022', 'FASCIA DELANTERA']
];
for (const [vehicle, part] of genericVehicleCases) {
  const fields = getSprMissingRequestFields(vehicle);
  const context = buildSprCatalogContext([vehicle], part);
  if (fields.join('|') !== 'pieza|marca' || !context.toLowerCase().includes(`${vehicle.toLowerCase()} ${part.toLowerCase()}`)) {
    failures.push({ vehicle, part, fields, context });
  }
}

const labeledContext = buildSprCatalogContext(
  ['Marca: Nissan', 'Modelo: Versa', 'Año: 2017'],
  'FARO DERECHO'
);
if (!/marca: nissan modelo: versa a[nñ]o: 2017 faro derecho/i.test(labeledContext)) {
  failures.push({ labeledContext });
}

for (const piece of ['CLAXON', 'BOMBA DE AGUA', 'SENSOR ABS']) {
  const context = buildSprCatalogContext(['SENTRA 2018'], piece);
  if (!isSprLikelyPieceFollowUp(piece) || !context.toLowerCase().includes(`sentra 2018 ${piece.toLowerCase()}`)) {
    failures.push({ piece, context });
  }
}

const total = cases.length + 3 + 3 + 3 + genericVehicleCases.length + 1 + 3 + 6;
console.log(`SPR handoff regressions: ${total - failures.length}/${total} passed`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
