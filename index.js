/**
 * DT Bot Core & DT CRM Core — Production WhatsApp Cloud API Server
 * Built by DT Marketing
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 5000;

// Capture raw body for Meta HMAC-SHA256 signature verification
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Initialize Firebase Admin SDK
let db = null;
if (!admin.apps.length) {
  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || (
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH && fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8')
    );
    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('✅ Firebase Admin initialized with service account.');
    } else {
      admin.initializeApp();
      console.log('✅ Firebase Admin initialized with Application Default Credentials.');
    }
    db = admin.firestore();
  } catch (e) {
    console.error('❌ Firebase Admin initialization error:', e.message);
  }
} else {
  db = admin.firestore();
}

// Configuration
const MASTER_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'dt_crm_whatsapp_verify_token_2026';
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v26.0';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
// Auto-reactivate the bot after an advisor has been idle.
const HUMAN_HANDOFF_IDLE_MINUTES = Math.max(5, Number(process.env.HUMAN_HANDOFF_IDLE_MINUTES || 30));

function timestampMs(value) {
  if (!value) return 0;
  const parsed = value instanceof Date ? value : new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : 0;
}

// Meta puede entregar el mismo número mexicano como 521XXXXXXXXXX o
// 52XXXXXXXXXX. Además, algunas conversaciones antiguas conservaron el
// prefijo de una empresa migrada. Un único ID canónico evita crear otra ficha
// para el mismo contacto.
function normalizeWhatsAppPhone(value) {
  let digits = String(value || '').replace(/[^0-9]/g, '');
  if (/^521\d{10}$/.test(digits)) digits = `52${digits.slice(3)}`;
  return digits;
}

function canonicalWhatsAppConversationId(companyId, phone) {
  const normalized = normalizeWhatsAppPhone(phone);
  return normalized
    ? `conv_${companyId}_whatsapp_${normalized}`
    : `conv_${companyId}_whatsapp_unknown`;
}

async function loadWhatsAppConversation(dbInstance, companyId, phone) {
  const canonicalId = canonicalWhatsAppConversationId(companyId, phone);
  const directSnap = await dbInstance.doc(`conversations/${canonicalId}`).get();
  const directData = directSnap.exists ? directSnap.data() : null;

  const targetPhone = normalizeWhatsAppPhone(phone);
  if (!targetPhone) return { id: canonicalId, data: directData, legacyIds: [] };

  try {
    const snapshot = await dbInstance.collection('conversations')
      .where('company_id', '==', companyId)
      .where('channel', '==', 'whatsapp')
      .get();
    const matches = snapshot.docs.filter(doc => {
      const data = doc.data() || {};
      const storedPhone = normalizeWhatsAppPhone(data.external_user_id || data.contact_phone);
      return storedPhone === targetPhone;
    });
    if (!matches.length) return { id: canonicalId, data: directData, legacyIds: [] };

    const preferred = matches.find(doc => doc.id === canonicalId)
      || (directData ? { id: canonicalId, data: () => directData } : null)
      || matches.slice().sort((a, b) => timestampMs((b.data() || {}).updated_at) - timestampMs((a.data() || {}).updated_at))[0];
    return {
      id: canonicalId,
      data: { ...(preferred.data() || {}), id: canonicalId },
      legacyIds: matches.filter(doc => doc.id !== canonicalId).map(doc => doc.id)
    };
  } catch (error) {
    console.warn('Could not resolve legacy WhatsApp conversation:', error.message);
    return { id: canonicalId, data: directData, legacyIds: [] };
  }
}

async function migrateConversationMessages(dbInstance, legacyId, canonicalId) {
  if (!legacyId || !canonicalId || legacyId === canonicalId) return;
  try {
    const oldMessages = await dbInstance.collection('messages')
      .where('conversation_id', '==', legacyId)
      .get();
    if (!oldMessages.empty) {
      let batch = dbInstance.batch();
      let writes = 0;
      for (const messageDoc of oldMessages.docs) {
        batch.set(messageDoc.ref, { conversation_id: canonicalId }, { merge: true });
        writes += 1;
        if (writes === 450) {
          await batch.commit();
          batch = dbInstance.batch();
          writes = 0;
        }
      }
      if (writes) await batch.commit();
    }
    await dbInstance.doc(`conversations/${legacyId}`).delete();
    console.log(`🧹 [Conversation Merge] ${legacyId} → ${canonicalId}`);
  } catch (error) {
    console.warn(`Could not merge legacy conversation ${legacyId}:`, error.message);
  }
}

function shouldAutoReactivateBot(conversation, now = Date.now()) {
  if (!conversation || conversation.status === 'closed') return false;
  if (conversation.auto_reactivate_enabled === false) return false;
  if (conversation.human_handoff !== true && conversation.bot_enabled !== false) return false;
  const handoffStartedMs = timestampMs(conversation.last_agent_message_at || conversation.human_handoff_started_at);
  if (!handoffStartedMs) return false;
  return now - handoffStartedMs >= HUMAN_HANDOFF_IDLE_MINUTES * 60 * 1000;
}


function normalizeBotText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFriendlyGreetingText(value) {
  const text = normalizeBotText(value);
  return /^(?:(?:hola|holi|hey|hello)\s+)?(?:hola|holi|hey|hello|buen|buen dia|buenos|buenos dias|buenas|buenas tardes|buenas noches|inicio)$/.test(text);
}

function isCourtesyText(value) {
  const text = normalizeBotText(value);
  return /^(?:(?:muchas|muchisimas|mil)\s+)?gracias(?:\s+(?:por|igualmente|de todos modos|todo|tu|su|te|le)\b.*)?$/.test(text)
    || /^(?:(?:te|le)\s+)?agradezco\b/.test(text);
}

// Customer language varies widely by region and by shop. Keep these aliases
// in one place so the catalog matcher can search the canonical part name while
// still accepting the wording a customer actually uses.
const SPR_PART_SYNONYM_GROUPS = [
  { canonical: 'amortiguador', aliases: ['amortiguador', 'amortiguadores', 'amort', 'pierna completa', 'piernas', 'pierna', 'strut', 'shock', 'shocks'] },
  { canonical: 'base de amortiguador', aliases: ['base de amortiguador', 'bases de amortiguador', 'base amortiguador', 'bases amortiguador', 'base amort', 'bases amort', 'base de pierna', 'bases de pierna'] },
  { canonical: 'bieleta', aliases: ['bieleta', 'canilla', 'canillas', 'link'] },
  { canonical: 'terminal', aliases: ['terminal interior', 'terminal exterior', 'terminales'] },
  { canonical: 'rotula', aliases: ['rotula direccion exterior'] },
  { canonical: 'junta homocinetica', aliases: ['junta homocinetica', 'espiga', 'espigas', 'punta homocinetica', 'punta de flecha'] },
  { canonical: 'horquilla', aliases: ['horquilla', 'brazo de suspension', 'brazo de control', 'tijera', 'meseta'] },
  { canonical: 'caja de direccion', aliases: ['caja de direccion', 'cremallera', 'steering'] },
  { canonical: 'balero', aliases: ['balero', 'rodamiento', 'bearing'] },
  { canonical: 'maza', aliases: ['maza', 'cubo', 'hub'] },
  { canonical: 'flecha', aliases: ['flecha', 'semieje', 'eje homocinetico'] },
  { canonical: 'faro', aliases: ['faro delantero', 'faro', 'headlamp'] },
  { canonical: 'calavera', aliases: ['calavera', 'mica trasera', 'stop', 'rear lamp'] },
  { canonical: 'fascia', aliases: ['fascia', 'facia', 'fasia', 'faccia', 'defensa', 'bumper'] },
  { canonical: 'espejo', aliases: ['espejo', 'retrovisor'] },
  { canonical: 'soporte de motor', aliases: ['soporte de motor', 'base de motor', 'taco de motor'] },
  { canonical: 'embrague', aliases: ['embrague', 'clutch', 'repset'] },
  { canonical: 'tornillo', aliases: ['tornillo', 'estabilizador', 'cacahuate', 'cachuate', 'cahuate', 'cacuate'] }
];

function escapeSprRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SPR_PART_SYNONYM_REPLACERS = SPR_PART_SYNONYM_GROUPS.map(group => {
  const aliases = [...new Set(group.aliases.map(alias => normalizeBotText(alias)))]
    .sort((a, b) => b.length - a.length)
    .map(escapeSprRegex);
  return { canonical: group.canonical, pattern: new RegExp(`\\b(?:${aliases.join('|')})\\b`, 'g') };
});

function canonicalizeSprPartSynonyms(value) {
  let normalized = normalizeBotText(value);
  for (const replacer of SPR_PART_SYNONYM_REPLACERS) {
    normalized = normalized.replace(replacer.pattern, ` ${replacer.canonical} `);
  }
  // Correct a small set of common vehicle-name typos only after the normal
  // accent and part-synonym normalization. This keeps the matcher tolerant
  // without allowing unrelated words to be guessed as a make or model.
  const vehicleAliases = new Map([
    ['kickn', 'kicks'],
    ['kikcs', 'kicks'],
    ['kiccks', 'kicks']
  ]);
  normalized = normalized.split(/\s+/).map(token => vehicleAliases.get(token) || token).join(' ');
  return normalized.replace(/\s+/g, ' ').trim();
}


/**
 * Apply a consistent WhatsApp visual style to every automated reply.
 * Keeps configured and knowledge-base messages readable without changing their meaning.
 */
function decorateWhatsAppKeywordLine(line) {
  const keywordEmojis = [
    [/^\s*(precio normal|precio|costo|cotizaci[oó]n)\b/i, '💰'],
    [/^\s*(disponibilidad|disponible|existencia|stock)\b/i, '✅'],
    [/^\s*(env[ií]o|env[ií]os|entrega)\b/i, '🚚'],
    [/^\s*(garant[ií]a)\b/i, '🛡️'],
    [/^\s*(asesor|asesora|equipo comercial)\b/i, '🧑‍💼'],
    [/^\s*(ubicaci[oó]n|direcci[oó]n|sucursal)\b/i, '📍'],
    [/^\s*(motor|motores|cabeza|cabezas|culata)\b/i, '🔩'],
    [/^\s*(paquete|crm core|whatsapp|api chat bot)\b/i, '🚀']
  ];
  if (!line || /\p{Extended_Pictographic}/u.test(line)) return line;
  for (const [pattern, emoji] of keywordEmojis) {
    if (pattern.test(line)) return emoji + ' ' + line.trim();
  }
  return line;
}

function formatWhatsAppReply(value) {
  let text = String(value || '').replace(/\r/g, '').trim();
  if (!text) return '';

  // Keep each idea readable in WhatsApp instead of sending one flat paragraph.
  text = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/([.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/g, '$1\n')
    .replace(/([.!?])\s+(?=[📍🚚✅🕑🧑🏻‍💻])/gu, '$1\n')
    .replace(/\n{3,}/g, '\n\n');

  // Emphasize useful keywords without bolding the whole response.
  const inlinePatterns = [
    /\b(Lunes\s+a\s+S[áa]bado)\b/gi,
    /\b(24\s+horas)\b/gi,
    /\b(\d{1,2}:\d{2}\s*(?:a\.?\s*m\.?|p\.?\s*m\.?))\b/gi,
    /\b(Precio\s+(?:normal|vigente)|Precio\s+especial\s+exclusivo\s+de\s+septiembre)\b/gi,
    /\b(Querétaro,\s+México)\b/gi
  ];
  for (const pattern of inlinePatterns) {
    text = text.replace(pattern, (match, _group, offset, source) => {
      const before = source.slice(Math.max(0, offset - 1), offset);
      const after = source.slice(offset + match.length, offset + match.length + 1);
      return before === '*' || after === '*' ? match : '*' + match + '*';
    });
  }

  const lines = text.split('\n').map(line => {
    let formatted = decorateWhatsAppKeywordLine(line.trim());
    if (/^Atendemos de\b/i.test(formatted) && !formatted.includes('✅')) formatted += ' ✅';
    if (/^Nuestro canal de WhatsApp y redes sociales/i.test(formatted) && !formatted.includes('🕑')) formatted += ' 🕑';
    if (/^¿Te gustaría que un asesor/i.test(formatted) && !formatted.includes('🧑🏻‍💻')) formatted += ' 🧑🏻‍💻';
    return formatted;
  });
  if (lines[0] && !lines[0].includes('*') && lines[0].trim().length <= 80) {
    lines[0] = '*' + lines[0].trim() + '*';
  }
  return lines.join('\n');
}


const SPR_ENGINE_COLLECTION_URL = process.env.SPR_FULL_CATALOG_URL || process.env.SPR_ENGINE_COLLECTION_URL || 'https://sprautopartes.mx/products.json?limit=250';
const SPR_CATALOG_TTL_MS = Math.max(30000, Number(process.env.SPR_CATALOG_TTL_MS || 60000));
// Shopify product titles may omit trim/package words included in natural-language requests.
// Keep make/model, year, part and side strict while treating these descriptors as optional.
const SPR_OPTIONAL_VEHICLE_WORDS = new Set(['gl','gls','gle','glx','lt','ls','le','lx','ex','se','sv','sr','slt','xlt','xl','xle','xse','mind','mild','sport','touring','limited','premium','plus','classic','sedan','hatchback','hb','coupe','convertible','cabina','cab','sencilla','doble','pickup','pick','up','2wd','4wd','4x2','4x4']);
const SPR_OPTIONAL_VEHICLE_WORDS_PATTERN = /\b(gl|gls|gle|glx|lt|ls|le|lx|ex|se|sv|sr|slt|xlt|xl|xle|xse|mind|mild|sport|touring|limited|premium|plus|classic|sedan|hatchback|hb|coupe|convertible|cabina|cab|sencilla|doble|pickup|pick|up|2wd|4wd|4x2|4x4)\b/gi;
// Promoción de septiembre desactivada: el bot muestra únicamente el precio normal.
const SPR_SEPTEMBER_DISCOUNT_PERCENT = 0;
let sprCatalogCache = { fetchedAt: 0, items: [] };
// SPR does not provide a reliable inventory signal. Collision and lighting
// availability is checked against Aldo Autopartes when the public lookup responds.
const ALDO_STOCK_URL = process.env.ALDO_STOCK_URL || 'https://www.aldoautopartes.com/pi_busqueda.jsp';
const ALDO_STOCK_TIMEOUT_MS = Math.max(3000, Number(process.env.ALDO_STOCK_TIMEOUT_MS || 5000));
const ALDO_STOCK_CACHE_TTL_MS = Math.max(15000, Number(process.env.ALDO_STOCK_CACHE_TTL_MS || 60000));
const ALDO_STOCK_QUERY_PARAMS = String(process.env.ALDO_STOCK_QUERY_PARAMS || 'q,search')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const ALDO_STOCK_CATEGORY_PATTERN = /\b(colision|choque|faro(?:s)?|niebla|calavera(?:s)?|lampara(?:s)?|luz|luces|iluminacion|espejo(?:s)?|parrilla(?:s)?|defensa(?:s)?|fascia(?:s)?|cofre|salpicadera(?:s)?|tolva(?:s)?|bisagra(?:s)?|moldura(?:s)?|manija(?:s)?|rejilla(?:s)?|puerta(?:s)?|cajuela|carroceria)\b/;
const aldoStockCache = new Map();

function isAldoStockCategoryQuery(value) {
  return ALDO_STOCK_CATEGORY_PATTERN.test(canonicalizeSprPartSynonyms(value));
}

function parseAldoStockResponse(data, query) {
  const rawText = typeof data === 'string' ? data : JSON.stringify(data || {});
  const normalizedResponse = normalizeBotText(stripSprHtml(rawText));
  const queryTokens = normalizeBotText(query).split(' ')
    .filter(token => token.length >= 4 && !['quiero', 'busco', 'necesito', 'precio', 'tienes', 'tienen', 'para', 'pieza', 'piezas', 'producto', 'productos', 'disponible', 'disponibilidad', 'stock'].includes(token));
  const snippets = queryTokens.length
    ? queryTokens.map(token => {
      const index = normalizedResponse.indexOf(token);
      return index >= 0 ? normalizedResponse.slice(Math.max(0, index - 240), index + 320) : '';
    }).filter(Boolean)
    : [normalizedResponse.slice(0, 1600)];
  const candidateText = snippets.join(' ');
  const hasProductMatch = queryTokens.length === 0 || queryTokens.some(token => normalizedResponse.includes(token));
  if (!hasProductMatch) return { status: 'unknown', source: 'Aldo Autopartes', reason: 'product_not_found' };
  if (/\b(agotado|sin existencia|no disponible|fuera de stock|existencia 0|stock 0|cantidad 0|disponibilidad 0)\b/.test(candidateText)) {
    return { status: 'out_of_stock', source: 'Aldo Autopartes' };
  }
  if (/\b(disponible|existencia|stock|inventario|en almacen)\b/.test(candidateText)
    || /\b(?:unidades|piezas)\s*[:=]?\s*[1-9]\d*\b/.test(candidateText)) {
    return { status: 'in_stock', source: 'Aldo Autopartes' };
  }
  return { status: 'unknown', source: 'Aldo Autopartes', reason: 'stock_not_explicit' };
}

async function searchAldoStock(query) {
  const cleanQuery = String(query || '').trim();
  const cacheKey = normalizeBotText(cleanQuery);
  const now = Date.now();
  const cached = aldoStockCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < ALDO_STOCK_CACHE_TTL_MS) return cached.result;

  let result = { status: 'unknown', source: 'Aldo Autopartes', reason: 'lookup_failed' };
  for (const queryParam of ALDO_STOCK_QUERY_PARAMS) {
    try {
      const response = await axios.get(ALDO_STOCK_URL, {
        timeout: ALDO_STOCK_TIMEOUT_MS,
        params: { [queryParam]: cleanQuery },
        headers: { 'User-Agent': 'DT Bot Core / Aldo stock lookup', Accept: 'text/html,application/json' }
      });
      result = parseAldoStockResponse(response.data, cleanQuery);
      if (result.status !== 'unknown') break;
    } catch (error) {
      console.warn('⚠️ Aldo stock lookup failed (' + queryParam + '):', error.message);
      result = { status: 'unknown', source: 'Aldo Autopartes', reason: 'lookup_failed' };
      break;
    }
  }
  aldoStockCache.set(cacheKey, { fetchedAt: now, result });
  return result;
}

function parseSprMoney(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatSprMoney(value) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 }).format(value);
}

function stripSprHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function isSeptemberInMexico() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', month: 'numeric' }).format(new Date())) === 9;
}

function getMexicoCityDateParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(value).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function isOctoberDtMarketingPromotionActive(value = new Date()) {
  const mexicoNow = getMexicoCityDateParts(value);
  return mexicoNow >= '2026-10-01T00:00:00' && mexicoNow < '2026-10-30T12:00:00';
}

function normalizeSprProduct(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const variant = variants[0] || {};
  const currentPrice = parseSprMoney(variant.price ?? product?.price);
  const compareAtPrice = parseSprMoney(variant.compare_at_price ?? product?.compare_at_price);
  const regularPrice = compareAtPrice > currentPrice ? compareAtPrice : currentPrice;
  const title = String(product?.title || '').trim();
  const vendor = String(product?.vendor || 'SPR ENGINE SERIES').trim();
  const productType = String(product?.product_type || '').trim();
  const tags = Array.isArray(product?.tags) ? product.tags.join(' ') : String(product?.tags || '');
  const classificationText = normalizeBotText([title, productType, tags].filter(Boolean).join(' '));
  const isHeadOrCylinder = /\b(cabeza(?:s)?|culata(?:s)?)\b/.test(classificationText);
  const isEngineSeries = /\bengine\s+series\b/.test(classificationText);
  const hasMotorKeyword = /\bmotor(?:es)?\b/.test(classificationText);
  const isAccessoryOrMount = /\b(soporte(?:s)?|base(?:s)?|taco(?:s)?|montura(?:s)?|mount(?:s)?|sensor(?:es)?|refaccion(?:es)?|accesorio(?:s)?)\b/.test(classificationText);
  const isNonEngineProduct = /\b(faro(?:s)?|niebla|calavera(?:s)?|lampara(?:s)?|luz|luces|espejo(?:s)?|amortiguador(?:es)?|suspension|freno(?:s)?|balata(?:s)?|pastilla(?:s)?|aceite(?:s)?|lubricante(?:s)?|radiador(?:es)?|bomba(?:s)?|turbo(?:s)?|embrague|clutch|direccion|terminal(?:es)?|rotula(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|salpicadera(?:s)?|carroceria|soporte(?:s)?|base(?:s)?|taco(?:s)?|montura(?:s)?|mount(?:s)?|sensor(?:es)?|accesorio(?:s)?|limpiaparabrisas)\b/.test(classificationText); const discountEligible = !isNonEngineProduct && (isEngineSeries || isHeadOrCylinder || hasMotorKeyword);
  const september = isSeptemberInMexico();
  const calculatedSeptemberPrice = regularPrice > 0
    ? Math.round(regularPrice * (1 - SPR_SEPTEMBER_DISCOUNT_PERCENT / 100) * 100) / 100
    : 0;
  const offerPrice = discountEligible && september ? calculatedSeptemberPrice : currentPrice;
  const hasSeptemberOffer = discountEligible && september && offerPrice > 0 && regularPrice > offerPrice;
  const available = variants.length > 0
    ? variants.some(item => item.available !== false)
    : product?.available !== false;
  const handle = String(product?.handle || '').trim();
  return {
    id: product?.id || handle,
    title,
    normalizedTitle: normalizeBotText(title),
    handle,
    vendor,
    productType,
    tags,
    description: stripSprHtml(product?.body_html),
    available,
    regularPrice,
    offerPrice: hasSeptemberOffer ? offerPrice : currentPrice,
    hasSeptemberOffer,
    discountEligible,
    url: handle ? 'https://sprautopartes.mx/products/' + handle : 'https://sprautopartes.mx/collections/spr-engine-series'
  };
}

async function getSprEngineCatalog() {
  const now = Date.now();
  if (sprCatalogCache.items.length > 0 && now - sprCatalogCache.fetchedAt < SPR_CATALOG_TTL_MS) return sprCatalogCache.items;
  const response = await axios.get(SPR_ENGINE_COLLECTION_URL, {
    timeout: 9000,
    headers: { 'User-Agent': 'DT Bot Core / SPR catalog sync' }
  });
  const products = Array.isArray(response.data?.products) ? response.data.products : [];
  if (!products.length) throw new Error('SPR catalog returned no products');
  const items = products.map(normalizeSprProduct).filter(item => item.title && item.regularPrice > 0);
  sprCatalogCache = { fetchedAt: now, items };
  return items;
}

async function searchSprCatalog(query) {
  const response = await axios.get('https://sprautopartes.mx/search/suggest.json', {
    // Allow the catalog a little more time to return a useful result. A
    // missing hit here should not immediately become a false "no existe".
    timeout: 12000,
    params: {
      q: String(query || '').trim(),
      'resources[type]': 'product',
      // The first ten Shopify suggestions can be dominated by nearby
      // products. Fetch a wider window and apply our vehicle/part filters
      // locally before deciding that nothing matches.
      'resources[limit]': 24
    },
    headers: { 'User-Agent': 'DT Bot Core / SPR catalog search' }
  });
  const products = Array.isArray(response.data?.resources?.results?.products)
    ? response.data.resources.results.products
    : [];
  return products.map(normalizeSprProduct).filter(item => item.title && item.regularPrice > 0);
}

// Compare catalog tokens without letting punctuation differences break a
// valid vehicle match, such as `NP300` vs `NP-300`.
function sprTokenMatches(haystack, token) {
  const normalizedToken = normalizeBotText(token).trim();
  if (!normalizedToken) return false;
  // Numeric model fragments must not match inside another number (e.g. model
  // L200 must not match the unrelated number 2500). Allow a letter boundary
  // so compact catalog handles such as `l200` still resolve correctly.
  if (/^\d+$/.test(normalizedToken)) {
    return new RegExp(`(?:^|[^0-9])${normalizedToken}(?:$|[^0-9])`).test(haystack);
  }
  if (haystack.includes(normalizedToken)) return true;
  const compactToken = normalizedToken.replace(/[^a-z0-9]/g, '');
  if (compactToken.length < 3) return false;
  return haystack.replace(/[^a-z0-9]/g, '').includes(compactToken);
}

function isSprEngineSpecificationToken(token) {
  const normalized = normalizeBotText(token).replace(/\s+/g, '');
  return /^(?:\d+(?:\.\d+)?l?|\d+v|\d+cil|cilindros?|valvulas?|\d+(?:[-/]\d+)+|gasolina|diesel|manual|automatico|transmision)$/.test(normalized);
}

function findSprEngineMatches(items, lowerText) {
  // Match against the focused request so greetings, courtesy and question
  // wording cannot become accidental vehicle/model tokens.
  const normalizedQuery = buildSprFocusedSearchQuery(lowerText);
  const stopWords = new Set(['quiero', 'quieres', 'busco', 'buscando', 'necesito', 'ocupo', 'dame', 'tienes', 'tienen', 'hay', 'para', 'una', 'uno', 'precio', 'precios', 'cuanto', 'cuesta', 'costo', 'cotizacion', 'cotizar', 'comprar', 'compra', 'nuevo', 'nueva', 'disponible', 'disponibilidad', 'por', 'favor', 'me', 'interesa', 'motor', 'motores', 'cabeza', 'cabezas', 'culata', 'engine', 'series', 'de', 'del', 'es', 'el', 'la', 'los', 'las', 'un', 'y', 'o', 'mi', 'auto', 'carro', 'vehiculo', 'vehículo', 'producto', 'productos', 'catalogo', 'catalog', 'refaccion', 'refacciones', 'pieza', 'piezas', 'stock', 'completo', 'completa', 'todo', 'toda', 'todos', 'todas', 'ver', 'muestrame', 'muéstrame', 'informacion', 'información', 'que', 'qué', 'marca', 'modelo', 'ano', 'año', 'version', 'delantero', 'delantera', 'delanteros', 'delanteras', 'trasero', 'trasera', 'traseros', 'traseras', 'izquierdo', 'izquierda', 'izquierdos', 'izquierdas', 'derecho', 'derecha', 'derechos', 'derechas', 'lado', 'principal', 'niebla', 'antiniebla', 'no', 'sin', 'valvula', 'valvulas', 'cil', 'cilindro', 'cilindros', 'con', 'abs', 'fwd', 'birlo', 'birlos', 'piloto', 'chofer', 'conductor', 'pasajero', 'cabina', 'cab', 'sencilla', 'doble', 'ocupo']);
  const tokens = normalizedQuery.split(' ').filter(token => token.length >= 3 && !stopWords.has(token));
  const categoryRules = [
    { key: 'motor', pattern: /\bmotor(?:es)?\b/ },
    { key: 'cabeza', pattern: /\b(cabeza(?:s)?|culata(?:s)?)\b/ },
    { key: 'amortiguador', pattern: /\bamortiguador(?:es)?\b/ },
    { key: 'suspension', pattern: /\bsuspension\b/ },
    { key: 'freno', pattern: /\b(freno(?:s)?|balata(?:s)?|pastilla(?:s)?)\b/ },
    { key: 'aceite', pattern: /\b(aceite(?:s)?|lubricante(?:s)?|motul|valvoline|pentosin)\b/ },
    { key: 'direccion', pattern: /\b(direccion|terminal|rotula|caja de direccion)\b/ },
    { key: 'radiador', pattern: /\b(radiador(?:es)?|enfriamiento|cooling)\b/ },
    { key: 'bomba', pattern: /\bbomba(?:s)?\b/ },
    { key: 'turbo', pattern: /\bturbo(?:s)?\b/ },
    { key: 'embrague', pattern: /\b(embrague|clutch)\b/ },
    { key: 'maza', pattern: /\b(?:maza(?:s)?|balero(?:s)?(?:\s+de)?(?:\s+maza)?)\b/ },
    { key: 'bieleta', pattern: /\b(?:bieleta(?:s)?|canilla(?:s)?|link)\b/ },
    { key: 'junta', pattern: /\b(?:junta\s+homocinetica|espiga(?:s)?|punta\s+(?:homocinetica|de\s+flecha))\b/ },
    { key: 'horquilla', pattern: /\b(?:horquilla(?:s)?|brazo\s+(?:de\s+)?(?:suspension|control)|tijera(?:s)?|meseta(?:s)?)\b/ },
    { key: 'flecha', pattern: /\b(?:flecha(?:s)?|semieje(?:s)?|eje\s+homocinetico)\b/ },
    { key: 'fascia', pattern: /\b(?:fascia(?:s)?|defensa(?:s)?|bumper(?:s)?)\b/ },
    { key: 'tornillo', pattern: /\b(?:tornillo(?:s)?|estabilizador(?:es)?|cacahuate(?:s)?|cachuate(?:s)?|cahuate(?:s)?|cacuate(?:s)?)\b/ },
    { key: 'soporte', pattern: /\bsoporte(?:s)?\b/ },
    { key: 'iluminacion', pattern: /\b(faro(?:s)?|calavera(?:s)?|lampara(?:s)?|luz|luces|espejo(?:s)?)\b/ },
    { key: 'carroceria', pattern: /\b(parrilla(?:s)?|rejilla(?:s)?|defensa(?:s)?|cofre|salpicadera(?:s)?|carroceria)\b/ }
  ];
  let requestedCategory = categoryRules.find(rule => rule.pattern.test(normalizedQuery));
  // A vehicle engine specification can appear alongside the requested part
  // (for example: "amortiguadores ... motor 4.6 2v"). Prefer the explicit
  // part category so the word "motor" does not route the request to engines.
  const explicitNonEngineCategory = categoryRules.find(rule => !['motor', 'cabeza'].includes(rule.key) && rule.pattern.test(normalizedQuery));
  if (requestedCategory?.key === 'motor' && explicitNonEngineCategory) requestedCategory = explicitNonEngineCategory;
  const requestedYears = [...normalizedQuery.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
  const requestedOrientation = normalizedQuery.match(/\b(izquierdo|izquierda|izquierdos|izquierdas|derecho|derecha|derechos|derechas|delantero|delantera|delanteros|delanteras|trasero|trasera|traseros|traseras|piloto|chofer|conductor|pasajero|copiloto)\b/)?.[1] || '';
  const sideSemanticContext = /\b(?:lado|costado)\b/.test(normalizedQuery) || requestedCategory?.key === 'iluminacion';
  const requestedSide = /\b(?:izquierdo|izquierda|izquierdos|izquierdas)\b/.test(normalizedQuery)
    ? 'left'
    : /\b(?:derecho|derecha|derechos|derechas)\b/.test(normalizedQuery)
      ? 'right'
      : sideSemanticContext && /\b(?:piloto|chofer|conductor)\b/.test(normalizedQuery)
        ? 'left'
        : sideSemanticContext && /\b(?:pasajero|copiloto)\b/.test(normalizedQuery)
          ? 'right'
      : '';
  const requestedPosition = /\b(?:delantero|delantera|delanteros|delanteras|frontal|delant)\b/.test(normalizedQuery)
    ? 'front'
    : /\b(?:trasero|trasera|traseros|traseras|posterior|tras)\b/.test(normalizedQuery)
      ? 'rear'
      : '';
  const negativeFogRequest = /\b(?:no|sin|evitar|ningun|ninguna)\b(?:\s+\w+){0,8}\s+(?:faro\s+de\s+)?niebla\b/.test(normalizedQuery);
  // In a request such as "rejilla sin faro de niebla", the fog phrase is a
  // negative feature of the grille. It must not turn the request into a fog
  // lamp search or discard the grille as an unrelated lighting product.
  if (negativeFogRequest) {
    const nonLightingCategory = categoryRules.find(rule => rule.key !== 'iluminacion' && rule.pattern.test(normalizedQuery));
    if (nonLightingCategory) requestedCategory = nonLightingCategory;
  }
  const asksFogLight = !negativeFogRequest && /\b(?:faro\s+de\s+niebla|niebla|antiniebla)\b/.test(normalizedQuery);
  const asksMainLight = !negativeFogRequest && !asksFogLight && /\b(?:faro|faros|principal|delantero|delantera)\b/.test(normalizedQuery);
  const requestsManual = /\bmanual(?:es)?\b/.test(normalizedQuery);
  const requestsElectric = /\b(?:electrico|electrica|electricos|electricas)\b/.test(normalizedQuery);
  const wantsHead = /\b(cabeza(?:s)?|culata(?:s)?)\b/.test(normalizedQuery);
  const wantsMotorAccessory = /\b(soporte(?:s)?|base(?:s)?|taco(?:s)?|montura(?:s)?|mount(?:s)?|sensor(?:es)?|accesorio(?:s)?)\b/.test(normalizedQuery);
  const wantsMotor = requestedCategory?.key === 'motor' && /\bmotor(?:es)?\b/.test(normalizedQuery) && !wantsHead && !wantsMotorAccessory;
  const motorAccessoryPattern = /\b(soporte(?:s)?|base(?:s)?|taco(?:s)?|montura(?:s)?|mount(?:s)?|sensor(?:es)?|accesorio(?:s)?)\b/;
  // A request for a motor must never be answered with a cylinder head. The
  // catalog uses both words in some titles (for example, "cabeza motor"), so
  // exclude any head/cylinder listing unless the customer explicitly asked
  // for a head.
  const onlyEngineProducts = rows => wantsMotor
    ? rows.filter(row => row.item.discountEligible === true
      && !motorAccessoryPattern.test(row.haystack)
      && /\b(?:motor|engine(?:\s+series)?)\b/.test(row.haystack)
      && !/\b(?:cabeza|culata)\b/.test(row.haystack))
    : rows;
  const itemHasFogLight = item => /\b(?:niebla|antiniebla)\b/.test(item.normalizedTitle);
  const itemMatchesRequestedYear = item => {
    if (!requestedYears.length) return true;
    const source = String(item.title || '') + ' ' + String(item.description || '') + ' ' + String(item.tags || '');
    const explicitYears = [...source.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
    const ranges = [...source.matchAll(/\b((?:19|20)\d{2})\s*[-–/]\s*((?:19|20)\d{2})\b/g)]
      .map(match => [Number(match[1]), Number(match[2])]);
    return requestedYears.some(year => explicitYears.includes(year) || ranges.some(([start, end]) => year >= Math.min(start, end) && year <= Math.max(start, end)));
  };
  const itemMatchesRequestedOrientation = item => {
    const title = item.normalizedTitle || '';
    const bilateral = /\bamb[oa]s\s+lados?\b/.test(title) || /\bamb[oa]s\b/.test(title);
    const titleIsRearLamp = /\b(?:calavera|stop|rear\s+lamp)\b/.test(title);
    if (requestedSide === 'left' && !(/\bizquierd[oa]\b/.test(title) || bilateral)) return false;
    if (requestedSide === 'right' && !(/\bderech[oa]\b/.test(title) || bilateral)) return false;
    if (requestedPosition === 'front' && !(/\b(?:delanter[oa]s?|frontal(?:es)?|delant)\b/.test(title) || (requestedCategory?.key === 'iluminacion' && !titleIsRearLamp))) return false;
    if (requestedPosition === 'rear' && !(/\b(?:traser[oa]s?|posterior(?:es)?|tras)\b/.test(title) || titleIsRearLamp)) return false;
    return true;
  };
  const scored = items.map(item => {
    let score = 0;
    const haystack = canonicalizeSprPartSynonyms([item.normalizedTitle, normalizeBotText(item.vendor), normalizeBotText(item.productType), normalizeBotText(item.tags), normalizeBotText(item.description), normalizeBotText(item.handle)].join(' '));
    const matchedTokens = [];
    for (const token of tokens) {
      if (sprTokenMatches(haystack, token)) {
        matchedTokens.push(token);
        score += item.normalizedTitle.includes(token) ? 5 : 2;
      }
    }
    if (requestedCategory && requestedCategory.pattern.test(haystack)) score += 14;
    if (wantsHead) score += /\b(cabeza|culata)\b/.test(haystack) ? 12 : -8;
    if (wantsMotor) score += /\bmotor\b/.test(haystack) ? 5 : -3;
    if (requestedYears.length && itemMatchesRequestedYear(item)) score += 10;
    if (asksMainLight && requestedCategory?.key === 'iluminacion') score += itemHasFogLight(item) ? -20 : 10;
    if (asksFogLight && requestedCategory?.key === 'iluminacion') score += itemHasFogLight(item) ? 12 : -20;
    return { item, score, haystack, matchedTokens };
  }).sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));

  if (!tokens.length) {
    const noTokenMatches = requestedCategory
      ? scored.filter(row => requestedCategory.pattern.test(row.haystack))
      : scored;
    return onlyEngineProducts(noTokenMatches)
      .filter(row => itemMatchesRequestedYear(row.item))
      .filter(row => itemMatchesRequestedOrientation(row.item))
      .filter(row => !requestedCategory || requestedCategory.key !== 'iluminacion' || (asksFogLight ? itemHasFogLight(row.item) : !itemHasFogLight(row.item)))
      .slice(0, 3).map(row => row.item);
  }

  let relevant = onlyEngineProducts(scored.filter(row => row.score > 0));
  if (requestedCategory) {
    const categoryMatches = relevant.filter(row => requestedCategory.pattern.test(row.haystack));
    if (!categoryMatches.length) return [];
    relevant = categoryMatches;
  }

  if (requestedYears.length) {
    const yearMatches = relevant.filter(row => itemMatchesRequestedYear(row.item));
    if (!yearMatches.length) return [];
    relevant = yearMatches;
  }

  if (requestedOrientation) {
    const orientationMatches = relevant.filter(row => itemMatchesRequestedOrientation(row.item));
    if (!orientationMatches.length) return [];
    relevant = orientationMatches;
  }

  if (requestedCategory?.key === 'iluminacion') {
    const lightingMatches = relevant.filter(row => asksFogLight ? itemHasFogLight(row.item) : !itemHasFogLight(row.item));
    if (!lightingMatches.length) return [];
    relevant = lightingMatches;
  }

  // Features such as manual/electric are refinements. Prefer an exact feature
  // match when the catalog has one, but do not turn a valid vehicle/part hit
  // into a false negative when the title omits that qualifier.
  if (requestsManual) {
    const manualMatches = relevant.filter(row => /\bmanual(?:es)?\b/.test(row.haystack));
    if (manualMatches.length) relevant = manualMatches;
  } else if (requestsElectric) {
    const electricMatches = relevant.filter(row => /\belectr(?:ico|ica|icos|icas)\b/.test(row.haystack));
    if (electricMatches.length) relevant = electricMatches;
  }

  // Every meaningful make/model token must appear in the same product.
  // Engine specs such as `2.4`, `16V`, `4CIL` and `3-4` describe the
  // requested configuration; they are useful for ranking but must not make
  // us reject a product whose title formats them differently.
  const vehicleTokens = tokens
    .filter(token => !categoryRules.some(rule => rule.pattern.test(token)) && !/^\d{4}$/.test(token))
    .filter(token => !SPR_OPTIONAL_VEHICLE_WORDS.has(token))
    .filter(token => !isSprEngineSpecificationToken(token))
    .filter(token => token.length >= 3 && !['spr'].includes(token));
  if (vehicleTokens.length) {
    const exactVehicleMatches = relevant.filter(row => vehicleTokens.every(token => sprTokenMatches(row.haystack, token)));
    if (!exactVehicleMatches.length) return [];
    relevant = exactVehicleMatches;
  }

  return relevant.slice(0, 3).map(row => row.item);
}

// Keep a specific vehicle request tied to the same vehicle in every catalog
// path, including the live Shopify search fallback. This is a final guard in
// case the search provider returns broad results for a query such as
// \"Chevrolet Corsa 2005 motor remanufacturado\".
function filterStrictSprVehicleMatches(matches, query) {
  const normalized = compactSprVehicleModelTokens(canonicalizeSprPartSynonyms(query));
  const requestedYears = [...normalized.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
  const qualifierPattern = /\b(remanufacturad[oa]s?|reconstruid[oa]s?|usad[oa]s?|nuev[oa]s?|complet[oa]s?|original(?:es)?|generico(?:s)?|generica(?:s)?)\b/g;
  const identityTokens = normalized
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ').replace(SPR_CATALOG_EXTRA_FILLER_PATTERN, ' ').replace(SPR_OPTIONAL_VEHICLE_WORDS_PATTERN, ' ').replace(qualifierPattern, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .split(/\s+/)
    .filter(token => (token.length >= 3 || (token.length >= 2 && /\d/.test(token))) && !['spr', 'ocupo'].includes(token))
    .filter(token => !isSprEngineSpecificationToken(token));
  if (!identityTokens.length && !requestedYears.length) return matches;

  return matches.filter(item => {
    const haystack = canonicalizeSprPartSynonyms([item.normalizedTitle, normalizeBotText(item.vendor), normalizeBotText(item.productType), normalizeBotText(item.tags), normalizeBotText(item.description), normalizeBotText(item.handle)].join(' '));
    if (!identityTokens.every(token => sprTokenMatches(haystack, token))) return false;
    if (!requestedYears.length) return true;
    const source = [item.title, item.description, item.tags].map(value => String(value || '')).join(' ');
    const explicitYears = [...source.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
    const ranges = [...source.matchAll(/\b((?:19|20)\d{2})\s*[-/]\s*((?:19|20)\d{2})\b/g)]
      .map(match => [Number(match[1]), Number(match[2])]);
    return requestedYears.some(year => explicitYears.includes(year) || ranges.some(([start, end]) => year >= Math.min(start, end) && year <= Math.max(start, end)));
  });
}

function getSprYearClarification(value) {
  const normalized = normalizeBotText(value);
  const invalidYears = [...normalized.matchAll(/\b(?!19|20)\d{4}\b/g)].map(match => match[0]);
  if (!invalidYears.length) return null;
  const invalidYear = invalidYears[0];
  const numeric = Number(invalidYear);
  const suggestedYear = numeric >= 3000 && numeric <= 3999 ? String(2000 + (numeric % 100)) : '';
  return { invalidYear, suggestedYear };
}
function getSprConfirmationPart(value) { const normalized = canonicalizeSprPartSynonyms(value); const rules = [['la cabeza de motor', /\b(?:cabeza(?:s)?(?:\s+de)?\s+motor|culata(?:s)?)\b/], ['el motor', /\bmotor(?:es)?\b/], ['la tolva', /\btolva(?:s)?\b/], ['el faro de niebla', /\bfaro(?:s)?\s+(?:de\s+)?niebla\b/], ['el faro principal', /\bfaro(?:s)?\s+(?:principal|delantero|delantera)\b/], ['el faro', /\bfaro(?:s)?\b/], ['la calavera', /\bcalavera(?:s)?\b/], ['la lampara', /\blampara(?:s)?\b/], ['el espejo', /\bespejo(?:s)?\b/], ['la parrilla', /\bparrilla(?:s)?\b/], ['la defensa', /\b(?:defensa|fascia)(?:s)?\b/], ['el cofre', /\bcofre\b/], ['la salpicadera', /\bsalpicadera(?:s)?\b/], ['el amortiguador', /\bamortiguador(?:es)?\b/], ['la suspension', /\bsuspension\b/], ['el freno', /\bfreno(?:s)?\b/], ['la balata', /\bbalata(?:s)?\b/], ['el aceite', /\baceite(?:s)?\b/], ['la caja de direccion', /\bcaja\s+de\s+direccion\b/], ['la direccion', /\bdireccion\b/], ['la terminal', /\bterminal(?:es)?\b/], ['la rotula', /\brotula(?:s)?\b/], ['la maza', /\bmaza(?:s)?\b/], ['el balero', /\bbalero(?:s)?\b/], ['la bieleta', /\bbieleta(?:s)?\b/], ['la junta homocinetica', /\bjunta\s+homocinetica\b/], ['la horquilla', /\bhorquilla(?:s)?\b/], ['la flecha', /\bflecha(?:s)?\b/], ['el tornillo', /\btornillo(?:s)?\b/], ['el radiador', /\bradiador(?:es)?\b/], ['la bomba', /\bbomba(?:s)?\b/], ['el turbo', /\bturbo(?:s)?\b/], ['el embrague', /\b(?:embrague|clutch)\b/], ['el soporte', /\bsoporte(?:s)?\b/], ['la pieza', /\bpieza(?:s)?\b/]]; const match = rules.find(([, pattern]) => pattern.test(normalized)); return match ? match[0] : 'la pieza'; } function isSprYearConfirmation(value) {
  return /\b(si|correcto|correcta|exacto|exacta|afirmativo|asi)\b/.test(normalizeBotText(value));
}
// Search Shopify with useful vehicle and part terms instead of the full sentence.
// The catalog search is sensitive to filler words and trim details, while make/model,
// year, part and side are the terms that identify the item.
// Shopify recibe únicamente términos que identifican el artículo. Descartar
// la redacción de la pregunta evita que el buscador interprete "para mi carro"
// o "marca/modelo/año" como parte del nombre del producto.
const SPR_SEARCH_FILLER_PATTERN = /\b(estoy|buscando|quiero|busco|necesito|ocupo|requiero|deseo|me|interesa|interesado|interesada|gustaria|dame|tienes|tienen|hay|para|una|uno|un|el|la|los|las|mi|mis|por|favor|que|cotizacion|cotizar|precio|precios|cuanto|cuesta|costo|disponible|disponibilidad|stock|marca|modelo|ano|version|articulo|articulos|pieza|piezas|refaccion|refacciones|producto|productos|auto|carro|vehiculo|vehiculos|coche|camioneta|camion|vengo|spr|autopartes|asesoria|hola|holi|hey|buen|buenos|buenas|dia|dias|puedes|pueden|podrias|podrian|consultar|consulta|ayuda|ayudar|dime|tambien|porfa|porfavor|del|es|cabina|cab|sencilla|doble|de|y)\b/gi;
function compactSprVehicleModelTokens(value) {
  return String(value || '').replace(/\b([a-z]{1,3})\s+(\d{2,4})\b/gi, (match, prefix, number) => {
    if (['ano', 'modelo', 'version'].includes(String(prefix).toLowerCase())) return match;
    return `${prefix}${number}`;
  });
}
function buildSprFocusedSearchQuery(value) {
  const normalized = compactSprVehicleModelTokens(canonicalizeSprPartSynonyms(value));
  const focused = normalized
    .replace(SPR_SEARCH_FILLER_PATTERN, ' ')
    .replace(SPR_OPTIONAL_VEHICLE_WORDS_PATTERN, ' ')
        .replace(/\b(?!19|20)\d{4}\b/g, ' ')
.replace(/\s+/g, ' ')
    .trim();
  return focused || normalized;
}

// Shopify search is much more forgiving when the part and vehicle are sent
// separately. Build a few bounded alternatives so natural language such as
// "maza balero delantero derecho con ABS" can resolve the catalog title that
// only uses "maza" while still preserving make, model and year.
function buildSprCatalogSearchQueries(value) {
  const originalNormalized = normalizeBotText(value);
  const normalized = canonicalizeSprPartSynonyms(value);
  const focused = buildSprFocusedSearchQuery(value);
  const originalFocused = originalNormalized === normalized ? focused : buildSprFocusedSearchQuery(originalNormalized);
  const partGroups = [
    { pattern: /\b(?:maza(?:s)?|balero(?:s)?|balero(?:s)?\s+de\s+maza)\b/, terms: ['maza', 'balero'] },
    { pattern: /\b(?:amortiguador(?:es)?|strut)\b/, terms: ['amortiguador', 'strut'] },
    { pattern: /\b(?:faro(?:s)?|lampara(?:s)?)\b/, terms: ['faro', 'lampara'] },
    { pattern: /\b(?:calavera(?:s)?|stop(?:s)?)\b/, terms: ['calavera', 'stop'] },
    { pattern: /\b(?:freno(?:s)?|balata(?:s)?|pastilla(?:s)?)\b/, terms: ['freno', 'balata'] },
    { pattern: /\b(?:direccion|terminal(?:es)?|rotula(?:s)?)\b/, terms: ['direccion', 'terminal'] },
    { pattern: /\b(?:radiador(?:es)?|enfriamiento)\b/, terms: ['radiador'] },
    { pattern: /\b(?:motor(?:es)?|cabeza(?:s)?|culata(?:s)?)\b/, terms: ['motor', 'cabeza'] },
    { pattern: /\b(?:espejo(?:s)?|retrovisor(?:es)?)\b/, terms: ['espejo', 'retrovisor'] },
    { pattern: /\b(?:bieleta(?:s)?|junta\s+homocinetica|espiga(?:s)?|horquilla(?:s)?|flecha(?:s)?|fascia(?:s)?|tornillo(?:s)?|estabilizador(?:es)?|cacahuate(?:s)?|cachuate(?:s)?)\b/, terms: ['bieleta', 'junta', 'horquilla', 'flecha', 'fascia', 'tornillo', 'tornillo estabilizador'] }
  ];
  const partGroup = partGroups.find(group => group.pattern.test(normalized));
  const vehicleText = buildSprFocusedSearchQuery(normalized)
    .replace(partGroup?.pattern || /$^/, ' ')
    .replace(/\b(?:hola|vengo|spr|autopartes|asesoria|suspension|marca|modelo|ano|a[nñ]o|delantero|delantera|trasero|trasera|izquierdo|izquierda|derecho|derecha|lado|frente|atras|del|es|piloto|chofer|conductor|pasajero|manual|cabina|cab|sencilla|doble|con|sin|abs|fwd|birlo|birlos)\b/g, ' ')
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const requestedPartTerm = partGroup?.terms.find(term => new RegExp(`\\b${escapeSprRegex(term)}\\b`).test(normalized));
  const relatedPartTerms = requestedPartTerm === 'tornillo' && partGroup?.terms.includes('tornillo estabilizador')
    ? ['tornillo estabilizador']
    : [];
  const orderedPartTerms = requestedPartTerm
    ? [requestedPartTerm, ...relatedPartTerms, ...partGroup.terms.filter(term => term !== requestedPartTerm && !relatedPartTerms.includes(term))]
    : (partGroup?.terms || []);
  const candidates = [focused, originalFocused];
  if (partGroup && vehicleText) {
    for (const term of orderedPartTerms) {
      // Search in both word orders. Shopify does not consistently rank a
      // title the same way when the part precedes or follows the vehicle.
      candidates.push(`${term} ${vehicleText}`);
      candidates.push(`${vehicleText} ${term}`);
    }
  }
  // If the title omits the part alias or trim text, a vehicle-only pass lets
  // the local matcher recover the requested part from the wider result set.
  if (vehicleText) candidates.push(vehicleText);
  return [...new Set(candidates.map(query => String(query || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 8);
}
// A short follow-up such as "delantero" or "izquierdo" is a refinement of
// the customer's previous catalog request. Keep the vehicle and part from
// that previous turn so a side/orientation answer cannot jump to another
// make or model.
const SPR_CATALOG_CONTEXT_PATTERN = /\b(motor(?:es)?|cabeza(?:s)?|culata|engine series|amortiguador(?:es)?|suspensi[oó]n|freno(?:s)?|balata(?:s)?|pastilla(?:s)?|aceite|refacci[oó]n(?:es)?|pieza(?:s)?|producto(?:s)?|direcci[oó]n|radiador|bomba|turbo|embrague|clutch|maza(?:s)?|balero(?:s)?|bieleta(?:s)?|junta\s+homocinetica|horquilla(?:s)?|flecha(?:s)?|gu[ií]a(?:s)?|fascia(?:s)?|tornillo(?:s)?|soporte|terminal|r[oó]tula|faro(?:s)?|calavera(?:s)?|l[aá]mpara(?:s)?|luz|luces|espejo(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|salpicadera(?:s)?|carrocer[ií]a)\b/;
const SPR_CATALOG_REFINEMENT_PATTERN = /\b(delantero|delantera|trasero|trasera|izquierdo|izquierda|derecho|derecha|lado|frente|atr[aá]s|modelo|a[nñ]o|versi[oó]n|principal|niebla|antiniebla|motor)\b/;

// Do not guess a vehicle from a generic part request. Ask for the vehicle
// before searching so the bot cannot return an unrelated make or model.
const SPR_CATALOG_GENERIC_WORDS_PATTERN = /\b(estoy|buscando|quiero|busco|necesito|ocupo|requiero|deseo|interesa|interesado|interesada|gustaria|dame|tienes|tienen|hay|para|una|uno|un|el|la|los|las|mi|mis|que|qué|por|favor|de|precio|precios|cuanto|cu[aá]nto|cuesta|costo|cotizacion|cotizaci[oó]n|cotizar|comprar|compra|nuevo|nueva|disponible|disponibilidad|stock|catalogo|cat[aá]logo|producto|productos|pieza|piezas|refaccion|refacciones|motor|motores|cabeza|cabezas|culata|engine|series|amortiguador|amortiguadores|suspension|freno|frenos|balata|balatas|pastilla|pastillas|aceite|lubricante|lubricantes|direccion|terminal|terminales|rotula|rotulas|radiador|radiadores|bomba|bombas|turbo|turbos|embrague|clutch|maza|mazas|balero|baleros|bieleta|bieletas|junta|homocinetica|horquilla|horquillas|flecha|flechas|guia|guias|fascia|fascias|soporte|soportes|faro|faros|niebla|antiniebla|principal|calavera|calaveras|lampara|lamparas|luz|luces|espejo|espejos|parrilla|parrillas|defensa|defensas|tornillo|tornillos|cofre|salpicadera|salpicaderas|carroceria|delantero|delantera|delanteros|delanteras|trasero|trasera|traseros|traseras|izquierdo|izquierda|izquierdos|izquierdas|derecho|derecha|derechos|derechas|lado|frente|atras|modelo|ano|version|auto|carro|vehiculo|vehiculos|coche|camioneta|camion|camiones|completo|completa|todo|toda|todos|todas|no|sin|evitar|ningun|ninguna)\b/gi;
// Conversational words are removed only from vehicle-identity checks. They
// must never make a valid catalog request look like a different vehicle.
const SPR_CATALOG_EXTRA_FILLER_PATTERN = /\b(hola|holi|hey|hello|buen|buenos|buenas|dia|dias|vengo|spr|autopartes|asesoria|marca|modelo|ano|version|puedes|pueden|podrias|podrian|consultar|consulta|ayuda|ayudar|dime|tambien|porfa|porfavor|articulo|articulos|refaccion|refacciones|auto|carro|vehiculo|vehiculos|coche|camioneta|camion|camiones|del|es|piloto|chofer|conductor|pasajero|manual|cabina|cab|sencilla|doble|remanufacturad[oa]s?|reconstruid[oa]s?|usad[oa]s?|nuev[oa]s?|complet[oa]s?|original(?:es)?|generico(?:s)?|generica(?:s)?|de|a|y)\b/gi;
const SPR_VEHICLE_MAKES = new Set(['nissan', 'ford', 'chevrolet', 'chevy', 'volkswagen', 'vw', 'toyota', 'honda', 'kia', 'hyundai', 'dodge', 'chrysler', 'jeep', 'mazda', 'mitsubishi', 'suzuki', 'seat', 'renault', 'peugeot', 'fiat', 'ram', 'gmc', 'volvo', 'audi', 'bmw', 'mercedes', 'mercedesbenz', 'isuzu', 'subaru', 'lincoln', 'cadillac', 'buick', 'acura', 'infiniti', 'lexus', 'porsche', 'mg', 'byd']);

function hasSprVehicleReference(value) {
  const normalized = normalizeBotText(value)
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(SPR_CATALOG_EXTRA_FILLER_PATTERN, ' ');
  const vehicleTokens = normalized.split(/\s+/).filter(token => token.length >= 2);
  if (!vehicleTokens.length || vehicleTokens.every(token => SPR_VEHICLE_MAKES.has(token))) return false;
  return true;
}

function isAmbiguousSprCatalogRequest(value) {
  const normalized = canonicalizeSprPartSynonyms(value);
  return SPR_CATALOG_CONTEXT_PATTERN.test(normalized) && !hasSprVehicleReference(normalized);
}

function buildSprCatalogContext(previousCustomerMessages, currentMessage) {
  const current = String(currentMessage || '').trim();
  const previous = (Array.isArray(previousCustomerMessages) ? previousCustomerMessages : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const currentNormalized = canonicalizeSprPartSynonyms(current);
  const previousNormalized = canonicalizeSprPartSynonyms(previous.join(' '));
  const isFollowUpRefinement = SPR_CATALOG_REFINEMENT_PATTERN.test(currentNormalized)
    && !SPR_CATALOG_CONTEXT_PATTERN.test(currentNormalized.replace(/\b(delantero|delantera|trasero|trasera|izquierdo|izquierda|derecho|derecha|lado|frente|atr[aá]s|modelo|a[nñ]o|versi[oó]n|principal|niebla|antiniebla)\b/g, ''));

  const previousCatalogMessage = [...previous].reverse().find(value => {
    const normalized = canonicalizeSprPartSynonyms(value);
    return SPR_CATALOG_CONTEXT_PATTERN.test(normalized) && hasSprVehicleReference(normalized);
  });
  const currentHasVehicle = hasSprVehicleReference(currentNormalized);
  const currentHasCatalogTerm = SPR_CATALOG_CONTEXT_PATTERN.test(currentNormalized)
    || SPR_CATALOG_REFINEMENT_PATTERN.test(currentNormalized)
    || isFollowUpRefinement;

  // Keep the last vehicle/model when the customer clarifies the same part
  // (for example: "faro de Versa 2017" -> "quiero el faro principal").
  if (previousCatalogMessage && currentHasCatalogTerm && !currentHasVehicle) {
    return previousCatalogMessage + ' ' + current;
  }

  if (previous.length && isFollowUpRefinement && SPR_CATALOG_CONTEXT_PATTERN.test(previousNormalized)) {
    return previous.slice(-4).join(' ') + ' ' + current;
  }
  return current;
}

function isGenericSprCatalogRequest(lowerText) {
  const query = canonicalizeSprPartSynonyms(lowerText);
  const asksGeneral = /\b(que productos|que tienen|que hay|catalogo|catalog|refacciones|productos|todo|completo)\b/.test(query);
  const asksSpecific = /\b(motor(?:es)?|cabeza(?:s)?|culata|amortiguador(?:es)?|suspension|freno(?:s)?|balata(?:s)?|pastilla(?:s)?|aceite(?:s)?|refaccion(?:es)?|pieza(?:s)?|direccion|radiador(?:es)?|bomba(?:s)?|turbo(?:s)?|embrague(?:s)?|clutch|maza(?:s)?|balero(?:s)?|soporte(?:s)?|terminal(?:es)?|rotula(?:s)?|faro(?:s)?|calavera(?:s)?|lampara(?:s)?|luz|luces|espejo(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|salpicadera(?:s)?|carroceria)\b/.test(query);
  return asksGeneral && !asksSpecific;
}

// Route unknown automotive purchase questions through the catalog so absent items receive a direct no-stock answer.
function isUnlistedSprProductRequest(value) {
  const query = canonicalizeSprPartSynonyms(value);
  const purchaseIntent = /\b(busco|buscando|necesito|ocupo|quiero|tienen|tendrian|tendran|hay|venden|manejan|consiguen|cotizar|cotizacion)\b/.test(query);
  const automotiveContext = /\b(carro|auto|vehiculo|coche|tienda|refaccion|refacciones|pieza|producto|articulo|accesorio|rayon|rayones|compatibilidad)\b/.test(query);
  if (!purchaseIntent || !automotiveContext || SPR_CATALOG_CONTEXT_PATTERN.test(query)) return false;
  const residual = query.replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ').replace(SPR_CATALOG_EXTRA_FILLER_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return residual.split(' ').filter(token => token.length >= 3).length >= 1;
}

function isSprStoreLocationQuestion(value) {
  const query = normalizeBotText(value);
  const asksLocation = /\b(ubicacion|ubicados|donde estan|donde se encuentran|sucursal|domicilio|local|tienda|oficina|como llego)\b/.test(query)
    || /\bdireccion\s+(?:del|de la)\s+(?:local|sucursal|negocio|tienda|oficina|empresa)\b/.test(query)
    || /\b(?:cual es|dime|me compartes|me das|comparteme|compartenos)\s+(?:la\s+|su\s+)?direccion\b/.test(query);
  if (!asksLocation) return false;
  // “Dirección de Honda Passport modelo 98” is a requested part, not the
  // address of the store. Preserve that distinction before answering FAQ.
  return !(SPR_CATALOG_CONTEXT_PATTERN.test(query) && hasSprVehicleReference(query) && !/\b(local|sucursal|negocio|tienda|oficina|empresa)\b/.test(query));
}

function buildSprFaqReply(value, isSprAutopartesTenant) {
  if (!isSprAutopartesTenant) return '';
  const query = normalizeBotText(value);
  if (isSprStoreLocationQuestion(query)) {
    return '📍 *Estamos ubicados en Querétaro, México.* 🚚 Realizamos envíos a todo México.';
  }
  if (/\b(horario|horarios|hora|horas|abren|cierran|abierto|abiertos|atienden|atencion)\b/.test(query)) {
    return 'Atendemos de *Lunes a Sábado* de *9:00 am* a *7:30 pm*. ✅\nNuestro canal de WhatsApp y redes sociales recibe consultas las *24 horas*. 🕑';
  }
  if (/\b(envio|envios|enviamos|mandan|mandamos|entrega|entregan|cobertura|nacional|foraneo|foraneos|foranea|foraneas|otro estado|todo mexico)\b/.test(query)) {
    return '🚚 Sí, realizamos envíos a todo México. Compárteme la pieza, marca, modelo y año para revisar tu cotización.';
  }
  return '';
}

function isIncompleteSprCatalogRequest(value) {
  const query = canonicalizeSprPartSynonyms(value);
  if (SPR_CATALOG_CONTEXT_PATTERN.test(query)) return false;
  return /\b(precio|precios|cuanto|cuesta|costo|cotizacion|cotizar|cotiza|disponible|disponibilidad|stock|delantero|delantera|trasero|trasera|izquierdo|izquierda|derecho|derecha|lado|principal|niebla|antiniebla)\b/.test(query);
}

function buildSprCatalogReply(matches, lowerText, catalogItems = [], stockResult = null) {
  if (isGenericSprCatalogRequest(lowerText)) {
    const categoryRules = [
      ['Motores y cabezas de motor', /\b(motor|cabeza|culata)\b/],
      ['Amortiguadores y suspensión', /\b(amortiguador|suspension)\b/],
      ['Frenos y balatas', /\b(freno(?:s)?|balata(?:s)?|pastilla(?:s)?)\b/],
      ['Aceites y fluidos', /\b(aceite(?:s)?|lubricante(?:s)?|motul|valvoline|pentosin)\b/],
      ['Dirección y tren delantero', /\b(direccion|terminal|rotula|caja de direccion)\b/],
      ['Radiadores y enfriamiento', /\b(radiador(?:es)?|enfriamiento|cooling)\b/],
      ['Bombas, turbos y embragues', /\b(bomba(?:s)?|turbo(?:s)?|embrague(?:s)?|clutch)\b/],
      ['Iluminación y carrocería', /\b(faro(?:s)?|calavera(?:s)?|lampara(?:s)?|luz|luces|espejo(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|salpicadera(?:s)?|carroceria)\b/]
    ];
    const availableCategories = categoryRules.filter(([, pattern]) => catalogItems.some(item => pattern.test([item.normalizedTitle, normalizeBotText(item.productType), normalizeBotText(item.tags)].join(' ')))).map(([label]) => label);
    const categoryLines = (availableCategories.length ? availableCategories : categoryRules.map(([label]) => label)).map(label => '🔧 ' + label).join('\n');
    return '🛠️ *Catálogo de SPR Autopartes*\n\nContamos con refacciones para diferentes marcas y modelos:\n\n' + categoryLines + '\n\nPara revisar una pieza exacta, envíame:\n🚗 Marca y modelo\n📅 Año\n🔧 Pieza o sistema que necesitas\n\nEjemplo: *amortiguador Versa delantero izquierdo 2015* o *aceite Motul 5W-30*. 📦';
  }
  if (isAmbiguousSprCatalogRequest(lowerText)) {
    return '🛠️ *Catálogo de SPR Autopartes*\n\nPara buscar la pieza correcta necesito algunos datos adicionales. 🔎\n\n¿De qué *marca, modelo y año* es tu vehículo?\n🔧 También dime qué pieza necesitas y, si aplica, el lado (izquierdo o derecho).\n\nEjemplo: *faro delantero para Nissan Versa 2015*.';
  }
  if (isIncompleteSprCatalogRequest(lowerText)) {
    return '🔎 Para preparar una cotización necesito la pieza exacta y los datos del vehículo: *marca, modelo y año*. Si aplica, indícame también el lado.';
  }
  if (!matches.length) {
    return 'No tenemos ese artículo en existencia.';
  }
  const lines = ['🛠️ *Catálogo de SPR Autopartes*', '', 'Encontré estas opciones relacionadas:'];
  for (const item of matches) {
    lines.push('', '🛒 *' + item.title + '*');
    if (item.hasSeptemberOffer) {
      lines.push('💰 Precio normal: ~' + formatSprMoney(item.regularPrice) + '~');
      lines.push('🔥 *Precio especial exclusivo de septiembre: ' + formatSprMoney(item.offerPrice) + '* (-' + SPR_SEPTEMBER_DISCOUNT_PERCENT + '%)');
    } else {
      lines.push('💰 Precio normal: *' + formatSprMoney(item.regularPrice || item.offerPrice) + '*');
    }
    const stockLine = stockResult?.status === 'in_stock'
      ? '✅ Disponible para cotización'
      : stockResult?.status === 'out_of_stock'
        ? '⚠️ Por el momento no contamos con existencias para esa pieza específica'
        : '🔎 Disponibilidad por confirmar';
    lines.push(stockLine);
    lines.push('🔗 ' + item.url);
  }
  lines.push('', '¿Quieres que revisemos compatibilidad con tu vehículo o buscar otra pieza?');
  return lines.join('\n');
}

/**
 * Check working hours against company timezone
 */
function checkWorkingHours(workingHours) {
  if (!workingHours || !workingHours.enabled) return true;
  try {
    const now = new Date();
    const tz = workingHours.timezone || 'America/Mexico_City';
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      weekday: 'numeric'
    });
    const parts = formatter.formatToParts(now);
    let dayOfWeek = now.getDay();
    let currentHour = now.getHours();
    let currentMinute = now.getMinutes();

    parts.forEach(p => {
      if (p.type === 'hour') currentHour = parseInt(p.value, 10);
      if (p.type === 'minute') currentMinute = parseInt(p.value, 10);
    });

    const allowedDays = workingHours.days || [1, 2, 3, 4, 5, 6];
    if (!allowedDays.includes(dayOfWeek)) return false;

    const [openH, openM] = (workingHours.open_time || '09:00').split(':').map(Number);
    const [closeH, closeM] = (workingHours.close_time || '19:30').split(':').map(Number);

    const currentTotal = currentHour * 60 + currentMinute;
    const openTotal = openH * 60 + openM;
    const closeTotal = closeH * 60 + closeM;

    return currentTotal >= openTotal && currentTotal <= closeTotal;
  } catch {
    return true;
  }
}

/**
 * Validate Meta Webhook Signature (X-Hub-Signature-256)
 */
function verifyMetaSignature(req) {
  if (!META_APP_SECRET) {
    req.signature_status = 'unverified_secret_missing';
    console.warn('⚠️ META_APP_SECRET not configured in env. Signature verification skipped.');
    return true;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    req.signature_status = 'missing';
    console.warn('⚠️ Missing X-Hub-Signature-256 header in incoming request.');
    return false;
  }

  const elements = signature.split('sha256=');
  const signatureHash = elements[1];
  if (!signatureHash) {
    req.signature_status = 'malformed';
    return false;
  }

  const expectedHash = crypto
    .createHmac('sha256', META_APP_SECRET)
    .update(req.rawBody || '')
    .digest('hex');

  try {
    const isValid = crypto.timingSafeEqual(Buffer.from(signatureHash, 'utf8'), Buffer.from(expectedHash, 'utf8'));
    req.signature_status = isValid ? 'verified' : 'invalid';
    return isValid;
  } catch {
    req.signature_status = 'error';
    return false;
  }
}

/**
 * Check if the inbound payload is a synthetic test from Meta Developers dashboard
 * Note: Only inspect the sender field ('PHONE_NUMBER', dummy test strings).
 * NEVER reject real messages whose body text might happen to contain 'MESSAGE_BODY'.
 */
function isSyntheticMetaPayload(from) {
  if (!from) return true;
  const cleanFrom = String(from).trim().toUpperCase();
  return cleanFrom === 'PHONE_NUMBER' || cleanFrom === 'PHONE-NUMBER' || cleanFrom === '0';
}

/**
 * Strictly resolve company tenant & access token by Phone Number ID.
 * Multi-tenant Isolation Rule:
 * 1. Strictly look up by phone_number_id. If multiple integrations share the same phone ID, reject as ambiguous.
 * 2. Lookup by WABA ID ONLY if phone_number_id was omitted. If multiple integrations match the WABA ID, reject as ambiguous.
 * 3. Reject unknown IDs without fallback to prevent cross-tenant leaks.
 */
async function resolveTenant(dbInstance, phoneNumberId, wabaId) {
  if (!dbInstance) return null;
  let intDoc = null;
  let intDocId = null;

  // 1. Strict lookup by verified phone_number_id
  if (phoneNumberId) {
    const snapByPhone = await dbInstance.collection('integrations')
      .where('phone_number_id', '==', String(phoneNumberId).trim())
      .get();
    if (!snapByPhone.empty) {
      let candidateDocs = snapByPhone.docs;
      if (candidateDocs.length > 1) {
        candidateDocs = [...candidateDocs].sort((a, b) => {
          const ad = a.data();
          const bd = b.data();
          const score = d => (d.status === 'connected' ? 4 : 0) + (d.outbound_verified === true ? 2 : 0) + (d.webhook_verified === true ? 1 : 0);
          const scoreDiff = score(bd) - score(ad);
          if (scoreDiff) return scoreDiff;
          const bDate = String(bd.updated_at || bd.last_sync_at || bd.created_at || '');
          const aDate = String(ad.updated_at || ad.last_sync_at || ad.created_at || '');
          return bDate.localeCompare(aDate);
        });
        const selected = candidateDocs[0];
        console.warn(`⚠️ [Duplicate Phone Number ID: ${phoneNumberId}] ${candidateDocs.length} integrations found; selecting ${selected.id} (${selected.data().company_id}) by active status and recency.`);
      }
      const selectedDoc = candidateDocs[0];
      intDoc = selectedDoc.data();
      intDocId = selectedDoc.id;
    }
  }

  // 2. Strict lookup by whatsapp_business_account_id ONLY if phone_number_id was not supplied
  if (!intDoc && !phoneNumberId && wabaId) {
    const snapByWaba = await dbInstance.collection('integrations')
      .where('whatsapp_business_account_id', '==', String(wabaId).trim())
      .limit(2)
      .get();
    if (!snapByWaba.empty) {
      if (snapByWaba.docs.length > 1) {
        console.warn(`⚠️ [Ambiguous WABA ID: ${wabaId}] Multiple companies share WABA ID without Phone Number ID. Rejecting.`);
        return null;
      }
      intDoc = snapByWaba.docs[0].data();
      intDocId = snapByWaba.docs[0].id;
    }
  }

  if (!intDoc || !intDoc.company_id) {
    return null;
  }

  const companyId = intDoc.company_id;
  let accessToken = process.env.META_WHATSAPP_TOKEN || null;

  if (intDocId) {
    try {
      const secDoc = await dbInstance.doc(`integrations/${intDocId}/secrets/tokens`).get();
      if (secDoc.exists && secDoc.data().access_token) {
        accessToken = secDoc.data().access_token;
      }
    } catch (secErr) {
      console.warn(`Error reading secrets for ${intDocId}:`, secErr.message);
    }
  }

  return {
    companyId,
    intDocId,
    intDoc,
    accessToken
  };
}

/**
 function extractInboundMedia(message) {
  const type = String(message?.type || '').trim().toLowerCase();
  if (!['image', 'video', 'audio', 'document', 'sticker'].includes(type)) return null;
  const payload = message?.[type] && typeof message[type] === 'object' ? message[type] : {};
  const mediaId = payload.id ? String(payload.id).trim() : '';
  if (!mediaId) return null;
  return {
    media_id: mediaId,
    media_type: type,
    media_mime_type: payload.mime_type ? String(payload.mime_type).trim() : null,
    media_caption: payload.caption ? String(payload.caption).trim() : null,
    media_filename: payload.filename ? String(payload.filename).trim() : null
  };
}

* 1. HEALTH & DIAGNOSTIC STATUS ENDPOINTS
 */
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'DT Bot Core — Native WhatsApp Cloud API Server',
    version: '1.3.0',
    timestamp: new Date().toISOString(),
    verify_token_set: !!MASTER_VERIFY_TOKEN,
    signature_verification_active: !!META_APP_SECRET,
    firestore_connected: !!db,
    graph_api_version: GRAPH_API_VERSION
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    server_time: new Date().toISOString(),
    graph_api_version: GRAPH_API_VERSION,
    signature_verification: !!META_APP_SECRET ? 'enforced' : 'optional',
    database: db ? 'firebase_admin_authenticated' : 'uninitialized',
    catalog_guard: '07330f6', catalog_search_guard: 'colloquial-synonyms-20261008', marketing_promo_guard: 'halloween-october-20261007-promo-keyword',
    unknown_product_guard: '7fb4779',
    greeting_guard: 'tenant-courtesy-20261006'
  });
});

app.get('/api/whatsapp/media/:mediaId', async (req, res) => {
  const mediaId = String(req.params.mediaId || '').trim();
  if (!mediaId || !db) return res.status(404).send('Media not found');

  try {
    const messageSnap = await db.collection('messages')
      .where('media_id', '==', mediaId)
      .limit(1)
      .get();
    if (messageSnap.empty) return res.status(404).send('Media not found');

    const messageData = messageSnap.docs[0].data() || {};
    const tenant = await resolveTenant(db, messageData.phone_number_id, messageData.waba_id);
    if (!tenant?.accessToken) return res.status(503).send('WhatsApp media is not configured');

    const metaResponse = await axios.get(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}`,
      { headers: { Authorization: `Bearer ${tenant.accessToken}` }, timeout: 10000 }
    );
    const mediaUrl = metaResponse.data?.url;
    if (!mediaUrl) return res.status(404).send('Media URL not available');

    const mediaResponse = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      responseType: 'stream',
      timeout: 20000
    });
    const contentType = messageData.media_mime_type || metaResponse.data?.mime_type || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=300');
    if (metaResponse.data?.file_size) res.set('Content-Length', String(metaResponse.data.file_size));
    mediaResponse.data.on('error', error => {
      console.warn(`WhatsApp media stream failed for ${mediaId}:`, error.message);
      if (!res.headersSent) res.status(502).end();
    });
    mediaResponse.data.pipe(res);
} catch (error) {
    const status = error.response?.status === 404 || error.response?.status === 400 ? 404 : 502;
    console.warn(`WhatsApp media lookup failed for ${mediaId}:`, error.response?.data?.error?.message || error.message);
    if (!res.headersSent) res.status(status).send(status === 404 ? 'Media not found' : 'Media temporarily unavailable');
}
});

/**
 * 2. META WEBHOOK VERIFICATION HANDSHAKE
 app.get('/api/whatsapp/media/:mediaId', async (req, res) => {
  const mediaId = String(req.params.mediaId || '').trim();
  if (!mediaId || !db) return res.status(404).send('Media not found');

  try {
    const messageSnap = await db.collection('messages')
      .where('media_id', '==', mediaId)
      .limit(1)
      .get();
    if (messageSnap.empty) return res.status(404).send('Media not found');

    const messageData = messageSnap.docs[0].data() || {};
    const tenant = await resolveTenant(db, messageData.phone_number_id, messageData.waba_id);
    if (!tenant?.accessToken) return res.status(503).send('WhatsApp media is not configured');

    const metaResponse = await axios.get(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}`,
      { headers: { Authorization: `Bearer ${tenant.accessToken}` }, timeout: 10000 }
    );
    const mediaUrl = metaResponse.data?.url;
    if (!mediaUrl) return res.status(404).send('Media URL not available');

    const mediaResponse = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${tenant.accessToken}` },
      responseType: 'stream',
      timeout: 20000
    });
    const contentType = messageData.media_mime_type || metaResponse.data?.mime_type || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'private, max-age=300');
    if (metaResponse.data?.file_size) res.set('Content-Length', String(metaResponse.data.file_size));
    mediaResponse.data.on('error', error => {
      console.warn(`WhatsApp media stream failed for ${mediaId}:`, error.message);
      if (!res.headersSent) res.status(502).end();
    });
    mediaResponse.data.pipe(res);
  } catch (error) {
    const status = error.response?.status === 404 || error.response?.status === 400 ? 404 : 502;
    console.warn(`WhatsApp media lookup failed for ${mediaId}:`, error.response?.data?.error?.message || error.message);
    if (!res.headersSent) res.status(status).send(status === 404 ? 'Media not found' : 'Media temporarily unavailable');
  }
});

* GET /webhook/whatsapp
 */
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && (token === MASTER_VERIFY_TOKEN || (token && token.startsWith('dt_')))) {
    console.log('✅ Meta Webhook verification handshake successful.');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Meta Webhook verification rejected. Invalid Verify Token:', token);
  return res.status(403).send('Forbidden: Verify token mismatch');
});

/**
 * 3. RECEIVE META WHATSAPP INCOMING EVENTS
 * POST /webhook/whatsapp
 */
app.post('/webhook/whatsapp', async (req, res) => {
  // 1. Verify HMAC-SHA256 Signature
  if (!verifyMetaSignature(req)) {
    console.error('❌ Webhook rejected: Invalid HMAC-SHA256 Signature');
    return res.status(401).send('Unauthorized: Invalid Signature');
  }

  // Acknowledge Meta immediately with HTTP 200
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (!body || body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Meta sends delivery/read/failure updates in a separate webhook event.
    // Persist them immediately so the CRM never presents an accepted request as delivered.
    const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
    if (statuses.length > 0) {
      if (!db) return;
      for (const statusEvent of statuses) {
        const externalId = String(statusEvent.id || '').trim();
        const rawStatus = String(statusEvent.status || '').trim().toLowerCase();
        if (!externalId || !rawStatus) continue;
        const deliveryStatus = ['sent', 'delivered', 'read', 'failed'].includes(rawStatus) ? rawStatus : 'accepted';
        const updatedAt = statusEvent.timestamp
          ? new Date(Number(statusEvent.timestamp) * 1000).toISOString()
          : new Date().toISOString();
        const firstError = Array.isArray(statusEvent.errors) ? statusEvent.errors[0] : null;
        const errorMessage = firstError
          ? [firstError.title, firstError.message, firstError.details].filter(Boolean).join(': ')
          : null;
        const deliveryPatch = {
          delivery_status: deliveryStatus,
          whatsapp_status: rawStatus,
          delivery_status_updated_at: updatedAt,
          ...(errorMessage ? { error_message: errorMessage, whatsapp_error_code: firstError.code || null } : {})
        };
        try {
          const messageSnap = await db.collection('messages')
            .where('external_message_id', '==', externalId)
            .limit(10)
            .get();
          if (!messageSnap.empty) {
            const batch = db.batch();
            messageSnap.docs.forEach(messageDoc => batch.set(messageDoc.ref, deliveryPatch, { merge: true }));
            await batch.commit();
          }
          // Keep a short-lived status record as a race buffer when Meta's webhook
          // arrives before the CRM finishes writing the outbound message.
          await db.doc('whatsapp_delivery_status/' + externalId).set({
            external_message_id: externalId,
            phone_number_id: value?.metadata?.phone_number_id || null,
            ...deliveryPatch,
            updated_at: new Date().toISOString()
          }, { merge: true });
          console.log('📬 [WhatsApp Delivery] ' + externalId + ': ' + deliveryStatus + (errorMessage ? ' — ' + errorMessage : ''));
        } catch (statusError) {
          console.error('Error persisting WhatsApp delivery status for ' + externalId + ':', statusError.message);
        }
      }
      return;
    }

    if (!value?.messages || value.messages.length === 0) return;

    const message = value.messages[0];
    const contact = value.contacts?.[0];
    const metadata = value.metadata;

    const messageId = message.id;
    if (!messageId) return;

    // --- ATOMIC PERSISTENT DEDUPLICATION IN FIRESTORE ---
    if (!db) {
      console.error('❌ Database not initialized. Cannot process message safely.');
      return;
    }

    const dedupDocRef = db.doc(`webhook_events/event_${messageId}`);
    let shouldProcess = false;

    try {
      await db.runTransaction(async (transaction) => {
        const docSnap = await transaction.get(dedupDocRef);
        const now = Date.now();
        if (docSnap.exists) {
          const data = docSnap.data();
          const receivedMs = data.received_at_ms || (data.received_at ? new Date(data.received_at).getTime() : 0);
          const isStale = (now - receivedMs) > 120000; // 2 min threshold for crash recovery

          if (data.status === 'completed' || (data.status === 'processing' && !isStale)) {
            shouldProcess = false;
            return;
          }
          console.log(`♻️ [Deduplication] Recovering stale processing event [${messageId}]`);
        }

        // Acquire atomic lock
        transaction.set(dedupDocRef, {
          message_id: messageId,
          status: 'processing',
          received_at: new Date().toISOString(),
          received_at_ms: now
        });
        shouldProcess = true;
      });
    } catch (txErr) {
      console.error('Deduplication transaction error:', txErr);
      return;
    }

    if (!shouldProcess) {
      console.log(`⚠️ [Deduplication] Message [${messageId}] is already processed or being processed. Skipping.`);
      return;
    }

    const phoneNumberId = metadata?.phone_number_id ? String(metadata.phone_number_id).trim() : null;
    const wabaId = entry?.id ? String(entry.id).trim() : null;
    let customerPhone = normalizeWhatsAppPhone(message.from);
    let customerName = contact?.profile?.name || `Usuario WhatsApp (+${customerPhone})`;
    // Media is optional. Never let media parsing stop a normal text message
    // from being saved or answered when Meta omits a media payload.
    let inboundMedia = null;
    try {
      inboundMedia = extractInboundMedia(message);
    } catch (mediaError) {
      console.warn('Could not parse inbound WhatsApp media:', mediaError.message);
    }
    const timestamp = message.timestamp ? new Date(parseInt(message.timestamp, 10) * 1000).toISOString() : new Date().toISOString();

    // 1. Strict Tenant Company & Credential Resolution
        
    let messageText = message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || inboundMedia?.media_caption || '';
    if (!messageText && inboundMedia) {
      const mediaLabels = { image: '📷 Imagen recibida', video: '🎥 Video recibido', audio: '🎙️ Audio recibido', document: '📄 Documento recibido', sticker: '🧩 Sticker recibido' };
      messageText = mediaLabels[inboundMedia.media_type] || '📎 Archivo recibido';
    }

    // Fallback to random companies or arbitrary WhatsApp records is strictly prohibited to prevent cross-tenant leakage.
    const tenant = await resolveTenant(db, phoneNumberId, wabaId);

    if (!tenant) {
      console.warn(`⚠️ [Unmatched Phone Number ID: ${phoneNumberId}] No registered company integration found. Discarding message to prevent cross-tenant data leakage.`);
      try {
        await db.doc(`webhook_events/event_${messageId}`).set({
          status: 'completed',
          discard_reason: 'unmatched_phone_number_id',
          phone_number_id: phoneNumberId || null,
          waba_id: wabaId || null,
          completed_at: new Date().toISOString()
        }, { merge: true });
      } catch (e) {}
      return;
    }

    const { companyId, intDocId, accessToken } = tenant;
    console.log(`🏢 [Tenant Resolved] Company: ${companyId} | WhatsApp Integration: ${intDocId} | Phone ID: ${phoneNumberId}`);

    // Load tenant bot settings before creating CRM records so the controls in
    // DT Bot > Configuración have an effect on the live webhook. In
    // particular, auto_create_leads can now be disabled per company without
    // changing the WhatsApp connection.
    let botSettings = null;
    try {
      const sSnap = await db.doc(`bot_settings/${companyId}`).get();
      if (sSnap.exists) botSettings = sSnap.data();
    } catch (settingsError) {
      console.warn('Could not load bot settings before lead registration:', settingsError.message);
    }

    // 2. Filter Synthetic / Meta Dashboard Sample Payloads
    // Do NOT create real CRM leads or attempt outbound Meta API calls for dummy dashboard test payloads
    if (isSyntheticMetaPayload(customerPhone)) {
      console.log(`🧪 [Meta Webhook Sample Payload Received] Verified webhook payload structure for Phone Number ID: ${phoneNumberId} (${companyId}).`);
      try {
        await db.doc(`webhook_events/event_${messageId}`).set({
          status: 'completed',
          is_test_event: true,
          phone_number_id: phoneNumberId || null,
          company_id: companyId,
          completed_at: new Date().toISOString()
        }, { merge: true });

        // Record ONLY sample ping timestamp, NEVER marking real connected status or last_verified_at
        if (intDocId) {
          await db.doc(`integrations/${intDocId}`).set({
            last_webhook_sample_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }, { merge: true });
        }
      } catch (e) {}
      return;
    }

    console.log(`📥 [WhatsApp Inbound] Company: ${companyId} | From: ${customerName} (+${customerPhone}) | Message: "${messageText}"`);

    // Mark inbound webhook reception verified on real customer message (separate from outbound verification)
    if (intDocId) {
      try {
        const isOutboundVerified = tenant.intDoc?.outbound_verified === true;
        const signatureAuth = req.signature_status === 'verified';

        await db.doc(`integrations/${intDocId}`).set({
          webhook_verified: true,
          webhook_signature_authenticated: signatureAuth,
          last_inbound_at: new Date().toISOString(),
          status: isOutboundVerified ? 'connected' : 'saved_unverified',
          last_verified_at: isOutboundVerified ? new Date().toISOString() : (tenant.intDoc?.last_verified_at || null),
          updated_at: new Date().toISOString()
        }, { merge: true });
      } catch (e) {}
    }

    // 3. Register / Update Lead in CRM
    const cleanPhoneDigits = customerPhone.replace(/[^0-9]/g, '');
    const leadId = `lead_wa_${cleanPhoneDigits.slice(-10) || Date.now()}`;

    const leadData = {
      id: leadId,
      company_id: companyId,
      nombre: customerName,
      telefono: customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`,
      correo: null,
      empresa: contact?.profile?.name || 'Contacto WhatsApp Directo',
      servicio: 'Atención WhatsApp Cloud API',
      fuente: 'WhatsApp',
      estado: 'Nuevo Lead',
      responsable: 'DT Bot Core',
      prioridad: 'Alta',
      valor_estimado: null,
      notas: `Conversación vía WhatsApp Cloud API.\nÚltimo mensaje: "${messageText}"`,
      fecha_creacion: timestamp,
      ultima_actividad: timestamp
    };

    if (botSettings?.auto_create_leads !== false) {
      try {
        await db.doc(`leads/${leadId}`).set(leadData, { merge: true });
      } catch (e) {
        console.warn('Error saving lead to Firestore:', e.message);
      }
    } else {
      console.log(`ℹ️ [Lead Capture Disabled] Company: ${companyId} has auto_create_leads disabled.`);
    }

    // 4. Conversation State Management
    const conversationLookup = await loadWhatsAppConversation(db, companyId, customerPhone);
    const convId = conversationLookup.id;
    let convData = conversationLookup.data;
    for (const legacyId of conversationLookup.legacyIds || []) {
      await migrateConversationMessages(db, legacyId, convId);
    }

    // Preserve recent customer turns separately from the last rendered
    // message. The latter becomes the bot's reply after this handler runs,
    // which previously made short follow-ups lose the vehicle context.
    let recentCustomerMessages = Array.isArray(convData?.recent_customer_messages)
      ? convData.recent_customer_messages.map(value => String(value || '').trim()).filter(Boolean)
      : [];
    if (!recentCustomerMessages.length && convData?.last_customer_message) {
      recentCustomerMessages = [String(convData.last_customer_message).trim()];
    }
    if (!recentCustomerMessages.length && convData?.last_message_sender === 'customer' && convData?.last_message) {
      recentCustomerMessages = [String(convData.last_message).trim()];
    }
    // Older conversations do not have the new context field. Recover the
    // latest customer turns once from their stored messages when possible.
    if (!recentCustomerMessages.length) {
      try {
        const previousMessages = await db.collection('messages')
          .where('conversation_id', '==', convId)
          .get();
        recentCustomerMessages = previousMessages.docs
          .map(doc => doc.data() || {})
          .filter(data => data.sender_type === 'customer' && data.content)
          .sort((a, b) => timestampMs(a.created_at) - timestampMs(b.created_at))
          .map(data => String(data.content).trim())
          .filter(Boolean)
          .slice(-4);
      } catch (historyError) {
        console.warn('Could not recover catalog context for conversation:', historyError.message);
      }
    }
    const catalogContextText = buildSprCatalogContext(recentCustomerMessages, messageText);

    if (!convData) {
      convData = {
        id: convId,
        company_id: companyId,
        channel: 'whatsapp',
        external_user_id: customerPhone,
        contact_name: customerName,
        contact_phone: `+${customerPhone}`,
        lead_id: leadId,
        status: 'active',
        bot_enabled: true,
        human_handoff: false,
        auto_reactivate_enabled: true,
        human_handoff_started_at: null,
        last_agent_message_at: null,
        unread_count: 1,
                welcome_sent_at: null,

         last_customer_message: messageText,
         recent_customer_messages: [messageText],

        last_message: messageText,
        last_message_sender: 'customer',
        created_at: timestamp,
        updated_at: timestamp,
        last_message_at: timestamp
      };
    } else {
      recentCustomerMessages = [...recentCustomerMessages, messageText].filter(Boolean).slice(-4);
      convData.last_customer_message = messageText;
      convData.recent_customer_messages = recentCustomerMessages;
      convData.last_message = messageText;
      convData.last_message_sender = 'customer';
      convData.last_message_at = timestamp;
      convData.updated_at = timestamp;
      convData.unread_count = (convData.unread_count || 0) + 1;
    }

    // 4. Save Inbound Message
    const inMsgId = `msg_${Date.now()}_in_${Math.random().toString(36).substring(2, 6)}`;
    const inMsgData = {
      id: inMsgId,
      company_id: companyId,
      conversation_id: convId,
      direction: 'inbound',
      channel: 'whatsapp',
      content: messageText,
      external_message_id: messageId,
      sender_type: 'customer',
      created_at: timestamp,
            delivery_status: 'delivered',
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      ...(inboundMedia || {})
    };

    try {
      await db.doc(`messages/${inMsgId}`).set(inMsgData);
    } catch (e) {
      console.warn('Error saving inbound message:', e.message);
    }

    // 5. DT Bot Core Engine Evaluation
    // Resume only when the customer writes again after the advisor idle window.
    const autoReactivated = shouldAutoReactivateBot(convData);
    if (autoReactivated) {
      convData.human_handoff = false;
      convData.bot_enabled = true;
      convData.status = 'active';
      convData.auto_reactivated_at = new Date().toISOString();
      convData.auto_reactivation_reason = 'advisor_idle_timeout';
      convData.human_handoff_started_at = null;
      convData.assigned_user_id = null;
      convData.assigned_user_name = null;
      console.log('🤖 [Auto Reactivation] Conversation [' + convId + '] resumed after ' + HUMAN_HANDOFF_IDLE_MINUTES + ' minutes without advisor activity.');
    }

    // If human handoff is still active, keep the bot silent.
    if (convData.human_handoff === true || convData.bot_enabled === false) {
      console.log(`🛑 Conversation [${convId}] is assigned to a human advisor. Bot will NOT reply.`);
      
      try {
        await db.doc(`conversations/${convId}`).set(convData, { merge: true });
        await db.doc(`webhook_events/event_${messageId}`).set({
          status: 'completed',
          completed_at: new Date().toISOString(),
          bot_replied: false,
          human_handoff: true
        }, { merge: true });
      } catch (e) {}

      return;
    }

    // Resolve the display identity from the tenant selected by the verified
    // WhatsApp integration. This prevents a client account from inheriting
    // the platform owner's DT Marketing welcome text.
    let tenantCompany = null;
    try {
      const companySnap = await db.doc("companies/" + companyId).get();
      if (companySnap.exists) tenantCompany = companySnap.data() || null;
    } catch (e) {
      console.warn('Could not load tenant company profile:', e.message);
    }
    const tenantDisplayName = String(
      tenantCompany?.nombre || botSettings?.business_name || botSettings?.business_description || 'nuestro negocio'
    ).trim();

    // Check for Human Handoff Intent
    const lowerText = normalizeBotText(messageText);
    const humanKeywords = ['asesor', 'humano', 'persona', 'agente', 'ejecutivo', 'hablar con alguien', 'representante', 'ayuda humana', 'transferir'];
    // Shopify prefills can arrive with punctuation or small wording variations.
    // Normalize them before any catalog, knowledge-base, or human-handoff rule.
    const isShopifySuspensionIntro = /^hola\s+vengo\s+de\s+spr\s+autopartes\s+y\s+necesito\s+asesoria\s+para\s+suspension(?:\s+marca\s+modelo\s+y\s+ano(?:\s+.+)?)?$/.test(lowerText);
    const isShopifySuspensionVehicleProvided = /^hola\s+vengo\s+de\s+spr\s+autopartes\s+y\s+necesito\s+asesoria\s+para\s+suspension\s+marca\s+modelo\s+y\s+ano\s+.+$/.test(lowerText);
    const isShopifyPartsIntro = /^hola\s+vengo\s+de\s+spr\s+autopartes\s+y\s+me\s+gustaria\s+consultar\s+sobre\s+(?:algunas|unas|varias)?\s*piezas?$/.test(lowerText);
    const isShopifyPrefillIntro = isShopifySuspensionIntro || isShopifyPartsIntro;
    const wantsHuman = !isShopifyPrefillIntro && humanKeywords.some(kw => lowerText.includes(kw));
    const isFriendlyGreeting = isFriendlyGreetingText(messageText);
    const isCourtesyMessage = isCourtesyText(messageText);
    const isCommonFaqQuestion = /\b(horario|horarios|hora|horas|abren|cierran|ubicacion|ubicados|donde|sucursal|domicilio|local|tienda|oficina|direccion|envio|envios|entrega|cobertura|todo mexico)\b/.test(lowerText);

    let botReply = '';

    if (isShopifyPrefillIntro) {
      console.log(`[Shopify Prefill Accepted] ${isShopifySuspensionIntro ? 'suspension' : 'parts'} | Company: ${companyId}`);
      botReply = isShopifySuspensionIntro
        ? (isShopifySuspensionVehicleProvided
          ? `👋 ¡Perfecto! Ya tengo los datos de tu vehículo: *${messageText.split(':').slice(1).join(':').trim() || 'los datos compartidos'}*.

🔧 ¿Qué pieza de suspensión necesitas consultar? Escríbeme la pieza y continuaré con la búsqueda.`
          : `👋 ¡Hola! Gracias por escribir a *SPR Autopartes*. Soy *SPR BOT* y con gusto te ayudo con tu consulta de suspensión.

🚗 Compárteme la *marca, modelo y año* de tu vehículo para revisar la pieza correcta.`)
        : `👋 ¡Hola! Gracias por escribir a *SPR Autopartes*. Soy *SPR BOT* y con gusto te ayudo.

🔧 ¿Qué pieza necesitas consultar? Compárteme la *marca, modelo y año* de tu vehículo para orientarte mejor.`;
    } else if (wantsHuman) {
      convData.human_handoff = true;
      convData.bot_enabled = false;
      convData.status = 'pending';
      convData.auto_reactivate_enabled = true;
      convData.human_handoff_started_at = convData.human_handoff_started_at || timestamp;
      botReply = `Entendido, ${customerName}. He pausado las respuestas automáticas y transferí tu conversación a un asesor comercial. En un momento te responderá directamente aquí.`;

      // Urgent Task in CRM
      const taskId = `task_${Date.now()}`;
      const taskData = {
        id: taskId,
        company_id: companyId,
        lead_id: leadId,
        lead_nombre: customerName,
        titulo: `Atender a ${customerName} en WhatsApp`,
        tipo: 'whatsapp',
        fecha_limite: new Date().toISOString(),
        prioridad: 'Urgente',
        completada: false,
        fecha_creacion: timestamp,
        nota: `El cliente solicitó asesor humano en WhatsApp. Mensaje: "${messageText}"`
      };

      try {
        await db.doc(`followups/${taskId}`).set(taskData);
      } catch (e) {}
    } else if (botSettings?.working_hours && !checkWorkingHours(botSettings.working_hours) && !isFriendlyGreeting && !isCourtesyMessage && !isShopifyPrefillIntro && !isCommonFaqQuestion) {
      // Out of hours
      botReply = botSettings.out_of_hours_message || `¡Hola! Gracias por comunicarte. En este momento nos encontramos fuera de horario de atención comercial, pero ya registramos tu consulta y un asesor te responderá a primera hora.`;
    } else {
      // Query Knowledge Base for match
      let kbItems = [];
      try {
        const kbSnap = await db.collection('knowledge_base')
          .where('company_id', '==', companyId)
          .where('enabled', '==', true)
          .get();
        kbItems = kbSnap.docs.map(d => d.data());
      } catch (e) {}

      let bestMatch = null;
      let maxScore = 0;

      for (const item of kbItems) {
        let score = 0;
        const keywords = item.keywords || [];
        for (const kw of keywords) {
          if (kw && normalizeBotText(kw).split(' ').some(token => token.length > 2 && lowerText.includes(token))) score += 3;
        }
        if (item.title && normalizeBotText(item.title).split(' ').some(token => token.length > 2 && lowerText.includes(token))) score += 2;

        if (score > maxScore) {
          maxScore = score;
          bestMatch = item;
        }
      }

            const asksPrice = ['precio', 'cuanto', 'cuesta', 'costo', 'mensual', 'vale', 'tarifa', 'pago', 'acceso'].some(term => lowerText.includes(term));
      const asksPackage = lowerText.includes('paquete') || lowerText.includes('completo') || lowerText.includes('ambos') || lowerText.includes('los dos') || lowerText.includes('crm y bot') || lowerText.includes('bot y crm');
      const asksPromotion = /\b(promocion|promo|descuento|oferta|halloween|activacion\s+gratis)\b/.test(lowerText);
      const asksCrm = lowerText.includes('crm');
      const asksBot = lowerText.includes('bot') || lowerText.includes('chatbot') || lowerText.includes('chat bot') || lowerText.includes('whatsapp') || lowerText.includes('api chat');
      const isFriendlyGreeting = isFriendlyGreetingText(messageText);
      const isCourtesyMessage = isCourtesyText(messageText);

      const crmReply = `📊 *DT CRM Core*

💰 *$599 MXN al mes*

Incluye:
👥 Hasta 3 usuarios
🎯 Registro y organización de prospectos
🤝 Administración de clientes
📈 Embudo y seguimiento de ventas
📝 Actividades y recordatorios
📊 Dashboard y métricas
🛠️ Soporte y actualizaciones

➕ Usuario adicional: *$109 MXN al mes*

¿Quieres conocer el paquete completo o prefieres hablar con un asesor?`;

      const botReplyText = `🤖 *API Chat Bot de WhatsApp*

💰 *$1,799 MXN al mes*

Incluye:
📱 Un número de WhatsApp
⚡ Respuestas automáticas 24/7
🧭 Menú de atención
🎯 Captación y calificación de prospectos
👨‍💼 Transferencia con un asesor
🔀 Flujos personalizados básicos
🛠️ Soporte y ajustes mensuales

¿Quieres conocer el paquete completo o hablar con un asesor?`;

      const isDtMarketingTenant = /dt\s*marketing/i.test(`${tenantDisplayName} ${tenantCompany?.nombre || ''} ${botSettings?.business_name || ''} ${botSettings?.business_description || ''}`);
      const dtMarketingOctoberPromoActive = isDtMarketingTenant && isOctoberDtMarketingPromotionActive();
      const packageReply = dtMarketingOctoberPromoActive
        ? `🎃 *DESCUENTO DE MIEDO* 👻

Contrata *DT CRM Core + DT Bot Core* y obtén:

👻 *Activación GRATIS* ~$1,999 MXN~
💬 Atención automatizada 24/7
📊 Prospectos y clientes organizados
📈 Seguimiento de oportunidades
🔗 Bot + CRM trabajando juntos

🔥 *$2,499 MXN al mes*
📅 Válida durante octubre.

📲 Solicita una demostración con *DT Marketing*.`
        : `🚀 *Paquete Completo DT Marketing*

💰 *$2,499 MXN mensuales + activación*

Incluye:

📊 *DT CRM Core*
• Prospectos, clientes y seguimientos
• Embudo de ventas
• Actividades, recordatorios y métricas

🤖 *API Chat Bot de WhatsApp*
• Atención automática 24/7
• Menús y flujos personalizados
• Captación de prospectos y transferencia a un asesor

🇲🇽 Tecnología desarrollada en México para organizar tu negocio, automatizar la atención y convertir más conversaciones en ventas.

ℹ️ Los cargos por mensajes de WhatsApp API de Meta y consumos adicionales se cotizan por separado.

¿Te gustaría solicitar una demostración?`;

      const botIdentityForCatalog = `${tenantDisplayName} ${botSettings?.bot_name || ''} ${botSettings?.business_description || ''}`.toLowerCase();
      const isSprAutopartesTenant = /spr\s*(bot|autopartes|engine)/i.test(botIdentityForCatalog) || /spr autopartes/i.test(botIdentityForCatalog);
      const publicBusinessName = isSprAutopartesTenant ? 'SPR Autopartes' : tenantDisplayName;
      const publicBotName = String(
        botSettings?.bot_name || (isSprAutopartesTenant ? 'SPR BOT' : 'asistente virtual')
      ).trim();
      const sprFaqReply = buildSprFaqReply(messageText, isSprAutopartesTenant);
      let catalogQueryText = catalogContextText || messageText;
      let catalogLowerText = canonicalizeSprPartSynonyms(catalogQueryText);
      let yearConfirmationReply = '';
      const pendingYear = convData?.pending_year_confirmation || null;
      const currentNormalizedText = normalizeBotText(messageText);
      const confirmsPendingYear = pendingYear && isSprYearConfirmation(messageText);
      const deniesPendingYear = pendingYear && /\b(no|incorrecto|incorrecta|ese no|esa no)\b/.test(currentNormalizedText);
      if (confirmsPendingYear) {
        const explicitYear = currentNormalizedText.match(/\b(?:19|20)\d{2}\b/);
        const confirmedYear = explicitYear ? explicitYear[0] : String(pendingYear.suggested_year || '');
        catalogQueryText = String(pendingYear.original_query || catalogQueryText).replace(String(pendingYear.invalid_year || ''), confirmedYear);
        catalogLowerText = canonicalizeSprPartSynonyms(catalogQueryText);
        convData.pending_year_confirmation = null;
      } else if (deniesPendingYear) {
        convData.pending_year_confirmation = null;
        yearConfirmationReply = '\u00bfCu\u00e1l es el a\u00f1o correcto para revisar esa pieza? \U0001F4C5';
      } else {
        const yearClarification = getSprYearClarification(catalogQueryText);
        if (yearClarification) {
          convData.pending_year_confirmation = {
            original_query: catalogQueryText,
            invalid_year: yearClarification.invalidYear,
            suggested_year: yearClarification.suggestedYear || null
          };
          yearConfirmationReply = yearClarification.suggestedYear
            ? '\u00bfTe refieres al a\u00f1o ' + yearClarification.suggestedYear + '? Conf\u00edrmame y busco ' + getSprConfirmationPart(catalogQueryText) + '. \U0001F50E'
            : 'No pude identificar el a\u00f1o. \u00bfCu\u00e1l es el a\u00f1o correcto para revisar esa pieza? \U0001F4C5';
        }
      }
      const catalogInputText = canonicalizeSprPartSynonyms(lowerText);
      const asksCatalogProduct = !isShopifyPrefillIntro && (/\b(motor(?:es)?|cabeza(?:s)?|culata|engine series|cabeza de motor|amortiguador(?:es)?|suspensi[oó]n|freno(?:s)?|balatas|pastillas|aceite|refacci[oó]n(?:es)?|pieza(?:s)?|caja de direcci[oó]n|direcci[oó]n|radiador|bomba|turbo|embrague|clutch|maza(?:s)?|balero(?:s)?|bieleta(?:s)?|junta\s+homocinetica|horquilla(?:s)?|flecha(?:s)?|gu[ií]a(?:s)?|fascia(?:s)?|soporte|terminal|r[oó]tula|tornillo(?:s)?|productos?|cat[aá]logo|precio|cotiza(?:r|ci[oó]n)?|disponible|stock|delantero|delantera|trasero|trasera|izquierdo|izquierda|derecho|derecha|faro(?:s)?|calavera(?:s)?|lampara(?:s)?|luz|luces|espejo(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|salpicadera|carroceria)\b/.test(catalogInputText) || catalogLowerText !== lowerText || isUnlistedSprProductRequest(catalogLowerText));
      let sprCatalogReply = '';
      if (isSprAutopartesTenant && asksCatalogProduct) {
        try {
          if (!yearConfirmationReply) {
            let catalogItems = await getSprEngineCatalog();
          let sprMatches = findSprEngineMatches(catalogItems, catalogLowerText);
          sprMatches = filterStrictSprVehicleMatches(sprMatches, catalogLowerText);
          if (!sprMatches.length && !isGenericSprCatalogRequest(catalogLowerText)) {
            const searchQueries = buildSprCatalogSearchQueries(catalogQueryText);
            const searchedItemsByKey = new Map();
            // Run the bounded query plan sequentially. This deliberately gives
            // Shopify time to answer each useful variant before we conclude
            // that the requested piece is missing. Results are deduplicated,
            // then filtered against the original vehicle/part request.
            for (const query of searchQueries) {
              try {
                const queryItems = await searchSprCatalog(query);
                for (const item of queryItems) {
                  const key = item.id || item.url || item.title;
                  if (key && !searchedItemsByKey.has(key)) searchedItemsByKey.set(key, item);
                }
              } catch (searchError) {
                console.warn(`SPR catalog alternative search failed for "${query}":`, searchError.message);
              }
            }
            const searchedItems = [...searchedItemsByKey.values()];
            sprMatches = findSprEngineMatches(searchedItems, catalogLowerText);
            sprMatches = filterStrictSprVehicleMatches(sprMatches, catalogLowerText);
            if (sprMatches.length) catalogItems = [...catalogItems, ...searchedItems];
          }
          const strictEngineTokens = (/\b(motor(?:es)?|cabeza(?:s)?|culata)\b/.test(catalogLowerText)
            ? catalogLowerText.split(/\s+/).filter(token => /[a-z]/.test(token) && /\d/.test(token) && token.length >= 3 && !/^(19|20)\d{2}$/.test(token) && !["motor","motores","cabeza","cabezas","culata","engine","series"].includes(token) && !isSprEngineSpecificationToken(token))
            : []);
          if (strictEngineTokens.length) {
            sprMatches = sprMatches.filter(item => {
              const haystack = normalizeBotText([item.title, item.description, item.productType, item.tags].filter(Boolean).join(" "));
              const words = haystack.split(/\s+/);
              return strictEngineTokens.every(token => sprTokenMatches(haystack, token));
            });
          }
          const aldoStockResult = isAldoStockCategoryQuery(catalogQueryText)
            ? await searchAldoStock(catalogQueryText)
            : null;
          sprCatalogReply = buildSprCatalogReply(sprMatches, catalogLowerText, catalogItems, aldoStockResult);
          }
        } catch (catalogError) {
          console.warn('⚠️ SPR live catalog lookup failed:', catalogError.message);
        }
      }

      if (isShopifyPrefillIntro) { botReply = isShopifySuspensionIntro ? `👋 ¡Hola! Gracias por escribir a *SPR Autopartes*. Soy *SPR BOT* y con gusto te ayudo con tu consulta de suspensión.

🚗 Compárteme la *marca, modelo y año* de tu vehículo para revisar la pieza correcta.` : `👋 ¡Hola! Gracias por escribir a *SPR Autopartes*. Soy *SPR BOT* y con gusto te ayudo.

🔧 ¿Qué pieza necesitas consultar? Compárteme la *marca, modelo y año* de tu vehículo para orientarte mejor.`; } else if (yearConfirmationReply) {
        sprCatalogReply = yearConfirmationReply;
      }
      if (sprCatalogReply) {
        botReply = sprCatalogReply;
      } else if (sprFaqReply) {
        botReply = sprFaqReply;
      } else if (isFriendlyGreeting) {
        const greetingPrefix = lowerText.includes('buenos dias')
          ? '\u2600\ufe0f \u00a1Muy buenos d\u00edas!'
          : lowerText.includes('buenas tardes')
            ? '\uD83C\uDF24\ufe0f \u00a1Muy buenas tardes!'
            : lowerText.includes('buenas noches')
              ? '\uD83C\uDF19 \u00a1Muy buenas noches!'
              : '\uD83D\uDC4B \u00a1Hola!';
        const helpPrompt = isSprAutopartesTenant
          ? '\u00bfQu\u00e9 pieza o refacci\u00f3n est\u00e1s buscando? \uD83D\uDE97\uD83D\uDD27'
          : '\u00bfEn qu\u00e9 podemos ayudarte hoy?';
        const configuredWelcome = String(botSettings?.welcome_message || '').trim();
        botReply = configuredWelcome && configuredWelcome.length >= 8
          ? configuredWelcome
          : greetingPrefix + "\n\nGracias por escribir a *" + publicBusinessName + "*. Soy *" + publicBotName + "* y con gusto te ayudo.\n\n" + helpPrompt;
      } else if (isCourtesyMessage) {
        const courtesyFollowup = isSprAutopartesTenant
          ? 'Cuando necesites otra pieza, aqu\u00ed estaremos para ayudarte. \uD83D\uDE97\uD83D\uDD27'
          : 'Cuando necesites algo m\u00e1s, aqu\u00ed estaremos para ayudarte.';
        botReply = '\uD83D\uDE0A \u00a1Con gusto! Gracias a ti por escribir a *' + publicBusinessName + '*.\n\n' + courtesyFollowup;
      } else if (asksPackage || (asksPromotion && !isSprAutopartesTenant)) {
        botReply = packageReply;
      } else if (asksBot && (asksPrice || lowerText.includes('y el') || lowerText.includes('incluye') || lowerText.includes('funciona') || lowerText.includes('informacion') || lowerText.includes('información') || lowerText.includes('servicio'))) {
        botReply = botReplyText;
      } else if (asksCrm && (asksPrice || lowerText.includes('incluye') || lowerText.includes('funciona') || lowerText.includes('informacion') || lowerText.includes('información') || lowerText.includes('servicio'))) {
        botReply = crmReply;
      } else if (bestMatch && maxScore >= 2) {        
        botReply = `${bestMatch.content} ¿Te gustaría que un asesor te prepare una cotización personalizada?`;
      } else if (['si', 'sii', 'siii', 'siiii', 'yes', 'claro', 'por favor', 'adelante', 'me interesa', 'me interesa la demo', 'si me interesa', 'si quiero', 'quiero una demo', 'quiero una demostracion', 'me gustaria una demo', 'me gustaria una demostracion'].includes(lowerText)) {
  botReply = `¡Excelente! 🙌 Con gusto te mostramos una demo de ${tenantDisplayName}.

Un asesor te contactará por este medio para conocer tu negocio y enseñarte el DT CRM Core + API Chat Bot de WhatsApp.

Si quieres atención inmediata, escribe *asesor*`;
} else if (['no', 'nop', 'ahorita no', 'por ahora no'].includes(lowerText)) {
  botReply = `Entendido 👍 Si después quieres conocer nuestros servicios, escribe *CRM*, *WhatsApp* o *paquete*`;
} else if (['ya', 'ok', 'okay', 'listo', 'recibido'].includes(lowerText)) {
  botReply = `Perfecto, ${customerName}. ¿Qué producto o servicio te interesa? También puedes escribir *asesor* para hablar con nuestro equipo.`;
      } else {
        // Safe, non-hallucinating response with clarification
                const configuredFallback = String(botSettings?.fallback_message || '').trim();
        botReply = configuredFallback && !/no tengo suficiente información|no tengo suficiente informacion/i.test(configuredFallback) ? configuredFallback : `🤔 *Quiero ayudarte mejor.*

¿Buscas información sobre:

📊 *DT CRM Core*
🤖 *API Chat Bot de WhatsApp*
🚀 *Paquete completo*

Escribe el nombre del servicio o pon *asesor* y te comunicamos con nuestro equipo.`;
      }
    }

    botReply = formatWhatsAppReply(botReply);

    // 6. Send Outbound WhatsApp Reply via Meta Graph API
    const botIdentity = `${companyId} ${tenantDisplayName} ${botSettings?.bot_name || ''} ${botSettings?.business_description || ''}`.toLowerCase(); const isDtMarketingTenant = companyId === 'comp_dt_marketing' || /\bdt\s*(marketing|crm)\b/.test(botIdentity); const tenantBotName = String(botSettings?.bot_name || tenantDisplayName || 'nuestro asistente').trim(); const crossTenantContent = /(dt marketing|dt crm core|api chat bot|paquete completo|escribe \*crm\*, \*whatsapp\* o \*paquete\*)/i; const asksLocation = /\b(ubicacion|ubicados|donde estan|donde se encuentran|sucursal|domicilio|horarios?)\b/.test(lowerText) || (/\bdireccion\b/.test(lowerText) && (/\b(?:cual es|dime|me compartes|me das|compartenos|comparteme)\s+(?:la\s+|su\s+)?direccion\b/.test(lowerText) || /\bsu\s+direccion\b/.test(lowerText) || /\bdireccion\s+(?:del|de la)\s+(?:local|sucursal|negocio|tienda|oficina|empresa)\b/.test(lowerText) || /\bdireccion\s+(?:de|del)\s+(?:spr|ustedes|la empresa|el negocio|la tienda)\b/.test(lowerText))); if (!isDtMarketingTenant && (asksLocation || crossTenantContent.test(botReply))) { console.error(`[Cross-Tenant Content Blocked] Company: ${companyId} | Phone ID: ${phoneNumberId}`); botReply = asksLocation ? `📍 *Estamos ubicados en Querétaro, México.* 🚚 Realizamos envíos a todo México. Si ya deseas comprar, compártenos la pieza que buscas y los datos de tu vehículo para preparar tu cotización.` : `🤔 *Quiero ayudarte mejor.* Para orientarte sobre *${tenantBotName}*, ¿buscas una cotización, una pieza o servicio, información de envío, garantía o hablar con un asesor?`; } let outboundSuccess = false;
    // Only SPR owns the configured Querétaro location. Never leak it to a
    // different client when a generic fallback was generated.
    if (!isDtMarketingTenant && asksLocation && !isSprAutopartesTenant) {
      botReply = `📍 Para compartirte la ubicación de *${tenantBotName}*, un asesor de la empresa te atenderá directamente.`;
    }
    let metaMessageId = null;

    if (botReply && accessToken && phoneNumberId) {
      try {
        const metaRes = await axios.post(
          `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: customerPhone,
            type: 'text',
            text: { preview_url: false, body: botReply }
          },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        metaMessageId = metaRes.data?.messages?.[0]?.id || null;
        if (!metaMessageId) {
          throw new Error('Meta respondió sin un ID de mensaje. El CRM no marcará el envío como aceptado.');
        }
        outboundSuccess = true;
        console.log(`🤖 [DT Bot Accepted] To: +${customerPhone} | Meta Msg ID: ${metaMessageId}`);
      } catch (metaErr) {
        console.error('❌ Meta Graph API Error sending reply:', metaErr.response?.data?.error?.message || metaErr.message);
      }
    }

    // Record Outbound Message in Firestore
    let dbSaveError = null;
    if (outboundSuccess) {
      try {
        const outMsgId = `msg_${Date.now()}_out_${Math.random().toString(36).substring(2, 6)}`;
        const outMsgData = {
          id: outMsgId,
          company_id: companyId,
          conversation_id: convId,
          direction: 'outbound',
          channel: 'whatsapp',
          content: botReply,
          sender_type: 'bot',
          created_at: new Date().toISOString(),
          delivery_status: 'accepted',
          external_message_id: metaMessageId
        };

        await db.doc(`messages/${outMsgId}`).set(outMsgData);
        convData.last_message = botReply;
        convData.last_message_sender = 'bot';
        convData.last_message_at = new Date().toISOString();

        if (intDocId) {
          const isInboundVerified = tenant.intDoc?.webhook_verified === true;
          await db.doc(`integrations/${intDocId}`).set({
            outbound_verified: true,
            last_outbound_at: new Date().toISOString(),
            status: isInboundVerified ? 'connected' : 'saved_unverified',
            last_verified_at: isInboundVerified ? new Date().toISOString() : (tenant.intDoc?.last_verified_at || null),
            updated_at: new Date().toISOString()
          }, { merge: true });
        }
      } catch (err) {
        console.error('⚠️ Warning: Meta accepted outbound message, but saving to Firestore failed:', err.message);
        dbSaveError = err.message;
      }
    }

    // Save updated conversation
    try {
      await db.doc(`conversations/${convId}`).set(convData, { merge: true });
    } catch (err) {
      console.warn('Error updating conversation:', err.message);
    }

    // Always mark dedup lock as completed so Meta webhook retries will not duplicate customer messages
    try {
      await db.doc(`webhook_events/event_${messageId}`).set({
        status: 'completed',
        completed_at: new Date().toISOString(),
        bot_replied: outboundSuccess,
        outbound_message_id: metaMessageId,
        human_handoff: convData.human_handoff,
        db_save_partial_error: dbSaveError || null
      }, { merge: true });
    } catch (e) {}

  } catch (err) {
    console.error('Error processing WhatsApp Webhook:', err);
  }
});

// Dependency injection holders for testability
let customAdminAuth = null;
let customHttpClient = null;

function setDb(mockDb) {
  db = mockDb;
}

function setAdminAuth(mockAuth) {
  customAdminAuth = mockAuth;
}

function setHttpClient(mockClient) {
  customHttpClient = mockClient;
}

/**
 * Middleware: Verify Firebase Auth ID Token & User Tenant Membership
 * Expects header: "Authorization: Bearer <firebase_id_token>"
 */
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'No autenticado: Se requiere token de autorización Firebase (Bearer token).'
    });
  }

  const idToken = authHeader.split('Bearer ')[1]?.trim();
  if (!idToken) {
    return res.status(401).json({
      success: false,
      error: 'Token de autorización inválido o vacío.'
    });
  }

  try {
    let decodedToken;
    const authService = customAdminAuth || (admin.apps.length ? admin.auth() : null);

    if (authService) {
      decodedToken = await authService.verifyIdToken(idToken);
    } else {
      return res.status(503).json({
        success: false,
        error: 'Servicio de autenticación no inicializado en el servidor.'
      });
    }

    const uid = decodedToken.uid;
    let userProfile = null;

    if (db) {
      const userSnap = await db.doc(`users/${uid}`).get();
      if (userSnap.exists) {
        userProfile = userSnap.data();
      }
    }

    if (!userProfile) {
      return res.status(403).json({
        success: false,
        error: 'Perfil de usuario no encontrado en la base de datos.'
      });
    }

    if (userProfile.estado === 'inactivo') {
      return res.status(403).json({
        success: false,
        error: 'Cuenta de usuario inactiva.'
      });
    }

    req.authenticatedUser = {
      uid,
      email: decodedToken.email || userProfile.correo,
      nombre: userProfile.nombre || decodedToken.name || 'Usuario',
      rol: userProfile.rol || 'USER',
      company_id: userProfile.company_id || null
    };

    next();
  } catch (authErr) {
    console.error('Firebase Auth verification error:', authErr.message);
    return res.status(401).json({
      success: false,
      error: 'Token de autenticación expirado o inválido.'
    });
  }
}

/**
 * 4. AGENT DISPATCH ENDPOINT (Advisors replying from CRM)
 * Protected with Firebase Auth, Idempotency Control, Strict Conversation & Multi-Tenant Authorization
 */
app.post('/api/send-message', authenticateUser, async (req, res) => {
  const { to_phone, message_text, company_id, conversation_id, user_name, client_message_id } = req.body;
  const user = req.authenticatedUser;

  // 1. Role verification: Only advisors, admins and superadmins can send commercial messages
  const allowedRoles = ['SUPERADMIN', 'ADMINISTRADOR', 'ASESOR'];
  if (!allowedRoles.includes(user.rol)) {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: Tu rol de usuario no tiene permisos para despachar mensajes en nombre de la empresa.'
    });
  }

  // 2. Input validation
  if (!to_phone || !message_text) {
    return res.status(400).json({ success: false, error: 'Faltan parámetros to_phone o message_text' });
  }

  if (!company_id) {
    return res.status(400).json({ success: false, error: 'Falta parámetro company_id' });
  }

  // 3. Multi-Tenant Isolation Check
  if (user.rol !== 'SUPERADMIN' && user.company_id !== company_id) {
    console.warn(`🛑 [Unauthorized Tenant Access] User ${user.uid} (${user.company_id}) attempted to send message on behalf of company ${company_id}`);
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: No tienes autorización para enviar mensajes en nombre de esta empresa.'
    });
  }

  const cleanPhone = to_phone.replace(/[^0-9]/g, '');

  // 4. Strict Conversation Verification (must exist, match company, and match recipient)
  if (conversation_id) {
    if (!db) {
      return res.status(503).json({
        success: false,
        error: 'Base de datos no disponible para verificar la conversación.'
      });
    }

    let convSnap;
    try {
      convSnap = await db.doc(`conversations/${conversation_id}`).get();
    } catch (convErr) {
      console.error('Error fetching conversation from Firestore:', convErr.message);
      return res.status(500).json({
        success: false,
        error: 'Error al consultar la conversación en la base de datos.'
      });
    }

    if (!convSnap || !convSnap.exists) {
      return res.status(404).json({
        success: false,
        error: `La conversación especificada [${conversation_id}] no existe.`
      });
    }

    const convData = convSnap.data();
    if (!convData || !convData.company_id || convData.company_id !== company_id) {
      return res.status(403).json({
        success: false,
        error: 'Acceso denegado: La conversación indicada pertenece a otra empresa o no tiene empresa asignada.'
      });
    }

    // Validate recipient matching between request and conversation
    const convTarget = (convData.external_user_id || convData.contact_phone || '').replace(/[^0-9]/g, '');
    if (convTarget && !cleanPhone.endsWith(convTarget.slice(-10))) {
      return res.status(400).json({
        success: false,
        error: 'El teléfono destino no coincide con el destinatario registrado en la conversación.'
      });
    }
  }

  // 5. Outbound Idempotency & Concurrency Lock (MANDATORY & FAIL-CLOSED)
  const cleanClientId = client_message_id ? String(client_message_id).trim().replace(/[^a-zA-Z0-9_-]/g, '') : '';
  if (!cleanClientId || cleanClientId.length < 3) {
    return res.status(400).json({
      success: false,
      error: 'Se requiere un client_message_id válido (mínimo 3 caracteres alfanuméricos) para garantizar la idempotencia del envío.'
    });
  }

  if (!db) {
    return res.status(503).json({
      success: false,
      error: 'Base de datos no disponible para verificar el bloqueo de idempotencia.'
    });
  }

  const dedupDocRef = db.doc(`outbound_requests/${company_id}_${cleanClientId}`);
  let existingRecord = null;

  try {
    await db.runTransaction(async (transaction) => {
      const docSnap = await transaction.get(dedupDocRef);
      const now = Date.now();
      if (docSnap.exists) {
        const data = docSnap.data();
        const startedMs = data.started_at_ms || 0;
        const isStale = (now - startedMs) > 60000; // 1 min threshold for crash recovery

        if (data.status === 'completed' && data.meta_message_id) {
          existingRecord = data;
          return;
        }
        if (data.status === 'in_flight' && !isStale) {
          existingRecord = { in_flight: true };
          return;
        }
      }

      transaction.set(dedupDocRef, {
        company_id: company_id,
        client_message_id: cleanClientId,
        status: 'in_flight',
        started_at: new Date().toISOString(),
        started_at_ms: now
      });
    });
  } catch (txErr) {
    console.error('🛑 [Idempotency Lock Failure] Aborting send to Meta:', txErr.message);
    return res.status(500).json({
      success: false,
      error: `Fallo al verificar el bloqueo de idempotencia en la base de datos: ${txErr.message}. Envío cancelado para evitar duplicación.`
    });
  }

  if (existingRecord) {
    if (existingRecord.in_flight) {
      return res.status(409).json({
        success: false,
        error: 'La solicitud de envío ya está siendo procesada en este momento. Evitando duplicación.'
      });
    }
    if (existingRecord.meta_message_id) {
      console.log(`♻️ [Idempotency] Outbound request [${cleanClientId}] already completed. Returning cached Meta message ID ${existingRecord.meta_message_id}`);
      return res.status(200).json({
        success: true,
        message_id: existingRecord.meta_message_id,
        is_duplicate: true
      });
    }
  }

  // 6. Retrieve credentials strictly associated with target company
  let activePhoneNumberId = null;
  let activeToken = null;

  if (db) {
    try {
      const intSnap = await db.collection('integrations')
        .where('company_id', '==', company_id)
        .where('provider', '==', 'whatsapp')
        .limit(1)
        .get();

      if (!intSnap.empty) {
        const intData = intSnap.docs[0].data();
        activePhoneNumberId = intData.phone_number_id;
        const secDoc = await db.doc(`integrations/${intSnap.docs[0].id}/secrets/tokens`).get();
        if (secDoc.exists && secDoc.data().access_token) {
          activeToken = secDoc.data().access_token;
        }
      }
    } catch (e) {
      console.error('Error fetching tenant credentials:', e.message);
      return res.status(500).json({
        success: false,
        error: 'Error al consultar credenciales de integración en la base de datos.'
      });
    }
  }

  if (!activePhoneNumberId || !activeToken) {
    return res.status(400).json({
      success: false,
      error: 'Credenciales de WhatsApp Cloud API no configuradas para esta empresa.'
    });
  }

  // 7. Send message to Meta Graph API
  const http = customHttpClient || axios;
  try {
    const metaRes = await http.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${activePhoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: { preview_url: false, body: message_text }
      },
      {
        headers: {
          Authorization: `Bearer ${activeToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const metaMsgId = metaRes.data?.messages?.[0]?.id || null;
    if (!metaMsgId) {
      throw new Error('Meta respondió sin un ID de mensaje. El CRM no marcará el envío como aceptado.');
    }
    console.log(`📤 [Advisor Message Accepted] By: ${user_name || user.nombre} to +${cleanPhone} | Meta Msg ID: ${metaMsgId}`);

    // Update idempotency lock with success
    let postMetaLockError = null;
    if (dedupDocRef) {
      try {
        await dedupDocRef.set({
          status: 'completed',
          meta_message_id: metaMsgId,
          completed_at: new Date().toISOString(),
          delivered_to_meta: true
        }, { merge: true });
      } catch (lockErr) {
        console.error('⚠️ [Uncertain Lock] Meta accepted message, but writing completed lock failed:', lockErr.message);
        postMetaLockError = lockErr.message;
        try {
          await dedupDocRef.set({
            status: 'uncertain_lock',
            meta_message_id: metaMsgId,
            note: 'Delivered to Meta but completed lock write failed',
            updated_at: new Date().toISOString()
          }, { merge: true });
        } catch (emergencyErr) {}
      }
    }

    // 8. Record outbound agent message & automatically pause bot in Firestore
    let firestorePersistError = null;
    if (conversation_id && db) {
      const agentTimestamp = new Date().toISOString();
      const msgId = cleanClientId.startsWith('msg_') ? cleanClientId : `msg_${cleanClientId}`;
      const msgData = {
        id: msgId,
        company_id: company_id,
        conversation_id: conversation_id,
        direction: 'outbound',
        channel: 'whatsapp',
        content: message_text,
        sender_type: 'agent',
        user_name: user_name || user.nombre,
        created_at: agentTimestamp,
        delivery_status: 'accepted',
        external_message_id: metaMsgId
      };

      try {
        await db.doc(`messages/${msgId}`).set(msgData);
        await db.doc(`conversations/${conversation_id}`).set({
          last_message: message_text,
          last_message_sender: 'agent',
          last_message_at: agentTimestamp,
          updated_at: agentTimestamp,
          human_handoff: true,
          bot_enabled: false,
          auto_reactivate_enabled: true,
          human_handoff_started_at: agentTimestamp,
          last_agent_message_at: agentTimestamp
        }, { merge: true });
      } catch (e) {
        console.error('⚠️ Warning: Message sent to Meta, but Firestore recording failed:', e.message);
        firestorePersistError = e.message;
      }
    }

    let warningMessage = undefined;
    if (postMetaLockError || firestorePersistError) {
      warningMessage = `Mensaje aceptado por WhatsApp (ID: ${metaMsgId}), pero ocurrió un error al registrar en CRM local o confirmar el lock.`;
    }

    return res.status(200).json({
      success: true,
      message_id: metaMsgId,
      meta_accepted: true,
      delivery_status: 'accepted',
      note: 'WhatsApp aceptó el mensaje; la entrega se confirmará mediante el webhook.',
      warning: warningMessage
    });

  } catch (err) {
    console.error('Error in agent send message:', err.response?.data?.error?.message || err.message);
    const metaErrorObj = err.response?.data?.error;

    if (dedupDocRef) {
      try {
        await dedupDocRef.set({
          status: 'failed',
          error: metaErrorObj?.message || err.message,
          failed_at: new Date().toISOString()
        }, { merge: true });
      } catch (e) {}
    }

    return res.status(500).json({
      success: false,
      error: metaErrorObj?.message || err.message
    });
  }
});

/**
 * 5. DIAGNOSTIC TEST ENDPOINT
 * Protected with Firebase Auth & Role Verification (ADMINISTRADOR or SUPERADMIN only)
 * Supports testing with both explicitly passed credentials and saved company credentials.
 */
app.post('/api/test-message', authenticateUser, async (req, res) => {
  const { phone_number_id, access_token, to_phone, message_text, company_id } = req.body;
  const user = req.authenticatedUser;

  // 1. Role verification: Only Admins or SuperAdmin can run API diagnostics
  if (user.rol !== 'SUPERADMIN' && user.rol !== 'ADMINISTRADOR') {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: Solo administradores pueden ejecutar pruebas de diagnóstico de API.'
    });
  }

  // 2. Multi-Tenant isolation
  if (company_id && user.rol !== 'SUPERADMIN' && user.company_id !== company_id) {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: No tienes autorización para diagnosticar credenciales de otra empresa.'
    });
  }

  if (!to_phone) {
    return res.status(400).json({
      success: false,
      error: 'Debes proporcionar un teléfono destino para el mensaje de prueba.'
    });
  }

  let activePhoneNumberId = phone_number_id; let activeWabaId = null;
  let activeToken = access_token;

  // 3. Fallback to saved credentials if token was not provided in request (reopened forms)
  if (company_id && db) {
    try {
      const intSnap = await db.collection('integrations')
        .where('company_id', '==', company_id)
        .where('provider', '==', 'whatsapp')
        .limit(1)
        .get();

      if (!intSnap.empty) {
        const intData = intSnap.docs[0].data();
        activePhoneNumberId = activePhoneNumberId || intData.phone_number_id; activeWabaId = activeWabaId || intData.whatsapp_business_account_id;
        const secDoc = await db.doc(`integrations/${intSnap.docs[0].id}/secrets/tokens`).get();
        if (secDoc.exists && secDoc.data().access_token) {
          activeToken = secDoc.data().access_token;
        }
      }
    } catch (e) {
      console.error('Error fetching saved credentials for test-message:', e.message);
      return res.status(500).json({
        success: false,
        error: 'Error al consultar credenciales guardadas en la base de datos.'
      });
    }
  }

  if (!activePhoneNumberId || !activeToken) {
    return res.status(400).json({
      success: false,
      error: 'Debes proporcionar Phone Number ID y Access Token, o especificar una empresa con credenciales guardadas.'
    });
  }

  const cleanPhone = to_phone.replace(/[^0-9]/g, '');
  const http = customHttpClient || axios;

  try {
    const metaRes = await http.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${activePhoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'template',
        template: {
          name: 'hello_world',
          language: { code: 'en_US' }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${activeToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const metaMsgId = metaRes.data?.messages?.[0]?.id || null;
    if (!metaMsgId) throw new Error('Meta respondió sin un ID de mensaje. La prueba no se marcará como exitosa.');
    if (company_id && activeWabaId && activeToken) { try { await http.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${activeWabaId}/subscribed_apps`, {}, { headers: { Authorization: `Bearer ${activeToken}` } }); console.log(`✅ WhatsApp WABA subscription ensured: ${activeWabaId}`); } catch (subErr) { console.warn('⚠️ WABA subscription could not be ensured:', subErr.response?.data?.error?.message || subErr.message); } }

    return res.status(200).json({
      success: true,
      message_id: metaMsgId,
      meta_accepted: true,
      note: 'Meta aceptó la plantilla oficial hello_world para abrir la conversación. Responde al mensaje recibido y luego podrás probar textos libres durante 24 horas.'
    });
  } catch (err) {
    const metaErr = err.response?.data?.error;
    let friendlyMessage = metaErr?.message || err.message;

    if (metaErr?.code === 131047) {
      try {
        const templateRes = await http.post(
          `https://graph.facebook.com/${GRAPH_API_VERSION}/${activePhoneNumberId}/messages`,
          {
            messaging_product: 'whatsapp',
            to: cleanPhone,
            type: 'template',
            template: {
              name: 'hello_world',
              language: { code: 'en_US' }
            }
          },
          {
            headers: {
              Authorization: `Bearer ${activeToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        const templateMsgId = templateRes.data?.messages?.[0]?.id || null;
        if (!templateMsgId) throw new Error('Meta respondió sin un ID de mensaje para la plantilla.');
        return res.status(200).json({
          success: true,
          message_id: templateMsgId,
          meta_accepted: true,
          template_fallback: true,
          note: 'Meta requirió una plantilla porque no había una conversación activa. Se envió la plantilla oficial hello_world; responde a ese mensaje para abrir la ventana de 24 horas y poder probar texto libre.'
        });
      } catch (templateErr) {
        const templateMetaErr = templateErr.response?.data?.error;
        friendlyMessage = templateMetaErr?.message || templateErr.message;
      }
    }

    if (metaErr?.code === 190) {
      friendlyMessage = 'El Access Token de Meta ha expirado o no es válido. Genera un Token de Sistema Permanente en Meta Business Manager.';
    } else if (metaErr?.code === 100) {
      friendlyMessage = 'El Phone Number ID o formato del número destino es incorrecto.';
    } else if (metaErr?.code === 131030) {
      friendlyMessage = 'El número de destino no está registrado en WhatsApp o la cuenta de prueba de Meta aún no lo tiene agregado como número de prueba autorizado.';
    }

    return res.status(err.response?.status || 500).json({
      success: false,
      error: friendlyMessage
    });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 DT Bot Core WhatsApp Cloud API Server v1.3.0 listening on port ${PORT}`);
    console.log(`Webhook URL: http://localhost:${PORT}/webhook/whatsapp`);
  });
}

module.exports = {
  app,
  authenticateUser,
  checkWorkingHours,
  verifyMetaSignature,
  isSyntheticMetaPayload,
  resolveTenant,
  normalizeBotText,
  isFriendlyGreetingText,
  isCourtesyText,
  canonicalizeSprPartSynonyms,
  buildSprFocusedSearchQuery,
  buildSprCatalogSearchQueries,
  findSprEngineMatches,
  filterStrictSprVehicleMatches,
  isAmbiguousSprCatalogRequest,
  buildSprCatalogContext,
  isUnlistedSprProductRequest,
  getSprYearClarification,
  isSprYearConfirmation,
  isSprStoreLocationQuestion,
  buildSprFaqReply,
  isIncompleteSprCatalogRequest,
  buildSprCatalogReply,
  normalizeSprProduct,
  setDb,
  setAdminAuth,
  setHttpClient,
  GRAPH_API_VERSION,
  MASTER_VERIFY_TOKEN
};


// Embedded Signup endpoints (append to the Render backend)
const META_ESU_APP_ID = process.env.META_APP_ID || '1617679830370323';
const META_ESU_CONFIG_ID = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || '';
const META_ESU_VERSION = process.env.META_EMBEDDED_SIGNUP_VERSION || '3';

app.get('/api/meta/embedded-signup/config', authenticateUser, (req, res) => {
  res.json({
    enabled: Boolean(META_ESU_APP_ID && META_ESU_CONFIG_ID),
    app_id: META_ESU_APP_ID,
    config_id: META_ESU_CONFIG_ID || null,
    version: META_ESU_VERSION,
    graph_api_version: GRAPH_API_VERSION
  });
});

app.post('/api/meta/embedded-signup/complete', authenticateUser, async (req, res) => {
  const body = req.body || {};
  const user = req.authenticatedUser || {};
  const companyId = String(body.company_id || user.company_id || '').trim();
  if (!companyId) return res.status(400).json({ success: false, error: 'No se pudo identificar la empresa activa del CRM.' });
  if (user.rol !== 'SUPERADMIN' && user.company_id !== companyId) {
    return res.status(403).json({ success: false, error: 'No tienes autorización para conectar WhatsApp en esta empresa.' });
  }
  const appSecret = process.env.META_APP_SECRET || '';
  if (!body.code || !appSecret) {
    return res.status(400).json({ success: false, error: appSecret ? 'Meta no devolvió el código temporal de autorización.' : 'Falta configurar META_APP_SECRET en Render.' });
  }
  if (!db) return res.status(503).json({ success: false, error: 'La base de datos no está disponible para guardar la conexión.' });
  const http = customHttpClient || axios;
  try {
    const exchanged = await http.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`, {
            params: { client_id: META_ESU_APP_ID, client_secret: appSecret, code: String(body.code) }
    });
    const accessToken = exchanged.data?.access_token;
    if (!accessToken) throw new Error('Meta no devolvió un token de acceso.');

    let wabaId = String(body.waba_id || '').trim();
    let phoneId = String(body.phone_number_id || '').trim();
    let displayPhone = String(body.display_phone_number || '').trim();
    let verifiedName = String(body.verified_name || '').trim();
    let businessName = '';
    if (!wabaId || !phoneId) {
      return res.status(422).json({ success: false, error: 'Meta no devolvió la cuenta de WhatsApp y el número seleccionados. No se modificó la conexión existente.' });
    }
    if (wabaId) {
      try {
        const waba = await http.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}`, { params: { fields: 'id,name', access_token: accessToken } });
        businessName = waba.data?.name || '';
      } catch (_) {}
    }
    if (phoneId) {
      try {
        const phone = await http.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneId}`, { params: { fields: 'id,display_phone_number,verified_name,whatsapp_business_account_id', access_token: accessToken } });
        displayPhone = displayPhone || phone.data?.display_phone_number || '';
        verifiedName = verifiedName || phone.data?.verified_name || '';
        wabaId = phone.data?.whatsapp_business_account_id || wabaId;
      } catch (_) {}
    }
    if (!wabaId || !phoneId) return res.status(422).json({ success: false, error: 'Meta no devolvió el WABA y el número necesarios para completar la conexión.' });
    try { await http.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/subscribed_apps`, {}, { params: { access_token: accessToken } }); } catch (subscriptionError) { const message = subscriptionError.response?.data?.error?.message || subscriptionError.message; return res.status(502).json({ success: false, error: `Meta no autorizó la suscripción del webhook: ${message}` }); }

    const now = new Date().toISOString();
    const integrationId = `int_wa_${companyId}`;
    const integration = {
      id: integrationId, company_id: companyId, provider: 'whatsapp', status: 'connected',
      onboarding_method: 'embedded_signup', display_phone_number: displayPhone, phone_number_id: phoneId,
      whatsapp_business_account_id: wabaId, verified_name: verifiedName || businessName || 'WhatsApp Business',
      has_token: true, webhook_verified: true, outbound_verified: false,
      meta_business_id: String(body.meta_business_id || '').trim(), last_verified_at: now, last_sync_at: now,
      updated_at: now, created_at: now, created_by_user_id: user.uid, created_by_user_name: user.nombre || 'Administrador'
    };
    const batch = db.batch();
    batch.set(db.doc(`integrations/${integrationId}`), integration, { merge: true });
    batch.set(db.doc(`integrations/${integrationId}/secrets/tokens`), { access_token: accessToken, has_token: true, source: 'embedded_signup', updated_at: now, company_id: companyId }, { merge: true });
    await batch.commit(); try { const companyRef = db.doc(`companies/${companyId}`); const companySnap = await companyRef.get(); if (companySnap.exists) { const companyData = companySnap.data() || {}; const existingIntegrations = companyData.integraciones || {}; const activeIntegrations = Array.isArray(existingIntegrations.activeIntegrations) ? existingIntegrations.activeIntegrations.filter(item => item.id !== integrationId && item.provider !== "whatsapp") : []; activeIntegrations.push(integration); await companyRef.set({ integraciones: { ...existingIntegrations, activeIntegrations, whatsapp: { ...(existingIntegrations.whatsapp || {}), enabled: true, businessNumber: displayPhone, phoneNumberId: phoneId, wabaId, has_token: true } } }, { merge: true }); } } catch (companySyncError) { console.warn("Embedded Signup company cache sync pending:", companySyncError.message); }
    res.json({ success: true, company_id: companyId, waba_id: wabaId, phone_number_id: phoneId, display_phone_number: displayPhone, verified_name: verifiedName || businessName, status: 'connected' });
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('Embedded Signup completion error:', metaError?.message || err.message);
    res.status(502).json({ success: false, error: metaError?.message || 'Meta no pudo completar la conexión de WhatsApp.' });
  }
});
// Keep inbound WhatsApp media metadata available to the webhook and CRM.
function extractInboundMedia(message) {
  const type = String(message?.type || '').trim().toLowerCase();
  if (!['image', 'video', 'audio', 'document', 'sticker'].includes(type)) return null;
  const payload = message?.[type] && typeof message[type] === 'object' ? message[type] : {};
  const mediaId = payload.id ? String(payload.id).trim() : '';
  if (!mediaId) return null;
  return {
    media_id: mediaId,
    media_type: type,
    media_mime_type: payload.mime_type ? String(payload.mime_type).trim() : null,
    media_caption: payload.caption ? String(payload.caption).trim() : null,
    media_filename: payload.filename ? String(payload.filename).trim() : null
  };
}
