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

/* ======= GEMINI COOLDOWN ======= */
let lastGeminiCall = 0;
const GEMINI_COOLDOWN_MS = 5000; // 5 seconds

/* ================= KEEP ALIVE ================= */
const app = express();
app.get('/', (req, res) => res.send('Bot Alive! 🔥'));
app.listen(process.env.PORT || 3000, () =>
    console.log('Keep-alive server running')
);

/* ================= GOOGLE DRIVE ================= */
const driveAuth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY),
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
});
const drive = google.drive({ version: 'v3', auth: driveAuth });
const FOLDER_ID = '1akYbGT5KZYe25hqTmy6nay1x77iozXZR';

/* ================= GEMINI ================= */
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

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp Connected');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    /* ================= MESSAGES ================= */
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg || msg.key.fromMe || m.type !== 'notify') return;

            const sender = msg.key.remoteJid;
            const text =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                '';

            /* ===== SURGERY REPORT (DATE BASED) ===== */
const lower = text.toLowerCase();

if (lower.startsWith('report')) {

    // Extract date from message
    const match = lower.match(/report\s+(\d{8})/);

    if (!match) {
        await sock.sendMessage(sender, {
            text: '📄 رپورٹ دیکھنے کے لیے لکھیں:\nreport 23122025'
        });
        return;
    }

    const dateStr = match[1]; // 23122025
    const fileName = `${dateStr}.png`;

    const res = await drive.files.list({
        q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
        fields: 'files(id,name)'
    });

    if (!res.data.files.length) {
        await sock.sendMessage(sender, {
            text: `❌ ${fileName} فولڈر میں موجود نہیں ہے۔`
        });
        return;
    }

    const fileId = res.data.files[0].id;
    const imageUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    await sock.sendMessage(sender, {
        image: { url: imageUrl },
        caption: `📄 Surgery Report\n🗓 Date: ${dateStr}`
    });

    console.log(`📤 Report sent: ${fileName}`);
    return;
}

             // ===== GEMINI ONLY FOR NORMAL CHAT =====
const now = Date.now();
if (now - lastGeminiCall < GEMINI_COOLDOWN_MS) {
    await sock.sendMessage(sender, {
        text: '⏳ AI تھوڑا مصروف ہے، چند سیکنڈ بعد دوبارہ کوشش کریں۔'
    });
    return;
}

lastGeminiCall = now;

try {
    const result = await model.generateContent(text);
    const reply = result.response.text();
    await sock.sendMessage(sender, { text: reply });
} catch (e) {
    console.error('Gemini error:', e.message);

    if (e.status === 429) {
        await sock.sendMessage(sender, {
            text: '⚠️ AI limit ختم ہو گئی ہے، تھوڑی دیر بعد دوبارہ کوشش کریں۔'
        });
    } else {
        await sock.sendMessage(sender, {
            text: '🤖 AI فی الحال دستیاب نہیں ہے۔'
        });
    }
}


startBot();           
