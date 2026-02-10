#!/usr/bin/env node
/**
 * link.js — Link wallet to all claimed bots (run once)
 *
 * For each bot in data/accs.txt:
 *   1. Checks claim status
 *   2. Posts link inscription: {"p":"mbc-20","op":"link","wallet":"0x..."}
 *   3. Solves verification challenge via ChatGPT
 *   4. Saves wallet_linked=true in status.json
 *
 * Usage: node link.js
 */

const {
  WALLET, MBC20_SUBMOLT, OPENAI_API_KEY, OPENAI_MODEL, LINK_PAYLOAD,
  SEP, SEP2, log, logBlock, logResult,
  readBots, readProxies, loadStatus, saveStatus, initBotStatus,
  createPost, verifyPost, checkClaimStatus
} = require("./shared");

async function linkBot(bot, proxyIdx, status) {
  const maskedKey = bot.apiKey.slice(0, 14) + "..." + bot.apiKey.slice(-4);

  logBlock(bot.name, `Linking wallet: ${bot.name}`);
  log(bot.name, `API Key: ${maskedKey}`);
  log(bot.name, `Proxy index: ${proxyIdx}`);
  log(bot.name, `Wallet: ${WALLET}`);

  initBotStatus(status, bot.name);

  if (status[bot.name].wallet_linked) {
    log(bot.name, "\u2705 Already linked! Skipping.");
    return;
  }

  log(bot.name, "Checking claim status...");
  const apiStatus = await checkClaimStatus(bot, proxyIdx);
  status[bot.name].last_status_check = new Date().toISOString();

  if (!apiStatus) { log(bot.name, "\u274C Could not check status. Skipping."); return; }
  log(bot.name, `Status: ${apiStatus}`);
  status[bot.name].claimed = apiStatus === "claimed";

  if (!status[bot.name].claimed) { log(bot.name, "\u23F3 Bot not claimed yet. Skipping."); return; }

  // Post link inscription
  console.log(SEP2);
  log(bot.name, "Posting link inscription...");
  log(bot.name, `Payload: ${JSON.stringify(LINK_PAYLOAD)}`);

  const linkId    = Math.random().toString(36).slice(2, 10);
  const linkTitle = `Linking wallet - #${linkId}`;
  const linkResp  = await createPost(bot.apiKey, MBC20_SUBMOLT, linkTitle, JSON.stringify(LINK_PAYLOAD), proxyIdx);
  status[bot.name].last_post_attempt = new Date().toISOString();

  log(bot.name, `POST status: ${linkResp.statusCode}`);

  if (linkResp.statusCode >= 200 && linkResp.statusCode < 300) {
    logResult(bot.name, true, "Link post created!");
    if (linkResp.json?.post?.id)  log(bot.name, `Post ID: ${linkResp.json.post.id}`);
    if (linkResp.json?.post?.url) log(bot.name, `URL: https://www.moltbook.com${linkResp.json.post.url}`);

    if (linkResp.json?.verification_required) {
      const v = linkResp.json.verification;
      log(bot.name, `Verification required! Expires: ${v.expires_at}`);
      const vResp = await verifyPost(bot.apiKey, v.code, v.challenge, proxyIdx, `${bot.name}/VERIFY`);
      if (vResp?.json?.success) {
        logResult(bot.name, true, "Link verified and published!");
        if (vResp.json.content_id) log(bot.name, `URL: https://www.moltbook.com/post/${vResp.json.content_id}`);
      }
    }

    status[bot.name].wallet_linked   = true;
    status[bot.name].last_post_result = "link_ok";
    logResult(bot.name, true, "Wallet linked!");
  } else if (linkResp.statusCode === 429) {
    const retryMin = linkResp.json?.retry_after_minutes || Math.ceil((linkResp.json?.retry_after_seconds || 1800) / 60);
    logResult(bot.name, false, `Rate limited \u2014 retry in ${retryMin} min`);
    status[bot.name].last_post_result = `link_rate_limit: ${retryMin}min`;
  } else {
    logResult(bot.name, false, `Link failed: HTTP ${linkResp.statusCode}`);
    if (linkResp.json) log(bot.name, `Error: ${JSON.stringify(linkResp.json)}`);
    status[bot.name].last_post_result = `link_fail: ${linkResp.statusCode}`;
  }
}

async function main() {
  const bots    = readBots();
  const proxies = readProxies();
  const status  = loadStatus();

  console.log(SEP);
  log("LINK", "MOLT \u2014 Link Wallet");
  log("LINK", `Bots: ${bots.length} | Proxies: ${proxies.length}`);
  log("LINK", `Wallet: ${WALLET || "(not set)"}`);
  log("LINK", `ChatGPT: ${OPENAI_API_KEY ? `ON (${OPENAI_MODEL})` : "OFF"}`);
  console.log(SEP);

  for (let i = 0; i < bots.length; i++) {
    const proxyIdx = proxies.length > 0 ? i % proxies.length : -1;
    try { await linkBot(bots[i], proxyIdx, status); }
    catch (e) { log(bots[i].name, `\u274C ERROR: ${e?.message || e}`); }
  }

  saveStatus(status);
  console.log(`\n${SEP}`);
  log("LINK", "Done!");

  const linked = Object.values(status).filter(s => s.wallet_linked).length;
  const total  = Object.keys(status).length;
  log("LINK", `Wallets linked: ${linked}/${total}`);
  console.log(SEP);
}

main().catch(e => { log("FATAL", e?.message || e); process.exit(1); });
