import dotenv from 'dotenv';
dotenv.config();

import {
    makeWASocket,
    Browsers,
    fetchLatestBaileysVersion,
    DisconnectReason,
    useMultiFileAuthState,
    getContentType
} from '@whiskeysockets/baileys';
import { Handler, Callupdate, GroupUpdate } from './data/index.js';
import express from 'express';
import pino from 'pino';
import fs from 'fs';
import { File } from 'megajs';
import NodeCache from 'node-cache';
import path from 'path';
import chalk from 'chalk';
import moment from 'moment-timezone';
import axios from 'axios';
import config from './config.cjs';
import pkg from './lib/autoreact.cjs';

const { emojis, doReact } = pkg;
const prefix = process.env.PREFIX || config.PREFIX;
const sessionName = "session";
const app = express();
const orange = chalk.bold.hex("#FFA500");
const lime = chalk.bold.hex("#32CD32");
let useQR = false;
let initialConnection = true;
const PORT = process.env.PORT || 3000;

// Deployment tracking system
const deploymentLogFile = 'deployment_log.json';
let dailyDeployments = 0;
let totalDeployments = 0;

// Load deployment data
try {
    if (fs.existsSync(deploymentLogFile)) {
        const data = JSON.parse(fs.readFileSync(deploymentLogFile, 'utf-8'));
        const today = moment().tz(config.TIME_ZONE || 'Africa/Nairobi').format('YYYY-MM-DD');
        dailyDeployments = data.date === today ? data.dailyCount : 0;
        totalDeployments = data.totalCount || 0;
    }
} catch (e) {
    console.error('Error reading deployment log:', e);
}

const MAIN_LOGGER = pino({
    timestamp: () => `,"time":"${new Date().toJSON()}"`
});
const logger = MAIN_LOGGER.child({});
logger.level = "trace";

const msgRetryCounterCache = new NodeCache();

const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);

const sessionDir = path.join(__dirname, 'session');
const credsPath = path.join(sessionDir, 'creds.json');

if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}

async function downloadSessionData() {
    console.log("Debugging SESSION_ID:", config.SESSION_ID);

    if (!config.SESSION_ID) {
        console.error('Please add your session to SESSION_ID env !!');
        return false;
    }

    const sessdata = config.SESSION_ID.split("XEON-XTEVH~")[1];

    if (!sessdata || !sessdata.includes("#")) {
        console.error('Invalid SESSION_ID format! It must contain both file ID and decryption key.');
        return false;
    }

    const [fileID, decryptKey] = sessdata.split("#");

    try {
        console.log("Downloading Session...");
        const file = File.fromURL(`https://mega.nz/file/${fileID}#${decryptKey}`);

        const data = await new Promise((resolve, reject) => {
            file.download((err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });

        await fs.promises.writeFile(credsPath, data);
        console.log("Session Successfully Loaded !!");
        return true;
    } catch (error) {
        console.error('Failed to download session data:', error);
        return false;
    }
}

async function sendDeploymentNotification(Matrix) {
    try {
        if (!config.OWNER_NUMBER) {
            console.log(chalk.yellow('Owner number not configured, skipping deployment notification'));
            return;
        }
        
        // Update deployment counts
        const now = moment().tz(config.TIME_ZONE || 'Africa/Nairobi');
        const today = now.format('YYYY-MM-DD');
        dailyDeployments++;
        totalDeployments++;
        
        // Save deployment data
        fs.writeFileSync(deploymentLogFile, JSON.stringify({
            date: today,
            dailyCount: dailyDeployments,
            totalCount: totalDeployments
        }));
        
        const deployTime = now.format('h:mm:ss A');
        const deployDate = now.format('Do MMMM YYYY');
        const deployerName = config.DEPLOYER || "Unknown";
        
        const notificationMessage = `🟢 *New Bot Deployment Alert* 🟢

📅 *Date:* ${deployDate}
⏰ *Time:* ${deployTime}
📱 *User Number:* ${Matrix.user.id.split('@')[0]}
🤖 *Bot Name:* ${config.BOT_NAME || "Xeon-Xtech"}
📊 *Deployment Stats:*
* *Today: ${dailyDeployments}*
* *Total: ${totalDeployments}*

*Configuration Details:*
> *Prefix:* \`${prefix}\`
> *Mode:* ${config.MODE || "public"}
📢 *Message: New Xeon-Xtech instance deployed successfully!*`;

        await Matrix.sendMessage(
            `${config.OWNER_NUMBER}@s.whatsapp.net`, 
            { 
                text: notificationMessage,
                contextInfo: {
                    forwardingScore: 999,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                        newsletterJid: config.CHANNEL_JID || '120363369453603973@newsletter',
                        newsletterName: config.CHANNEL_NAME || "𝑺ʜᴀᴅᴏᴡ ✘ᴛᴇᴄʜ",
                        serverMessageId: Math.floor(Math.random() * 1000) + 1
                    }
                }
            }
        );
        
        console.log(chalk.green('✓ Deployment notification sent to owner'));
    } catch (error) {
        console.error(chalk.red('✗ Failed to send deployment notification:'), error);
    }
}

async function start() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Xeon-Xtech using WA v${version.join('.')}, isLatest: ${isLatest}`);

        const Matrix = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: useQR,
            browser: ["XEON-XTECH", "safari", "3.3"],
            auth: state,
            getMessage: async (key) => {
                if (store) {
                    const msg = await store.loadMessage(key.remoteJid, key.id);
                    return msg.message || undefined;
                }
                return { conversation: "whatsapp user bot" };
            }
        });

        Matrix.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    start();
                }
            } else if (connection === 'open') {
                if (initialConnection) {
                    console.log(chalk.green("✓ Connected Successfully"));
                    
                    // Get current date in requested format (1st April 2025)
                    const currentDate = moment().tz(config.TIME_ZONE || 'Africa/Nairobi').format('Do MMMM YYYY');
                    
                    // Send simplified welcome message
                    await Matrix.sendMessage(Matrix.user.id, {
                        image: { url: "https://files.catbox.moe/og4tsk.jpg" },
                        caption: `> 𝐆ᴇᴛ 𝐑ɪɢʜᴛ 𝐖ɪᴛᴄʜ𝐀 🩷🎀 .
╭───❍「 *𝐂ᴏɴɴᴇᴄᴛᴇ𝐃* 」
┃ 🎀 𝐗ᴇᴏɴ 𝐗ᴛᴇᴄʜ 𝐁ᴏᴛ; ${currentDate},
╰───────────❍
╭───❍「 *𝐁ᴏᴛ 𝐑ᴇᴘᴏ* 」
┃ [**Here**](https://github.com/Black-Tappy/XEON-XMD) star repo!
╰───────────❍
╭───❍「 *𝐉ᴏɪɴ 𝐂ʜᴀɴɴᴇ𝐋* 」
┃ [**Here**](https://whatsapp.com/channel/0029VasHgfG4tRrwjAUyTs10) to join!
╰───────────❍
╭───❍「 *𝐁ᴏᴛ 𝐎ᴡɴᴇ𝐑* 」
┃ +254759000340
╰───────────❍
╭───❍「 *𝐒ʏꜱᴛᴇᴍ 𝐒ᴛᴀᴛᴜꜱ* 」
┃ ░░░░░░░░░░░░░░░░░░░ 100%
╰───────────❍
╭───❍「 *𝐁ᴏᴛ 𝐏ʀᴇꜰɪ𝐱* 」
┃ 𝐂ᴏɴꜰɪɢᴜʀ𝐄 𝐘ᴏᴜʀ 𝐏ʀᴇꜰɪ𝐗 ${prefix}
╰───────────❍
╭───❍「 *𝐀ᴜᴛᴏᴍᴀᴛɪᴏ𝐍* 」
┃𝐏ᴏᴡᴇʀᴇᴅ 𝐁ʏ 𝐁ʟᴀᴄᴋ-𝐓ᴀᴘᴘʏ
╰───────────❍`,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: config.CHANNEL_JID || '120363369453603973@newsletter',
                                newsletterName: config.CHANNEL_NAME || "𝑺ʜᴀᴅᴏᴡ ✘ᴛᴇᴄʜ",
                                serverMessageId: 143
                            }
                        }
                    });
                    
                    // Send deployment notification
                    await sendDeploymentNotification(Matrix);
                    
                    initialConnection = false;
                } else {
                    console.log(chalk.blue("♻️ Connection reestablished after restart."));
                }
            }
        });

        Matrix.ev.on('creds.update', saveCreds);
        Matrix.ev.on("messages.upsert", async chatUpdate => await Handler(chatUpdate, Matrix, logger));
        Matrix.ev.on("call", async (json) => await Callupdate(json, Matrix));
        Matrix.ev.on("group-participants.update", async (messag) => await GroupUpdate(Matrix, messag));

        if (config.MODE === "public") {
            Matrix.public = true;
        } else if (config.MODE === "private") {
            Matrix.public = false;
        }

        // Auto Reaction to chats
        Matrix.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const mek = chatUpdate.messages[0];
                if (!mek.key.fromMe && config.AUTO_REACT) {
                    if (mek.message) {
                        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                        await doReact(randomEmoji, mek, Matrix);
                    }
                }
            } catch (err) {
                console.error('Error during auto reaction:', err);
            }
        });

        // Auto Like Status and Mark as Viewed
        Matrix.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const mek = chatUpdate.messages[0];
                if (!mek || !mek.message) return;

                const contentType = getContentType(mek.message);
                mek.message = (contentType === 'ephemeralMessage')
                    ? mek.message.ephemeralMessage.message
                    : mek.message;

                if (mek.key.remoteJid === 'status@broadcast' && config.AUTO_STATUS_REACT === "true") {
                    const jawadlike = await Matrix.decodeJid(Matrix.user.id);
                    const emojiList = ['❤️', '💸', '😇', '🍂', '💥', '💯', '🔥', '💫', '💎', '💗', '🤍', '🖤', '👀', '🙌', '🙆', '🚩', '🥰', '💐', '😎', '🤎', '✅', '🫀', '🧡', '😁', '😄', '🌸', '🕊️', '🌷', '⛅', '🌟', '🗿', '🇵🇰', '💜', '💙', '🌝', '💚'];
                    const randomEmoji = emojiList[Math.floor(Math.random() * emojiList.length)];

                    await Matrix.readMessages([mek.key]);
                    
                    await Matrix.sendMessage(mek.key.remoteJid, {
                        react: {
                            text: randomEmoji,
                            key: mek.key,
                        }
                    }, { statusJidList: [mek.key.participant, jawadlike] });

                    console.log(`✓ Viewed and reacted to status with: ${randomEmoji}`);
                }
            } catch (err) {
                console.error("✗ Auto Like Status Error:", err);
            }
        });

    } catch (error) {
        console.error('‼️ Critical Error:', error);
        process.exit(1);
    }
}

async function init() {
    if (fs.existsSync(credsPath)) {
        console.log("🔒 Session file found, proceeding without QR code.");
        await start();
    } else {
        const sessionDownloaded = await downloadSessionData();
        if (sessionDownloaded) {
            console.log("🔒 Session downloaded, starting bot.");
            await start();
        } else {
            console.log("⚠️ No session found or downloaded, QR code will be printed for authentication.");
            useQR = true;
            await start();
        }
    }
}

init();

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.listen(PORT, () => {
    console.log(chalk.green(`🌐 Server is running on port ${PORT}`));
});
