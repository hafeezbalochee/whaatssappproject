const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* ================= CONFIG ================= */
const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_COOLDOWN_MS = 5000;
let lastGeminiCall = 0;

app.get('/', (req, res) => res.send('Bot Status: Active ✅'));
app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT}`));

/* ================= SETUP ================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

let drive;
try {
    const driveAuth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_DRIVE_KEY),
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    drive = google.drive({ version: 'v3', auth: driveAuth });
} catch (e) { console.error("Check GOOGLE_DRIVE_KEY in Secrets"); }

/* ================= BOT LOGIC ================= */
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    // Fetch latest WA version to prevent 405 error
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📡 Using WhatsApp Version: ${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log('✨ NEW QR CODE GENERATED:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Connection Closed: ${code}`);
            if (code !== DisconnectReason.loggedOut) {
                setTimeout(() => startBot(), 5000);
            }
        }

        if (connection === 'open') console.log('✅ Connected Successfully!');
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        
        try {
            // Report logic (Example: report 20251227)
            if (text.toLowerCase().startsWith('report')) {
                const date = text.split(' ')[1];
                if (!date) return sock.sendMessage(jid, { text: "Usage: report YYYYMMDD" });

                const res = await drive.files.list({
                    q: `name='${date}.png' and trashed=false`,
                    fields: 'files(id, name)'
                });

                if (res.data.files.length > 0) {
                    const fileId = res.data.files[0].id;
                    const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
                    await sock.sendMessage(jid, { image: { url }, caption: `Report for ${date}` });
                } else {
                    await sock.sendMessage(jid, { text: "File not found." });
                }
                return;
            }

            // AI Logic
            const now = Date.now();
            if (now - lastGeminiCall > GEMINI_COOLDOWN_MS) {
                lastGeminiCall = now;
                const aiResult = await model.generateContent(text);
                await sock.sendMessage(jid, { text: aiResult.response.text() });
            }
        } catch (err) { console.error("Msg Error:", err); }
    });
}

startBot();
