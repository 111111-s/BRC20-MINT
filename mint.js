#!/usr/bin/env node
/**
 * mint.js — Auto-mint MBC-20 tokens
 *
 * Runs an infinite loop, checking every 60s which bots are ready to mint.
 * Each bot mints independently based on its own cooldown timer (2h 5m).
 *
 * Usage: node mint.js
 */

const {
  WALLET, MBC20_SUBMOLT, OPENAI_API_KEY, OPENAI_MODEL, MINT_PAYLOAD,
  SEP, SEP2, log, logBlock, logResult,
  readBots, readProxies, loadStatus, saveStatus, initBotStatus,
  createPost, verifyPost, checkClaimStatus
} = require("./shared");

const MINT_COOLDOWN_MS  = (2 * 60 + 5) * 60 * 1000; // 2h 5m
const CHECK_INTERVAL_MS = 60 * 1000;                  // 60s

function getTimeUntilMint(botStatus) {
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
    if (mintResp.json?.post?.id)  log(bot.name, `Post ID: ${mintResp.json.post.id}`);
    if (mintResp.json?.post?.url) log(bot.name, `URL: https://www.moltbook.com${mintResp.json.post.url}`);

    if (mintResp.json?.verification_required) {
      const v = mintResp.json.verification;
      log(bot.name, `Verification required! Expires: ${v.expires_at}`);
      const vResp = await verifyPost(bot.apiKey, v.code, v.challenge, proxyIdx, `${bot.name}/VERIFY`);
      if (vResp?.json?.success) {
        logResult(bot.name, true, "Mint verified and published!");
        if (vResp.json.content_id) log(bot.name, `URL: https://www.moltbook.com/post/${vResp.json.content_id}`);
      }
    }

    status[bot.name].last_mint_attempt = now;
    status[bot.name].last_post_result  = "mint_ok";
  } else if (mintResp.statusCode === 429) {
    const retryMin = mintResp.json?.retry_after_minutes || Math.ceil((mintResp.json?.retry_after_seconds || 1800) / 60);
    logResult(bot.name, false, `Rate limited \u2014 retry in ${retryMin} min`);
    status[bot.name].last_post_result  = `mint_rate_limit: ${retryMin}min`;
    status[bot.name].last_mint_attempt = new Date(Date.now() - MINT_COOLDOWN_MS + retryMin * 60 * 1000).toISOString();
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
      waitingBots.push({ name: bots[i].name, mins: Math.ceil(remaining / 60000) });
    }
  }

  if (readyBots.length === 0 && waitingBots.length > 0) {
    const nearest = Math.min(...waitingBots.map(w => w.mins));
    process.stdout.write(`\r[${new Date().toISOString().replace("T", " ").slice(0, 19)}] Waiting... ${waitingBots.length} cooling down (nearest: ~${nearest} min)   `);
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
    log("CYCLE", "Done. Checking again in 60s.");
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
  log("START", `Cooldown: ${MINT_COOLDOWN_MS / 60000} min | Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  log("START", `ChatGPT: ${OPENAI_API_KEY ? `ON (${OPENAI_MODEL})` : "OFF"}`);
  console.log(SEP);

  const status = loadStatus();
  for (const bot of bots) {
    initBotStatus(status, bot.name);
    const remaining = getTimeUntilMint(status[bot.name]);
    log("INIT", `${bot.name} \u2014 ${remaining === 0 ? "READY" : `~${Math.ceil(remaining / 60000)} min`}`);
  }
  console.log(SEP);

  await checkLoop();
  setInterval(async () => { try { await checkLoop(); } catch (e) { log("ERR", e?.message || e); } }, CHECK_INTERVAL_MS);
}

process.on("unhandledRejection", (err) => { log("UNHANDLED_REJECTION", err?.stack || err?.message || err); });
process.on("uncaughtException",  (err) => { log("UNCAUGHT_EXCEPTION", err?.stack || err?.message || err); process.exit(1); });

main().catch(e => { log("FATAL", e?.stack || e?.message || e); process.exit(1); });
