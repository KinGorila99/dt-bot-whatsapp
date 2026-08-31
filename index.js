/**
 * DT Bot Core & DT CRM Core — Native WhatsApp Cloud API Server
 * Built by DT Marketing
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin (uses default credentials or service account)
if (!admin.apps.length) {
  try {
    admin.initializeApp();
  } catch (e) {
    console.log('Firebase Admin initialized without default service account credentials.');
  }
}

const db = admin.apps.length ? admin.firestore() : null;

// Master verify token for Meta Webhook setup
const MASTER_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'dt_crm_whatsapp_verify_token_2026';
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v19.0';

/**
 * HEALTH CHECK
 */
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'DT Bot Core — WhatsApp Cloud API Server',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

/**
 * 1. META WEBHOOK VERIFICATION HANDSHAKE
 * Configure in Meta for Developers:
 * Callback URL: https://your-server-domain.com/webhook/whatsapp
 * Verify Token: dt_crm_whatsapp_verify_token_2026
 */
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && (token === MASTER_VERIFY_TOKEN || (token && token.startsWith('dt_')))) {
    console.log('✅ Meta Webhook verified successfully by challenge handshake.');
    return res.status(200).send(challenge);
  }

  console.warn('❌ Meta Webhook verification failed. Invalid Verify Token:', token);
  return res.status(403).send('Forbidden: Invalid Verify Token');
});

/**
 * 2. RECEIVE META WHATSAPP EVENTS (INCOMING MESSAGES)
 */
app.post('/webhook/whatsapp', async (req, res) => {
  // Acknowledge Meta immediately with HTTP 200
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (!body || body.object !== 'whatsapp_business_account') {
      return;
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value || !value.messages || value.messages.length === 0) {
      // Status update (delivered, read, sent)
      return;
    }

    const message = value.messages[0];
    const contact = value.contacts?.[0];
    const metadata = value.metadata;

    const phoneNumberId = metadata?.phone_number_id;
    const customerPhone = message.from;
    const customerName = contact?.profile?.name || `WhatsApp User (+${customerPhone})`;
    const messageText = message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
    const messageId = message.id;
    const timestamp = message.timestamp ? new Date(parseInt(message.timestamp) * 1000).toISOString() : new Date().toISOString();

    console.log(`📥 Incoming WhatsApp message from ${customerName} (+${customerPhone}): "${messageText}"`);

    // 1. Identify Company / Tenant
    let companyId = 'comp_dt_marketing';
    let accessToken = process.env.META_WHATSAPP_TOKEN || null;

    if (db && phoneNumberId) {
      const intSnap = await db.collection('integrations')
        .where('phone_number_id', '==', phoneNumberId)
        .where('status', '==', 'connected')
        .limit(1)
        .get();

      if (!intSnap.empty) {
        const intDoc = intSnap.docs[0].data();
        companyId = intDoc.company_id;
        
        // Retrieve secret token if present
        const secDoc = await db.doc(`integrations/${intSnap.docs[0].id}/secrets/tokens`).get();
        if (secDoc.exists && secDoc.data().access_token) {
          accessToken = secDoc.data().access_token;
        }
      }
    }

    // 2. Lead Deduplication & Registration in Firestore
    let leadId = null;
    if (db) {
      const cleanPhoneDigits = customerPhone.replace(/[^0-9]/g, '');
      const leadSnap = await db.collection('leads')
        .where('company_id', '==', companyId)
        .get();

      let existingLead = null;
      for (const doc of leadSnap.docs) {
        const lData = doc.data();
        const lDigits = (lData.telefono || '').replace(/[^0-9]/g, '');
        if (lDigits && lDigits.slice(-8) === cleanPhoneDigits.slice(-8)) {
          existingLead = { id: doc.id, ...lData };
          leadId = doc.id;
          break;
        }
      }

      if (!existingLead) {
        leadId = `lead_wa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        await db.doc(`leads/${leadId}`).set({
          id: leadId,
          company_id: companyId,
          nombre: customerName,
          telefono: customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`,
          correo: `${customerPhone}@whatsapp.com`,
          empresa: 'Contacto WhatsApp Directo',
          servicio: 'Atención Inmediata',
          fuente: 'WhatsApp',
          estado: 'Nuevo Lead',
          responsable: 'DT Bot Core',
          prioridad: 'Alta',
          valor_estimado: 8500,
          notas: `Conversación iniciada por WhatsApp Cloud API.\nMensaje inicial: "${messageText}"`,
          fecha_creacion: timestamp,
          ultima_actividad: timestamp
        });
      } else {
        await db.doc(`leads/${leadId}`).update({
          ultima_actividad: timestamp
        });
      }

      // 3. Record Conversation & Inbound Message
      const convId = `conv_${companyId}_whatsapp_${customerPhone}`;
      const convRef = db.doc(`conversations/${convId}`);
      const convDoc = await convRef.get();

      const convData = convDoc.exists ? convDoc.data() : {
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
        created_at: timestamp
      };

      const inMsgId = `msg_${Date.now()}_in`;
      await db.doc(`messages/${inMsgId}`).set({
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
      });

      // 4. DT Bot Core Conversational Engine Evaluation
      const lowerText = messageText.toLowerCase().trim();
      const humanHandoffKeywords = ['asesor', 'humano', 'persona', 'agente', 'hablar con alguien', 'ejecutivo', 'soporte humano'];
      const wantsHuman = humanHandoffKeywords.some(kw => lowerText.includes(kw));

      let botReply = '';

      if (wantsHuman) {
        // Human Handoff trigger
        convData.human_handoff = true;
        convData.bot_enabled = false;
        convData.status = 'pending';
        botReply = `Entendido, ${customerName}. He transferido tu conversación a uno de nuestros asesores comerciales. En unos instantes un especialista te responderá directamente aquí.`;

        // Register urgent task for the sales team
        await db.collection('followups').add({
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
        });
      } else if (convData.bot_enabled && !convData.human_handoff) {
        // Query Knowledge Base for Company
        const kbSnap = await db.collection('knowledge_base')
          .where('company_id', '==', companyId)
          .where('enabled', '==', true)
          .get();

        let matchedAnswer = null;
        for (const doc of kbSnap.docs) {
          const item = doc.data();
          const keywords = item.keywords || [];
          const matchesKeyword = keywords.some(k => lowerText.includes(k.toLowerCase().trim()));
          if (matchesKeyword || lowerText.includes(item.title.toLowerCase())) {
            matchedAnswer = item.content;
            break;
          }
        }

        if (matchedAnswer) {
          botReply = matchedAnswer;
        } else if (!convDoc.exists) {
          // First time greeting
          botReply = `¡Hola ${customerName}! 👋 Bienvenido a nuestro canal oficial de WhatsApp. ¿En qué producto o servicio te gustaría que te asesoremos hoy?`;
        } else {
          // General friendly fallback with menu
          botReply = `Gracias por tu mensaje. Para brindarte la información exacta, puedes preguntarme sobre nuestros servicios, cotizaciones o escribir "asesor" si deseas que un ejecutivo te contacte.`;
        }
      }

      // 5. Send Outbound Bot Response via Meta Graph API
      if (botReply && accessToken && phoneNumberId) {
        try {
          await axios.post(
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

          console.log(`🤖 Bot answered to +${customerPhone}: "${botReply}"`);

          // Record Outbound Message in Firestore
          const outMsgId = `msg_${Date.now()}_out`;
          await db.doc(`messages/${outMsgId}`).set({
            id: outMsgId,
            company_id: companyId,
            conversation_id: convId,
            direction: 'outbound',
            channel: 'whatsapp',
            content: botReply,
            sender_type: 'bot',
            created_at: new Date().toISOString(),
            delivery_status: 'sent'
          });

          convData.last_message = botReply;
          convData.last_message_sender = 'bot';
          convData.last_message_at = new Date().toISOString();
        } catch (apiErr) {
          console.error('Error sending WhatsApp Cloud API reply:', apiErr.response?.data || apiErr.message);
        }
      }

      // Save updated conversation state
      convData.updated_at = new Date().toISOString();
      await convRef.set(convData, { merge: true });
    }

  } catch (err) {
    console.error('Error in WhatsApp Webhook handler:', err);
  }
});

/**
 * 3. AGENT OUTBOUND DISPATCH ENDPOINT
 * Used by CRM Advisors when replying from the Inbox
 */
app.post('/api/send-message', async (req, res) => {
  const { phone_number_id, access_token, to_phone, message_text, company_id, conversation_id, user_name } = req.body;

  if (!to_phone || !message_text) {
    return res.status(400).json({ success: false, error: 'Missing to_phone or message_text' });
  }

  const cleanPhone = to_phone.replace(/[^0-9]/g, '');
  const activePhoneNumberId = phone_number_id || process.env.META_PHONE_NUMBER_ID;
  const activeToken = access_token || process.env.META_WHATSAPP_TOKEN;

  if (!activePhoneNumberId || !activeToken) {
    return res.status(400).json({
      success: false,
      error: 'WhatsApp Cloud API credentials not configured (phone_number_id / access_token)'
    });
  }

  try {
    const metaRes = await axios.post(
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

    console.log(`📤 Advisor (${user_name || 'Agente'}) sent message to +${cleanPhone}: "${message_text}"`);

    // Record in Firestore if available
    if (db && conversation_id && company_id) {
      const msgId = `msg_${Date.now()}_agent`;
      await db.doc(`messages/${msgId}`).set({
        id: msgId,
        company_id: company_id,
        conversation_id: conversation_id,
        direction: 'outbound',
        channel: 'whatsapp',
        content: message_text,
        sender_type: 'agent',
        user_name: user_name || 'Asesor',
        created_at: new Date().toISOString(),
        delivery_status: 'sent'
      });

      await db.doc(`conversations/${conversation_id}`).set({
        last_message: message_text,
        last_message_sender: 'agent',
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { merge: true });
    }

    return res.status(200).json({
      success: true,
      meta_response: metaRes.data
    });

  } catch (err) {
    console.error('Error in agent send message:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});

/**
 * 4. DIAGNOSTIC TEST ENDPOINT
 */
app.post('/api/test-message', async (req, res) => {
  const { phone_number_id, access_token, to_phone, message_text } = req.body;

  if (!phone_number_id || !access_token || !to_phone) {
    return res.status(400).json({
      success: false,
      error: 'Missing phone_number_id, access_token, or to_phone'
    });
  }

  const cleanPhone = to_phone.replace(/[^0-9]/g, '');

  try {
    const metaRes = await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${phone_number_id}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: { preview_url: false, body: message_text || 'Prueba de diagnóstico exitosa desde DT CRM Core.' }
      },
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.status(200).json({
      success: true,
      meta_response: metaRes.data
    });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 DT Bot Core WhatsApp Cloud API Server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook/whatsapp`);
});
