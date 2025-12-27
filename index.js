/* ================= IMPORTS ================= */
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* ================= CONFIG ================= */
const GEMINI_COOLDOWN_MS = 5000;
let lastGeminiCall = 0;
const FOLDER_ID = '1akYbGT5KZYe25hqTmy6nay1x77iozXZR';

/* ================= KEEP-ALIVE SERVER ================= */
const app = express();

app.get('/', (req, res) => {
  res.send('Bot is alive ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

/* ================= SELF PING ================= */
// Set this in Replit Secrets:
// REPLIT_APP_URL = https://whaatssappproject--hafeezbalochee.replit.app

setInterval(async () => {
  try {
    const res = await fetch(process.env.REPLIT_APP_URL);
    console.log('Self-ping OK:', res.status);
  } catch (err) {
    console.error('Self-ping failed:', err.message);
  }
}, 4 * 60 * 1000);


/* ================= GOOGLE DRIVE SETUP ================= */
const driveAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY),
  scopes: ['https://www.googleapis.com/auth/drive.readonly']
});
const drive = google.drive({ version: 'v3', auth: driveAuth });

/* ================= GEMINI AI SETUP ================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

/* ================= START BOT ================= */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome')
  });

  sock.ev.on('creds.update', saveCreds);

  /* ===== CONNECTION ===== */
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
    if (shouldReconnect) {
        console.log('🔁 Reconnecting in 5 seconds...');
        setTimeout(() => {
            startBot();
        }, 5000); // wait 5 seconds before reconnecting
    }
}

    if (connection === 'open') {
      console.log('✅ WhatsApp Connected');
    }
  });

  /* ===== MESSAGES ===== */
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const lower = text.toLowerCase().trim();

    try {
      /* ===== DAILY REPORT ===== */
      if (lower.startsWith('report')) {
        const match = lower.match(/report\s+(\d{8})/);
        if (!match) {
          await sock.sendMessage(sender, { text: '📄 استعمال کریں:\nreport 23122025' });
          return;
        }

        const fileName = `${match[1]}.png`;
        const res = await drive.files.list({
          q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
          fields: 'files(id,name)'
        });

        if (!res.data.files.length) {
          await sock.sendMessage(sender, { text: `❌ ${fileName} موجود نہیں ہے۔` });
          return;
        }

        const fileId = res.data.files[0].id;
        const imageUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
        await sock.sendMessage(sender, { image: { url: imageUrl }, caption: `📄 Surgery Report\n🗓 ${match[1]}` });
        return;
      }

      /* ===== MONTHLY REPORT ===== */
      if (lower.startsWith('monthly report')) {
        const match = lower.match(/monthly report\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/);
        if (!match) {
          await sock.sendMessage(sender, { text: '📊 استعمال کریں:\nmonthly report november 2025' });
          return;
        }

        const fileName = `Monthly_Report_${match[1]}_${match[2]}.xlsx`;
        const res = await drive.files.list({
          q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
          fields: 'files(id,name)'
        });

        if (!res.data.files.length) {
          await sock.sendMessage(sender, { text: `❌ ${fileName} موجود نہیں ہے۔` });
          return;
        }

        const fileId = res.data.files[0].id;
        const fileUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
        await sock.sendMessage(sender, {
          document: { url: fileUrl },
          mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileName,
          caption: `📊 Monthly Report\n${match[1].toUpperCase()} ${match[2]}`
        });
        return;
      }

      /* ===== GEMINI AI RESPONSE ===== */
      const now = Date.now();
      if (now - lastGeminiCall < GEMINI_COOLDOWN_MS) {
        await sock.sendMessage(sender, { text: '⏳ AI تھوڑی دیر بعد دستیاب ہو گا۔' });
        return;
      }

      lastGeminiCall = now;
      const result = await model.generateContent(text);
      const reply = result.response.text();
      await sock.sendMessage(sender, { text: reply });

    } catch (err) {
      console.error('Message error:', err);
      lastGeminiCall = 0;
      await sock.sendMessage(sender, { text: '❌ کوئی خرابی پیش آ گئی ہے۔' });
    }
  });
}

/* ================= RUN BOT ================= */
startBot();
