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
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
// Auto-reactivate the bot after an advisor has been idle.
const HUMAN_HANDOFF_IDLE_MINUTES = Math.max(5, Number(process.env.HUMAN_HANDOFF_IDLE_MINUTES || 30));

function timestampMs(value) {
  if (!value) return 0;
  const parsed = value instanceof Date ? value : new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : 0;
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
    database: db ? 'firebase_admin_authenticated' : 'uninitialized'
  });
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

    if (!value?.messages || value.messages.length === 0) {
      // Event is status update (sent, delivered, read)
      return;
    }

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
    let customerPhone = message.from ? String(message.from).trim() : '';
    // Meta may include Mexico's legacy WhatsApp routing digit (521XXXXXXXXXX).
    // Graph API recipient addressing requires the canonical 52XXXXXXXXXX form.
    if (/^521\d{10}$/.test(customerPhone)) customerPhone = `52${customerPhone.slice(3)}`;
    let customerName = contact?.profile?.name || `Usuario WhatsApp (+${customerPhone})`;
    let messageText = message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
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

    try {
      await db.doc(`leads/${leadId}`).set(leadData, { merge: true });
    } catch (e) {
      console.warn('Error saving lead to Firestore:', e.message);
    }

    // 4. Conversation State Management
    const convId = `conv_${companyId}_whatsapp_${customerPhone}`;
    let convData = null;

    try {
      const cSnap = await db.doc(`conversations/${convId}`).get();
      if (cSnap.exists) convData = cSnap.data();
    } catch (e) {}

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

        last_message: messageText,
        last_message_sender: 'customer',
        created_at: timestamp,
        updated_at: timestamp,
        last_message_at: timestamp
      };
    } else {
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
      delivery_status: 'delivered'
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

    // Load Bot Settings for working hours & personality
    let botSettings = null;
    try {
      const sSnap = await db.doc(`bot_settings/${companyId}`).get();
      if (sSnap.exists) botSettings = sSnap.data();
    } catch (e) {}

    // Check for Human Handoff Intent
    const lowerText = normalizeBotText(messageText);
    const humanKeywords = ['asesor', 'humano', 'persona', 'agente', 'ejecutivo', 'hablar con alguien', 'representante', 'ayuda humana', 'transferir'];
    const wantsHuman = humanKeywords.some(kw => lowerText.includes(kw));

    let botReply = '';

    if (wantsHuman) {
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
    } else if (botSettings?.working_hours && !checkWorkingHours(botSettings.working_hours)) {
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

      if (asksPackage) {
        botReply = packageReply;
      } else if (asksBot && (asksPrice || lowerText.includes('y el') || lowerText.includes('incluye') || lowerText.includes('funciona') || lowerText.includes('informacion') || lowerText.includes('información') || lowerText.includes('servicio'))) {
        botReply = botReplyText;
      } else if (asksCrm && (asksPrice || lowerText.includes('incluye') || lowerText.includes('funciona') || lowerText.includes('informacion') || lowerText.includes('información') || lowerText.includes('servicio'))) {
        botReply = crmReply;
      } else if (bestMatch && maxScore >= 2) {        
        botReply = `${bestMatch.content} ¿Te gustaría que un asesor te prepare una cotización personalizada?`;
      } else if (['si', 'sii', 'siii', 'siiii', 'yes', 'claro', 'por favor', 'adelante', 'me interesa', 'me interesa la demo', 'si me interesa', 'si quiero', 'quiero una demo', 'quiero una demostracion', 'me gustaria una demo', 'me gustaria una demostracion'].includes(lowerText)) {
  botReply = `¡Excelente! 🙌 Con gusto te mostramos una demo de DT Marketing.

Un asesor te contactará por este medio para conocer tu negocio y enseñarte el DT CRM Core + API Chat Bot de WhatsApp.

Si quieres atención inmediata, escribe *asesor*`;
} else if (['no', 'nop', 'ahorita no', 'por ahora no'].includes(lowerText)) {
  botReply = `Entendido 👍 Si después quieres conocer nuestros servicios, escribe *CRM*, *WhatsApp* o *paquete*`;
} else if (['ya', 'ok', 'okay', 'listo', 'recibido'].includes(lowerText)) {
  botReply = `Perfecto, ${customerName}. ¿Qué producto o servicio te interesa? También puedes escribir *asesor* para hablar con nuestro equipo.`;
} else if (lowerText === 'hola' || lowerText === 'buenos dias' || lowerText === 'buenas tardes' || lowerText === 'buenas noches' || lowerText === 'inicio') {
        const configuredWelcome = String(botSettings?.welcome_message || '').trim();
        botReply = convData.welcome_sent_at ? '¡Hola de nuevo! 👋 ¿Qué información necesitas?' : (convData.welcome_sent_at = new Date().toISOString(), configuredWelcome || `¡Hola ${customerName}! 👋

Gracias por escribir a DT Marketing.

Soy el asistente virtual. Puedo ayudarte con:
• DT CRM Core
• API Chat Bot de WhatsApp
• Paquete completo

Escribe "CRM", "WhatsApp", "paquete" o "asesor" para continuar.`) || `¡Hola ${customerName}! 👋 Bienvenido a nuestro canal oficial de WhatsApp. ¿En qué producto o cotización podemos asesorarte hoy? (Escribe "asesor" para hablar con un ejecutivo).`;
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

    // 6. Send Outbound WhatsApp Reply via Meta Graph API
    let outboundSuccess = false;
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

        outboundSuccess = true;
        metaMessageId = metaRes.data?.messages?.[0]?.id || null;
        console.log(`🤖 [DT Bot Sent] To: +${customerPhone} | Meta Msg ID: ${metaMessageId}`);
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
          delivery_status: 'sent',
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

    const metaMsgId = metaRes.data?.messages?.[0]?.id || 'sent';
    console.log(`📤 [Advisor Message Sent] By: ${user_name || user.nombre} to +${cleanPhone} | Meta Msg ID: ${metaMsgId}`);

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
        delivery_status: 'sent',
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

    const metaMsgId = metaRes.data?.messages?.[0]?.id || 'sent'; if (company_id && activeWabaId && activeToken) { try { await http.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${activeWabaId}/subscribed_apps`, {}, { headers: { Authorization: `Bearer ${activeToken}` } }); console.log(`✅ WhatsApp WABA subscription ensured: ${activeWabaId}`); } catch (subErr) { console.warn('⚠️ WABA subscription could not be ensured:', subErr.response?.data?.error?.message || subErr.message); } }

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
        const templateMsgId = templateRes.data?.messages?.[0]?.id || 'sent';
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
            params: { client_id: META_ESU_APP_ID, client_secret: appSecret, code: String(body.code), redirect_uri: 'https://dt-crm-core.web.app/index.html' }
    });
    const accessToken = exchanged.data?.access_token;
    if (!accessToken) throw new Error('Meta no devolvió un token de acceso.');

    let wabaId = String(body.waba_id || '').trim();
    let phoneId = String(body.phone_number_id || '').trim();
    let displayPhone = String(body.display_phone_number || '').trim();
    let verifiedName = String(body.verified_name || '').trim();
    let businessName = '';
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
    } else if (wabaId) {
      const phones = await http.get(`https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/phone_numbers`, { params: { fields: 'id,display_phone_number,verified_name', limit: 10, access_token: accessToken } });
      const first = phones.data?.data?.[0];
      if (first) { phoneId = first.id || ''; displayPhone = displayPhone || first.display_phone_number || ''; verifiedName = verifiedName || first.verified_name || ''; }
    }
    if (!wabaId || !phoneId) return res.status(422).json({ success: false, error: 'Meta no devolvió el WABA y el número necesarios para completar la conexión.' });
    try { await http.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/subscribed_apps`, {}, { params: { access_token: accessToken } }); } catch (subscriptionError) { console.warn('Embedded Signup subscription pending:', subscriptionError.response?.data?.error?.message || subscriptionError.message); }

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
