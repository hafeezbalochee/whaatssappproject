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

/* ================= KEEP ALIVE SERVER ================= */
const app = express();
app.get('/', (req, res) => res.send('Bot is Alive! 🔥'));
app.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Keep-alive server running on port', process.env.PORT || 3000);
});

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

/* ================= COOLDOWN FOR GEMINI ================= */
let lastGeminiCall = 0;
const GEMINI_COOLDOWN_MS = 5000; // 5 seconds

/* ================= START BOT ================= */
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: true // QR console میں print کرے گا
    });

    sock.ev.on('creds.update', saveCreds);

    /* ===== CONNECTION UPDATE ===== */
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('QR Code generated – scan it!');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed!', lastDisconnect?.error?.output?.statusCode);
            if (shouldReconnect) {
                console.log('Reconnecting...');
                startBot();
            } else {
                console.log('Logged out – delete auth_info folder and restart for new QR');
            }
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
                    await sock.sendMessage(sender, { text: '📄 استعمال: report 31122025' });
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
                    caption: `📄 Daily Surgery Report\n🗓 ${match[1]}`
                });
                return;
            }

            /* ===== MONTHLY REPORT ===== */
            if (lower.startsWith('monthly report')) {
                const match = lower.match(/monthly report\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
                if (!match) {
                    await sock.sendMessage(sender, { text: '📊 استعمال: monthly report october 2025' });
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
                await sock.sendMessage(sender, { text: '⏳ Gemini تھوڑی دیر میں دستیاب ہوگا۔' });
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
startBot().catch(err => console.error('Bot start error:', err));
