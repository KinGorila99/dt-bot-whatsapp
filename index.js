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
