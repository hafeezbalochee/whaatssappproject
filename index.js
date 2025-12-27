/* ================= IMPORTS ================= */
const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
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
app.get('/', (req, res) => res.send('Bot is running! ✅'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web Server active on port ${PORT}`));

/* ================= GOOGLE DRIVE SETUP ================= */
let drive;
try {
    const driveAuth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY),
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    drive = google.drive({ version: 'v3', auth: driveAuth });
} catch (e) {
    console.error("❌ Google Drive Key Error: Check your Secrets!");
}

/* ================= GEMINI AI SETUP ================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

/* ================= START BOT ================= */
async function startBot() {
    // 1. Setup Auth
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    // 2. Get Latest WA Version (Fixes 405 error)
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📡 Connecting with WhatsApp v${version.join('.')}`);

    // 3. Create Connection
    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'), // Using Desktop identification
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    /* ===== CONNECTION UPDATES ===== */
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log('--------------------------------------------');
            console.log('📸 SCAN THE QR CODE BELOW WITH WHATSAPP:');
            console.log('--------------------------------------------');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Connection Closed. Status: ${statusCode}`);
            
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔁 Attempting to reconnect...');
                setTimeout(() => startBot(), 5000);
            } else {
                console.log('🚫 Logged out. Delete "auth_info" and scan again.');
            }
        }

        if (connection === 'open') {
            console.log('✅ SUCCESS: WhatsApp is now connected!');
        }
    });

    /* ===== MESSAGE HANDLING ===== */
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg || msg.key.fromMe || !msg.message) return;

        const sender = msg.key.remoteJid;
        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || 
                     msg.message?.imageMessage?.caption || '';
        const lower = text.toLowerCase().trim();

        try {
            // --- REPORT LOGIC ---
            if (lower.startsWith('report')) {
                const match = lower.match(/report\s+(\d+)/);
                if (!match) {
                    return await sock.sendMessage(sender, { text: '📄 استعمال کریں: report 23122025' });
                }

                const fileName = `${match[1]}.png`;
                const res = await drive.files.list({
                    q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
                    fields: 'files(id,name)'
                });

                if (!res.data.files.length) {
                    return await sock.sendMessage(sender, { text: `❌ فائل ${fileName} نہیں ملی۔` });
                }

                const fileId = res.data.files[0].id;
                const imageUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
                await sock.sendMessage(sender, { 
                    image: { url: imageUrl }, 
                    caption: `📄 Surgery Report\n🗓 Date: ${match[1]}` 
                });
                return;
            }

            // --- GEMINI AI LOGIC ---
            const now = Date.now();
            if (now - lastGeminiCall < GEMINI_COOLDOWN_MS) return;

            lastGeminiCall = now;
            const result = await model.generateContent(text);
            const responseText = result.response.text();
            
            await sock.sendMessage(sender, { text: responseText });

        } catch (err) {
            console.error('Processing Error:', err.message);
            lastGeminiCall = 0;
        }
    });
}

/* ================= RUN ================= */
startBot().catch(err => console.error("Critical Startup Error:", err));
