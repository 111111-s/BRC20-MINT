#!/usr/bin/env node
/**
 * Moltbook — Auto Mint (individual timers per bot)
 * Usage: node index.js
 * 
 * Checks every 60 seconds which bots are ready to mint.
 * Each bot mints independently based on its own last_mint_attempt from status.json.
 * No more waiting 125 min for all bots — each mints as soon as its cooldown expires.
 */

const {
  WALLET, MBC20_SUBMOLT, OPENAI_API_KEY, OPENAI_MODEL, MINT_PAYLOAD,
  SEP, SEP2, log, logBlock, logResult,
  readBots, parseProxy, readProxies, loadStatus, saveStatus, initBotStatus,
  createPost, verifyPost, checkClaimStatus
} = require("./shared");

// Mint cooldown per bot: 2 hours 5 minutes
const MINT_COOLDOWN_MS = (2 * 60 + 5) * 60 * 1000;
// Check loop interval: every 60 seconds
const CHECK_INTERVAL_MS = 60 * 1000;

function getTimeUntilMint(botStatus) {
  if (!botStatus.last_mint_attempt) return 0; // never minted — mint now
  const elapsed = Date.now() - new Date(botStatus.last_mint_attempt).getTime();
  return Math.max(0, MINT_COOLDOWN_MS - elapsed);
}

async function tryMintBot(bot, proxyStr, status) {
  const proxy = parseProxy(proxyStr);
  const now = new Date().toISOString();

  initBotStatus(status, bot.name);

  const remaining = getTimeUntilMint(status[bot.name]);
  if (remaining > 0) return; // not ready yet

  const maskedKey = bot.apiKey.slice(0, 14) + "..." + bot.apiKey.slice(-4);
  const maskedProxy = proxy ? proxy.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@") : "direct";

  logBlock(bot.name, `Minting: ${bot.name}`);
  log(bot.name, `API Key: ${maskedKey}`);
  log(bot.name, `Proxy: ${maskedProxy}`);

  // Check claim
  log(bot.name, `Checking claim status...`);
  const apiStatus = await checkClaimStatus(bot, proxy);
  status[bot.name].last_status_check = now;

  if (!apiStatus) {
    log(bot.name, `❌ Could not check status. Skipping.`);
    return;
  }

  log(bot.name, `Status: ${apiStatus}`);
  status[bot.name].claimed = apiStatus === "claimed";

  if (!status[bot.name].claimed) {
    log(bot.name, `⏳ Bot not claimed yet. Skipping.`);
    return;
  }

  // Mint
  console.log(SEP2);
  log(bot.name, `Minting tokens...`);
  log(bot.name, `Payload: ${JSON.stringify(MINT_PAYLOAD)}`);

  const mintId = Math.random().toString(36).slice(2, 10);
  const mintTitle = `Minting ${MINT_PAYLOAD.tick} - #${mintId}`;
  const mintResp = await createPost(bot.apiKey, MBC20_SUBMOLT, mintTitle, JSON.stringify(MINT_PAYLOAD), proxy);

  log(bot.name, `MINT POST status: ${mintResp.statusCode}`);

  if (mintResp.statusCode >= 200 && mintResp.statusCode < 300) {
    logResult(bot.name, true, `Mint post created!`);
    if (mintResp.json?.post?.id) log(bot.name, `Post ID: ${mintResp.json.post.id}`);
    if (mintResp.json?.post?.url) log(bot.name, `URL: https://www.moltbook.com${mintResp.json.post.url}`);

    // Verify if needed
    if (mintResp.json?.verification_required) {
      const v = mintResp.json.verification;
      log(bot.name, `Verification required! Expires: ${v.expires_at}`);
      const vResp = await verifyPost(bot.apiKey, v.code, v.challenge, proxy, `${bot.name}/MINT-VERIFY`);
      if (vResp && vResp.json?.success) {
        logResult(bot.name, true, `Mint post verified and published!`);
        if (vResp.json.content_id) {
          log(bot.name, `Published URL: https://www.moltbook.com/post/${vResp.json.content_id}`);
        }
      }
    }

    status[bot.name].last_mint_attempt = now;
    status[bot.name].last_post_result = "mint_ok";
  } else if (mintResp.statusCode === 429) {
    const retryMin = mintResp.json?.retry_after_minutes || Math.ceil((mintResp.json?.retry_after_seconds || 1800) / 60);
    logResult(bot.name, false, `Mint rate limited — retry in ${retryMin} min`);
    if (mintResp.json?.hint) log(bot.name, `Hint: ${mintResp.json.hint}`);
    status[bot.name].last_post_result = `mint_rate_limit: ${retryMin}min`;
    // Set last_mint_attempt so we don't spam retries, but use shorter cooldown
    status[bot.name].last_mint_attempt = new Date(Date.now() - MINT_COOLDOWN_MS + retryMin * 60 * 1000).toISOString();
  } else {
    logResult(bot.name, false, `Mint failed: HTTP ${mintResp.statusCode}`);
    if (mintResp.json) log(bot.name, `Error: ${JSON.stringify(mintResp.json)}`);
    status[bot.name].last_post_result = `mint_fail: ${mintResp.statusCode}`;
  }
}

async function checkLoop() {
  const bots = readBots();
  const proxies = readProxies();
  const status = loadStatus();

  // Find bots that are ready to mint
  const readyBots = [];
  const waitingBots = [];

  for (let i = 0; i < bots.length; i++) {
    initBotStatus(status, bots[i].name);
    const remaining = getTimeUntilMint(status[bots[i].name]);
    if (remaining === 0) {
      readyBots.push({ bot: bots[i], proxyStr: proxies.length > 0 ? proxies[i % proxies.length] : null });
    } else {
      waitingBots.push({ name: bots[i].name, mins: Math.ceil(remaining / 60000) });
    }
  }

  if (readyBots.length === 0 && waitingBots.length > 0) {
    // Quiet tick — just show countdown
    const nearest = Math.min(...waitingBots.map(w => w.mins));
    process.stdout.write(`\r[${new Date().toISOString().replace("T", " ").slice(0, 19)}] Waiting... ${readyBots.length} ready, ${waitingBots.length} cooling down (nearest: ~${nearest} min)   `);
    return;
  }

  if (readyBots.length > 0) {
    console.log(`\n${"█".repeat(70)}`);
    log("CYCLE", `${readyBots.length} bot(s) ready to mint, ${waitingBots.length} cooling down`);
    console.log(`${"█".repeat(70)}`);

    for (const { bot, proxyStr } of readyBots) {
      try {
        await tryMintBot(bot, proxyStr, status);
      } catch (e) {
        log(bot.name, `❌ ERROR: ${e?.message || e}`);
      }
    }

    // Show waiting bots
    if (waitingBots.length > 0) {
      console.log(SEP2);
      log("WAIT", `Bots still cooling down:`);
      for (const w of waitingBots) {
        log("WAIT", `  ${w.name} — ~${w.mins} min remaining`);
      }
    }

    saveStatus(status);
    console.log(`\n${SEP}`);
    log("CYCLE", `Done. Checking again in 60s.`);
    console.log(SEP);
  }
}

async function main() {
  const bots = readBots();
  const proxies = readProxies();

  console.log(SEP);
  log("START", `Moltbook — Auto Mint (individual timers)`);
  log("START", `Bots: ${bots.length}`);
  log("START", `Proxies: ${proxies.length}`);
  log("START", `Wallet: ${WALLET}`);
  log("START", `Mint cooldown: ${MINT_COOLDOWN_MS / 60000} min per bot`);
  log("START", `Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  log("START", `ChatGPT: ${OPENAI_API_KEY ? `ON (${OPENAI_MODEL})` : "OFF — set OPENAI_API_KEY!"}`);
  console.log(SEP);

  // Show initial state
  const status = loadStatus();
  for (let i = 0; i < bots.length; i++) {
    initBotStatus(status, bots[i].name);
    const remaining = getTimeUntilMint(status[bots[i].name]);
    if (remaining === 0) {
      log("INIT", `${bots[i].name} — READY to mint now`);
    } else {
      log("INIT", `${bots[i].name} — mint in ~${Math.ceil(remaining / 60000)} min`);
    }
  }
  console.log(SEP);

  // First check immediately
  await checkLoop();

  // Then check every 60 seconds
  setInterval(async () => {
    try {
      await checkLoop();
    } catch (e) {
      log("ERR", e?.message || e);
    }
  }, CHECK_INTERVAL_MS);
}

main().catch(e => {
  log("FATAL", e?.message || e);
  process.exit(1);
});
