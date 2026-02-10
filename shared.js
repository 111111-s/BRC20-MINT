#!/usr/bin/env node
/**
 * shared.js — Common utilities for all MOLT scripts
 *
 * Provides:
 *   - Configuration loading (data/config.json)
 *   - File readers (accounts, proxies, twitter tokens, emails)
 *   - HTTP client with proxy support
 *   - Moltbook API helpers (status check, post creation, verification)
 *   - Challenge solver via OpenAI (ChatGPT)
 *   - Logging utilities
 *
 * Used by: mint.js, link.js, reg.js, transfer.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { HttpsProxyAgent } = require("https-proxy-agent");

// ─── Paths ───────────────────────────────────────────────────────────────────

const DATA_DIR      = path.resolve(__dirname, "data");
const ACCS_FILE     = path.resolve(DATA_DIR, "accs.txt");
const PROXY_FILE    = path.resolve(DATA_DIR, "proxy.txt");
const STATUS_FILE   = path.resolve(DATA_DIR, "status.json");
const TWITTER_FILE  = path.resolve(DATA_DIR, "twitter.txt");
const EMAIL_FILE    = path.resolve(DATA_DIR, "email.txt");
const DEAD_TWITTER_FILE = path.resolve(DATA_DIR, "dead_twitter.txt");
const CONFIG_FILE   = path.resolve(DATA_DIR, "config.json");

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const defaults = {
    wallet: "",
    openai_api_key: "",
    openai_model: "gpt-4o-mini",
    mint_tick: "CLAW",
    mint_amt: "100",
    reg_threads: 1
  };

  if (!fs.existsSync(CONFIG_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2), "utf8");
    return defaults;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

const CONFIG = loadConfig();

const WALLET        = CONFIG.wallet || process.env.WALLET || "";
const OPENAI_API_KEY = CONFIG.openai_api_key || process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL  = CONFIG.openai_model || process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!WALLET)        console.warn("[WARN] wallet is empty in data/config.json");
if (!OPENAI_API_KEY) console.warn("[WARN] openai_api_key is empty in data/config.json — challenge solving will fail");

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_HOST = "www.moltbook.com";
const MBC20_SUBMOLT = "mbc-20";

const MINT_PAYLOAD = {
  p: "mbc-20",
  op: "mint",
  tick: CONFIG.mint_tick || "CLAW",
  amt: CONFIG.mint_amt || "100"
};

const LINK_PAYLOAD = {
  p: "mbc-20",
  op: "link",
  wallet: WALLET
};

// ─── Logging ─────────────────────────────────────────────────────────────────

const SEP  = "\u2550".repeat(70);
const SEP2 = "\u2500".repeat(70);

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(tag, msg) {
  console.log(`[${ts()}] [${tag}] ${msg}`);
}

function logBlock(tag, title) {
  console.log(`\n${SEP}`);
  log(tag, title);
  console.log(SEP2);
}

function logResult(tag, success, msg) {
  log(tag, `${success ? "\u2705" : "\u274C"} ${msg}`);
}

// ─── File readers ────────────────────────────────────────────────────────────

/** Read bot accounts from data/accs.txt (format: Name:APIKey[:ClaimURL]) */
function readBots() {
  if (!fs.existsSync(ACCS_FILE)) return [];
  return fs.readFileSync(ACCS_FILE, "utf8")
    .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
    .map(l => {
      const parts = l.split(":");
      if (parts.length >= 2) {
        return { name: parts[0], apiKey: parts[1], claimUrl: parts.slice(2).join(":") || null };
      }
      return null;
    }).filter(Boolean);
}

/** Read proxies from data/proxy.txt (one per line) */
function readProxies() {
  if (!fs.existsSync(PROXY_FILE)) return [];
  return fs.readFileSync(PROXY_FILE, "utf8")
    .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
}

/** Read Twitter tokens from data/twitter.txt (format: AUTH_TOKEN:CT0[:2FA]) */
function readTwitterTokens() {
  if (!fs.existsSync(TWITTER_FILE)) return [];
  return fs.readFileSync(TWITTER_FILE, "utf8")
    .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
    .map(l => {
      const parts = l.split(":");
      if (parts.length >= 2) {
        return { auth_token: parts[0], ct0: parts[1], twofa: parts[2] || null };
      }
      return null;
    }).filter(Boolean);
}

/** Read email credentials from data/email.txt (format: EMAIL:PASSWORD[:IMAP_HOST]) */
function readEmails() {
  if (!fs.existsSync(EMAIL_FILE)) return [];
  return fs.readFileSync(EMAIL_FILE, "utf8")
    .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
    .map(l => {
      const parts = l.split(":");
      if (parts.length >= 2) {
        return { email: parts[0], password: parts[1], imap_host: parts[2] || null };
      }
      return null;
    }).filter(Boolean);
}

/**
 * Parse proxy string into a URL.
 * Supports: http://user:pass@host:port, host:port:user:pass, host:port
 */
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  const trimmed = proxyStr.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;

  const parts = trimmed.split(":");
  if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
  return `http://${trimmed}`;
}

// ─── Status management ───────────────────────────────────────────────────────

function loadStatus() {
  if (!fs.existsSync(STATUS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); } catch { return {}; }
}

function saveStatus(status) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), "utf8");
}

function initBotStatus(status, name) {
  if (!status[name]) {
    status[name] = {
      claimed: false,
      wallet_linked: false,
      last_mint_attempt: null,
      last_post_attempt: null,
      last_post_result: null,
      last_status_check: null
    };
  }
}

// ─── HTTP client ─────────────────────────────────────────────────────────────

/**
 * HTTP/HTTPS request with optional proxy and redirect following.
 *
 * @param {object} opts
 * @param {string} opts.url              - Target URL
 * @param {string} [opts.method='GET']   - HTTP method
 * @param {object} [opts.headers]        - Additional headers
 * @param {string} [opts.cookie]         - Cookie header value
 * @param {*}      [opts.body]           - Request body (auto-serialized)
 * @param {string} [opts.contentType]    - Content-Type override
 * @param {string} [opts.proxyUrl]       - Proxy URL
 * @param {boolean}[opts.followRedirects]- Follow 3xx redirects
 * @param {number} [opts.maxRedirects=5] - Max redirect hops
 * @param {number} [opts.timeout=25000]  - Request timeout (ms)
 * @returns {Promise<{statusCode, headers, body, json, cookies, location}>}
 */
function httpRequest(opts) {
  const {
    url, method = "GET", headers = {}, cookie, body,
    contentType, proxyUrl, followRedirects = false, maxRedirects = 5,
    timeout = 25000
  } = opts;

  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const mod = isHttps ? https : http;

  const reqHeaders = { ...headers };
  if (cookie) reqHeaders["cookie"] = cookie;

  let bodyStr = null;
  if (body !== undefined && body !== null) {
    if (contentType === "application/x-www-form-urlencoded") {
      bodyStr = typeof body === "string" ? body : new URLSearchParams(body).toString();
      reqHeaders["content-type"] = "application/x-www-form-urlencoded";
    } else {
      bodyStr = typeof body === "string" ? body : JSON.stringify(body);
      reqHeaders["content-type"] = contentType || "application/json";
    }
    reqHeaders["content-length"] = Buffer.byteLength(bodyStr, "utf8").toString();
  }

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method,
    headers: reqHeaders
  };

  if (proxyUrl && isHttps) {
    options.agent = new HttpsProxyAgent(proxyUrl);
  }

  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const setCookies = res.headers["set-cookie"] || [];
      const location = res.headers["location"] || null;

      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("error", reject);
      res.on("end", () => {
        if (followRedirects && [301, 302, 303, 307, 308].includes(res.statusCode) && location && maxRedirects > 0) {
          const nextUrl = location.startsWith("http") ? location : new URL(location, url).toString();
          const newCookie = mergeCookies(cookie, setCookies);
          return resolve(httpRequest({
            ...opts,
            url: nextUrl,
            method: [301, 302, 303].includes(res.statusCode) ? "GET" : method,
            body: [301, 302, 303].includes(res.statusCode) ? null : body,
            cookie: newCookie,
            followRedirects: true,
            maxRedirects: maxRedirects - 1
          }));
        }

        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data, json, cookies: setCookies, location });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Request timed out (${timeout / 1000}s): ${method} ${url.slice(0, 80)}`));
    });
    if (bodyStr) req.write(bodyStr, "utf8");
    req.end();
  });
}

/** Merge existing cookie string with new Set-Cookie headers */
function mergeCookies(existingCookie, setCookieHeaders) {
  const cookies = {};
  if (existingCookie) {
    existingCookie.split(";").forEach(c => {
      const [k, ...v] = c.trim().split("=");
      if (k) cookies[k.trim()] = v.join("=");
    });
  }
  if (setCookieHeaders && Array.isArray(setCookieHeaders)) {
    for (const header of setCookieHeaders) {
      const [k, ...v] = header.split(";")[0].split("=");
      if (k) cookies[k.trim()] = v.join("=");
    }
  }
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

/**
 * Retry helper. fn receives the attempt index (0-based) so callers can rotate proxies.
 * @param {(attempt: number) => Promise} fn
 */
async function withRetry(fn, { retries = 2, delay = 2000, tag } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt < retries) {
        if (tag) log(tag, `\u26A0 Network error (${err.message}), retry ${attempt + 1}/${retries} with new proxy...`);
        await new Promise(r => setTimeout(r, delay * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
}

/** Pick a proxy from the list, rotating by offset on retry */
let _proxyList = null;
function getProxy(baseIndex, offset = 0) {
  if (baseIndex < 0) return null;
  if (!_proxyList) _proxyList = readProxies();
  if (_proxyList.length === 0) return null;
  return parseProxy(_proxyList[(baseIndex + offset) % _proxyList.length]);
}

// ─── Moltbook API ────────────────────────────────────────────────────────────

/** Check agent claim status */
async function checkClaimStatus(bot, proxyIdx, tag) {
  try {
    const resp = await withRetry((attempt) => httpRequest({
      url: `https://${BASE_HOST}/api/v1/agents/status`,
      method: "GET",
      headers: { "x-api-key": bot.apiKey },
      proxyUrl: getProxy(proxyIdx, attempt)
    }), { retries: 2, tag });
    return resp.json?.status || resp.json?.agent?.status || null;
  } catch {
    return null;
  }
}

/** Create a post on Moltbook */
async function createPost(apiKey, submolt, title, content, proxyIdx, tag) {
  return withRetry((attempt) => httpRequest({
    url: `https://${BASE_HOST}/api/v1/posts`,
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: { submolt, title, content },
    proxyUrl: getProxy(proxyIdx, attempt)
  }), { retries: 2, tag });
}

/** Verify a post (solve challenge via ChatGPT, then submit answer) */
async function verifyPost(apiKey, code, challenge, proxyIdx, tag, maxRetries = 2) {
  if (!OPENAI_API_KEY) {
    log(tag || "VERIFY", "Cannot solve challenge \u2014 OPENAI_API_KEY not set!");
    return null;
  }

  log(tag || "VERIFY", `Solving challenge via ChatGPT (${OPENAI_MODEL})...`);
  log(tag || "VERIFY", `Challenge: ${challenge.slice(0, 80)}...`);
  log(tag || "VERIFY", `Decoded:   ${deobfuscate(challenge).slice(0, 80)}...`);

  try {
    const answer = await solveChallengeWithGPT(challenge, tag);
    log(tag || "VERIFY", `ChatGPT answer: ${answer}`);

    const resp = await withRetry((attempt) => httpRequest({
      url: `https://${BASE_HOST}/api/v1/verify`,
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: { verification_code: code, answer },
      proxyUrl: getProxy(proxyIdx, attempt)
    }), { retries: maxRetries, tag: tag || "VERIFY" });

    log(tag || "VERIFY", `Verify status: ${resp.statusCode}`);
    if (resp.json?.success) {
      logResult(tag || "VERIFY", true, "Verification successful!");
    } else {
      logResult(tag || "VERIFY", false, `Verification failed: ${JSON.stringify(resp.json)}`);
    }
    return resp;
  } catch (e) {
    logResult(tag || "VERIFY", false, `Challenge error: ${e.message}`);
    return null;
  }
}

// ─── Challenge solver (OpenAI) ───────────────────────────────────────────────

function deobfuscate(text) {
  // 1. Remove all decorative/special characters, keep alphanumeric + basic punctuation
  let clean = text.replace(/[^a-zA-Z0-9\s.,?!]/g, " ");
  // 2. Normalize whitespace
  clean = clean.replace(/\s+/g, " ").toLowerCase().trim();
  // 3. Collapse repeated letters: "loooobssterr" → "lobster", "newwtons" → "newtons"
  clean = clean.replace(/([a-z])\1+/g, "$1");
  // 4. Remove filler words (only "um"/"umm" — the actual obfuscation fillers)
  clean = clean.replace(/\b(um+)\b/g, "").replace(/\s+/g, " ").trim();
  return clean;
}

/** Extract and validate answer: must be a number with 2 decimal places */
function parseAnswer(raw) {
  const trimmed = raw.trim();
  // Try exact match: number with 2 decimals
  const exact = trimmed.match(/-?\d+\.\d{2}\b/);
  if (exact) return exact[0];
  // Try any decimal number → format to 2dp
  const decimal = trimmed.match(/-?\d+\.\d+/);
  if (decimal) return parseFloat(decimal[0]).toFixed(2);
  // Try integer → format to 2dp
  const integer = trimmed.match(/-?\d+/);
  if (integer) return parseFloat(integer[0]).toFixed(2);
  return null;
}

const GPT_SYSTEM_PROMPT = [
  "You are a precise math solver. You receive obfuscated text about lobsters that contains a math word problem.",
  "",
  "DECODING: The text has random caps, duplicate letters, and special chars. Examples:",
  "  'LoOoObSsStErR' = 'lobster', 'ThIrTy TwO' = 'thirty two' = 32, 'FoUrTeEn' = 'fourteen' = 14",
  "  'nEwWwToNs' = 'newtons', 'PrEsSuUrE' = 'pressure'",
  "",
  "NUMBER WORDS: one=1, two=2, three=3, four=4, five=5, six=6, seven=7, eight=8, nine=9, ten=10,",
  "  eleven=11, twelve=12, thirteen=13, fourteen=14, fifteen=15, sixteen=16, seventeen=17, eighteen=18, nineteen=19,",
  "  twenty=20, thirty=30, forty=40, fifty=50, sixty=60, seventy=70, eighty=80, ninety=90, hundred=100",
  "  Compounds: 'twenty five' = 25, 'thirty two' = 32, 'forty seven' = 47",
  "",
  "OPERATIONS:",
  "  'total/combined/sum/together' → ADD",
  "  'loses/decreases/less/minus/difference' → SUBTRACT",
  "  'times/multiplied/product' → MULTIPLY",
  "  'divided/split/per/each/equally among' → DIVIDE",
  "  'percent/percentage' → use % formula",
  "",
  "RESPOND with ONLY the final numeric answer, exactly 2 decimal places. Example: 47.00",
  "NO words, NO units, NO explanation. JUST the number."
].join("\n");

async function solveChallengeWithGPT(challenge, tag) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set! Set it in data/config.json.");

  const clean = deobfuscate(challenge);

  // Try up to 2 times if answer format is invalid
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await httpRequest({
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: { "authorization": `Bearer ${OPENAI_API_KEY}` },
      body: {
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: GPT_SYSTEM_PROMPT },
          {
            role: "user",
            content: attempt === 0
              ? `Solve this math problem. Reply with ONLY the number (2 decimal places).\n\nOriginal: ${challenge}\n\nDecoded: ${clean}`
              : `The previous answer was not a valid number. Try again. Solve this math problem and reply with ONLY a number like 47.00\n\nOriginal: ${challenge}\n\nDecoded: ${clean}`
          }
        ],
        max_tokens: 30,
        temperature: attempt * 0.3 // slightly higher temp on retry for variety
      }
    });

    const raw = resp.json?.choices?.[0]?.message?.content;
    if (!raw) throw new Error(`GPT returned no answer: ${JSON.stringify(resp.json || resp.body?.slice(0, 200))}`);

    const answer = parseAnswer(raw);
    if (answer) return answer;

    if (tag) log(tag, `\u26A0 GPT returned invalid format: "${raw.trim()}", retrying...`);
  }

  throw new Error("GPT could not produce a valid numeric answer after 2 attempts");
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  CONFIG, WALLET, MBC20_SUBMOLT, OPENAI_API_KEY, OPENAI_MODEL,
  MINT_PAYLOAD, LINK_PAYLOAD,
  BASE_HOST, DATA_DIR, ACCS_FILE, PROXY_FILE, STATUS_FILE,
  TWITTER_FILE, EMAIL_FILE, DEAD_TWITTER_FILE,

  SEP, SEP2, ts, log, logBlock, logResult,

  readBots, parseProxy, readProxies, readTwitterTokens, readEmails,
  loadStatus, saveStatus, initBotStatus,

  httpRequest, mergeCookies, withRetry, getProxy,

  checkClaimStatus, createPost, verifyPost,
  deobfuscate, solveChallengeWithGPT
};
