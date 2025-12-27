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
app.get('/', (req, res) => res.send('Bot is alive ✅'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

/* ================= SELF PING ================= */
setInterval(async () => {
    try {
        if (process.env.REPLIT_APP_URL) {
            const res = await fetch(process.env.REPLIT_APP_URL);
            console.log('Self-ping OK:', res.status);
        }
    } catch (err) {
        console.error('Self-ping failed:', err.message);
    }
}, 4 * 60 * 1000);

/* ================= GOOGLE DRIVE SETUP ================= */
let drive;
try {
    const driveAuth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY),
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    drive = google.drive({ version: 'v3', auth: driveAuth });
} catch (e) {
    console.error("CRITICAL: Google Drive Key is missing or invalid in Secrets!");
}

/* ================= GEMINI AI SETUP ================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Fixed: Changed 'gemini-2.5-flash' to 'gemini-1.5-flash'
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

/* ================= START BOT ================= */
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: true // Built-in backup for QR display
    });

    sock.ev.on('creds.update', saveCreds);

    /* ===== CONNECTION UPDATE ===== */
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('👇 SCAN THE QR CODE BELOW 👇');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`❌ Connection Closed. Reason: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(() => startBot(), 5000);
            } else {
                console.log('🚫 Logged out. Please delete auth_info folder and restart.');
            }
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
        }
    });

    /* ===== MESSAGES HANDLING ===== */
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const lower = text.toLowerCase().trim();

        try {
            // 1. Report Logic
            if (lower.startsWith('report')) {
                const match = lower.match(/report\s+(\d+)/);
                if (!match) {
                    return await sock.sendMessage(sender, { text: '📄 استعمال کریں:\nreport 23122025' });
                }
                const fileName = `${match[1]}.png`;
                const res = await drive.files.list({
                    q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
                    fields: 'files(id,name)'
                });

                if (!res.data.files.length) {
                    return await sock.sendMessage(sender, { text: `❌ ${fileName} موجود نہیں ہے۔` });
                }
                const fileId = res.data.files[0].id;
                const imageUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
                await sock.sendMessage(sender, { image: { url: imageUrl }, caption: `📄 Surgery Report\n🗓 ${match[1]}` });
                return;
            }

            // 2. Gemini AI Logic
            const now = Date.now();
            if (now - lastGeminiCall < GEMINI_COOLDOWN_MS) return;

            lastGeminiCall = now;
            const result = await model.generateContent(text);
            const reply = result.response.text();
            await sock.sendMessage(sender, { text: reply });

        } catch (err) {
            console.error('Bot Error:', err);
            lastGeminiCall = 0;
        }
    });
}

// Start the process
startBot().catch(err => console.error("Startup Error:", err));
