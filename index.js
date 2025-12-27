const fs = require('fs');
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
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- AUTO-CLEANUP (Fixes 405 error without Shell) ---
// This deletes the session if it's corrupted, so a new QR generates
const SESSION_PATH = './auth_info';
function clearSession() {
    if (fs.existsSync(SESSION_PATH)) {
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        console.log("🧹 Old session cleared to fix connection...");
    }
}

/* ================= KEEP-ALIVE ================= */
const app = express();
app.get('/', (req, res) => res.send('Bot is running! ✅'));
app.listen(process.env.PORT || 3000);

/* ================= START BOT ================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    
    // Fallback WA version to bypass "405 Method Not Allowed"
    const waVersion = [2, 3000, 1015901307];

    const sock = makeWASocket({
        version: waVersion,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log('📸 SCAN THIS QR CODE:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Closed: ${statusCode}`);

            // If it's a 405 or bad session, we clear and restart
            if (statusCode === 405 || statusCode === 401) {
                clearSession();
                setTimeout(() => startBot(), 2000);
            } else if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(() => startBot(), 5000);
            }
        }

        if (connection === 'open') console.log('✅ Connected!');
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        try {
            const result = await model.generateContent(text);
            await sock.sendMessage(jid, { text: result.response.text() });
        } catch (e) { console.error("AI Error:", e.message); }
    });
}

startBot();
