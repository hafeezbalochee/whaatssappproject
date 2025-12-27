/* ================= IMPORTS ================= */
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* ================= WEB SERVER (KEEP-ALIVE) ================= */
const app = express();
app.get('/', (req, res) => res.send('Bot Status: Active ✅'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server active on port ${PORT}`));

/* ================= GOOGLE DRIVE SETUP ================= */
let drive;
try {
    const driveAuth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY),
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    drive = google.drive({ version: 'v3', auth: driveAuth });
} catch (e) {
    console.error("❌ GOOGLE_DRIVE_KEY error. Check your environment variables.");
}
const FOLDER_ID = '1akYbGT5KZYe25hqTmy6nay1x77iozXZR';

/* ================= GEMINI AI SETUP ================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
let lastGeminiCall = 0;
const COOLDOWN = 6000; // 6 seconds

/* ================= MAIN BOT LOGIC ================= */
async function startBot() {
    // 1. Setup Authentication State
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    // 2. Initialize Socket with 405 Fix
    const sock = makeWASocket({
        // MANUAL VERSION OVERRIDE: Essential fix for "405 Method Not Allowed" in late 2025
        version: [2, 3000, 1015901307], 
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'), // More stable than 'Chrome' on servers
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    /* ===== CONNECTION UPDATES ===== */
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('✨ New QR Code Generated:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Connection Closed. Status: ${code}`);

            // If not logged out, attempt to reconnect
            if (code !== DisconnectReason.loggedOut) {
                console.log('🔁 Reconnecting in 10 seconds...');
                setTimeout(startBot, 10000);
            } else {
                console.log('🚫 Logged Out. Delete "auth_info" and scan again.');
            }
        }

        if (connection === 'open') {
            console.log('✅ Connected Successfully to WhatsApp!');
        }
    });

    /* ===== MESSAGE HANDLING ===== */
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const lower = text.toLowerCase().trim();

        try {
            // 1. DAILY REPORT LOGIC
            if (lower.startsWith('report')) {
                const match = lower.match(/report\s+(\d{8})/);
                if (!match) return sock.sendMessage(sender, { text: '📝 استعمال کریں: report 27122025' });

                const fileName = `${match[1]}.png`;
                const res = await drive.files.list({
                    q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
                    fields: 'files(id)'
                });

                if (!res.data.files?.length) return sock.sendMessage(sender, { text: `❌ رپورٹ ${match[1]} نہیں ملی۔` });

                const imageUrl = `https://drive.google.com/uc?export=download&id=${res.data.files[0].id}`;
                await sock.sendMessage(sender, { 
                    image: { url: imageUrl }, 
                    caption: `📄 Surgery Report: ${match[1]}` 
                });
                return;
            }

            // 2. MONTHLY REPORT LOGIC
            if (lower.startsWith('monthly report')) {
                const match = lower.match(/monthly report\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
                if (!match) return sock.sendMessage(sender, { text: '📊 استعمال کریں: monthly report october 2025' });

                const month = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
                const year = match[2];
                const fileName = `Monthly_Report_${month}_${year}.xlsx`;

                const res = await drive.files.list({
                    q: `'${FOLDER_ID}' in parents and name='${fileName}' and trashed=false`,
                    fields: 'files(id)'
                });

                if (!res.data.files?.length) return sock.sendMessage(sender, { text: `❌ ${month} ${year} کی رپورٹ نہیں ملی۔` });

                const fileUrl = `https://drive.google.com/uc?export=download&id=${res.data.files[0].id}`;
                await sock.sendMessage(sender, { 
                    document: { url: fileUrl }, 
                    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    fileName: fileName,
                    caption: `📊 Monthly Summary: ${month} ${year}`
                });
                return;
            }

            // 3. AI CHAT LOGIC (GEMINI)
            const now = Date.now();
            if (now - lastGeminiCall < COOLDOWN) {
                return; // Silence if within cooldown to avoid spam
            }

            lastGeminiCall = now;
            const result = await model.generateContent(text);
            const aiReply = result.response.text();
            await sock.sendMessage(sender, { text: aiReply });

        } catch (err) {
            console.error('Message Processing Error:', err.message);
        }
    });
}

// Start the process
startBot().catch(err => console.error("Critical Startup Error:", err));
