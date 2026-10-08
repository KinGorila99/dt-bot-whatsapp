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
const { normalizeBotText, canonicalizeSprPartSynonyms, buildSprCatalogSearchQueries, findSprEngineMatches, filterStrictSprVehicleMatches } = require('../index.js');
Module._load = originalLoad;

const target = {
  id: 'vento-tornillo-regression',
  title: 'TORNILLO ESTABILIZADOR DELANTERO AMBOS LADOS VOLKSWAGEN VENTO 2014-2022 GOL 2009-2019',
  normalizedTitle: normalizeBotText('TORNILLO ESTABILIZADOR DELANTERO AMBOS LADOS VOLKSWAGEN VENTO 2014-2022 GOL 2009-2019'),
  vendor: 'SAFETY', productType: '', tags: '', description: '', discountEligible: false,
  regularPrice: 100, offerPrice: 100, available: true, url: 'https://sprautopartes.mx/products/vento-tornillo-regression'
};

const requests = [
  'Tienes cacahuate derecho para Vento 2018',
  'Tienes cachuate derecho para Vento 2018',
  'Tienes cahuate derecho para Vento 2018',
  'Tienes cacuate derecho para Vento 2018',
  'Tienes tornillo derecho para Vento 2018',
  'Tienes estabilizador derecho para Vento 2018',
  'Tienes tornillo estabilizador derecho para Volkswagen Vento 2018'
];

const failures = [];
for (const request of requests) {
  const normalized = canonicalizeSprPartSynonyms(request);
  const matches = filterStrictSprVehicleMatches(findSprEngineMatches([target], normalized), normalized);
  const searchQueries = buildSprCatalogSearchQueries(request);
  if (matches.length !== 1 || matches[0].id !== target.id || !searchQueries.some(query => query.includes('tornillo estabilizador'))) {
    failures.push({ request, normalized, matches: matches.map(item => item.title), searchQueries });
  }
}

console.log(`SPR synonym regressions: ${requests.length - failures.length}/${requests.length} passed`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
