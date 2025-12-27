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
const fetch = require('node-fetch'); // keep-alive کے لیے

/* ================= KEEP-ALIVE SERVER (Render/Railway کے لیے) ================= */
const app = express();
app.get('/', (req, res) => res.send('Bot is Alive! 🔥'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Keep-alive server running on port ${PORT}`);
});

/* ================= SELF PING TO AVOID SLEEP (Render free tier) ================= */
setInterval(() => {
    fetch(`https://whatsappproject.onrender.com`)
        .then(() => console.log('Self-ping successful'))
        .catch(() => console.log('Self-ping failed'));
}, 240000); // ہر 4 منٹ میں پنگ

/* ================= GOOGLE DRIVE SETUP ================= */
const driveAuth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY),
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
});
const drive = google.drive({ version: 'v3', auth: driveAuth });
const FOLDER_ID = '1akYbGT5KZYe25hqTmy6nay1x77iozXZR'; // تمہارا folder ID

/* ================= GEMINI AI SETUP ================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

/* ================= GEMINI COOLDOWN ================= */
let lastGeminiCall = 0;
const GEMINI_COOLDOWN_MS = 6000; // 6 seconds

/* ================= START BOT ================= */
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    /* ===== CONNECTION UPDATE ===== */
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('QR Code generated – scan it fast!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log('Connection closed! Status:', statusCode);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('Logged out – نیا QR کے لیے auth_info delete کر کے redeploy کر لو');
                return;
            }

            if (statusCode === 405 || statusCode === 401) {
                console.log('WhatsApp block (405/401) – نیا number استعمال کر لو یا 24 گھنٹے wait');
                return; // reconnect نہ کریں
            }

            // دیگر cases میں ایک بار reconnect
            console.log('Reconnecting in 15 seconds...');
            setTimeout(startBot, 15000);
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
        }
    });

    /* ===== MESSAGE HANDLER ===== */
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const lower = text.toLowerCase().trim();

        try {
            /* ===== DAILY REPORT ===== */
            if (lower.startsWith('report')) {
                const match = lower.match(/report\s+(\d{8})/);
                if (!match) {
                    await sock.sendMessage(sender, { text: 'استعمال: report 27122025' });
                    return;
                }
                const fileName = `${match[1]}.png`;
                const res = await drive.files.list({
                    q: `'\( {FOLDER_ID}' in parents and name=' \){fileName}' and trashed=false`,
                    fields: 'files(id, name)'
                });

                if (!res.data.files || res.data.files.length === 0) {
                    await sock.sendMessage(sender, { text: `❌ ${fileName} موجود نہیں۔` });
                    return;
                }

                const fileId = res.data.files[0].id;
                const imageUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

                await sock.sendMessage(sender, {
                    image: { url: imageUrl },
                    caption: `📄 Daily Report\n🗓 ${match[1]}`
                });
                return;
            }

            /* ===== MONTHLY REPORT ===== */
            if (lower.startsWith('monthly report')) {
                const match = lower.match(/monthly report\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
                if (!match) {
                    await sock.sendMessage(sender, { text: 'استعمال: monthly report october 2025' });
                    return;
                }
                const month = match[1].charAt(0).toUpperCase() + match[1].slice(1);
                const year = match[2];
                const fileName = `Monthly_Report_\( {month}_ \){year}.xlsx`;

                const res = await drive.files.list({
                    q: `'\( {FOLDER_ID}' in parents and name=' \){fileName}' and trashed=false`,
                    fields: 'files(id, name)'
                });

                if (!res.data.files || res.data.files.length === 0) {
                    await sock.sendMessage(sender, { text: `❌ ${fileName} موجود نہیں۔` });
                    return;
                }

                const fileId = res.data.files[0].id;
                const fileUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

                await sock.sendMessage(sender, {
                    document: { url: fileUrl },
                    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    fileName: fileName,
                    caption: `📊 Monthly Report\n\( {month} \){year}`
                });
                return;
            }

            /* ===== GEMINI AI REPLY ===== */
            const now = Date.now();
            if (now - lastGeminiCall < GEMINI_COOLDOWN_MS) {
                await sock.sendMessage(sender, { text: '⏳ Gemini تھوڑی دیر میں جواب دے گا۔' });
                return;
            }
            lastGeminiCall = now;

            const result = await model.generateContent(text);
            const reply = result.response.text();

            await sock.sendMessage(sender, { text: reply });

        } catch (err) {
            console.error('Error:', err);
            await sock.sendMessage(sender, { text: '❌ کوئی خرابی آ گئی۔' });
        }
    });
}

/* ================= RUN BOT ================= */
startBot().catch(err => console.error('Bot crash:', err));
