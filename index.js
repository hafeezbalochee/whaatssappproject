const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

// ===============================
// 1️⃣ Express Health Check (Railway)
// ===============================
const app = express();
app.get('/', (req, res) => res.send('WhatsApp AI Bot is Running 🚀'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is live on port ${PORT}`);
});

// ===============================
// 2️⃣ Google Drive Setup
// ===============================
const FOLDER_ID = '1akYbGT5KZYe25hqTmy6nay1x77iozXZR';

const driveAuth = new google.auth.GoogleAuth({
  credentials: process.env.GOOGLE_DRIVE_KEY
    ? JSON.parse(process.env.GOOGLE_DRIVE_KEY)
    : undefined,
  scopes: ['https://www.googleapis.com/auth/drive.readonly']
});

const drive = google.drive({
  version: 'v3',
  auth: driveAuth
});

// ===============================
// 3️⃣ Gemini AI Setup
// ===============================
if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY not set');
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

let lastGeminiCall = 0;
const COOLDOWN = 6000;

// ===============================
// 4️⃣ WhatsApp Bot
// ===============================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: state.keys
    },
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 Scan this QR code');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Connected to WhatsApp');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ Connection closed. Reason: ${code}`);

      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconnecting in 10 seconds...');
        setTimeout(startBot, 10000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    const lower = text.toLowerCase().trim();

    try {
      // ===============================
      // 📄 Daily Report
      // ===============================
      if (lower.startsWith('report')) {
        const match = lower.match(/report\s+(\d+)/);
        if (!match) {
          await sock.sendMessage(jid, { text: 'Usage: report 27122025' });
          return;
        }

        const fileName = `${match[1]}.png`;

        const res = await drive.files.list({
          q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
          fields: 'files(id)'
        });

        if (!res.data.files.length) {
          await sock.sendMessage(jid, { text: 'Report not found' });
          return;
        }

        const imageUrl = `https://drive.google.com/uc?export=download&id=${res.data.files[0].id}`;
        await sock.sendMessage(jid, {
          image: { url: imageUrl },
          caption: `Report: ${match[1]}`
        });
        return;
      }

      // ===============================
      // 📊 Monthly Report
      // ===============================
      if (lower.startsWith('monthly report')) {
        const match = lower.match(/monthly report\s+([a-zA-Z]+)\s+(\d{4})/);
        if (!match) {
          await sock.sendMessage(jid, {
            text: 'Usage: monthly report October 2025'
          });
          return;
        }

        const month =
          match[1].charAt(0).toUpperCase() +
          match[1].slice(1).toLowerCase();
        const year = match[2];
        const fileName = `Monthly_Report_${month}_${year}.xlsx`;

        const res = await drive.files.list({
          q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
          fields: 'files(id)'
        });

        if (!res.data.files.length) {
          await sock.sendMessage(jid, {
            text: `Monthly report (${month} ${year}) not found`
          });
          return;
        }

        const fileUrl = `https://drive.google.com/uc?export=download&id=${res.data.files[0].id}`;

        await sock.sendMessage(jid, {
          document: { url: fileUrl },
          fileName,
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
        return;
      }

      // ===============================
      // 🤖 Gemini AI Chat
      // ===============================
      if (Date.now() - lastGeminiCall < COOLDOWN) return;
      lastGeminiCall = Date.now();

      const result = await model.generateContent(text);
      const reply = result.response.text();

      await sock.sendMessage(jid, { text: reply });

    } catch (err) {
      console.error('Bot Error:', err);
    }
  });
}

// ===============================
// 5️⃣ Start Bot
// ===============================
startBot().catch((err) => {
  console.error('Startup Error:', err);
});

