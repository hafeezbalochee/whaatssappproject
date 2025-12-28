const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- 1. Express Server Setup for Railway ---
const app = express();
app.get('/', (req, res) => res.send('Bot is online and running! 🚀'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Health check server running on port ${PORT}`));

// --- 2. External API Configurations ---
// Fixed FOLDER_ID: Removed curly braces which cause API errors
const FOLDER_ID = '1akYbGT5KZYe25hqTmy6nay1x77iozXZR';

const driveAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY || '{}'),
  scopes: ['https://www.googleapis.com/auth/drive.readonly']
});
const drive = google.drive({ version: 'v3', auth: driveAuth });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

let lastGeminiCall = 0;
const COOLDOWN = 6000;

// --- 3. Main Bot Logic ---
async function startBot() {
  // Fix for 405 error: Always fetch and use the latest WhatsApp version
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Connecting with WhatsApp v${version.join('.')} (Latest: ${isLatest})`);

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    version, // Crucial: This prevents the 405 Method Not Allowed error
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'open') {
      console.log('✅ WhatsApp Bot Connected Successfully!');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      const errorCode = lastDisconnect?.error?.output?.statusCode;

      if (errorCode === 405) {
        console.log('⚠️ Status 405 detected: WhatsApp has flagged this session. Waiting 1 hour before retry.');
        // Stop the loop for an hour to avoid a permanent ban
        setTimeout(startBot, 3600000); 
      } else if (shouldReconnect) {
        console.log('🔄 Connection lost. Reconnecting in 10 seconds...');
        setTimeout(startBot, 10000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const lower = text.toLowerCase().trim();

    try {
      // 📊 Report Command
      if (lower.startsWith('report')) {
        const match = lower.match(/report\s+(\d+)/);
        if (!match) return sock.sendMessage(sender, { text: 'استعمال: report 27122025' });

        const fileName = `${match[1]}.png`;
        const res = await drive.files.list({
          q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
          fields: 'files(id)'
        });

        if (!res.data.files?.length) return sock.sendMessage(sender, { text: 'Report موجود نہیں' });

        const imageUrl = `https://drive.google.com/uc?export=download&id=${res.data.files[0].id}`;
        await sock.sendMessage(sender, { image: { url: imageUrl }, caption: `Report ${match[1]}` });
        return;
      }

      // 📅 Monthly Report Command
      if (lower.startsWith('monthly report')) {
        const match = lower.match(/monthly report\s+([a-zA-Z]+)\s+(\d{4})/i);
        if (!match) return sock.sendMessage(sender, { text: 'استعمال: monthly report october 2025' });

        const month = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
        const year = match[2];
        const fileName = `Monthly_Report_${month}_${year}.xlsx`;

        const res = await drive.files.list({
          q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
          fields: 'files(id)'
        });

        if (!res.data.files?.length) return sock.sendMessage(sender, { text: `Monthly report (${month} ${year}) موجود نہیں` });

        const fileUrl = `https://drive.google.com/uc?export=download&id=${res.data.files[0].id}`;
        await sock.sendMessage(sender, { document: { url: fileUrl }, fileName: fileName, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        return;
      }

      // 🤖 Gemini AI Response
      if (Date.now() - lastGeminiCall < COOLDOWN) return; // Silent cooldown
      lastGeminiCall = Date.now();

      const result = await model.generateContent(text);
      const reply = result.response.text();
      await sock.sendMessage(sender, { text: reply });

    } catch (err) {
      console.error('Execution Error:', err);
    }
  });
}

// Start the bot
startBot();
