const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.get('/', (req, res) => res.send('Bot Alive! 🔥'));
app.listen(process.env.PORT || 3000, () => console.log('Server running'));

const driveAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY),
  scopes: ['https://www.googleapis.com/auth/drive.readonly']
});
const drive = google.drive({ version: 'v3', auth: driveAuth });
const FOLDER_ID = '1akYbGT5KZYe25hqTmy6nay1x77iozXZR';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

let lastGeminiCall = 0;
const COOLDOWN = 6000;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) return;
      if (code === 405 || code === 401) {
        console.log('Blocked by WhatsApp');
        return;
      }
      setTimeout(startBot, 10000);
    }
    if (connection === 'open') console.log('Connected!');
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const lower = text.toLowerCase().trim();

    try {
      if (lower.startsWith('report')) {
        const match = lower.match(/report\s+(\d{8})/);
        if (!match) return sock.sendMessage(sender, { text: 'استعمال: report 27122025' });

        const fileName = `${match[1]}.png`;
        const res = await drive.files.list({
          q: `'\( {FOLDER_ID}' in parents and name=' \){fileName}' and trashed=false`,
          fields: 'files(id)'
        });

        if (!res.data.files?.length) return sock.sendMessage(sender, { text: 'File نہیں ملا' });

        const imageUrl = `https://drive.google.com/uc?export=download&id=${res.data.files[0].id}`;
        await sock.sendMessage(sender, { image: { url: imageUrl }, caption: match[1] });
        return;
      }

      if (lower.startsWith('monthly report')) {
        const match = lower.match(/monthly report\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
        if (!match) return sock.sendMessage(sender, { text: 'استعمال: monthly report october 2025' });

        const month = match[1].charAt(0).toUpperCase() + match[1].slice(1);
        const year = match[2];
        const fileName = `Monthly_Report_\( {month}_ \){year}.xlsx`;

        const res = await drive.files.list({
          q: `'\( {FOLDER_ID}' in parents and name=' \){fileName}' and trashed=false`,
          fields: 'files(id)'
        });

        if (!res.data.files?.length) return sock.sendMessage(sender, { text: 'File نہیں ملا' });

        const fileUrl = `https://drive.google.com/uc?export=download&id=${res.data.files[0].id}`;
        await sock.sendMessage(sender, { document: { url: fileUrl }, fileName });
        return;
      }

      if (Date.now() - lastGeminiCall < COOLDOWN) return sock.sendMessage(sender, { text: 'Wait' });
      lastGeminiCall = Date.now();

      const result = await model.generateContent(text);
      await sock.sendMessage(sender, { text: result.response.text() });

    } catch (err) {
      console.error(err);
    }
  });
}

startBot();
