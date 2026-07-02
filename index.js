const path = require('path');
const fs = require('fs');
const isPkg = typeof process.pkg !== 'undefined';
const baseDir = isPkg ? path.dirname(process.execPath) : __dirname;
const configPath = path.join(baseDir, 'config.txt');
require('dotenv').config({ path: configPath });
const mineflayer = require('mineflayer');
const { GlobalKeyboardListener } = require("node-global-key-listener");
const readline = require('readline');
const USERNAME = process.env.BOT_USERNAME || "MISSING_USERNAME";
const PASSWORD = process.env.BOT_PASSWORD || "MISSING_PASSWORD";
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
});
rl.setPrompt('> ');
rl.prompt();
function sendLog(msg) {
    if (process.stdout.clearLine) process.stdout.clearLine();
    if (process.stdout.cursorTo) process.stdout.cursorTo(0);
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}
console.log(USERNAME);
const bot = mineflayer.createBot({
    host: 'play.tulparmc.com',
    port: 25565,
    username: USERNAME,
    auth: 'offline',
    version: '1.19.4'
});
bot.physicsEnabled = false;
let trackingReady = false;
bot.once('spawn', () => {
    sendLog(`${USERNAME} spawned.`);
    setTimeout(() => {
        bot.chat(`/login ${PASSWORD}`);
        setTimeout(() => {
            bot.chat('/survival');
            sendLog(`${USERNAME} executed /survival.`);
            setInterval(() => bot.chat('/survival'), 600000);
            setTimeout(() => {
                trackingReady = true;
                sendLog(`[SYS] Player tracking enabled.`);
            }, 15000);
        }, 3000);
    }, 1000);
});
bot.on('kicked', reason => sendLog(`Kicked: ${reason}`));
bot.on('error', err => sendLog(`Error: ${err.message}`));
bot.on('end', () => sendLog(`Disconnected.`));
const https = require('https');
function notifyPhone(message, title = "Minecraft Bot") {
    const data = Buffer.from(message, 'utf-8');
    const req = https.request({
        hostname: 'ntfy.sh',
        path: '/koth',
        method: 'POST',
        headers: {
            'Title': title,
            'Content-Length': data.length
        }
    });
    req.on('error', (err) => sendLog(`[NTFY ERROR] ${err.message}`));
    req.write(data);
    req.end();
}
rl.on('line', (input) => {
    const text = input.trim();
    if (text) {
        if (bot.entity) {
            bot.chat(text);
            sendLog(`[CHAT OUT] ${text}`);
        } else {
            sendLog(`[SYS] Cannot chat yet, bot is not spawned.`);
        }
    }
    rl.prompt();
});
const { URL } = require('url');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK || "";
function sendWebhook(content) {
    if (!WEBHOOK_URL) return;
    const url = new URL(WEBHOOK_URL);
    const data = JSON.stringify({ content });
    const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    });
    req.on('error', (err) => sendLog(`[WEBHOOK ERROR] ${err.message}`));
    req.write(data);
    req.end();
}
bot.on('entitySpawn', (entity) => {
    if (entity.type === 'player' && trackingReady) {
        const name = entity.username || entity.name;
        const distance = bot.entity.position.distanceTo(entity.position);
        if (distance < 10) {
            sendLog(`[RENDER] Player entered range: ${name} (${distance.toFixed(1)}m away)`);
            notifyPhone(`${name} kotha giris yapti.`, "Player Nearby");
            sendWebhook(`**${name}** kotha giris yapti.`);
            bot.chat(`?⬛ ${name} kotha giris yapti. ⬛`);
        }
    }
});
function shutdown(signal) {
    sendLog(`[SYS] Received ${signal}, shutting down...`);
    if (bot && bot.player) {
        bot.chat('/logout');
    }
    if (bot) {
        bot.quit('Shutting down');
    }
    setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => shutdown('SIGTERM'));
