/**
 * DT Bot Core & DT CRM Core — Production WhatsApp Cloud API Server
 * Built by DT Marketing
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 5000;
const WEBHOOK_BODY_LIMIT = process.env.WEBHOOK_BODY_LIMIT || '1mb';
const MEDIA_BODY_LIMIT = process.env.MEDIA_BODY_LIMIT || '12mb';
const SERVER_STARTED_AT = new Date().toISOString();
const RESEND_API_URL = 'https://api.resend.com/emails';
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
const ALERT_EMAIL_TO = String(process.env.ALERT_EMAIL_TO || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const ALERT_EMAIL_FROM = String(process.env.ALERT_EMAIL_FROM || '').trim();
const SPR_ALERT_TIMEZONE = String(process.env.SPR_ALERT_TIMEZONE || 'America/Mexico_City').trim();
const SPR_INACTIVITY_ALERT_HOURS = Math.max(1, Number(process.env.SPR_INACTIVITY_ALERT_HOURS || 3));
const SPR_ALERT_CHECK_INTERVAL_MS = Math.max(60000, Number(process.env.SPR_ALERT_CHECK_INTERVAL_MS || 600000));
const SPR_INACTIVITY_STATE_PATH = 'system_alert_state/spr_inactivity';

// Capture raw body for Meta HMAC-SHA256 signature verification
app.use(cors());
// Media messages are posted as JSON with a base64 payload from the CRM. Keep
// this larger parser scoped to the media endpoint so webhook bodies retain the
// normal 1 MB safety limit.
app.use('/api/send-media', express.json({ limit: MEDIA_BODY_LIMIT }));
app.use(express.json({
  limit: WEBHOOK_BODY_LIMIT,
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
// Defaults that are applied to every tenant when a bot has not yet been
// configured. They keep the assistant tenant-scoped and prevent an uncertain
// catalog result from becoming an incorrect "out of stock" claim.
const TENANT_POLICY_VERSION = 'tenant-safe-defaults-20261010';
const TENANT_SAFE_ONBOARDING_POLICY = Object.freeze({
  tenant_isolation_required: true,
  require_own_waba: true,
  require_verified_phone_number: true,
  require_client_billing_owner: true,
  review_uncertain_requests: true,
  silent_uncertain_fallback: true,
  keyword_search_before_no_match: true,
  ask_vehicle_details_before_no_match: true,
  preserve_tenant_identity: true,
  no_cross_tenant_content: true
});

// Per-tenant emergency pause. No tenant is paused by default; an environment
// value can pause one or more tenants without affecting other tenants such as
// DT Marketing. SPR is active by default after this release. A stale
// PAUSED_BOT_COMPANIES value left over from the previous emergency stop must
// not silently keep SPR offline; use SPR_BOT_ACTIVE=false when an explicit
// pause is intended.
const SPR_COMPANY_ID = 'comp_1787600762092';
const SPR_BOT_ACTIVE = !/^(false|0|off|paused)$/i.test(
  String(process.env.SPR_BOT_ACTIVE ?? 'true').trim()
);
const PAUSED_BOT_COMPANIES = new Set(
  String(process.env.PAUSED_BOT_COMPANIES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

function isTenantPaused(companyId) {
  const normalizedCompanyId = String(companyId || '').trim();
  if (normalizedCompanyId === SPR_COMPANY_ID) return !SPR_BOT_ACTIVE;
  return PAUSED_BOT_COMPANIES.has(normalizedCompanyId);
}

function getTenantSafeBotDefaults(tenant = {}) {
  const name = String(tenant.nombre || tenant.name || 'nuestro negocio').trim();
  return {
    policy_version: TENANT_POLICY_VERSION,
    silent_uncertain_fallback: true,
    onboarding_policy: { ...TENANT_SAFE_ONBOARDING_POLICY },
    welcome_message: `¡Hola! 👋 Gracias por comunicarte con ${name}. Soy tu asistente virtual y con gusto te ayudo.`,
    out_of_hours_message: `¡Hola! Gracias por escribir a ${name}. En este momento estamos fuera de horario; registré tu consulta para que un asesor la revise.`,
    fallback_message: '',
    custom_instructions: `Eres el asistente oficial de ${name}. Responde con amabilidad y precisión. Busca por palabras clave y usa marca, modelo, año y pieza para verificar la solicitud antes de responder. No inventes precios, compatibilidad ni existencias. Si no puedes confirmar la información con seguridad, marca la conversación para revisión de un asesor y no envíes una respuesta automática. Mantén siempre el nombre e identidad de esta empresa y no menciones otras empresas o cuentas.`
  };
}

function mergeTenantSafeBotSettings(tenant, settings) {
  const defaults = getTenantSafeBotDefaults(tenant);
  const current = settings && typeof settings === 'object' ? settings : {};
  return {
    ...defaults,
    ...current,
    onboarding_policy: {
      ...defaults.onboarding_policy,
      ...(current.onboarding_policy || {})
    }
  };
}
// Auto-reactivate the bot after an advisor has been idle.
// Keep bot silent for five minutes after the last advisor message.
const HUMAN_HANDOFF_IDLE_MINUTES = 5;

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return timestampMs(value.toDate());
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  const parsed = value instanceof Date ? value : new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : 0;
}

function sanitizeMetaLogValue(value, key = '') {
  const normalizedKey = String(key || '').toLowerCase();
  if (/^(access_token|authorization|token|password|secret|input|wa_id|phone|phone_number|display_phone_number|recipient_id|to|from)$/.test(normalizedKey)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string') {
    return value
      .replace(/(access_token|authorization|token|password|secret)=([^&\s]+)/gi, '$1=[REDACTED]')
      .replace(/\b\d{10,15}\b/g, '[REDACTED_PHONE]');
  }
  if (Array.isArray(value)) return value.map(item => sanitizeMetaLogValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeMetaLogValue(entryValue, entryKey)
    ]));
  }
  return value;
}

function serializeMetaLogBody(body) {
  try {
    return JSON.stringify(sanitizeMetaLogValue(body));
  } catch (error) {
    return JSON.stringify({ log_serialization_error: error.message });
  }
}

function logMetaApiResponse(operation, response) {
  console.log(`[Meta API] operation=${operation} http_status=${response?.status ?? 'unknown'} response_body=${serializeMetaLogBody(response?.data ?? null)}`);
}

function logMetaApiError(operation, error) {
  const response = error?.response;
  const body = response?.data ?? { error: error?.message || 'Unknown Meta API error' };
  console.error(`[Meta API] operation=${operation} http_status=${response?.status ?? 'no_response'} response_body=${serializeMetaLogBody(body)}`);
}

function getWebhookEventType(value) {
  const hasMessages = Array.isArray(value?.messages) && value.messages.length > 0;
  const hasStatuses = Array.isArray(value?.statuses) && value.statuses.length > 0;
  if (hasMessages && hasStatuses) return 'ambos';
  if (hasMessages) return 'mensaje';
  if (hasStatuses) return 'estado';
  return 'ninguno';
}

function logWebhookEvent(value, result, reason, details = {}) {
  console.log(`[WhatsApp Webhook] ${JSON.stringify({
    hora: new Date().toISOString(),
    phone_number_id: value?.metadata?.phone_number_id || 'no_informado',
    tipo_evento: getWebhookEventType(value),
    resultado: result,
    motivo: sanitizeMetaLogValue(reason),
    ...details
  })}`);
}

function isAlertEmailConfigured() {
  return Boolean(RESEND_API_KEY && ALERT_EMAIL_FROM && ALERT_EMAIL_TO.length);
}

async function sendAlertEmail({ subject, text }) {
  if (!isAlertEmailConfigured()) {
    console.warn('[Alert email] Disabled: configure RESEND_API_KEY, ALERT_EMAIL_FROM and ALERT_EMAIL_TO in Render.');
    return false;
  }

  try {
    await axios.post(RESEND_API_URL, {
      from: ALERT_EMAIL_FROM,
      to: ALERT_EMAIL_TO,
      subject,
      text
    }, {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    console.log(`[Alert email] Sent: ${subject}`);
    return true;
  } catch (error) {
    console.error('[Alert email] Resend failed:', error.response?.data?.message || error.message);
    return false;
  }
}

function getZonedDateParts(date, timeZone = SPR_ALERT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(date));
  const values = Object.fromEntries(parts
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: weekdays[values.weekday]
  };
}

function getTimeZoneOffsetMs(date, timeZone = SPR_ALERT_TIMEZONE) {
  const parts = getZonedDateParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - new Date(date).getTime();
}

function zonedPartsToUtc(parts, timeZone = SPR_ALERT_TIMEZONE) {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = localAsUtc;
  for (let index = 0; index < 3; index += 1) {
    const corrected = localAsUtc - getTimeZoneOffsetMs(new Date(guess), timeZone);
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

function isSprBusinessWindow(date = new Date(), timeZone = SPR_ALERT_TIMEZONE) {
  const parts = getZonedDateParts(date, timeZone);
  return parts.weekday >= 1 && parts.weekday <= 6 && parts.hour >= 9 && parts.hour < 19;
}

function businessMinutesSince(startDate, endDate = new Date(), timeZone = SPR_ALERT_TIMEZONE) {
  const startMs = timestampMs(startDate);
  const endMs = timestampMs(endDate);
  if (!startMs || !endMs || endMs <= startMs) return 0;

  const startParts = getZonedDateParts(new Date(startMs), timeZone);
  const endParts = getZonedDateParts(new Date(endMs), timeZone);
  let cursor = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
  const lastDay = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
  let totalMinutes = 0;

  for (let index = 0; cursor <= lastDay && index < 370; index += 1) {
    const cursorDate = new Date(cursor);
    const dayParts = {
      year: cursorDate.getUTCFullYear(),
      month: cursorDate.getUTCMonth() + 1,
      day: cursorDate.getUTCDate()
    };
    const weekday = cursorDate.getUTCDay();
    if (weekday >= 1 && weekday <= 6) {
      const workStart = zonedPartsToUtc({ ...dayParts, hour: 9, minute: 0, second: 0 }, timeZone).getTime();
      const workEnd = zonedPartsToUtc({ ...dayParts, hour: 19, minute: 0, second: 0 }, timeZone).getTime();
      const overlapStart = Math.max(startMs, workStart);
      const overlapEnd = Math.min(endMs, workEnd);
      if (overlapEnd > overlapStart) totalMinutes += (overlapEnd - overlapStart) / 60000;
    }
    cursor += 86400000;
  }

  return totalMinutes;
}

async function checkSprInactivityAlert(now = new Date()) {
  if (!db || !isAlertEmailConfigured() || !isSprBusinessWindow(now)) return false;

  const stateRef = db.doc(SPR_INACTIVITY_STATE_PATH);
  const stateSnap = await stateRef.get();
  const state = stateSnap.exists ? stateSnap.data() || {} : {};
  const nowIso = new Date(now).toISOString();
  const baselineAt = state.baseline_at || SERVER_STARTED_AT;
  if (!stateSnap.exists || !state.baseline_at) {
    await stateRef.set({
      company_id: SPR_COMPANY_ID,
      baseline_at: baselineAt,
      updated_at: nowIso
    }, { merge: true });
  }

  const quietSince = state.last_customer_message_at || baselineAt;
  const quietSinceMs = timestampMs(quietSince);
  if (!quietSinceMs) return false;

  const quietBusinessMinutes = businessMinutesSince(quietSince, now, SPR_ALERT_TIMEZONE);
  const thresholdMinutes = SPR_INACTIVITY_ALERT_HOURS * 60;
  if (quietBusinessMinutes <= thresholdMinutes) return false;

  const lastAlertedMs = timestampMs(state.last_alerted_at);
  if (lastAlertedMs >= quietSinceMs) return false;

  const sent = await sendAlertEmail({
    subject: '[SPR] Más de 3 horas hábiles sin mensajes de clientes',
    text: [
      'SPR Autopartes no ha recibido mensajes de clientes durante más de 3 horas hábiles.',
      `Último mensaje de cliente: ${state.last_customer_message_at || 'no registrado; se tomó el arranque del servidor como referencia'}`,
      `Tiempo hábil transcurrido: ${Math.floor(quietBusinessMinutes / 60)} h ${Math.floor(quietBusinessMinutes % 60)} min`,
      `Horario considerado: lunes a sábado, 09:00–19:00 (${SPR_ALERT_TIMEZONE})`,
      `Revisión generada: ${nowIso}`
    ].join('\n')
  });

  if (sent) {
    await stateRef.set({
      company_id: SPR_COMPANY_ID,
      last_alerted_at: nowIso,
      last_alerted_business_minutes: Math.round(quietBusinessMinutes),
      updated_at: nowIso
    }, { merge: true });
  }
  return sent;
}

let inactivityAlertCheckRunning = false;
function startSprAlertMonitor() {
  if (!db || !isAlertEmailConfigured()) {
    console.warn('[SPR alerts] Monitor disabled until Resend environment variables are configured.');
    return null;
  }

  const runCheck = async () => {
    if (inactivityAlertCheckRunning) return;
    inactivityAlertCheckRunning = true;
    try {
      await checkSprInactivityAlert();
    } catch (error) {
      console.error('[SPR alerts] Inactivity check failed:', error.message);
    } finally {
      inactivityAlertCheckRunning = false;
    }
  };

  void runCheck();
  return setInterval(runCheck, SPR_ALERT_CHECK_INTERVAL_MS);
}

function createUniqueId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Meta normally sends the canonical international number, but older webhook
// deliveries and migrated conversations may still contain Mexico's legacy
// 521XXXXXXXXXX form. Always use one key for the same WhatsApp contact.
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

/**
 * Find a legacy conversation created with a different phone representation.
 * This prevents a new webhook from opening a second inbox card for the same
 * company/contact while preserving the canonical document id going forward.
 */
async function loadWhatsAppConversation(dbInstance, companyId, phone) {
  const canonicalId = canonicalWhatsAppConversationId(companyId, phone);
  const directSnap = await dbInstance.doc(`conversations/${canonicalId}`).get();
  if (directSnap.exists) return { id: canonicalId, data: directSnap.data(), legacyIds: [] };

  const targetPhone = normalizeWhatsAppPhone(phone);
  if (!targetPhone) return { id: canonicalId, data: null, legacyIds: [] };

  try {
    let snapshot = await dbInstance.collection('conversations')
      .where('contact_phone_normalized', '==', targetPhone)
      .limit(20)
      .get();
    let candidateDocs = snapshot.docs.filter(doc => {
      const data = doc.data() || {};
      return data.company_id === companyId && data.channel === 'whatsapp';
    });
    if (!candidateDocs.length) {
      snapshot = await dbInstance.collection('conversations')
        .where('company_id', '==', companyId)
        .where('channel', '==', 'whatsapp')
        .limit(200)
        .get();
      candidateDocs = snapshot.docs;
    }
    const matches = candidateDocs.filter(doc => {
      const data = doc.data() || {};
      const storedPhone = normalizeWhatsAppPhone(data.external_user_id || data.contact_phone);
      return storedPhone === targetPhone;
    });
    if (!matches.length) return { id: canonicalId, data: null, legacyIds: [] };

    const preferred = matches.find(doc => doc.id === canonicalId)
      || matches.slice().sort((a, b) => timestampMs((b.data() || {}).updated_at) - timestampMs((a.data() || {}).updated_at))[0];
    return {
      id: canonicalId,
      data: { ...(preferred.data() || {}), id: canonicalId },
      legacyIds: matches.filter(doc => doc.id !== canonicalId).map(doc => doc.id)
    };
  } catch (error) {
    console.warn('Could not resolve legacy WhatsApp conversation:', error.message);
    return { id: canonicalId, data: null, legacyIds: [] };
  }
}

async function migrateConversationMessages(dbInstance, legacyId, canonicalId) {
  if (!legacyId || !canonicalId || legacyId === canonicalId) return;
  try {
    let migratedCount = 0;
    while (true) {
      const oldMessages = await dbInstance.collection('messages')
        .where('conversation_id', '==', legacyId)
        .limit(100)
        .get();
      if (oldMessages.empty) break;
      const batch = dbInstance.batch();
      for (const messageDoc of oldMessages.docs) {
        batch.set(messageDoc.ref, { conversation_id: canonicalId }, { merge: true });
      }
      await batch.commit();
      migratedCount += oldMessages.size;
    }
    await dbInstance.doc(`conversations/${legacyId}`).delete();
    console.log(`🧹 [Conversation Merge] ${legacyId} → ${canonicalId} (${migratedCount} mensajes migrados en lotes de 100)`);
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

// Keep greeting and courtesy detection reusable by the offline evaluator and
// by the webhook. These messages must never fall through to catalog matching.
function isFriendlyGreetingText(value) {
  const text = normalizeBotText(value);
  return /^(?:(?:hola|holi|hey|hello)\s+)?(?:hola|holi|hey|hello|buen dia|buenos dias|buenas tardes|buenas noches|inicio)$/.test(text);
}

function isCourtesyText(value) {
  const text = normalizeBotText(value).replace(/^(?:(?:ou+|wow+|wao+|ah+|ay+|oh+|ooo+|jaja+)\s+)+/, '').trim();
  return /^(?:(?:muchas|muchisimas|mil)\s+)?gracias(?:\s+(?:por|igualmente|de todos modos|todo|tu|su|te|le)\b.*)?$/.test(text)
    || /^(?:(?:te|le)\s+)?agradezco\b/.test(text);
}

// A customer can send the vehicle profile in several labeled lines before
// naming the part (for example: "Marca: Volkswagen", "Modelo: Tiguan",
// "Año: 2019", "Motor: 1.4 TSI"). Keep those labels as vehicle context so
// the bot does not ask for the same information again or mistake the engine
// specification for a request to buy a motor.
function extractSprVehicleDetails(value) {
  const details = {};
  const lines = String(value || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*[-*•]?\s*([^:]{1,48}):\s*(.+?)\s*$/);
    if (!match) continue;
    const label = normalizeBotText(match[1]);
    const detailValue = String(match[2] || '').trim();
    if (!detailValue) continue;

    if (/^(marca|marca del vehiculo|make|brand)$/.test(label)) details.marca = detailValue;
    else if (/^(modelo|model)$/.test(label)) details.modelo = detailValue;
    else if (/^(ano|year)$/.test(label)) details.ano = detailValue;
    else if (/^(motor|engine|motorizacion|motor del vehiculo)$/.test(label)) details.motor = detailValue;
    else if (/^(version|trim)$/.test(label)) details.version = detailValue;
    else if (/^(potencia|horsepower|hp)$/.test(label)) details.potencia = detailValue;
    else if (/^(transmision|transmission|caja)$/.test(label)) details.transmision = detailValue;
    else if (/^(traccion|drive|drivetrain)$/.test(label)) details.traccion = detailValue;
    else if (/^(numero de serie|numero de serie vin|vin|serie)$/.test(label)) details.vin = detailValue;
  }
  return details;
}

function stripSprVehicleDetailLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter(line => {
      const match = line.match(/^\s*[-*•]?\s*([^:]{1,48}):\s*(.+?)\s*$/);
      if (!match) return true;
      const label = normalizeBotText(match[1]);
      return !/^(marca|marca del vehiculo|make|brand|modelo|model|ano|year|motor|engine|motorizacion|motor del vehiculo|version|trim|potencia|horsepower|hp|transmision|transmission|caja|traccion|drive|drivetrain|numero de serie|numero de serie vin|vin|serie)$/.test(label);
    })
    .join('\n');
}

const SPR_EXPLICIT_PART_PATTERN = /\b(motor(?:es)?|cabeza(?:s)?|culata|engine series|amortiguador(?:es)?|suspensi[oó]n|bieleta(?:s)?|balero(?:s)?|maza(?:s)?|homocin[eé]tica(?:s)?|freno(?:s)?|balata(?:s)?|pastilla(?:s)?|aceite|anticongelante|refrigerante|coolant|lubricante|aditivo|liquido(?:s)?|buj[ií]a(?:s)?|bater[ií]a(?:s)?|filtro(?:s)?|llanta(?:s)?|neum[aá]tico(?:s)?|rin(?:es)?|birlo(?:s)?|plumilla(?:s)?|escobilla(?:s)?|fusible(?:s)?|foco(?:s)?|refacci[oó]n(?:es)?|pieza(?:s)?|direcci[oó]n|caja de direcci[oó]n|cremallera(?:s)?|rack(?:\s+and)?\s+pinion|radiador|bomba|turbo|embrague|clutch|soporte|terminal|r[oó]tula|faro(?:s)?|calavera(?:s)?|stop|l[aá]mpara(?:s)?|luz|luces|espejo(?:s)?|gu[ií]a(?:s)?|fascia(?:s)?|moldura(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|cajuela|puerta(?:s)?|manija(?:s)?|bisagra(?:s)?|tolva(?:s)?|rejilla(?:s)?|salpicadera(?:s)?|carrocer[ií]a)\b/i;

function hasSprExplicitPartRequest(value) {
  const query = normalizeSprCatalogText(normalizeBotText(stripSprVehicleDetailLines(value)));
  return SPR_EXPLICIT_PART_PATTERN.test(query) || isUnlistedSprProductRequest(query);
}

function buildSprVehicleConfirmationReply(details) {
  const labels = [
    ['marca', 'Marca'],
    ['modelo', 'Modelo'],
    ['ano', 'Año'],
    ['motor', 'Motor'],
    ['version', 'Versión'],
    ['potencia', 'Potencia'],
    ['transmision', 'Transmisión'],
    ['traccion', 'Tracción']
  ];
  // Do not echo the customer's VIN. It remains backend context and is never
  // repeated in an automated WhatsApp reply.
  const visibleLines = labels
    .filter(([key]) => details && details[key])
    .map(([key, label]) => `• ${label}: ${details[key]}`);
  return `✅ Perfecto, ya recibí los datos de tu vehículo:\n\n${visibleLines.join('\n')}\n\n🔧 ¿Qué pieza o refacción necesitas consultar?`;
}

// Customers often type collision parts phonetically or with one missing
// letter. Normalize only well-known catalog variants in the query so a typo
// such as "facia"/"kickn" does not turn an exact catalog match into a false
// out-of-stock answer. Product titles remain unchanged and are still checked
// strictly against the normalized query.
// Customer wording varies widely by region. Canonicalize known technical and
// colloquial names before every catalog pass. In particular, "cacahuate" is
// the colloquial stabilizer bolt, never a cajuela; confusing those families
// was one of the regressions that caused valid Vento requests to be rejected.
const SPR_PART_SYNONYM_GROUPS = [
  { canonical: 'amortiguador', aliases: ['amortiguador', 'amortiguadores', 'amort', 'pierna completa', 'piernas', 'pierna', 'strut', 'shock', 'shocks'] },
  { canonical: 'base de amortiguador', aliases: ['base de amortiguador', 'bases de amortiguador', 'base amortiguador', 'bases amortiguador', 'base amort', 'bases amort', 'base de pierna', 'bases de pierna'] },
  { canonical: 'bieleta', aliases: ['bieleta', 'canilla', 'canillas', 'link', 'bielita'] },
  { canonical: 'terminal', aliases: ['terminal', 'terminal interior', 'terminal exterior', 'terminales'] },
  { canonical: 'rotula', aliases: ['rotula', 'rotula direccion exterior', 'rótula'] },
  { canonical: 'junta homocinetica', aliases: ['junta homocinetica', 'espiga', 'espigas', 'punta homocinetica', 'punta de flecha', 'homocinetica', 'homocinética'] },
  { canonical: 'horquilla', aliases: ['horquilla', 'brazo de suspension', 'brazo de control', 'tijera', 'meseta'] },
  { canonical: 'caja de direccion', aliases: ['caja de direccion', 'caja direccion', 'cremallera', 'cremalleras', 'rack', 'rack and pinion', 'rack pinion', 'steering rack', 'steering'] },
  { canonical: 'balero', aliases: ['balero', 'rodamiento', 'bearing', 'bearings'] },
  { canonical: 'maza', aliases: ['maza', 'cubo', 'hub', 'hubs'] },
  { canonical: 'flecha', aliases: ['flecha', 'semieje', 'eje homocinetico'] },
  { canonical: 'faro', aliases: ['faro delantero', 'faro', 'headlamp', 'headlamps'] },
  // "Rejilla" and "parrilla" are used interchangeably in Mexican catalogs.
  // Keep them as one explicit part family so a request for a fog-light kit
  // cannot fall through to an unrelated product that only shares the vehicle.
  { canonical: 'rejilla', aliases: ['rejilla', 'rejillas', 'parrilla', 'parrillas'] },
  { canonical: 'calavera', aliases: ['calavera', 'mica trasera', 'stop', 'rear lamp'] },
  { canonical: 'fascia', aliases: ['fascia', 'facia', 'fasia', 'faccia', 'defensa', 'bumper', 'bumpers'] },
  { canonical: 'espejo', aliases: ['espejo', 'retrovisor', 'retrovisores'] },
  { canonical: 'soporte de motor', aliases: ['soporte de motor', 'base de motor', 'taco de motor'] },
  { canonical: 'embrague', aliases: ['embrague', 'clutch', 'repset'] },
  { canonical: 'tornillo', aliases: ['tornillo', 'estabilizador', 'cacahuate', 'cachahuate', 'cachuate', 'cahuate', 'cacuate'] }, { canonical: 'anticongelante', aliases: ['anticongelante', 'refrigerante', 'coolant'] }
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
  normalized = normalized.replace(/\bchev\s+(?:soy|soi|boy|boi|hoy)\b/g, ' chevy ');
  const vehicleAliases = new Map([
    ['kickn', 'kicks'],
    ['kikcs', 'kicks'],
    ['kiccks', 'kicks']
  ]);
  normalized = normalized.split(/\s+/).map(token => vehicleAliases.get(token) || token).join(' ');
  return compactSprVehicleModelTokens(normalized.replace(/\s+/g, ' ').trim());
}

function compactSprVehicleModelTokens(value) {
  const modelPrefixes = new Set(['l', 'f', 'i', 'a', 'x', 'q', 's']);
  return String(value || '').replace(/\b([a-z]{1,3})\s+(\d{2,4})\b/gi, (match, prefix, number) => {
    const normalizedPrefix = String(prefix).toLowerCase();
    if (!modelPrefixes.has(normalizedPrefix) || ['ano', 'modelo', 'version'].includes(normalizedPrefix)) return match;
    return `${normalizedPrefix}${number}`;
  });
}

function normalizeSprCatalogText(value) {
  return canonicalizeSprPartSynonyms(value);
}

// "Dirección" is also a very common automotive part (steering rack/assembly).
// Only treat it as the business address when the customer clearly asks for the
// location of the store or uses an explicit location phrase.
function isCustomerLocationQuestion(value) {
  const normalized = normalizeBotText(value);
  if (/\b(ubicacion|ubicados|donde estan|donde se encuentran|sucursal|domicilio|horarios?)\b/.test(normalized)) {
    return true;
  }
  if (!/\bdireccion\b/.test(normalized)) return false;
  return (
    /\b(?:cual es|dime|me compartes|me das|compartenos|comparteme)\s+(?:la\s+|su\s+)?direccion\b/.test(normalized)
    || /\bsu\s+direccion\b/.test(normalized)
    || /\bdireccion\s+(?:del|de la)\s+(?:local|sucursal|negocio|tienda|oficina|empresa)\b/.test(normalized)
    || /\bdireccion\s+(?:de|del)\s+(?:spr|ustedes|la empresa|el negocio|la tienda)\b/.test(normalized)
  );
}

function isSprStoreLocationQuestion(value) {
  const query = normalizeBotText(value);
  const asksLocation = /\b(ubicacion|ubicados|donde estan|donde se encuentran|sucursal|domicilio|local|tienda|oficina|como llego)\b/.test(query)
    || /\bdireccion\s+(?:del|de la)\s+(?:local|sucursal|negocio|tienda|oficina|empresa)\b/.test(query)
    || /\b(?:cual es|dime|me compartes|me das|comparteme|compartenos)\s+(?:la\s+|su\s+)?direccion\b/.test(query);
  if (!asksLocation) return false;
  // “Dirección de Honda Passport modelo 98” is a requested part, not the
  // store address. Keep the two intents separate.
  return !(SPR_CATALOG_CONTEXT_PATTERN.test(query)
    && hasSprVehicleReference(query)
    && !/\b(local|sucursal|negocio|tienda|oficina|empresa)\b/.test(query));
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
    [/^\s*(direcci[oó]n|terminal|r[oó]tula|caja de direcci[oó]n)\b/i, '🔧'],
    [/^\s*(ubicaci[oó]n|ubicados|sucursal|domicilio)\b/i, '📍'],
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
// Shopify product titles usually omit trim/package words that customers include
// in natural language (for example, "GL" or "Mind"). Keep the vehicle model,
// year and requested part strict while treating these descriptors as optional.
const SPR_OPTIONAL_VEHICLE_WORDS = new Set(['gl', 'gls', 'gle', 'glx', 'lt', 'ls', 'le', 'lx', 'ex', 'se', 'sv', 'sr', 'slt', 'xlt', 'xl', 'xle', 'xse', 'mind', 'mild', 'sport', 'touring', 'limited', 'premium', 'plus', 'classic', 'sedan', 'hatchback', 'hb', 'coupe', 'convertible']);
const SPR_OPTIONAL_VEHICLE_WORDS_PATTERN = /\b(gl|gls|gle|glx|lt|ls|le|lx|ex|se|sv|sr|slt|xlt|xl|xle|xse|mind|mild|sport|touring|limited|premium|plus|classic|sedan|hatchback|hb|coupe|convertible)\b/gi;
// La promoción de septiembre quedó desactivada: el bot debe mostrar únicamente
// el precio normal de motores y cabezas de motor.
const SPR_SEPTEMBER_DISCOUNT_PERCENT = 0;
let sprCatalogCache = { fetchedAt: 0, items: [] };
let sprCatalogFetchPromise = null;
let sprCatalogSource = 'none';
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
  return ALDO_STOCK_CATEGORY_PATTERN.test(normalizeSprCatalogText(value));
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
  if (aldoStockCache.size > 500) {
    const oldestKey = aldoStockCache.keys().next().value;
    if (oldestKey) aldoStockCache.delete(oldestKey);
  }
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

function normalizeSprImageUrl(value) {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    const raw = candidate && typeof candidate === 'object'
      ? (candidate.src || candidate.url || candidate.originalSrc || candidate.image_url || candidate.imageUrl || '')
      : candidate;
    const url = String(raw || '').trim();
    if (/^https?:\/\/[^\s]+$/i.test(url)) return url;
  }
  return '';
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
  const sku = String(variant.sku || product?.sku || product?.codigo || product?.code || '').replace(/^'+/, '').trim();
  const rawProductUrl = String(product?.url || product?.product_url || product?.link || '').trim();
  const productUrl = rawProductUrl.startsWith('/')
    ? 'https://sprautopartes.mx' + rawProductUrl
    : rawProductUrl;
  const image = normalizeSprImageUrl(
    product?.image || product?.featured_image || product?.featuredImage
      || product?.image_url || product?.imageUrl || product?.imagen || product?.foto
      || product?.thumbnail || product?.images
  );
  return {
    id: product?.id || handle,
    title,
    normalizedTitle: normalizeSprCatalogText(title),
    vendor,
    productType,
    tags,
    description: stripSprHtml(product?.body_html),
    available,
    sku,
    regularPrice,
    offerPrice: hasSeptemberOffer ? offerPrice : currentPrice,
    hasSeptemberOffer,
    discountEligible,
    url: productUrl || (handle ? 'https://sprautopartes.mx/products/' + handle : 'https://sprautopartes.mx/collections/spr-engine-series'),
    image
  };
}

const SPR_OFFICIAL_SEARCH_URL = 'https://sprautopartes.mx/search/suggest.json';

async function getSprEngineCatalog() {
  const now = Date.now();
  if (sprCatalogCache.items.length > 0 && now - sprCatalogCache.fetchedAt < SPR_CATALOG_TTL_MS) return sprCatalogCache.items;
  if (sprCatalogFetchPromise) return sprCatalogFetchPromise;
  sprCatalogFetchPromise = (async () => {
    const response = await axios.get(SPR_ENGINE_COLLECTION_URL, {
      timeout: 9000,
      headers: { 'User-Agent': 'DT Bot Core / SPR official catalog' }
    });
    const products = Array.isArray(response.data?.products) ? response.data.products : [];
    if (!products.length) throw new Error('SPR official catalog returned no products');
    const items = products.map(normalizeSprProduct).filter(item => item.title && item.regularPrice > 0);
    sprCatalogSource = 'official_shopify_catalog';
    sprCatalogCache = { fetchedAt: Date.now(), items };
    return items;
  })().finally(() => {
    sprCatalogFetchPromise = null;
  });
  return sprCatalogFetchPromise;
}

const KNOWLEDGE_CACHE_TTL_MS = Math.max(5000, Number(process.env.KNOWLEDGE_CACHE_TTL_MS || 15000));
const knowledgeCache = new Map();
const knowledgeFetches = new Map();

async function getTenantKnowledgeBase(dbInstance, companyId) {
  const key = String(companyId || '').trim();
  if (!dbInstance || !key) return [];
  const now = Date.now();
  const cached = knowledgeCache.get(key);
  if (cached && now - cached.fetchedAt < KNOWLEDGE_CACHE_TTL_MS) return cached.items;
  if (knowledgeFetches.has(key)) return knowledgeFetches.get(key);
  const fetchPromise = (async () => {
    try {
      const kbSnap = await dbInstance.collection('knowledge_base')
        .where('company_id', '==', key)
        .where('enabled', '==', true)
        .get();
      const items = kbSnap.docs.map(doc => doc.data());
      knowledgeCache.set(key, { fetchedAt: Date.now(), items });
      if (knowledgeCache.size > 500) {
        const oldestKey = knowledgeCache.keys().next().value;
        if (oldestKey) knowledgeCache.delete(oldestKey);
      }
      return items;
    } catch (error) {
      console.warn(`Could not load knowledge base for ${key}:`, error.message);
      return cached?.items || [];
    } finally {
      knowledgeFetches.delete(key);
    }
  })();
  knowledgeFetches.set(key, fetchPromise);
  return fetchPromise;
}

async function searchSprCatalog(query) {
  const response = await axios.get(SPR_OFFICIAL_SEARCH_URL, {
    timeout: 9000,
    params: {
      q: String(query || '').trim(),
      'resources[type]': 'product',
      'resources[limit]': 10
    },
    headers: { 'User-Agent': 'DT Bot Core / SPR catalog search' }
  });
  const products = Array.isArray(response.data?.resources?.results?.products)
    ? response.data.resources.results.products
    : [];
  return products.map(normalizeSprProduct).filter(item => item.title && item.regularPrice > 0);
}

function findSprStrictMatches(items, lowerText) {
  const normalizedQuery = normalizeSprCatalogText(lowerText);
  const stopWords = new Set(['quiero', 'quieres', 'busco', 'buscando', 'necesito', 'dame', 'tienes', 'tienen', 'hay', 'para', 'una', 'uno', 'precio', 'precios', 'cuanto', 'cuesta', 'costo', 'cotizacion', 'cotizar', 'comprar', 'compra', 'nuevo', 'nueva', 'disponible', 'disponibilidad', 'por', 'favor', 'me', 'interesa', 'motor', 'motores', 'cabeza', 'cabezas', 'culata', 'engine', 'series', 'de', 'el', 'la', 'los', 'las', 'un', 'y', 'o', 'mi', 'auto', 'carro', 'vehiculo', 'vehículo', 'producto', 'productos', 'catalogo', 'catalog', 'refaccion', 'refacciones', 'pieza', 'piezas', 'stock', 'completo', 'completa', 'todo', 'toda', 'todos', 'todas', 'ver', 'muestrame', 'muéstrame', 'informacion', 'información', 'que', 'qué', 'delantero', 'delantera', 'trasero', 'trasera', 'izquierdo', 'izquierda', 'derecho', 'derecha', 'lado', 'principal', 'niebla', 'antiniebla', 'no', 'sin', 'quiero']);
  const tokens = normalizedQuery.split(' ').filter(token => token.length >= 3 && !stopWords.has(token));
  const categoryRules = [
    { key: 'motor', pattern: /\bmotor(?:es)?\b/ },
    { key: 'cabeza', pattern: /\b(cabeza(?:s)?|culata(?:s)?)\b/ },
    { key: 'amortiguador', pattern: /\bamortiguador(?:es)?\b/ },
    { key: 'suspension', pattern: /\b(suspension|bieleta)\b/ },
    { key: 'balero', pattern: /\b(balero|maza|homocin[eé]tica)\b/ },
    { key: 'freno', pattern: /\b(freno(?:s)?|balata(?:s)?|pastilla(?:s)?)\b/ },
    { key: 'aceite', pattern: /\b(aceite(?:s)?|lubricante(?:s)?|motul|valvoline|pentosin)\b/ },
    { key: 'direccion', pattern: /\b(direccion|terminal|rotula|caja de direccion)\b/ },
    { key: 'radiador', pattern: /\b(radiador(?:es)?|enfriamiento|cooling)\b/ },
    { key: 'bomba', pattern: /\bbomba(?:s)?\b/ },
    { key: 'turbo', pattern: /\bturbo(?:s)?\b/ },
    { key: 'embrague', pattern: /\b(embrague|clutch)\b/ },
    { key: 'soporte', pattern: /\bsoporte(?:s)?\b/ },
    { key: 'iluminacion', pattern: /\b(faro(?:s)?|calavera(?:s)?|lampara(?:s)?|luz|luces|espejo(?:s)?)\b/ },
    { key: 'colision', pattern: /\b(guia(?:s)?|fascia(?:s)?|moldura(?:s)?|defensa(?:s)?|parrilla(?:s)?|cofre|salpicadera(?:s)?)\b/ },
    { key: 'carroceria', pattern: /\b(parrilla(?:s)?|defensa(?:s)?|cofre|cajuela|salpicadera(?:s)?|carroceria)\b/ }
  ];
  const requestedCategory = categoryRules.find(rule => rule.key !== 'motor' && rule.pattern.test(normalizedQuery))
    || categoryRules.find(rule => rule.pattern.test(normalizedQuery));
  // A broad family (for example, “iluminación” or “colisión”) is not enough
  // to answer a concrete request. Keep the requested part itself as a hard
  // constraint so a calavera cannot be replaced with an espejo, or a cajuela
  // with a salpicadera just because they share a catalog family.
  const requestedPartPatterns = [
    { key: 'motor', pattern: /\bmotor(?:es)?\b/ },
    { key: 'cabeza', pattern: /\b(cabeza(?:s)?|culata(?:s)?)\b/ },
    { key: 'amortiguador', pattern: /\bamortiguador(?:es)?\b/ },
    { key: 'bieleta', pattern: /\bbieleta(?:s)?\b/ },
    { key: 'balero', pattern: /\b(balero(?:s)?|maza(?:s)?|homocin[eé]tica(?:s)?)\b/ },
    { key: 'calavera', pattern: /\bcalavera(?:s)?\b/ },
    { key: 'stop', pattern: /\bstop\b/ },
    { key: 'faro', pattern: /\bfaro(?:s)?\b/ },
    { key: 'rejilla', pattern: /\brejilla(?:s)?\b/ },
    { key: 'espejo', pattern: /\bespejo(?:s)?\b/ },
    { key: 'fascia', pattern: /\bfascia(?:s)?\b/ },
    { key: 'guia', pattern: /\bgu[ií]a(?:s)?\b/ },
    { key: 'moldura', pattern: /\bmoldura(?:s)?\b/ },
    { key: 'parrilla', pattern: /\bparrilla(?:s)?\b/ },
    { key: 'defensa', pattern: /\bdefensa(?:s)?\b/ },
    { key: 'cofre', pattern: /\bcofre\b/ },
    { key: 'cajuela', pattern: /\bcajuela\b/ },
    { key: 'salpicadera', pattern: /\bsalpicadera(?:s)?\b/ },
    { key: 'puerta', pattern: /\bpuerta(?:s)?\b/ },
    { key: 'radiador', pattern: /\bradiador(?:es)?\b/ },
    { key: 'bomba', pattern: /\bbomba(?:s)?\b/ },
    { key: 'turbo', pattern: /\bturbo(?:s)?\b/ },
    { key: 'embrague', pattern: /\b(embrague|clutch)\b/ },
    { key: 'direccion', pattern: /\b(direccion|terminal(?:es)?|rotula(?:s)?)\b/ }
  ].filter(({ pattern }) => pattern.test(normalizedQuery));
  // “Cremallera”, “rack” and “caja de dirección” identify the steering-rack
  // piece itself. A generic catalog tag such as “Dirección” is not enough:
  // many unrelated products carry that department tag and previously caused
  // a RAM request to return a clutch. Keep this family as a hard constraint.
  const requestsSteeringRack = /\bcaja de direccion\b/.test(normalizedQuery);
  if (requestsSteeringRack) {
    requestedPartPatterns.push({
      key: 'cremallera',
      pattern: /\b(?:caja de direccion|cremallera|rack(?:\s+and)?\s+pinion|steering\s+rack)\b/
    });
  }
  const requestedYears = [...normalizedQuery.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
  // Prefer the side (left/right) over the position (front/rear). A query such
  // as “puerta delantera izquierda” must never return the right-hand part just
  // because “delantera” appears first.
  const requestedOrientations = [...normalizedQuery.matchAll(/\b(izquierdo|izquierda|derecho|derecha|delantero|delantera|trasero|trasera)\b/g)]
    .map(match => match[1])
    .filter((value, index, values) => values.indexOf(value) === index);
  const negativeFogRequest = /\b(?:no|sin|evitar|ningun|ninguna)\b(?:\s+\w+){0,8}\s+(?:faro\s+de\s+)?niebla\b/.test(normalizedQuery);
  const mentionsBodyPartWithFogFeature = /\b(defensa(?:s)?|parrilla(?:s)?|fascia(?:s)?|moldura(?:s)?|cofre|salpicadera(?:s)?|carrocer[ií]a|puerta(?:s)?|cajuela)\b/.test(normalizedQuery);
  const asksFogLight = !negativeFogRequest && !mentionsBodyPartWithFogFeature && /\b(?:faro\s+de\s+niebla|niebla|antiniebla)\b/.test(normalizedQuery);
  const asksMainLight = !asksFogLight && !mentionsBodyPartWithFogFeature && /\b(?:faro|faros|principal|delantero|delantera)\b/.test(normalizedQuery);
  const wantsHead = /\b(cabeza(?:s)?|culata(?:s)?)\b/.test(normalizedQuery);
  const wantsMotorAccessory = /\b(soporte(?:s)?|base(?:s)?|taco(?:s)?|montura(?:s)?|mount(?:s)?|sensor(?:es)?|accesorio(?:s)?)\b/.test(normalizedQuery);
  const hasNonMotorCatalogPart = /\b(cabeza(?:s)?|culata(?:s)?|amortiguador(?:es)?|suspension|bieleta(?:s)?|balero(?:s)?|maza(?:s)?|freno(?:s)?|balata(?:s)?|pastilla(?:s)?|aceite|direccion|terminal(?:es)?|rotula(?:s)?|radiador(?:es)?|bomba(?:s)?|turbo(?:s)?|embrague|clutch|soporte(?:s)?|faro(?:s)?|calavera(?:s)?|lampara(?:s)?|luz|luces|espejo(?:s)?|guia(?:s)?|fascia(?:s)?|moldura(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|cajuela|puerta(?:s)?|manija(?:s)?|bisagra(?:s)?|tolva(?:s)?|rejilla(?:s)?|salpicadera(?:s)?|carroceria)\b/.test(normalizedQuery);
  const wantsMotor = /\bmotor(?:es)?\b/.test(normalizedQuery) && !wantsHead && !wantsMotorAccessory && !hasNonMotorCatalogPart;
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
  const itemHasFogLight = item => /\b(?:niebla|antiniebla)\b/.test(item.normalizedTitle)
    && !/\bsin\s+(?:faro\s+de\s+)?niebla\b/.test(item.normalizedTitle);
  const itemMatchesRequestedYear = item => {
    if (!requestedYears.length) return true;
    const source = String(item.title || '') + ' ' + String(item.description || '') + ' ' + String(item.tags || '');
    const explicitYears = [...source.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
    const ranges = [...source.matchAll(/\b((?:19|20)\d{2})\s*[-–/]\s*((?:19|20)\d{2})\b/g)]
      .map(match => [Number(match[1]), Number(match[2])]);
    return requestedYears.some(year => explicitYears.includes(year) || ranges.some(([start, end]) => year >= Math.min(start, end) && year <= Math.max(start, end)));
  };
  const itemMatchesRequestedOrientation = item => {
    if (!requestedOrientations.length) return true;
    const title = item.normalizedTitle || '';
    return requestedOrientations.every(requestedOrientation => {
      if (requestedOrientation.startsWith('izquier')) return /\bizquierd[oa]\b/.test(title);
      if (requestedOrientation.startsWith('derech')) return /\bderech[oa]\b/.test(title);
      if (requestedOrientation.startsWith('delanter')) return /\b(?:delanter[oa]|frontal)\b/.test(title);
      if (requestedOrientation.startsWith('traser')) return /\btraser[oa]\b/.test(title);
      return true;
    });
  };
  const scored = items.map(item => {
    let score = 0;
    const haystack = canonicalizeSprPartSynonyms([item.normalizedTitle, normalizeBotText(item.vendor), normalizeBotText(item.productType), normalizeBotText(item.tags)].join(' '));
    const matchedTokens = [];
    for (const token of tokens) {
      if (haystack.includes(token)) {
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

  if (requestedOrientations.length) {
    const orientationMatches = relevant.filter(row => itemMatchesRequestedOrientation(row.item));
    if (!orientationMatches.length) return [];
    relevant = orientationMatches;
  }

  if (requestedCategory?.key === 'iluminacion' && !mentionsBodyPartWithFogFeature) {
    const lightingMatches = relevant.filter(row => asksFogLight ? itemHasFogLight(row.item) : !itemHasFogLight(row.item));
    if (!lightingMatches.length) return [];
    relevant = lightingMatches;
  }

  if (requestedPartPatterns.length) {
    const exactPartMatches = relevant.filter(row => requestedPartPatterns.every(({ pattern }) => pattern.test(row.haystack)));
    if (!exactPartMatches.length) return [];
    relevant = exactPartMatches;
  }

  // Every meaningful make/model token must appear in the same product. A
  // previous implementation accepted any one token (for example, the make
  // only), which let a request for a missing engine return another part from
  // the same make. Orientation and year are checked separately above.
  const vehicleTokens = tokens
    .filter(token => !categoryRules.some(rule => rule.pattern.test(token)) && !/^\d{4}$/.test(token))
    .filter(token => !SPR_OPTIONAL_VEHICLE_WORDS.has(token))
    .filter(token => token.length >= 3 && !['spr'].includes(token));
  if (vehicleTokens.length) {
    const exactVehicleMatches = relevant.filter(row => vehicleTokens.every(token => row.haystack.includes(token)));
    if (!exactVehicleMatches.length) return [];
    relevant = exactVehicleMatches;
  }

  return relevant.slice(0, 3).map(row => row.item);
}

// Keep a specific vehicle request tied to the same vehicle in every catalog
// path, including the live Shopify search fallback. This is a final guard in
// case the search provider returns broad results for a query such as
// "Chevrolet Corsa 2005 motor remanufacturado".
function filterStrictSprVehicleMatches(matches, query) {
  const normalized = normalizeSprCatalogText(query);
  const requestedYears = [...normalized.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
  const requestedPartPatterns = [
    // "motor" is also commonly supplied as an engine specification alongside
    // another requested part (for example, "amortiguador ... motor 4.6").
    // The dedicated motor matcher handles motor-only requests, so do not make
    // that specification a second hard part requirement here.
    /\b(?:cabeza|culata)(?:s)?\b/, /\bamortiguador(?:es)?\b/,
    /\bbieleta(?:s)?\b/, /\b(?:balero|maza|homocinetica)(?:s)?\b/,
    /\bcalavera(?:s)?\b/, /\bstop\b/, /\bfaro(?:s)?\b/, /\brejilla(?:s)?\b/,
    /\bespejo(?:s)?\b/, /\bfascia(?:s)?\b/, /\bguia(?:s)?\b/, /\bmoldura(?:s)?\b/,
    /\bdefensa(?:s)?\b/, /\bcofre\b/, /\bcajuela\b/, /\bsalpicadera(?:s)?\b/,
    /\bpuerta(?:s)?\b/, /\bradiador(?:es)?\b/, /\bbomba(?:s)?\b/, /\bturbo(?:s)?\b/,
    /\b(?:embrague|clutch)\b/, /\b(?:direccion|terminal|rotula)(?:es|s)?\b/
  ].filter(pattern => pattern.test(normalized));
  const qualifierPattern = /\b(remanufacturad[oa]s?|reconstruid[oa]s?|usad[oa]s?|nuev[oa]s?|complet[oa]s?|original(?:es)?|generico(?:s)?|generica(?:s)?)\b/g;
  const identityTokens = normalized
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(SPR_OPTIONAL_VEHICLE_WORDS_PATTERN, ' ')
    .replace(qualifierPattern, ' ')
    .replace(/\b(?:hola|holi|hey|hello|buen|buenos|buenas|dia|dias|vengo|spr|autopartes|asesoria|puedes|pueden|podrias|podrian|consultar|consulta|ayuda|ayudar|dime|tambien|porfa|porfavor|articulo|articulos|auto|carro|vehiculo|vehiculos|coche|camioneta|camion|cabina|cab|sencilla|doble|del|es|piloto|chofer|conductor|pasajero|manual|electrico|electrica|electricos|electricas|con|sin|abs|fwd|birlo|birlos|4x2|4x4|2wd|4wd|lado|frente|atras|principal|niebla|antiniebla)\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .split(/\s+/)
    .filter(token => (token.length >= 3 || (token.length >= 2 && /\d/.test(token))) && !['spr'].includes(token))
    .filter(token => !isSprEngineSpecificationToken(token));
  if (!identityTokens.length && !requestedYears.length) return matches;

  return matches.filter(item => {
    const haystack = canonicalizeSprPartSynonyms([item.normalizedTitle, normalizeBotText(item.vendor), normalizeBotText(item.productType), normalizeBotText(item.tags)].join(' '));
    // Preserve every concrete part named by the customer. This final guard is
    // intentionally independent of vehicle/year matching because the live
    // catalog search can return broad results for a model name.
    if (requestedPartPatterns.some(pattern => !pattern.test(haystack))) return false;
    if (!identityTokens.every(token => sprTokenMatches(haystack, token))) return false;
    if (!requestedYears.length) return true;
    const source = [item.title, item.description, item.tags].map(value => String(value || '')).join(' ');
    const explicitYears = [...source.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
    const ranges = [...source.matchAll(/\b((?:19|20)\d{2})\s*[-–/]\s*((?:19|20)\d{2})\b/g)]
      .map(match => [Number(match[1]), Number(match[2])]);
    return requestedYears.some(year => explicitYears.includes(year) || ranges.some(([start, end]) => year >= Math.min(start, end) && year <= Math.max(start, end)));
  });
}

// Public matcher used by the webhook and regression suite. Keep the strict
// pass first, then run the bounded investigative pass before declaring a miss.
function findSprEngineMatches(items, lowerText) {
  const strictMatches = findSprStrictMatches(items, lowerText);
  // Refine the broad strict batch with the complete piece/side/position/year
  // pass. Strict matching can return three related products before it knows
  // that "copiloto" means the right side; the exhaustive pass removes those
  // cross-side results while preserving the strict batch as a safe fallback.
  const refinedMatches = findSprExhaustiveMatches(items, lowerText, true);
  if (refinedMatches.length) return refinedMatches;
  const recoveryMatches = findSprCatalogRecoveryMatches(items, lowerText);
  if (recoveryMatches.length) return recoveryMatches;
  // Keep broad strict results only for non-specific catalog/category queries;
  // a concrete piece request with no verified candidate must reach the
  // non-denial fallback instead of showing an unrelated product.
  return SPR_EXPLICIT_PART_PATTERN.test(normalizeBotText(lowerText)) ? [] : strictMatches;
}

function sprTokenMatches(haystack, token) {
  const normalizedHaystack = normalizeBotText(haystack);
  const normalizedToken = normalizeBotText(token);
  if (!normalizedToken) return true;
  if (/^\d+$/.test(normalizedToken)) return new RegExp(`\\b${escapeSprRegex(normalizedToken)}\\b`).test(normalizedHaystack);
  if (normalizedHaystack.includes(normalizedToken)) return true;
  // Catalog titles often use Mitsubishi PU while customers say L200.
  if (normalizedToken === 'l200' && /\b(?:pu|l200)\b/.test(normalizedHaystack)) return true;
  if (normalizedToken.length < 5 || /\d/.test(normalizedToken)) return false;
  return normalizedHaystack.split(/\s+/).some(word => {
    if (word.length < 5 || Math.abs(word.length - normalizedToken.length) > 1) return false;
    let mismatches = 0;
    for (let index = 0; index < Math.max(word.length, normalizedToken.length); index += 1) {
      if (word[index] !== normalizedToken[index]) mismatches += 1;
    }
    return mismatches <= 1;
  });
}

function isSprEngineSpecificationToken(token) {
  return /^(?:m\d{2,4}|v\d|\d+(?:\.\d+)?l|\d+(?:\.\d+)?v|\d+cil|\d+[-/]\d+|\d+x\d+|t\d+)$/i.test(normalizeBotText(token));
}

// A second local pass prevents a single strict miss from becoming a false
// rejection. It preserves the requested category, vehicle, year and side,
// while tolerating one alphabetic typo and alternate word order.
function findSprExhaustiveMatches(items, query, skipExact = false) {
  const normalized = canonicalizeSprPartSynonyms(query);
  // Do not return the first broad strict batch here. It can contain multiple
  // sides or positions when the customer used colloquial terms such as
  // "copiloto". The exhaustive pass below applies the complete piece,
  // orientation and year filters before selecting the final three products.
  const partRules = [
    ['motor', /\b(?:motor|engine(?:\s+series)?)\b/], ['cabeza', /\b(?:cabeza|culata)\b/],
    ['amortiguador', /\bamortiguador\b/], ['bieleta', /\bbieleta\b/],
    ['balero', /\b(?:balero|maza|junta homocinetica)\b/], ['faro', /\bfaro\b/],
    ['rejilla', /\brejilla\b/],
    ['calavera', /\b(?:calavera|stop)\b/], ['espejo', /\bespejo\b/],
    ['fascia', /\bfascia\b/], ['guia', /\bguia\b/], ['moldura', /\bmoldura\b/],
    ['parrilla', /\bparrilla\b/], ['defensa', /\bdefensa\b/], ['cofre', /\bcofre\b/],
    ['cajuela', /\bcajuela\b/], ['puerta', /\bpuerta\b/], ['salpicadera', /\bsalpicadera\b/],
    ['radiador', /\bradiador\b/], ['bomba', /\bbomba\b/], ['turbo', /\bturbo\b/],
    ['embrague', /\bembrague\b/], ['direccion', /\b(?:direccion|caja de direccion)\b/],
    ['tornillo', /\btornillo\b/], ['terminal', /\bterminal\b/],
    ['rotula', /\brotula\b/]
  ];
  const matchingCategories = partRules.filter(([, pattern]) => pattern.test(normalized));
  const requestedCategory = matchingCategories.find(([key]) => key !== 'motor') || matchingCategories[0];
  const requiredPartPatterns = matchingCategories.filter(([key]) => key !== 'motor');
  const requestsSteeringRack = /\bcaja de direccion\b/.test(normalized);
  const wantsMotor = requestedCategory?.[0] === 'motor'
    && !/\b(?:cabeza|culata|soporte|base|taco|montura|mount|sensor|accesorio)\b/.test(normalized);
  const requestedYears = [...normalized.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
  const requestedSide = /\b(?:izquierdo|izquierda|piloto|chofer|conductor)\b/.test(normalized)
    ? 'left' : /\b(?:derecho|derecha|pasajero|copiloto)\b/.test(normalized) ? 'right' : '';
  const requestedPosition = /\b(?:delantero|delantera|frontal|delant)\b/.test(normalized)
    ? 'front' : /\b(?:trasero|trasera|posterior|tras)\b/.test(normalized) ? 'rear' : '';
  const asksFogLight = /\b(?:faro\s+de\s+)?(?:niebla|antiniebla)\b/.test(normalized)
    && !/\b(?:sin|no|evitar)\b(?:\s+\w+){0,8}\s+(?:faro\s+de\s+)?niebla\b/.test(normalized);
  const asksMainLight = !asksFogLight && /\b(?:faro|principal|delantero|delantera)\b/.test(normalized);
  const partWords = [...SPR_PART_SYNONYM_GROUPS.flatMap(group => [group.canonical, ...group.aliases]), 'motor', 'motores', 'cabeza', 'cabezas', 'culata', 'engine', 'series']
    .map(normalizeBotText).sort((a, b) => b.length - a.length);
  const partPattern = new RegExp(`\\b(?:${partWords.map(escapeSprRegex).join('|')})\\b`, 'gi');
  const hasEngineSpecifications = /\b(?:motor|4x[24]|\d+(?:\.\d+)?\s*v|\d+\s*cil)\b/.test(normalized);
  const coreTokens = normalized
    .replace(partPattern, ' ')
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(/\b(?:hola|holi|hey|hello|buen|buenos|buenas|dia|dias|vengo|spr|autopartes|asesoria|puedes|pueden|podrias|podrian|consultar|consulta|ayuda|ayudar|dime|tambien|porfa|porfavor|articulo|articulos|auto|carro|vehiculo|vehiculos|coche|camioneta|camion|cabina|cab|sencilla|doble|del|es|piloto|chofer|conductor|pasajero|manual|electrico|electrica|electricos|electricas|4x2|4x4|2wd|4wd|lado|frente|atras)\b/gi, ' ')
    .replace(SPR_OPTIONAL_VEHICLE_WORDS_PATTERN, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(?:delantero|delantera|delanteros|delanteras|trasero|trasera|traseros|traseras|izquierdo|izquierda|izquierdos|izquierdas|derecho|derecha|derechos|derechas|lado|frente|atras|principal|niebla|antiniebla|piloto|copiloto|chofer|conductor|pasajero|manual|electrico|electrica|electricos|electricas|hatchback|sedan|sedán|cabina|sencilla|doble|con|sin|abs|fwd|birlo|birlos)\b/gi, ' ')
    .split(/\s+/)
    .filter(token => (token.length >= 3 || /\d/.test(token)) && !isSprEngineSpecificationToken(token))
    .filter(token => !(hasEngineSpecifications && /^\d{1,2}$/.test(token)));
  const matchesYear = item => {
    if (!requestedYears.length) return true;
    const source = [item.title, item.description, item.tags].map(value => String(value || '')).join(' ');
    const years = [...source.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
    const ranges = [...source.matchAll(/\b((?:19|20)\d{2})\s*[-–/]\s*((?:19|20)\d{2})\b/g)].map(match => [Number(match[1]), Number(match[2])]);
    return requestedYears.some(year => years.includes(year) || ranges.some(([start, end]) => year >= Math.min(start, end) && year <= Math.max(start, end)));
  };
  return (Array.isArray(items) ? items : []).filter(item => {
    const haystack = canonicalizeSprPartSynonyms([item.normalizedTitle, item.title, item.vendor, item.productType, item.tags, item.description, item.handle].filter(Boolean).join(' '));
    if (requestedCategory && !requestedCategory[1].test(haystack)) return false;
    // When a customer names more than one concrete part (for example,
    // "faros antiniebla y rejillas"), every requested family must be present
    // in the same product. Matching only the vehicle is not sufficient.
    if (requiredPartPatterns.some(([, pattern]) => !pattern.test(haystack))) return false;
    // A steering-rack request must contain the rack/caja de dirección family
    // explicitly. Department tags containing only “dirección” are not a match.
    if (requestsSteeringRack && !/\bcaja de direccion\b/.test(haystack)) return false;
    if (coreTokens.length && !coreTokens.every(token => sprTokenMatches(haystack, token))) return false;
    if (!matchesYear(item)) return false;
    if (requestedCategory?.[0] === 'motor' && wantsMotor
      && (item.discountEligible !== true || /\b(?:cabeza|culata|soporte|base|taco|montura|mount|sensor|accesorio)\b/.test(haystack))) return false;
    if (requestedSide && !(/\bamb[oa]s(?:\s+lados?)?\b/.test(haystack) || (requestedSide === 'left' ? /\bizquierd[oa]\b/.test(haystack) : /\bderech[oa]\b/.test(haystack)))) return false;
    if (requestedPosition === 'front' && !/\b(?:delanter[oa]s?|frontal(?:es)?|delant)\b/.test(haystack) && !(requestedCategory?.[0] === 'faro' && !/\b(?:calavera|stop)\b/.test(haystack))) return false;
    if (requestedPosition === 'rear' && !/\b(?:traser[oa]s?|posterior(?:es)?|tras)\b/.test(haystack) && !/\b(?:calavera|stop|rear lamp)\b/.test(haystack)) return false;
    if (requestedCategory?.[0] === 'faro') {
      // "sin niebla" is the main headlamp variant, not a fog lamp. Keep it
      // eligible when the customer asks for a normal/main headlamp.
      const itemIsFog = /\b(?:niebla|antiniebla)\b/.test(haystack)
        && !/\bsin\s+(?:faro\s+de\s+)?niebla\b/.test(haystack);
      if (asksMainLight && /\bsin\s+(?:faro\s+de\s+)?niebla\b/.test(haystack)) return false;
      if (asksFogLight !== itemIsFog || (asksMainLight && itemIsFog)) return false;
    }
    if (requestedCategory?.[0] === 'motor' && !/\b(?:motor|engine(?:\s+series)?)\b/.test(haystack)) return false;
    return true;
  }).slice(0, 3);
}

// Last local recovery pass for a real catalog request. It is intentionally
// broader than the exact matcher, but it still requires the requested piece
// family and at least one vehicle token before returning a candidate. This is
// what keeps a typo, a different word order, or an omitted brand from turning
// into a false "no hay"/advisor response while avoiding unrelated products.
function findSprCatalogRecoveryMatches(items, query) {
  const sourceItems = Array.isArray(items) ? items.filter(item => item && item.title) : [];
  if (!sourceItems.length) return [];
  const normalized = canonicalizeSprPartSynonyms(query);
  const requestedYears = [...normalized.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
  const orientationWords = /\b(?:delantero|delantera|delanteros|delanteras|trasero|trasera|traseros|traseras|izquierdo|izquierda|izquierdos|izquierdas|derecho|derecha|derechos|derechas|lateral|laterales|lado|frente|atras|principal|niebla|antiniebla|piloto|chofer|conductor|pasajero|manual|electrico|electrica|electricos|electricas|con|sin|abs|fwd|birlo|birlos|hatchback|sedan|sedan|cabina|sencilla|doble)\b/gi;
  const partWords = [
    ...SPR_PART_SYNONYM_GROUPS.flatMap(group => [group.canonical, ...group.aliases]),
    'motor', 'motores', 'cabeza', 'cabezas', 'culata', 'radiador', 'bomba', 'bomba de agua',
    'turbo', 'embrague', 'clutch', 'freno', 'balata', 'pastilla', 'aceite', 'terminal',
    'rotula', 'parrilla', 'defensa', 'cofre', 'cajuela', 'puerta', 'manija', 'bisagra',
    'tolva', 'rejilla', 'salpicadera', 'carroceria', 'guia', 'moldura', 'claxon', 'bocina',
    'sensor', 'calefaccion', 'alternador', 'compresor', 'ventilador', 'evaporador', 'condensador'
  ].map(normalizeBotText).sort((a, b) => b.length - a.length);
  const partPattern = new RegExp(`\\b(?:${partWords.map(escapeSprRegex).join('|')})\\b`, 'gi');
  const requestedPartWords = [...new Set((normalized.match(partPattern) || []).map(value => normalizeBotText(value)))];
  const vehicleTokens = normalized
    .replace(partPattern, ' ')
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(orientationWords, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(token => (token.length >= 3 || /\d/.test(token)) && !isSprEngineSpecificationToken(token));
  if (!requestedPartWords.length || !vehicleTokens.length) return [];
  const requestedPartCanonicals = new Set(
    SPR_PART_SYNONYM_GROUPS
      .filter(group => group.aliases.some(alias => requestedPartWords.includes(normalizeBotText(alias))) || requestedPartWords.includes(group.canonical))
      .map(group => group.canonical)
  );
  const rows = sourceItems.map(item => {
    const haystack = canonicalizeSprPartSynonyms([
      item.normalizedTitle, item.title, item.vendor, item.productType, item.tags, item.description, item.handle
    ].filter(Boolean).join(' '));
    const partMatch = requestedPartCanonicals.size
      ? [...requestedPartCanonicals].some(part => haystack.includes(part))
      : requestedPartWords.some(part => haystack.includes(part));
    if (!partMatch) return null;
    const matchedVehicles = vehicleTokens.filter(token => sprTokenMatches(haystack, token));
    if (!matchedVehicles.length) return null;
    // Numeric model names such as "Mazda 3" must stay adjacent to their
    // make. A long title can also mention "MX-3" or "323"; counting the
    // digit alone would incorrectly rank those as the requested model.
    const numericModelPairs = [];
    for (let index = 1; index < vehicleTokens.length; index += 1) {
      if (/^\d+$/.test(vehicleTokens[index]) && /^[a-z][a-z0-9-]{2,}$/i.test(vehicleTokens[index - 1])) {
        numericModelPairs.push([vehicleTokens[index - 1], vehicleTokens[index]]);
      }
    }
    if (numericModelPairs.some(([makeOrModel, number]) => !new RegExp(`\\b${escapeSprRegex(makeOrModel)}\\s+${escapeSprRegex(number)}\\b`).test(haystack))) return null;
    const source = [item.title, item.description, item.tags].map(value => String(value || '')).join(' ');
    const explicitYears = [...source.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
    const ranges = [...source.matchAll(/\b((?:19|20)\d{2})\s*[-–/]\s*((?:19|20)\d{2})\b/g)]
      .map(match => [Number(match[1]), Number(match[2])]);
    const yearMatch = !requestedYears.length || requestedYears.some(year => explicitYears.includes(year) || ranges.some(([start, end]) => year >= Math.min(start, end) && year <= Math.max(start, end)));
    const requestedSides = normalized.match(/\b(?:izquierd[oa]|derech[oa])\b/g) || [];
    const requestedPositions = normalized.match(/\b(?:delanter[oa]|traser[oa])\b/g) || [];
    const orientationMatch = (!requestedSides.length || requestedSides.some(side => new RegExp(side.startsWith('izquier') ? 'izquierd[oa]' : 'derech[oa]').test(haystack)))
      && (!requestedPositions.length || requestedPositions.some(position => new RegExp(position.startsWith('delanter') ? 'delanter[oa]|frontal' : 'traser[oa]|posterior').test(haystack)));
    let score = (requestedPartCanonicals.size ? 40 : 28) + matchedVehicles.length * 12 + numericModelPairs.length * 20;
    if (yearMatch) score += 14;
    if (orientationMatch) score += 8;
    if (!yearMatch && requestedYears.length) score -= 8;
    return { item, score, matchedVehicles: matchedVehicles.length };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  const minimumVehicles = vehicleTokens.length >= 2 ? 2 : 1;
  return rows.filter(row => row.matchedVehicles >= minimumVehicles).slice(0, 3).map(row => row.item);
}

// Search Shopify with the useful vehicle and part terms instead of the full
// sentence. The catalog search is sensitive to filler words and trim details,
// while make/model, year, part and side are the terms that identify the item.
const SPR_SEARCH_FILLER_PATTERN = /\b(estoy|buscando|quiero|busco|necesito|ocupo|requiero|deseo|me|interesa|interesado|interesada|gustaria|dame|tienes|tienen|hay|para|una|uno|un|el|la|los|las|mi|mis|por|favor|que|qué|de|del|cotizacion|cotización|cotizar|precio|precios|cuanto|cuánto|cuesta|costo|disponible|disponibilidad|stock|modelo|año|ano|version|versión|hola|holi|hey|hello|buen|buenos|buenas|dia|dias|vengo|spr|autopartes|asesoria|puedes|pueden|podrias|podrian|consultar|consulta|ayuda|ayudar|dime|tambien|porfa|porfavor|articulo|articulos|producto|productos|refaccion|refacciones|auto|carro|vehiculo|vehiculos|coche|camioneta|camion|cabina|sencilla|doble)\b/gi;

function buildSprFocusedSearchQuery(value) {
  const normalized = normalizeSprCatalogText(value);
  const focused = normalized
    .replace(SPR_SEARCH_FILLER_PATTERN, ' ')
    .replace(SPR_OPTIONAL_VEHICLE_WORDS_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return focused || normalized;
}

// Shopify's search endpoint is sensitive to sentence order. Generate a small,
// bounded set of keyword-only queries so the second pass can try the piece and
// vehicle in both orders without sending the customer's whole paragraph.
function buildSprCatalogSearchQueries(value) {
  const normalized = canonicalizeSprPartSynonyms(value);
  const focused = buildSprFocusedSearchQuery(value);
  const partGroups = SPR_PART_SYNONYM_GROUPS.filter(group => {
    const aliases = group.aliases.map(alias => normalizeBotText(alias));
    return aliases.some(alias => new RegExp(`\\b${escapeSprRegex(alias)}\\b`, 'i').test(normalized));
  });
  const allPartTerms = partGroups
    .flatMap(group => [group.canonical, ...group.aliases])
    .map(term => normalizeBotText(term))
    .sort((a, b) => b.length - a.length);
  const partPattern = allPartTerms.length
    ? new RegExp(`\\b(?:${allPartTerms.map(escapeSprRegex).join('|')})\\b`, 'gi')
    : /$^/;
  const vehicleText = focused
    .replace(partPattern, ' ')
    .replace(/\b(?:delantero|delantera|delanteros|delanteras|trasero|trasera|traseros|traseras|izquierdo|izquierda|izquierdos|izquierdas|derecho|derecha|derechos|derechas|lado|frente|atras|principal|niebla|antiniebla|piloto|chofer|conductor|pasajero|manual|electrico|electrica|electricos|electricas|con|sin|abs|fwd|birlo|birlos|es)\b/gi, ' ')
    .replace(SPR_OPTIONAL_VEHICLE_WORDS_PATTERN, ' ')
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const queries = [focused, normalized];
  if (vehicleText && partGroups.length) {
    for (const group of partGroups) {
      const terms = [...new Set([group.canonical, ...group.aliases.map(alias => normalizeBotText(alias))])].slice(0, 6);
      for (const term of terms) {
        queries.push(`${term} ${vehicleText}`);
        queries.push(`${vehicleText} ${term}`);
      }
    }
  }
  if (vehicleText) queries.push(vehicleText);
  if (/\b(?:tornillo|tornillo\s+estabilizador|estabilizador|cacahuate|cachahuate|cachuate|cahuate|cacuate)\b/i.test(normalizeBotText(value))) {
    queries.push(`tornillo estabilizador ${vehicleText}`.trim(), `${vehicleText} tornillo estabilizador`.trim());
  }
  return [...new Set(queries.map(query => String(query || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 16);
}

// Query SPR's official search endpoint with bounded canonical variants.
// The local export is intentionally not used: prices, links and new products
// must come from the live SPR website on every cache refresh.
async function searchSprCatalogExhaustively(catalogItems, query) {
  const merged = new Map();
  for (const item of Array.isArray(catalogItems) ? catalogItems : []) {
    const key = item.id || item.url || item.handle || item.title;
    if (key) merged.set(String(key), item);
  }
  const queries = buildSprCatalogSearchQueries(query);
  const results = await Promise.allSettled(queries.map(searchQuery => searchSprCatalog(searchQuery)));
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value || []) {
      const key = item.id || item.url || item.handle || item.title;
      if (key && !merged.has(String(key))) merged.set(String(key), item);
    }
  }
  const items = [...merged.values()];
  let matches = filterStrictSprVehicleMatches(findSprEngineMatches(items, query), query);
  if (!matches.length) matches = findSprExhaustiveMatches(items, query);
  return { items, matches, queries };
}

// A short follow-up such as "delantero" or "izquierdo" is a refinement of
// the customer's previous catalog request. Keep the vehicle and part from
// that previous turn so a side/orientation answer cannot jump to another
// make or model.
const SPR_CATALOG_CONTEXT_PATTERN = /\b(motor(?:es)?|cabeza(?:s)?|culata|engine series|amortiguador(?:es)?|suspensi[oó]n|bieleta(?:s)?|balero(?:s)?|maza(?:s)?|homocin[eé]tica(?:s)?|freno(?:s)?|balata(?:s)?|pastilla(?:s)?|aceite|anticongelante|refrigerante|coolant|lubricante|aditivo|liquido(?:s)?|buj[ií]a(?:s)?|bater[ií]a(?:s)?|filtro(?:s)?|llanta(?:s)?|neum[aá]tico(?:s)?|rin(?:es)?|birlo(?:s)?|plumilla(?:s)?|escobilla(?:s)?|fusible(?:s)?|foco(?:s)?|refacci[oó]n(?:es)?|pieza(?:s)?|producto(?:s)?|direcci[oó]n|caja de direcci[oó]n|cremallera(?:s)?|rack(?:\s+and)?\s+pinion|radiador|bomba|turbo|embrague|clutch|soporte|terminal|r[oó]tula|faro(?:s)?|calavera(?:s)?|stop|l[aá]mpara(?:s)?|luz|luces|espejo(?:s)?|gu[ií]a(?:s)?|fascia(?:s)?|moldura(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|cajuela|puerta(?:s)?|manija(?:s)?|bisagra(?:s)?|tolva(?:s)?|rejilla(?:s)?|salpicadera(?:s)?|carrocer[ií]a)\b/;
const SPR_CATALOG_REFINEMENT_PATTERN = /\b(delantero|delantera|delanteros|delanteras|trasero|trasera|traseros|traseras|izquierdo|izquierda|izquierdos|izquierdas|derecho|derecha|derechos|derechas|lateral|laterales|lado|frente|atr[aá]s|modelo|a[nñ]o|versi[oó]n|principal|niebla|antiniebla|motor)\b/;

// Do not guess a vehicle from a generic part request. Ask for the vehicle
// before searching so the bot cannot return an unrelated make or model.
const SPR_CATALOG_GENERIC_WORDS_PATTERN = /\b(estoy|buscando|quiero|busco|necesito|ocupo|requiero|deseo|interesa|interesado|interesada|gustaria|dame|tienes|tienen|hay|para|una|uno|un|el|la|los|las|mi|mis|que|qué|por|favor|de|precio|precios|cuanto|cu[aá]nto|cuesta|costo|cotizacion|cotizaci[oó]n|cotizar|comprar|compra|nuevo|nueva|disponible|disponibilidad|stock|catalogo|cat[aá]logo|producto|productos|pieza|piezas|refaccion|refacciones|motor|motores|cabeza|cabezas|culata|engine|series|amortiguador|amortiguadores|suspension|bieleta|bieletas|balero|baleros|maza|mazas|homocinetica|homocineticas|freno|frenos|balata|balatas|pastilla|pastillas|aceite|lubricante|lubricantes|direccion|terminal|terminales|rotula|rotulas|radiador|radiadores|bomba|bombas|turbo|turbos|embrague|clutch|soporte|soportes|faro|faros|niebla|antiniebla|principal|calavera|calaveras|lampara|lamparas|luz|luces|espejo|espejos|guia|guias|fascia|fascias|moldura|molduras|parrilla|parrillas|defensa|defensas|cofre|cajuela|puerta|puertas|manija|manijas|bisagra|bisagras|tolva|tolvas|rejilla|rejillas|salpicadera|salpicaderas|carroceria|delantero|delantera|delanteros|delanteras|trasero|trasera|traseros|traseras|izquierdo|izquierda|izquierdos|izquierdas|derecho|derecha|derechos|derechas|lateral|laterales|lado|frente|atras|modelo|ano|version|auto|carro|vehiculo|vehiculos|coche|camioneta|camion|camiones|completo|completa|todo|toda|todos|todas|no|sin|evitar|ningun|ninguna)\b/gi;
const SPR_VEHICLE_MAKES = new Set(['nissan', 'ford', 'chevrolet', 'chevy', 'volkswagen', 'vw', 'toyota', 'honda', 'kia', 'hyundai', 'dodge', 'chrysler', 'jeep', 'mazda', 'mitsubishi', 'suzuki', 'seat', 'renault', 'peugeot', 'fiat', 'ram', 'gmc', 'volvo', 'audi', 'bmw', 'mercedes', 'mercedesbenz', 'isuzu', 'subaru', 'lincoln', 'cadillac', 'buick', 'acura', 'infiniti', 'lexus', 'porsche', 'mg', 'byd']);

function hasSprVehicleReference(value) {
  const normalized = normalizeBotText(value)
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(/\b(?:remanufacturad[oa]s?|reconstruid[oa]s?|usad[oa]s?|nuev[oa]s?|complet[oa]s?|original(?:es)?|generico(?:s)?|generica(?:s)?)\b/g, ' ');
  const vehicleTokens = normalized.split(/\s+/).filter(token => token.length >= 2);
  if (!vehicleTokens.length || vehicleTokens.every(token => SPR_VEHICLE_MAKES.has(token))) return false;
  return true;
}

// A vehicle profile can arrive in separate customer turns (for example,
// "Marca: Nissan", then "Modelo: Versa", then "Año: 2017"). Keep that
// structured tail together so the next piece request can use the complete
// profile instead of falling through to advisor review.
function getSprStructuredVehicleContext(previousMessages) {
  const previous = Array.isArray(previousMessages) ? previousMessages : [];
  const context = [];
  let collecting = false;
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const value = String(previous[index] || '').trim();
    if (!value) continue;
    const details = extractSprVehicleDetails(value);
    const hasVehicleField = ['marca', 'modelo', 'ano'].some(key => details[key]);
    if (hasVehicleField) {
      context.unshift(value);
      collecting = true;
      continue;
    }
    // Courtesy or greeting turns do not invalidate a vehicle profile.
    if (collecting && (isFriendlyGreetingText(value) || isCourtesyText(value))) continue;
    if (collecting) break;
  }
  return context.join(' ').replace(/\s+/g, ' ').trim();
}

function isAmbiguousSprCatalogRequest(value) {
  const normalized = normalizeBotText(value);
  return SPR_CATALOG_CONTEXT_PATTERN.test(normalized) && !hasSprVehicleReference(normalized);
}

// Keep the follow-up flow open even when a piece is new or is not yet in the
// synonym list (for example, "claxon" or "bomba de agua"). This fallback is
// used only after a vehicle context exists, so greetings and advisor commands
// cannot become unrelated catalog searches.
function isSprLikelyPieceFollowUp(value) {
  const query = canonicalizeSprPartSynonyms(value);
  if (!query || isFriendlyGreetingText(query) || isCourtesyText(query)) return false;
  if (/\b(?:asesor|humano|persona|agente|horario|envio|envios|ubicacion|direccion|garantia|pago|pagos|gracias|ok|okay|listo|recibido)\b/.test(query)) return false;
    const hasKnownPart = /\b(?:base de amortiguador|junta homocinetica|caja de direccion|soporte de motor|amortiguador|bieleta|terminal|rotula|balero|maza|flecha|faro|calavera|fascia|espejo|embrague|tornillo)\b/.test(query); if (hasKnownPart) return true; const residual = query
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return residual.split(' ').some(token => token.length >= 3);
}

function buildSprCatalogContext(previousCustomerMessages, currentMessage) {
  const current = String(currentMessage || '').trim();
  const previous = (Array.isArray(previousCustomerMessages) ? previousCustomerMessages : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const currentNormalized = normalizeBotText(current);
  const previousNormalized = normalizeBotText(previous.join(' '));
  const isFollowUpRefinement = SPR_CATALOG_REFINEMENT_PATTERN.test(currentNormalized)
    && !SPR_CATALOG_CONTEXT_PATTERN.test(currentNormalized.replace(/\b(delantero|delantera|trasero|trasera|izquierdo|izquierda|derecho|derecha|lado|frente|atr[aá]s|modelo|a[nñ]o|versi[oó]n|principal|niebla|antiniebla)\b/g, ''));

  const previousCatalogMessage = [...previous].reverse().find(value => {
    const normalized = normalizeBotText(value);
    return SPR_CATALOG_CONTEXT_PATTERN.test(normalized) && hasSprVehicleReference(normalized);
  });
  const previousVehicleMessage = [...previous].reverse().find(value => {
    const normalized = normalizeBotText(value);
    const labeledDetails = extractSprVehicleDetails(value);
    const isSingleLabeledVehicleField = Object.keys(labeledDetails).length === 1
      && ['marca', 'modelo', 'ano'].some(key => labeledDetails[key]);
    return hasSprVehicleReference(normalized)
      && !isSingleLabeledVehicleField
      && (/\b(?:19|20)\d{2}\b/.test(normalized) || [...SPR_VEHICLE_MAKES].some(make => new RegExp(`\\b${escapeSprRegex(make)}\\b`, 'i').test(normalized)));
  });
  const previousStructuredVehicleContext = getSprStructuredVehicleContext(previous); const previousVehicleIndex = previousVehicleMessage ? previous.lastIndexOf(previousVehicleMessage) : -1; const previousStructuredVehicleIndex = previous.reduce((latest, value, index) => { const details = extractSprVehicleDetails(value); return ['marca', 'modelo', 'ano'].some(key => details[key]) ? index : latest; }, -1); const latestVehicleContext = previousStructuredVehicleIndex > previousVehicleIndex ? previousStructuredVehicleContext : previousVehicleMessage;
  const currentHasVehicle = hasSprVehicleReference(currentNormalized);
  const currentHasCatalogTerm = SPR_CATALOG_CONTEXT_PATTERN.test(currentNormalized)
    || SPR_CATALOG_REFINEMENT_PATTERN.test(currentNormalized)
    || isFollowUpRefinement
    || isSprLikelyPieceFollowUp(currentNormalized);
  const currentCanUsePreviousVehicle = currentHasCatalogTerm
    && !currentHasVehicle;

  if (latestVehicleContext && currentCanUsePreviousVehicle) return latestVehicleContext + ' ' + current; // Keep the latest vehicle profile for subsequent pieces.
  // (for example: "faro de Versa 2017" -> "quiero el faro principal").
  if (previousCatalogMessage && currentCanUsePreviousVehicle) {
    return previousCatalogMessage + ' ' + current;
  }

  // The first turn may contain only a model/year (for example, "Sentra
  // 2018"), followed by the actual piece. Preserve that vehicle context so
  // "faro derecho" becomes a searchable request instead of a dead end.
  if (previousVehicleMessage && currentCanUsePreviousVehicle) {
    return previousVehicleMessage + ' ' + current;
  }

  if (previousStructuredVehicleContext && currentCanUsePreviousVehicle) {
    return previousStructuredVehicleContext + ' ' + current;
  }

  if (previous.length && isFollowUpRefinement && SPR_CATALOG_CONTEXT_PATTERN.test(previousNormalized)) {
    return previous.slice(-4).join(' ') + ' ' + current;
  }
  return current;
}

function isGenericSprCatalogRequest(lowerText) {
  const query = normalizeBotText(lowerText);
  const asksGeneral = /\b(que productos|que tienen|que hay|catalogo|catalog|refacciones|productos|todo|completo)\b/.test(query);
  const asksSpecific = /\b(motor(?:es)?|cabeza(?:s)?|culata|amortiguador(?:es)?|suspension|freno(?:s)?|balata(?:s)?|pastilla(?:s)?|aceite(?:s)?|refaccion(?:es)?|pieza(?:s)?|direccion|radiador(?:es)?|bomba(?:s)?|turbo(?:s)?|embrague(?:s)?|clutch|soporte(?:s)?|terminal(?:es)?|rotula(?:s)?|faro(?:s)?|calavera(?:s)?|lampara(?:s)?|luz|luces|espejo(?:s)?|guia(?:s)?|fascia(?:s)?|moldura(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|salpicadera(?:s)?|carroceria)\b/.test(query);
  return asksGeneral && !asksSpecific;
}

function isIncompleteSprCatalogRequest(value) {
  const query = canonicalizeSprPartSynonyms(value);
  if (SPR_CATALOG_CONTEXT_PATTERN.test(query)) return false;
  return /\b(precio|precios|cuanto|cuesta|costo|cotizacion|cotizar|cotiza|disponible|disponibilidad|stock|delantero|delantera|trasero|trasera|izquierdo|izquierda|derecho|derecha|lado|principal|niebla|antiniebla)\b/.test(query);
}

// A concrete SPR request that survives the complete catalog/search pass but
// has no confirmed product must go to an advisor. It must not fall back to a
// repeated request for the same vehicle fields.
function shouldRouteSprCatalogToAdvisor({
  isSprAutopartesTenant = false,
  asksCatalogProduct = false,
  sprCatalogMatched = false,
  missingRequestReply = '',
  query = '',
  yearConfirmationReply = ''
} = {}) {
  return Boolean(
    isSprAutopartesTenant
    && asksCatalogProduct
    && !sprCatalogMatched
    && !String(missingRequestReply || '').trim()
    && !String(yearConfirmationReply || '').trim()
    && !isGenericSprCatalogRequest(query)
  );
}

function getSprMissingRequestFields(value) {
  const query = canonicalizeSprPartSynonyms(value);
  // Greetings and courtesy are conversational turns, never incomplete vehicle
  // profiles. Keep them ahead of catalog heuristics so "Hola" cannot be
  // treated as a model that is missing a piece, brand, or year.
  if (isFriendlyGreetingText(query) || isCourtesyText(query)) return [];
  if (isUnlistedSprProductRequest(query) && !SPR_CATALOG_CONTEXT_PATTERN.test(query)) return [];
  const hasPart = hasSprExplicitPartRequest(query);
  const hasMake = [...SPR_VEHICLE_MAKES].some(make => new RegExp(`\\b${escapeSprRegex(make)}\\b`, 'i').test(query));
  const hasYear = /\b(?:19|20)\d{2}\b/.test(query);
  const hasModel = hasSprVehicleReference(query);
  const hasVehicleClue = hasMake || hasModel || hasYear;
  if (!hasVehicleClue) return [];
  // A customer can name a part that is not yet in the synonym list. Treat it
  // as a piece when there are at least two non-vehicle words, while keeping a
  // bare "SENTRA 2018" (or "Nissan Versa 2020") as an incomplete vehicle.
  const unlistedPartResidual = query
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(new RegExp(`\\b(?:${[...SPR_VEHICLE_MAKES].map(escapeSprRegex).join('|')})\\b`, 'gi'), ' ')
    .replace(/\b(?:marca|modelo|ano|año|version|versi[oó]n|auto|carro|vehiculo|vehiculos|coche|camioneta|camion|hatchback|sedan|sedán|cabina|sencilla|doble)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(token => token.length >= 3);
  const hasUnlistedPart = !hasPart
    && hasVehicleClue
    && unlistedPartResidual.length >= 2
    && isSprLikelyPieceFollowUp(query);
  const effectiveHasPart = hasPart || hasUnlistedPart;
  // A piece plus model and year is enough to attempt the catalog lookup. The
  // make can be confirmed from the catalog (for example, "Sentra" implies
  // the Nissan family in the supplied catalog); only ask for it after a
  // failed search, rather than ending the conversation before searching.
  if (effectiveHasPart && hasModel && hasYear) return [];
  const missing = [];
  if (!effectiveHasPart) missing.push('pieza');
  if (!hasMake) missing.push('marca');
  if (!hasModel) missing.push('modelo');
  if (!hasYear) missing.push('año');
  return missing;
}

function buildSprMissingRequestReply(missingFields, source = '') {
  const fields = Array.isArray(missingFields) ? missingFields.filter(Boolean) : [];
  if (!fields.length) return '';
  const readable = fields.length === 1
    ? fields[0]
    : `${fields.slice(0, -1).join(', ')} y ${fields[fields.length - 1]}`;
  const vehicleHint = normalizeBotText(source)
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const intro = vehicleHint
    ? `✅ Ya tengo registrado: *${vehicleHint.toUpperCase()}*.`
    : '✅ Ya recibí parte de los datos.';
  const directQuestion = fields.includes('pieza') && fields.includes('marca')
    ? '¿Qué pieza necesitas y de qué marca es?'
    : fields.includes('pieza')
      ? '¿Qué pieza necesitas?'
      : `¿Me compartes ${readable}?`;
  return `${intro}
${directQuestion}


Para afinar compatibilidad y darte la cotización con *precio, foto y enlace*, compárteme: *${readable}*.

Si no conoces alguno, describe la pieza con tus propias palabras y revisaré las opciones relacionadas.


`;
}

// Once a conversation is handed to an advisor, a short acknowledgement such
// as "gracias" must stay with the human. A new catalog request or a concrete
// FAQ question is the explicit signal that the customer wants the bot again.
function isSprNewRequestOrQuestion(value) {
  const raw = String(value || '');
  const query = canonicalizeSprPartSynonyms(raw);
  if (!query) return false;
  if (isFriendlyGreetingText(query)) return true;
  const hasQuestion = /[?¿]/.test(raw)
    && /\b(horario|envio|envios|ubicacion|direccion|garantia|precio|precios|disponible|existencia|stock|catalogo|producto|pieza|refaccion|asesor|compatibilidad)\b/.test(query);
  if (hasQuestion) return true;
  if (isCourtesyText(query)) return false;
  if (/^(ok|okay|listo|recibido|entendido)\b/.test(query)
    || /\b(?:el|la) asesor(?:a)?\b.*\b(?:ya me atendio|me atendio|me ayudo)\b/.test(query)) return false;
  // Once an SPR conversation has been paused, every non-courtesy customer
  // message is a fresh turn for the bot. Unknown wording must still receive
  // the catalog prompt instead of leaving the customer with no reply.
  return true;
}

function buildSprAdvisorReviewReply(customerName = '') {
  const name = String(customerName || '').trim();
  return `Gracias${name ? `, ${name}` : ''}. Voy a pasar tu solicitud con un asesor para verificar la pieza, compatibilidad y existencia directamente. Las respuestas automáticas quedan pausadas mientras la revisa. 👨‍💼`;
}

// Route purchase questions about an unknown automotive item through the SPR
// catalog so a likely product request gets a focused lookup before any human
// review. An empty result is handled by the silent advisor-review policy below.
function isUnlistedSprProductRequest(value) {
  const query = normalizeBotText(value);
  const purchaseIntent = /\b(busco|buscando|necesito|ocupo|quiero|tienen|tendrian|tendran|hay|venden|manejan|consiguen|cotizar|cotizacion)\b/.test(query);
  const automotiveContext = /\b(carro|auto|vehiculo|coche|tienda|refaccion|refacciones|pieza|producto|articulo|accesorio|rayon|rayones|compatibilidad)\b/.test(query);
  if (!purchaseIntent || !automotiveContext || SPR_CATALOG_CONTEXT_PATTERN.test(query)) return false;
        const residual = query
    .replace(SPR_CATALOG_GENERIC_WORDS_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return residual.split(' ').filter(token => token.length >= 3).length >= 1;
}

function buildSprCatalogFallbackReply(value) {
  const request = String(value || '').replace(/\s+/g, ' ').trim();
  const requestLine = request ? `\n📋 Solicitud recibida: *${request}*.` : '';
  return `🛠️ *Catálogo de SPR Autopartes*${requestLine}

Para darte la pieza correcta con *precio, foto y enlace*, necesito que la solicitud incluya pieza, marca, modelo y año en una sola línea.
Ejemplo: *faro derecho Nissan Versa 2017*.

También puedes describir la pieza con tus propias palabras; tomaré los términos equivalentes y las variantes del catálogo.`;
}

function buildSprCatalogReply(matches, lowerText, catalogItems = [], stockResult = null) {
  const safeMatches = Array.isArray(matches) ? matches : [];
  // A concrete catalog match always wins. Do not let a word such as
  // "delantera", "precio" or "disponible" send a valid request back to the
  // data-capture prompt after the matcher already found products.
  if (safeMatches.length) {
    const lines = ['🛠️ *Catálogo de SPR Autopartes*', '', 'Encontré estas opciones relacionadas:'];
    for (const item of safeMatches) {
      lines.push('', '🛒 *' + item.title + '*');
      if (item.hasSeptemberOffer) {
        lines.push('💰 Precio normal: ~' + formatSprMoney(item.regularPrice) + '~');
        lines.push('🔥 *Precio especial exclusivo de septiembre: ' + formatSprMoney(item.offerPrice) + '* (-' + SPR_SEPTEMBER_DISCOUNT_PERCENT + '%)');
      } else {
        lines.push('💰 Precio normal: *' + formatSprMoney(item.regularPrice || item.offerPrice) + '*');
      }
      const stockLine = stockResult?.status === 'in_stock'
        ? '✅ Disponible para cotización'
        : '🔎 Disponibilidad por confirmar';
      lines.push(stockLine);
      // Shopify exports may include a direct image. When they do not, the
      // product page is still sent with link previews enabled, so WhatsApp can
      // display the product photo from the page metadata.
      lines.push('🖼️ Foto y detalles: ' + (item.image || item.url));
      lines.push('🔗 ' + item.url);
    }
    lines.push('', '¿Quieres que revisemos compatibilidad con tu vehículo o buscar otra pieza?');
    return lines.join('\n');
  }
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
    return '🛠️ *Catálogo de SPR Autopartes*\n\nContamos con refacciones para diferentes marcas y modelos:\n\n' + categoryLines + '\n\nPara revisar una pieza exacta, escríbeme *solo estos cuatro datos*: pieza, marca, modelo y año.\n🔧 Pieza\n🚗 Marca\n🚙 Modelo\n📅 Año\n\nEjemplo: *amortiguador Nissan Versa 2015*.';
  }
  if (isAmbiguousSprCatalogRequest(lowerText)) {
    return '🛠️ *Catálogo de SPR Autopartes*\n\nPara buscar correctamente, escríbeme *solo estos cuatro datos*: pieza, marca, modelo y año.\n🔧 Pieza\n🚗 Marca\n🚙 Modelo\n📅 Año\n\nEjemplo: *faro derecho Nissan Versa 2015*.';
  }
  if (isIncompleteSprCatalogRequest(lowerText)) {
    return '🔎 Para preparar una cotización necesito *solo estos cuatro datos*: pieza, marca, modelo y año.\nEjemplo: *amortiguador Nissan Versa 2015*.';
  }
  return buildSprCatalogFallbackReply(lowerText);
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
 * 1. Strictly look up by phone_number_id. If duplicate records belong to the
 *    same company, choose the active/verified record instead of dropping the
 *    customer's message. Reject only a true cross-tenant collision.
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
      .limit(20)
      .get();
    if (!snapByPhone.empty) {
      let candidateDocs = snapByPhone.docs;
      if (candidateDocs.length > 1) {
        const companyIds = [...new Set(candidateDocs
          .map(doc => String(doc.data()?.company_id || '').trim())
          .filter(Boolean))];
        if (companyIds.length > 1) {
          console.error(`🛑 [Cross-tenant Phone Number ID: ${phoneNumberId}] ${candidateDocs.length} integrations belong to ${companyIds.length} companies. Rejecting the webhook to prevent cross-tenant delivery.`);
          return null;
        }
        const scoreIntegration = doc => {
          const data = doc.data() || {};
          const status = String(data.status || '').toLowerCase();
          return (status === 'connected' ? 1000000 : 0)
            + (data.webhook_verified === true ? 100000 : 0)
            + (data.outbound_verified === true ? 10000 : 0)
            + (data.provider === 'whatsapp' ? 1000 : 0)
            + (timestampMs(data.updated_at) / 1e12);
        };
        candidateDocs = candidateDocs.slice().sort((a, b) => scoreIntegration(b) - scoreIntegration(a));
        console.warn(`⚠️ [Duplicate Phone Number ID: ${phoneNumberId}] ${candidateDocs.length} same-company records found; using active/verified integration ${candidateDocs[0].id}.`);
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

  return {    companyId,    intDocId,
    intDoc,
    accessToken
  };
}

/**
 * Resolve the outbound WhatsApp credential for a company without assuming
 * that the first Firestore integration document is the active one. Companies
 * can retain old, disconnected or test integrations after reconnecting Meta.
 * Prefer the conversation's phone number when available, then a connected
 * and verified integration that actually has a token.
 */
async function resolveOutboundTenant(dbInstance, companyId, preferredPhoneNumberId = null) {
  if (!dbInstance || !companyId) return null;
  // Keep this lookup to one equality filter.  The previous compound
  // company_id + provider query required a Firestore composite index that
  // may not be deployed yet, which made an otherwise valid CRM send fail
  // before it ever reached Meta.  Filter provider in memory instead.
  const snap = await dbInstance.collection('integrations')
    .where('company_id', '==', String(companyId))
    .limit(50)
    .get();
  if (snap.empty) return null;

  const candidates = [];
  for (const doc of snap.docs) {
    const intData = doc.data() || {};
    if (String(intData.provider || '').toLowerCase() !== 'whatsapp') continue;
    const phoneNumberId = String(intData.phone_number_id || '').trim();
    if (!phoneNumberId) continue;
    let accessToken = null;
    try {
      const secDoc = await dbInstance.doc(`integrations/${doc.id}/secrets/tokens`).get();
      accessToken = secDoc.exists ? String(secDoc.data()?.access_token || '').trim() : null;
    } catch (secretError) {
      console.warn(`Could not read outbound token for ${doc.id}:`, secretError.message);
    }
    if (!accessToken) continue;

    const status = String(intData.status || '').toLowerCase();
    const verifiedAt = timestampMs(intData.last_verified_at);
    const updatedAt = timestampMs(intData.updated_at);
    const isPreferred = preferredPhoneNumberId && phoneNumberId === String(preferredPhoneNumberId).trim();
    const isUsablePreferred = isPreferred && (status === 'connected' || intData.outbound_verified === true);
    const isDisconnected = ['disconnected', 'disabled', 'revoked', 'expired'].includes(status);
    const score =
      // A conversation's old Phone Number ID is only a tie-breaker when the
      // integration is still verified.  A stale/disconnected record must
      // never outrank the company's active connection.
      (isUsablePreferred ? 1000 : 0)
      + (status === 'connected' ? 100000 : 0)
      + (intData.outbound_verified === true ? 10000 : 0)
      + (intData.webhook_verified === true ? 5000 : 0)
      + (isDisconnected ? -1000000 : 0)
      + verifiedAt / 1e12
      + updatedAt / 1e15;
    candidates.push({ score, intDocId: doc.id, intDoc: intData, phoneNumberId, accessToken });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function mergeBufferedDeliveryStatus(dbInstance, externalMessageId, messageRef) {
  if (!dbInstance || !externalMessageId || !messageRef) return null;
  try {
    const statusSnap = await dbInstance.doc(`whatsapp_delivery_status/${externalMessageId}`).get();
    if (!statusSnap.exists) return null;
    const statusData = statusSnap.data() || {};
    const patch = {
      delivery_status: statusData.delivery_status || statusData.whatsapp_status || 'accepted',
      whatsapp_status: statusData.whatsapp_status || statusData.delivery_status || 'accepted',
      delivery_status_updated_at: statusData.delivery_status_updated_at || statusData.updated_at || new Date().toISOString()
    };
    if (statusData.error_message) patch.error_message = statusData.error_message;
    if (statusData.whatsapp_error_code) patch.whatsapp_error_code = statusData.whatsapp_error_code;
    await messageRef.set(patch, { merge: true });
    return patch;
  } catch (statusError) {
    console.warn(`Could not merge buffered delivery status for ${externalMessageId}:`, statusError.message);
    return null;
  }
}

// WhatsApp media messages carry the binary file behind a short-lived Meta
// media id. Keep the id and its metadata in Firestore; the CRM media route
// below fetches the binary with the tenant's token when the conversation is
// opened, so no Meta access token is ever exposed to the browser.
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

/**
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

app.get('/version', (req, res) => {
  res.json({
    git_commit: process.env.RENDER_GIT_COMMIT || 'unknown',
    started_at: SERVER_STARTED_AT
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    server_time: new Date().toISOString(),
    graph_api_version: GRAPH_API_VERSION,
    signature_verification: !!META_APP_SECRET ? 'enforced' : 'optional',
    database: db ? 'firebase_admin_authenticated' : 'uninitialized',
    spr_bot_active: SPR_BOT_ACTIVE,
    spr_bot_pause_control: 'SPR_BOT_ACTIVE=false'
  });
});

/**
 * Stream an inbound WhatsApp attachment to the CRM without exposing the
 * tenant's Meta access token. The message record supplies the phone number
 * that owns the media id, which keeps this endpoint tenant-aware.
 */
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
 * GET /webhook/whatsapp
 */
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && (token === MASTER_VERIFY_TOKEN || (token && token.startsWith('dt_')))) {
    console.log('✅ Meta Webhook verification handshake successful.');
    logWebhookEvent({}, 'procesado', 'handshake de verificación aceptado', { tipo_evento: 'verificacion' });
    return res.status(200).send(challenge);
  }

  console.warn('❌ Meta Webhook verification rejected. Invalid Verify Token.');
  logWebhookEvent({}, 'descartado', 'token de verificación inválido', { tipo_evento: 'verificacion' });
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
    logWebhookEvent(req.body?.entry?.[0]?.changes?.[0]?.value, 'descartado', 'firma HMAC-SHA256 inválida');
    return res.status(401).send('Unauthorized: Invalid Signature');
  }

  // Acknowledge Meta immediately with HTTP 200
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (!body || body.object !== 'whatsapp_business_account') {
      logWebhookEvent(body?.entry?.[0]?.changes?.[0]?.value, 'descartado', 'payload vacío o object distinto de whatsapp_business_account');
      return;
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    logWebhookEvent(value, 'recibido', 'firma validada; inicio de procesamiento');

    // Meta sends delivery/read/failure updates in a separate webhook event.
    // Persist them immediately so the CRM never presents an accepted request as delivered.
    const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
    if (statuses.length > 0) {
      if (!db) {
        logWebhookEvent(value, 'descartado', 'base de datos no inicializada; no se pudo procesar el estado ni el mensaje');
        return;
      }
      for (const statusEvent of statuses) {
        const externalId = String(statusEvent.id || '').trim();
        const rawStatus = String(statusEvent.status || '').trim().toLowerCase();
        if (!externalId || !rawStatus) {
          logWebhookEvent(value, 'descartado', 'estado sin id de mensaje o sin status');
          continue;
        }
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
        if (firstError) {
          void sendAlertEmail({
            subject: '[WhatsApp] Meta reportó un error de entrega',
            text: [
              'Meta reportó un error al entregar un mensaje de WhatsApp.',
              `Código: ${firstError.code || 'sin código'}`,
              `Motivo: ${errorMessage || 'sin motivo informado'}`,
              `Mensaje: ${externalId}`,
              `Phone Number ID: ${value?.metadata?.phone_number_id || 'no informado'}`,
              `Fecha: ${updatedAt}`
            ].join('\n')
          }).catch(() => {});
        }
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
          logWebhookEvent(value, 'descartado', `no se pudo persistir el estado ${rawStatus}: ${statusError.message}`, { message_id: externalId });
        }
      }
      // A payload can contain delivery statuses and a customer message at
      // the same time. Statuses are persisted above, but must not prevent the
      // message branch below from saving the inbound turn in the CRM.
    }

    if (!value?.messages || value.messages.length === 0) {
      logWebhookEvent(value, 'procesado', statuses.length > 0 ? 'estado(s) procesado(s); no había mensaje entrante' : 'evento sin mensaje entrante');
      return;
    }

    const message = value.messages[0];
    const contact = value.contacts?.[0];
    const metadata = value.metadata;

    const messageId = message.id;
    if (!messageId) {
      logWebhookEvent(value, 'descartado', 'mensaje sin message.id');
      return;
    }

    // --- ATOMIC PERSISTENT DEDUPLICATION IN FIRESTORE ---
    if (!db) {
      console.error('❌ Database not initialized. Cannot process message safely.');
      logWebhookEvent(value, 'descartado', 'base de datos no inicializada; no se pudo guardar el mensaje', { message_id: messageId });
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
      logWebhookEvent(value, 'descartado', `error en deduplicación: ${txErr.message}`, { message_id: messageId });
      return;
    }

    if (!shouldProcess) {
      console.log(`⚠️ [Deduplication] Message [${messageId}] is already processed or being processed. Skipping.`);
      logWebhookEvent(value, 'descartado', 'mensaje duplicado o ya en procesamiento', { message_id: messageId });
      return;
    }

    const phoneNumberId = metadata?.phone_number_id ? String(metadata.phone_number_id).trim() : null;
    const wabaId = entry?.id ? String(entry.id).trim() : null;
    let customerPhone = normalizeWhatsAppPhone(message.from);
    let customerName = contact?.profile?.name || `Usuario WhatsApp (+${customerPhone})`;
    // Media is optional. Never let a missing parser stop the entire webhook.
    const inboundMedia = typeof extractInboundMedia === 'function'
      ? extractInboundMedia(message)
      : null;
    let messageText = message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || inboundMedia?.media_caption || '';
    if (!messageText && inboundMedia) {
      const mediaLabels = { image: '📷 Imagen recibida', video: '🎥 Video recibido', audio: '🎙️ Audio recibido', document: '📄 Documento recibido', sticker: '🧩 Sticker recibido' };
      messageText = mediaLabels[inboundMedia.media_type] || '📎 Archivo recibido';
    }
    const timestamp = message.timestamp ? new Date(parseInt(message.timestamp, 10) * 1000).toISOString() : new Date().toISOString();

    // 1. Strict Tenant Company & Credential Resolution
    // Webhook events must ONLY be routed to a company that owns this verified phone_number_id.
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
      logWebhookEvent(value, 'descartado', 'phone_number_id sin integración registrada para ningún tenant', { message_id: messageId });
      return;
    }

    const { companyId, intDocId, accessToken } = tenant;
    console.log(`🏢 [Tenant Resolved] Company: ${companyId} | WhatsApp Integration: ${intDocId} | Phone ID: ${phoneNumberId}`);

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
      logWebhookEvent(value, 'descartado', 'payload sintético de prueba de Meta; no se creó conversación ni respuesta', { message_id: messageId, company_id: companyId });
      return;
    }

    console.log(`📥 [WhatsApp Inbound] Company: ${companyId} | Phone ID: ${phoneNumberId} | Message received.`);

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
    const phoneKey = cleanPhoneDigits.slice(-10) || String(Date.now());
    const companyKey = String(companyId || 'tenant').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'tenant';
    const leadId = `lead_${companyKey}_wa_${phoneKey}`;

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

    try {
      await db.doc(`leads/${leadId}`).set(leadData, { merge: true });
    } catch (e) {
      console.warn('Error saving lead to Firestore:', e.message);
    }

    // 4. Conversation State Management
    const conversationLookup = await loadWhatsAppConversation(db, companyId, customerPhone);
    const convId = conversationLookup.id;
    let convData = conversationLookup.data;

    // If this contact was stored previously with a legacy id/phone format,
    // move its messages to the canonical conversation before appending the new
    // turn. This keeps the inbox as one continuous chat.
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
          .orderBy('created_at', 'desc')
          .limit(50)
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

    const botPausedByOwner = isTenantPaused(companyId);
    if (!convData) {
      convData = {
        id: convId,
        company_id: companyId,
        channel: 'whatsapp',
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        external_user_id: customerPhone,
        contact_phone_normalized: customerPhone,
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
      if (phoneNumberId) convData.phone_number_id = phoneNumberId;
      if (wabaId) convData.waba_id = wabaId;
      convData.contact_phone_normalized = customerPhone;
      recentCustomerMessages = [...recentCustomerMessages, messageText].filter(Boolean).slice(-4);
      convData.last_customer_message = messageText;
      convData.recent_customer_messages = recentCustomerMessages;
      convData.last_message = messageText;
      convData.last_message_sender = 'customer';
      convData.last_message_at = timestamp;
      convData.updated_at = timestamp;
      convData.unread_count = (convData.unread_count || 0) + 1;
    }

    // The previous emergency pause marked existing SPR conversations for
    // human review. Once the explicit pause is removed, the next customer
    // message resumes only that owner-pause state; other advisor handoffs
    // remain untouched and still require the normal idle timeout.
    if (companyId === SPR_COMPANY_ID && !botPausedByOwner && convData.handoff_reason === 'bot_paused_by_owner') {
      convData.human_handoff = false;
      convData.bot_enabled = true;
      convData.status = 'active';
      convData.auto_reactivate_enabled = true;
      convData.human_handoff_started_at = null;
      convData.needs_human_review = false;
      convData.review_requested_at = null;
      convData.handoff_reason = null;
      convData.auto_reactivated_at = timestamp;
      convData.auto_reactivation_reason = 'owner_pause_removed';
      console.log('🤖 [Owner Pause Removed] Conversation [' + convId + '] resumed for the reactivated SPR bot.');
    }

    // A human reply pauses the current turn, not the whole conversation. For
    // SPR, a new piece, greeting, or concrete question explicitly starts a
    // fresh automated turn. This prevents every advisor send from leaving the
    // customer silently paused while preserving acknowledgements such as
    // "gracias" with the human advisor.
    if (companyId === SPR_COMPANY_ID && !botPausedByOwner
      && (convData.human_handoff === true || convData.bot_enabled === false)      && (!convData.last_agent_message_at || shouldAutoReactivateBot(convData))
      && isSprNewRequestOrQuestion(messageText)) {
      convData.human_handoff = false;
      convData.bot_enabled = true;
      convData.status = 'active';
      convData.auto_reactivate_enabled = true;
      convData.human_handoff_started_at = null;
      convData.needs_human_review = false;
      convData.review_requested_at = null;
      convData.handoff_reason = null;
      convData.auto_reactivated_at = timestamp;
      convData.auto_reactivation_reason = 'customer_new_request';
      convData.assigned_user_id = null;
      convData.assigned_user_name = null;
      // A prior catalog review belongs to the previous customer turn. A new
      // piece or concrete question must start a clean automated turn instead
      // of remaining silently blocked by the stale review marker.
      convData.catalog_review_required = false;
      convData.catalog_review_reason = null;
      convData.catalog_review_query = null;
      console.log('🤖 [New Customer Request] Conversation [' + convId + '] resumed for a new piece or FAQ question.');
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

    if (companyId === SPR_COMPANY_ID) {
      try {
        await db.doc(SPR_INACTIVITY_STATE_PATH).set({
          company_id: SPR_COMPANY_ID,
          last_customer_message_at: timestamp,
          last_customer_message_id: messageId,
          last_alerted_at: null,
          updated_at: new Date().toISOString()
        }, { merge: true });
      } catch (alertStateError) {
        console.warn('[SPR alerts] Could not update last customer message:', alertStateError.message);
      }
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

      logWebhookEvent(value, 'procesado', 'mensaje guardado; bot pausado porque la conversación está asignada a un asesor', { message_id: messageId, company_id: companyId });
      return;
    }

    // Load Bot Settings for working hours & personality
    let botSettings = null;
    try {
      const sSnap = await db.doc(`bot_settings/${companyId}`).get();
      if (sSnap.exists) botSettings = sSnap.data();
    } catch (e) {}

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
    // Fill only missing policy fields so an existing tenant's intentional
    // branding and messages remain intact while every tenant receives the
    // same safety and isolation defaults.
    botSettings = mergeTenantSafeBotSettings(
      tenantCompany || { id: companyId, nombre: botSettings?.business_name || 'nuestro negocio' },
      botSettings
    );
    const tenantDisplayName = String(
      tenantCompany?.nombre || botSettings?.business_name || botSettings?.business_description || 'nuestro negocio'
    ).trim();

    // Check for Human Handoff Intent
    const lowerText = normalizeBotText(messageText);
    const humanKeywords = ['asesor', 'humano', 'persona', 'agente', 'ejecutivo', 'hablar con alguien', 'representante', 'ayuda humana', 'transferir'];
    const wantsHuman = humanKeywords.some(kw => lowerText.includes(kw));
    // Greetings and courtesy messages must be answered before business-hours rules.
    // A greeting such as “Hola, buenos días” is still a greeting, not a request
    // for schedules or a catalog search.
    const isFriendlyGreeting = isFriendlyGreetingText(messageText);
    const isCourtesyMessage = isCourtesyText(messageText);
    const isShopifySuspensionIntro = /^hola vengo de spr autopartes y necesito asesoria para suspension marca modelo y ano$/.test(lowerText);
    const isShopifyPartsIntro = /^hola vengo de spr autopartes y me gustaria consultar sobre algunas piezas$/.test(lowerText);
    const isShopifyPrefillIntro = isShopifySuspensionIntro || isShopifyPartsIntro;

    let botReply = '';

    if (botPausedByOwner) {
      // Keep the inbound turn in Firestore for the advisor, but never send an
      // automatic answer while the owner has paused this tenant's bot.
      convData.human_handoff = true;
      convData.bot_enabled = false;
      convData.status = 'pending';
      convData.auto_reactivate_enabled = false;
      convData.handoff_reason = 'bot_paused_by_owner';
      convData.needs_human_review = true;
      convData.review_requested_at = timestamp;
      botReply = '';
      console.log(`⏸️ [Bot Paused by Owner] Company [${companyId}] — inbound recorded without automatic reply.`);
    } else if (wantsHuman) {
      convData.human_handoff = true;
      convData.bot_enabled = false;
      convData.status = 'pending';
      convData.auto_reactivate_enabled = true;
      convData.human_handoff_started_at = convData.human_handoff_started_at || timestamp;
      botReply = `Entendido, ${customerName}. He pausado las respuestas automáticas y transferí tu conversación a un asesor comercial. En un momento te responderá directamente aquí.`;

      // Urgent Task in CRM
      const taskId = createUniqueId('task');
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
    } else if (botSettings?.working_hours && !checkWorkingHours(botSettings.working_hours) && !isFriendlyGreeting && !isCourtesyMessage && !isShopifyPrefillIntro) {
      // Out of hours
      botReply = botSettings.out_of_hours_message || `¡Hola! Gracias por comunicarte. En este momento nos encontramos fuera de horario de atención comercial, pero ya registramos tu consulta y un asesor te responderá a primera hora.`;
    } else {
      // Query Knowledge Base for match
      const kbItems = await getTenantKnowledgeBase(db, companyId);

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
      const asksCrm = lowerText.includes('crm');
      const asksBot = lowerText.includes('bot') || lowerText.includes('chatbot') || lowerText.includes('chat bot') || lowerText.includes('whatsapp') || lowerText.includes('api chat');
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

      const packageReply = `🚀 *Paquete Completo DT Marketing*

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

      const botIdentityForCatalog = `${botSettings?.bot_name || ''} ${botSettings?.business_description || ''}`.toLowerCase();
      var isSprAutopartesTenant = companyId === SPR_COMPANY_ID
        || /spr\s*(bot|autopartes|engine)/i.test(botIdentityForCatalog)
        || /spr autopartes/i.test(botIdentityForCatalog);
      const publicBusinessName = isSprAutopartesTenant ? 'SPR Autopartes' : tenantDisplayName;
      const publicBotName = String(
        botSettings?.bot_name || (isSprAutopartesTenant ? 'SPR BOT' : 'asistente virtual')
      ).trim();
      const catalogQueryText = catalogContextText || messageText;
      // Normalize colloquial spellings before every stage of the lookup. The
      // same canonical query must reach matching, strict vehicle filters and
      // the final reply; otherwise “facia”, “amort” or “retrovisor” could
      // match in the first pass and then be discarded by the second one.
      const catalogLowerText = normalizeSprCatalogText(catalogQueryText);
      const sprVehicleDetails = isSprAutopartesTenant
        ? extractSprVehicleDetails(catalogQueryText)
        : {};
      const hasCompleteSprVehicleIdentity = Boolean(
        sprVehicleDetails.marca && sprVehicleDetails.modelo && sprVehicleDetails.ano
      );
      // A labeled vehicle profile is context, not a product request. In
      // particular, "Motor: 1.4 TSI" must not trigger a motor lookup. Only
      // search once the customer names an actual piece in the same message or
      // in a follow-up that carries this vehicle context.
      const vehicleOnlyCatalogContext = isSprAutopartesTenant
        && hasCompleteSprVehicleIdentity
        && !hasSprExplicitPartRequest(catalogQueryText);
      const vehicleContextReply = vehicleOnlyCatalogContext
        ? buildSprVehicleConfirmationReply(sprVehicleDetails)
        : '';
      const sprMissingRequestFields = isSprAutopartesTenant && !vehicleOnlyCatalogContext
        ? getSprMissingRequestFields(catalogQueryText)
        : [];
      const sprMissingRequestReply = buildSprMissingRequestReply(sprMissingRequestFields, catalogQueryText);
      const asksCatalogProduct = !isShopifyPrefillIntro
        && !vehicleOnlyCatalogContext
        && (/\b(motor(?:es)?|cabeza(?:s)?|culata|engine series|cabeza de motor|amortiguador(?:es)?|suspensi[oó]n|freno(?:s)?|balatas|pastillas|aceite|anticongelante|refrigerante|coolant|lubricante|aditivo|liquido(?:s)?|buj[ií]a(?:s)?|bater[ií]a(?:s)?|filtro(?:s)?|llanta(?:s)?|neum[aá]tico(?:s)?|rin(?:es)?|birlo(?:s)?|plumilla(?:s)?|escobilla(?:s)?|fusible(?:s)?|foco(?:s)?|refacci[oó]n(?:es)?|pieza(?:s)?|caja de direcci[oó]n|direcci[oó]n|cremallera(?:s)?|rack(?:\s+and)?\s+pinion|radiador|bomba|turbo|embrague|clutch|soporte|terminal|r[oó]tula|productos?|cat[aá]logo|precio|cotiza(?:r|ci[oó]n)?|disponible|stock|delantero|delantera|trasero|trasera|izquierdo|izquierda|derecho|derecha|faro(?:s)?|calavera(?:s)?|lampara(?:s)?|luz|luces|espejo(?:s)?|gu[ií]a(?:s)?|fascia(?:s)?|moldura(?:s)?|parrilla(?:s)?|defensa(?:s)?|cofre|cajuela|puerta(?:s)?|manija(?:s)?|bisagra(?:s)?|tolva(?:s)?|rejilla(?:s)?|salpicadera|carroceria)\b/.test(lowerText) || SPR_EXPLICIT_PART_PATTERN.test(lowerText) || catalogLowerText !== lowerText || isUnlistedSprProductRequest(catalogLowerText) || (catalogContextText !== messageText && isSprLikelyPieceFollowUp(messageText)));
      let sprCatalogReply = ''; let sprCatalogMatched = false;
      if (isSprAutopartesTenant && asksCatalogProduct) {
        try {
          let catalogItems = [];
          try {
            catalogItems = [];
          } catch (catalogLoadError) {
            console.warn('⚠️ SPR collection load failed; continuing with official search:', catalogLoadError.message);
          }
                    let sprMatches = [];
          let officialSearchItems = [];
          // Always consult SPR's live search first. This keeps prices, links and
          // newly published products current for every piece request instead of
          // trusting a potentially stale collection response.
          try {
            const officialQuery = buildSprFocusedSearchQuery(catalogQueryText);
            officialSearchItems = await searchSprCatalog(officialQuery);
            const officialStrictMatches = filterStrictSprVehicleMatches(
              findSprEngineMatches(officialSearchItems, catalogLowerText),
              catalogLowerText
            );
            const officialMatches = officialStrictMatches.length
              ? officialStrictMatches
              : findSprExhaustiveMatches(officialSearchItems, catalogQueryText);
            if (officialMatches.length || isGenericSprCatalogRequest(catalogLowerText)) {
              catalogItems = officialSearchItems;
              sprMatches = officialMatches;
            }
          } catch (officialSearchError) {
            console.warn('⚠️ SPR official search failed; no local catalog fallback was used:', officialSearchError.message);
          }

          // Continue only with official results and bounded official-query variants.
          // No local export or collection fallback is consulted.
          
          catalogItems = officialSearchItems;
          if (!sprMatches.length) {
            sprMatches = findSprEngineMatches(catalogItems, catalogLowerText);
            sprMatches = filterStrictSprVehicleMatches(sprMatches, catalogLowerText);
          }
          if (!sprMatches.length && !isGenericSprCatalogRequest(catalogLowerText)) {
            sprMatches = findSprExhaustiveMatches(catalogItems, catalogQueryText);
          }
          if (!sprMatches.length && !isGenericSprCatalogRequest(catalogLowerText)) {
            const exhaustiveSearch = await searchSprCatalogExhaustively(
              [...catalogItems, ...officialSearchItems],
              catalogQueryText
            );
            catalogItems = exhaustiveSearch.items;
            sprMatches = exhaustiveSearch.matches;
          }
          // A strict miss must not end the conversation. Run one final ranked pass
          // over all official results so
          // typos, colloquial wording, omitted brand names and different word
          // order still return the closest catalog options with their prices
          // and links. Exact matches always win before this recovery pass.
          if (!sprMatches.length && !isGenericSprCatalogRequest(catalogLowerText)) {
            sprMatches = findSprCatalogRecoveryMatches(catalogItems, catalogQueryText);
          }
          sprCatalogMatched = sprMatches.length > 0; const aldoStockResult = isAldoStockCategoryQuery(catalogQueryText)
            ? await searchAldoStock(catalogQueryText)
            : null;
          sprCatalogReply = buildSprCatalogReply(sprMatches, catalogLowerText, catalogItems, aldoStockResult);
        } catch (catalogError) {
          console.warn('⚠️ SPR live catalog lookup failed:', catalogError.message);
        }
      }

      if (isShopifyPrefillIntro) {
        botReply = `👋 ¡Hola! Gracias por escribir a *SPR Autopartes*. Soy *SPR BOT* y con gusto te ayudo.\n\nPara buscar correctamente en el catálogo, escríbeme *solo estos cuatro datos* en un mismo mensaje:\n🔧 Pieza\n🚗 Marca\n🚙 Modelo\n📅 Año\n\nEjemplo: *faro derecho Nissan Versa 2017*.`;
      } else if (shouldRouteSprCatalogToAdvisor({
        isSprAutopartesTenant,
        asksCatalogProduct,
        sprCatalogMatched,
        missingRequestReply: sprMissingRequestReply,
        query: catalogQueryText
      })) {
        convData.human_handoff = true;
        convData.bot_enabled = false;
        convData.status = 'pending';
        convData.auto_reactivate_enabled = false;
        convData.human_handoff_started_at = convData.human_handoff_started_at || timestamp;
        convData.handoff_reason = 'catalog_no_exact_match';
        convData.catalog_review_required = true;
        convData.catalog_review_reason = 'no_exact_match_after_all_filters';
        convData.catalog_review_query = messageText;
        convData.needs_human_review = true;
        convData.review_requested_at = timestamp;
        botReply = buildSprAdvisorReviewReply(customerName);

        const taskId = createUniqueId('task');
        const taskData = {
          id: taskId,
          company_id: companyId,
          lead_id: leadId,
          lead_nombre: customerName,
          titulo: `Verificar pieza sin coincidencia exacta de ${customerName}`,
          tipo: 'whatsapp',
          fecha_limite: new Date().toISOString(),
          prioridad: 'Urgente',
          completada: false,
          fecha_creacion: timestamp,
          nota: `Se agotaron los filtros del catálogo sin coincidencia confirmable. Revisar manualmente antes de cotizar. Mensaje: "${messageText}"`
        };
        try {
          await db.doc(`followups/${taskId}`).set(taskData);
        } catch (e) {}
      } else if (sprMissingRequestReply && !sprCatalogMatched) {
        botReply = sprMissingRequestReply;
      } else if (vehicleContextReply) {
        botReply = vehicleContextReply;
      } else if (sprCatalogReply) {
        botReply = sprCatalogReply;
      } else if (isFriendlyGreeting) {
        const greetingPrefix = lowerText.includes('buenos dias')
          ? '☀️ ¡Muy buenos días!'
          : lowerText.includes('buenas tardes')
            ? '🌤️ ¡Muy buenas tardes!'
            : lowerText.includes('buenas noches')
              ? '🌙 ¡Muy buenas noches!'
              : '👋 ¡Hola!';
        const helpPrompt = isSprAutopartesTenant
          ? 'Para buscar en el catálogo, escríbeme *solo*: pieza, marca, modelo y año.\nEjemplo: *faro derecho Nissan Versa 2017*.'
          : '¿En qué podemos ayudarte hoy?';
        botReply = `${greetingPrefix}

Gracias por escribir a *${publicBusinessName}*. Soy *${publicBotName}* y con gusto te ayudo.

${helpPrompt}`;
      } else if (isCourtesyMessage) {
        const courtesyFollowup = isSprAutopartesTenant
          ? 'Cuando necesites otra pieza, aquí estaremos para ayudarte. 🚗🔧'
          : 'Cuando necesites algo más, aquí estaremos para ayudarte.';
        botReply = `😊 ¡Con gusto! Gracias a ti por escribir a *${publicBusinessName}*.

${courtesyFollowup}`;
      } else if (asksPackage) {
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
        // SPR catalog requests remain automated. A request that survived the
        // exhaustive and recovery passes still receives a useful catalog
        // prompt; it is never routed to an advisor, denied as out of stock or
        // left unanswered. Other tenants keep their configured review policy.
        if (isSprAutopartesTenant) {
          botReply = buildSprCatalogFallbackReply(catalogQueryText);
          convData.human_handoff = false;
          convData.bot_enabled = true;
          convData.status = 'active';
          convData.needs_human_review = false;
          convData.review_requested_at = null;
          convData.handoff_reason = null;
        } else if (botSettings?.silent_uncertain_fallback === true || botSettings?.onboarding_policy?.review_uncertain_requests === true) {
          convData.human_handoff = true;
          convData.bot_enabled = false;
          convData.status = 'pending';
          // A review stays paused until the customer starts a new piece/FAQ
          // request. This prevents a repeated acknowledgement from waking the
          // bot and sending a second, possibly conflicting answer.
          convData.auto_reactivate_enabled = false;
          convData.human_handoff_started_at = convData.human_handoff_started_at || timestamp;
          convData.handoff_reason = 'uncertain_request_review';
          convData.needs_human_review = true;
          convData.review_requested_at = timestamp;
          botReply = isSprAutopartesTenant
            ? buildSprAdvisorReviewReply(customerName)
            : '';
          console.log(`🧑‍💼 [Review Required] Conversation [${convId}] needs advisor verification before replying.`);
        } else {
          const configuredFallback = String(botSettings?.fallback_message || '').trim();
          botReply = configuredFallback && !/no tenemos ese articulo|no tenemos ese artículo|no tengo suficiente información|no tengo suficiente informacion/i.test(configuredFallback)
            ? configuredFallback
            : '';
        }
      }
    }

    botReply = formatWhatsAppReply(botReply);

    // 6. Send Outbound WhatsApp Reply via Meta Graph API
    const botIdentity = `${companyId} ${tenantDisplayName} ${botSettings?.bot_name || ''} ${botSettings?.business_description || ''}`.toLowerCase(); const isDtMarketingTenant = companyId === 'comp_dt_marketing' || /\bdt\s*(marketing|crm)\b/.test(botIdentity); const tenantBotName = String(botSettings?.bot_name || tenantDisplayName || 'nuestro asistente').trim(); const crossTenantContent = /(dt marketing|dt crm core|api chat bot|paquete completo|escribe \*crm\*, \*whatsapp\* o \*paquete\*)/i; const asksLocation = isCustomerLocationQuestion(lowerText); if (!isDtMarketingTenant && (asksLocation || crossTenantContent.test(botReply))) { console.error(`[Cross-Tenant Content Blocked] Company: ${companyId} | Phone ID: ${phoneNumberId}`); botReply = asksLocation ? `📍 *Estamos ubicados en Querétaro, México.* 🚚 Realizamos envíos a todo México. Si ya deseas comprar, compártenos la pieza que buscas y los datos de tu vehículo para preparar tu cotización.` : `🤔 *Quiero ayudarte mejor.* Para orientarte sobre *${tenantBotName}*, ¿buscas una cotización, una pieza o servicio, información de envío, garantía o hablar con un asesor?`; } let outboundSuccess = false;
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
            text: {
              preview_url: Boolean(isSprAutopartesTenant && /https?:\/\/sprautopartes\.mx\/products\//i.test(botReply)),
              body: botReply
            }
          },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        logMetaApiResponse('respuesta_del_bot', metaRes);
        metaMessageId = metaRes.data?.messages?.[0]?.id || null;
        if (!metaMessageId) {
          throw new Error('Meta respondió sin un ID de mensaje. El CRM no marcará el envío como aceptado.');
        }
        outboundSuccess = true;
        console.log(`🤖 [DT Bot Accepted] Phone ID: ${phoneNumberId} | Meta Msg ID: ${metaMessageId}`);
      } catch (metaErr) {
        logMetaApiError('respuesta_del_bot', metaErr);
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
          external_message_id: metaMessageId,
          phone_number_id: phoneNumberId
        };

        const messageRef = db.doc(`messages/${outMsgId}`);
        await messageRef.set(outMsgData);
        await mergeBufferedDeliveryStatus(db, metaMessageId, messageRef);
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
        needs_human_review: convData.needs_human_review === true,
        handoff_reason: convData.handoff_reason || null,
        db_save_partial_error: dbSaveError || null
      }, { merge: true });
    } catch (e) {}

    logWebhookEvent(value, 'procesado', outboundSuccess ? 'mensaje guardado y respuesta del bot aceptada por Meta' : 'mensaje guardado; no se envió respuesta automática', {
      message_id: messageId,
      company_id: companyId,
      bot_replied: outboundSuccess
    });

  } catch (err) {
    console.error('Error processing WhatsApp Webhook:', err);
    logWebhookEvent(req.body?.entry?.[0]?.changes?.[0]?.value, 'descartado', `error inesperado durante el procesamiento: ${err.message}`);
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

  // Use the same canonical WhatsApp phone format as inbound webhooks. Older
  // Mexican contacts can still be stored as 521XXXXXXXXXX; Meta Cloud API
  // expects the current 52XXXXXXXXXX form for outbound messages.
  const cleanPhone = normalizeWhatsAppPhone(to_phone);
  if (!cleanPhone) {
    return res.status(400).json({
      success: false,
      error: 'El teléfono destino no tiene un formato válido para WhatsApp.'
    });
  }
  let preferredPhoneNumberId = null;

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
    const convTarget = normalizeWhatsAppPhone(convData.external_user_id || convData.contact_phone || '');
    if (convTarget && !cleanPhone.endsWith(convTarget.slice(-10))) {
      return res.status(400).json({
        success: false,
        error: 'El teléfono destino no coincide con el destinatario registrado en la conversación.'
      });
    }
    preferredPhoneNumberId = convData.phone_number_id || convData.whatsapp_phone_number_id || null;
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
  const markOutboundAttemptFailed = async (errorMessage) => {
    try {
      await dedupDocRef.set({
        status: 'failed',
        error: String(errorMessage || 'Error antes de contactar Meta'),
        failed_at: new Date().toISOString()
      }, { merge: true });
    } catch (lockError) {
      console.warn('Could not release outbound idempotency lock:', lockError.message);
    }
  };
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

  try {
    const outboundTenant = await resolveOutboundTenant(db, company_id, preferredPhoneNumberId);
    if (outboundTenant) {
      activePhoneNumberId = outboundTenant.phoneNumberId;
      activeToken = outboundTenant.accessToken;
    }
  } catch (e) {
    console.error('Error fetching tenant credentials:', e.message);
    await markOutboundAttemptFailed(e.message);
    return res.status(500).json({
      success: false,
      error: 'Error al consultar credenciales de integración en la base de datos.'
    });
  }

  if (!activePhoneNumberId || !activeToken) {
    await markOutboundAttemptFailed('Credenciales de WhatsApp Cloud API no configuradas para esta empresa.');
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

    logMetaApiResponse('envio_manual', metaRes);
    const metaMsgId = metaRes.data?.messages?.[0]?.id || null;
    if (!metaMsgId) {
      throw new Error('Meta respondió sin un ID de mensaje. El CRM no marcará el envío como aceptado.');
    }
    console.log(`📤 [Advisor Message Accepted] Company: ${company_id} | Meta Msg ID: ${metaMsgId}`);

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
        external_message_id: metaMsgId,
        phone_number_id: activePhoneNumberId
      };

      try {
        const messageRef = db.doc(`messages/${msgId}`);
        await messageRef.set(msgData);
        await mergeBufferedDeliveryStatus(db, metaMsgId, messageRef);
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
    logMetaApiError('envio_manual', err);
    console.error('Error in agent send message:', err.response?.data?.error?.message || err.message);
    const metaErrorObj = err.response?.data?.error;
    if (metaErrorObj?.code || metaErrorObj?.message) {
      void sendAlertEmail({
        subject: '[WhatsApp] Meta rechazó un mensaje',
        text: [
          'Meta devolvió un error al intentar enviar una respuesta desde el CRM.',
          `Empresa: ${company_id || 'no informada'}`,
          `Conversación: ${conversation_id || 'no informada'}`,
          `Código: ${metaErrorObj.code || 'sin código'}`,
          `Motivo: ${metaErrorObj.message || err.message}`,
          `Detalle: ${metaErrorObj.error_data?.details || metaErrorObj.details || 'sin detalle adicional'}`,
          `Fecha: ${new Date().toISOString()}`
        ].join('\n')
      }).catch(() => {});
    }

    // Meta rejects free-form text after the 24-hour customer-service window
    // with error 131047 ("Re-engagement message").  Treat this as a
    // non-retryable, actionable state instead of surfacing Meta's raw text
    // and offering a retry that will fail again.  The advisor must either
    // wait for the customer to write again or use an approved template.
    const isClosedWhatsAppWindow = metaErrorObj?.code === 131047
      || /re-engagement message/i.test(String(metaErrorObj?.message || err.message || ''));

    if (dedupDocRef) {
      try {
        await dedupDocRef.set({
          status: 'failed',
          error: metaErrorObj?.message || err.message,
          failed_at: new Date().toISOString()
        }, { merge: true });
      } catch (e) {}
    }

    if (isClosedWhatsAppWindow) {
      return res.status(409).json({
        success: false,
        error_code: 'WHATSAPP_WINDOW_CLOSED',
        meta_error_code: metaErrorObj?.code || 131047,
        meta_error_subcode: metaErrorObj?.error_subcode || null,
        retryable: false,
        requires_template: true,
        error: 'La ventana de atención de WhatsApp está cerrada. El cliente debe escribir primero o debes usar una plantilla aprobada por Meta.'
      });
    }

    return res.status(500).json({
      success: false,
      error_code: metaErrorObj?.code ? `META_${metaErrorObj.code}` : 'WHATSAPP_SEND_FAILED',
      meta_error_code: metaErrorObj?.code || null,
      meta_error_subcode: metaErrorObj?.error_subcode || null,
      retryable: true,
      error: metaErrorObj?.message || err.message
    });
  }
});

/**
 * 5. DIAGNOSTIC TEST ENDPOINT
 * Protected with Firebase Auth & Role Verification (ADMINISTRADOR or SUPERADMIN only)
 * Supports testing with both explicitly passed credentials and saved company credentials.
 */
/**
 * Send an image or document from the CRM through the tenant's WhatsApp Cloud
 * API connection. The CRM sends a bounded base64 payload; the backend uploads
 * it to Meta first and then sends the resulting media ID to the customer.
 */
app.post('/api/send-media', authenticateUser, async (req, res) => {
  const {
    to_phone,
    company_id,
    conversation_id,
    user_name,
    client_message_id,
    message_type,
    filename,
    mime_type,
    data_base64,
    caption
  } = req.body || {};
  const user = req.authenticatedUser;
  const allowedRoles = ['SUPERADMIN', 'ADMINISTRADOR', 'ASESOR'];

  if (!allowedRoles.includes(user.rol)) {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: tu rol no tiene permisos para enviar archivos.'
    });
  }
  if (!company_id || !to_phone || !data_base64 || !client_message_id) {
    return res.status(400).json({
      success: false,
      error: 'Faltan company_id, to_phone, data_base64 o client_message_id.'
    });
  }
  if (user.rol !== 'SUPERADMIN' && user.company_id !== company_id) {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: no puedes enviar archivos desde otra empresa.'
    });
  }

  const cleanPhone = normalizeWhatsAppPhone(to_phone);
  if (!cleanPhone) {
    return res.status(400).json({ success: false, error: 'El teléfono destino no es válido.' });
  }

  const mime = String(mime_type || 'application/octet-stream').trim().toLowerCase();
  const requestedType = String(message_type || '').trim().toLowerCase();
  const mediaType = requestedType === 'image' || mime.startsWith('image/') ? 'image' : 'document';
  const safeFilename = String(filename || (mediaType === 'image' ? 'imagen' : 'documento'))
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .slice(0, 180);
  const rawBase64 = String(data_base64).replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(rawBase64)) {
    return res.status(400).json({ success: false, error: 'El archivo no tiene un formato base64 válido.' });
  }
  const fileBuffer = Buffer.from(rawBase64, 'base64');
  const maxBytes = Math.max(1, Number(process.env.MEDIA_MAX_BYTES || 10 * 1024 * 1024));
  if (!fileBuffer.length || fileBuffer.length > maxBytes) {
    return res.status(413).json({
      success: false,
      error: `El archivo debe pesar entre 1 byte y ${Math.floor(maxBytes / (1024 * 1024))} MB.`
    });
  }

  let preferredPhoneNumberId = null;
  if (conversation_id) {
    if (!db) return res.status(503).json({ success: false, error: 'Base de datos no disponible.' });
    const convSnap = await db.doc(`conversations/${conversation_id}`).get();
    if (!convSnap.exists) {
      return res.status(404).json({ success: false, error: 'La conversación indicada no existe.' });
    }
    const convData = convSnap.data() || {};
    if (convData.company_id !== company_id) {
      return res.status(403).json({ success: false, error: 'La conversación pertenece a otra empresa.' });
    }
    const convTarget = normalizeWhatsAppPhone(convData.external_user_id || convData.contact_phone || '');
    if (convTarget && !cleanPhone.endsWith(convTarget.slice(-10))) {
      return res.status(400).json({ success: false, error: 'El teléfono no coincide con la conversación.' });
    }
    preferredPhoneNumberId = convData.phone_number_id || convData.whatsapp_phone_number_id || null;
  }

  if (!db) return res.status(503).json({ success: false, error: 'Base de datos no disponible.' });
  const cleanClientId = String(client_message_id).trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleanClientId.length < 3) {
    return res.status(400).json({ success: false, error: 'client_message_id no es válido.' });
  }
  const dedupDocRef = db.doc(`outbound_requests/${company_id}_${cleanClientId}`);
  let existingRecord = null;
  try {
    await db.runTransaction(async transaction => {
      const snap = await transaction.get(dedupDocRef);
      const data = snap.exists ? snap.data() || {} : {};
      const stale = data.started_at_ms && Date.now() - data.started_at_ms > 60000;
      if (data.status === 'completed' && data.meta_message_id) {
        existingRecord = data;
        return;
      }
      if (data.status === 'in_flight' && !stale) {
        existingRecord = { in_flight: true };
        return;
      }
      transaction.set(dedupDocRef, {
        company_id,
        client_message_id: cleanClientId,
        status: 'in_flight',
        started_at: new Date().toISOString(),
        started_at_ms: Date.now()
      });
    });
  } catch (error) {
    console.error('[Media idempotency] lock failed:', error.message);
    return res.status(500).json({ success: false, error: 'No se pudo asegurar el envío único.' });
  }
  if (existingRecord?.in_flight) {
    return res.status(409).json({ success: false, error: 'El archivo ya está siendo procesado.' });
  }
  if (existingRecord?.meta_message_id) {
    return res.status(200).json({ success: true, message_id: existingRecord.meta_message_id, is_duplicate: true });
  }

  let activePhoneNumberId = null;
  let activeToken = null;
  try {
    const outboundTenant = await resolveOutboundTenant(db, company_id, preferredPhoneNumberId);
    activePhoneNumberId = outboundTenant?.phoneNumberId || null;
    activeToken = outboundTenant?.accessToken || null;
  } catch (error) {
    await dedupDocRef.set({ status: 'failed', error: error.message, failed_at: new Date().toISOString() }, { merge: true });
    return res.status(500).json({ success: false, error: 'No se pudieron consultar las credenciales de WhatsApp.' });
  }
  if (!activePhoneNumberId || !activeToken) {
    await dedupDocRef.set({ status: 'failed', error: 'Credenciales no configuradas', failed_at: new Date().toISOString() }, { merge: true });
    return res.status(400).json({ success: false, error: 'Credenciales de WhatsApp no configuradas para esta empresa.' });
  }

  const http = customHttpClient || axios;
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', fileBuffer, { filename: safeFilename, contentType: mime });
    const uploadRes = await http.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${activePhoneNumberId}/media`,
      form,
      { headers: { Authorization: `Bearer ${activeToken}`, ...form.getHeaders() }, maxBodyLength: Infinity, maxContentLength: Infinity }
    );
    logMetaApiResponse('subida_media_manual', uploadRes);
    const mediaId = uploadRes.data?.id || null;
    if (!mediaId) throw new Error('Meta no devolvió un ID de archivo.');

    const mediaPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: mediaType,
      [mediaType]: { id: mediaId }
    };
    const normalizedCaption = String(caption || '').trim();
    if (normalizedCaption) mediaPayload[mediaType].caption = normalizedCaption;
    if (mediaType === 'document') mediaPayload.document.filename = safeFilename;
    const metaRes = await http.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${activePhoneNumberId}/messages`,
      mediaPayload,
      { headers: { Authorization: `Bearer ${activeToken}`, 'Content-Type': 'application/json' } }
    );
    logMetaApiResponse('envio_media_manual', metaRes);
    const metaMsgId = metaRes.data?.messages?.[0]?.id || null;
    if (!metaMsgId) throw new Error('Meta respondió sin un ID de mensaje.');

    await dedupDocRef.set({ status: 'completed', meta_message_id: metaMsgId, media_id: mediaId, completed_at: new Date().toISOString(), delivered_to_meta: true }, { merge: true });
    const createdAt = new Date().toISOString();
    if (conversation_id) {
      const msgId = cleanClientId.startsWith('msg_') ? cleanClientId : `msg_${cleanClientId}`;
      const displayContent = normalizedCaption || `📎 ${safeFilename}`;
      const msgRef = db.doc(`messages/${msgId}`);
      await msgRef.set({
        id: msgId,
        company_id,
        conversation_id,
        direction: 'outbound',
        channel: 'whatsapp',
        content: displayContent,
        sender_type: 'agent',
        user_name: user_name || user.nombre,
        created_at: createdAt,
        delivery_status: 'accepted',
        external_message_id: metaMsgId,
        phone_number_id: activePhoneNumberId,
        media_id: mediaId,
        media_type: mediaType,
        media_mime_type: mime,
        media_filename: safeFilename,
        media_caption: normalizedCaption || null
      });
      await mergeBufferedDeliveryStatus(db, metaMsgId, msgRef);
      await db.doc(`conversations/${conversation_id}`).set({
        last_message: displayContent,
        last_message_sender: 'agent',
        last_message_at: createdAt,
        updated_at: createdAt,
        human_handoff: true,
        bot_enabled: false,
        auto_reactivate_enabled: true,
        human_handoff_started_at: createdAt,
        last_agent_message_at: createdAt
      }, { merge: true });
    }
    return res.status(200).json({ success: true, message_id: metaMsgId, media_id: mediaId, media_type: mediaType, delivery_status: 'accepted' });
  } catch (error) {
    logMetaApiError('envio_media_manual', error);
    await dedupDocRef.set({ status: 'failed', error: error.response?.data?.error?.message || error.message, failed_at: new Date().toISOString() }, { merge: true }).catch(() => {});
    const metaError = error.response?.data?.error;
    return res.status(error.response?.status || 500).json({
      success: false,
      error_code: metaError?.code ? `META_${metaError.code}` : 'WHATSAPP_MEDIA_SEND_FAILED',
      meta_error_code: metaError?.code || null,
      error: metaError?.message || error.message || 'No se pudo enviar el archivo.'
    });
  }
});

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
  if (company_id && db && (!activePhoneNumberId || !activeToken)) {
    try {
      const outboundTenant = await resolveOutboundTenant(db, company_id, activePhoneNumberId);
      if (outboundTenant) {
        activePhoneNumberId = activePhoneNumberId || outboundTenant.phoneNumberId;
        activeWabaId = activeWabaId || outboundTenant.intDoc?.whatsapp_business_account_id || null;
        activeToken = activeToken || outboundTenant.accessToken;
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

    logMetaApiResponse('prueba_manual', metaRes);
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
    logMetaApiError('prueba_manual', err);
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
        logMetaApiResponse('prueba_manual_plantilla_fallback', templateRes);
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
        logMetaApiError('prueba_manual_plantilla_fallback', templateErr);
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
    startSprAlertMonitor();
  });
}

module.exports = {
  app,
  authenticateUser,
  checkWorkingHours,
  verifyMetaSignature,
  isSyntheticMetaPayload,
  resolveTenant,
  resolveOutboundTenant,
  mergeBufferedDeliveryStatus,
  setDb,
  setAdminAuth,
  setHttpClient,
  GRAPH_API_VERSION,
  MASTER_VERIFY_TOKEN,
  normalizeWhatsAppPhone,
  normalizeBotText,
  isFriendlyGreetingText,
  isCourtesyText,
  canonicalizeSprPartSynonyms,
  buildSprFocusedSearchQuery,
  buildSprCatalogSearchQueries,
  findSprEngineMatches,
  filterStrictSprVehicleMatches,
  findSprExhaustiveMatches,
  findSprCatalogRecoveryMatches,
  sprTokenMatches,
  isAmbiguousSprCatalogRequest,
  buildSprCatalogContext,
  getSprStructuredVehicleContext,
  isSprLikelyPieceFollowUp,
  isUnlistedSprProductRequest,
  isIncompleteSprCatalogRequest,
  shouldRouteSprCatalogToAdvisor,
  getSprMissingRequestFields,
  buildSprMissingRequestReply,
  isSprNewRequestOrQuestion,
  buildSprAdvisorReviewReply,
  isSprStoreLocationQuestion,
  buildSprFaqReply,
  buildSprCatalogFallbackReply,
  buildSprCatalogReply,
  businessMinutesSince,
  isSprBusinessWindow,
  normalizeSprProduct,
  extractSprVehicleDetails,
  stripSprVehicleDetailLines,
  hasSprExplicitPartRequest,
  buildSprVehicleConfirmationReply
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

// Prepare a tenant before opening Meta's Embedded Signup flow. This keeps
// onboarding repeatable for every future client: safe bot defaults, tenant
// identity and the activation checklist are written once, without exposing
// tokens or requiring the operator to fill the same fields again.
app.post('/api/meta/embedded-signup/prepare', authenticateUser, async (req, res) => {
  const user = req.authenticatedUser || {};
  const companyId = String(req.body?.company_id || user.company_id || '').trim();
  if (!companyId) return res.status(400).json({ success: false, error: 'No se pudo identificar la empresa activa del CRM.' });
  if (user.rol !== 'SUPERADMIN' && user.company_id !== companyId) {
    return res.status(403).json({ success: false, error: 'No tienes autorización para preparar esta activación.' });
  }
  if (!db) return res.status(503).json({ success: false, error: 'La base de datos no está disponible para preparar la activación.' });

  try {
    const companyRef = db.doc(`companies/${companyId}`);
    const settingsRef = db.doc(`bot_settings/${companyId}`);
    const onboardingRef = db.doc(`tenant_onboarding/${companyId}`);
    const [companySnap, settingsSnap] = await Promise.all([companyRef.get(), settingsRef.get()]);
    const company = companySnap.exists ? companySnap.data() || {} : { id: companyId };
    const currentSettings = settingsSnap.exists ? settingsSnap.data() || {} : {};
    const safeSettings = mergeTenantSafeBotSettings({ ...company, id: companyId }, currentSettings);
    const now = new Date().toISOString();
    const batch = db.batch();
    batch.set(settingsRef, {
      ...safeSettings,
      company_id: companyId,
      updated_at: now,
      activation_defaults_applied_at: now,
      activation_defaults_applied_by: user.uid || 'system'
    }, { merge: true });
    batch.set(onboardingRef, {
      company_id: companyId,
      policy_version: TENANT_POLICY_VERSION,
      status: 'preparing',
      checklist: {
        tenant_identity: Boolean(company.nombre || company.name),
        own_waba: false,
        verified_phone_number: false,
        webhook_subscribed: false,
        client_billing_owner: true,
        bot_safe_defaults: true
      },
      updated_at: now,
      prepared_at: now,
      prepared_by_user_id: user.uid || null
    }, { merge: true });
    await batch.commit();
    res.json({
      success: true,
      company_id: companyId,
      policy_version: TENANT_POLICY_VERSION,
      status: 'preparing',
      next_step: 'Autorizar el WABA y el número de WhatsApp de la empresa en Meta.'
    });
  } catch (error) {
    console.error('Embedded Signup preparation error:', error.message);
    res.status(500).json({ success: false, error: 'No se pudo preparar la activación de esta empresa.' });
  }
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
      tenant_owned: true, billing_owner: 'client', billing_scope: 'tenant_messaging_account',
      policy_version: TENANT_POLICY_VERSION,
      has_token: true, webhook_verified: true, outbound_verified: false,
      meta_business_id: String(body.meta_business_id || '').trim(), last_verified_at: now, last_sync_at: now,
      updated_at: now, created_at: now, created_by_user_id: user.uid, created_by_user_name: user.nombre || 'Administrador'
    };
    const batch = db.batch();
    batch.set(db.doc(`integrations/${integrationId}`), integration, { merge: true });
    batch.set(db.doc(`integrations/${integrationId}/secrets/tokens`), { access_token: accessToken, has_token: true, source: 'embedded_signup', updated_at: now, company_id: companyId }, { merge: true });
    batch.set(db.doc(`tenant_onboarding/${companyId}`), {
      company_id: companyId,
      policy_version: TENANT_POLICY_VERSION,
      status: 'connected',
      checklist: {
        tenant_identity: true,
        own_waba: true,
        verified_phone_number: true,
        webhook_subscribed: true,
        client_billing_owner: true,
        bot_safe_defaults: true
      },
      updated_at: now
    }, { merge: true });
    await batch.commit(); try { const companyRef = db.doc(`companies/${companyId}`); const companySnap = await companyRef.get(); if (companySnap.exists) { const companyData = companySnap.data() || {}; const existingIntegrations = companyData.integraciones || {}; const activeIntegrations = Array.isArray(existingIntegrations.activeIntegrations) ? existingIntegrations.activeIntegrations.filter(item => item.id !== integrationId && item.provider !== "whatsapp") : []; activeIntegrations.push(integration); await companyRef.set({ integraciones: { ...existingIntegrations, activeIntegrations, whatsapp: { ...(existingIntegrations.whatsapp || {}), enabled: true, businessNumber: displayPhone, phoneNumberId: phoneId, wabaId, has_token: true, tenant_owned: true, billing_owner: 'client', policy_version: TENANT_POLICY_VERSION } } }, { merge: true }); } } catch (companySyncError) { console.warn("Embedded Signup company cache sync pending:", companySyncError.message); }
    res.json({ success: true, company_id: companyId, waba_id: wabaId, phone_number_id: phoneId, display_phone_number: displayPhone, verified_name: verifiedName || businessName, status: 'connected' });
  } catch (err) {
    const metaError = err.response?.data?.error;
    console.error('Embedded Signup completion error:', metaError?.message || err.message);
    res.status(502).json({ success: false, error: metaError?.message || 'Meta no pudo completar la conexión de WhatsApp.' });
  }
});
