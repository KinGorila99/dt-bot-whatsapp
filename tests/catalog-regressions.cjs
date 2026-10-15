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

const contextualCases = [
  {
    request: 'El espejo del lado del piloto, lado izquierdo, es manual. FRONTIER 2024 NISSAN',
    item: {
      id: 'frontier-espejo-manual',
      title: 'ESPEJO IZQUIERDO MANUAL PARA PINTAR NISSAN FRONTIER 2021-2024 TYG',
      handle: 'espejo-izquierdo-manual-nissan-frontier-2021-2024',
      tags: 'ESPEJO NISSAN FRONTIER IZQUIERDO',
      description: '',
      vendor: 'TYG', productType: 'ESPEJO', discountEligible: false,
      regularPrice: 100, offerPrice: 100, available: true
    },
    queryMustContain: 'espejo frontier 2024 nissan'
  },
  {
    request: 'Buen día busco una calavera del lado del chofer trasera para un L 200 2016',
    item: {
      id: 'l200-calavera-izquierda',
      title: 'CALAVERA IZQUIERDA CON ARNÉS MITSUBISHI PU 2016-2019 TYC',
      handle: 'calavera-izquierda-con-arnes-mitsubishi-pu-l200-2016-2019',
      tags: 'CALAVERA MITSUBISHI TYC',
      description: '',
      vendor: 'TYC', productType: 'CALAVERA', discountEligible: false,
      regularPrice: 100, offerPrice: 100, available: true
    },
    queryMustContain: 'calavera l200 2016'
  },
  {
    request: 'Amortiguadores delanteros para Ford lobo 2010 4x2 cabina sencilla motor 4.6 2v',
    item: {
      id: 'lobo-amortiguador-delantero',
      title: 'AMORTIGUADOR DELANTERO AMBOS LADOS GAS FORD LOBO 2WD 2009-2012 KYB',
      handle: 'amortiguador-delantero-ford-lobo-2wd-2009-2012',
      tags: 'AMORTIGUADOR FORD LOBO DELANTERO',
      description: '',
      vendor: 'KYB', productType: 'AMORTIGUADOR', discountEligible: false,
      regularPrice: 100, offerPrice: 100, available: true
    },
    queryMustContain: 'amortiguador ford lobo 2010'
  },
  {
    request: 'Buenos días, ¿podrías cotizar calavera Sentra 2022 lado izquierdo (lado chófer)?',
    item: {
      id: 'sentra-calavera-izquierda',
      title: 'CALAVERA IZQUIERDA CON ARNÉS NISSAN SENTRA 2020-2025 TYC',
      handle: 'calavera-izquierda-nissan-sentra-2020-2025',
      tags: 'CALAVERA NISSAN SENTRA IZQUIERDA',
      description: '',
      vendor: 'TYC', productType: 'CALAVERA', discountEligible: false,
      regularPrice: 100, offerPrice: 100, available: true
    },
    queryMustContain: 'calavera sentra 2022'
  }
];

const failures = [];

// A Polo fog-light/rejilla request must never be satisfied by a clutch that
// only mentions Polo in a long compatibility list. This reproduces the bad
// answer reported from the live SPR conversation.
const poloFogKitRequest = 'Kit faros antiniebla y rejillas polo 2015 Hatchback';
const poloFogKitItems = [
  {
    id: 'polo-clutch-unrelated',
    title: 'KIT CLUTCH SEAT CORDOBA 4L 2.0 LTS 2003-2009 IBIZA 4L 2.0 LTS 2003-2015 115 HP SOHC VOLKSWAGEN POLO 4L 2.0 LTS 2003-2007 114 HP OHC 5 VELOCIDADES LUK',
    normalizedTitle: normalizeBotText('KIT CLUTCH SEAT CORDOBA 4L 2.0 LTS 2003-2009 IBIZA 4L 2.0 LTS 2003-2015 115 HP SOHC VOLKSWAGEN POLO 4L 2.0 LTS 2003-2007 114 HP OHC 5 VELOCIDADES LUK'),
    vendor: 'LUK', productType: 'CLUTCH', tags: '', description: '', regularPrice: 4057
  },
  {
    id: 'polo-fog-rejilla',
    title: 'KIT FAROS ANTINIEBLA Y REJILLAS VOLKSWAGEN POLO 2015 HATCHBACK',
    normalizedTitle: normalizeBotText('KIT FAROS ANTINIEBLA Y REJILLAS VOLKSWAGEN POLO 2015 HATCHBACK'),
    vendor: '', productType: 'ILUMINACION', tags: '', description: '', regularPrice: 2000
  }
];
const poloFogKitQuery = canonicalizeSprPartSynonyms(poloFogKitRequest);
const poloFogKitMatches = filterStrictSprVehicleMatches(
  findSprEngineMatches(poloFogKitItems, poloFogKitQuery),
  poloFogKitQuery
);
if (poloFogKitMatches.length !== 1 || poloFogKitMatches[0].id !== 'polo-fog-rejilla') {
  failures.push({
    request: poloFogKitRequest,
    matches: poloFogKitMatches.map(item => item.title)
  });
}

for (const request of requests) {
  const normalized = canonicalizeSprPartSynonyms(request);
  const matches = filterStrictSprVehicleMatches(findSprEngineMatches([target], normalized), normalized);
  const searchQueries = buildSprCatalogSearchQueries(request);
  if (matches.length !== 1 || matches[0].id !== target.id || !searchQueries.some(query => query.includes('tornillo estabilizador'))) {
    failures.push({ request, normalized, matches: matches.map(item => item.title), searchQueries });
  }
}

for (const testCase of contextualCases) {
  const item = { ...testCase.item, normalizedTitle: normalizeBotText(testCase.item.title) };
  const normalized = canonicalizeSprPartSynonyms(testCase.request);
  const matches = filterStrictSprVehicleMatches(findSprEngineMatches([item], normalized), normalized);
  const searchQueries = buildSprCatalogSearchQueries(testCase.request);
  if (matches.length !== 1 || matches[0].id !== item.id || !searchQueries.some(query => query.includes(testCase.queryMustContain))) {
    failures.push({ request: testCase.request, normalized, matches: matches.map(found => found.title), searchQueries });
  }
}

const totalCases = requests.length + contextualCases.length + 1;
console.log(`SPR catalog regressions: ${totalCases - failures.length}/${totalCases} passed`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
