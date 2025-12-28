const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const QRCode = require('qrcode');
const express = require('express');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --------------------
// WEB SERVER (REPLIT)
// --------------------
const app = express();
let latestQR = null;

app.get('/', (req, res) => {
  res.send(`
    <h2>WhatsApp AI Bot</h2>
    <p>Status: Running</p>
    <p>QR: <a href="/qr" target="_blank">Open QR Code</a></p>
  `);
});

app.get('/qr', async (req, res) => {
  if (!latestQR) {
    return res.send('QR not generated yet. Wait...');
  }

  const qrImage = await QRCode.toDataURL(latestQR, {
    width: 400,
    margin: 2
  });

  res.send(`
    <h2>Scan QR Code</h2>
    <img src="${qrImage}" />
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

// --------------------
// GOOGLE APIs
// --------------------
const FOLDER_ID = '1akYbGT5KZYe25hqTmy6nay1x77iozXZR';

const driveAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY || '{}'),
  scopes: ['https://www.googleapis.com/auth/drive.readonly']
});

const drive = google.drive({ version: 'v3', auth: driveAuth });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

let lastGeminiCall = 0;
const COOLDOWN = 6000;

// --------------------
// WHATSAPP BOT
// --------------------
async function startBot() {
  const { version } = await fetchLatestBaileysVersion();
  console.log(`Starting WhatsApp v${version.join('.')}`);

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 15000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      console.log('📲 QR GENERATED');
      console.log('➡ Open /qr in browser to scan');
    }

    if (connection === 'open') {
      latestQR = null;
      console.log('✅ WhatsApp Connected');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`❌ Disconnected: ${code}`);

      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startBot, 30000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    try {
      if (Date.now() - lastGeminiCall < COOLDOWN) return;
      lastGeminiCall = Date.now();

      const result = await model.generateContent(text);
      await sock.sendMessage(jid, { text: result.response.text() });
    } catch (err) {
      console.error('Bot Error:', err.message);
    }
  });
}

startBot();
