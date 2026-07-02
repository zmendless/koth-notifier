//
const express = require('express');
const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Constants ──────────────────────────────────────────────────────────────────
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.txt');
const HONEY_BOTTLE_INTERVAL_MS = 39 * 60 * 1000;
const RECONNECT_DELAY_MS = 30 * 1000;
const BATCH_DELAY_MS = 5 * 1000;
const AUTH_DELAY_REGISTER = 2000;
const AUTH_DELAY_LOGIN = 5000;
const AUTH_DELAY_SURVIVAL = 3000;
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'koth';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
const NOTIFY_DISTANCE = 10;

// ── State ──────────────────────────────────────────────────────────────────────
const bots = {};
const attackIntervals = {};
const attackConfigs = {};
const survivalIntervals = {};
const reconnectTimeouts = {};
const potionIntervals = {};
const potionConfigs = {};
const sellDropConfigs = {};
const sequenceConfigs = {};
const notifyConfigs = {};
const clients = [];

// ── Server identity ────────────────────────────────────────────────────────────
const ADJECTIVES = ['Alpha', 'Bravo', 'Delta', 'Echo', 'Foxtrot', 'Ghost', 'Iron', 'Nova', 'Omega', 'Phantom', 'Shadow', 'Storm', 'Thunder', 'Titan', 'Viper'];
const NOUNS = ['Anvil', 'Blade', 'Cobra', 'Dagger', 'Eagle', 'Falcon', 'Hawk', 'Jaguar', 'Lynx', 'Panther', 'Raven', 'Serpent', 'Tiger', 'Wolf', 'Wraith'];
const SERVER_NAME = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Logging ────────────────────────────────────────────────────────────────────
function sendLog(msg) {
	const logEntry = `[${new Date().toLocaleTimeString()}] ${msg}`;
	console.log(logEntry);
	[...clients].forEach(client => client.write(`data: ${logEntry}\n\n`));
}

// ── Notification helpers (ntfy + Discord webhook) ───────────────────────────────
function notifyPhone(message, title = 'Minecraft Bot') {
	const data = Buffer.from(message, 'utf-8');
	const req = https.request({
		hostname: 'ntfy.sh',
		path: `/${NTFY_TOPIC}`,
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

function sendWebhook(content) {
	if (!DISCORD_WEBHOOK) return;
	const url = new URL(DISCORD_WEBHOOK);
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

// ── Config endpoint ────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
	res.send({ name: SERVER_NAME });
});

// ── SSE Stream ─────────────────────────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();
	clients.push(res);
	req.on('close', () => clients.splice(clients.indexOf(res), 1));
});

// ── Bot list ───────────────────────────────────────────────────────────────────
app.get('/api/bots', (req, res) => {
	const active = Object.values(bots).map(b => b.originalName);
	const pending = Object.keys(reconnectTimeouts).map(id => id.toUpperCase());
	res.send([...new Set([...active, ...pending])]);
});

// ── Position / dimension ───────────────────────────────────────────────────────
app.get('/api/bots/:username/position', (req, res) => {
	const botId = req.params.username.toLowerCase();
	const bot = bots[botId];
	if (!bot) return res.status(404).send({ error: 'Bot offline' });
	const pos = bot.entity?.position;
	if (!pos) return res.status(400).send({ error: 'Position unavailable' });
	const rawDim = bot.game?.dimension || 'unknown';
	const dimension = rawDim.replace('minecraft:', '');
	res.send({
		x: Math.floor(pos.x),
		y: Math.floor(pos.y),
		z: Math.floor(pos.z),
		dimension
	});
});

// ── Accounts file ──────────────────────────────────────────────────────────────
async function loadAccountsFromFile() {
	if (!fs.existsSync(ACCOUNTS_FILE)) {
		sendLog('[SYS] No accounts.txt found — skipping auto-load.');
		return;
	}
	const lines = fs.readFileSync(ACCOUNTS_FILE, 'utf8')
		.split('\n')
		.map(l => l.trim())
		.filter(l => l && !l.startsWith('#'));

	const accounts = lines
		.map(l => l.split(/\s+/))
		.filter(p => p.length >= 2)
		.map(p => ({ username: p[0], password: p[1] }));

	if (accounts.length === 0) { sendLog('[SYS] accounts.txt is empty.'); return; }
	sendLog(`[SYS] Auto-loading ${accounts.length} account(s) from accounts.txt...`);
	for (let i = 0; i < accounts.length; i++) {
		initBot(accounts[i].username, accounts[i].password);
		if (i < accounts.length - 1) await sleep(BATCH_DELAY_MS);
	}
	sendLog('[SYS] Auto-load complete.');
}

// ── Core bot init ──────────────────────────────────────────────────────────────
function initBot(username, password) {
	const botId = username.toLowerCase();
	if (reconnectTimeouts[botId]) {
		clearTimeout(reconnectTimeouts[botId]);
		delete reconnectTimeouts[botId];
	}
	if (bots[botId]) return null;
	sendLog(`Starting bot: ${username}`);
	const bot = mineflayer.createBot({
		host: 'play.tulparmc.com',
		port: 25565,
		username,
		version: '1.19.4'
	});
	bot.originalName = username;
	bot.loginPassword = password;

	bot.once('spawn', () => {
		sendLog(`${username} spawned. Preparing auth...`);
		setTimeout(() => {
			bot.chat(`/register ${password} ${password}`);
			sendLog(`${username} sent /register`);
			setTimeout(() => {
				bot.chat(`/login ${password}`);
				sendLog(`${username} logged in.`);
				setTimeout(() => {
					bot.chat('/survival');
					sendLog(`${username} executed /survival.`);

					survivalIntervals[botId] = setInterval(() => {
						if (bots[botId]) {
							bots[botId].chat('/survival');
							sendLog(`${username} auto-executed /survival (10m loop).`);
						}
					}, 600000);

					if (attackConfigs[botId]?.active) {
						sendLog(`Resuming attack loop for ${username}...`);
						delete attackIntervals[botId];
						manageAttackInterval(botId, attackConfigs[botId].delay, 'start');
					}
					if (potionConfigs[botId]?.active) {
						sendLog(`Resuming Honey Bottle loop for ${username}...`);
						delete potionIntervals[botId];
						managePotionInterval(botId, 'start');
					}
					// Sell/Drop and Sequence do NOT auto-resume after reconnect (safety)
				}, AUTH_DELAY_SURVIVAL);
			}, AUTH_DELAY_LOGIN);
		}, AUTH_DELAY_REGISTER);
	});

	bot.on('chat', (usernameSender, message) => {
		if (usernameSender === bot.username) return;
		sendLog(`[CHAT] <${usernameSender}> ${message}`);
	});
	bot.on('whisper', (usernameSender, message) => {
		sendLog(`[WHISPER] from <${usernameSender}>: ${message}`);
	});

	// ── Koth proximity notify (toggle via /api/bots/notify/start|stop) ─────────
	bot.on('entitySpawn', (entity) => {
		if (entity.type !== 'player') return;
		if (!notifyConfigs[botId]?.active) return;
		if (!bot.entity) return; // bot itself not fully loaded yet
		const name = entity.username || entity.name;
		const distance = bot.entity.position.distanceTo(entity.position);
		if (distance < NOTIFY_DISTANCE) {
			sendLog(`[KOTH] ${username}: ${name} entered range (${distance.toFixed(1)}m)`);
			notifyPhone(`${name} kotha giris yapti.`, 'Player Nearby');
			sendWebhook(`**${name}** kotha giris yapti. (near ${username}, ${distance.toFixed(1)}m)`);
			bot.chat(`⬛ ${name} kotha giris yapti. ⬛`);
		}
	});

	bot.on('kicked', reason => {
		sendLog(`${username} kicked: ${reason}`);
		handleConnectionLoss(username, password, botId);
	});
	bot.on('error', err => {
		sendLog(`${username} error: ${err.message}`);
		handleConnectionLoss(username, password, botId);
	});
	bot.on('end', () => {
		sendLog(`${username} disconnected.`);
		cleanupBotState(botId);
	});

	bots[botId] = bot;
	return bot;
}

function cleanupBotState(botId) {
	if (!bots[botId]) return; // guard against double-cleanup
	delete bots[botId];
	if (attackIntervals[botId]) { clearInterval(attackIntervals[botId]); delete attackIntervals[botId]; }
	if (survivalIntervals[botId]) { clearInterval(survivalIntervals[botId]); delete survivalIntervals[botId]; }
	if (potionIntervals[botId]) { clearInterval(potionIntervals[botId]); delete potionIntervals[botId]; }
	if (sellDropConfigs[botId]) sellDropConfigs[botId].active = false;
	if (sequenceConfigs[botId]) sequenceConfigs[botId].active = false;
	// notifyConfigs intentionally NOT cleared here — preference persists across reconnects, same as attack/potion
}

function handleConnectionLoss(username, password, botId) {
	cleanupBotState(botId);
	sendLog(`${username} connection lost. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
	reconnectTimeouts[botId] = setTimeout(() => {
		delete reconnectTimeouts[botId];
		if (!bots[botId]) initBot(username, password);
	}, RECONNECT_DELAY_MS);
}

// ── Attack ─────────────────────────────────────────────────────────────────────
function manageAttackInterval(botId, delaySeconds, action) {
	const bot = bots[botId];
	if (!bot) return { status: 'error', message: 'Bot offline.' };
	const username = bot.originalName;

	if (action === 'start') {
		if (attackIntervals[botId]) return { status: 'error', message: 'Already attacking.' };
		attackConfigs[botId] = { active: true, delay: delaySeconds };
		sendLog(`Starting attack loop for ${username}`);
		const intervalId = setInterval(() => {
			const activeBot = bots[botId];
			if (activeBot && activeBot.entity) {
				activeBot.setControlState('sprint', false);
				activeBot.setControlState('jump', false);
				const target = activeBot.nearestEntity(entity =>
					entity.name === 'armor_stand' && entity.position.distanceTo(activeBot.entity.position) < 1.5
				);
				if (target) activeBot.attack(target);
				else activeBot.swingArm('right');
			} else {
				clearInterval(intervalId);
				delete attackIntervals[botId];
			}
		}, delaySeconds * 1000);
		attackIntervals[botId] = intervalId;
		return { status: 'success', message: 'Attack started.' };
	}
	if (action === 'stop') {
		if (!attackIntervals[botId]) return { status: 'error', message: 'Not attacking.' };
		if (attackConfigs[botId]) attackConfigs[botId].active = false;
		clearInterval(attackIntervals[botId]);
		delete attackIntervals[botId];
		sendLog(`Stopped attack loop for ${username}.`);
		return { status: 'success', message: 'Attack stopped.' };
	}
	return { status: 'error', message: 'Invalid action.' };
}

// ── Honey Bottle ───────────────────────────────────────────────────────────────
function findHoneyBottle(bot) {
	return bot.inventory.items().find(item => item.name === 'honey_bottle');
}

async function drinkHoneyBottle(botId) {
	const bot = bots[botId];
	if (!bot) return;
	const item = findHoneyBottle(bot);
	if (!item) { sendLog(`${bot.originalName} has no Honey Bottle, skipping.`); return; }
	try {
		await bot.equip(item, 'hand');
		await bot.waitForTicks(5);
		bot.activateItem();
		sendLog(`${bot.originalName} drank a Honey Bottle.`);
	} catch (err) {
		sendLog(`[ERR] ${bot.originalName} failed to drink Honey Bottle: ${err.message}`);
	}
}

function managePotionInterval(botId, action) {
	const bot = bots[botId];
	if (!bot) return { status: 'error', message: 'Bot offline.' };
	const username = bot.originalName;
	if (action === 'start') {
		if (potionIntervals[botId]) return { status: 'error', message: 'Already running.' };
		potionConfigs[botId] = { active: true };
		sendLog(`Starting Honey Bottle loop for ${username} (every 39m).`);
		drinkHoneyBottle(botId);
		const intervalId = setInterval(() => {
			if (bots[botId]) drinkHoneyBottle(botId);
			else { clearInterval(intervalId); delete potionIntervals[botId]; }
		}, HONEY_BOTTLE_INTERVAL_MS);
		potionIntervals[botId] = intervalId;
		return { status: 'success', message: 'Potion loop started.' };
	}
	if (action === 'stop') {
		if (!potionIntervals[botId]) return { status: 'error', message: 'Not running.' };
		if (potionConfigs[botId]) potionConfigs[botId].active = false;
		clearInterval(potionIntervals[botId]);
		delete potionIntervals[botId];
		sendLog(`Stopped Honey Bottle loop for ${username}.`);
		return { status: 'success', message: 'Potion loop stopped.' };
	}
	return { status: 'error', message: 'Invalid action.' };
}

// ── Sell + Drop Loop ───────────────────────────────────────────────────────────
// Cycle: /sellall PRISMARINE_CRYSTALS → 10s → /sellall PRISMARINE_SHARD → 10s
//        → /sellall COD → 10s → wait 5s → drop all → wait 10s → repeat

async function executeSellDropCycle(botId) {
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;
	const name = bots[botId].originalName;
	sendLog(`${name} starting sell/drop cycle.`);

	bots[botId].chat('/sellall PRISMARINE_CRYSTALS');
	sendLog(`${name} → /sellall PRISMARINE_CRYSTALS`);
	await sleep(10000);
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	bots[botId].chat('/sellall PRISMARINE_SHARD');
	sendLog(`${name} → /sellall PRISMARINE_SHARD`);
	await sleep(10000);
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	bots[botId].chat('/sellall COD');
	sendLog(`${name} → /sellall COD`);
	await sleep(10000);
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	await sleep(5000);
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	const bot = bots[botId];
	const items = bot.inventory.items();
	sendLog(`${name} dropping ${items.length} stack(s)...`);
	await bot.waitForTicks(10);
	for (const item of items) {
		if (!bots[botId] || !sellDropConfigs[botId]?.active) return;
		try {
			await bots[botId].tossStack(item);
			await bots[botId].waitForTicks(5);
		} catch (err) {
			sendLog(`[ERR] ${name} drop: ${err.message}`);
		}
	}
	sendLog(`${name} dropped all items.`);

	await sleep(10000);
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	executeSellDropCycle(botId);
}

function manageSellDropLoop(botId, action) {
	if (action === 'start') {
		if (!bots[botId]) return { status: 'error', message: 'Bot offline.' };
		if (sellDropConfigs[botId]?.active) return { status: 'error', message: 'Already running.' };
		sellDropConfigs[botId] = { active: true };
		sendLog(`Starting sell/drop loop for ${bots[botId].originalName}.`);
		executeSellDropCycle(botId);
		return { status: 'success', message: 'Sell/Drop loop started.' };
	}
	if (action === 'stop') {
		const name = bots[botId]?.originalName || botId;
		if (sellDropConfigs[botId]) sellDropConfigs[botId].active = false;
		delete sellDropConfigs[botId];
		sendLog(`Sell/Drop loop stopped for ${name}.`);
		return { status: 'success', message: 'Sell/Drop loop stopped.' };
	}
	return { status: 'error', message: 'Invalid action.' };
}

// ── Chat Sequence ──────────────────────────────────────────────────────────────
// messages: [{ text, delay }] where delay = seconds to wait AFTER sending that message
// initialDelay (M): seconds to wait before the first message fires
// loop: if true, restarts from the first message after the last one

async function executeSequence(botId) {
	const config = sequenceConfigs[botId];
	if (!config?.active || !bots[botId]) return;
	const name = bots[botId].originalName;

	if (config.initialDelay > 0) {
		sendLog(`[SEQ] ${name} waiting ${config.initialDelay}s before start...`);
		await sleep(config.initialDelay * 1000);
		config.initialDelay = 0; // only apply on first run, not on loops
		if (!sequenceConfigs[botId]?.active || !bots[botId]) return;
	}

	for (const step of config.messages) {
		if (!sequenceConfigs[botId]?.active || !bots[botId]) return;
		bots[botId].chat(step.text);
		sendLog(`[SEQ] ${name}: "${step.text}" → wait ${step.delay}s`);
		await sleep(step.delay * 1000);
	}

	if (sequenceConfigs[botId]?.active && config.loop) {
		executeSequence(botId);
	} else {
		if (sequenceConfigs[botId]) sequenceConfigs[botId].active = false;
		sendLog(`[SEQ] Sequence complete for ${name}.`);
	}
}

function manageSequence(botId, action, config) {
	if (action === 'start') {
		if (!bots[botId]) return { status: 'error', message: 'Bot offline.' };
		if (sequenceConfigs[botId]?.active) return { status: 'error', message: 'Sequence already running.' };
		if (!config?.messages?.length) return { status: 'error', message: 'No messages in sequence.' };
		sequenceConfigs[botId] = { active: true, ...config };
		sendLog(`[SEQ] Starting for ${bots[botId].originalName} (${config.messages.length} step(s), loop=${config.loop}).`);
		executeSequence(botId);
		return { status: 'success', message: 'Sequence started.' };
	}
	if (action === 'stop') {
		const name = bots[botId]?.originalName || botId;
		if (sequenceConfigs[botId]) sequenceConfigs[botId].active = false;
		delete sequenceConfigs[botId];
		sendLog(`[SEQ] Stopped for ${name}.`);
		return { status: 'success', message: 'Sequence stopped.' };
	}
	return { status: 'error', message: 'Invalid action.' };
}

// ── Koth Notify toggle ───────────────────────────────────────────────────────
function manageNotify(botId, action) {
	if (!bots[botId]) return { status: 'error', message: 'Bot offline.' };
	const name = bots[botId].originalName;
	if (action === 'start') {
		if (notifyConfigs[botId]?.active) return { status: 'error', message: 'Already notifying.' };
		notifyConfigs[botId] = { active: true };
		sendLog(`[KOTH] Notify enabled for ${name}.`);
		return { status: 'success', message: 'Notify enabled.' };
	}
	if (action === 'stop') {
		if (!notifyConfigs[botId]?.active) return { status: 'error', message: 'Not notifying.' };
		notifyConfigs[botId] = { active: false };
		sendLog(`[KOTH] Notify disabled for ${name}.`);
		return { status: 'success', message: 'Notify disabled.' };
	}
	return { status: 'error', message: 'Invalid action.' };
}

// ── Warp Arena (all bots) ──────────────────────────────────────────────────────
// Sequence: /warp arena → wait 10s → drop all items → /back

app.post('/api/bots/warp-arena', async (req, res) => {
	const allBots = Object.values(bots);
	if (allBots.length === 0) return res.status(404).send({ status: 'error', message: 'No bots online.' });

	res.send({ status: 'success', message: `Warp Arena sequence: ${allBots.length} bot(s)` });

	allBots.forEach(bot => {
		bot.chat('/warp arena');
		sendLog(`${bot.originalName} → /warp arena`);
	});

	await sleep(10000);

	await Promise.all(allBots.map(async (bot) => {
		const botId = bot.originalName.toLowerCase();
		const liveBot = bots[botId];
		if (!liveBot) return;

		const items = liveBot.inventory.items();
		await liveBot.waitForTicks(5);
		for (const item of items) {
			if (!bots[botId]) break;
			try {
				await bots[botId].tossStack(item);
				await bots[botId].waitForTicks(5);
			} catch (err) {
				sendLog(`[ERR] ${bot.originalName} warp-arena drop: ${err.message}`);
			}
		}
		sendLog(`${bot.originalName} dropped all items (arena).`);

		if (bots[botId]) {
			bots[botId].chat('/back');
			sendLog(`${bot.originalName} → /back`);
		}
	}));
});

// ── REST Endpoints ─────────────────────────────────────────────────────────────
app.post('/api/bots/add', (req, res) => {
	const { username, password } = req.body;
	if (initBot(username, password)) {
		// Auto-append to accounts file so single adds also persist
		const entry = `${username} ${password}\n`;
		const existing = fs.existsSync(ACCOUNTS_FILE) ? fs.readFileSync(ACCOUNTS_FILE, 'utf8') : '';
		if (!existing.includes(username + ' ')) fs.appendFileSync(ACCOUNTS_FILE, entry);
		res.send({ status: 'success', message: `${username} initiated.` });
	} else {
		res.status(400).send({ status: 'error', message: 'Bot already active.' });
	}
});

app.post('/api/bots/batch-add', async (req, res) => {
	const { accounts, save } = req.body;
	if (!accounts || !Array.isArray(accounts))
		return res.status(400).send({ status: 'error', message: 'Invalid payload.' });

	if (save) {
		const content = accounts.map(a => `${a.username} ${a.password}`).join('\n') + '\n';
		fs.writeFileSync(ACCOUNTS_FILE, content);
		sendLog(`[SYS] Saved ${accounts.length} account(s) to accounts.txt`);
	}

	res.send({ status: 'success', message: `Batch started (${accounts.length} accounts)` });
	sendLog(`[SYS] Batch login: ${accounts.length} accounts, 5s delay each.`);
	for (let i = 0; i < accounts.length; i++) {
		const acc = accounts[i];
		if (acc.username && acc.password) {
			initBot(acc.username, acc.password);
			if (i < accounts.length - 1) await sleep(BATCH_DELAY_MS);
		}
	}
	sendLog(`[SYS] Batch login sequence complete.`);
});

app.post('/api/bots/disconnect', (req, res) => {
	const botId = req.body.username.toLowerCase();
	let actionTaken = false;
	if (reconnectTimeouts[botId]) {
		clearTimeout(reconnectTimeouts[botId]);
		delete reconnectTimeouts[botId];
		sendLog(`[SYS] Cancelled pending reconnect for ${botId}`);
		actionTaken = true;
	}
	if (attackConfigs[botId]) attackConfigs[botId].active = false;
	if (sellDropConfigs[botId]) sellDropConfigs[botId].active = false;
	if (sequenceConfigs[botId]) sequenceConfigs[botId].active = false;
	if (notifyConfigs[botId]) notifyConfigs[botId].active = false;
	if (bots[botId]) { bots[botId].quit(); actionTaken = true; }
	if (actionTaken) res.send({ status: 'success', message: `Disconnected: ${botId}` });
	else res.status(404).send({ status: 'error', message: 'Bot not found.' });
});

app.post('/api/bots/chat', (req, res) => {
	const target = req.body.target.toLowerCase();
	const { message } = req.body;
	if (target === 'all') {
		Object.values(bots).forEach(b => b.chat(message));
		sendLog(`[BROADCAST]: ${message}`);
	} else if (bots[target]) {
		bots[target].chat(message);
		sendLog(`[OUTGOING] ${bots[target].originalName}: ${message}`);
	} else {
		return res.status(404).send({ status: 'error', message: 'Target offline.' });
	}
	res.send({ status: 'success', message: 'Sent.' });
});

app.post('/api/bots/hotbar', (req, res) => {
	const botId = req.body.username.toLowerCase();
	const bot = bots[botId];
	if (!bot) return res.status(404).send({ error: 'Bot offline' });
	const slotInt = parseInt(req.body.slot);
	if (isNaN(slotInt) || slotInt < 0 || slotInt > 8)
		return res.status(400).send({ error: 'Invalid slot' });
	bot.setQuickBarSlot(slotInt);
	sendLog(`${bot.originalName} hotbar → slot ${slotInt + 1}`);
	res.send({ status: 'success', message: `Slot set to ${slotInt + 1}` });
});

app.get('/api/bots/:username/inventory', (req, res) => {
	const botId = req.params.username.toLowerCase();
	const bot = bots[botId];
	if (!bot) return res.status(404).send({ error: 'Bot offline' });
	res.send(bot.inventory.items().map(item => ({ name: item.name, count: item.count })));
});

app.post('/api/bots/drop', async (req, res) => {
	const botId = req.body.username.toLowerCase();
	const bot = bots[botId];
	if (!bot) return res.status(404).send({ error: 'Bot offline.' });
	const items = bot.inventory.items();
	if (items.length === 0) return res.send({ status: 'success', message: 'Inventory already empty.' });
	res.send({ status: 'success', message: 'Dropping...' });
	sendLog(`${bot.originalName} dropping inventory...`);
	await bot.waitForTicks(10);
	for (const item of items) {
		try { await bot.tossStack(item); await bot.waitForTicks(5); }
		catch (err) { sendLog(`[ERR] Drop: ${err.message}`); }
	}
	sendLog(`${bot.originalName} finished dropping.`);
});

app.post('/api/bots/attack/start', (req, res) => {
	const r = manageAttackInterval(req.body.username.toLowerCase(), req.body.delay, 'start');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/attack/stop', (req, res) => {
	const r = manageAttackInterval(req.body.username.toLowerCase(), null, 'stop');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/potion/start', (req, res) => {
	const r = managePotionInterval(req.body.username.toLowerCase(), 'start');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/potion/stop', (req, res) => {
	const r = managePotionInterval(req.body.username.toLowerCase(), 'stop');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/selldrop/start', (req, res) => {
	const r = manageSellDropLoop(req.body.username.toLowerCase(), 'start');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/selldrop/stop', (req, res) => {
	const r = manageSellDropLoop(req.body.username.toLowerCase(), 'stop');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/sequence/start', (req, res) => {
	const r = manageSequence(req.body.username.toLowerCase(), 'start', {
		messages: req.body.messages,
		initialDelay: req.body.initialDelay || 0,
		loop: !!req.body.loop
	});
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/sequence/stop', (req, res) => {
	const r = manageSequence(req.body.username.toLowerCase(), 'stop');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/notify/start', (req, res) => {
	const r = manageNotify(req.body.username.toLowerCase(), 'start');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/notify/stop', (req, res) => {
	const r = manageNotify(req.body.username.toLowerCase(), 'stop');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});

app.listen(process.env.PORT || 3000, () => {
	console.log(`Tulpar Bot Manager [${SERVER_NAME}] running on port ${process.env.PORT || 3000}`);
	loadAccountsFromFile();
});
