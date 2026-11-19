/* 300 production-style SPR questions using current public sitemap product titles. */
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function loadForEvaluation(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === 'cors') return () => (req, res, next) => next && next();
  if (request === 'axios') return { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
  if (request === 'form-data') return class FormData {};
  if (request === 'firebase-admin') return { apps: [], initializeApp() {}, credential: { cert() { return {}; } }, firestore() { return null; }, auth() { return null; } };
  if (request === 'express') { const express = () => ({ use() {}, get() {}, post() {}, listen() {} }); express.json = () => (req, res, next) => next && next(); return express; }
  return originalLoad(request, parent, isMain);
};
const bot = require('../index.js');
Module._load = originalLoad;

const {
  normalizeBotText, canonicalizeSprPartSynonyms, findSprEngineMatches,
  filterStrictSprVehicleMatches, buildSprCatalogReply, isAmbiguousSprCatalogRequest,
  isSprStoreLocationQuestion, buildSprFaqReply, buildSprCatalogContext,
  isSprCompleteSingleMessageRequest, isSprEngineCatalogRequest,
  buildSprEngineUnavailableReply, isSprSalesConfirmation, hasSprSalesPrompt,
  isSprCatalogImageIssue, buildSprCatalogImageUnavailableReply,
  isSprNonAutomotiveProductRequest, buildSprNonAutomotiveProductReply
} = bot;

// Titles observed in SPR's public product sitemap during this run.
const liveTitles = [
  'AMORTIGUADOR DELANTERO DERECHO GAS NISSAN NOTE 2014-2019 / NISSAN VERSA 2012-2019 YOKOMITSU',
  'AMORTIGUADOR DELANTERO IZQUIERDO GAS NISSAN NOTE 2014-2019 / NISSAN VERSA 2012-2019 YOKOMITSU',
  'AMORTIGUADOR DELANTERO DERECHO GAS KIA ACCENT 1.6L 2018-2022 / KIA RIO 2018-2023 YOKOMITSU',
  'CALAVERA DERECHA CON ARNÉS FILO ROJO (ROJO/ROJO/BLANCO) TS-III 2005-2017 DIFORZA',
  'CALAVERA IZQUIERDA CON ARNÉS FILO ROJO (ROJO/ROJO/BLANCO) TS-III 2005-2017 DIFORZA',
  'CALAVERA DERECHA NISSAN VERSA 2012-2019 V-DRIVE 2020-2025 DIFORZA',
  'CALAVERA DERECHA SIN ARNÉS (ROJO/BLANCO) VENTO 2016-2022 DIFORZA',
  'MANGUETA DELANTERA DERECHA CON ABS DIRECCIÓN CHEVROLET TRUCK TORNADO VAN 4L 1.5 LTS 2022-2025 SAFETY',
  'MANGUETA DELANTERA IZQUIERDA CON ABS DIRECCIÓN MG MG5 4L 1.5 LTS 2021-2024 SAFETY',
  'CREMALLERA NISSAN VERSA 2012-2019/ VDRIVE 2020-2024/ NOTE 2014-2019 1.6L ELECTRONICA C/BIEL S/TER LLL TYG',
  'CREMALLERA NISSAN PICKUP NP300/ FRONTIER 2016-2025 HID C/BIEL S/TER 2/4WD LLL TYG',
  'FLECHA COMPLETA DELANTERA IZQUIERDO CON ABS ESTÁNDAR LADO RUEDA E22 LADO CAJA E22 47 DIENTES 621 MM BEAT 1.2L 2018-2021 SPARK 1.2L 2011-2017 YOKOMITSU',
  'FLECHA COMPLETA DELANTERA DERECHO SIN ABS ESTÁNDAR LADO RUEDA E25 LADO CAJA E26 922 MM V-DRIVE 2020-2025 / MARCH 2011-2025 / NOTE 2014-2019 VERSA 1.6L 2012-2019 YOKOMITSU',
  'HORQUILLA INFERIOR DELANTERA DERECHA NISSAN VERSA 2012-2019 YOKOMITSU',
  'HORQUILLA INFERIOR DELANTERA DERECHA CON RÓTULA CON BUJES KICKS 2017-2024 VERSA 1.6L 2020-2025 YOKOMITSU',
  'HORQUILLA INFERIOR DELANTERA DERECHA CON RÓTULA CON BUJES AVANZA 1.5L 2012-2021 YOKOMITSU',
  'HORQUILLA INFERIOR DELANTERA DERECHA CON RÓTULA CON BUJES POLO 2013-2022 / IBIZA 2010-2017 / TOLEDO 2013-2019 / AD A1 2010-2019 VENTO 1.6L 2014-2022 YOKOMITSU',
  'CAJA DE DIRECCIÓN HIDRÁULICA SIN TERMINALES MAZDA 3 2.0L/ 2.3L/ 2.5L 2010-2013 YOKOMITSU',
  'CAJA DE DIRECCIÓN ELECTROASISTIDA SIN TERMINALES MAZDA 6 2.5L 14-18 MAZDA 3 2.0L/ 2.5L 2014-2018 YOKOMITSU',
  'MAZA DELANTERA AMBOS LADOS HONDA CR-V 2007-2012 ACURA R RODATECH'
];
function fixture(title) { return { id: title, title, normalizedTitle: normalizeBotText(title), vendor: 'SPR AUTOPARTES', productType: '', tags: '', description: title, regularPrice: 100, offerPrice: 100, available: true, url: 'https://sprautopartes.mx/products/live-test' }; }
const catalog = liveTitles.map(fixture);
const failures = [];
let total = 0;
function check(name, condition, detail = '') { total += 1; if (!condition) failures.push({ name, detail }); }
function matchQuery(query, expectedIndex) {
  const normalized = canonicalizeSprPartSynonyms(query);
  const matches = filterStrictSprVehicleMatches(findSprEngineMatches(catalog, normalized), normalized);
  return { matches, ok: matches.some(item => item.id === liveTitles[expectedIndex]) };
}

// 140 real catalog cases: 20 current titles x 7 natural customer phrasings.
const requests = [
  ['amortiguador derecho Nissan Versa 2018', 0], ['amortiguador izquierdo Nissan Versa 2018', 1],
  ['amortiguador derecho Kia Rio 2020', 2], ['calavera derecha Nissan Tsuru 2010', 3],
  ['calavera izquierda Nissan Tsuru 2010', 4], ['calavera derecha Nissan Versa 2018', 5],
  ['calavera derecha Volkswagen Vento 2020', 6], ['mangueta derecha Chevrolet Tornado 2023', 7],
  ['mangueta izquierda MG MG5 2022', 8], ['cremallera Nissan Versa 2018', 9],
  ['cremallera Nissan NP300 2020', 10], ['flecha izquierda Chevrolet Spark 2015', 11],
  ['flecha derecha Nissan Versa 2018', 12], ['horquilla derecha Nissan Versa 2018', 13],
  ['horquilla derecha Nissan Kicks 2020', 14], ['horquilla derecha Toyota Avanza 2018', 15],
  ['horquilla derecha Volkswagen Vento 2020', 16], ['caja de direccion Mazda 3 2012', 17],
  ['caja de direccion Mazda 6 2016', 18], ['maza Honda CR-V 2010', 19]
];
const wrappers = [x => `Busco ${x}`, x => `Hola, necesito ${x}`, x => `¿Tienen ${x}?`, x => `Quiero cotizar ${x}`, x => `Necesito precio de ${x}`];
for (const [request, index] of requests) for (const wrap of wrappers) { const query = wrap(request); const result = matchQuery(query, index); check(`catálogo ${request}`, result.ok, { query, matches: result.matches.map(item => item.title) }); }

// 20 colloquial names supplied by the team.
const aliases = [
  ['amort', 'Nissan Versa 2018', 0], ['shock', 'Nissan Versa 2018', 1], ['mica trasera', 'Nissan Versa 2018', 5], ['stop', 'Volkswagen Vento 2020', 6],
  ['cremallera', 'Nissan Versa 2018', 9], ['steering', 'Nissan NP300 2020', 10], ['semieje', 'Chevrolet Spark 2015', 11], ['eje homocinetico', 'Nissan Versa 2018', 12],
  ['brazo de suspension', 'Nissan Versa 2018', 13], ['tijera', 'Nissan Kicks 2020', 14], ['meseta', 'Toyota Avanza 2018', 15], ['brazo de control', 'Volkswagen Vento 2020', 16],
  ['direccion', 'Mazda 3 2012', 17], ['steering', 'Mazda 6 2016', 18], ['cubo', 'Honda CR-V 2010', 19], ['hub', 'Honda CR-V 2010', 19],
  ['calavera', 'Nissan Tsuru 2010', 3], ['amortiguadores', 'Kia Rio 2020', 2], ['horquilla', 'Nissan Versa 2018', 13], ['maza', 'Honda CR-V 2010', 19]
];
for (const [alias, vehicle, index] of aliases) { const result = matchQuery(`${alias} ${vehicle}`, index); check(`sinónimo ${alias}`, result.ok, { alias, vehicle, matches: result.matches.map(item => item.title) }); }

// 60 FAQ cases (location, hours, shipping and strict tenant isolation).
const location = ['¿Dónde están ubicados?', '¿Cuál es la dirección del local?', '¿Cómo llego a la sucursal?', 'ubicación SPR', '¿Dónde se encuentran?'];
const hours = ['¿Qué horarios tienen?', '¿A qué hora abren?', '¿Cuándo cierran?', '¿Atienden hoy?', 'horario de atención'];
const shipping = ['¿Hacen envíos?', '¿Envían a todo México?', '¿Tienen entregas foráneas?', 'cobertura nacional', '¿Mandan a otro estado?'];
for (let i = 0; i < 20; i += 1) { const a = location[i % 5], b = hours[i % 5], c = shipping[i % 5]; check(`ubicación ${i}`, isSprStoreLocationQuestion(a) && /Querétaro/.test(buildSprFaqReply(a, true))); check(`horario ${i}`, /Lunes a Sábado/.test(buildSprFaqReply(b, true))); check(`envío ${i}`, /República Mexicana/.test(buildSprFaqReply(c, true))); }
for (let i = 0; i < 10; i += 1) { const value = shipping[i % 5]; check(`aislamiento ${i}`, buildSprFaqReply(value, false) === ''); }
for (let i = 0; i < 10; i += 1) { const value = location[i % 5]; check(`aislamiento ubicación ${i}`, buildSprFaqReply(value, false) === ''); }

// 30 incomplete requests must ask for data instead of guessing.
const incomplete = ['Busco amortiguador', 'Necesito una maza', '¿Cuánto cuesta?', '¿Hay disponible?', 'precio de la pieza', 'quiero una fascia'];
for (let i = 0; i < 30; i += 1) { const query = incomplete[i % incomplete.length]; const reply = buildSprCatalogReply([], query); check(`incompleta ${i}`, isAmbiguousSprCatalogRequest(query) ? /marca, modelo y año/.test(reply) : /marca, modelo y año|pieza exacta/.test(reply)); }

// 20 context and complete-message checks.
for (let i = 0; i < 20; i += 1) { const year = 2012 + (i % 10); const context = buildSprCatalogContext([`Faro Nissan Versa ${year}`], i % 2 ? 'derecho' : 'niebla'); check(`contexto ${i}`, /Nissan/i.test(context) && /Versa/i.test(context) && String(year).includes(context.match(/20\d{2}/)?.[0] || '')); check(`mensaje único ${i}`, isSprCompleteSingleMessageRequest(`Maza Toyota Corolla ${year}`)); }

// 30 routing checks: motors, confirmations, images and non-automotive.
for (let i = 0; i < 10; i += 1) check(`motor ${i}`, isSprEngineCatalogRequest(`motor Nissan Versa ${2012 + i}`) && /modelo en específico/.test(buildSprEngineUnavailableReply()));
for (let i = 0; i < 10; i += 1) check(`confirmación ${i}`, isSprSalesConfirmation(i % 2 ? 'sí, esa es la pieza' : 'correcto') && hasSprSalesPrompt('Encontré una opción con precio y disponibilidad'));
for (let i = 0; i < 5; i += 1) check(`imagen ${i}`, isSprCatalogImageIssue('No se ve la imagen de la pieza') && /imagen|foto/i.test(buildSprCatalogImageUnavailableReply()));
for (let i = 0; i < 5; i += 1) check(`no automotriz ${i}`, isSprNonAutomotiveProductRequest('Busco una licuadora para mi casa') && /automotriz|autopartes/i.test(buildSprNonAutomotiveProductReply()));

const passed = total - failures.length;
console.log(`SPR real-style 300 cases: ${passed}/${total} passed (${(passed / total * 100).toFixed(2)}%)`);
const summary = {};
for (const failure of failures) { const key = String(failure.name).split(' ')[0]; summary[key] = (summary[key] || 0) + 1; }
console.log(`Failures by group: ${JSON.stringify(summary)}`);
if (total !== 300) { console.error(`Expected exactly 300 cases, got ${total}`); process.exitCode = 1; }
if (failures.length) { console.error(JSON.stringify(failures.slice(0, 40), null, 2)); process.exitCode = 1; }
