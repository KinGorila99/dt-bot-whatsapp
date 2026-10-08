/*
 * Full public SPR catalog regression.
 *
 * Shopify caps products.json pagination at 100 pages. The public sitemap is
 * the complete source of product URLs, so this evaluator reads every product
 * handle from all product sitemaps and exercises the same local matcher with
 * varied natural-language wrappers. It deliberately does not invent stock or
 * prices: it checks that a product-specific request remains tied to its item.
 */
const https = require('node:https');
const fs = require('node:fs');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function loadForEvaluation(request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === 'cors') return () => (req, res, next) => next && next();
  if (request === 'axios') return { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
  if (request === 'firebase-admin') return {
    apps: [], initializeApp() {}, credential: { cert() { return {}; } },
    firestore() { return null; }, auth() { return null; }
  };
  if (request === 'express') {
    const express = () => ({ use() {}, get() {}, post() {}, listen() {} });
    express.json = () => (req, res, next) => next && next();
    return express;
  }
  return originalLoad(request, parent, isMain);
};
const { normalizeBotText, findSprEngineMatches } = require('../index.js');
Module._load = originalLoad;

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'DT Bot Core catalog evaluator' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return fetchText(new URL(response.headers.location, url).href).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`${response.statusCode} ${url}`));
      }
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(chunks.join('')));
    }).on('error', reject);
  });
}

function productUrlsFromSitemap(xml) {
  return [...xml.matchAll(/<loc>(https?:\/\/[^<]+\/products\/[^<]+)<\/loc>/gi)].map(match => match[1].trim());
}

function handleToTitle(url) {
  const handle = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
  return handle.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

function fixture(title) {
  const normalizedTitle = normalizeBotText(title);
  const engine = /\b(motor|engine|cabeza|culata)\b/.test(normalizedTitle);
  return {
    id: title,
    title,
    normalizedTitle,
    vendor: engine ? 'SPR ENGINE SERIES' : 'SPR AUTOPARTES',
    productType: '', tags: '', description: title,
    discountEligible: engine,
    regularPrice: 100, offerPrice: 100, available: true,
    url: 'https://sprautopartes.mx/products/test'
  };
}

async function main() {
  const localUrlsFile = process.env.SPR_PRODUCT_URLS_FILE || '';
  let urls;
  if (localUrlsFile && fs.existsSync(localUrlsFile)) {
    urls = [...new Set(fs.readFileSync(localUrlsFile, 'utf8').split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
  } else {
    const indexXml = await fetchText('https://sprautopartes.mx/sitemap.xml');
    const sitemapUrls = [...indexXml.matchAll(/<loc>(https?:\/\/[^<]*sitemap_products_\d+\.xml[^<]*)<\/loc>/gi)]
      .map(match => match[1].replace(/&amp;/g, '&'));
    const sitemapXml = await Promise.all(sitemapUrls.map(fetchText));
    urls = [...new Set(sitemapXml.flatMap(productUrlsFromSitemap))];
  }
  const wrappers = [
    title => `Busco ${title}`,
    title => `Hola, necesito ${title}, por favor`,
    title => `Tienen ${title}?`,
    title => `Quiero ${title}`,
    title => `Necesito precio de ${title}`,
    title => `Me interesa ${title}`
  ];
  const failures = [];
  let passed = 0;
  for (let index = 0; index < urls.length; index += 1) {
    const title = handleToTitle(urls[index]);
    if (!title) { failures.push({ index, url: urls[index], reason: 'empty title' }); continue; }
    const query = wrappers[index % wrappers.length](title);
    const matches = findSprEngineMatches([fixture(title)], query);
    if (matches.length === 1 && matches[0].id === title) passed += 1;
    else if (failures.length < 50) failures.push({ index, title, query, matches: matches.map(item => item.title) });
  }
  const expectedPublicProducts = 35973;
  console.log(JSON.stringify({
    publicProductUrls: urls.length,
    requestedProductCount: expectedPublicProducts,
    countDifference: expectedPublicProducts - urls.length,
    passed,
    failed: urls.length - passed,
    accuracy: urls.length ? Number((passed / urls.length * 100).toFixed(4)) : 0,
    failures: failures.slice(0, 10)
  }, null, 2));
  if (failures.length || passed !== urls.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
