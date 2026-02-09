#!/usr/bin/env node
/**
 * Moltbook — Shared utilities
 * Used by: mint.js, link.js, reg.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { HttpsProxyAgent } = require("https-proxy-agent");

// ─── Paths ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(__dirname, "data");
const ACCS_FILE = path.resolve(DATA_DIR, "accs.txt");
const PROXY_FILE = path.resolve(DATA_DIR, "proxy.txt");
const STATUS_FILE = path.resolve(DATA_DIR, "status.json");
const TWITTER_FILE = path.resolve(DATA_DIR, "twitter.txt");
const EMAIL_FILE = path.resolve(DATA_DIR, "email.txt");
const DEAD_TWITTER_FILE = path.resolve(DATA_DIR, "dead_twitter.txt");
const CONFIG_FILE = path.resolve(DATA_DIR, "config.json");

// ─── Config ─────────────────────────────────────────────────────────────────

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

const WALLET = CONFIG.wallet || process.env.WALLET || "";
const OPENAI_API_KEY = CONFIG.openai_api_key || process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = CONFIG.openai_model || process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!WALLET) console.warn("[WARN] wallet is empty in data/config.json");
if (!OPENAI_API_KEY) console.warn("[WARN] openai_api_key is empty in data/config.json — challenge solving will fail");

// ─── Constants ──────────────────────────────────────────────────────────────

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

// ─── Logging ────────────────────────────────────────────────────────────────

const SEP = "═".repeat(70);
const SEP2 = "─".repeat(70);

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
  log(tag, `${success ? "✅" : "❌"} ${msg}`);
}

// ─── File readers ───────────────────────────────────────────────────────────

function readBots() {
  if (!fs.existsSync(ACCS_FILE)) return [];
  const lines = fs.readFileSync(ACCS_FILE, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
  return lines.filter(l => !l.startsWith("#")).map(l => {
    const parts = l.split(":");
    if (parts.length >= 2) {
      return {
        name: parts[0],
        apiKey: parts[1],
        claimUrl: parts.slice(2).join(":") || null
      };
    }
    return null;
  }).filter(Boolean);
}

function readProxies() {
  if (!fs.existsSync(PROXY_FILE)) return [];
  return fs.readFileSync(PROXY_FILE, "utf8")
    .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
}

function readTwitterTokens() {
  if (!fs.existsSync(TWITTER_FILE)) return [];
  const lines = fs.readFileSync(TWITTER_FILE, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
  return lines.filter(l => !l.startsWith("#")).map(l => {
    const parts = l.split(":");
    if (parts.length >= 2) {
      return {
        auth_token: parts[0],
        ct0: parts[1],
        twofa: parts[2] || null
      };
    }
    return null;
  }).filter(Boolean);
}

function readEmails() {
  if (!fs.existsSync(EMAIL_FILE)) return [];
  const lines = fs.readFileSync(EMAIL_FILE, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
  return lines.filter(l => !l.startsWith("#")).map(l => {
    const parts = l.split(":");
    if (parts.length >= 2) {
      return {
        email: parts[0],
        password: parts[1],
        imap_host: parts[2] || null
      };
    }
    return null;
  }).filter(Boolean);
}

function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  const trimmed = proxyStr.trim();
  if (!trimmed) return null;

  // Already a URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;

  const parts = trimmed.split(":");
  if (parts.length === 4) {
    // ip:port:user:pass
    return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  }
  if (parts.length === 2) {
    // ip:port
    return `http://${parts[0]}:${parts[1]}`;
  }
  return `http://${trimmed}`;
}

// ─── Status management ──────────────────────────────────────────────────────

function loadStatus() {
  if (!fs.existsSync(STATUS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return {};
  }
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

// ─── HTTP ───────────────────────────────────────────────────────────────────

/**
 * HTTP/HTTPS request with optional proxy and redirect following
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers]
 * @param {string} [opts.cookie]
 * @param {*} [opts.body]
 * @param {string} [opts.contentType]
 * @param {string} [opts.proxyUrl]
 * @param {boolean} [opts.followRedirects=false] - Whether to follow 3xx redirects
 * @param {number} [opts.maxRedirects=5] - Max redirects to follow
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
      // Collect set-cookie headers
      const setCookies = res.headers["set-cookie"] || [];
      const location = res.headers["location"] || null;

      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        // Follow redirects if requested
        if (followRedirects && [301, 302, 303, 307, 308].includes(res.statusCode) && location && maxRedirects > 0) {
          const nextUrl = location.startsWith("http") ? location : new URL(location, url).toString();
          // Merge cookies from redirect
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
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json,
          cookies: setCookies,
          location
        });
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

/**
 * Merge existing cookie string with new Set-Cookie headers
 */
function mergeCookies(existingCookie, setCookieHeaders) {
  const cookies = {};

  // Parse existing
  if (existingCookie) {
    existingCookie.split(";").forEach(c => {
      const [k, ...v] = c.trim().split("=");
      if (k) cookies[k.trim()] = v.join("=");
    });
  }

  // Parse new Set-Cookie headers
  if (setCookieHeaders && Array.isArray(setCookieHeaders)) {
    for (const header of setCookieHeaders) {
      const mainPart = header.split(";")[0];
      const [k, ...v] = mainPart.split("=");
      if (k) cookies[k.trim()] = v.join("=");
    }
  }

  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ─── Moltbook API ───────────────────────────────────────────────────────────

async function checkClaimStatus(bot, proxy) {
  try {
    const resp = await httpRequest({
      url: `https://${BASE_HOST}/api/v1/agents/status`,
      method: "GET",
      headers: { "x-api-key": bot.apiKey },
      proxyUrl: proxy
    });
    if (resp.json) return resp.json.status || resp.json.agent?.status || null;
    return null;
  } catch {
    return null;
  }
}

async function createPost(apiKey, submolt, title, content, proxy) {
  return httpRequest({
    url: `https://${BASE_HOST}/api/v1/posts`,
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: { submolt, title, content },
    proxyUrl: proxy
  });
}

async function verifyPost(apiKey, code, challenge, proxy, tag) {
  if (!OPENAI_API_KEY) {
    log(tag || "VERIFY", "Cannot solve challenge — OPENAI_API_KEY not set!");
    return null;
  }

  log(tag || "VERIFY", `Solving challenge via ChatGPT (${OPENAI_MODEL})...`);
  log(tag || "VERIFY", `Challenge: ${challenge.slice(0, 80)}...`);

  try {
    const answer = await solveChallengeWithGPT(challenge);
    log(tag || "VERIFY", `ChatGPT answer: ${answer}`);

    const resp = await httpRequest({
      url: `https://${BASE_HOST}/api/v1/verify`,
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: { code, answer },
      proxyUrl: proxy
    });

    log(tag || "VERIFY", `Verify status: ${resp.statusCode}`);

    if (resp.json?.success) {
      logResult(tag || "VERIFY", true, `Verification successful!`);
    } else {
      logResult(tag || "VERIFY", false, `Verification failed: ${JSON.stringify(resp.json)}`);
    }

    return resp;
  } catch (e) {
    logResult(tag || "VERIFY", false, `Challenge error: ${e.message}`);
    return null;
  }
}

// ─── Challenge solver (via ChatGPT) ─────────────────────────────────────────

function deobfuscate(text) {
  return text.replace(/[^a-zA-Z0-9\s+=\-.,?!]/g, " ").replace(/\s+/g, " ").toLowerCase().trim();
}

async function solveChallengeWithGPT(challenge) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set! Set it in data/config.json.");

  const clean = deobfuscate(challenge);

  const resp = await httpRequest({
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    headers: { "authorization": `Bearer ${OPENAI_API_KEY}` },
    body: {
      model: OPENAI_MODEL,
      messages: [
        {
          role: "system",
          content: "You solve obfuscated math problems. Reply with ONLY the numeric answer formatted to exactly 2 decimal places (e.g. 30.00). No explanation, no units, no words — just the number."
        },
        {
          role: "user",
          content: `Solve this math problem:\n\nOriginal (obfuscated): ${challenge}\n\nCleaned: ${clean}\n\nReply with ONLY the number (2 decimal places).`
        }
      ],
      max_tokens: 20,
      temperature: 0
    }
  });

  if (resp.json?.choices?.[0]?.message?.content) {
    const answer = resp.json.choices[0].message.content.trim();
    // Extract just the number
    const match = answer.match(/[\d]+\.[\d]+/);
    return match ? match[0] : answer;
  }

  throw new Error(`GPT returned no answer: ${JSON.stringify(resp.json || resp.body?.slice(0, 200))}`);
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Config & constants
  CONFIG, WALLET, MBC20_SUBMOLT, OPENAI_API_KEY, OPENAI_MODEL,
  MINT_PAYLOAD, LINK_PAYLOAD,
  BASE_HOST, DATA_DIR, ACCS_FILE, PROXY_FILE, STATUS_FILE,
  TWITTER_FILE, EMAIL_FILE, DEAD_TWITTER_FILE,

  // Logging
  SEP, SEP2, ts, log, logBlock, logResult,

  // File readers
  readBots, parseProxy, readProxies, readTwitterTokens, readEmails,
  loadStatus, saveStatus, initBotStatus,

  // HTTP
  httpRequest, mergeCookies,

  // Moltbook API
  checkClaimStatus, createPost, verifyPost,

  // Challenge solver
  solveChallengeWithGPT
};
