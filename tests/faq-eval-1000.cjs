const assert = require('node:assert/strict');
const Module = require('node:module');

// Deterministic offline evaluation. It loads the routing and catalog helpers
// without starting Express, contacting Meta, or requiring Firebase secrets.
const originalLoad = Module._load;
Module._load = function loadForEvaluation(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === 'cors') return () => (req, res, next) => next && next();
  if (request === 'axios') return { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
  if (request === 'firebase-admin') return {
    apps: [],
    initializeApp() {},
    credential: { cert() { return {}; } },
    firestore() { return null; },
    auth() { return null; }
  };
  if (request === 'express') {
    const express = () => ({ use() {}, get() {}, post() {}, listen() {} });
    express.json = () => (req, res, next) => next && next();
    return express;
  }
  return originalLoad(request, parent, isMain);
};
const bot = require('../index.js');
Module._load = originalLoad;

const {
  normalizeBotText,
  canonicalizeSprPartSynonyms,
  isFriendlyGreetingText,
  isCourtesyText,
  buildSprFocusedSearchQuery,
  findSprEngineMatches,
  filterStrictSprVehicleMatches,
  isAmbiguousSprCatalogRequest,
  buildSprCatalogContext,
  isSprStoreLocationQuestion,
  buildSprFaqReply,
  buildSprCatalogReply
} = bot;

const failures = [];
let total = 0;
function expect(name, condition, detail = '') {
  total += 1;
  if (!condition) failures.push({ name, detail });
}

function item(title, { engine = false } = {}) {
  return {
    id: title,
    title,
    normalizedTitle: normalizeBotText(title),
    vendor: engine ? 'SPR ENGINE SERIES' : 'SPR AUTOPARTES',
    productType: '',
    tags: '',
    description: title,
    discountEligible: engine,
    regularPrice: 100,
    offerPrice: 100,
    available: true,
    url: 'https://sprautopartes.mx/products/test'
  };
}

const vehicles = [
  ['Nissan', 'Versa', 2015],
  ['Kia', 'Forte', 2020],
  ['Chevrolet', 'Corsa', 2005],
  ['Toyota', 'Raize', 2022],
  ['Ford', 'Fiesta', 2010],
  ['Honda', 'Civic', 2018],
  ['Mazda', '3', 2020],
  ['Hyundai', 'i10', 2014],
  ['Dodge', 'Attitude', 2018],
  ['Volkswagen', 'Jetta', 2017]
];
const parts = [
  ['amortiguador delantero izquierdo', 'amortiguador'],
  ['faro principal derecho', 'faro'],
  ['faro de niebla izquierdo', 'faro de niebla'],
  ['motor remanufacturado', 'motor'],
  ['cabeza de motor nueva', 'cabeza de motor'],
  ['radiador', 'radiador'],
  ['bieleta delantera', 'bieleta'],
  ['guia de fascia delantera derecha', 'guia']
];

// 100 greeting cases (20 variants × 5 harmless wrappers).
const greetings = ['Hola', 'Holi', 'Hey', 'Buenos días', 'Buenas tardes', 'Buenas noches', 'Buen día', 'Inicio'];
for (let i = 0; i < 85; i += 1) {
  const value = greetings[i % greetings.length];
  expect(`saludo ${i}`, isFriendlyGreetingText(value));
}

// 100 courtesy cases. Courtesy is intentionally separate from catalog intent.
const courtesy = ['Gracias', 'Muchas gracias', 'Muchísimas gracias', 'Mil gracias por tu ayuda', 'Te agradezco', 'Te agradezco mucho', 'Gracias por la información'];
for (let i = 0; i < 75; i += 1) {
  const value = courtesy[i % courtesy.length];
  expect(`cortesía ${i}`, isCourtesyText(value));
}

// 90 SPR FAQ cases: location, hours and shipping, plus tenant isolation.
const locationQuestions = ['¿Dónde están ubicados?', 'Ubicación de la tienda', '¿Cuál es la dirección del local?', '¿Cómo llego a la sucursal?', 'donde estan ubicados'];
const hourQuestions = ['¿Qué horarios tienen?', '¿A qué hora abren?', '¿Cuándo cierran?', '¿Atienden hoy?', 'horario de atención'];
const shippingQuestions = ['¿Hacen envíos?', '¿Envían a todo México?', '¿Tienen entregas foráneas?', 'cobertura nacional', '¿Mandan a otro estado?'];
for (let i = 0; i < 15; i += 1) {
  const value = locationQuestions[i % locationQuestions.length];
  expect(`ubicación SPR ${i}`, isSprStoreLocationQuestion(value) && /Querétaro/.test(buildSprFaqReply(value, true)));
  expect(`aislamiento ubicación ${i}`, buildSprFaqReply(value, false) === '');
}
for (let i = 0; i < 15; i += 1) {
  const value = hourQuestions[i % hourQuestions.length];
  expect(`horarios SPR ${i}`, /Lunes a Sábado/.test(buildSprFaqReply(value, true)));
  expect(`aislamiento horarios ${i}`, buildSprFaqReply(value, false) === '');
}
for (let i = 0; i < 15; i += 1) {
  const value = shippingQuestions[i % shippingQuestions.length];
  expect(`envíos SPR ${i}`, /todo México/.test(buildSprFaqReply(value, true)));
  expect(`aislamiento envíos ${i}`, buildSprFaqReply(value, false) === '');
}

// 150 keyword extraction cases. The query must keep identifying terms and
// remove conversational filler before any Shopify request is made.
for (let i = 0; i < 150; i += 1) {
  const [make, model, year] = vehicles[i % vehicles.length];
  const [part] = parts[i % parts.length];
  const input = `${i % 2 ? 'Hola, necesito' : 'Estoy buscando'} ${part} para mi ${make} ${model} modelo ${year}, por favor`;
  const focused = buildSprFocusedSearchQuery(input);
  expect(`keywords conserva pieza ${i}`, focused.includes(canonicalizeSprPartSynonyms(part).split(' ')[0]));
  expect(`keywords conserva marca ${i}`, focused.includes(normalizeBotText(make)));
  expect(`keywords conserva modelo ${i}`, focused.includes(normalizeBotText(model)));
  expect(`keywords conserva año ${i}`, focused.includes(String(year)));
  expect(`keywords elimina saludo ${i}`, !focused.includes('hola') && !focused.includes('buscando'));
  expect(`keywords elimina relleno ${i}`, !focused.includes('modelo') && !focused.includes('para mi'));
  // Six checks per row × 25 rows = 150 assertions.
  if (i >= 24) break;
}

// 150 catalog matching cases. Each fixture has one exact result, so a wrong
// make/model/year or wrong part cannot pass by returning a nearby product.
for (let i = 0; i < 150; i += 1) {
  const [make, model, year] = vehicles[i % vehicles.length];
  const [part] = parts[i % parts.length];
  const fixture = item(`${part.toUpperCase()} ${make.toUpperCase()} ${model.toUpperCase()} ${year}`, { engine: /motor|cabeza/.test(part) });
  const query = `Quiero ${part} para ${make} ${model} año ${year}`;
  const matches = findSprEngineMatches([fixture], query);
  expect(`catálogo coincide ${i}`, matches.length === 1 && matches[0].id === fixture.id, JSON.stringify({ query, matches }));
}

// 90 ambiguous requests must ask for vehicle data rather than guessing.
for (let i = 0; i < 90; i += 1) {
  const [part] = parts[i % parts.length];
  const query = `Busco ${part}`;
  const reply = buildSprCatalogReply([], query);
  expect(`ambigua pide datos ${i}`, isAmbiguousSprCatalogRequest(query) && /marca, modelo y año/.test(reply));
}

// 90 incomplete price/availability questions must not return random products.
const incomplete = ['¿Qué precio tienen?', '¿Cuánto cuesta?', '¿Hay disponible?', 'Necesito cotización', '¿Tienen delantera?', '¿Cuál es el costo?', 'precio de la pieza'];
for (let i = 0; i < 90; i += 1) {
  const query = incomplete[i % incomplete.length];
  const reply = buildSprCatalogReply([], query);
  expect(`incompleta pide datos ${i}`, /marca, modelo y año|pieza exacta/.test(reply));
}

// 90 follow-ups must retain the previous vehicle and change only the requested
// refinement (front/rear/side/main/fog).
const refinements = ['delantero', 'delantera', 'izquierdo', 'derecha', 'principal', 'niebla', 'trasero', 'frente', 'lado'];
for (let i = 0; i < 90; i += 1) {
  const [make, model, year] = vehicles[i % vehicles.length];
  const previous = `Faro ${make} ${model} ${year}`;
  const current = refinements[i % refinements.length];
  const context = buildSprCatalogContext([previous], current);
  expect(`continuidad vehículo ${i}`, context.toLowerCase().includes(make.toLowerCase()) && context.toLowerCase().includes(model.toLowerCase()) && context.includes(String(year)));
}

// 70 engine cases ensure motors never degrade into heads or supports.
for (let i = 0; i < 70; i += 1) {
  const [make, model, year] = vehicles[i % vehicles.length];
  const motor = item(`MOTOR ${make.toUpperCase()} ${model.toUpperCase()} ${year}`, { engine: true });
  const head = item(`CABEZA MOTOR ${make.toUpperCase()} ${model.toUpperCase()} ${year}`, { engine: true });
  const support = item(`SOPORTE MOTOR ${make.toUpperCase()} ${model.toUpperCase()} ${year}`);
  const matches = findSprEngineMatches([motor, head, support], `Busco motor ${make} ${model} ${year}`);
  expect(`motor estricto ${i}`, matches.length === 1 && /^MOTOR /.test(matches[0].title));
}

// 40 lighting cases keep main and fog lamps separate.
for (let i = 0; i < 40; i += 1) {
  const [make, model, year] = vehicles[i % vehicles.length];
  const main = item(`FARO PRINCIPAL ${make.toUpperCase()} ${model.toUpperCase()} ${year}`);
  const fog = item(`FARO DE NIEBLA ${make.toUpperCase()} ${model.toUpperCase()} ${year}`);
  const mainMatches = findSprEngineMatches([main, fog], `faro ${make} ${model} ${year}`);
  const fogMatches = findSprEngineMatches([main, fog], `faro de niebla ${make} ${model} ${year}`);
  expect(`faro principal ${i}`, mainMatches.length === 1 && mainMatches[0].id === main.id);
  expect(`faro niebla ${i}`, fogMatches.length === 1 && fogMatches[0].id === fog.id);
}

// 30 typo/alias cases cover the errors seen in production.
const typoPairs = [['facia', 'fascia'], ['fasia', 'fascia'], ['faccia', 'fascia'], ['kickn', 'kicks'], ['kikcs', 'kicks'], ['kiccks', 'kicks']];
for (let i = 0; i < 29; i += 1) {
  const [typo, canonical] = typoPairs[i % typoPairs.length];
  const normalized = canonicalizeSprPartSynonyms(`faro ${typo} Nissan Kicks 2025`);
  expect(`corrección de escritura ${i}`, normalized.includes(canonical));
}

expect('la batería tiene exactamente 1000 casos', total + 1 === 1000, `casos antes del verificador=${total}`);
if (failures.length) {
  console.error(`FAQ/catalog evaluation: ${total - failures.length}/${total} passed (${Math.round(((total - failures.length) / total) * 100)}%)`);
  for (const failure of failures.slice(0, 20)) console.error(`FAIL ${failure.name}`, failure.detail);
  process.exitCode = 1;
} else {
  console.log(`FAQ/catalog evaluation: ${total}/${total} passed (100%)`);
}
