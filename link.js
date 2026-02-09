#!/usr/bin/env node
/**
 * Moltbook — Link wallet to all bots (run once)
 * Usage: node link.js
 * 
 * For each bot in accs.txt:
 *   1. Checks claim status
 *   2. Posts link inscription (wallet binding)
 *   3. Solves verification challenge via ChatGPT
 *   4. Saves wallet_linked=true in status.json
 */

const {
  WALLET, MBC20_SUBMOLT, OPENAI_API_KEY, OPENAI_MODEL, LINK_PAYLOAD,
  SEP, SEP2, log, logBlock, logResult,
  readBots, parseProxy, readProxies, loadStatus, saveStatus, initBotStatus,
  createPost, verifyPost, checkClaimStatus
} = require("./shared");

async function linkBot(bot, proxyStr, status) {
  const proxy = parseProxy(proxyStr);
  const maskedKey = bot.apiKey.slice(0, 14) + "..." + bot.apiKey.slice(-4);
  const maskedProxy = proxy ? proxy.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@") : "direct";

  logBlock(bot.name, `Linking wallet for: ${bot.name}`);
  log(bot.name, `API Key: ${maskedKey}`);
  log(bot.name, `Proxy: ${maskedProxy}`);
  log(bot.name, `Wallet: ${WALLET}`);

  initBotStatus(status, bot.name);

  // Already linked?
  if (status[bot.name].wallet_linked) {
    log(bot.name, `✅ Already linked! Skipping.`);
    return;
  }

  // Check claim
  log(bot.name, `Checking claim status...`);
  const apiStatus = await checkClaimStatus(bot, proxy);
  status[bot.name].last_status_check = new Date().toISOString();

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

  // Post link inscription
  console.log(SEP2);
  log(bot.name, `Posting link inscription...`);
  log(bot.name, `Payload: ${JSON.stringify(LINK_PAYLOAD)}`);

  const linkId = Math.random().toString(36).slice(2, 10);
  const linkTitle = `Linking wallet - #${linkId}`;
  const linkResp = await createPost(bot.apiKey, MBC20_SUBMOLT, linkTitle, JSON.stringify(LINK_PAYLOAD), proxy);
  status[bot.name].last_post_attempt = new Date().toISOString();

  log(bot.name, `POST status: ${linkResp.statusCode}`);

  if (linkResp.statusCode >= 200 && linkResp.statusCode < 300) {
    logResult(bot.name, true, `Link post created!`);
    if (linkResp.json?.post?.id) log(bot.name, `Post ID: ${linkResp.json.post.id}`);
    if (linkResp.json?.post?.url) log(bot.name, `URL: https://www.moltbook.com${linkResp.json.post.url}`);

    // Verify
    if (linkResp.json?.verification_required) {
      const v = linkResp.json.verification;
      log(bot.name, `Verification required! Expires: ${v.expires_at}`);
      const vResp = await verifyPost(bot.apiKey, v.code, v.challenge, proxy, `${bot.name}/VERIFY`);
      if (vResp && vResp.json?.success) {
        logResult(bot.name, true, `Link post verified and published!`);
        if (vResp.json.content_id) {
          log(bot.name, `Published URL: https://www.moltbook.com/post/${vResp.json.content_id}`);
        }
      }
    }

    status[bot.name].wallet_linked = true;
    status[bot.name].last_post_result = "link_ok";
    logResult(bot.name, true, `Wallet linked!`);
  } else if (linkResp.statusCode === 429) {
    const retryMin = linkResp.json?.retry_after_minutes || Math.ceil((linkResp.json?.retry_after_seconds || 1800) / 60);
    logResult(bot.name, false, `Rate limited — retry in ${retryMin} min`);
    if (linkResp.json?.hint) log(bot.name, `Hint: ${linkResp.json.hint}`);
    status[bot.name].last_post_result = `link_rate_limit: ${retryMin}min`;
  } else {
    logResult(bot.name, false, `Link failed: HTTP ${linkResp.statusCode}`);
    if (linkResp.json) log(bot.name, `Error: ${JSON.stringify(linkResp.json)}`);
    status[bot.name].last_post_result = `link_fail: ${linkResp.statusCode}`;
  }
}

async function main() {
  const bots = readBots();
  const proxies = readProxies();
  const status = loadStatus();

  console.log(SEP);
  log("LINK", `Moltbook — Link Wallet`);
  log("LINK", `Bots: ${bots.length}`);
  log("LINK", `Proxies: ${proxies.length}`);
  log("LINK", `Wallet: ${WALLET}`);
  log("LINK", `ChatGPT: ${OPENAI_API_KEY ? `ON (${OPENAI_MODEL})` : "OFF — set OPENAI_API_KEY!"}`);
  console.log(SEP);

  for (let i = 0; i < bots.length; i++) {
    const proxyStr = proxies.length > 0 ? proxies[i % proxies.length] : null;
    try {
      await linkBot(bots[i], proxyStr, status);
    } catch (e) {
      log(bots[i].name, `❌ ERROR: ${e?.message || e}`);
    }
  }

  saveStatus(status);
  console.log(`\n${SEP}`);
  log("LINK", `Done! status.json saved.`);

  // Summary
  const linked = Object.values(status).filter(s => s.wallet_linked).length;
  const total = Object.keys(status).length;
  log("LINK", `Wallets linked: ${linked}/${total}`);
  console.log(SEP);
}

main().catch(e => {
  log("FATAL", e?.message || e);
  process.exit(1);
});
