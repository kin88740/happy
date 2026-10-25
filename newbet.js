'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const axios = require('axios');
const { Telegraf } = require('telegraf');

const CONFIG = Object.freeze({
    token: process.env.BOT_TOKEN || '8749319527:AAG06NA1IaNq247go5vt75dzN6OpuNf_y6o',
    ownerId: 8733682209,
    supportContact: '@OyeSWAG',
    dataDir: '.',
    ignoreSsl: true,
    richMessages: true,
    deviceId: process.env.GAME_DEVICE_ID || '10f624a84d2f2110450d20860eee60d3',
    arLotteryUrl: process.env.ARLOTTERY_RESULT_URL || 'https://draw.ar-lottery01.com/TrxWinGo/TrxWinGo_1M/GetHistoryIssuePage.json',
    adminGroupId: '-1002861958802',
    payout: 0.96,
    payoutViolet: 3.8,
    pollMs: 2000,
    maxConsecutiveErrors: 10,
    balanceRetries: 5,
    betRetries: 5,
    reloginMs: 30 * 60 * 1000,
    lowBalanceWarnMs: 60_000,
    sniper: { maxHits: 2, maxLosses: 4 },
});

if (!CONFIG.token || CONFIG.token.startsWith('PUT_YOUR') || !Number.isFinite(CONFIG.ownerId)) {
    console.error('A valid bot token (BOT_TOKEN) and numeric owner ID are required.');
    process.exit(1);
}

const log = {};
for (const level of ['debug', 'info', 'warn', 'error']) {
    log[level] = (msg) => console.log(`[${level.toUpperCase()}] ${new Date().toISOString()} ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const utf8Safe = (value) => {
    const input = String(value ?? '');
    let output = '';
    for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = input.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) { output += input[i] + input[++i]; continue; }
            output += '�';
            continue;
        }
        output += code >= 0xDC00 && code <= 0xDFFF ? '�' : input[i];
    }
    return output;
};
const esc = (v) => utf8Safe(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ks = (n) => `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Ks`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${ks(Math.abs(n))}`;
const last = (arr, n = 1) => arr[arr.length - n];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const cmpIssue = (a, b) => { a = String(a); b = String(b); return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0); };
const duration = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`; };

function retryAfterMs(err, fallback = 10_000) {
    const raw = err?.retryAfterMs ?? err?.response?.headers?.['retry-after'];
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
    return fallback;
}

async function withRetry(fn, { times = 3, delay = 1500 } = {}) {
    let lastErr;
    for (let i = 0; i < times; i++) {
        try {
            return await fn(i);
        } catch (err) {
            lastErr = err;
            if (i >= times - 1) break;
            const status = Number(err?.status ?? err?.response?.status ?? err?.code);
            if ([401, 403].includes(status)) throw err;
            const wait = status === 429
                ? retryAfterMs(err, Math.min(60_000, delay * (2 ** i)))
                : delay * (2 ** i);
            await sleep(wait + Math.floor(Math.random() * 750));
        }
    }
    throw lastErr;
}

class RequestLimiter {
    constructor({ minIntervalMs = 1_000, maxCooldownMs = 120_000 } = {}) {
        this.minIntervalMs = minIntervalMs;
        this.maxCooldownMs = maxCooldownMs;
        this.nextAt = 0;
        this.cooldownUntil = 0;
        this.queue = Promise.resolve();
    }
    async waitTurn() {
        let release;
        const previous = this.queue;
        this.queue = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            const now = Date.now();
            const wait = Math.max(0, this.nextAt - now, this.cooldownUntil - now);
            if (wait) await sleep(wait);
            this.nextAt = Date.now() + this.minIntervalMs;
        } finally {
            release();
        }
    }
    cooldown(ms) {
        const bounded = Math.min(this.maxCooldownMs, Math.max(1000, ms || 10_000));
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + bounded);
    }
}

const platformLimiters = new Map();
const limiterFor = (platformKey) => {
    if (!platformLimiters.has(platformKey)) platformLimiters.set(platformKey, new RequestLimiter());
    return platformLimiters.get(platformKey);
};

const PLATFORMS = {
    '6LOTTERY': { name: '6LOTTERY', baseUrl: 'https://6lotteryapi.com/api/webapi/', style: 'danger', emoji: 'site_6lottery' },
    '777BIGWIN': { name: '777BIGWIN', baseUrl: 'https://api.bigwinqaz.com/api/webapi/', style: 'success', emoji: 'site_777bigwin' },
    'CKLOTTERY': { name: 'CKLOTTERY', baseUrl: 'https://ckygjf6r.com/api/webapi/', style: 'primary', emoji: 'site_cklottery' },
    'SHWELOTTERY': { name: 'SHWELOT', baseUrl: 'https://api.shweshwbb.com/api/webapi/', style: 'danger', emoji: 'site_shwelottery', origin: 'https://shwelottery.net', referer: 'https://shwelottery.net/', userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36' },
};

const GAMES = {
    TRX: { label: 'TRX 1min', typeId: 13, issue: 'GetTrxGameIssue', bet: 'GameTrxBetting', waitMs: 180_000 },
    WINGO_30S: { label: 'WINGO 30s', typeId: 30, issue: 'GetGameIssue', bet: 'GameBetting', waitMs: 120_000 },
    WINGO: { label: 'WINGO 1min', typeId: 1, issue: 'GetGameIssue', bet: 'GameBetting', waitMs: 180_000 },
    WINGO_3MIN: { label: 'WINGO 3min', typeId: 2, issue: 'GetGameIssue', bet: 'GameBetting', waitMs: 600_000 },
    WINGO_5MIN: { label: 'WINGO 5min', typeId: 3, issue: 'GetGameIssue', bet: 'GameBetting', waitMs: 900_000 },
};

const SELECT_TYPE = {
    BS: { B: 13, S: 14 },
    COLOR: { G: 11, V: 12, R: 10 },
};

const bsOf = (n) => (n >= 5 ? 'B' : 'S');
const colorOf = (n) => ([1, 3, 7, 9].includes(n) ? 'G' : [0, 5].includes(n) ? 'V' : 'R');
const COLOR_NAME = { G: 'Green', V: 'Violet', R: 'Red' };
const COLOR_DOT = { G: '🟢', V: '🟣', R: '🔴' };
const choiceName = (c) => ({ B: 'BIG', S: 'SMALL', ...COLOR_NAME }[c] ?? c);

const DEFAULT_BS_ORDER = 'BSBBSBSSSB';
const OP_PATTERN = 'BSBSBBSSBBBSSSBSBS';
const ALINKAR_PATTERN = 'BBSSBSBSBBSS';
// Output lookup order is lexicographic B/S order for every 7-character pattern (B=0, S=1).
const GOLDEN_RATIO_OUTPUTS = Object.freeze([
    'SBBSBSSB', 'SSBBSBSB', 'BSBSSBBS', 'BBSSBSBS',
    'SBSBBSBS', 'BSSBSBBS', 'BBSBSSBS', 'SBBSBSSB',
    'BSSBSBBS', 'BSBSSBSB', 'SBBSBSSB', 'SSBBSBBS',
    'BSBBSSBS', 'SBSBBSSB', 'SBBSBSBS', 'BSSBSBBS',
]);
const SHINE_PATTERNS = { B: ['S', 'B', 'S', 'B', 'S'], S: ['B', 'S', 'B', 'S', 'B'] };
const KO_PAING_SKIP_COUNT = 5;
const STAKING_MODES = ['Martingale', 'Anti-Martingale'];
const BET_MODES = ['STRAIGHT', 'REVERSE'];
const betModeLabel = (mode) => mode === 'REVERSE' ? 'Reverse' : 'Straight';
const applyBetMode = (choice, mode) => mode === 'REVERSE'
    ? (choice === 'B' ? 'S' : choice === 'S' ? 'B' : choice)
    : choice;
const PAYMENT_AMOUNT = 10_000;
const PAYMENT_ACCOUNTS = Object.freeze({
    kpay: '09758221700 (Paing Zin Htet)',
    wave: '09799082808 (Paing Zin Htet)',
});
const TUTORIAL_URL = 'https://t.me/lets_make_a_deal_vdo/5725';
const WELCOME_VIDEO_URL = process.env.WELCOME_VIDEO_URL ||
    'https://p14.f2.n0.cdn.zight.com/items/01a166ff-ac4d-7650-b2f8-f5eea879d21a/34ed7f56-6b00-4c97-877a-7239f4e16c57.mp4?source=viewer&v=1372b434048856928082187e5cd574c5';
const welcomeCaption = () =>
    `${em('celebrate')} <b>Welcome to 𝙋𝘼𝙄 ˡᵒᵗᵗᵉʳʸ ᵃᵘᵗᵒ ᵖʳᵒᶠⁱᵗ ᵇᵒᵗ ${em('mmFlag')}</b>\n\n` +
    `<blockquote>${em('bot')} Smart signals • ${em('goal')} Auto betting\n` +
    `${em('graph')} Profit focused • ${em('shield')} Secure setup\n` +
    `${em('fast')} Fast results • ${em('gem')} Premium experience</blockquote>\n\n` +
    `${em('down')} အောက်က Menu မှာ Sign In ဝင်ပြီး စတင်အသုံးပြုနိုင်ပါတယ်။`;
const getPaymentAmount = () => Number.isSafeInteger(stores?.bot?.data?.paymentAmount) && stores.bot.data.paymentAmount > 0 ? stores.bot.data.paymentAmount : PAYMENT_AMOUNT;

class JsonStore {
    constructor(file, initial) {
        this.file = path.join(CONFIG.dataDir, file);
        this.data = initial;
        this.timer = null;
    }
    load() {
        try {
            if (fs.existsSync(this.file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
        } catch (err) { log.error(`Failed to load ${this.file}: ${err.message}`); }
        return this;
    }
    save() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 500);
    }
    flush() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
            fs.renameSync(tmp, this.file);
        } catch (err) { log.error(`Failed to save ${this.file}: ${err.message}`); }
    }
}

const stores = {
    settings: new JsonStore('settings.v2.json', {}).load(),
    allowed: new JsonStore('users_6lottery.json', { allowed_ids: [] }).load(),
    admins: new JsonStore('admins.json', { admin_ids: [] }).load(),
    known: new JsonStore('known_users.json', { ids: [] }).load(),
    emoji: new JsonStore('emoji_ids.json', {}).load(),
    bot: new JsonStore('bot_state.json', { maintenance: false, freeMode: false, groupNotificationDisabled: {}, hiddenPlatforms: {}, hiddenStrategies: {} }).load(),
    banned: new JsonStore('banned_users.json', { ids: [] }).load(),
    trxResults: new JsonStore('trx_results.json', { results: [] }).load(),
    payments: new JsonStore('pending_payments.json', { payments: [] }).load(),
    strategyRatings: new JsonStore('strategy_ratings.json', { ratings: {} }).load(),
    dailySummaries: new JsonStore('daily_summaries.json', { users: {} }).load(),
    signalChannels: new JsonStore('signal_channels.json', { channel_ids: [], channels: {} }).load(),
    settingCodes: new JsonStore('setting_codes.json', { codes: {} }).load(),
    forceJoin: new JsonStore('force_join.json', { chats: {} }).load(),
};

const idList = (store, key) => ({
    has: (id) => store.data[key].includes(id),
    add(id) { if (this.has(id)) return false; store.data[key].push(id); store.save(); return true; },
    remove(id) { const i = store.data[key].indexOf(id); if (i < 0) return false; store.data[key].splice(i, 1); store.save(); return true; },
    all: () => [...store.data[key]],
});
const allowedIds = idList(stores.allowed, 'allowed_ids');
const adminIds = idList(stores.admins, 'admin_ids');
const knownUsers = idList(stores.known, 'ids');
const bannedIds = idList(stores.banned, 'ids');

const signalChannelIds = idList(stores.signalChannels, 'channel_ids');

const forceJoinData = () => stores.forceJoin.data.chats || (stores.forceJoin.data.chats = {});
const forceJoinIds = () => Object.keys(forceJoinData());
const forceJoinChatKey = (value) => {
    const text = String(value || '').trim();
    if (/^-?\d+$/.test(text)) return text;
    if (/^@[A-Za-z0-9_]{4,}$/.test(text)) return text;
    return null;
};
const forceJoinLabel = (id, meta = forceJoinData()[String(id)] || {}) =>
    meta.title || meta.username && `@${String(meta.username).replace(/^@/, '')}` || String(id);
const forceJoinButtonUrl = (id, meta = forceJoinData()[String(id)] || {}) => {
    if (meta.url && /^https?:\/\//i.test(meta.url)) return meta.url;
    if (String(id).startsWith('@')) return `https://t.me/${String(id).slice(1)}`;
    if (meta.username) return `https://t.me/${String(meta.username).replace(/^@/, '')}`;
    return null;
};
const forceJoinKeyboard = () => {
    const rows = forceJoinIds().map((id) => {
        const url = forceJoinButtonUrl(id);
        return [url
            ? { text: `Join ${forceJoinLabel(id)}`, url }
            : { text: `Check ${forceJoinLabel(id)}`, callback_data: 'fj:check' }];
    });
    rows.push([{ text: 'I Joined — Check Again', callback_data: 'fj:check' }]);
    return inline(rows);
};
const forceJoinText = () =>
    `${em('lock')} <b>အသုံးပြုရန် Channel / Group များကို အရင် Join လုပ်ပါ</b>\n\n` +
    `အောက်ပါ Channel/Group အားလုံးကို Join ပြီးနောက် <b>I Joined — Check Again</b> ကိုနှိပ်ပါ။\n` +
    `မည်သည့် Channel/Group မှ ထွက်သွားပါက Bot process ကို ချက်ချင်းရပ်ပါမည်။`;

async function forceJoinStatus(userId) {
    const missing = [];
    for (const id of forceJoinIds()) {
        try {
            const member = await bot.telegram.getChatMember(id, userId);
            const ok = ['creator', 'administrator', 'member'].includes(member?.status) ||
                (member?.status === 'restricted' && member?.is_member === true);
            if (!ok) missing.push(id);
        } catch (err) {
            log.warn(`force join check failed ${id}/${userId}: ${err.message}`);
            missing.push(id);
        }
    }
    return { ok: missing.length === 0, missing };
}

async function enforceForceJoin(s, { notify = true } = {}) {
    if (!s || isAdmin(s.id) || !forceJoinIds().length) return true;
    const result = await forceJoinStatus(s.id);
    if (result.ok) {
        s.forceJoinBlocked = false;
        s.forceJoinNoticeSent = false;
        return true;
    }
    if (s.running) {
        s.running = false;
        if (s.run && !s.run.endReason) s.run.endReason = 'force-join';
        log.info(`force join stopped process for ${s.id}`);
    }
    if (notify && !s.forceJoinNoticeSent) {
        s.forceJoinNoticeSent = true;
        await ui.html(s.id, forceJoinText(), forceJoinKeyboard()).catch(() => { });
    }
    s.forceJoinBlocked = true;
    return false;
}

function signalChannelShortName(value, max = 20) {
    const text = String(value || '').replace(/^@/, '').trim() || 'Channel';
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}
function configuredSignalChannelButtons() {
    const channels = stores.signalChannels.data.channels || {};
    return signalChannelIds.all().map((id) => {
        const meta = channels[String(id)] || {};
        return { id: String(id), label: signalChannelShortName(meta.title || meta.username || id) };
    });
}

const isOwner = (id) => id === CONFIG.ownerId;
const isAdmin = (id) => isOwner(id) || adminIds.has(id);


const isAuthorized = (tgId, gameId) =>
    !bannedIds.has(tgId) &&
    (stores.bot.data.freeMode || isAdmin(tgId) || allowedIds.has(Number(gameId)));

const signalState = { latest: null, byPeriod: new Map() };
const parseChatId = (text) => /^-?\d+$/.test(String(text || '').trim()) ? String(text).trim() : null;
function parseSignalMultiplier(text) {
    const m = String(text || '').match(/(?:\(\s*(\d+(?:\.\d+)?)\s*\)|(?:\b(\d+(?:\.\d+)?)\s*[xXဆဇ])|(?:\b[xX]\s*(\d+(?:\.\d+)?)))/i);
    return m ? Number(m[1] || m[2] || m[3]) : 1;
}
function parseChannelSignal(text) {
    const source = String(text || '').replace(/[\u200b\r]/g, '').trim();
    if (!source) return null;
    const periodMatch = source.match(/(?:Period|ပွဲ\s*စ(?:ဥ|ဉ)်)\s*[:：]?\s*(\d{8,})/i)
        || source.match(/(?:^|\n)[^\d\n]{0,12}(\d{8,})\s*[•·]/);
    const period = periodMatch?.[1] || null;
    if (!period) return null;
    const directionMatch = source.match(/(?:Prediction|ထိုး\s*ရန်)\s*[:：]?\s*(BIG|SMALL)\b/i)
        || source.match(/\b(BIG|SMALL)\b/i);
    if (!directionMatch) return null;
    const choice = directionMatch[1].toUpperCase() === 'BIG' ? 'B' : 'S';
    const multiplier = parseSignalMultiplier(source);
    return { period: String(period), choice, multiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1, receivedAt: Date.now() };
}
function latestSignalForIssue(issue, channelId = null) {
    const key = channelId ? `${String(channelId)}:${String(issue)}` : null;
    const hit = key ? signalState.byPeriod.get(key) : [...signalState.byPeriod.values()].reverse().find((item) => String(item.period) === String(issue));
    return hit && Date.now() - hit.receivedAt < 10 * 60_000 ? hit : null;
}

function signalChannelLink(signal) {
    if (!signal) return 'Signal Channel';
    const username = String(signal.channelUsername || '').replace(/^@/, '').trim();
    const channelId = String(signal.channelId || '');
    const messageId = signal.messageId;
    const url = username
        ? `https://t.me/${username}`
        : channelId.startsWith('-100') && messageId
            ? `https://t.me/c/${channelId.slice(4)}/${messageId}`
            : null;
    const shortName = signal.channelTitle || (username ? `@${username}` : 'Signal Channel');
    return url ? `<a href="${url}">${esc(shortName)}</a>` : esc(shortName);
}
function decisionReasonHtml(cfg, run, reason) {
    return cfg.strategy === 'CHANNEL_SIGNAL' && run.signal ? signalChannelLink(run.signal) : esc(reason || '');
}

const defaultSettings = (platform = 'CKLOTTERY') => ({
    platform,
    game: platform === 'CKLOTTERY' ? 'TRX' : 'WINGO',
    betType: 'BS',
    betMode: 'STRAIGHT',
    strategy: 'TREND_FOLLOW',
    signalChannelId: null,
    staking: 'Martingale',
    betSizes: [],
    pattern: DEFAULT_BS_ORDER,
    bsWait: 0,
    bbWait: 0,
    target: null,
    stopLoss: null,
    entryLayer: 1,
    slLayer: 0,
    virtual: false,
    virtualBalance: 0,
    autoTimeStart: null,
    autoTimeEnd: null,
    autoDurationMinutes: null,
    autoWinCount: null,
    language: 'en',
});
const getSettings = (id) => {
    const cfg = stores.settings.data[id] ??= defaultSettings();
    if (!BET_MODES.includes(cfg.betMode)) cfg.betMode = 'STRAIGHT';
    return cfg;
};
const saveSettings = () => stores.settings.save();



const SIGN_EXCLUDE = new Set(['signature', 'timestamp', 'track', 'xosoBettingData']);

function sign(body) {
    const canonical = {};
    for (const key of Object.keys(body).sort()) {
        const value = body[key];
        if (value === null || value === undefined || value === '' || SIGN_EXCLUDE.has(key)) continue;
        canonical[key] = value;
    }
    return md5(JSON.stringify(canonical)).toUpperCase();
}

class ArLotteryClient {
    constructor() {
        this.http = axios.create({
            timeout: 15_000,
            httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: !CONFIG.ignoreSsl }),
            headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'newbet-trx-checker/1.0' },
        });
    }

    async latest() {
        const response = await this.http.get(CONFIG.arLotteryUrl, { params: { ts: Date.now() } });
        let data = response.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch { throw new Error('draw.ar-lottery01 returned invalid JSON'); } }
        const history = Array.isArray(data?.data?.list) ? data.data.list : [];
        const newest = history.find((x) => x?.issueNumber != null && x?.number != null);
        if (newest) return { issueNumber: String(newest.issueNumber), number: String(newest.number) };
        const candidates = [];
        const walk = (v) => {
            if (!v) return;
            if (Array.isArray(v)) return v.forEach(walk);
            if (typeof v === 'object') {
                const issue = v.issueNumber ?? v.issue ?? v.period ?? v.periodNumber ?? v.drawNumber ?? v.draw_id;
                const number = v.number ?? v.result ?? v.num ?? v.digit ?? v.openNumber ?? v.open_num;
                if (issue != null && number != null) candidates.push({ issueNumber: String(issue), number: String(number) });
                Object.values(v).forEach((x) => { if (x && typeof x === 'object') walk(x); });
            }
        };
        walk(data);
        const hit = candidates.find((x) => /^\d+$/.test(String(x.number)) && Number(x.number) >= 0);
        if (!hit) throw new Error('draw.ar-lottery01 returned no usable TRX result');
        return { issueNumber: hit.issueNumber, number: hit.number };
    }
}

function normalizeMobileLogin(value) {
    const raw = String(value || '').trim().replace(/[\s-]/g, '');
    if (!/^\d+$/.test(raw)) throw new Error('Enter a valid mobile number or email address.');
    if (raw.startsWith('95')) return raw;
    return `95${raw}`;
}

class LotteryClient {
    constructor(platformKey) {
        this.platformKey = platformKey;
        this.auth = null;
        this.limiter = limiterFor(platformKey);
        this.http = axios.create({
            baseURL: PLATFORMS[platformKey].baseUrl,
            timeout: 15_000,
            httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: !CONFIG.ignoreSsl }),
            headers: {
                'Content-Type': 'application/json;charset=UTF-8',
                'Ar-Origin': PLATFORMS[platformKey].origin || 'https://6win598.com',
                Origin: PLATFORMS[platformKey].origin || 'https://6win598.com',
                Referer: PLATFORMS[platformKey].referer || 'https://6win598.com/',
                'User-Agent': PLATFORMS[platformKey].userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0',
            },
        });
    }

    async call(endpoint, payload = {}) {
        await this.limiter.waitTurn();
        const body = { ...payload, language: 7, random: crypto.randomBytes(16).toString('hex') };
        body.signature = sign(body);
        body.timestamp = Math.floor(Date.now() / 1000);
        try {
            const { data } = await this.http.post(endpoint, body, this.auth ? { headers: { Authorization: this.auth } } : undefined);
            const apiCode = Number(data?.code);
            if (apiCode === 429 || /(?:rate.?limit|too many|频繁|请求过多|429)/i.test(String(data?.msg || data?.message || ''))) {
                const err = new Error(data?.msg || data?.message || 'Rate limited');
                err.status = 429;
                this.limiter.cooldown(15_000);
                throw err;
            }
            return data;
        } catch (err) {
            const status = Number(err?.response?.status ?? err?.status);
            if (status === 429) {
                const wait = retryAfterMs(err, 15_000);
                this.limiter.cooldown(wait);
                log.warn(`429 rate limit: ${this.platformKey}/${endpoint}; backing off ${wait}ms`);
            }
            throw err;
        }
    }

    async login(identifier, password, vCode = '') {
        const email = String(identifier).includes('@');
        const loginId = email ? String(identifier).trim().toLowerCase() : normalizeMobileLogin(identifier);
        const payload = {
            username: loginId,
            pwd: password,
            phonetype: 0,
            logintype: email ? 'email' : 'mobile',
            packId: '', deviceId: CONFIG.deviceId,
            adId: '', fbc: '', fbcId: '', fbp: '', pixelId: '',
        };
        const suppliedCode = String(vCode || '').trim();
        
        
        
        
        if (suppliedCode) payload.vCode = suppliedCode;
        const res = await this.call('Login', payload);
        const detail = [
            res?.msg, res?.message, res?.data?.msg, res?.data?.message,
            res?.data?.error, res?.data?.errorMessage,
        ].filter((x) => x != null).map(String).join(' ');
        const flag = (value) => value === true || value === 1 || value === '1' || value === 'true';
        const needsCode = flag(res?.data?.needVCode)
            || flag(res?.data?.needVerify)
            || flag(res?.data?.vCodeRequired)
            || flag(res?.data?.verifyCodeRequired)
            || /(?:verification|security|confirm|one.?time)\s*(?:code|otp)|v.?code|验证码|ကုဒ်/i.test(detail)
                && /(?:required|needed|enter|invalid|expired|cannot|can\s*not|must|should|verify|verification)/i.test(detail);
        if (Number(res?.code) !== 0 || !res.data || !res.data.token) {
            const err = new Error(needsCode ? 'Verification code required.' : (detail || 'Login failed'));
            if (needsCode && !suppliedCode) err.code = 'LOGIN_CODE_REQUIRED';
            throw err;
        }
        this.auth = `${res.data.tokenHeader || 'Bearer '}${res.data.token || ''}`;
    }

    async userInfo() {
        const res = await this.call('GetUserInfo');
        if (res?.code !== 0 || !res.data) return null;
        const d = res.data;
        return { userId: d.userId, username: d.userName, nickname: d.nickName, balance: d.amount, loginDate: d.userLoginDate };
    }

    async balance() {
        const res = await this.call('GetBalance');
        if (res?.code !== 0 || !res.data) return null;
        const raw = res.data.Amount ?? res.data.amount ?? res.data.balance;
        const value = parseFloat(raw);
        return Number.isFinite(value) ? value : null;
    }

    async currentIssue(game) {
        const g = GAMES[game];
        const res = await withRetry(async () => {
            const r = await this.call(g.issue, { typeId: g.typeId });
            if (r?.code !== 0) throw new Error(r?.msg || 'issue request failed');
            return r;
        }, { times: 3, delay: 2000 });
        const d = res.data || {};
        const issue = game === 'TRX' ? d.predraw?.issueNumber : d.issueNumber;
        return { issue: issue ? String(issue) : null, settled: d.settled || null, remain: Number(d.remainTime) || null };
    }

    async results(game, size = 10) {
        const isTrx = game === 'TRX';
        const endpoint = isTrx ? 'GetTRXNoaverageEmerdList' : 'GetNoaverageEmerdList';
        const typeId = GAMES[game].typeId;
        const PAGE_MAX = 10;
        const pages = Math.max(1, Math.ceil(size / PAGE_MAX));
        const out = [];
        for (let p = 1; p <= pages; p++) {
            const res = await this.call(endpoint, { pageSize: PAGE_MAX, pageNo: p, typeId });
            if (res?.code !== 0) {
                if (!out.length) throw new Error(res?.msg || 'results request failed');
                break;
            }
            const d = res.data || {};
            const list = isTrx
                ? (d.data?.gameslist || d.gameslist || d.list || [])
                : (d.list || []);
            if (!list.length && !out.length) throw new Error(res?.msg || 'results request failed');
            out.push(...list);
            if (list.length < PAGE_MAX) break;
        }
        return out.slice(0, size);
    }

    async settled(game) {
        if (game === 'TRX') {
            const { settled } = await this.currentIssue(game);
            return settled ? [settled] : [];
        }
        return this.results(game, 10);
    }

    async placeBet({ game, issue, choice, betType, unit, count }) {
        const g = GAMES[game];
        const selectType = SELECT_TYPE[betType]?.[choice];
        if (!selectType) throw new Error(`Invalid bet selection: ${choice}`);
        return withRetry(
            () => this.call(g.bet, {
                typeId: g.typeId, issuenumber: issue, gameType: betType === 'COLOR' ? 0 : 2,
                amount: unit, betCount: count, selectType,
            }),
            { times: CONFIG.betRetries, delay: 5000 },
        );
    }
}

const tailMatches = (hist, units, n) => {
    if (!n || hist.length < 2 * n) return false;
    const tail = hist.slice(-2 * n).join('');
    return units.some((u) => tail === u.repeat(n));
};

const cycle = (e, key, pattern) => {
    const i = e.run.st[key] % pattern.length;
    e.run.st[key] = (i + 1) % pattern.length;
    return { choice: pattern[i] };
};

async function sniperResult(e, name, win, reset, amount = 0, choice = null) {
    const r = e.run;
    if (win) {
        r.sniperHits++;
        r.sniperLosses = 0;
        if (!e.background) void notifyAdminArticle({ userId: e.s.id, icon: 'sniper', title: 'Sniper Hit', rows: [['User', userLabel(e.s)], ['Strategy', name], ['Bet', choiceName(choice)], ['Win amount', signed(amount * CONFIG.payout)], ['Hits', `${r.sniperHits}/${CONFIG.sniper.maxHits}`]] });
        if (r.sniperHits >= CONFIG.sniper.maxHits) { e.stopWith('sniper-hit'); return 'end'; }
        await e.say(`${em('target')} <b>${esc(name)} hit</b>  ${r.sniperHits}/${CONFIG.sniper.maxHits}`);
        reset();
        return 'hit';
    }
    r.sniperLosses++;
    if (r.sniperLosses >= CONFIG.sniper.maxLosses) { e.stopWith('sniper-loss'); return 'end'; }
    await e.say(`${em('loss')} <b>${esc(name)} miss</b>  ${r.sniperLosses}/${CONFIG.sniper.maxLosses}`);
    return 'loss';
}

const KO_ZERO_BBS = {
    bbbbb: { pred: 'S', conf: 88, name: '5B→S' }, sssss: { pred: 'B', conf: 88, name: '5S→B' },
    bbbb: { pred: 'S', conf: 85, name: '4B→S' }, ssss: { pred: 'B', conf: 85, name: '4S→B' },
    bbbs: { pred: 'S', conf: 80, name: 'B3S→S' }, sssb: { pred: 'B', conf: 80, name: 'S3B→B' },
    bbss: { pred: 'B', conf: 76, name: 'BBSS→B' }, ssbb: { pred: 'S', conf: 76, name: 'SSBB→S' },
    bbssbb: { pred: 'S', conf: 78, name: 'BBSSBB→S' }, ssbbss: { pred: 'B', conf: 78, name: 'SSBBSS→B' },
    bssbb: { pred: 'S', conf: 74, name: 'BSSBB→S' }, sbbss: { pred: 'B', conf: 74, name: 'SBBSS→B' },
    bbbss: { pred: 'S', conf: 76, name: 'BBBSS→S' }, sssbb: { pred: 'B', conf: 76, name: 'SSSBB→B' },
    bbs: { pred: 'S', conf: 72, name: 'BBS→S' }, ssb: { pred: 'B', conf: 72, name: 'SSB→B' },
    bsb: { pred: 'S', conf: 70, name: 'BSB→S' }, sbs: { pred: 'B', conf: 70, name: 'SBS→B' },
};
function koZeroRecent(e) { return e.run.hist.slice().reverse(); }
function koZeroDetectBBS(e, recent, st) {
    if (recent.length < 3) return null;
    const seq = recent.slice(0, 8).join('').toLowerCase();
    let best = null, bestScore = 0;
    for (const [pattern, data] of Object.entries(KO_ZERO_BBS)) {
        if (!seq.startsWith(pattern)) continue;
        const bonus = (seq.length - pattern.length) * 2;
        const adaptiveBoost = st.adaptiveWeight > 1 ? Math.floor((st.adaptiveWeight - 1) * 10) : 0;
        const conf = Math.min(96, data.conf + bonus + adaptiveBoost);
        if (conf > bestScore) { bestScore = conf; best = { pred: data.pred, conf, pattern: data.name, score: conf }; }
    }
    return best;
}
function koZeroPredict(e) {
    const st = e.run.st.koZero;
    const recent = koZeroRecent(e);
    const bsPatterns = [
        koZeroDetectBBS(e, recent, st),
        recent.length >= 4 && recent.slice(0, 4).every((v, i) => i === 0 || v !== recent[i - 1])
            ? { pred: recent[0] === 'B' ? 'S' : 'B', conf: 82, pattern: 'ALT→next', score: 82 } : null,
        recent.length >= 6 ? (() => { const b = recent.slice(0, 5).filter((v) => v === 'B').length; const q = recent.slice(0, 5).filter((v) => v === 'S').length; const ratio = b / (q || 1); return ratio >= 3 ? { pred: 'S', conf: 65, pattern: 'GAP→S', score: 65 } : ratio <= 0.33 ? { pred: 'B', conf: 65, pattern: 'GAP→B', score: 65 } : null; })() : null,
        recent.length >= 5 ? (() => { const first = recent[0]; let n = 0; while (recent[n] === first) n++; return n >= 3 ? { pred: first === 'B' ? 'S' : 'B', conf: Math.min(85, 60 + (n - 3) * 8), pattern: `REV→${first === 'B' ? 'S' : 'B'}`, score: Math.min(85, 60 + (n - 3) * 8) } : null; })() : null,
    ].filter(Boolean);
    let bScore = 0, sScore = 0, top = bsPatterns[0] || { pred: recent[0] || 'B', conf: 50, pattern: 'CHANCE', score: 0 }, topScore = 0;
    for (const x of bsPatterns) { if (x.pred === 'B') bScore += x.score; else sScore += x.score; if (x.score > topScore) { topScore = x.score; top = x; } }
    const total = bScore + sScore;
    let pred = bScore > sScore ? 'B' : 'S';
    let conf = Math.round((Math.max(bScore, sScore) / (total || 1)) * 100);
    conf = Math.min(96, Math.max(50, conf));
    if (bsPatterns.length > 1 && st.patternRotation % 3 === 0) {
        const alt = bsPatterns[Math.floor(st.patternRotation / 3) % bsPatterns.length];
        if (alt && alt.score > top.score * 0.7) { pred = alt.pred; conf = Math.max(50, alt.conf - 3); top = alt; }
    }
    st.patternRotation++;
    const reason = ` · ${conf}% confidence`;
    st.adaptiveWeight = st.consecutiveWrong >= 3 ? Math.min(2.0, st.adaptiveWeight + 0.1) : st.consecutiveWrong === 0 ? Math.max(1.0, st.adaptiveWeight - 0.05) : st.adaptiveWeight;
    return { choice: pred, betType: 'BS', reason };
}

function shanshredHairPredict(e) {
    const numbers = e.run.digits.slice().reverse().map(Number).filter(Number.isFinite);
    if (numbers.length < 3) return { choice: pick(['B', 'S']), reason: 'Waiting for at least 3 WINGO results' };

    const votes = [];
    const vote = (value) => { if (value === 'B' || value === 'S') votes.push(value); };
    const avg = (values) => values.reduce((a, b) => a + b, 0) / values.length;

    if (numbers.length >= 5) vote(numbers.slice(0, 5).reduce((a, b) => a + b, 0) < 35 ? 'B' : 'S');

    if (numbers.length >= 4) {
        const diffs = numbers.slice(0, 4).slice(0, 3).map((n, i) => n - numbers[i + 1]);
        const positive = diffs.filter((d) => d > 0).length;
        const negative = diffs.filter((d) => d < 0).length;
        if (positive > negative) vote('S');
        else if (negative > positive) vote('B');
    }

    const product = numbers.slice(0, 3).reduce((a, b) => a * b, 1) / 3;
    vote(product > 50 ? 'S' : 'B');

    const ratios = numbers.slice(0, 3).slice(0, 2)
        .filter((_, i) => numbers[i + 1] !== 0)
        .map((n, i) => n / numbers[i + 1]);
    if (ratios.length) {
        const ratio = avg(ratios);
        if (ratio > 1.2) vote('B');
        else if (ratio < 0.8) vote('S');
    }

    if (numbers.length >= 5) vote(numbers.slice(0, 5).filter((n) => n % 2 === 0).length > 2 ? 'S' : 'B');

    if (numbers.length >= 5) {
        const window = numbers.slice(0, Math.min(10, numbers.length));
        const current = numbers[0];
        const mean = avg(window);
        if (current > mean) vote('S');
        else if (current < mean) vote('B');
    }

    if (numbers.length >= 5) {
        const window = numbers.slice(0, Math.min(10, numbers.length));
        const min = Math.min(...window), max = Math.max(...window), range = max - min;
        if (range) {
            const position = (numbers[0] - min) / range;
            if (position > 0.7) vote('S');
            else if (position < 0.3) vote('B');
        }
    }

    if (numbers.length >= 5) {
        const window = numbers.slice(0, Math.min(10, numbers.length));
        const big = window.filter((n) => n >= 5).length;
        const small = window.length - big;
        if (small === 0) vote('S');
        else {
            const ratio = big / small;
            if (ratio > 1.5) vote('S');
            else if (ratio < 0.67) vote('B');
        }
    }

    const weighted = (numbers[0] * 13 + numbers[1] * 8 + numbers[2] * 5) / 26;
    if (weighted > 5) vote('S');
    else if (weighted < 4) vote('B');

    const squareMean = avg(numbers.slice(0, 3).map((n) => n ** 2));
    const currentSquare = numbers[0] ** 2;
    if (currentSquare > squareMean) vote('S');
    else if (currentSquare < squareMean) vote('B');

    const changes = numbers.slice(0, 3).slice(0, 2)
        .filter((_, i) => numbers[i + 1] !== 0)
        .map((n, i) => ((n - numbers[i + 1]) / numbers[i + 1]) * 100);
    if (changes.length) {
        const change = avg(changes);
        if (change > 5) vote('S');
        else if (change < -5) vote('B');
    }

    if (numbers.length >= 5) {
        const factorial = (n) => { let out = 1; for (let i = 2; i <= n; i++) out *= i; return out; };
        const facts = numbers.slice(0, 5).map(factorial);
        const currentFact = facts[0];
        const meanFact = avg(facts);
        if (currentFact > meanFact) vote('S');
        else if (currentFact < meanFact) vote('B');
    }

    const big = votes.filter((v) => v === 'B').length;
    const small = votes.length - big;
    const choice = big === small ? pick(['B', 'S']) : (big > small ? 'B' : 'S');
    const tieNote = big === small ? ' · tie/random fallback' : '';
    return {
        choice,
        reason: `12-method vote`,
    };
}

function createSkozePattern() {
    const pattern = [];
    let last = Math.random() > 0.5 ? 'B' : 'S';
    let switchCount = 0;
    const opposite = () => last === 'B' ? 'S' : 'B';
    for (let i = 0; i < 2880; i++) {
        const len = pattern.length;
        const lastTwo = pattern.slice(-2);
        const lastThree = pattern.slice(-3);
        if (lastThree.length === 3 && lastThree.every((side) => side === last)) {
            if (Math.random() < 0.88) last = opposite();
        } else if (lastTwo.length === 2 && lastTwo.every((side) => side === last)) {
            if (Math.random() < 0.72) last = opposite();
        } else if (switchCount >= 3 && len >= 6 && pattern.slice(-6).filter((side, i, arr) => i > 0 && side !== arr[i - 1]).length >= 3) {
            if (Math.random() >= 0.6) last = opposite();
        } else if (Math.random() < 0.56) {
            last = opposite();
        }
        if (pattern.length > 0 && pattern[pattern.length - 1] !== last) switchCount++;
        pattern.push(last);
    }
    return pattern;
}

const STRATEGIES = {
    PAI_TRX_SIGNAL: {
        label: 'PAI TRX SIGNAL', modes: ['BS'], notGames: Object.keys(GAMES).filter((game) => game !== 'TRX'),
        description: 'TRX only — follows the configured TRX signal when available, otherwise follows the latest TRX side.',
        predict(e) {
            const signal = latestSignalForIssue(e.run.currentIssue, e.cfg.signalChannelId);
            if (signal) { e.run.signal = signal; return { choice: signal.choice, reason: 'PAI TRX SIGNAL · channel signal' }; }
            return { choice: last(e.run.hist) ?? 'B', reason: 'PAI TRX SIGNAL · latest TRX fallback' };
        },
    },
    CHANNEL_SIGNAL: {
        label: 'Channel Signal', modes: ['BS'], notGames: Object.keys(GAMES).filter((game) => game !== 'TRX'),
        predict(e) {
            const signal = latestSignalForIssue(e.run.currentIssue, e.cfg.signalChannelId);
            if (!signal) return { choice: 'B', skip: true, reason: `Waiting for channel signal · ${e.run.currentIssue || '—'}` };
            e.run.signal = signal;
            return { choice: signal.choice, reason: '' };
        },
    },
    SHANSHRED_HAIR: {
        label: 'ʞuɐɥsʳᵉᵈ ʰᵃⁱʳ',
        modes: ['BS'],
        notGames: ['TRX'],
        predict: shanshredHairPredict,
    },
    TREND_FOLLOW: {
        label: 'B/S Follow', modes: ['BS', 'COLOR'],
        predict(e) {
            if (e.cfg.betType === 'COLOR') {
                const d = last(e.run.digits);
                return { choice: d === undefined ? pick(['G', 'V', 'R']) : colorOf(d) };
            }
            return {
                choice: last(e.run.hist) ?? 'B',
                skip: tailMatches(e.run.hist, ['BS', 'SB'], e.cfg.bsWait),
                reason: 'BS/SB pattern detected',
            };
        },
    },
    KO_ZERO: {
        label: 'KO ZERO', modes: ['BS'],
        description: 'BIG/SMALL bets only — COLOR bets are disabled for KO ZERO',
        predict: koZeroPredict,
        async onResult(e, { win, placed }) {
            if (!placed) return;
            e.run.st.koZero.consecutiveWrong = win ? 0 : e.run.st.koZero.consecutiveWrong + 1;
        },
    },
    ALTERNATE: {
        label: 'B/S Reverse', modes: ['BS'],
        predict(e) {
            const l = last(e.run.hist);
            return {
                choice: l ? (l === 'B' ? 'S' : 'B') : 'B',
                skip: tailMatches(e.run.hist, ['BB', 'SS'], e.cfg.bbWait),
                reason: 'BB/SS pattern detected',
            };
        },
    },
    BS_ORDER: {
        label: 'BS Order', modes: ['BS'],
        predict(e) { return cycle(e, 'patternIdx', e.cfg.pattern || DEFAULT_BS_ORDER); },
    },
    OP_PATTERN: {
        label: 'Ko Min', modes: ['BS'],
        predict(e) { return cycle(e, 'opIdx', OP_PATTERN); },
    },
    ALINKAR: {
        label: 'Ko Tiger', modes: ['BS'],
        predict(e) { return cycle(e, 'alinkarIdx', ALINKAR_PATTERN); },
    },
    GOLDEN_RATIO: {
        label: 'Golden Ratio', modes: ['BS'],
        description: 'Looks up the last 7 settled BIG/SMALL results in the supplied 128-pattern mapping. It skips betting until 7 results are available.',
        predict(e) {
            const history = e.run.hist;
            if (history.length < 7) {
                return { choice: 'B', skip: true, reason: `Golden Ratio · waiting for ${7 - history.length} more result(s)` };
            }
            const pattern = history.slice(-7).join('');
            const index = Number.parseInt([...pattern].map((side) => side === 'S' ? '1' : '0').join(''), 2);
            const choice = GOLDEN_RATIO_OUTPUTS[Math.floor(index / 8)]?.[index % 8];
            if (choice !== 'B' && choice !== 'S') {
                return { choice: 'B', skip: true, reason: `Golden Ratio · no mapping for ${pattern}` };
            }
            return { choice, reason: `Golden Ratio · ${pattern} → ${choice}` };
        },
    },
    SKO_ZE: {
        label: 'Sko-ze', modes: ['BS'],
        notGames: Object.keys(GAMES).filter((game) => game !== 'WINGO_30S'),
        description: 'Recreates 6lottery30s.html: generates a fresh 2,880-slot randomized B/S sequence for each bot run, then selects by the current Myanmar 30-second time slot. It does not use previous results; WINGO 30s only.',
        predict(e) {
            const state = e.run.st;
            if (!Array.isArray(state.skozePattern) || state.skozePattern.length !== 2880) {
                state.skozePattern = createSkozePattern();
            }
            const myanmarTime = new Date(Date.now() + 6.5 * 60 * 60 * 1000);
            const secondsSinceMidnight = myanmarTime.getUTCHours() * 3600 + myanmarTime.getUTCMinutes() * 60 + myanmarTime.getUTCSeconds();
            const slot = Math.floor(secondsSinceMidnight / 30);
            const choice = state.skozePattern[slot];
            return { choice, reason: `Sko-ze · Myanmar 30s slot ${slot + 1}/2880` };
        },
    },
    KO_PAING: {
        label: 'KO PAING', modes: ['BS'],
        description: 'Fixed stake only: skip the first 5 rounds, then bet BIG. Keep betting BIG after a win; after a loss, skip 5 rounds and bet BIG again.',
        predict(e) {
            const st = e.run.st.koPaing;
            if (st.skipRemaining > 0) {
                const skipped = KO_PAING_SKIP_COUNT - st.skipRemaining + 1;
                st.skipRemaining--;
                return { choice: 'B', skip: true, reason: `KO PAING · skip ${skipped}/${KO_PAING_SKIP_COUNT}` };
            }
            return { choice: 'B', reason: st.hasBet ? 'KO PAING · continue BIG after win' : 'KO PAING · first BIG bet' };
        },
        async onResult(e, { win, placed }) {
            const st = e.run.st.koPaing;
            if (placed) {
                st.hasBet = true;
                if (!win) st.skipRemaining = KO_PAING_SKIP_COUNT;
            }
        },
    },

    QUANTUM_CALC: {
        label: 'Ma May Myat', modes: ['BS'],
        predict(e) {
            const h = e.run.hist;
            if (h.length < 5) return { choice: 'B' };
            const val = (r) => (r === 'B' ? 7 : 2);
            const sum = (arr) => arr.reduce((a, r) => a + val(r), 0);
            const diff = Math.abs(sum(h.slice(-5)) - sum(h.slice(0, -5)));
            const digit = diff % 10;
            const twoDigit = diff >= 10;
            return { choice: (digit >= 5) === twoDigit ? 'S' : 'B' };
        },
    },
    TIME_WARP: {
        label: 'Ma Hnin', modes: ['BS'],
        predict(e) {
            const h = e.run.hist;
            const pos = e.run.st.pos;
            return { choice: h.length >= pos ? h[h.length - pos] : last(h) ?? 'B' };
        },
        async onResult(e, { win, placed }) { if (placed && !win) e.run.st.pos = e.run.st.pos === 8 ? 5 : 8; },
    },
    SHINE: {
        label: 'Ko Shine', modes: ['BS'],
        predict(e) {
            const h = e.run.hist;
            if (!h.length) return { choice: pick(['B', 'S']) };
            const l = last(h);
            let streak = 1;
            for (let i = h.length - 2; i >= 0 && h[i] === l; i--) streak++;
            const seq = SHINE_PATTERNS[l];
            return { choice: seq[(streak - 1) % seq.length] };
        },
    },

    CYBER_SNIPER: {
        label: 'SNIPER', modes: ['BS'], sniper: true,
        predict(e) {
            const st = e.run.st.cyber;
            const d = last(e.run.digits);
            if (!st.active && (d === 0 || d === 9)) {
                Object.assign(st, { active: true, direction: d === 0 ? 'B' : 'S', sequence: [d === 0 ? 'B' : 'S'], step: 0, gotSame: false });
            }
            if (!st.active) return { choice: 'B', skip: true, reason: 'waiting for a 0 or 9' };
            return { choice: st.sequence[st.step] ?? st.direction };
        },
        async onResult(e, { win, placed, amount, choice }) {
            if (!placed) return;
            const st = e.run.st.cyber;
            const outcome = await sniperResult(e, 'Cyber Sniper', win,
                () => Object.assign(st, { active: false, direction: null, sequence: [], step: 0, gotSame: false }), amount, choice);
            if (outcome !== 'loss') return;
            st.step++;
            const [prev, cur] = [last(e.run.digits, 2), last(e.run.digits)];
            if (st.step === 1 && prev === cur) {
                st.gotSame = true;
                if (cur === 0) st.sequence = ['B', 'S', 'B', 'B'];
                if (cur === 9) st.sequence = ['S', 'B', 'S', 'S'];
            }
        },
    },
    COLOR_SNIPER: {
        label: 'Color Sniper', modes: ['COLOR'], sniper: true,
        predict(e) {
            const st = e.run.st.color;
            const d = last(e.run.digits);
            if (!st.active && (d === 1 || d === 7)) st.active = true;
            return st.active ? { choice: 'R' } : { choice: 'R', skip: true, reason: 'waiting for a 1 or 7' };
        },
        async onResult(e, { win, placed, amount, choice }) {
            if (!placed) return;
            const st = e.run.st.color;
            await sniperResult(e, 'Color Sniper', win, () => { st.active = false; }, amount, choice);
        },
    },
};

const STRATEGY_KEY_ALIASES = Object.freeze({ QUATAM_CALC: 'QUANTUM_CALC' });
function strategyDisplayName(strategyKey) {
    const key = STRATEGY_KEY_ALIASES[String(strategyKey)] || String(strategyKey);
    return STRATEGIES[key]?.label || String(strategyKey);
}

const SETTING_CODE_RE = /^PAI-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
function normalizeSettingCode(value) {
    const code = String(value || '').trim().toUpperCase();
    return SETTING_CODE_RE.test(code) ? code : null;
}
function randomSettingCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(12);
    let raw = '';
    for (const byte of bytes) raw += alphabet[byte % alphabet.length];
    return `PAI-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}
function sharedSettingPayload(s) {
    const cfg = s.cfg;
    return {
        game: cfg.game, betType: cfg.betType, betMode: cfg.betMode, strategy: cfg.strategy,
        signalChannelId: cfg.signalChannelId || null, staking: cfg.staking,
        betSizes: normalizeBetSizes(cfg.betSizes), pattern: cfg.pattern,
        bsWait: cfg.bsWait, bbWait: cfg.bbWait, target: cfg.target, stopLoss: cfg.stopLoss,
        entryLayer: cfg.entryLayer, slLayer: cfg.slLayer, virtual: Boolean(cfg.virtual),
        virtualBalance: cfg.virtualBalance, autoTimeStart: cfg.autoTimeStart,
        autoTimeEnd: cfg.autoTimeEnd, autoDurationMinutes: cfg.autoDurationMinutes,
        autoWinCount: cfg.autoWinCount, language: cfg.language,
    };
}
function saveSharedSettingCode(s, preferredCode = null) {
    const codes = stores.settingCodes.data.codes || (stores.settingCodes.data.codes = {});
    let code = normalizeSettingCode(preferredCode);
    while (!code || codes[code]) code = randomSettingCode();
    codes[code] = { ...sharedSettingPayload(s), createdBy: String(s.id), createdAt: new Date().toISOString() };
    stores.settingCodes.save();
    return code;
}
function importSharedSettingCode(s, value) {
    const code = normalizeSettingCode(value);
    if (!code) return { ok: false, message: 'Setting Code format မမှန်ပါ။ ဥပမာ <code>PAI-ABCD-EFGH-JKLM</code>' };
    const payload = stores.settingCodes.data.codes?.[code];
    if (!payload) return { ok: false, message: 'ဒီ Setting Code ကို မတွေ့ပါ။ Code မှန်/မမှန် ပြန်စစ်ပါ။' };
    if (!GAMES[payload.game] || !STRATEGIES[payload.strategy] || !STRATEGIES[payload.strategy].modes.includes(payload.betType)) {
        return { ok: false, message: 'ဒီ Setting Code ထဲက game/strategy configuration ကို အသုံးပြုလို့မရပါ။' };
    }
    const cfg = s.cfg;
    Object.assign(cfg, {
        game: payload.game, betType: payload.betType, betMode: BET_MODES.includes(payload.betMode) ? payload.betMode : 'STRAIGHT',
        strategy: payload.strategy, staking: STAKING_MODES.includes(payload.staking) ? payload.staking : 'Martingale',
        betSizes: normalizeBetSizes(payload.betSizes), pattern: payload.pattern || DEFAULT_BS_ORDER,
        bsWait: Number(payload.bsWait) || 0, bbWait: Number(payload.bbWait) || 0,
        target: payload.target == null ? null : Number(payload.target), stopLoss: payload.stopLoss == null ? null : Number(payload.stopLoss),
        entryLayer: [1, 2, 3].includes(Number(payload.entryLayer)) ? Number(payload.entryLayer) : 1,
        slLayer: Math.max(0, Number(payload.slLayer) || 0), autoTimeStart: payload.autoTimeStart ?? null,
        autoTimeEnd: payload.autoTimeEnd ?? null, autoDurationMinutes: payload.autoDurationMinutes ?? null,
        autoWinCount: payload.autoWinCount ?? null, signalChannelId: payload.signalChannelId || null,
        virtual: Boolean(payload.virtual), virtualBalance: Number(payload.virtualBalance) || 0,
        language: LANG[payload.language] ? payload.language : 'en',
    });
    saveSettings();
    return { ok: true, code, payload };
}

const SETTING_CODE_PROFILES = Object.freeze([
    { minBalance: 5_000, stakes: [0, 0, 100, 300, 500, 1200, 3200], game: 'WINGO_30S', strategy: 'SHANSHRED_HAIR', autoWinCount: 20, slLayer: 0 },
    { minBalance: 10_000, stakes: [0, 0, 0, 100, 300, 500, 1200, 2800, 5800], game: 'TRX', strategy: 'QUANTUM_CALC', autoWinCount: null, slLayer: 0 },
    { minBalance: 30_000, stakes: [0, 0, 0, 100, 300, 700, 2100, 6300, 20000], game: 'TRX', strategy: 'PAI_TRX_SIGNAL', autoWinCount: null, slLayer: 0 },
    { minBalance: 50_000, stakes: [0, 0, 100, 300, 500, 1500, 4000, 10000, 33500], game: 'WINGO_30S', strategy: 'SHANSHRED_HAIR', autoWinCount: 35, slLayer: 2 },
    { minBalance: 100_000, stakes: [0, 0, 0, 100, 300, 500, 1500, 4000, 10000, 30000, 53500], game: 'WINGO_30S', strategy: 'SHANSHRED_HAIR', autoWinCount: null, slLayer: 2 },
]);
function settingCodeProfile(balance) {
    const amount = Number(String(balance).replace(/[,_\s]/g, ''));
    if (!Number.isSafeInteger(amount) || amount < SETTING_CODE_PROFILES[0].minBalance) return null;
    return [...SETTING_CODE_PROFILES].reverse().find((profile) => amount >= profile.minBalance) || null;
}
function settingCodeListText() {
    const lines = SETTING_CODE_PROFILES.map((p) => {
        const auto = p.autoWinCount ? `Auto Bet Time - ${p.autoWinCount}Wins` : 'Auto Bet Time - off';
        const sl = p.slLayer ? ` · Bet SL - ${p.slLayer}` : '';
        return `<code>${p.minBalance.toLocaleString('en-US')}+</code> → <code>${p.stakes.join(',')}</code> / ${GAMES[p.game].label} / ${auto}${sl} / Strategy - <b>${esc(STRATEGIES[p.strategy].label)}</b>`;
    });
    return `${em('settings')} <b>Setting Code Profiles</b>

${lines.join('\n\n')}

<blockquote>Apply: <code>/settingcode balance target stoploss</code>
ဥပမာ: <code>/settingcode 50000 10000 5000</code>
သို့မဟုတ် code ကို သီးသန့်ပို့ပြီးနောက် Target / Stop Loss ကို ဆက်ပို့နိုင်ပါတယ်။</blockquote>`;
}
function applySettingCode(s, balance, target = null, stopLoss = null) {
    const profile = settingCodeProfile(balance);
    if (!profile) return { ok: false, message: 'Setting Code အတွက် balance အနည်းဆုံး 5,000 Ks လိုအပ်ပါတယ်။ 5,000 / 10,000 / 30,000 / 50,000 / 100,000 tier များထဲမှ သက်ဆိုင်ရာအမြင့်ဆုံး tier ကို အသုံးပြုပါမယ်။' };
    const cfg = s.cfg;
    Object.assign(cfg, {
        game: profile.game,
        betType: 'BS',
        betMode: 'STRAIGHT',
        strategy: profile.strategy,
        staking: 'Martingale',
        betSizes: [...profile.stakes],
        autoTimeStart: null,
        autoTimeEnd: null,
        autoDurationMinutes: null,
        autoWinCount: profile.autoWinCount,
        entryLayer: 1,
        slLayer: profile.slLayer,
        target: target == null ? null : Number(target),
        stopLoss: stopLoss == null ? null : Number(stopLoss),
    });
    if (profile.strategy === 'PAI_TRX_SIGNAL') cfg.signalChannelId = cfg.signalChannelId || null;
    saveSettings();
    const code = saveSharedSettingCode(s);
    return { ok: true, profile, code };
}
function settingCodeAppliedText(profile, balance, target, stopLoss, code = null, imported = false) {
    const auto = profile.autoWinCount ? `${profile.autoWinCount} wins` : 'off';
    const sl = profile.slLayer ? `${profile.slLayer} losses` : 'off';
    return `${em('ok')} <b>Setting Code applied</b>

` +
        `Balance code: <b>${Number(balance).toLocaleString('en-US')}+</b>
` +
        `Game: <b>${esc(GAMES[profile.game].label)}</b>
` +
        `Strategy: <b>${esc(STRATEGIES[profile.strategy].label)}</b>
` +
        `Stake: <code>${profile.stakes.join(',')}</code>
` +
        `Auto Bet Time: <b>${auto}</b>
` +
        `Bet SL: <b>${sl}</b>
` +
        `Profit Target: <b>${target == null ? 'not set' : ks(target)}</b>
` +
        `Stop Loss: <b>${stopLoss == null ? 'not set' : ks(stopLoss)}</b>` +
        (code ? `\nSetting Code: <code>${esc(code)}</code>${imported ? ' (imported)' : ' · share this code'}` : '');
}

function stakeAmount(cfg, run, _balance) {
    const sizes = normalizeBetSizes(cfg.betSizes);
    if (cfg.strategy === 'KO_PAING' && sizes.length !== 1) throw new Error('KO PAING requires exactly one fixed stake size.');
    const selected = sizes[Math.min(run.martinIdx, sizes.length - 1)];
    if (selected === 'ALL IN') return allInAmount(cfg, _balance);
    
    
    return selected;
}

function normalizeBetSizes(values) {
    return (Array.isArray(values) ? values : []).map((value) => {
        if (typeof value === 'string' && /^all\s*in$/i.test(value.trim())) return 'ALL IN';
        return Number(value);
    }).filter((value) => value === 'ALL IN' || (Number.isInteger(value) && value >= 0));
}

function betUnitFor(cfg) {
    return cfg.platform === '6LOTTERY' ? 100 : 10;
}

function allInAmount(cfg, balance) {
    const available = Number(balance);
    if (!Number.isFinite(available) || available <= 0) return 0;
    const unit = betUnitFor(cfg);
    return Math.floor(available / unit) * unit;
}

function stakeUpdate(cfg, run, win, _amount, zeroStake = false) {
    const sizes = normalizeBetSizes(cfg.betSizes);
    const top = sizes.length - 1;
    if (top < 0) return;
    if (zeroStake) {
        run.martinIdx = win ? 0 : Math.min(run.martinIdx + 1, top);
        return;
    }
    switch (cfg.staking) {
        case 'Martingale': run.martinIdx = win ? 0 : Math.min(run.martinIdx + 1, top); break;
        case 'Anti-Martingale': run.martinIdx = win ? Math.min(run.martinIdx + 1, top) : 0; break;
        default: break;
    }
}

function calculatedStakeSizes(startAmount, balance, platform) {
    const available = Number(balance);
    const base = platform === 'CKLOTTERY' ? 10 : 100;
    const start = Number(startAmount);
    if (!Number.isFinite(available) || !Number.isFinite(start) || start < base || start > available) return [];
    if (start % base !== 0) return [];
    const sizes = [];
    let next = start;
    let total = 0;
    while (total + next <= available) {
        sizes.push(next);
        total += next;
        next = next * 2 + base;
    }
    return sizes;
}

const stakeLevel = (_cfg, run) => run.martinIdx + 1;

function splitStake(amount) {
    const total = Math.max(1, Math.floor(amount));
    const unit = [10000, 1000, 100, 10, 1].find((u) => total % u === 0);
    return { unit, count: total / unit, total };
}

const pad2 = (n) => String(n).padStart(2, '0');
const parseClock = (value) => {
    const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!m) return null;
    let h = Number(m[1]); const minute = Number(m[2]);
    if (minute > 59 || h > 23) return null;
    if (m[3]) { const ap = m[3].toUpperCase(); if (h < 1 || h > 12) return null; h = h % 12 + (ap === 'PM' ? 12 : 0); }
    return h * 60 + minute;
};
const clockText = (minutes) => { if (minutes == null) return null; const h24 = Math.floor(minutes / 60) % 24; const ap = h24 >= 12 ? 'PM' : 'AM'; const h = h24 % 12 || 12; return `${pad2(h)}:${pad2(minutes % 60)} ${ap}`; };
const formatAutoTime = (cfg) => cfg.autoTimeStart == null || cfg.autoTimeEnd == null ? 'off' : `${clockText(cfg.autoTimeStart)} - ${clockText(cfg.autoTimeEnd)}`;
const formatRunLimits = (cfg) => [cfg.autoDurationMinutes ? `${cfg.autoDurationMinutes} mins` : null, cfg.autoWinCount ? `${cfg.autoWinCount} wins` : null].filter(Boolean).join(' / ') || 'until manually stopped';
const myanmarMinute = () => { const d = new Date(Date.now() + 6.5 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
function autoScheduleState(cfg) {
    if (cfg.autoTimeStart == null || cfg.autoTimeEnd == null) return 'active';
    const now = myanmarMinute(), start = cfg.autoTimeStart, end = cfg.autoTimeEnd;
    if (start === end) return 'active';
    if (start < end) return now < start ? 'before' : now >= end ? 'after' : 'active';
    return now >= start || now < end ? 'active' : 'after';
}

const sessions = new Map();

class Session {
    constructor(id) {
        this.id = id;
        this.client = null;
        this.creds = null;
        this.info = null;
        this.tg = {};
        this.running = false;
        this.run = null;
        this.input = null;
        this.manual = { bets: [], game: null, view: null, live: null, quick: null };
        this.walletConfirm = null;
        this.dailySummaryDay = null;
        this.forceJoinBlocked = false;
        this.forceJoinNoticeSent = false;
    }
    get cfg() { return getSettings(this.id); }
}
const getSession = (id) => { let s = sessions.get(id); if (!s) sessions.set(id, (s = new Session(id))); return s; };

const newRun = (cfg) => ({
    startedAt: Date.now(),
    deadlineAt: cfg.autoDurationMinutes ? Date.now() + cfg.autoDurationMinutes * 60_000 : null,
    startBalance: 0, profit: 0, vBalance: cfg.virtualBalance, vStart: cfg.virtualBalance,
    bets: 0, wins: 0, losses: 0,
    martinIdx: 0, dalUnits: 1, customIdx: 0,
    consecLosses: 0, slSkip: false, saved: null,
    entry: cfg.entryLayer > 1 ? { waiting: true, losses: 0 } : null,
    hist: [], digits: [], seen: new Set(),
    lastIssue: null, currentIssue: null, signal: null, errors: 0, pending: null,
    sniperHits: 0, sniperLosses: 0, targetNotified: false,
    maxWin: 0, maxLoss: 0, currentWinStreak: 0, currentLossStreak: 0, maxWinStreak: 0, maxLossStreak: 0,
    lastLowWarn: 0, lastLogin: Date.now(), endReason: null, detail: null,
    st: {
        patternIdx: 0, opIdx: 0, alinkarIdx: 0, pos: 8, skozePattern: null,
        cyber: { active: false, direction: null, sequence: [], step: 0, gotSame: false },
        color: { active: false },
        koZero: { consecutiveWrong: 0, patternRotation: 0, adaptiveWeight: 1.0 },
        koPaing: { skipRemaining: KO_PAING_SKIP_COUNT, hasBet: false },
    },
});

const END_REASONS = {
    user: { icon: 'stop', title: 'Session stopped', text: 'Stopped manually' },
    target: { icon: 'target', title: 'Target reached', text: 'Profit target reached' },
    'stop-loss': { icon: 'warn', title: 'Stop loss hit', text: 'Loss limit reached' },
    'sniper-hit': { icon: 'sniper', title: 'Sniper mission complete', text: `${CONFIG.sniper.maxHits} target hits achieved` },
    'sniper-loss': { icon: 'warn', title: 'Sniper stopped', text: `${CONFIG.sniper.maxLosses} consecutive misses` },
    'time-range': { icon: 'stop', title: 'Time range complete', text: 'The configured auto-bet time range has ended' },
    duration: { icon: 'stop', title: 'Run time complete', text: 'The configured run duration has ended' },
    'win-count': { icon: 'target', title: 'Win count complete', text: 'The configured win count has been reached' },
    'low-balance': { icon: 'warn', title: 'Balance too low', text: 'Balance below the smallest stake' },
    errors: { icon: 'error', title: 'Connection problems', text: 'Too many consecutive API errors' },
    balance: { icon: 'error', title: 'Balance unavailable', text: 'Could not read the balance' },
    config: { icon: 'error', title: 'Configuration error', text: 'Invalid configuration' },
    blocked: { icon: 'error', title: 'Chat unavailable', text: 'The bot can no longer message this chat' },
    'force-join': { icon: 'lock', title: 'Force Join required', text: 'User left a required Channel/Group' },
    maintenance: { icon: 'warn', title: 'Maintenance mode', text: 'Bot is under maintenance' },
    banned: { icon: 'error', title: 'Account banned', text: 'Your access has been revoked' },
    error: { icon: 'error', title: 'Unexpected error', text: 'Engine crashed' },
};
const RESTARTABLE = new Set(['target', 'stop-loss', 'sniper-hit', 'sniper-loss']);

class Engine {
    constructor(session) { this.s = session; }
    get cfg() { return this.s.cfg; }
    get client() { return this.s.client; }
    get run() { return this.s.run; }

    say(html, markup) {
        return ui.html(this.s.id, html, markup).catch((err) => {
            log.error(`send to ${this.s.id} failed: ${err.message}`);
            if (err.response?.error_code === 403) this.stopWith('blocked');
        });
    }

    stopWith(reason, detail) {
        if (!this.run.endReason) { this.run.endReason = reason; this.run.detail = detail ?? null; }
        this.s.running = false;
    }

    profitNow() { return this.cfg.virtual ? this.run.vBalance - this.run.vStart : this.run.profit; }

    async start() {
        const s = this.s;
        s.running = true;
        try {
            if (!(await this.prepare())) return;
            await this.announce();
            while (s.running) await this.tick();
        } catch (err) {
            log.error(`engine ${s.id}: ${err.stack || err.message}`);
            this.stopWith('error', err.message);
        } finally {
            await this.finish();
        }
    }

    async prepare() {
        const { cfg, s } = this;
        s.run = newRun(cfg);
        if (!cfg.virtual) {
            let balance = null;
            for (let i = 0; i < CONFIG.balanceRetries && balance === null; i++) {
                balance = await this.client.balance().catch(() => null);
                if (balance === null) await sleep(3000);
            }
            if (balance === null) { this.stopWith('balance'); await this.finish(); return false; }
            s.run.startBalance = balance;
        }
        try { this.ingest(cfg.game === 'TRX' ? await getTrxResults('TRX', 20) : await this.client.results(cfg.game, 20)); } catch (err) { log.warn(`seed failed: ${err.message}`); }
        return true;
    }

    async announce() {
        const { cfg } = this;
        const balance = cfg.virtual ? this.run.vBalance : this.run.startBalance;
        const launchRows = [
            ['User', userLabel(this.s)],
            ['Game site', cfg.platform],
            ['Game', `${GAMES[cfg.game].label} · ${cfg.strategy === 'KO_ZERO' ? 'Auto BIG/SMALL' : cfg.betType === 'COLOR' ? 'Color' : 'Big/Small'}`],
            ['Strategy', this.strategyLabel()],
            ['Bet mode', betModeLabel(cfg.betMode)],
            ['Staking', `${cfg.staking} · ${cfg.betSizes.join(', ')} Ks`],
            ['Wallet', `${cfg.virtual ? 'Virtual' : 'Real'} · ${ks(balance)}`],
            ['Profit target', cfg.target ? ks(cfg.target) : 'off'],
            ['Stop loss', cfg.stopLoss ? ks(cfg.stopLoss) : 'off'],
            ['Entry / SL layer', `${cfg.entryLayer} / ${cfg.slLayer || 'off'}`],
            ['Virtual balance', cfg.virtual ? ks(cfg.virtualBalance) : '—'],
            ['Auto time range', formatAutoTime(cfg)],
            ['Run limit', formatRunLimits(cfg)],
        ];
        await ui.card(this.s.id, {
            icon: 'start', title: 'Bot engaged',
            sections: [{ rows: launchRows.slice(1).map(([k, v]) => [k, v]) }],
        });
        void notifyAdminArticle({ userId: this.s.id, icon: 'start', title: 'Auto Bet launched', rows: launchRows });
    }

    strategyLabel() {
        const { cfg } = this;
        let label = STRATEGIES[cfg.strategy].label;
        if (cfg.strategy === 'TREND_FOLLOW' && cfg.bsWait) label += ` (wait BS/SB ×${cfg.bsWait})`;
        if (cfg.strategy === 'ALTERNATE' && cfg.bbWait) label += ` (wait BB/SS ×${cfg.bbWait})`;
        if (cfg.strategy === 'BS_ORDER') label += ` (${cfg.pattern})`;
        return `${label} · ${betModeLabel(cfg.betMode)}`;
    }

    async finish() {
        const { s, cfg, run: r } = this;
        if (!r) return;
        s.running = false;
        const reason = r.endReason || 'user';
        const meta = END_REASONS[reason] || END_REASONS.error;
        const balance = cfg.virtual ? r.vBalance : await this.client.balance().catch(() => null);
        const rows = [
            ['Reason', meta.text],
            ['Total Bets', r.bets],
            ['Rounds', `${r.bets}  (W ${r.wins} · L ${r.losses})`],
            ['Net P/L', signed(this.profitNow())],
            ['Max Win', r.maxWin ? signed(r.maxWin) : '—'],
            ['Max Loss', r.maxLoss ? signed(-r.maxLoss) : '—'],
            ['Max Win Streak', r.maxWinStreak],
            ['Max Loss Streak', r.maxLossStreak],
            [cfg.virtual ? 'Virtual balance' : 'Balance', balance == null ? '—' : ks(balance)],
            ['Runtime', duration(Date.now() - r.startedAt)],
        ];
        if (r.detail) rows.push(['Detail', r.detail]);
        const markup = reason === 'target'
            ? ratingPicker(cfg.strategy)
            : RESTARTABLE.has(reason)
                ? inline([[cb('Restart', 'restart', 'success', 'start')]])
                : mainMenu(s);
        const finishNote = reason === 'target'
            ? 'Profit Target ရောက်ပါပြီ။ အသုံးပြုခဲ့တဲ့ Strategy ကို 1–5 stars rating ပေးပါ။'
            : r.pending ? 'A bet placed just before stopping may still settle on the platform.' : undefined;
        await ui.card(s.id, { icon: meta.icon, title: meta.title, sections: [{ rows }], note: finishNote }, markup);
        s.run = null;
    }

    

    async tick() {
        const { cfg, run: r } = this;
        const schedule = autoScheduleState(cfg);
        if (schedule === 'before') { await sleep(1000); return; }
        if (schedule === 'after') { this.stopWith('time-range'); return; }
        if (r.deadlineAt && Date.now() >= r.deadlineAt) { this.stopWith('duration'); return; }
        if (cfg.autoWinCount && r.wins >= cfg.autoWinCount) { this.stopWith('win-count'); return; }
        await this.maybeRelogin();

        let cur;
        try { cur = await this.client.currentIssue(cfg.game); r.errors = 0; }
        catch (err) {
            log.warn(`issue error: ${err.message}`);
            if (++r.errors >= CONFIG.maxConsecutiveErrors) this.stopWith('errors');
            await sleep(2000);
            return;
        }
        if (!cur.issue || cur.issue === r.lastIssue) { await sleep(1000); return; }
        r.currentIssue = cur.issue;

        const balance = await this.refreshBalance();
        if (balance === null) { this.stopWith('balance'); return; }

        if (!STRATEGIES[cfg.strategy]?.sniper && cfg.stopLoss && this.profitNow() <= -cfg.stopLoss) {
            this.stopWith('stop-loss');
            return;
        }
        if (!STRATEGIES[cfg.strategy]?.sniper && cfg.target && this.profitNow() >= cfg.target) {
            this.stopWith('target');
            return;
        }
        const positiveSizes = normalizeBetSizes(cfg.betSizes).filter((size) => size === 'ALL IN' || size > 0);
        const minBet = Math.min(...positiveSizes.filter((size) => size !== 'ALL IN'), ...(
            positiveSizes.includes('ALL IN') ? [betUnitFor(cfg)] : []
        ));
        if (positiveSizes.length && balance < minBet) { this.stopWith('low-balance'); return; }
        if (positiveSizes.length && balance < minBet * 3 && Date.now() - r.lastLowWarn > CONFIG.lowBalanceWarnMs) {
            r.lastLowWarn = Date.now();
            await this.say(`${em('warn')} <b>Low balance</b>  ${ks(balance)} · smallest stake ${ks(minBet)}`);
        }

        if (cfg.strategy === 'CHANNEL_SIGNAL' && !latestSignalForIssue(cur.issue, cfg.signalChannelId)) {
            await sleep(1000);
            return;
        }
        const decision = await this.decide();
        const strategy = STRATEGIES[cfg.strategy];
        const betType = decision.betType || cfg.betType;
        if (!SELECT_TYPE[betType]?.[decision.choice]) { this.stopWith('config', `invalid ${betType} choice ${decision.choice}`); return; }

        let amount;
        try { amount = stakeAmount(cfg, r, balance); } catch (err) { this.stopWith('config', err.message); return; }
        const zeroStake = amount === 0 && !decision.skip;
        if (decision.skip || zeroStake) {
            r.lastIssue = cur.issue;
            await this.say(`${em('skip')} <b>SKIP</b>  <code>${esc(cur.issue)}</code>\n<blockquote>${esc(decision.reason || '0 stake step')}${esc(modeNote)}\n${em('strategy')} ${esc(this.strategyLabel())} · ${em('wallet')} stake L${stakeLevel(cfg, r)}</blockquote>`);
            const item = await this.awaitSettle(cur.issue);
            if (item) await this.settle({ issue: cur.issue, choice: decision.choice, amount: 0, placed: false, zeroStake, item, strategy });
            return;
        }

        const { unit, count, total } = splitStake(amount);
        if (total > balance) { this.stopWith('low-balance'); return; }

        if (!cfg.virtual) {
            let res;
            try { res = await this.client.placeBet({ game: cfg.game, issue: cur.issue, choice: decision.choice, betType, unit, count }); }
            catch (err) { res = { code: -1, msg: err.message }; }
            if (res?.code !== 0) {
                await this.say(`${em('error')} <b>Bet rejected</b>  ${esc(res?.msg || 'unknown error')}\n<i>Retrying shortly…</i>`);
                if (++r.errors >= CONFIG.maxConsecutiveErrors) this.stopWith('errors');
                await sleep(5000);
                return;
            }
        }

        r.lastIssue = cur.issue;
        r.pending = cur.issue;
        await this.say(
            `<blockquote>╭───${em('order')} <b>BET PLACED</b> · ${em('virtual')} <b>${esc(choiceName(decision.choice))}</b>\n` +
            `├─${em('game')} ${esc(GAMES[cfg.game].label)} · ${betType === 'COLOR' ? 'COLOR' : 'BIG / SMALL'}\n` +
            `├─${em('wait')} Issue: <code>${esc(cur.issue)}</code>\n` +
            `├─${em('wallet')} Stake: ${total.toLocaleString('en-US')} Ks · Level L${stakeLevel(cfg, r)}\n` +
            `├─${em('strategy')} Strategy: ${esc(this.strategyLabel())}\n` +
            `╰─ ${em('smart')} Signal: ${decisionReasonHtml(cfg, r, decision.reason) || '—'}</blockquote>`,
        );

        const item = await this.awaitSettle(cur.issue);
        if (item) await this.settle({ issue: cur.issue, choice: decision.choice, betType, amount: total, placed: true, item, strategy });
        r.pending = null;
    }

    async decide() {
        const { cfg, run: r } = this;
        const d = await STRATEGIES[cfg.strategy].predict(this);
        const betType = d.betType || this.cfg.betType;
        const sourceChoice = d.choice;
        const choice = betType === 'BS' ? applyBetMode(sourceChoice, this.cfg.betMode) : sourceChoice;
        let skip = !!d.skip;
        let reason = d.reason || '';
        if (!skip && r.entry?.waiting) {
            skip = true;
            reason = cfg.entryLayer === 2 ? 'Entry layer · waiting for 1 loss' : `Entry layer · ${r.entry.losses}/2 losses`;
        }
        if (!skip && r.slSkip) { skip = true; reason = 'SL layer · waiting for a recovery win'; }
        return { choice, sourceChoice, betType, skip, reason };
    }

    async refreshBalance() {
        if (this.cfg.virtual) return this.run.vBalance;
        return withRetry(() => this.client.balance(), { times: 2, delay: 1500 }).catch(() => null);
    }

    async maybeRelogin() { }

    

    ingest(list) {
        const r = this.run;
        const fresh = list
            .filter((x) => x?.issueNumber && x.number !== '' && x.number != null && !r.seen.has(String(x.issueNumber)))
            .sort((a, b) => cmpIssue(a.issueNumber, b.issueNumber));
        for (const item of fresh) {
            const n = Number(item.number) % 10;
            r.seen.add(String(item.issueNumber));
            r.hist.push(bsOf(n)); r.digits.push(n);
        }
        if (r.hist.length > 20) r.hist = r.hist.slice(-20);
        if (r.digits.length > 10) r.digits = r.digits.slice(-10);
        if (r.seen.size > 500) r.seen = new Set([...r.seen].slice(-200));
    }

    async awaitSettle(issue) {
        const deadline = Date.now() + GAMES[this.cfg.game].waitMs;
        while (this.s.running && Date.now() < deadline) {
            try {
                const list = this.cfg.game === 'TRX' ? await getTrxResults('TRX') : await this.client.settled(this.cfg.game);
                this.ingest(list);
                const hit = list.find((x) => String(x.issueNumber) === String(issue) && x.number !== '' && x.number != null);
                if (hit) return hit;
            } catch (err) { log.warn(`settle poll: ${err.message}`); }
            await sleep(CONFIG.pollMs);
        }
        if (this.s.running) await this.say(`${em('warn')} Result for <code>${esc(issue)}</code> did not arrive in time — continuing.`);
        return null;
    }

    async settle({ issue, choice, betType = this.cfg.betType, amount, placed, zeroStake = false, item, strategy }) {
        const { cfg, run: r } = this;
        const n = Number(item.number) % 10;
        const size = bsOf(n);
        const color = colorOf(n);
        const win = betType === 'COLOR' ? choice === color : choice === size;
        const resultLine = `<b>${n}</b> · ${size === 'B' ? 'Big' : 'Small'} · ${dot(color)}`;

        if (placed) {
            r.bets++; win ? r.wins++ : r.losses++;
            const delta = win ? amount * CONFIG.payout : -amount;
            if (cfg.virtual) r.vBalance += delta; else r.profit += delta;
            if (win) {
                r.maxWin = Math.max(r.maxWin, amount * CONFIG.payout);
                r.currentWinStreak++; r.currentLossStreak = 0;
                r.maxWinStreak = Math.max(r.maxWinStreak, r.currentWinStreak);
            } else {
                r.maxLoss = Math.max(r.maxLoss, amount);
                r.currentLossStreak++; r.currentWinStreak = 0;
                r.maxLossStreak = Math.max(r.maxLossStreak, r.currentLossStreak);
            }
            stakeUpdate(cfg, r, win, amount);
            recordDailySummary(this.s.id, 'auto', cfg.strategy, win, delta);

            if (cfg.slLayer > 0) {
                if (win) { r.consecLosses = 0; r.slSkip = false; }
                else if (++r.consecLosses >= cfg.slLayer) {
                    r.saved = { martinIdx: r.martinIdx, dalUnits: r.dalUnits, customIdx: r.customIdx };
                    r.slSkip = true;
                }
            }
        } else {
            this.updateEntryLayer(win);
            if (zeroStake) stakeUpdate(cfg, r, win, 0, true);
            if (r.slSkip && win) {
                r.slSkip = false; r.consecLosses = 0;
                if (r.saved) Object.assign(r, r.saved);
            }
        }

        await strategy.onResult?.(this, { win, placed, n, amount, choice, issue });

        if (placed) {
            const balance = cfg.virtual ? r.vBalance : await this.client.balance().catch(() => null);
            const profit = this.profitNow();
            const sl = cfg.slLayer && !win ? `${em('warn')} SL streak ${r.consecLosses}/${cfg.slLayer}` : '';
            await this.say(
                `<blockquote>╭───${win ? em('win') : em('loss')} <b>${win ? 'WIN' : 'LOSS'} · ${win ? signed(amount * CONFIG.payout) : signed(-amount)}</b>\n` +
                `├─${em('game')} ${esc(GAMES[cfg.game].label)} · ${betType === 'COLOR' ? 'COLOR' : 'BIG / SMALL'}\n` +
                `├─${em('wait')} Issue: <code>${esc(issue)}</code>\n` +
                `├─${em('result')} Result: ${resultLine}\n` +
                `├─${em('order')} Pick: ${esc(choiceName(choice))} · Stake: ${amount.toLocaleString('en-US')} Ks\n` +
                `├─${em('wallet')} Balance: ${balance == null ? '—' : ks(balance)}\n` +
                `${sl ? `├─${sl}\n` : ''}` +
                `╰─ ${em('profit')} Session P/L: ${signed(profit)}</blockquote>`,
            );
            if (cfg.autoWinCount && r.wins >= cfg.autoWinCount) { this.stopWith('win-count'); return; }
        } else {
            await this.say(`${em('skip')} <i>shadow</i>\n${esc(choiceName(choice))} would ${win ? 'have won' : 'have lost'} · ${resultLine}`);
        }
        await this.checkLimits(strategy);
    }

    updateEntryLayer(win) {
        const e = this.run.entry;
        if (!e?.waiting) return;
        if (this.cfg.entryLayer === 2) { if (!win) e.waiting = false; }
        else if (this.cfg.entryLayer === 3) {
            if (win) e.losses = 0;
            else if (++e.losses >= 2) e.waiting = false;
        }
    }

    async checkLimits(strategy) {
        if (strategy.sniper) return;
        const { cfg } = this;
        const profit = this.profitNow();
        try {
            if (cfg.target && profit >= cfg.target) {
                if (!this.run.targetNotified) {
                    this.run.targetNotified = true;
                    const balance = cfg.virtual ? this.run.vBalance : await this.client.balance().catch(() => null);
                    void notifyAdminArticle({ userId: this.s.id, icon: 'target', title: 'Profit Target reached', rows: [['User', userLabel(this.s)], ['Game', GAMES[cfg.game].label], ['Profit', signed(profit)], ['Balance', balance == null ? '—' : ks(balance)]] });
                }
                this.stopWith('target');
                return;
            }
            if (cfg.stopLoss && profit <= -cfg.stopLoss) {
                this.stopWith('stop-loss');
                return;
            }
        } catch (err) {
            log.error(`checkLimits error for ${this.s.id}: ${err.message}`);
        }
    }
}

function startEngine(s) {
    const cfg = s.cfg;
    if (!s.client) return 'Sign in first.';
    if (!isAuthorized(s.id, s.info?.userId)) {
        return `အသုံးပြုခွင့်မရှိပါ။ Telegram ID ${s.id}, Game ID ${s.info?.userId} ကို Admin ${CONFIG.supportContact} ထံသို့ ပို့ပါ။`;
    }
    if (s.running) return 'The bot is already running.';
    if (!cfg.betSizes.length) return 'Set your stake sizes first.';
    if (cfg.strategy === 'KO_PAING') {
        const sizes = normalizeBetSizes(cfg.betSizes);
        if (sizes.length !== 1 || sizes[0] === 'ALL IN' || sizes[0] <= 0) return 'KO PAING requires exactly one fixed stake size (for example: 1000).';
    }
    const st = STRATEGIES[cfg.strategy];
    if (!st) return 'Pick a strategy first.';
    if (cfg.strategy === 'CHANNEL_SIGNAL' && cfg.game !== 'TRX') return 'Channel Signal သည် TRX game တစ်ခုတည်းအတွက်သာ ဖြစ်ပါသည်။';
    if (!st.modes.includes(cfg.betType)) return `${st.label} does not support ${cfg.betType === 'COLOR' ? 'Color' : 'Big/Small'} bets — choose another strategy.`;
    if (stores.bot.data.hiddenStrategies?.[cfg.strategy] === true) return 'ဒီ Strategy ကို Owner က ဖျောက်ထားသောကြောင့် အသစ်စတင်၍ မရပါ။';
    if (st.notGames?.includes(cfg.game)) return `${st.label} is not available on ${GAMES[cfg.game].label}.`;

    saveSettings();
    new Engine(s).start().catch((err) => log.error(`engine crash: ${err.stack}`));
    return null;
}

const bot = new Telegraf(CONFIG.token);
const LANG = {
    en: {
        quickTitle: 'Confirm Quick Bet', confirm: 'Confirm', cancel: 'Cancel',
        daily: 'Daily Summary', bets: 'Bets', wins: 'Wins', losses: 'Losses', winRate: 'Win rate', profit: 'Profit',
        language: 'Language', languageSet: 'Language set to English.', waiting: 'Result is tracked automatically.',
    },
    my: {
        quickTitle: 'Quick Bet အတည်ပြုပါ', confirm: 'အတည်ပြုမည်', cancel: 'မလုပ်တော့ပါ',
        daily: 'နေ့စဉ်အနှစ်ချုပ်', bets: 'Bet အရေအတွက်', wins: 'အနိုင်', losses: 'အရှုံး', winRate: 'အနိုင်ရာခိုင်နှုန်း', profit: 'အမြတ်/အရှုံး',
        language: 'ဘာသာစကား', languageSet: 'ဘာသာစကားကို မြန်မာလို ပြောင်းပြီးပါပြီ။', waiting: 'Result ကို အလိုအလျောက် စောင့်ကြည့်နေပါသည်။',
    },
};
const langOf = (s) => LANG[s?.cfg?.language] ? s.cfg.language : 'en';
const tr = (s, key) => LANG[langOf(s)][key] || LANG.en[key] || key;
const groupNotificationsEnabledFor = (userId) => {
    if (userId == null || !isAdmin(Number(userId))) return true;
    return stores.bot.data.groupNotificationDisabled?.[String(userId)] !== true;
};

async function notifyAdminGroup(text, userId) {
    if (!groupNotificationsEnabledFor(userId)) return;
    try {
        await bot.telegram.sendMessage(CONFIG.adminGroupId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (err) { log.warn(`admin group notification failed: ${err.message}`); }
}
async function notifyAdminArticle({ userId, icon = 'info', title, rows, note: articleNote }) {
    if (!groupNotificationsEnabledFor(userId)) return;
    try {
        await ui.card(CONFIG.adminGroupId, { icon, title, sections: [{ rows }], note: articleNote });
    } catch (err) { log.warn(`admin group article notification failed: ${err.message}`); }
}
const userLabel = (s) => esc(s?.tg?.username ? `@${s.tg.username}` : s?.tg?.name || s?.id || 'unknown');
const BUTTON_MY = {
    'Sign In': 'ဝင်ရောက်မည်', 'Tutorial': 'သင်ခန်းစာ', 'Launch': 'စတင်မည်', 'Halt': 'ရပ်မည်', 'Stake Sizes': 'လောင်းကြေးပမာဏ', 'Wallet Mode': 'ပိုက်ဆံအိတ်',
    'Game': 'ဂိမ်း', 'Bet Type': 'လောင်းမည့်အမျိုးအစား', 'Strategy': 'နည်းဗျူဟာ', 'Straight / Reverse': 'Straight / Reverse', 'Staking': 'လောင်းကြေးစနစ်', 'Risk Guard': 'အန္တရာယ်ထိန်းချုပ်မှု',
    'Manual Bet': 'လက်ဖြင့်လောင်းမည်', 'Account': 'အကောင့်', 'Switch Account': 'အကောင့်ပြောင်းမည်', 'Admin Panel': 'Admin Panel', 'Back': 'နောက်သို့',
    'Profit Target': 'အမြတ်ပန်းတိုင်', 'Stop Loss': 'အရှုံးကန့်သတ်ချက်', 'Entry Layer': 'စတင်လောင်းမည့်အဆင့်', 'SL Layer': 'SL အဆင့်',
    'BIG': 'အကြီး', 'SMALL': 'အသေး', 'RED': 'အနီ', 'GREEN': 'အစိမ်း', 'VIOLET': 'ခရမ်း', 'Results': 'ရလဒ်များ', 'My Bets': 'ကျွန်ုပ်၏ Bet များ',
    'Balance': 'လက်ကျန်ငွေ', 'Game Type': 'ဂိမ်းအမျိုးအစား', 'TRX Checker': 'TRX စစ်ဆေးရန်', 'Add User': 'User ထည့်ရန်', 'Remove Users': 'Users ဖယ်ရန်',
    'Active Users': 'Active Users', 'Allowed IDs': 'ခွင့်ပြုထားသော ID များ', 'Broadcast': 'Broadcast', 'Add Admin': 'Admin ထည့်ရန်', 'Remove Admin': 'Admin ဖယ်ရန်',
    'List Admins': 'Admin စာရင်း', 'Main Menu': 'ပင်မမီနူး', 'Ban User': 'User Ban', 'Unban User': 'User Ban ဖြေမည်', 'Banned List': 'Ban စာရင်း',
    'Site Visibility': 'Site ဖော်/ဖျောက်', 'Strategy Visibility': 'Strategy ဖော်/ဖျောက်', 'Maintenance': 'ပြုပြင်ထိန်းသိမ်းမှု', 'Free Mode': 'အခမဲ့ Mode', 'Group Notification': 'Group Noti', 'Add Force Join': 'Force Join ထည့်ရန်', 'Remove Force Join': 'Force Join ဖယ်ရန်', 'Force Join List': 'Force Join စာရင်း', 'Add Channel': 'Channel ထည့်ရန်', 'Remove Channel': 'Channel ဖယ်ရန်', 'Channel Status': 'Channel အခြေအနေ', 'Pending Payment': 'ဆိုင်းငံ့ငွေပေးချေမှု', 'Payment Amount': 'ငွေလွှဲပမာဏ', 'Language': 'ဘာသာစကား', 'Cancel': 'မလုပ်တော့ပါ', 'Confirm': 'အတည်ပြုမည်',
    'Stop Live': 'Live ရပ်မည်', 'Refresh': 'ပြန်စစ်မည်', 'Restart': 'ပြန်စမည်', 'Custom': 'စိတ်ကြိုက်', 'Prev': 'ရှေ့စာမျက်နှာ', 'Next': 'နောက်စာမျက်နှာ',
    'ON': 'ဖွင့်', 'OFF': 'ပိတ်', 'Off': 'ပိတ်', 'Auto Bet Time': 'Auto Bet Time', 'WINGO': 'WINGO', '30s': '၃၀ စက္ကန့်', '1min': '၁ မိနစ်', '3min': '၃ မိနစ်', '5min': '၅ မိနစ်',
};
function localizeMarkup(chatId, markup) {
    const s = sessions.get(Number(chatId));
    if (!markup || !s || langOf(s) !== 'my') return markup;
    const translate = (button) => button?.text && BUTTON_MY[button.text] ? { ...button, text: BUTTON_MY[button.text] } : button;
    return {
        ...markup,
        ...(markup.inline_keyboard ? { inline_keyboard: markup.inline_keyboard.map((row) => row.map(translate)) } : {}),
        ...(markup.keyboard ? { keyboard: markup.keyboard.map((row) => row.map(translate)) } : {}),
    };
}
const BUTTON_EN_BY_MY = Object.fromEntries(Object.entries(BUTTON_MY).map(([en, my]) => [my, en]));
const canonicalButtonText = (s, text) => langOf(s) === 'my' ? (BUTTON_EN_BY_MY[text] || text) : text;


const EMOJI_FALLBACK = {
    start: '🚀', stop: '🛑', win: '✅', loss: '❌', skip: '⏭', order: '🎯', wallet: '👛', profit: '📈',
    result: '🎲', game: '🎮', strategy: '🧠', user: '👤', admin: '🛡', broadcast: '📣', warn: '⚠️',
    error: '⛔', ok: '✔️', info: 'ℹ️', wait: '⏳', virtual: '🧪', real: '💵', target: '🏁', risk: '🧯',
    settings: '⚙️', chart: '📊', lock: '🔐', sniper: '🔭', back: '◀️', manual: '🕹', list: '🗂',
    entry: '🚪', slLayer: '🧱', staking: '💰', kpay: '💳', wave: '🌊',
    dotG: '🟢', dotV: '🟣', dotR: '🔴', mmFlag: '🇲🇲',
    celebrate: '🎉', bot: '🤖', smart: '💡', signal: '📡', goal: '🎯', graph: '📈', shield: '🛡️',
    fast: '⚡', gem: '💎', down: '👇', tutorial: '📚', signin: '🔑', fire: '🔥', star: '⭐',
    money: '💸', trophy: '🏆', premium: '👑', phone: '📱', alert: '🚨', check: '☑️', time: '🕒',
    site_6lottery: '🎰', site_777bigwin: '🎲', site_cklottery: '🍀', site_shwelottery: '🔴',
};
const em = (name) => {
    const id = stores.emoji.data[name];
    const fallback = EMOJI_FALLBACK[name] || '•';
    return id ? `<tg-emoji emoji-id="${esc(id)}">${fallback}</tg-emoji>` : fallback;
};
const iconOf = (name) => (name && stores.emoji.data[name] ? { icon_custom_emoji_id: stores.emoji.data[name] } : {});

const dot = (c) => em({ G: 'dotG', V: 'dotV', R: 'dotR' }[c]);
const betTypeOf = (side) => (side === 'B' || side === 'S' ? 'BS' : 'COLOR');
const isWin = (side, n) => (betTypeOf(side) === 'BS' ? side === bsOf(n) : side === colorOf(n));
const winProfit = (side, amount) => amount * (side === 'V' ? CONFIG.payoutViolet : CONFIG.payout);
const sideTag = (side) => (COLOR_NAME[side] ? `${dot(side)} ${COLOR_NAME[side].toUpperCase()}` : choiceName(side));
const sidePlain = (side) => (COLOR_NAME[side] ? `${COLOR_DOT[side]} ${COLOR_NAME[side].toUpperCase()}` : choiceName(side));
const ticketHead = (icon, title, tail = '') => `╭───${em(icon)} <b>「 ${title} 」</b>${tail ? `  ${tail}` : ''}`;
const ticketLead = (content) => `│   ${content}`;
const ticketRow = (content) => `├─ ${content}`;
const ticketFoot = (content) => `╰─ ${content}`;

const cb = (text, data, style, icon) => ({ text: utf8Safe(text), callback_data: utf8Safe(data), ...(style ? { style: utf8Safe(style) } : {}), ...iconOf(icon) });
const key = (text, style, icon) => ({ text, ...(style ? { style } : {}), ...iconOf(icon) });
const inline = (rows) => ({ inline_keyboard: rows });
const replyKb = (rows) => ({ keyboard: rows, resize_keyboard: true, is_persistent: false });

const L = {
    login: 'Sign In', tutorial: 'Tutorial', launch: 'Launch', halt: 'Halt', sizes: 'Stake Sizes', wallet: 'Wallet Mode',
    game: 'Game', betType: 'Bet Type', strategy: 'Strategy', betMode: 'Straight / Reverse', staking: 'Staking', risk: 'Risk Guard',
    manual: 'Manual Bet', account: 'Account', switchAcc: 'Switch Account', admin: 'Admin Panel', back: 'Back',
    target: 'Profit Target', stopLoss: 'Stop Loss', entry: 'Entry Layer', slLayer: 'SL Layer',
    big: 'BIG', small: 'SMALL', red: 'RED', green: 'GREEN', violet: 'VIOLET',
    results: 'Results', myBets: 'My Bets', balance: 'Balance', manualGame: 'Game Type',
    trx: 'TRX Checker', autoTime: 'Auto Bet Time', settingCode: 'Setting Code', importCode: 'Import Code', shareCode: 'Share Code',
    addUser: 'Add User', removeUser: 'Remove Users', activeUsers: 'Active Users', allowed: 'Allowed IDs',
    broadcast: 'Broadcast', addAdmin: 'Add Admin', removeAdmin: 'Remove Admin', listAdmins: 'List Admins', menu: 'Main Menu',
    banUser: 'Ban User', unbanUser: 'Unban User', bannedList: 'Banned List',
    siteVisibility: 'Site Visibility', strategyVisibility: 'Strategy Visibility', maintenance: 'Maintenance', freeMode: 'Free Mode', groupNotifications: 'Group Notification', forceJoinAdd: 'Add Force Join', forceJoinRemove: 'Remove Force Join', forceJoinList: 'Force Join List', addChannel: 'Add Channel', removeChannel: 'Remove Channel', channelStatus: 'Channel Status', pendingPayment: 'Pending Payment', paymentAmount: 'Payment Amount', language: 'Language',
};

function mainMenu(s) {
    if (!s?.client) return replyKb([
        [key(L.login, 'primary', 'lock'), key(L.tutorial, 'primary', 'info')],
        ...(isAdmin(s?.id) ? [[key(L.admin, 'primary', 'admin')]] : []),
    ]);
    const rows = [
        [key(L.launch, 'success', 'start'), key(L.halt, 'danger', 'stop')],
        [key(L.sizes, undefined, 'wallet'), key(L.wallet, undefined, 'virtual')],
        [key(L.game, undefined, 'game'), ...(s.cfg.strategy === 'KO_ZERO' ? [] : [key(L.betType, undefined, 'result')])],
        [key(L.strategy, 'primary', 'strategy'), key(L.betMode, undefined, 'strategy')],
        [key(L.staking, undefined, 'staking'), key(L.risk, undefined, 'risk')],
        [key(L.settingCode, 'primary', 'settings'), key(L.importCode, 'primary', 'download'), key(L.shareCode, 'success', 'share')],
        [key(L.autoTime, undefined, 'wait'), key(L.manual, undefined, 'manual')],
        [key(L.account, undefined, 'user'), key(L.switchAcc, undefined, 'lock')],
        [key(L.trx, 'primary', 'chart')],
        [key(L.language, undefined, 'info')],
    ];
    if (isAdmin(s.id)) rows.push([key(L.admin, 'primary', 'admin')]);
    return replyKb(rows);
}
function riskMenu() {
    return replyKb([
        [key(L.target, 'success', 'target'), key(L.stopLoss, 'danger', 'warn')],
        [key(L.entry, undefined, 'entry'), key(L.slLayer, undefined, 'risk')],
        [key(L.autoTime, undefined, 'wait')],
        [key(L.back, undefined, 'back')],
    ]);
}
const manualMenu = () => replyKb([
    [key(L.big, 'success', 'profit'), key(L.small, 'danger', 'loss')],
    [key(L.green, undefined, 'dotG'), key(L.red, undefined, 'dotR'), key(L.violet, undefined, 'dotV')],
    [key(L.results, 'primary', 'chart'), key(L.myBets, undefined, 'list')],
    [key(L.balance, undefined, 'wallet'), key(L.manualGame, undefined, 'game')],
    [key(L.back, undefined, 'back')],
]);
const ADMIN_MENU_LABELS = Object.freeze({
    addUser: L.addUser, removeUser: L.removeUser, activeUsers: L.activeUsers, allowed: L.allowed,
    banUser: L.banUser, unbanUser: L.unbanUser, bannedList: L.bannedList,
    groupNotifications: L.groupNotifications, broadcast: L.broadcast,
    addAdmin: L.addAdmin, removeAdmin: L.removeAdmin, listAdmins: L.listAdmins,
    pendingPayment: L.pendingPayment, paymentAmount: L.paymentAmount,
    addChannel: L.addChannel, removeChannel: L.removeChannel, channelStatus: L.channelStatus,
    forceJoinAdd: L.forceJoinAdd, forceJoinRemove: L.forceJoinRemove, forceJoinList: L.forceJoinList,
    maintenance: L.maintenance, freeMode: L.freeMode,
    siteVisibility: L.siteVisibility, strategyVisibility: L.strategyVisibility, mainMenu: L.menu,
});
const adminMenu = (id) => {
    const item = (text, action, style, icon) => cb(text, `adm:${action}`, style, icon);
    if (!isAdmin(id)) return inline([[item(L.menu, 'mainMenu', undefined, 'back')]]);
    const rows = [
        [item(L.addUser, 'addUser', 'success', 'ok'), item(L.removeUser, 'removeUser', 'danger', 'error')],
        [item(L.activeUsers, 'activeUsers', undefined, 'user'), item(L.allowed, 'allowed', undefined, 'list')],
        [item(L.banUser, 'banUser', undefined, 'error'), item(L.unbanUser, 'unbanUser', undefined, 'ok'), item(L.bannedList, 'bannedList', undefined, 'list')],
        [item(L.groupNotifications, 'groupNotifications', undefined, 'broadcast'), ...(isOwner(id) ? [item(L.broadcast, 'broadcast', undefined, 'broadcast')] : [])],
    ];
    if (isOwner(id)) {
        rows.push(
            [item(L.addAdmin, 'addAdmin', undefined, 'admin'), item(L.removeAdmin, 'removeAdmin', undefined, 'admin'), item(L.listAdmins, 'listAdmins', undefined, 'list')],
            [item(L.pendingPayment, 'pendingPayment', undefined, 'wallet'), item(L.paymentAmount, 'paymentAmount', undefined, 'wallet')],
            [item(L.addChannel, 'addChannel', undefined, 'broadcast'), item(L.removeChannel, 'removeChannel', undefined, 'broadcast'), item(L.channelStatus, 'channelStatus', undefined, 'list')],
            [item(L.forceJoinAdd, 'forceJoinAdd', undefined, 'lock'), item(L.forceJoinRemove, 'forceJoinRemove', undefined, 'lock'), item(L.forceJoinList, 'forceJoinList', undefined, 'list')],
            [item(L.maintenance, 'maintenance', 'danger', 'settings'), item(L.freeMode, 'freeMode', 'success', 'ok')],
            [item(L.siteVisibility, 'siteVisibility', 'primary', 'settings'), item(L.strategyVisibility, 'strategyVisibility', 'primary', 'strategy')],
        );
    }
    rows.push([item(L.menu, 'mainMenu', undefined, 'back')]);
    return inline(rows);
};
const visiblePlatforms = () => Object.entries(PLATFORMS).filter(([platformKey]) => stores.bot.data.hiddenPlatforms?.[platformKey] !== true);
const platformMenuText = () => visiblePlatforms().length
    ? `${em('lock')} <b>Choose a platform</b>`
    : `${em('warn')} <b>လက်ရှိ ရွေးချယ်နိုင်သော Site မရှိပါ။ Owner ကို ဆက်သွယ်ပါ။</b>`;
const platformButtonText = (p) => `${stores.emoji.data[p.emoji] ? '' : (EMOJI_FALLBACK[p.emoji] || '🎰')}${stores.emoji.data[p.emoji] ? '' : ' '}${p.name}`;
const platformMenu = () => {
    const visible = visiblePlatforms();
    return replyKb([
        ...(visible.length ? [visible.map(([, p]) => key(platformButtonText(p), p.style, p.emoji))] : []),
        [key(L.back, undefined, 'back')],
    ]);
};
const siteVisibilityMenu = () => inline([
    ...Object.entries(PLATFORMS).map(([platformKey, p]) => {
        const hidden = stores.bot.data.hiddenPlatforms?.[platformKey] === true;
        return [cb(`${hidden ? '🔴' : '🟢'} ${platformButtonText(p)} · ${hidden ? 'Hidden' : 'Shown'}`, `sv:toggle:${platformKey}`, hidden ? 'danger' : 'success', p.emoji)];
    }),
    [cb('Back to Admin', 'sv:back', undefined, 'back')],
]);
const strategyVisibilityMenu = () => inline([
    ...Object.entries(STRATEGIES).map(([strategyKey, st]) => {
        const hidden = stores.bot.data.hiddenStrategies?.[strategyKey] === true;
        return [cb(`${hidden ? '🔴' : '🟢'} ${st.label} · ${hidden ? 'Hidden' : 'Shown'}`, `stratvis:toggle:${strategyKey}`, hidden ? 'danger' : 'success', 'strategy')];
    }),
    [cb('Back to Admin', 'stratvis:back', undefined, 'back')],
]);

const cancelRow = [cb('Cancel', 'x:cancel', 'danger', 'error')];
const gamePicker = (prefix, current) => inline([
    [cb('WINGO', `${prefix}:WINGO_SELECT`, current?.startsWith('WINGO') ? 'success' : 'primary', 'game'),
    cb('TRX', `${prefix}:TRX`, current === 'TRX' ? 'success' : 'primary', 'game')],
    cancelRow,
]);
const wingoPicker = (prefix, current) => inline([
    [['WINGO_30S', '30s'], ['WINGO', '1min']].map(([g, t]) => cb(t, `${prefix}:${g}`, current === g ? 'success' : undefined)),
    [['WINGO_3MIN', '3min'], ['WINGO_5MIN', '5min']].map(([g, t]) => cb(t, `${prefix}:${g}`, current === g ? 'success' : undefined)),
    cancelRow,
]);
const waitPicker = (prefix, current) => {
    const btn = (n) => cb(String(n), `${prefix}:${n}`, current === n ? 'success' : undefined);
    return inline([[1, 2, 3].map(btn), [4, 5, 6].map(btn), [cb('Off', `${prefix}:0`, current === 0 ? 'success' : 'danger')]]);
};

function strategyRatingEntries(strategy) {
    const all = stores.strategyRatings.data.ratings || {};
    return Array.isArray(all[strategy]) ? all[strategy] : [];
}
function strategyRatingLabel(strategy) {
    const entries = strategyRatingEntries(strategy);
    if (!entries.length) return '★ —';
    const average = entries.reduce((sum, entry) => sum + Number(entry.rating || 0), 0) / entries.length;
    return `★ ${average.toFixed(1)} (${entries.length})`;
}
function recordStrategyRating(userId, strategy, rating) {
    const ratings = stores.strategyRatings.data.ratings || (stores.strategyRatings.data.ratings = {});
    const entries = Array.isArray(ratings[strategy]) ? ratings[strategy] : [];
    const record = { userId: String(userId), rating, updatedAt: new Date().toISOString() };
    const index = entries.findIndex((entry) => String(entry.userId) === String(userId));
    if (index >= 0) entries[index] = record;
    else entries.push(record);
    ratings[strategy] = entries;
    stores.strategyRatings.save();
}
const ratingPicker = (strategy) => inline([
    [1, 2, 3, 4, 5].map((n) => cb(`${n} ★`, `rate:${strategy}:${n}`, n >= 4 ? 'success' : n <= 2 ? 'danger' : 'primary')),
    [cb('Skip', `rate:${strategy}:skip`), cb('Restart', 'restart', 'success', 'start')],
]);
function strategyPicker(cfg) {
    const buttons = [];
    for (const [id, st] of Object.entries(STRATEGIES)) {
        if (stores.bot.data.hiddenStrategies?.[id] === true) continue;
        if ((!st.modes.includes(cfg.betType) && !['GOLDEN_RATIO', 'SKO_ZE'].includes(id)) || st.notGames?.includes(cfg.game)) continue;
        if (id === 'CHANNEL_SIGNAL') {
            const channels = configuredSignalChannelButtons();
            if (!channels.length) buttons.push(cb('Channel', 'st:CHANNEL_SIGNAL', cfg.strategy === id ? 'success' : 'primary'));
            else for (const channel of channels) buttons.push(cb(channel.label, `st:CHANNEL_SIGNAL:${channel.id}`, cfg.strategy === id && String(cfg.signalChannelId) === channel.id ? 'success' : 'primary'));
            continue;
        }
        buttons.push(cb(`${st.label} · ${strategyRatingLabel(id)}`, `st:${id}`, cfg.strategy === id ? 'success' : 'primary'));
    }
    return inline([...chunk(buttons, 2), cancelRow]);
}

function renderClassic(card) {
    const head = `<blockquote>${card.icon ? `${em(card.icon)} ` : ''}<b>${esc(card.title)}</b></blockquote>`;
    const body = card.sections.map((sec) => {
        const table = [...(sec.header ? [sec.header] : []), ...sec.rows].map((r) => r.map(String));
        const widths = table[0].map((_, c) => Math.max(...table.map((r) => [...(r[c] ?? '')].length)));
        const lines = table.map((r) => r.map((cell, c) => (c < r.length - 1 ? cell.padEnd(widths[c]) : cell)).join('  '));
        if (sec.header) lines.splice(1, 0, widths.map((w) => '─'.repeat(w)).join('──'));
        return `${sec.title ? `<b>${esc(sec.title)}</b>\n` : ''}<pre>${esc(lines.join('\n'))}</pre>`;
    }).join('\n');
    return `${head}\n${body}${card.note ? `\n<i>${esc(card.note)}</i>` : ''}`;
}

function richCell(value) {
    let out = esc(value);
    for (const [name, fallback] of Object.entries(EMOJI_FALLBACK)) {
        const id = stores.emoji.data[name];
        if (id && fallback) out = out.split(fallback).join(`<tg-emoji emoji-id="${esc(id)}">${fallback}</tg-emoji>`);
    }
    return out;
}

function renderRich(card) {
    const tables = card.sections.map((sec) => {
        const head = sec.header ? `<tr>${sec.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>` : '';
        const rows = sec.rows.map((r) => `<tr>${r.map((cell, i) => `<td>${!sec.header && i === 0 ? `<b>${richCell(cell)}</b>` : richCell(cell)}</td>`).join('')}</tr>`).join('');
        return `${sec.title ? `<h4>${esc(sec.title)}</h4>` : ''}<table bordered striped>${head}${rows}</table>`;
    }).join('');
    return `<h3>${card.icon ? `${em(card.icon)} ` : ''}${esc(card.title)}</h3>${tables}${card.note ? `<p><i>${esc(card.note)}</i></p>` : ''}`;
}

let richEnabled = CONFIG.richMessages;

const ui = {
    html(chatId, text, markup) {
        return bot.telegram.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...(markup ? { reply_markup: localizeMarkup(chatId, markup) } : {}),
        });
    },
    async card(chatId, card, markup) {
        if (richEnabled) {
            try {
                return await bot.telegram.callApi('sendRichMessage', {
                    chat_id: chatId,
                    rich_message: { html: renderRich(card) },
                    ...(markup ? { reply_markup: localizeMarkup(chatId, markup) } : {}),
                });
            } catch (err) {
                const msg = String(err.description || err.message || '');
                log.warn(`sendRichMessage failed, falling back: ${msg}`);
                if (/method|not found|unknown|404/i.test(msg)) richEnabled = false; 
            }
        }
        return this.html(chatId, renderClassic(card), markup).catch((err) => log.error(`card send failed: ${err.message}`));
    },
};



function accountCard(s, balance) {
    const cfg = s.cfg;
    const info = s.info || {};
    const platform = PLATFORMS[cfg.platform];
    const st = STRATEGIES[cfg.strategy];
    return {
        icon: 'user', title: 'Account overview',
        sections: [
            { title: 'Identity', rows: [['User ID', info.userId ?? '—'], ['Name', info.nickname || info.username || '—'], ['Platform', platform?.name ?? '—'], ['Last login', info.loginDate ?? '—']] },
            { title: 'Wallet', rows: [['Balance', balance == null ? '—' : ks(balance)], ['Mode', cfg.virtual ? 'Virtual' : 'Real']] },
            {
                title: 'Play', rows: [
                    ['Game', GAMES[cfg.game].label], ['Bet type', cfg.strategy === 'KO_ZERO' ? 'Auto BIG/SMALL' : cfg.betType === 'COLOR' ? 'Color' : 'Big/Small'],
                    ['Strategy', st?.label ?? cfg.strategy], ['Bet mode', betModeLabel(cfg.betMode)], ['Staking', cfg.staking], ['Stakes', cfg.betSizes.join(', ') || 'not set'],
                    ...(cfg.strategy === 'BS_ORDER' ? [['BS pattern', cfg.pattern]] : []),
                ],
            },
            {
                title: 'Risk guard', rows: [
                    ['Profit target', cfg.target ? ks(cfg.target) : 'off'], ['Stop loss', cfg.stopLoss ? ks(cfg.stopLoss) : 'off'],
                    ['Entry layer', ['Immediate', 'After 1 loss', 'After 2 losses'][cfg.entryLayer - 1]], ['SL layer', cfg.slLayer ? `${cfg.slLayer} losses` : 'off'],
                ],
            },
            { title: 'Status', rows: [['Bot', s.running ? '● running' : '○ stopped']] },
        ],
    };
}

const fmtRemain = (sec) => (sec ? `${Math.floor(sec / 60)}m ${sec % 60}s` : null);

function resultsCard(view, page, game) {
    const pages = Math.min(4, Math.ceil(view.list.length / 10));
    const rows = view.list.slice((page - 1) * 10, page * 10).map((r) => {
        const n = Number(r.number) % 10;
        return [String(r.issueNumber).slice(-8), String(n), bsOf(n) === 'B' ? 'Big' : 'Small', `${COLOR_DOT[colorOf(n)]} ${COLOR_NAME[colorOf(n)]}`];
    });
    return {
        card: {
            icon: 'chart', title: `${GAMES[game].label} · page ${page}/${pages}`,
            sections: [{ header: ['Period', 'No.', 'Size', 'Colour'], rows }],
            note: fmtRemain(view.remain) ? `Next draw in ${fmtRemain(view.remain)}` : undefined,
        },
        pages,
    };
}
const resultsNav = (page, pages) => inline([[
    ...(page > 1 ? [cb('Prev', `rp:${page - 1}`, 'primary', 'back')] : []),
    cb(`${page}/${pages}`, 'rp:x'),
    ...(page < pages ? [cb('Next', `rp:${page + 1}`, 'primary')] : []),
]]);

const note = (kind, text) => `${em(kind)} ${text}`;

const paymentStartKb = () => inline([[cb('Payment / Screenshot', 'pay:open', 'success', 'wallet')]]);
const paymentInstructionText = () =>
    `${em('wallet')} <b>အသုံးပြုခွင့်ရရန် ငွေလွှဲရန်</b>

` +
    `<b>Amount:</b> <code>${getPaymentAmount().toLocaleString('en-US')} Ks</code>
` +
    `${em('kpay')} <b>KPAY</b>: <code>${esc(PAYMENT_ACCOUNTS.kpay)}</code>
` +
    `${em('wave')} <b>WAVE</b>: <code>${esc(PAYMENT_ACCOUNTS.wave)}</code>

` +
    `ငွေလွှဲပြီးပါက Screenshot ကို ဤ chat ထဲသို့ ပို့ပေးပါ။ Owner စစ်ဆေးပြီး Approve လုပ်ပေးပါမည်။`;
const denyText = (tgId, gameId) =>
    `${em('error')} <b>အသုံးပြုခွင့်မရရှိသေးပါ။</b>

` +
    `အသုံးပြုခွင့်ရရန် <b>${getPaymentAmount().toLocaleString('en-US')} Ks</b> လွှဲပြီး Screenshot ပို့ပါ။
` +
    `Telegram ID: <code>${esc(tgId)}</code>
` +
    `Game ID: <code>${esc(gameId)}</code>

` +
    `${em('kpay')} KPAY · ${em('wave')} WAVE ကို အသုံးပြုနိုင်ပါတယ်။`;
const maintenanceText = () =>
    `${em('warn')} <b>Bot ကို ပြုပြင်ထိန်းသိမ်းနေပါသည်။</b>\nခေတ္တစောင့်ဆိုင်းပေးပါ။`;

const bannedText = (tgId) =>
    `${em('error')} <b>သင့်အကောင့်ကို ပိတ်ပင်ထားပါသည်။</b>\n\n` +
    `Telegram ID: <code>${esc(tgId)}</code>\n` +
    `အသေးစိတ်သိလိုပါက Admin ${esc(CONFIG.supportContact)} ကို ဆက်သွယ်ပါ။`;

bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();
    if (!ctx.from) return next();
    ctx.state.s = getSession(ctx.from.id);
    if (ctx.message?.text) ctx.message.text = canonicalButtonText(ctx.state.s, ctx.message.text);
    ctx.state.s.tg = {
        username: ctx.from.username || null,
        name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
    };
    if (knownUsers.add(ctx.from.id)) log.info(`new user ${ctx.from.id}`);

    if (bannedIds.has(ctx.from.id) && !isOwner(ctx.from.id)) {
        if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => { });
        return ui.html(ctx.from.id, bannedText(ctx.from.id)).catch(() => { });
    }
    if (!(await enforceForceJoin(ctx.state.s))) return;
    if (stores.bot.data.maintenance && !isAdmin(ctx.from.id)) {
        if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => { });
        return ui.html(ctx.from.id, maintenanceText()).catch(() => { });
    }
    return next();
});

bot.catch((err, ctx) => log.error(`update ${ctx.update?.update_id}: ${err.stack || err.message}`));

const authed = (fn) => async (ctx) => {
    const s = ctx.state.s;
    if (!s.client) return ui.html(s.id, note('error', 'Please sign in first.'), mainMenu(s));
    return fn(ctx, s);
};
const adminOnly = (fn) => async (ctx) => (isAdmin(ctx.from.id) ? fn(ctx, ctx.state.s) : ui.html(ctx.from.id, note('error', 'Admins only.')));
const ownerOnly = (fn) => async (ctx) => (isOwner(ctx.from.id) ? fn(ctx, ctx.state.s) : ui.html(ctx.from.id, note('error', 'Owner only.'), adminMenu(ctx.from.id)));
const labelHandlers = new Map();
const onLabel = (label, fn) => {
    labelHandlers.set(label, fn);
    return bot.hears(label, async (ctx) => { ctx.state.s.input = null; return fn(ctx); });
};
const prompt = (s, type, extra, text, markup) => { s.input = { type, ...extra }; return ui.html(s.id, text, markup); };
const done = async (ctx, s, text, markup) => {
    await ctx.deleteMessage().catch(() => { });
    return ui.html(s.id, text, markup ?? mainMenu(s));
};


bot.start(async (ctx) => {
    const s = ctx.state.s;
    s.input = null;
    const menu = mainMenu(s);
    try {
        const videoResponse = await axios.get(WELCOME_VIDEO_URL, {
            responseType: 'arraybuffer',
            timeout: 60_000,
            maxContentLength: 50 * 1024 * 1024,
            maxBodyLength: 50 * 1024 * 1024,
        });
        const videoBuffer = Buffer.from(videoResponse.data);
        await bot.telegram.sendVideo(s.id, { source: videoBuffer, filename: 'pai.mp4' }, {
            caption: welcomeCaption(),
            parse_mode: 'HTML',
            reply_markup: localizeMarkup(s.id, menu),
        });
    } catch (err) {
        log.warn(`welcome video download/upload failed: ${err.message}`);
        await ui.html(s.id, welcomeCaption(), menu);
    }
    void notifyAdminArticle({ userId: s.id, icon: 'user', title: 'User started bot', rows: [['User', userLabel(s)], ['Telegram ID', ctx.from.id]] });
});

const parseId = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
const allow = (text) => { const id = parseId(text); return id === null ? 'Invalid ID.' : allowedIds.add(id) ? `${id} added.` : `${id} is already allowed.`; };
const disallow = (text) => { const id = parseId(text); return id === null ? 'Invalid ID.' : allowedIds.remove(id) ? `${id} removed.` : `${id} was not found.`; };

function banUser(text) {
    const id = parseId(text);
    if (id === null) return 'Invalid ID.';
    if (isAdmin(id)) return 'Owner / Admin ကို ban လို့မရပါ။';
    if (!bannedIds.add(id)) return `${id} is already banned.`;
    const t = sessions.get(id);
    if (t) {
        if (t.running && t.run && !t.run.endReason) t.run.endReason = 'banned';
        t.running = false;
        t.input = null;
    }
    return `${id} banned.`;
}
const unbanUser = (text) => {
    const id = parseId(text);
    return id === null ? 'Invalid ID.' : bannedIds.remove(id) ? `${id} unbanned.` : `${id} was not banned.`;
};

const emptySummaryStats = () => ({ bets: 0, wins: 0, losses: 0, profit: 0 });
const summaryRate = (x) => x.bets ? (x.wins / x.bets * 100).toFixed(1) : '0.0';
const summaryDateKey = (ms = Date.now()) => new Date(ms + 6.5 * 3600_000).toISOString().slice(0, 10);
const previousSummaryDate = (day) => summaryDateKey(Date.parse(`${day}T00:00:00+06:30`) - 86_400_000);
function recordDailySummary(userId, mode, strategy, win, profit, at = Date.now()) {
    const users = stores.dailySummaries.data.users || (stores.dailySummaries.data.users = {});
    const user = users[String(userId)] || (users[String(userId)] = {});
    const day = summaryDateKey(at);
    const daily = user[day] || (user[day] = { manual: emptySummaryStats(), auto: emptySummaryStats(), strategies: {} });
    const bucket = daily[mode] || (daily[mode] = emptySummaryStats());
    bucket.bets++;
    if (win) bucket.wins++; else bucket.losses++;
    bucket.profit += Number(profit || 0);
    if (mode === 'auto') {
        const strategyBucket = daily.strategies[strategy] || (daily.strategies[strategy] = emptySummaryStats());
        strategyBucket.bets++;
        if (win) strategyBucket.wins++; else strategyBucket.losses++;
        strategyBucket.profit += Number(profit || 0);
    }
    stores.dailySummaries.save();
}
function summaryStats(s, day = summaryDateKey()) {
    const daily = stores.dailySummaries.data.users?.[String(s.id)]?.[day] || {};
    const manual = { ...emptySummaryStats(), ...(daily.manual || {}) };
    const auto = { ...emptySummaryStats(), ...(daily.auto || {}) };
    const strategies = daily.strategies || {};
    const total = {
        bets: manual.bets + auto.bets,
        wins: manual.wins + auto.wins,
        losses: manual.losses + auto.losses,
        profit: manual.profit + auto.profit,
    };
    return { day, manual, auto, total, strategies };
}
function summaryLine(label, x) {
    return `<b>${esc(label)}</b>  ${x.bets} bets · W ${x.wins} · L ${x.losses} · ${summaryRate(x)}% · <b>${esc(signed(x.profit))}</b>`;
}
function summaryNav(day) {
    const today = summaryDateKey();
    return inline([[
        cb('Today', 'sum:today', day === today ? 'success' : 'primary'),
        cb('Yesterday', 'sum:yesterday', day !== today ? 'success' : 'primary'),
    ], [cb('Main Menu', 'x:summary', undefined, 'back')]]);
}
function summaryText(s, day = summaryDateKey()) {
    const x = summaryStats(s, day);
    const groupedStrategies = Object.entries(x.strategies).reduce((groups, [name, stats]) => {
        const displayName = strategyDisplayName(name);
        const bucket = groups[displayName] || (groups[displayName] = emptySummaryStats());
        bucket.bets += Number(stats.bets || 0);
        bucket.wins += Number(stats.wins || 0);
        bucket.losses += Number(stats.losses || 0);
        bucket.profit += Number(stats.profit || 0);
        return groups;
    }, {});
    const strategyRows = Object.entries(groupedStrategies).map(([name, stats]) => summaryLine(name, stats));
    return `${em('chart')} <b>Daily Summary · ${esc(day)}</b>\n\n` +
        `${summaryLine('TOTAL', x.total)}\n\n` +
        `${em('manual')} <b>Manual Bet</b>\n${summaryLine('Manual', x.manual)}\n\n` +
        `${em('start')} <b>Auto Bet</b>\n${summaryLine('Auto', x.auto)}\n\n` +
        `${em('strategy')} <b>By Strategy</b>\n` +
        (strategyRows.length ? strategyRows.join('\n') : '<i>No auto bet results for this date.</i>');
}
function languageKb() {
    return inline([[cb('English', 'lang:en', 'primary'), cb('မြန်မာ', 'lang:my', 'primary')]]);
}
bot.command('hide', async (ctx) => {
    ctx.state.s.input = null;
    return ctx.reply('Keyboard hidden.', { reply_markup: { remove_keyboard: true } });
});
bot.command('menu', (ctx) => {
    const s = ctx.state.s;
    return ui.html(s.id, `${em('back')} Main menu`, mainMenu(s));
});
bot.command('lang', authed((ctx, s) => ui.html(s.id, `${em('info')} <b>${tr(s, 'language')}</b>`, languageKb())));
bot.command('language', authed((ctx, s) => ui.html(s.id, `${em('info')} <b>${tr(s, 'language')}</b>`, languageKb())));
bot.command('summary', authed((ctx, s) => ui.html(s.id, summaryText(s), summaryNav(summaryDateKey()))));
bot.command('settingcode', authed(async (ctx, s) => {
    const args = ctx.message.text.split(/\s+/).slice(1).filter(Boolean);
    if (!args.length) return ui.html(s.id, settingCodeListText(), inline([[cb('Apply Setting Code', 'sc:apply', 'success', 'settings')], [cancelRow]]));
    const sharedCode = normalizeSettingCode(args[0]);
    if (sharedCode && args.length === 1) {
        const imported = importSharedSettingCode(s, sharedCode);
        if (!imported.ok) return ui.html(s.id, note('error', imported.message), mainMenu(s));
        const p = imported.payload;
        return ui.html(s.id, `${em('ok')} <b>Setting Code imported</b>\nCode: <code>${esc(sharedCode)}</code>\nGame: <b>${esc(GAMES[p.game].label)}</b>\nStrategy: <b>${esc(STRATEGIES[p.strategy].label)}</b>\nStake: <code>${p.betSizes.join(',')}</code>`, mainMenu(s));
    }
    const balance = Number(String(args[0]).replace(/[,_]/g, ''));
    const target = args[1] == null ? null : positiveNumber(args[1]);
    const stopLoss = args[2] == null ? null : positiveNumber(args[2]);
    if (!Number.isSafeInteger(balance) || balance <= 0 || (args[1] != null && !target) || (args[2] != null && !stopLoss) || args.length > 3) {
        return ui.html(s.id, note('error', 'အသုံးပြုပုံ: <code>/settingcode balance target stoploss</code>\nဥပမာ: <code>/settingcode 50000 10000 5000</code>'), mainMenu(s));
    }
    const result = applySettingCode(s, balance, target, stopLoss);
    if (!result.ok) return ui.html(s.id, note('error', result.message), mainMenu(s));
    return ui.html(s.id, settingCodeAppliedText(result.profile, balance, target, stopLoss, result.code), mainMenu(s));
}));

bot.command('allow', adminOnly((ctx) => ui.html(ctx.from.id, esc(allow(ctx.message.text.split(/\s+/)[1] || '')), adminMenu(ctx.from.id))));
bot.command('remove', adminOnly((ctx) => ui.html(ctx.from.id, esc(disallow(ctx.message.text.split(/\s+/)[1] || '')), adminMenu(ctx.from.id))));
bot.command('ban', adminOnly((ctx) => ui.html(ctx.from.id, esc(banUser(ctx.message.text.split(/\s+/)[1] || '')), adminMenu(ctx.from.id))));
bot.command('unban', adminOnly((ctx) => ui.html(ctx.from.id, esc(unbanUser(ctx.message.text.split(/\s+/)[1] || '')), adminMenu(ctx.from.id))));
bot.command('showid', adminOnly((ctx) => showAllowed(ctx.from.id)));
bot.command('users', adminOnly((ctx) => showActiveUsers(ctx.from.id)));

bot.command('emojis', ownerOnly(async (ctx) => {
    const rows = Object.keys(EMOJI_FALLBACK).map((k) => [k, EMOJI_FALLBACK[k], stores.emoji.data[k] ? 'animated ✓' : '—']);
    await ui.card(ctx.from.id, { icon: 'settings', title: 'Emoji slots', sections: [{ header: ['Key', 'Fallback', 'Custom'], rows }], note: 'Use /setemoji <key>, then send one premium emoji.' });
}));
bot.command('setemoji', ownerOnly(async (ctx, s) => {
    const k = ctx.message.text.split(/\s+/)[1];
    if (!k || !EMOJI_FALLBACK[k]) return ui.html(s.id, `${em('info')} Usage: <code>/setemoji &lt;key&gt;</code> — keys: ${Object.keys(EMOJI_FALLBACK).map((x) => `<code>${x}</code>`).join(' ')}`);
    return prompt(s, 'setemoji', { key: k }, `${em('info')} Now send one premium emoji for <code>${esc(k)}</code>.`);
}));


onLabel(L.login, (ctx) => ui.html(ctx.from.id, platformMenuText(), platformMenu()));
onLabel(L.tutorial, (ctx) => {
    const s = ctx.state.s;
    return ui.html(s.id, `${em('info')} <b>Tutorial Video</b>\n\nဒီ Link ကိုနှိပ်ပြီး Tutorial video ကိုကြည့်နိုင်ပါတယ်။\n<a href="${TUTORIAL_URL}">${TUTORIAL_URL}</a>`, mainMenu(s));
});
onLabel(L.switchAcc, (ctx) => {
    const s = ctx.state.s;
    if (s.running) return ui.html(s.id, note('warn', `Halt the bot before switching accounts.`), mainMenu(s));
    Object.assign(s, { client: null, creds: null, info: null });
    return ui.html(s.id, platformMenuText(), platformMenu());
});
for (const [platformKey, p] of Object.entries(PLATFORMS)) {
    onLabel(p.name, (ctx) => {
        const s = ctx.state.s;
        if (stores.bot.data.hiddenPlatforms?.[platformKey] === true) return ui.html(s.id, note('info', 'ဒီ Site ကို Owner က ယာယီဖျောက်ထားပါတယ်။'), platformMenu());
        return prompt(s, 'login', { platform: platformKey },
        `${em('lock')} <b>${esc(p.name)}</b>\nSend mobile/email and password on two lines:\n<pre>9xxxxxxxxxx\nyourPassword</pre>\n<pre>09xxxxxxxxx\nyourPassword</pre>\n<pre>email@example.com\nyourPassword</pre>`,
        replyKb([[key(L.back, undefined, 'back')]]));
    });
}
onLabel(L.back, (ctx) => {
    const s = ctx.state.s;
    s.manual.view = null;
    return ui.html(s.id, `${em('back')} Main menu`, mainMenu(s));
});
onLabel(L.menu, (ctx) => ui.html(ctx.from.id, `${em('back')} Main menu`, mainMenu(ctx.state.s)));

onLabel(L.launch, authed(async (ctx, s) => {
    const err = startEngine(s);
    if (err) await ui.html(s.id, note('error', esc(err)), mainMenu(s));
}));
onLabel(L.halt, authed(async (ctx, s) => {
    if (!s.running) return ui.html(s.id, note('info', 'The bot is not running.'), mainMenu(s));
    s.running = false;
    await ui.html(s.id, note('wait', 'Stopping — summary follows in a moment…'));
}));

onLabel(L.sizes, authed(async (ctx, s) => {
    const balance = s.cfg.virtual ? (s.run?.vBalance ?? s.cfg.virtualBalance) : await s.client.balance().catch(() => null);
    const current = normalizeBetSizes(s.cfg.betSizes).map((size) => size === 'ALL IN' ? 'ALL IN' : String(size)).join(' · ') || 'not set';
    const koPaing = s.cfg.strategy === 'KO_PAING';
    const instructions = koPaing
        ? `KO PAING ကိုသုံးနေသောကြောင့် stake size တစ်ခုတည်းသာ ပို့ပါ။\nဥပမာ: <code>1000</code>\nတစ်ခုထက်ပိုပြီး မပို့ရပါ။`
        : `Calculator အတွက် user စထိုးမယ့် ပမာဏကို ပို့ပါ (ဥပမာ <code>100</code>)။\nအဲဒီပမာဏကနေစပြီး balance မကျော်အောင် ladder တွက်ပေးမည်။\nလိုက်ဆတမ်းထည့်မယ်ဆို တစ်ကြောင်းချင်းဆီပို့\n\n<code>0</code> ထည့်ပြီး skip လုပ်လို့လည်းရသလို နောက်ဆုံးဇမှာလည်း <code>ALL IN</code> ထည့်လို့ရပါတယ်။\nဥပမာ:\n<code>\n0\n0\n100\n300\n700\nALL IN</code>`;
    return prompt(s, 'sizes', { calculatorBalance: balance },
        `${em('wallet')} <b>Stake sizes</b>\n<b>Balance:</b> ${balance == null ? 'unavailable' : ks(balance)}\n<b>Current:</b> <code>${esc(current)}</code>\n\n${instructions}`, inline([cancelRow]));
}));
onLabel(L.wallet, authed((ctx, s) => ui.html(s.id, `${em('virtual')} <b>Wallet mode</b>`, inline([[
    cb('Virtual', 'md:virtual', s.cfg.virtual ? 'success' : 'primary', 'virtual'),
    cb('Real', 'md:real', s.cfg.virtual ? 'primary' : 'success', 'real'),
], cancelRow]))));
onLabel(L.game, authed((ctx, s) => ui.html(s.id, `${em('game')} <b>Select game</b>`, gamePicker('gt', s.cfg.game))));
onLabel(L.betType, authed((ctx, s) => ui.html(s.id, `${em('result')} <b>Bet type</b>`, inline([[
    cb('Big / Small', 'bt:BS', s.cfg.betType === 'BS' ? 'success' : 'primary'),
    cb('Colour', 'bt:COLOR', s.cfg.betType === 'COLOR' ? 'success' : 'primary'),
], cancelRow]))));
onLabel(L.strategy, authed((ctx, s) => ui.html(s.id, `${em('strategy')} <b>Select strategy</b>`, strategyPicker(s.cfg))));
onLabel(L.betMode, authed((ctx, s) => ui.html(s.id, `${em('strategy')} <b>Straight / Reverse</b>\nStraight follows the strategy or channel signal. Reverse swaps BIG and SMALL signals.`, inline([[
    cb('Straight', 'dir:STRAIGHT', s.cfg.betMode === 'STRAIGHT' ? 'success' : 'primary'),
    cb('Reverse', 'dir:REVERSE', s.cfg.betMode === 'REVERSE' ? 'success' : 'primary'),
], cancelRow]))));
onLabel(L.staking, authed((ctx, s) => ui.html(s.id, `${em('staking')} <b>Staking mode</b>`, inline([
    ...chunk(STAKING_MODES.map((m) => cb(m, `bm:${m}`, s.cfg.staking === m ? 'success' : 'primary')), 2), cancelRow]))));

onLabel(L.risk, authed((ctx, s) => ui.html(s.id, `${em('risk')} <b>Risk guard</b>`, riskMenu())));
onLabel(L.target, authed((ctx, s) => prompt(s, 'target', {}, `${em('target')} <b>Profit target</b>\nStop automatically once profit reaches (Ks):\n<code>10000</code>`, inline([cancelRow]))));
onLabel(L.stopLoss, authed((ctx, s) => prompt(s, 'stoploss', {}, `${em('warn')} <b>Stop loss</b>\nStop automatically once loss reaches (Ks):\n<code>5000</code>`, inline([cancelRow]))));
onLabel(L.entry, authed((ctx, s) => ui.html(s.id, `${em('entry')} <b>Entry layer</b>\nWhen should real betting begin?`, inline([
    [cb('1 · Immediately', 'el:1', s.cfg.entryLayer === 1 ? 'success' : 'primary')],
    [cb('2 · After 1 loss', 'el:2', s.cfg.entryLayer === 2 ? 'success' : 'primary')],
    [cb('3 · After 2 losses', 'el:3', s.cfg.entryLayer === 3 ? 'success' : 'primary')],
    cancelRow]))));

onLabel(L.slLayer, authed((ctx, s) => ui.html(s.id, `${em('slLayer')} <b>SL layer</b>\nSkip betting after N consecutive losses:`, inline([
    [cb('Off', 'sl:0', s.cfg.slLayer === 0 ? 'success' : 'danger')],
    ...chunk([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => cb(String(n), `sl:${n}`, s.cfg.slLayer === n ? 'success' : undefined)), 3),
    cancelRow]))));

onLabel(L.settingCode, authed((ctx, s) => prompt(s, 'setting-code-balance', {}, `${em('settings')} <b>Setting Code</b>\n\nအရင်ဆုံး သင့် Balance ကို ပို့ပါ။\nဥပမာ <code>50000</code>`, inline([cancelRow]))));
onLabel(L.importCode, authed((ctx, s) => prompt(s, 'import-code', {}, `${em('download')} <b>Import Code</b>\n\nသင့်ထံရရှိထားသော <code>PAI-XXXX-XXXX-XXXX</code> ကို ပို့ပါ။`, inline([cancelRow]))));
onLabel(L.shareCode, authed((ctx, s) => {
    const code = saveSharedSettingCode(s);
    return ui.html(s.id, `${em('share')} <b>Share Code</b>\n\nလက်ရှိ User Settings အားလုံးကို Share လုပ်ရန် Code: <code>${esc(code)}</code>\n\nStake Sizes, Strategy, Game, Risk Guard, Auto Bet Time, Pattern နှင့် အခြားလက်ရှိ custom settings များပါဝင်ပါတယ်။\nဒီ Code ကို အခြား User က Import Code မှတစ်ဆင့် ထည့်သွင်းနိုင်ပါတယ်။`, mainMenu(s));
}));
onLabel(L.autoTime, authed((ctx, s) => prompt(s, 'autotime', {}, `${em('wait')} <b>Auto Bet Time / Limits</b>
တွဲပို့လည်းရသလို ကိုယ်သုံးချင်တာကိုပဲရွေးပို့လို့ရပါတယ်:
<pre> ဥပမာ:
09:00 AM - 10:00 AM
60 mins
10 wins</pre>
Use <code>off</code> on a line to clear that limit.`, inline([cancelRow]))));
onLabel(L.account, authed(async (ctx, s) => {
    let balance = s.cfg.virtual ? (s.run?.vBalance ?? s.cfg.virtualBalance) : await s.client.balance().catch(() => null);
    await ui.card(s.id, accountCard(s, balance), mainMenu(s));
}));

const MM_OFFSET = 6.5 * 3600_000; 

const trxDay = () => Math.floor((Date.now() + MM_OFFSET) / 86_400_000);
const fmtMM = (ms) => new Date(ms + MM_OFFSET).toISOString().slice(0, 16).replace('T', ' ');

const trx = {
    client: new ArLotteryClient(), fallback: false, busy: false, primed: false, errors: 0, seen: new Set(),
    day: trxDay(), since: Date.now(), total: 0, big: 0, small: 0, last: null, recent: [], results: Array.isArray(stores.trxResults.data.results) ? stores.trxResults.data.results : [],
};

function trxReset() {
    Object.assign(trx, { day: trxDay(), since: Date.now(), total: 0, big: 0, small: 0, last: null, recent: [], results: [], primed: false, seen: new Set() });
    stores.trxResults.data.results = []; stores.trxResults.save();
    log.info('TRX checker reset');
}

const liveStates = new Map();

const liveStateKey = (game, platformKey) => game === 'TRX' ? 'TRX' : `${platformKey || 'UNKNOWN'}:${game}`;
const liveState = (game, platformKey) => {
    const key = liveStateKey(game, platformKey);
    if (!liveStates.has(key)) {
        const results = game === 'TRX' ? trx.results.slice(0, 40) : [];
        liveStates.set(key, { key, game, platformKey: game === 'TRX' ? null : platformKey, results, seen: new Set(results.map((x) => String(x.issueNumber))), primed: false, busy: false });
    }
    return liveStates.get(key);
};

function liveResultsHtml(game, list) {
    const rows = list.slice(0, 10).map((r) => {
        const n = Number(r.number) % 10;
        return `${em('chart')} <code>${esc(String(r.issueNumber).slice(-8))}</code> · <b>${n}</b> · ` +
            `${bsOf(n) === 'B' ? 'BIG' : 'SMALL'} · ${dot(colorOf(n))} <b>${COLOR_NAME[colorOf(n)].toUpperCase()}</b>`;
    });
    return `${em('chart')} <b>Live Result · ${esc(GAMES[game]?.label || game)}</b>\n\n` +
        (rows.length ? rows.join('\n') : `${em('wait')} Waiting for result…`) +
        `\n\n${em('info')} New result ထွက်တိုင်း table update လုပ်နေပါသည်။`;
}
const liveResultKb = () => inline([[cb('Stop Live', 'live:stop', 'danger', 'stop')]]);

function liveResultsArticle(game, list) {
    const rows = list.slice(0, 10).map((r) => {
        const n = Number(r.number) % 10;
        return [String(r.issueNumber).slice(-8), String(n), bsOf(n) === 'B' ? 'BIG' : 'SMALL', `${COLOR_DOT[colorOf(n)]} ${COLOR_NAME[colorOf(n)].toUpperCase()}`];
    });
    return {
        icon: 'chart', title: `Live Result · ${GAMES[game]?.label || game}`,
        sections: [{ header: ['Period', 'No.', 'Size', 'Colour'], rows }],
        note: 'Result အသစ်ထွက်တိုင်း Article table ကို update လုပ်နေပါသည်။',
    };
}

async function sendLiveResult(s) {
    const game = s.manual.live?.game || manualGame(s);
    const platformKey = game === 'TRX' ? null : (s.manual.live?.platformKey || s.cfg.platform);
    const state = liveState(game, platformKey);
    const oldId = s.manual.live?.messageId;
    if (oldId) await bot.telegram.deleteMessage(s.id, oldId).catch(() => { });
    const msg = await ui.card(s.id, liveResultsArticle(game, state.results), liveResultKb());
    const messageId = msg?.message_id || msg?.result?.message_id;
    s.manual.live = { messageId: messageId || null, game, platformKey, active: true };
    return msg;
}

async function updateLiveResultTables(game, platformKey) {
    for (const s of sessions.values()) {
        const samePlatform = game === 'TRX' || s.manual.live?.platformKey === platformKey || s.cfg.platform === platformKey;
        if (!s.manual.live?.active || s.manual.live.game !== game || !samePlatform || bannedIds.has(s.id)) continue;
        try { await sendLiveResult(s); } catch (err) { log.warn(`live result update ${s.id}: ${err.message}`); }
    }
}

async function pollLiveGame(game, platformKey = null) {
    const state = liveState(game, platformKey);
    if (state.busy) return;
    state.busy = true;
    try {
        let list;
        if (game === 'TRX') {
            if (trxDay() !== trx.day) trxReset();
            const x = await trx.client.latest();
            list = [{ issueNumber: String(x.issueNumber), number: String(Number(x.number) % 10) }];
        } else {
            const session = [...sessions.values()].find((x) => x.client && x.cfg.platform === platformKey && !bannedIds.has(x.id));
            if (!session) return;
            list = await session.client.results(game, 10);
        }
        const fresh = list.filter((x) => x?.issueNumber != null && x.number !== '' && x.number != null)
            .map((x) => ({ issueNumber: String(x.issueNumber), number: String(Number(x.number) % 10) }))
            .sort((a, b) => cmpIssue(b.issueNumber, a.issueNumber));
        if (!fresh.length) return;
        const newest = fresh[0];
        if (state.seen.has(newest.issueNumber)) return;
        state.seen.add(newest.issueNumber);
        state.results = [...fresh, ...state.results].filter((x, i, a) => a.findIndex((y) => y.issueNumber === x.issueNumber) === i).slice(0, 40);
        if (game === 'TRX') {
            trx.results = state.results;
            stores.trxResults.data.results = trx.results; stores.trxResults.save();
            trx.last = { issue: newest.issueNumber, n: Number(newest.number) };
            trx.recent = [...trx.recent, bsOf(Number(newest.number))].slice(-10);
            if (state.primed) {
                trx.total++;
                if (bsOf(Number(newest.number)) === 'B') trx.big++; else trx.small++;
            }
        }
        if (state.primed) await updateLiveResultTables(game, platformKey);
        state.primed = true;
        if (state.seen.size > 500) state.seen = new Set([...state.seen].slice(-200));
    } catch (err) {
        if (game === 'TRX' && trx.errors++ % 20 === 0) log.warn(`TRX live poll: ${err.message}`);
        else log.warn(`${game} live poll: ${err.message}`);
    } finally { state.busy = false; }
}

async function pollTrx() { return pollLiveGame('TRX'); }

async function getTrxResults(game, size = 40) {
    if (game !== 'TRX') throw new Error('getTrxResults is only for TRX');
    const state = liveState('TRX');
    if (!state.results.length) await pollTrx();
    return state.results.slice(0, size);
}

function trxCard() {
    const pct = (n) => (trx.total ? `${((n / trx.total) * 100).toFixed(1)}%` : '—');
    const l = trx.last;
    return {
        icon: 'chart', title: 'TRX Checker',
        sections: [{
            rows: [
                ['Total rounds', trx.total],
                ['BIG', `${trx.big}  (${pct(trx.big)})`],
                ['SMALL', `${trx.small}  (${pct(trx.small)})`],
                ['Last result', l ? `${l.n} · ${bsOf(l.n) === 'B' ? 'Big' : 'Small'} · ${COLOR_DOT[colorOf(l.n)]}` : '—'],
                ['Last 10', trx.recent.join(' ') || '—'],
                ['Counting since', fmtMM(trx.since)],
            ],
        }],
        note: `Source: draw.ar-lottery01 · resets daily at 12:00 AM (Myanmar time).`,
    };
}
const sendTrx = (s) => ui.card(s.id, trxCard(), inline([[cb('Refresh', 'tc:r', 'primary', 'chart')]]));
onLabel(L.trx, authed((ctx, s) => sendTrx(s)));
bot.command('trx', authed((ctx, s) => sendTrx(s)));


const manualGame = (s) => s.manual.game || s.cfg.game;
onLabel(L.manual, authed((ctx, s) => {
    s.manual.game = s.cfg.game;
    return ui.html(s.id, `${em('manual')} <b>Manual bet</b>${s.cfg.virtual ? `  ${em('virtual')} virtual` : ''}\nPick BIG, SMALL or a colour, then an amount.`, manualMenu());
}));
onLabel(L.big, authed((ctx, s) => ui.html(s.id, `${em('profit')} <b>BIG</b> — choose an amount`, manualAmountPicker('B'))));
onLabel(L.small, authed((ctx, s) => ui.html(s.id, `${em('loss')} <b>SMALL</b> — choose an amount`, manualAmountPicker('S'))));
for (const [label, side] of [[L.green, 'G'], [L.red, 'R'], [L.violet, 'V']]) {
    onLabel(label, authed((ctx, s) => ui.html(s.id, `${sideTag(side)} — choose an amount`, manualAmountPicker(side))));
}
onLabel(L.manualGame, authed((ctx, s) => ui.html(s.id, `${em('game')} <b>Game for manual bets</b>`, gamePicker('mg', manualGame(s)))));
onLabel(L.language, authed((ctx, s) => ui.html(s.id, `${em('info')} <b>${tr(s, 'language')}</b>`, languageKb())));
onLabel(L.balance, authed(async (ctx, s) => {
    const v = s.cfg.virtual;
    const balance = v ? s.cfg.virtualBalance : await s.client.balance().catch(() => null);
    await ui.card(s.id, { icon: 'wallet', title: v ? 'Virtual balance' : 'Balance', sections: [{ rows: [['Available', balance == null ? 'unavailable' : ks(balance)]] }] }, manualMenu());
}));
onLabel(L.myBets, authed(async (ctx, s) => {
    const bets = s.manual.bets.slice(-20).reverse();
    if (!bets.length) return ui.html(s.id, note('info', 'No manual bets yet.'), manualMenu());
    const rows = bets.map((b) => [
        b.status === 'PENDING' ? '…' : b.win ? 'WIN' : 'LOSS',
        `${b.virtual ? 'V ' : ''}${sidePlain(b.choice)}`, String(b.amount), b.result ?? String(b.issue).slice(-6),
        b.status === 'PENDING' ? 'pending' : signed(b.profit),
    ]);
    await ui.card(s.id, { icon: 'list', title: 'Recent manual bets', sections: [{ header: ['', 'Side', 'Stake', 'Result', 'P/L'], rows }] }, manualMenu());
}));
onLabel(L.results, authed(async (ctx, s) => {
    const game = manualGame(s);
    if (!GAMES[game]) return ui.html(s.id, note('error', 'Unknown game.'), manualMenu());
    const platformKey = game === 'TRX' ? null : s.cfg.platform;
    s.manual.live = { ...(s.manual.live || {}), game, platformKey, active: true };
    await pollLiveGame(game, platformKey);
    return sendLiveResult(s);
}));

const manualAmountPicker = (side) => inline([
    [10, 100, 1000].map((n) => cb(n.toLocaleString('en-US'), `ma:${side}:${n}`, 'primary')),
    [10000, 100000].map((n) => cb(n.toLocaleString('en-US'), `ma:${side}:${n}`, 'primary')).concat(cb('Custom', `ma:${side}:c`)),
    cancelRow,
]);
const manualMultPicker = (side, amount) => inline([
    [1, 5, 20].map((n) => cb(`${n}×`, `mm:${side}:${amount}:${n}`, 'primary')),
    [50, 100].map((n) => cb(`${n}×`, `mm:${side}:${amount}:${n}`, 'primary')).concat(cb('Custom', `mm:${side}:${amount}:c`)),
    cancelRow,
]);

async function manualConfirm(s, side, amount, mult) {
    const { cfg } = s;
    const virtual = cfg.virtual;
    const game = manualGame(s);
    const { unit, count, total } = splitStake(amount * mult);
    const bets = s.manual.bets;

    try {
        const { issue } = await s.client.currentIssue(game);
        if (!issue) throw new Error('No open period');
        if (virtual) {
            if (cfg.virtualBalance < total) throw new Error(`Virtual balance not enough (${ks(cfg.virtualBalance)})`);
            cfg.virtualBalance -= total; saveSettings();
        } else {
            const res = await s.client.placeBet({ game, issue, choice: side, betType: betTypeOf(side), unit, count });
            if (res?.code !== 0) throw new Error(res?.msg || 'Bet rejected');
        }
        bets.push({ status: 'PENDING', virtual, choice: side, amount: total, issue, game, result: null, win: null, profit: null, placedAt: Date.now() });
        if (bets.length > 20) bets.splice(0, bets.length - 20);
        return ui.html(s.id, `${em('ok')} <b>Bet placed</b>${virtual ? `  ${em('virtual')}` : ''}\n` +
            `${sideTag(side)} · ${total.toLocaleString('en-US')} Ks\n` +
            `${em('game')} ${esc(GAMES[game].label)} · <code>${esc(issue)}</code>\n` +
            `${em('wait')} ${tr(s, 'waiting')}`, manualMenu());
    } catch (err) {
        return ui.html(s.id, note('error', `Bet failed: ${esc(err.message)}`), manualMenu());
    }
}

let manualBusy = false;
async function pollManualBets() {
    if (manualBusy) return;
    manualBusy = true;
    try {
        for (const s of sessions.values()) {
            if (bannedIds.has(s.id)) continue;
            const pending = s.manual.bets.filter((b) => b.status === 'PENDING');
            if (!pending.length || !s.client) continue;
            for (const game of new Set(pending.map((b) => b.game))) {
                let list;
                try {
                    const platformKey = game === 'TRX' ? null : s.cfg.platform;
                    list = liveState(game, platformKey).results;
                    if (!list.length) { await pollLiveGame(game, platformKey); list = liveState(game, platformKey).results; }
                } catch { continue; }
                for (const b of pending.filter((x) => x.game === game)) {
                    const hit = list.find((x) => String(x.issueNumber) === String(b.issue) && x.number !== '' && x.number != null);
                    if (!hit) continue;
                    const n = Number(hit.number) % 10;
                    b.win = isWin(b.choice, n);
                    b.profit = b.win ? winProfit(b.choice, b.amount) : -b.amount;
                    b.status = b.win ? 'WIN' : 'LOSS';
                    b.result = `${n} (${bsOf(n)}/${colorOf(n)})`;
                    recordDailySummary(s.id, 'manual', 'MANUAL', b.win, b.profit);
                    if (b.virtual && b.win) { s.cfg.virtualBalance += b.amount + b.profit; saveSettings(); }
                    const resultBalance = s.cfg.virtual ? s.cfg.virtualBalance : await s.client.balance().catch(() => null);
                    if (b.win && (Number(b.profit) >= 5000 || Number(b.amount) >= 5000)) {
                        void notifyAdminArticle({ userId: s.id, icon: 'win', title: 'Manual Bet Won 5,000+', rows: [['User', userLabel(s)], ['Game', GAMES[b.game]?.label || b.game], ['Bet', sidePlain(b.choice)], ['Profit', signed(b.profit)]] });
                    }
                    await ui.html(s.id, `${b.win ? em('win') : em('loss')} <b>MANUAL ${b.win ? 'WIN' : 'LOSS'}</b>  ${signed(b.profit)}${b.virtual ? `  ${em('virtual')}` : ''}\n<blockquote>${sideTag(b.choice)} · ${b.amount} Ks · result <b>${n}</b> ${dot(colorOf(n))}\n<code>${esc(b.issue)}</code>\n${em('wallet')} Balance: <b>${resultBalance == null ? '—' : ks(resultBalance)}</b></blockquote>`).catch(() => { });
                }
            }
        }
    } finally { manualBusy = false; }
}


onLabel(L.admin, adminOnly((ctx) => ui.html(ctx.from.id, `${em('admin')} <b>Admin panel</b>`, adminMenu(ctx.from.id))));
onLabel(L.addUser, adminOnly((ctx, s) => prompt(s, 'admin-allow', {}, `${em('ok')} Send the <b>platform user ID</b> to allow:`, adminMenu(s.id))));
onLabel(L.removeUser, adminOnly((ctx, s) => prompt(s, 'admin-disallow', {}, `${em('error')} Send the <b>platform user ID</b> to remove:`, adminMenu(s.id))));
onLabel(L.banUser, adminOnly((ctx, s) => prompt(s, 'admin-ban', {}, `${em('error')} Ban လုပ်မယ့် <b>Telegram Chat ID</b> ကို ပို့ပါ:`, adminMenu(s.id))));
onLabel(L.unbanUser, adminOnly((ctx, s) => prompt(s, 'admin-unban', {}, `${em('ok')} Ban ဖြေမယ့် <b>Telegram Chat ID</b> ကို ပို့ပါ:`, adminMenu(s.id))));
onLabel(L.bannedList, adminOnly((ctx) => showBanned(ctx.from.id)));
onLabel(L.broadcast, ownerOnly((ctx, s) => prompt(s, 'broadcast', {}, `${em('broadcast')} Send the message to broadcast (HTML allowed):`, adminMenu(s.id))));
onLabel(L.allowed, adminOnly((ctx) => showAllowed(ctx.from.id)));
onLabel(L.activeUsers, adminOnly((ctx) => showActiveUsers(ctx.from.id)));
onLabel(L.siteVisibility, ownerOnly((ctx, s) => ui.html(s.id, `${em('settings')} <b>Site ဖော်/ဖျောက်</b>\n\nအစိမ်းရောင်သည် ဖော်ထားပြီး၊ အနီသည် ဖျောက်ထားခြင်း ဖြစ်သည်။ ဖျောက်ထားခြင်းသည် ရွေးချယ်စာရင်းမှသာ ဖယ်ရှားပြီး လက်ရှိ login ဝင်ထားသူများကို မထွက်စေပါ။`, siteVisibilityMenu())));
onLabel(L.strategyVisibility, ownerOnly((ctx, s) => ui.html(s.id, `${em('strategy')} <b>Strategy ဖော်/ဖျောက်</b>\n\nဖျောက်ထားသော Strategy များကို ရွေးချယ်စာရင်းမှ ဖယ်ရှားပြီး အသစ်စတင်ခြင်းကို တားပါမည်။ လက်ရှိ run နေသော process များကို မရပ်စေပါ။`, strategyVisibilityMenu())));
onLabel(L.addChannel, ownerOnly((ctx, s) => prompt(s, 'signal-add-channel', {}, `${em('broadcast')} Signal Channel ID ပို့ပါ။
ဥပမာ: <code>-1001234567890</code>`, adminMenu(s.id))));
onLabel(L.removeChannel, ownerOnly((ctx, s) => prompt(s, 'signal-remove-channel', {}, `${em('broadcast')} ဖယ်မည့် Signal Channel ID ပို့ပါ။`, adminMenu(s.id))));
onLabel(L.channelStatus, ownerOnly(async (ctx) => {
    const ids = signalChannelIds.all();
    return ui.card(ctx.from.id, { icon: 'broadcast', title: 'Signal Channels', sections: [{ header: ['#', 'Channel ID', 'Status'], rows: ids.length ? ids.map((id, i) => [i + 1, id, 'Listening']) : [['—', 'No channels configured', '—']] }] }, adminMenu(ctx.from.id));
}));
onLabel(L.forceJoinAdd, ownerOnly((ctx, s) => prompt(s, 'force-join-add', {}, `${em('lock')} <b>Force Join ထည့်ရန်</b>\nပထမလိုင်းတွင် Chat ID သို့မဟုတ် @username ထည့်ပါ။\nဒုတိယလိုင်းတွင် Join URL (optional) ထည့်ပါ။\nဥပမာ:\n<pre>-1001234567890\nhttps://t.me/example</pre>`, adminMenu(s.id))));
onLabel(L.forceJoinRemove, ownerOnly((ctx, s) => prompt(s, 'force-join-remove', {}, `${em('lock')} ဖယ်မည့် Force Join Chat ID သို့မဟုတ် @username ပို့ပါ။`, adminMenu(s.id))));
onLabel(L.forceJoinList, ownerOnly(async (ctx) => {
    const ids = forceJoinIds();
    return ui.card(ctx.from.id, { icon: 'lock', title: 'Force Join Chats', sections: [{ header: ['#', 'Chat', 'Join URL'], rows: ids.length ? ids.map((id, i) => [i + 1, forceJoinLabel(id), forceJoinButtonUrl(id) || '—']) : [['—', 'No chats configured', '—']] }] }, adminMenu(ctx.from.id));
}));
onLabel(L.pendingPayment, ownerOnly((ctx) => showPendingPayments(ctx.from.id)));
onLabel(L.paymentAmount, ownerOnly((ctx, s) => prompt(s, 'payment-amount', {}, `${em('wallet')} <b>Payment Amount</b>\nCurrent: <code>${getPaymentAmount().toLocaleString('en-US')} Ks</code>\nSend a new whole-number amount in Ks:`, adminMenu(s.id))));
onLabel(L.addAdmin, ownerOnly((ctx, s) => prompt(s, 'admin-add-admin', {}, `${em('admin')} Send the <b>Telegram ID</b> of the new admin:`, adminMenu(s.id))));
onLabel(L.removeAdmin, ownerOnly((ctx, s) => prompt(s, 'admin-remove-admin', {}, `${em('admin')} Send the <b>Telegram ID</b> of the admin to remove:`, adminMenu(s.id))));
onLabel(L.listAdmins, ownerOnly(async (ctx) => {
    const ids = [CONFIG.ownerId, ...adminIds.all()];
    const rows = await Promise.all(ids.map(async (id) => [id === CONFIG.ownerId ? 'Owner' : 'Admin', id, await tgName(id)]));
    return ui.card(ctx.from.id, { icon: 'admin', title: 'Admins', sections: [{ header: ['Role', 'Telegram ID', 'Telegram'], rows }] }, adminMenu(ctx.from.id));
}));


const groupNotificationText = (userId) => flagText('broadcast', 'Group Notifications', groupNotificationsEnabledFor(userId), 'OFF လုပ်ထားရင် ဒီ Admin/Owner ရဲ့ Bot notification များကိုသာ Admin Group ထဲ မပို့ပါ။ သာမန် User Noti များ အမြဲပို့ပါမည်။');

onLabel(L.groupNotifications, adminOnly((ctx, s) => ui.html(s.id,
    groupNotificationText(s.id),
    flagKb('gn', groupNotificationsEnabledFor(s.id)))));


const flagKb = (ns, on) => inline([[
    cb('ON', `${ns}:on`, on ? 'success' : undefined),
    cb('OFF', `${ns}:off`, !on ? 'danger' : undefined),
], cancelRow]);
const flagText = (icon, title, on, desc) =>
    `${em(icon)} <b>${esc(title)}</b>  ${on ? `${em('dotG')} ON` : `${em('dotR')} OFF`}\n<i>${esc(desc)}</i>`;

onLabel(L.maintenance, ownerOnly((ctx, s) => ui.html(s.id,
    flagText('settings', 'Maintenance mode', stores.bot.data.maintenance, 'ON လုပ်ရင် Admin မှလွဲ၍ ဘယ်သူမှ မသုံးနိုင်ပါ၊ run နေတဲ့ bot များလည်း ရပ်သွားမည်'),
    flagKb('mt', stores.bot.data.maintenance))));
onLabel(L.freeMode, ownerOnly((ctx, s) => ui.html(s.id,
    flagText('ok', 'Free Mode', stores.bot.data.freeMode, 'ON လုပ်ရင် ID Allow မလိုဘဲ လူတိုင်းသုံးနိုင်မည်'),
    flagKb('fm', stores.bot.data.freeMode))));


const who = (t) => [t?.username && `@${t.username}`, t?.name].filter(Boolean).join(' · ') || '—';
const nameCache = new Map();
async function tgName(id) {
    const live = sessions.get(id)?.tg;
    if (live?.username || live?.name) return who(live);
    const hit = nameCache.get(id);
    if (hit && Date.now() - hit.at < 600_000) return hit.label;
    try {
        const c = await bot.telegram.getChat(id);
        const label = who({ username: c.username, name: [c.first_name, c.last_name].filter(Boolean).join(' ') });
        nameCache.set(id, { label, at: Date.now() });
        return label;
    } catch { return '—'; }
}

async function showAllowed(chatId) {
    const ids = allowedIds.all();
    if (!ids.length) return ui.html(chatId, note('info', 'No allowed IDs yet.'), adminMenu(chatId));
    return ui.card(chatId, { icon: 'list', title: `Allowed platform IDs (${ids.length})`, sections: [{ header: ['#', 'Platform ID'], rows: ids.map((id, i) => [i + 1, id]) }] }, adminMenu(chatId));
}
async function showBanned(chatId) {
    const ids = bannedIds.all();
    if (!ids.length) return ui.html(chatId, note('info', 'Ban list is empty.'), adminMenu(chatId));
    const rows = await Promise.all(ids.map(async (id, i) => [i + 1, id, await tgName(id)]));
    return ui.card(chatId, {
        icon: 'list', title: `Banned users (${ids.length})`,
        sections: [{ header: ['#', 'Telegram ID', 'Telegram'], rows }],
    }, adminMenu(chatId));
}
async function showActiveUsers(chatId) {
    const users = [...sessions.values()].filter((x) => x.client);
    if (!users.length) return ui.html(chatId, note('info', 'No signed-in users.'), adminMenu(chatId));
    const rows = await Promise.all(users.map(async (x) => {
        const bal = x.cfg.virtual ? (x.run?.vBalance ?? x.cfg.virtualBalance) : await x.client.balance().catch(() => null);
        return [
            x.id, who(x.tg), x.info?.userId ?? '—', x.cfg.platform,
            `${bal == null ? '—' : ks(bal)}${x.cfg.virtual ? ' (V)' : ''}`,
            x.running ? '● running' : '○ idle',
        ];
    }));
    return ui.card(chatId, {
        icon: 'user', title: `Signed-in users (${rows.length})`,
        sections: [{ header: ['TG ID', 'Telegram', 'Game ID', 'Platform', 'Balance', 'Bot'], rows }],
    }, adminMenu(chatId));
}

function paymentEntries() {
    return Array.isArray(stores.payments.data.payments) ? stores.payments.data.payments : (stores.payments.data.payments = []);
}
function paymentById(id) { return paymentEntries().find((p) => p.id === String(id)); }
function paymentReviewKb(id) { return inline([[cb('Approve', `pa:${id}`, 'success', 'ok'), cb('Reject', `pr:${id}`, 'danger', 'error')]]); }
function paymentId() { return `PAY-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`; }
function paymentCaption(payment) {
    return `${em('wallet')} <b>Pending Payment</b>
` +
        `<b>Payment ID:</b> <code>${esc(payment.id)}</code>
` +
        `<b>Username:</b> ${esc(payment.username || '—')}
` +
        `<b>Name:</b> ${esc(payment.name || '—')}
` +
        `<b>Telegram ID:</b> <code>${esc(payment.telegramId)}</code>
` +
        `<b>Game ID:</b> <code>${esc(payment.gameId || '—')}</code>
` +
        `<b>Amount:</b> <code>${Number(payment.amount || getPaymentAmount()).toLocaleString('en-US')} Ks</code>`;
}
async function notifyOwnerPayment(payment) {
    return bot.telegram.sendPhoto(CONFIG.ownerId, payment.fileId, {
        caption: paymentCaption(payment), parse_mode: 'HTML', reply_markup: paymentReviewKb(payment.id),
    });
}
async function showPendingPayments(chatId) {
    const pending = paymentEntries().filter((p) => p.status === 'pending');
    if (!pending.length) return ui.html(chatId, note('info', 'Pending Payment မရှိသေးပါ။'), adminMenu(chatId));
    const rows = pending.map((p) => [p.id, p.username || p.name || '—', p.gameId || '—', new Date(p.createdAt).toISOString().slice(0, 16).replace('T', ' ')]);
    const buttons = pending.map((p) => [cb(`Approve ${p.id}`, `pa:${p.id}`, 'success', 'ok'), cb('Reject', `pr:${p.id}`, 'danger', 'error')]);
    return ui.card(chatId, { icon: 'wallet', title: `Pending Payments (${pending.length})`, sections: [{ header: ['Payment ID', 'User', 'Game ID', 'Created'], rows }] }, inline([...buttons, [cb('Back', 'x:payment', undefined, 'back')]]));
}
async function finalizePayment(ctx, approved, id) {
    if (!isOwner(ctx.from.id)) return;
    const payment = paymentById(id);
    if (!payment || payment.status !== 'pending') return ctx.answerCbQuery('Payment already processed.', { show_alert: true }).catch(() => { });
    const gameId = Number(payment.gameId);
    if (approved && !Number.isFinite(gameId)) return ctx.answerCbQuery('Invalid Game ID.', { show_alert: true }).catch(() => { });
    payment.status = approved ? 'approved' : 'rejected';
    payment.decidedAt = new Date().toISOString();
    payment.decidedBy = String(ctx.from.id);
    if (approved) allowedIds.add(gameId);
    stores.payments.save();
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => { });
    const target = Number(payment.telegramId);
    const targetSession = sessions.get(target);
    if (approved) await ui.html(target, `${em('ok')} <b>Payment Approved</b>
အသုံးပြုခွင့်ရပါပြီ။ Game ID <code>${esc(payment.gameId)}</code> ကို Allow လုပ်ပြီးပါပြီ။ ကျေးဇူးပြု၍ ပြန်လည် Sign In ဝင်ပါ။`, targetSession ? mainMenu(targetSession) : undefined).catch(() => { });
    else await ui.html(target, `${em('error')} <b>Payment မအတည်ပြုနိုင်သေးပါ။</b>
ကျေးဇူးပြု၍ Admin ကို ဆက်သွယ်ပါ။`).catch(() => { });
    return ui.html(ctx.from.id, note(approved ? 'ok' : 'info', `${payment.id} ${approved ? 'approved and Game ID allowed.' : 'rejected.'}`), adminMenu(ctx.from.id));
}
const positiveNumber = (text) => { const n = parseFloat(text); return Number.isFinite(n) && n > 0 ? n : null; };

async function finishPlatformLogin(s, client, platformKey, identifier, password) {
    const info = await client.userInfo();
    if (!info?.userId) throw new Error('Could not read account details');
    if (!isAuthorized(s.id, info.userId)) {
        s.info = info;
        s.input = null;
        await ui.html(s.id, denyText(s.id, info.userId), paymentStartKb());
        return false;
    }
    Object.assign(s, { client, info, creds: { phone: identifier, identifier, password, platform: platformKey } });
    if (!stores.settings.data[s.id]) stores.settings.data[s.id] = defaultSettings(platformKey);
    s.cfg.platform = platformKey;
    if (!GAMES[s.cfg.game]) s.cfg.game = defaultSettings(platformKey).game;
    saveSettings();
    const balance = await client.balance().catch(() => null);
    await ui.card(s.id, {
        icon: 'ok', title: `${platformKey} connected`,
        sections: [{ rows: [['User ID', info.userId], ['Balance', balance == null ? '—' : ks(balance)]] }],
        note: 'Configure your settings, then tap Launch.',
    }, mainMenu(s));
    return true;
}
function loginLines(text) {
    const lines = String(text).split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) {
        const oneLine = String(text).trim().match(/^(\S+@\S+)\s+(.+)$/);
        if (oneLine) return { identifier: oneLine[1], password: oneLine[2] };
    }
    const [identifier, password] = lines;
    return { identifier, password };
}

const INPUTS = {
    async login(ctx, s, text) {
        const { identifier, password } = loginLines(text);
        if (!identifier || !password) return ui.html(s.id, note('error', 'Send email/mobile and password on two separate lines.'));
        await ctx.deleteMessage().catch(() => { });
        const platformKey = s.input.platform;
        s.input = null;
        await ui.html(s.id, note('wait', `Connecting to <b>${esc(platformKey)}</b>…`));
        try {
            const client = new LotteryClient(platformKey);
            await client.login(identifier, password);
            await finishPlatformLogin(s, client, platformKey, identifier, password);
        } catch (err) {
            if (err.code === 'LOGIN_CODE_REQUIRED') {
                s.input = { type: 'login-code', platform: platformKey, identifier, password };
                return ui.html(s.id, `${em('lock')} <b>Verification code required</b>\nSend the code you received by SMS/email.`, inline([cancelRow]));
            }
            await ui.html(s.id, note('error', `Sign-in failed: ${esc(err.message)}`), mainMenu(s));
        }
    },

    async 'login-code'(ctx, s, text) {
        const code = String(text).trim();
        if (!/^\d{6}$/.test(code)) return ui.html(s.id, note('error', 'Enter the 6-digit verification code.'));
        const { platform, identifier, password } = s.input || {};
        if (!platform || !identifier || !password) { s.input = null; return ui.html(s.id, note('error', 'Login session expired. Please start login again.'), mainMenu(s)); }
        await ctx.deleteMessage().catch(() => { });
        s.input = null;
        await ui.html(s.id, note('wait', 'Verifying code and signing in…'));
        try {
            const client = new LotteryClient(platform);
            await client.login(identifier, password, code);
            await finishPlatformLogin(s, client, platform, identifier, password);
        } catch (err) {
            if (err.code === 'LOGIN_CODE_REQUIRED' || /verification|verify|v.?code|otp/i.test(err.message)) {
                s.input = { type: 'login-code', platform, identifier, password };
                return ui.html(s.id, note('error', 'Invalid or expired code. Send the new verification code.'));
            }
            await ui.html(s.id, note('error', `Sign-in failed: ${esc(err.message)}`), mainMenu(s));
        }
    },
    async 'payment-amount'(ctx, s, text) {
        const amount = Number(String(text).replace(/[,\s]/g, ''));
        if (!Number.isSafeInteger(amount) || amount <= 0) return ui.html(s.id, note('error', 'Payment amount ကို positive whole number အဖြစ် ထည့်ပါ။'), adminMenu(s.id));
        stores.bot.data.paymentAmount = amount;
        stores.bot.save();
        s.input = null;
        return ui.html(s.id, note('ok', `Payment amount ပြောင်းပြီးပါပြီ: <b>${amount.toLocaleString('en-US')} Ks</b>`), adminMenu(s.id));
    },
    async sizes(ctx, s, text) {
        const lines = String(text).split(/\n|,/).map((x) => x.trim()).filter(Boolean);
        if (lines.length === 1 && /^\d+$/.test(lines[0]) && Number(lines[0]) > 0) {
            const startAmount = Number(lines[0]);
            const balance = Number(s.input?.calculatorBalance);
            const unit = s.cfg.platform === 'CKLOTTERY' ? 10 : 100;
            if (!Number.isFinite(balance)) return ui.html(s.id, note('error', 'Balance is unavailable. Reopen Stake Sizes and try again.'));
            if (s.cfg.strategy === 'KO_PAING') {
                if (startAmount % unit !== 0 || startAmount > balance) return ui.html(s.id, note('error', `KO PAING အတွက် stake တစ်ခုတည်းကို ${unit} Ks multiple ဖြစ်အောင်၊ balance မကျော်အောင် ထည့်ပါ။`));
                Object.assign(s.cfg, { betSizes: [startAmount] });
                saveSettings(); s.input = null;
                return ui.html(s.id, note('ok', `KO PAING fixed stake: <b>${startAmount.toLocaleString('en-US')} Ks</b>`), mainMenu(s));
            }
            const sizes = calculatedStakeSizes(startAmount, balance, s.cfg.platform);
            if (!sizes.length) return ui.html(s.id, note('error', `Starting stake must be a ${unit} Ks multiple and the ladder total must fit within the available balance (${ks(balance)}).`));
            Object.assign(s.cfg, { betSizes: sizes });
            saveSettings(); s.input = null;
            return ui.html(s.id, note('ok', `Calculated from ${startAmount.toLocaleString('en-US')} Ks: <b>${sizes.join(' · ')}</b> Ks\nLadder total: <b>${sizes.reduce((sum, size) => sum + size, 0).toLocaleString('en-US')} Ks</b> / balance ${ks(balance)}.`), mainMenu(s));
        }
        const sizes = lines.map((line) => /^all\s*in$/i.test(line) ? 'ALL IN' : (/^\d+$/.test(line) ? Number(line) : null)).filter((value) => value !== null);
        if (s.cfg.strategy === 'KO_PAING' && (sizes.length !== 1 || sizes[0] === 'ALL IN' || sizes[0] <= 0)) return ui.html(s.id, note('error', 'KO PAING အတွက် fixed stake size တစ်ခုတည်းသာ ထည့်ပါ (ဥပမာ 1000).'));
        if (!sizes.length || sizes.length !== lines.length) return ui.html(s.id, note('error', 'Use whole numbers (including 0) or ALL IN, one per line. For calculator, send only the balance number.'));

        Object.assign(s.cfg, { betSizes: sizes });
        saveSettings(); s.input = null;
        return ui.html(s.id, note('ok', `Stake sizes: <b>${sizes.join(', ')}</b> Ks`), mainMenu(s));
    },
    async pattern(ctx, s, text) {
        const p = text.toUpperCase().replace(/\s/g, '');
        if (!/^[BS]{3,}$/.test(p)) return ui.html(s.id, note('error', 'Use only B and S, at least 3 characters.'));
        s.cfg.pattern = p; saveSettings(); s.input = null;
        return ui.html(s.id, note('ok', `BS pattern <code>${esc(p)}</code> · first bet ${p[0] === 'B' ? 'BIG' : 'SMALL'}`), mainMenu(s));
    },
    async target(ctx, s, text) {
        const n = positiveNumber(text);
        if (!n) return ui.html(s.id, note('error', 'Enter a positive number.'));
        s.cfg.target = n; saveSettings(); s.input = null;
        return ui.html(s.id, note('ok', `Profit target: <b>${ks(n)}</b>`), riskMenu());
    },
    async stoploss(ctx, s, text) {
        const n = positiveNumber(text);
        if (!n) return ui.html(s.id, note('error', 'Enter a positive number.'));
        s.cfg.stopLoss = n; saveSettings(); s.input = null;
        return ui.html(s.id, note('ok', `Stop loss: <b>${ks(n)}</b>`), riskMenu());
    },
    async autotime(ctx, s, text) {
        const lines = String(text).split(/\n|,/).map((x) => x.trim()).filter(Boolean);
        let start = s.cfg.autoTimeStart, end = s.cfg.autoTimeEnd, duration = s.cfg.autoDurationMinutes, wins = s.cfg.autoWinCount;
        for (const line of lines) {
            if (/^off$/i.test(line)) { start = end = duration = wins = null; continue; }
            const range = line.match(/^(.+?)\s*(?:-|to)\s*(.+)$/i);
            if (range && parseClock(range[1]) != null && parseClock(range[2]) != null) { start = parseClock(range[1]); end = parseClock(range[2]); continue; }
            const dm = line.match(/^(?:duration\s*[:=]?\s*)?(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes)$/i);
            if (dm && Number(dm[1]) > 0) { duration = Number(dm[1]); continue; }
            const wm = line.match(/^(?:wins?|count)\s*[:=]?\s*(\d+)$/i) || line.match(/^(\d+)\s*wins?$/i);
            if (wm && Number(wm[1]) > 0) { wins = Number(wm[1]); continue; }
            return ui.html(s.id, note('error', 'Invalid line. Use <code>09:00 AM - 10:00 AM</code>, <code>60 mins</code>, or <code>10 wins</code>.'));
        }
        if ((start == null) !== (end == null)) return ui.html(s.id, note('error', 'Set both start and end times.'));
        Object.assign(s.cfg, { autoTimeStart: start, autoTimeEnd: end, autoDurationMinutes: duration, autoWinCount: wins }); saveSettings(); s.input = null;
        return ui.html(s.id, note('ok', `Auto limits saved: <b>${esc(formatAutoTime(s.cfg))}</b> · <b>${esc(formatRunLimits(s.cfg))}</b>`), mainMenu(s));
    },
    async 'import-code'(ctx, s, text) {
        const code = normalizeSettingCode(text);
        if (!code) return ui.html(s.id, note('error', 'Import Code format မမှန်ပါ။ ဥပမာ <code>PAI-ABCD-EFGH-JKLM</code>'));
        const imported = importSharedSettingCode(s, code);
        if (!imported.ok) return ui.html(s.id, note('error', imported.message));
        s.input = null;
        const cfg = imported.payload;
        return ui.html(s.id, `${em('ok')} <b>Import Code အောင်မြင်ပါသည်</b>\n\nCode: <code>${esc(code)}</code>\nGame: <b>${esc(GAMES[cfg.game].label)}</b>\nStrategy: <b>${esc(STRATEGIES[cfg.strategy].label)}</b>\nStake: <code>${cfg.betSizes.join(',')}</code>\nProfit Target: <b>${cfg.target == null ? 'not set' : ks(cfg.target)}</b>\nStop Loss: <b>${cfg.stopLoss == null ? 'not set' : ks(cfg.stopLoss)}</b>`, mainMenu(s));
    },
    async 'setting-code-balance'(ctx, s, text) {
        const sharedCode = normalizeSettingCode(text);
        if (sharedCode) {
            const imported = importSharedSettingCode(s, sharedCode);
            if (!imported.ok) return ui.html(s.id, note('error', imported.message));
            s.input = null;
            const p = imported.payload;
            return ui.html(s.id, `${em('ok')} <b>Setting Code imported</b>\n\nCode: <code>${esc(sharedCode)}</code>\nGame: <b>${esc(GAMES[p.game].label)}</b>\nStrategy: <b>${esc(STRATEGIES[p.strategy].label)}</b>\nStake: <code>${p.betSizes.join(',')}</code>\nProfit Target: <b>${p.target == null ? 'not set' : ks(p.target)}</b>\nStop Loss: <b>${p.stopLoss == null ? 'not set' : ks(p.stopLoss)}</b>`, mainMenu(s));
        }
        const balance = Number(String(text).replace(/[,_\s]/g, ''));
        if (!Number.isSafeInteger(balance) || balance <= 0) {
            return ui.html(s.id, note('error', 'Balance ကို positive whole number အဖြစ် ပို့ပါ။ ဥပမာ <code>50000</code>'));
        }
        const profile = settingCodeProfile(balance);
        if (!profile) {
            return ui.html(s.id, note('error', 'Balance အနည်းဆုံး 5,000 Ks လိုအပ်ပါတယ်။ ဥပမာ <code>5000</code>, <code>10000</code>, <code>30000</code>, <code>50000</code>, <code>100000</code>')); 
        }
        s.input = { type: 'setting-code-target', balance };
        return ui.html(s.id, `${em('target')} <b>Profit Target ပို့ပါ</b>\n\nBalance: <code>${balance.toLocaleString('en-US')} Ks</code>\nTier: <b>${profile.minBalance.toLocaleString('en-US')}+</b>\n\nProfit Target ပမာဏကို ပို့ပါ။ ဥပမာ <code>10000</code>`, inline([cancelRow]));
    },
    async 'setting-code-target'(ctx, s, text) {
        const target = positiveNumber(text);
        if (!target) return ui.html(s.id, note('error', 'Profit Target ကို positive number အဖြစ် ပို့ပါ။ ဥပမာ <code>10000</code>'));
        const balance = Number(s.input?.balance);
        const profile = settingCodeProfile(balance);
        if (!profile) { s.input = null; return ui.html(s.id, note('error', 'Setting Code session မမှန်တော့ပါ။ Setting Code ကို ပြန်နှိပ်ပါ။'), mainMenu(s)); }
        s.input = { type: 'setting-code-stoploss', balance, target };
        return ui.html(s.id, `${em('warn')} <b>Stop Loss ပို့ပါ</b>\n\nBalance: <code>${balance.toLocaleString('en-US')} Ks</code>\nProfit Target: <code>${target.toLocaleString('en-US')} Ks</code>\n\nStop Loss ပမာဏကို ပို့ပါ။ ဥပမာ <code>5000</code>`, inline([cancelRow]));
    },
    async 'setting-code-stoploss'(ctx, s, text) {
        const stopLoss = positiveNumber(text);
        if (!stopLoss) return ui.html(s.id, note('error', 'Stop Loss ကို positive number အဖြစ် ပို့ပါ။ ဥပမာ <code>5000</code>'));
        const balance = Number(s.input?.balance);
        const target = Number(s.input?.target);
        const result = applySettingCode(s, balance, target, stopLoss);
        if (!result.ok) { s.input = null; return ui.html(s.id, note('error', result.message), mainMenu(s)); }
        s.input = null;
        return ui.html(s.id, settingCodeAppliedText(result.profile, balance, target, stopLoss, result.code), mainMenu(s));
    },
    async 'setting-code'(ctx, s, text) {
        const values = String(text).split(/[\s,\n]+/).map((x) => x.trim()).filter(Boolean);
        if (values.length === 1) return INPUTS['setting-code-balance'](ctx, s, values[0]);
        const balance = Number(String(values[0] || '').replace(/[,_]/g, ''));
        const target = values[1] == null ? null : positiveNumber(values[1]);
        const stopLoss = values[2] == null ? null : positiveNumber(values[2]);
        if (!Number.isSafeInteger(balance) || balance <= 0 || !target || !stopLoss || values.length > 3) {
            return ui.html(s.id, note('error', 'Format: <code>balance target stoploss</code> ဥပမာ <code>50000 10000 5000</code>'), mainMenu(s));
        }
        const result = applySettingCode(s, balance, target, stopLoss);
        if (!result.ok) return ui.html(s.id, note('error', result.message), mainMenu(s));
        s.input = null;
        return ui.html(s.id, settingCodeAppliedText(result.profile, balance, target, stopLoss, result.code), mainMenu(s));
    },
    async vbalance(ctx, s, text) {
        const n = positiveNumber(text);
        if (!n) return ui.html(s.id, note('error', 'Enter a positive number.'));
        Object.assign(s.cfg, { virtual: true, virtualBalance: n }); saveSettings(); s.input = null;
        return ui.html(s.id, note('virtual', `Virtual wallet: <b>${ks(n)}</b>`), mainMenu(s));
    },
    async 'manual-amount'(ctx, s, text) {
        const n = parseInt(text, 10);
        if (!(n > 0)) return ui.html(s.id, note('error', 'Enter a positive whole number.'));
        const side = s.input.side; s.input = null;
        return ui.html(s.id, `${em('risk')} <b>${n.toLocaleString('en-US')} Ks</b> — choose a multiplier`, manualMultPicker(side, n));
    },
    async 'manual-mult'(ctx, s, text) {
        const n = parseInt(text, 10);
        if (!(n > 0)) return ui.html(s.id, note('error', 'Enter a positive whole number.'));
        const { side, amount } = s.input; s.input = null;
        return ui.html(s.id, manualConfirmText(side, amount, n), manualConfirmKb(side, amount, n));
    },

    async 'admin-allow'(ctx, s, text) { s.input = null; return ui.html(s.id, esc(allow(text)), adminMenu(s.id)); },
    async 'admin-disallow'(ctx, s, text) { s.input = null; return ui.html(s.id, esc(disallow(text)), adminMenu(s.id)); },
    async 'admin-ban'(ctx, s, text) { s.input = null; return ui.html(s.id, esc(banUser(text)), adminMenu(s.id)); },
    async 'admin-unban'(ctx, s, text) { s.input = null; return ui.html(s.id, esc(unbanUser(text)), adminMenu(s.id)); },
    async 'admin-add-admin'(ctx, s, text) {
        s.input = null; const id = parseId(text);
        if (id === null) return ui.html(s.id, note('error', 'Invalid ID.'), adminMenu(s.id));
        return ui.html(s.id, adminIds.add(id) ? note('ok', `${id} is now an admin.`) : note('info', `${id} is already an admin.`), adminMenu(s.id));
    },
    async 'admin-remove-admin'(ctx, s, text) {
        s.input = null; const id = parseId(text);
        if (id === null) return ui.html(s.id, note('error', 'Invalid ID.'), adminMenu(s.id));
        if (isOwner(id)) return ui.html(s.id, note('error', 'The owner cannot be removed.'), adminMenu(s.id));
        return ui.html(s.id, adminIds.remove(id) ? note('ok', `${id} removed.`) : note('info', `${id} is not an admin.`), adminMenu(s.id));
    },
    async 'signal-add-channel'(ctx, s, text) {
        s.input = null;
        const id = parseChatId(text);
        if (!id) return ui.html(s.id, note('error', 'Invalid Channel ID. ဥပမာ: <code>-1001234567890</code>'), adminMenu(s.id));
        const added = signalChannelIds.add(id);
        if (added) {
            try {
                const chat = await bot.telegram.getChat(id);
                const channels = stores.signalChannels.data.channels || (stores.signalChannels.data.channels = {});
                channels[id] = { title: chat.title || null, username: chat.username || null, updatedAt: Date.now() };
                stores.signalChannels.save();
            } catch (err) {
                log.warn(`signal channel metadata ${id}: ${err.message}`);
            }
        }
        return ui.html(s.id, added ? note('ok', `${id} signal channel အဖြစ် ထည့်ပြီးပါပြီ။ Bot ကို Channel မှာ Admin ထားထားကြောင်း စစ်ပါ။`) : note('info', `${id} ရှိပြီးသားပါ။`), adminMenu(s.id));
    },
    async 'force-join-add'(ctx, s, text) {
        s.input = null;
        const lines = String(text).split(/\n/).map((x) => x.trim()).filter(Boolean);
        const id = forceJoinChatKey(lines[0]);
        if (!id) return ui.html(s.id, note('error', 'Invalid Chat ID or @username.'), adminMenu(s.id));
        const url = lines[1] || null;
        if (url && !/^https?:\/\//i.test(url)) return ui.html(s.id, note('error', 'Join URL must start with http:// or https://'), adminMenu(s.id));
        let meta = { title: id, username: id.startsWith('@') ? id.slice(1) : null, url, addedAt: Date.now() };
        try { const chat = await bot.telegram.getChat(id); meta = { ...meta, title: chat.title || meta.title, username: chat.username || meta.username }; } catch (err) { log.warn(`force join metadata ${id}: ${err.message}`); }
        forceJoinData()[id] = meta; stores.forceJoin.save();
        return ui.html(s.id, note('ok', `${esc(forceJoinLabel(id, meta))} ကို Force Join အဖြစ် ထည့်ပြီးပါပြီ။`), adminMenu(s.id));
    },
    async 'force-join-remove'(ctx, s, text) {
        s.input = null;
        const id = forceJoinChatKey(text);
        if (!id) return ui.html(s.id, note('error', 'Invalid Chat ID or @username.'), adminMenu(s.id));
        const data = forceJoinData();
        if (!data[id]) return ui.html(s.id, note('info', 'Force Join chat မတွေ့ပါ။'), adminMenu(s.id));
        delete data[id]; stores.forceJoin.save();
        return ui.html(s.id, note('ok', `${esc(id)} ကို Force Join မှ ဖယ်ပြီးပါပြီ။`), adminMenu(s.id));
    },
    async 'signal-remove-channel'(ctx, s, text) {
        s.input = null;
        const id = parseChatId(text);
        if (!id) return ui.html(s.id, note('error', 'Invalid Channel ID.'), adminMenu(s.id));
        const removed = signalChannelIds.remove(id);
        if (removed) {
            if (stores.signalChannels.data.channels) delete stores.signalChannels.data.channels[id];
            stores.signalChannels.save();
        }
        return ui.html(s.id, removed ? note('ok', `${id} ဖယ်ပြီးပါပြီ။`) : note('info', `${id} မတွေ့ပါ။`), adminMenu(s.id));
    },
    async broadcast(ctx, s, text) {
        if (!isOwner(s.id)) { s.input = null; return ui.html(s.id, note('error', 'Owner only.'), adminMenu(s.id)); }
        s.input = null;
        const body = `${em('broadcast')} <b>Announcement</b>\n\n${text}`;
        let sent = 0;
        for (const id of knownUsers.all()) {
            if (bannedIds.has(id)) continue;
            try { await ui.html(id, body); sent++; } catch {  }
            await sleep(35);
        }
        return ui.html(s.id, note('ok', `Delivered to ${sent}/${knownUsers.all().length} users.`), adminMenu(s.id));
    },
};

const QUICK_BET_SIDE = {
    big: 'B', b: 'B', small: 'S', s: 'S',
    green: 'G', g: 'G', red: 'R', r: 'R', violet: 'V', v: 'V',
};
const QUICK_BET_RE = /^bet\s+(big|b|small|s|green|g|red|r|violet|v)\s+([0-9][0-9,]*(?:\.[0-9]+)?\s*[km]?)$/i;
function parseQuickBet(text) {
    const m = String(text || '').trim().match(QUICK_BET_RE);
    if (!m) return null;
    const side = QUICK_BET_SIDE[m[1].toLowerCase()];
    const raw = m[2].replace(/\s+/g, '').toLowerCase();
    const multiplier = raw.endsWith('k') ? 1_000 : raw.endsWith('m') ? 1_000_000 : 1;
    const numeric = raw.replace(/[km]$/, '').replace(/,/g, '');
    const amount = Math.round(Number(numeric) * multiplier);
    return side && Number.isFinite(amount) && amount > 0 ? { side, amount } : null;
}

bot.on('channel_post', async (ctx) => {
    const channelId = String(ctx.chat?.id || '');
    if (!signalChannelIds.has(channelId)) return;
    const text = ctx.channelPost?.text || ctx.channelPost?.caption || '';
    const signal = parseChannelSignal(text);
    if (!signal) {
        log.debug(`ignored unrecognized signal from ${channelId}`);
        return;
    }
    signal.channelId = channelId;
    signal.messageId = ctx.channelPost?.message_id || null;
    signal.channelUsername = ctx.chat?.username || null;
    signal.channelTitle = ctx.chat?.title || null;
    const channelMeta = stores.signalChannels.data.channels || (stores.signalChannels.data.channels = {});
    channelMeta[channelId] = { title: signal.channelTitle, username: signal.channelUsername, updatedAt: Date.now() };
    stores.signalChannels.save();
    signalState.latest = signal;
    signalState.byPeriod.set(`${channelId}:${signal.period}`, signal);
    if (signalState.byPeriod.size > 200) {
        const old = [...signalState.byPeriod.keys()].slice(0, signalState.byPeriod.size - 100);
        old.forEach((key) => signalState.byPeriod.delete(key));
    }
    log.info(`channel signal accepted ${channelId}: ${signal.period} ${signal.choice} ${signal.multiplier}x`);
});

bot.on('text', async (ctx) => {
    // Session middleware only initializes private chats; ignore group text updates.
    if (ctx.chat?.type !== 'private' || !ctx.from) return;
    const s = ctx.state?.s;
    if (!s) return;
    const text = ctx.message?.text || '';

    if (s.input?.type === 'setemoji' && isOwner(s.id)) {
        const custom = ctx.message.entities?.find((e) => e.type === 'custom_emoji');
        if (!custom) return ui.html(s.id, note('error', 'That was not a premium emoji. Send one custom emoji.'));
        stores.emoji.data[s.input.key] = custom.custom_emoji_id;
        stores.emoji.save();
        const key_ = s.input.key; s.input = null;
        return ui.html(s.id, `${note('ok', `<code>${esc(key_)}</code> saved`)}  ${em(key_)}`);
    }

    const handler = s.input && INPUTS[s.input.type];
    if (handler) return handler(ctx, s, text.trim());

    if (!s.input && s.client && normalizeSettingCode(text)) {
        const imported = importSharedSettingCode(s, text);
        if (!imported.ok) return ui.html(s.id, note('error', imported.message), mainMenu(s));
        const p = imported.payload;
        return ui.html(s.id, `${em('ok')} <b>Setting Code imported</b>\nCode: <code>${esc(normalizeSettingCode(text))}</code>\nGame: <b>${esc(GAMES[p.game].label)}</b>\nStrategy: <b>${esc(STRATEGIES[p.strategy].label)}</b>\nStake: <code>${p.betSizes.join(',')}</code>`, mainMenu(s));
    }

    if (!s.input && s.client && /^\d[\d,_]*(?:\s+[\d,_]+){0,2}$/.test(text.trim())) {
        const values = text.trim().split(/\s+/).map((x) => Number(x.replace(/[,_]/g, '')));
        if (values.length === 1 && settingCodeProfile(values[0])) {
            const result = applySettingCode(s, values[0]);
            return ui.html(s.id, `${settingCodeAppliedText(result.profile, values[0], null, null)}\n\n${em('info')} Target / Stop Loss မထည့်ရသေးပါ။ <code>/settingcode ${values[0]} TARGET STOPLOSS</code> ဖြင့် ထည့်နိုင်ပါတယ်။`, mainMenu(s));
        }
        if (values.length >= 2 && values.length <= 3 && values.every((n) => Number.isFinite(n))) {
            const result = applySettingCode(s, values[0], values[1], values[2] ?? null);
            if (result.ok) return ui.html(s.id, settingCodeAppliedText(result.profile, values[0], values[1], values[2] ?? null), mainMenu(s));
        }
    }

    const quickBet = parseQuickBet(text);
    if (quickBet) {
        if (!s.client) return ui.html(s.id, note('error', 'Please sign in first.'), mainMenu(s));
        return ui.html(s.id, quickConfirmText(s, quickBet.side, quickBet.amount), quickConfirmKb(s, quickBet.side, quickBet.amount));
    }
    if (s.client && !text.startsWith('/')) return ui.html(s.id, note('info', 'Use the menu buttons below or send: <code>bet big 200</code>.'), mainMenu(s));
});

bot.on('photo', async (ctx) => {
    const s = ctx.state.s;
    if (s.input?.type !== 'payment-screenshot') return;
    const photo = ctx.message.photo?.at(-1);
    if (!photo?.file_id) return ui.html(s.id, note('error', 'Screenshot မတွေ့ပါ။ Photo အဖြစ် ပြန်ပို့ပေးပါ။'));
    const pending = paymentEntries().find((p) => p.telegramId === String(s.id) && p.status === 'pending');
    const payment = pending || { id: paymentId(), telegramId: String(s.id), username: s.tg?.username ? `@${s.tg.username}` : '—', name: s.tg?.name || '—', gameId: s.info?.userId || '—', amount: getPaymentAmount(), status: 'pending', createdAt: new Date().toISOString() };
    Object.assign(payment, { fileId: photo.file_id, amount: getPaymentAmount(), updatedAt: new Date().toISOString(), gameId: s.info?.userId || payment.gameId || '—' });
    if (!pending) paymentEntries().push(payment);
    stores.payments.save();
    s.input = null;
    try {
        await notifyOwnerPayment(payment);
        return ui.html(s.id, note('ok', `Screenshot လက်ခံပြီးပါပြီ။ Owner စစ်ဆေးပြီး Approve လုပ်ပေးပါမည်။
Payment ID: <code>${esc(payment.id)}</code>`));
    } catch (err) {
        return ui.html(s.id, note('error', `Screenshot သိမ်းပြီးပါပြီ၊ Owner notification မပို့နိုင်သေးပါ။ Payment ID: <code>${esc(payment.id)}</code>`));
    }
});


const manualConfirmText = (side, amount, mult) =>
    `${em('warn')} <b>Confirm bet</b>\n<blockquote>${sideTag(side)} · ${amount.toLocaleString('en-US')} × ${mult} = <b>${(amount * mult).toLocaleString('en-US')} Ks</b></blockquote>`;
const manualConfirmKb = (side, amount, mult) => inline([
    [cb(`Bet ${(amount * mult).toLocaleString('en-US')} Ks`, `mc:${side}:${amount}:${mult}`, 'success', 'ok')],
    [cb('Cancel', 'x:cancel', 'danger', 'error')],
]);
const quickConfirmText = (s, side, amount) => `${em('risk')} <b>${tr(s, 'quickTitle')}</b>\n<blockquote>${sideTag(side)} · <b>${amount.toLocaleString('en-US')} Ks</b>\n${em('game')} ${esc(GAMES[manualGame(s)].label)}</blockquote>`;
const quickConfirmKb = (s, side, amount) => inline([
    [cb(tr(s, 'confirm'), `qb:${side}:${amount}`, 'success', 'ok')],
    [cb(tr(s, 'cancel'), 'x:cancel', 'danger', 'error')],
]);

const ACTIONS = {
    async adm(ctx, s, [actionKey]) {
        if (!isAdmin(s.id)) return ui.html(s.id, note('error', 'Admins only.'), mainMenu(s));
        const label = ADMIN_MENU_LABELS[actionKey];
        const handler = label && labelHandlers.get(label);
        if (!handler) return;
        await ctx.deleteMessage().catch(() => { });
        s.input = null;
        return handler(ctx);
    },
    'sc': async (ctx, s, args) => {
        if (args[0] !== 'apply') return;
        return prompt(s, 'setting-code-balance', {}, `${em('settings')} <b>Setting Code</b>\n\nအရင်ဆုံး သင့် Balance ကို ပို့ပါ။\nဥပမာ <code>50000</code>`, inline([cancelRow]));
    },
    async x(ctx, s) { s.input = null; s.walletConfirm = null; await ctx.deleteMessage().catch(() => { }); },
    async lang(ctx, s, [value]) {
        if (!LANG[value]) return;
        s.cfg.language = value; saveSettings();
        await ctx.deleteMessage().catch(() => { });
        return ui.html(s.id, `${em('ok')} ${tr(s, 'languageSet')}`, mainMenu(s));
    },

    async qb(ctx, s, [side, amount]) {
        await ctx.deleteMessage().catch(() => { });
        return manualConfirm(s, side, Number(amount), 1);
    },


    async pay(ctx, s, [command]) {
        if (command !== 'open') return;
        s.input = { type: 'payment-screenshot' };
        return done(ctx, s, paymentInstructionText(), inline([cancelRow]));
    },
    async pa(ctx, s, [id]) { return finalizePayment(ctx, true, id); },
    async pr(ctx, s, [id]) { return finalizePayment(ctx, false, id); },
    async restart(ctx, s) {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => { });
        const err = startEngine(s);
        if (err) await ui.html(s.id, note('error', esc(err)), mainMenu(s));
    },
    async rate(ctx, s, [strategy, value]) {
        if (!STRATEGIES[strategy]) return;
        if (value === 'skip') {
            await ctx.deleteMessage().catch(() => { });
            return ui.html(s.id, note('info', 'Rating skipped.'), mainMenu(s));
        }
        const rating = Number(value);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) return;
        recordStrategyRating(s.id, strategy, rating);
        await ctx.deleteMessage().catch(() => { });
        return ui.html(s.id, note('ok', `ကျေးဇူးတင်ပါတယ်။ <b>${esc(STRATEGIES[strategy].label)}</b> rating: <b>${rating}/5</b> · Current average <b>${esc(strategyRatingLabel(strategy))}</b>`), mainMenu(s));
    },

    async sum(ctx, s, [which]) {
        const day = which === 'yesterday' ? previousSummaryDate(summaryDateKey()) : summaryDateKey();
        await ctx.deleteMessage().catch(() => { });
        return ui.html(s.id, summaryText(s, day), summaryNav(day));
    },
    async dir(ctx, s, [mode]) {
        if (!BET_MODES.includes(mode)) return;
        s.cfg.betMode = mode;
        saveSettings();
        const message = `Bet mode: <b>${betModeLabel(mode)}</b>${mode === 'REVERSE' ? ' · BIG/SMALL signals will be inverted.' : ''}`;
        return done(ctx, s, note('ok', message));
    },
    async st(ctx, s, [id, channelId]) {
        const st = STRATEGIES[id];
        if (!st) return;
        if (stores.bot.data.hiddenStrategies?.[id] === true) return done(ctx, s, note('error', 'ဒီ Strategy ကို Owner က ဖျောက်ထားပါတယ်။'));
        if (id === 'CHANNEL_SIGNAL') {
            s.cfg.game = 'TRX';
            s.cfg.betType = 'BS';
            s.cfg.strategy = id;
            s.cfg.signalChannelId = channelId || null;
            saveSettings();
            return done(ctx, s, `${em('broadcast')} Strategy: <b>Channel Signal</b>
<blockquote>Configured Signal Channel တွေမှ TRX signal အတိုင်းလိုက်ထိုးပါမည်။</blockquote>`);
        }
        if (id === 'GOLDEN_RATIO') {
            s.cfg.betType = 'BS';
            s.cfg.strategy = id;
            saveSettings();
            return done(ctx, s, `${em('strategy')} Strategy: <b>Golden Ratio</b>
Bet Type ကို <b>BIG / SMALL</b> သို့ သတ်မှတ်ပြီးပါပြီ။ နောက်ဆုံးထွက် result ၇ ခုကို mapping နဲ့တိုက်စစ်ပြီးမှ bet လုပ်ပါမည်။`);
        }
        if (id === 'SKO_ZE') {
            s.cfg.betType = 'BS';
            s.cfg.strategy = id;
            saveSettings();
            return done(ctx, s, `${em('strategy')} Strategy: <b>Sko-ze</b>
Bet Type ကို <b>BIG / SMALL</b> သို့ သတ်မှတ်ပြီးပါပြီ။ ဤနည်းဗျူဟာသည် <b>WINGO 30s</b> အတွက်သာဖြစ်ပြီး result ဟောင်းများကိုမသုံးပါ။`);
        }
        if (!st.modes.includes(s.cfg.betType) || st.notGames?.includes(s.cfg.game)) {
            return done(ctx, s, note('error', `${esc(st.label)} is not available for the current game / bet type.`));
        }
        s.cfg.strategy = id; saveSettings();
        if (id === 'BS_ORDER') { await ctx.deleteMessage().catch(() => { }); return prompt(s, 'pattern', {}, `${em('strategy')} <b>BS pattern</b>\nSend B/S characters, e.g. <code>BSBSSBBS</code>`, inline([cancelRow])); }
        if (id === 'KO_PAING') {
            const sizes = normalizeBetSizes(s.cfg.betSizes);
            if (sizes.length !== 1 || sizes[0] === 'ALL IN' || sizes[0] <= 0) {
                const balance = s.cfg.virtual ? (s.run?.vBalance ?? s.cfg.virtualBalance) : await s.client.balance().catch(() => null);
                await ctx.deleteMessage().catch(() => { });
                return prompt(s, 'sizes', { calculatorBalance: balance }, `${em('wallet')} <b>KO PAING Stake Size</b>\nKO PAING အတွက် stake size တစ်ခုတည်းသာ ထည့်ပါ။\nဥပမာ: <code>1000</code>\nတစ်ခုထက်ပိုပြီး ထည့်ထားပါက ဖျက်ပြီး size တစ်ခုတည်း ပြန်ထည့်ပါ။`, inline([cancelRow]));
            }
            s.cfg.betSizes = [sizes[0]];
            saveSettings();
            return done(ctx, s, `${em('strategy')} Strategy: <b>KO PAING</b>\n<blockquote>ပထမ ၅ ပွဲကို 0 bet skip ပါမယ်။ ၆ ပွဲမြောက်မှာ B ထိုးပါမယ်။ နိုင်ရင် B ဆက်ထိုးပြီး ရှုံးရင် ၅ ပွဲ skip ပြန်စပါမယ်။</blockquote>\n<b>Stake:</b> <code>${sizes[0].toLocaleString('en-US')} Ks</code>`);
        }
        if (st.description) return done(ctx, s, `${em('strategy')} Strategy: <b>${esc(st.label)}</b>\n<blockquote>${esc(st.description)}</blockquote>`);
        if (id === 'TREND_FOLLOW' && s.cfg.betType === 'BS') { await ctx.deleteMessage().catch(() => { }); return ui.html(s.id, `${em('strategy')} <b>B/S Follow</b>\nSkip when BS/SB repeats how many times?`, waitPicker('ws', s.cfg.bsWait)); }
        if (id === 'ALTERNATE') { await ctx.deleteMessage().catch(() => { }); return ui.html(s.id, `${em('strategy')} <b>B/S Reverse</b>\nSkip when BB/SS repeats how many times?`, waitPicker('bw', s.cfg.bbWait)); }
        const extra = st.sniper ? ` · ends after ${CONFIG.sniper.maxHits} hits or ${CONFIG.sniper.maxLosses} misses` : '';
        return done(ctx, s, `${em('strategy')} Strategy: <b>${esc(st.label)}</b>${extra}`);
    },
    async ws(ctx, s, [n]) { s.cfg.bsWait = Number(n); saveSettings(); return done(ctx, s, note('ok', Number(n) ? `BS/SB wait: <b>×${n}</b>` : 'BS/SB wait disabled')); },
    async bw(ctx, s, [n]) { s.cfg.bbWait = Number(n); saveSettings(); return done(ctx, s, note('ok', Number(n) ? `BB/SS wait: <b>×${n}</b>` : 'BB/SS wait disabled')); },

    async bt(ctx, s, [type]) {
        if (s.cfg.strategy === 'KO_ZERO') return done(ctx, s, `${em('strategy')} <b>KO ZERO</b> uses BIG/SMALL bets only. COLOR bets are disabled.`);
        if (!['BS', 'COLOR'].includes(type)) return;
        s.cfg.betType = type;
        const st = STRATEGIES[s.cfg.strategy];
        let extra = '';
        if (!st.modes.includes(type)) { s.cfg.strategy = 'TREND_FOLLOW'; extra = '\nStrategy reset to <b>Trend Follow</b>.'; }
        saveSettings();
        return done(ctx, s, note('ok', `Bet type: <b>${type === 'COLOR' ? 'Colour' : 'Big / Small'}</b>${extra}`));
    },

    async gt(ctx, s, [game]) {
        if (game === 'WINGO_SELECT') { await ctx.deleteMessage().catch(() => { }); return ui.html(s.id, `${em('game')} <b>WINGO duration</b>`, wingoPicker('gt', s.cfg.game)); }
        if (!GAMES[game]) return;
        s.cfg.game = game;
        let extra = '';
        if (STRATEGIES[s.cfg.strategy].notGames?.includes(game)) { s.cfg.strategy = 'TREND_FOLLOW'; extra = '\nStrategy reset to <b>Trend Follow</b>.'; }
        saveSettings();
        return done(ctx, s, note('ok', `Game: <b>${esc(GAMES[game].label)}</b>${extra}`));
    },
    async mg(ctx, s, [game]) {
        if (game === 'WINGO_SELECT') { await ctx.deleteMessage().catch(() => { }); return ui.html(s.id, `${em('game')} <b>WINGO duration</b>`, wingoPicker('mg', manualGame(s))); }
        if (!GAMES[game]) return;
        s.manual.game = game;
        return done(ctx, s, note('ok', `Manual game: <b>${esc(GAMES[game].label)}</b>`), manualMenu());
    },

    async bm(ctx, s, [mode]) {
        if (!STAKING_MODES.includes(mode)) return;
        s.cfg.staking = mode; saveSettings();
        return done(ctx, s, note('ok', `Staking: <b>${esc(mode)}</b>`));
    },

    async el(ctx, s, [n]) { s.cfg.entryLayer = Number(n); saveSettings(); return done(ctx, s, note('ok', `Entry layer: <b>${n}</b>`), riskMenu()); },
    async sl(ctx, s, [n]) { s.cfg.slLayer = Number(n); saveSettings(); return done(ctx, s, note('ok', Number(n) ? `SL layer: skip after <b>${n}</b> losses` : 'SL layer disabled'), riskMenu()); },

    async md(ctx, s, [mode]) {
        if (!['virtual', 'real'].includes(mode)) return;
        s.walletConfirm = { mode, step: 1 };
        await ctx.deleteMessage().catch(() => { });
        return ui.html(s.id, `${em('warn')} <b>Wallet switch confirmation 1/2</b>\nYou selected <b>${mode === 'real' ? 'REAL' : 'VIRTUAL'}</b> wallet. Continue?`, inline([[cb('Continue', `mdc:${mode}:1`, 'primary')], [cb('Cancel', 'x:cancel', 'danger', 'error')]]));
    },
    async mdc(ctx, s, [mode, step]) {
        if (s.walletConfirm?.mode !== mode || step !== '1') return;
        s.walletConfirm.step = 2;
        return ui.html(s.id, `${em('warn')} <b>Wallet switch confirmation 2/2</b>\n${mode === 'real' ? 'REAL wallet uses real money. Bets will be sent to the platform.' : 'VIRTUAL wallet will not place real-money bets.'}\nConfirm switch?`, inline([[cb('Confirm switch', `mdf:${mode}`, mode === 'real' ? 'danger' : 'success')], [cb('Cancel', 'x:cancel', 'danger', 'error')]]));
    },
    async mdf(ctx, s, [mode]) {
        if (s.walletConfirm?.mode !== mode || s.walletConfirm.step !== 2) return;
        s.walletConfirm = null;
        if (mode === 'virtual') { await ctx.deleteMessage().catch(() => { }); return prompt(s, 'vbalance', {}, `${em('virtual')} <b>Virtual wallet</b>\nStarting balance (Ks):\n<code>10000</code>`, inline([cancelRow])); }
        s.cfg.virtual = false; saveSettings();
        return done(ctx, s, note('real', 'Switched to <b>real</b> wallet.'));
    },

    async ma(ctx, s, [side, amount]) {
        await ctx.deleteMessage().catch(() => { });
        if (amount === 'c') return prompt(s, 'manual-amount', { side }, `${em('wallet')} Enter a custom amount:`);
        return ui.html(s.id, `${em('risk')} <b>${Number(amount).toLocaleString('en-US')} Ks</b> — choose a multiplier`, manualMultPicker(side, Number(amount)));
    },
    async mm(ctx, s, [side, amount, mult]) {
        await ctx.deleteMessage().catch(() => { });
        if (mult === 'c') return prompt(s, 'manual-mult', { side, amount: Number(amount) }, `${em('risk')} Enter a custom multiplier (e.g. 10):`);
        return ui.html(s.id, manualConfirmText(side, Number(amount), Number(mult)), manualConfirmKb(side, Number(amount), Number(mult)));
    },
    async mc(ctx, s, [side, amount, mult]) {
        await ctx.deleteMessage().catch(() => { });
        return manualConfirm(s, side, Number(amount), Number(mult));
    },

    async rp(ctx, s, [page]) {
        if (page === 'x') return;
        const view = s.manual.view;
        if (!view) return ctx.answerCbQuery('Results expired — open Results again.', { show_alert: true }).catch(() => { });
        const { card, pages } = resultsCard(view, Number(page), view.game);
        await ctx.deleteMessage().catch(() => { });
        return ui.card(s.id, card, resultsNav(Number(page), pages));
    },

    async live(ctx, s, [command]) {
        if (command !== 'stop') return;
        s.manual.live = null;
        await ctx.deleteMessage().catch(() => { });
        return ui.html(s.id, note('ok', 'Live Result stopped.'), manualMenu());
    },

    
    async tc(ctx, s) {
        await ctx.deleteMessage().catch(() => { });
        return sendTrx(s);
    },

    
    async mt(ctx, s, [v]) {
        if (!isOwner(s.id)) return;
        const on = v === 'on';
        stores.bot.data.maintenance = on; stores.bot.save();
        if (on) {
            for (const x of sessions.values()) {
                if (x.running && x.run && !isAdmin(x.id)) {
                    if (!x.run.endReason) x.run.endReason = 'maintenance';
                    x.running = false;
                }
            }
        }
        return done(ctx, s, note(on ? 'warn' : 'ok', `Maintenance mode: <b>${on ? 'ON' : 'OFF'}</b>`), adminMenu(s.id));
    },

    
    async gn(ctx, s, [v]) {
        if (!isAdmin(s.id)) return;
        const on = v === 'on';
        const disabled = stores.bot.data.groupNotificationDisabled || (stores.bot.data.groupNotificationDisabled = {});
        if (on) delete disabled[String(s.id)];
        else disabled[String(s.id)] = true;
        stores.bot.save();
        return done(ctx, s, note(on ? 'ok' : 'info', `Your Group Notifications: <b>${on ? 'ON' : 'OFF'}</b>`), adminMenu(s.id));
    },

    
    async fj(ctx, s, [command]) {
        if (command === 'check') {
            s.forceJoinNoticeSent = false;
            const ok = await enforceForceJoin(s);
            return ok ? ui.html(s.id, note('ok', 'အားလုံး Join ပြီးပါပြီ။ ဆက်လက်အသုံးပြုနိုင်ပါပြီ။'), mainMenu(s)) : undefined;
        }
    },

    async fm(ctx, s, [v]) {
        if (!isOwner(s.id)) return;
        const on = v === 'on';
        stores.bot.data.freeMode = on; stores.bot.save();
        return done(ctx, s, note(on ? 'ok' : 'info', `Free Mode: <b>${on ? 'ON' : 'OFF'}</b>`), adminMenu(s.id));
    },

    async sv(ctx, s, [command, platformKey]) {
        if (!isOwner(s.id)) return ui.html(s.id, note('error', 'Owner only.'), adminMenu(s.id));
        if (command === 'back') return done(ctx, s, note('info', 'Admin panel'), adminMenu(s.id));
        if (command !== 'toggle' || !Object.prototype.hasOwnProperty.call(PLATFORMS, platformKey)) return;
        const hidden = stores.bot.data.hiddenPlatforms || (stores.bot.data.hiddenPlatforms = {});
        const wasHidden = hidden[platformKey] === true;
        if (wasHidden) delete hidden[platformKey];
        else hidden[platformKey] = true;
        stores.bot.save();
        const state = wasHidden ? 'ဖော်ထားပါပြီ' : 'ဖျောက်ထားပါပြီ';
        return done(ctx, s, note('ok', `<b>${esc(PLATFORMS[platformKey].name)}</b> ကို ${state}။`), siteVisibilityMenu());
    },

    async stratvis(ctx, s, [command, strategyKey]) {
        if (!isOwner(s.id)) return ui.html(s.id, note('error', 'Owner only.'), adminMenu(s.id));
        if (command === 'back') return done(ctx, s, note('info', 'Admin panel'), adminMenu(s.id));
        if (command !== 'toggle' || !Object.prototype.hasOwnProperty.call(STRATEGIES, strategyKey)) return;
        const hidden = stores.bot.data.hiddenStrategies || (stores.bot.data.hiddenStrategies = {});
        const wasHidden = hidden[strategyKey] === true;
        if (wasHidden) delete hidden[strategyKey];
        else hidden[strategyKey] = true;
        stores.bot.save();
        const state = wasHidden ? 'ဖော်ထားပါပြီ' : 'ဖျောက်ထားပါပြီ';
        return done(ctx, s, note('ok', `<b>${esc(STRATEGIES[strategyKey].label)}</b> ကို ${state}။ အသစ်စတင်ခြင်းကိုသာ သက်ရောက်ပြီး လက်ရှိ run များ ဆက်လက်လုပ်ဆောင်ပါမည်။`), strategyVisibilityMenu());
    },
};

const NO_LOGIN_NEEDED = new Set(['x', 'fj', 'gn', 'mt', 'fm', 'sv', 'stratvis', 'adm', 'pay', 'pa', 'pr']);

bot.on('callback_query', async (ctx) => {
    const [ns, ...args] = String(ctx.callbackQuery?.data || '').split(':');
    await ctx.answerCbQuery().catch(() => { });
    const action = ACTIONS[ns];
    if (!action) return;
    const s = ctx.state.s;
    if (!NO_LOGIN_NEEDED.has(ns) && !s.client) return ui.html(s.id, note('error', 'Please sign in first.'), mainMenu(s));
    return action(ctx, s, args);
});

function shutdown(signal) {
    log.info(`${signal} received — flushing state`);
    for (const store of Object.values(stores)) store.flush();
    bot.stop(signal);
    process.exit(0);
}

async function main() {
    setInterval(async () => {
        if (!forceJoinIds().length) return;
        for (const s of sessions.values()) {
            if (!s.forceJoinBlocked && !isAdmin(s.id)) await enforceForceJoin(s);
        }
    }, 3000).unref();
    setInterval(pollManualBets, 4000).unref();
    await pollTrx();
    let summaryDay = trxDay();
    setInterval(async () => {
        const today = trxDay();
        if (today === summaryDay) return;
        summaryDay = today;
        const yesterday = summaryDateKey(Date.now() - 86_400_000);
        const users = [...sessions.values()].filter((x) => !bannedIds.has(x.id) && stores.dailySummaries.data.users?.[String(x.id)]?.[yesterday]);
        for (const s of users) {
            if (s.dailySummaryDay === today || bannedIds.has(s.id)) continue;
            s.dailySummaryDay = today;
            await ui.html(s.id, summaryText(s, yesterday), summaryNav(yesterday)).catch(() => { });
        }
        if (users.length) await notifyAdminArticle({ icon: 'chart', title: 'Daily Summary cycle completed', rows: [['Users notified', users.length]] });
    }, 30_000).unref();
    const pollIntervals = {
        TRX: 10_000,
        WINGO_30S: 8_000,
        WINGO: 15_000,
        WINGO_3MIN: 30_000,
        WINGO_5MIN: 45_000,
    };
    const gameIsActive = (game, platformKey = null) => [...sessions.values()].some((s) =>
        s.client && !bannedIds.has(s.id) &&
        (s.cfg.game === game || s.manual?.live?.game === game) &&
        (game === 'TRX' || s.cfg.platform === platformKey || s.manual?.live?.platformKey === platformKey));
    for (const game of Object.keys(GAMES)) {
        if (game === 'TRX') {
            setInterval(() => { if (gameIsActive(game)) void pollLiveGame(game); }, pollIntervals[game] || 15_000).unref();
            continue;
        }
        for (const platformKey of Object.keys(PLATFORMS)) {
            setInterval(() => {
                if (gameIsActive(game, platformKey)) void pollLiveGame(game, platformKey);
            }, pollIntervals[game] || 15_000).unref();
        }
    }
    process.on('uncaughtException', (err) => log.error(`uncaught: ${err.stack || err.message}`));
    process.on('unhandledRejection', (reason) => log.error(`unhandled rejection: ${reason?.stack || reason}`));
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    await bot.launch(() => {
        log.info(`Bot online · rich messages ${richEnabled ? 'enabled' : 'disabled'} · ${Object.keys(stores.emoji.data).length} custom emoji IDs`);
        void notifyAdminArticle({ icon: 'start', title: 'Bot launched', rows: [['Status', 'Online']] });
    });
}

main().catch((err) => { log.error(`fatal: ${err.stack || err.message}`); process.exit(1); });
