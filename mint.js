#!/usr/bin/env node
/**
 * mint.js — Auto-mint MBC-20 tokens
 *
 * Runs an infinite loop, minting every 30 minutes per bot.
 * On 429 (rate limit), records exact retry time from API response
 * so there are no idle gaps — mints resume immediately when ready.
 *
 * Usage: node mint.js
 */

const {
  WALLET, MBC20_SUBMOLT, OPENAI_API_KEY, OPENAI_MODEL, MINT_PAYLOAD,
  SEP, SEP2, log, logBlock, logResult,
  readBots, readProxies, loadStatus, saveStatus, initBotStatus,
  createPost, verifyPost, checkClaimStatus
} = require("./shared");

const MINT_COOLDOWN_MS  = 30 * 60 * 1000; // 30 min default cooldown
const CHECK_INTERVAL_MS = 60 * 1000;      // 60s

function getTimeUntilMint(botStatus) {
  // Use exact next_mint_at if set (from 429 response or after success)
  if (botStatus.next_mint_at) {
    return Math.max(0, new Date(botStatus.next_mint_at).getTime() - Date.now());
  }
  // Fallback to old last_mint_attempt + cooldown
  if (!botStatus.last_mint_attempt) return 0;
  const elapsed = Date.now() - new Date(botStatus.last_mint_attempt).getTime();
  return Math.max(0, MINT_COOLDOWN_MS - elapsed);
}

async function tryMintBot(bot, proxyIdx, status) {
  const now = new Date().toISOString();

  initBotStatus(status, bot.name);

  const remaining = getTimeUntilMint(status[bot.name]);
  if (remaining > 0) return;

  const maskedKey = bot.apiKey.slice(0, 14) + "..." + bot.apiKey.slice(-4);

  logBlock(bot.name, `Minting: ${bot.name}`);
  log(bot.name, `API Key: ${maskedKey}`);
  log(bot.name, `Proxy index: ${proxyIdx}`);

  // Check claim status
  log(bot.name, "Checking claim status...");
  const apiStatus = await checkClaimStatus(bot, proxyIdx, bot.name);
  status[bot.name].last_status_check = now;

  if (!apiStatus) { log(bot.name, "\u274C Could not check status. Skipping."); return; }
  log(bot.name, `Status: ${apiStatus}`);
  status[bot.name].claimed = apiStatus === "claimed";

  if (!status[bot.name].claimed) { log(bot.name, "\u23F3 Bot not claimed yet. Skipping."); return; }

  // Mint
  console.log(SEP2);
  log(bot.name, "Minting tokens...");
  log(bot.name, `Payload: ${JSON.stringify(MINT_PAYLOAD)}`);

  const mintId    = Math.random().toString(36).slice(2, 10);
  const mintTitle = `Minting ${MINT_PAYLOAD.tick} - #${mintId}`;
  const mintContent = JSON.stringify(MINT_PAYLOAD) + "\n\nmbc20.xyz";
  const mintResp  = await createPost(bot.apiKey, MBC20_SUBMOLT, mintTitle, mintContent, proxyIdx, bot.name);

  log(bot.name, `POST status: ${mintResp.statusCode}`);

  if (mintResp.statusCode >= 200 && mintResp.statusCode < 300) {
    logResult(bot.name, true, "Mint post created!");
    const postId = mintResp.json?.post?.id;
    if (postId) log(bot.name, `Post ID: ${postId}`);
    if (mintResp.json?.post?.url) log(bot.name, `URL: https://www.moltbook.com${mintResp.json.post.url}`);

    let verified = false;
    if (mintResp.json?.verification_required) {
      const v = mintResp.json.verification;
      log(bot.name, `Verification required! Expires: ${v.expires_at}`);
      const vResp = await verifyPost(bot.apiKey, v.code, v.challenge, proxyIdx, `${bot.name}/VERIFY`);
      if (vResp?.json?.success) {
        logResult(bot.name, true, "Mint verified and published!");
        verified = true;
        if (vResp.json.content_id) log(bot.name, `URL: https://www.moltbook.com/post/${vResp.json.content_id}`);
      }
    }

    // Save post ID for later indexing on mbc20.xyz
    if (postId && verified) {
      if (!status[bot.name].post_ids) status[bot.name].post_ids = [];
      status[bot.name].post_ids.push(postId);
      log(bot.name, `Saved post ID for indexing (total: ${status[bot.name].post_ids.length})`);
    }

    status[bot.name].last_mint_attempt = now;
    // Use server-provided next mint time if available, else default 30 min
    if (mintResp.json?.next_mint_at) {
      status[bot.name].next_mint_at = mintResp.json.next_mint_at;
    } else {
      status[bot.name].next_mint_at = new Date(Date.now() + MINT_COOLDOWN_MS).toISOString();
    }
    status[bot.name].last_post_result  = "mint_ok";
    log(bot.name, `Next mint at: ${status[bot.name].next_mint_at.replace("T", " ").slice(0, 19)}`);
  } else if (mintResp.statusCode === 429) {
    // Use exact retry time from API response
    const retrySeconds = mintResp.json?.retry_after_seconds
      || (mintResp.json?.retry_after_minutes ? mintResp.json.retry_after_minutes * 60 : null)
      || 1800;
    const retryMin = Math.ceil(retrySeconds / 60);
    const nextMintAt = new Date(Date.now() + retrySeconds * 1000).toISOString();
    logResult(bot.name, false, `Rate limited \u2014 retry in ${retryMin} min`);
    log(bot.name, `Next mint at: ${nextMintAt.replace("T", " ").slice(0, 19)}`);
    status[bot.name].last_post_result  = `mint_rate_limit: ${retryMin}min`;
    status[bot.name].last_mint_attempt = now;
    status[bot.name].next_mint_at = nextMintAt;
  } else {
    logResult(bot.name, false, `Mint failed: HTTP ${mintResp.statusCode}`);
    if (mintResp.json) log(bot.name, `Error: ${JSON.stringify(mintResp.json)}`);
    status[bot.name].last_post_result = `mint_fail: ${mintResp.statusCode}`;
  }
}

async function checkLoop() {
  const bots    = readBots();
  const proxies = readProxies();
  const status  = loadStatus();

  const readyBots   = [];
  const waitingBots = [];

  for (let i = 0; i < bots.length; i++) {
    initBotStatus(status, bots[i].name);
    const remaining = getTimeUntilMint(status[bots[i].name]);
    if (remaining === 0) {
      readyBots.push({ bot: bots[i], proxyIdx: proxies.length > 0 ? i % proxies.length : -1 });
    } else {
      waitingBots.push({ name: bots[i].name, secs: Math.ceil(remaining / 1000), mins: Math.ceil(remaining / 60000) });
    }
  }

  if (readyBots.length === 0 && waitingBots.length > 0) {
    const nearestSec = Math.min(...waitingBots.map(w => w.secs));
    const mm = Math.floor(nearestSec / 60);
    const ss = nearestSec % 60;
    process.stdout.write(`\r[${new Date().toISOString().replace("T", " ").slice(0, 19)}] Waiting... ${waitingBots.length} cooling down (nearest: ${mm}m ${ss}s)   `);
    return;
  }

  if (readyBots.length > 0) {
    console.log(`\n${"█".repeat(70)}`);
    log("CYCLE", `${readyBots.length} bot(s) ready to mint, ${waitingBots.length} cooling down`);
    console.log(`${"█".repeat(70)}`);

    for (const { bot, proxyIdx } of readyBots) {
      try { await tryMintBot(bot, proxyIdx, status); }
      catch (e) { log(bot.name, `\u274C ERROR: ${e?.message || e}`); }
      saveStatus(status); // save after each bot so progress isn't lost on crash
    }

    if (waitingBots.length > 0) {
      console.log(SEP2);
      log("WAIT", "Bots still cooling down:");
      for (const w of waitingBots) log("WAIT", `  ${w.name} \u2014 ~${w.mins} min remaining`);
    }
    console.log(`\n${SEP}`);
    log("CYCLE", `Done. Checking again in ${CHECK_INTERVAL_MS / 1000}s.`);
    console.log(SEP);
  }
}

async function main() {
  const bots    = readBots();
  const proxies = readProxies();

  console.log(SEP);
  log("START", "MOLT \u2014 Auto Mint");
  log("START", `Bots: ${bots.length} | Proxies: ${proxies.length}`);
  log("START", `Wallet: ${WALLET || "(not set)"}`);
  log("START", `Default cooldown: ${MINT_COOLDOWN_MS / 60000} min`);
  log("START", `ChatGPT: ${OPENAI_API_KEY ? `ON (${OPENAI_MODEL})` : "OFF"}`);
  console.log(SEP);

  const status = loadStatus();
  for (const bot of bots) {
    initBotStatus(status, bot.name);
    const remaining = getTimeUntilMint(status[bot.name]);
    if (remaining === 0) {
      log("INIT", `${bot.name} \u2014 READY`);
    } else {
      const nextAt = status[bot.name].next_mint_at
        ? new Date(status[bot.name].next_mint_at).toISOString().replace("T", " ").slice(0, 19)
        : "~" + Math.ceil(remaining / 60000) + " min";
      log("INIT", `${bot.name} \u2014 next at ${nextAt}`);
    }
  }
  console.log(SEP);

  // Smart loop: run immediately, then sleep until nearest bot is ready (or max 60s)
  while (true) {
    try {
      await checkLoop();
    } catch (e) {
      log("ERR", e?.message || e);
    }

    // Calculate sleep time: wait until nearest bot is ready, min 10s, max 60s
    const st = loadStatus();
    let nearestMs = CHECK_INTERVAL_MS; // default 60s
    for (const bot of readBots()) {
      initBotStatus(st, bot.name);
      const rem = getTimeUntilMint(st[bot.name]);
      if (rem > 0 && rem < nearestMs) nearestMs = rem;
      if (rem === 0) { nearestMs = 10000; break; } // someone is ready, check quickly
    }
    const sleepMs = Math.max(10000, Math.min(nearestMs, CHECK_INTERVAL_MS));
    await new Promise(r => setTimeout(r, sleepMs));
  }
}

process.on("unhandledRejection", (err) => { log("UNHANDLED_REJECTION", err?.stack || err?.message || err); });
process.on("uncaughtException",  (err) => { log("UNCAUGHT_EXCEPTION", err?.stack || err?.message || err); process.exit(1); });

main().catch(e => { log("FATAL", e?.stack || e?.message || e); process.exit(1); });
