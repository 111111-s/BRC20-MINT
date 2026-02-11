#!/usr/bin/env node
/**
 * indexmint.js — Index all bot mints on mbc20.xyz
 *
 * Strategy:
 *   1. Try index-agent?name=BOT_NAME first
 *   2. If "Agent not found" → fallback to index-post?id=POST_ID for each saved post
 *
 * Post IDs are saved in data/status.json by mint.js after each successful mint.
 *
 * Usage: node indexmint.js
 */

const {
  SEP, SEP2, log, logBlock, logResult,
  readBots, readProxies, parseProxy, loadStatus, saveStatus, initBotStatus,
  httpRequest
} = require("./shared");

const INDEX_AGENT_URL = "https://mbc20.xyz/api/index-agent";
const INDEX_POST_URL  = "https://mbc20.xyz/api/index-post";

function getProxyByIndex(proxies, idx) {
  if (!proxies || proxies.length === 0) return null;
  return parseProxy(proxies[idx % proxies.length]);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const HEADERS = {
  "accept": "*/*",
  "accept-language": "en-US,en;q=0.9",
  "origin": "https://mbc20.xyz",
  "referer": "https://mbc20.xyz/",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
};

/**
 * Try to index via index-agent endpoint.
 * Returns: { ok: true, indexed, skipped, mbc20Posts } on success
 *          { ok: false, notFound: true }  if agent not found (after retries)
 *          { ok: false, error: "..." }    on other error
 */
async function tryIndexAgent(botName, proxies, baseIdx) {
  const url = `${INDEX_AGENT_URL}?name=${encodeURIComponent(botName)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const proxyUrl = getProxyByIndex(proxies, baseIdx + attempt);
    try {
      const resp = await httpRequest({
        url, method: "GET", headers: HEADERS, proxyUrl, timeout: 30000
      });

      if (resp.json?.success) {
        return { ok: true, ...resp.json };
      }

      const errMsg = resp.json?.error || `HTTP ${resp.statusCode}`;
      if (errMsg.toLowerCase().includes("not found")) {
        if (attempt < 2) {
          log(botName, `\u26A0 ${errMsg}, retry with different proxy (${attempt + 1}/3)...`);
          await sleep(1000);
          continue;
        }
        return { ok: false, notFound: true };
      }
      // Other API error — don't retry
      return { ok: false, error: errMsg };
    } catch (e) {
      if (attempt < 2) {
        log(botName, `\u26A0 ${e.message}, retry with new proxy (${attempt + 1}/3)...`);
        await sleep(1000);
      } else {
        return { ok: false, error: e.message };
      }
    }
  }
  return { ok: false, error: "max retries" };
}

/**
 * Fallback: index individual posts via index-post?id=POST_ID
 * Returns number of successfully indexed posts
 */
async function indexByPostIds(botName, postIds, proxies, baseIdx) {
  let indexedCount = 0;

  for (let p = 0; p < postIds.length; p++) {
    const postId = postIds[p];
    const url = `${INDEX_POST_URL}?id=${encodeURIComponent(postId)}`;
    const proxyUrl = getProxyByIndex(proxies, baseIdx + p);

    try {
      const resp = await httpRequest({
        url, method: "GET", headers: HEADERS, proxyUrl, timeout: 30000
      });

      if (resp.json?.success) {
        indexedCount++;
      } else {
        log(botName, `  Post ${postId.slice(0, 8)}... failed: ${resp.json?.error || resp.statusCode}`);
      }
    } catch (e) {
      log(botName, `  Post ${postId.slice(0, 8)}... error: ${e.message}`);
    }

    if (p < postIds.length - 1) await sleep(100);
  }

  return indexedCount;
}

async function main() {
  const bots    = readBots();
  const proxies = readProxies();
  const status  = loadStatus();

  console.log(SEP);
  log("INDEX", "MOLT \u2014 Index Mints on mbc20.xyz");
  log("INDEX", `Bots: ${bots.length} | Proxies: ${proxies.length}`);
  log("INDEX", `Strategy: index-agent first \u2192 fallback to index-post by ID`);
  console.log(SEP);

  if (bots.length === 0) {
    logResult("INDEX", false, "No bots found in data/accs.txt");
    process.exit(1);
  }

  let agentIndexed = 0;
  let postIndexed  = 0;
  let alreadyDone  = 0;
  let noPosts      = 0;
  let errors       = 0;

  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    const tag = bot.name;
    initBotStatus(status, bot.name);
    const savedPosts = status[bot.name].post_ids || [];

    // Step 1: Try index-agent
    const result = await tryIndexAgent(bot.name, proxies, i);

    if (result.ok) {
      const { indexed, skipped, mbc20Posts } = result;
      if (indexed > 0) {
        logResult(tag, true, `Indexed ${indexed} new post(s) (mbc20: ${mbc20Posts}, skipped: ${skipped})`);
        agentIndexed += indexed;
      } else if (skipped > 0) {
        logResult(tag, true, `Already indexed (${skipped} post(s), mbc20: ${mbc20Posts})`);
        alreadyDone++;
      } else if (mbc20Posts === 0) {
        // No posts via agent — try by post ID if we have any
        if (savedPosts.length > 0) {
          log(tag, `No MBC-20 posts via agent, trying ${savedPosts.length} saved post ID(s)...`);
          const cnt = await indexByPostIds(bot.name, savedPosts, proxies, i);
          if (cnt > 0) {
            logResult(tag, true, `Indexed ${cnt} post(s) via post ID fallback`);
            postIndexed += cnt;
          } else {
            noPosts++;
          }
        } else {
          noPosts++;
        }
      }
    } else if (result.notFound) {
      // Step 2: Agent not found — fallback to index-post by saved IDs
      if (savedPosts.length > 0) {
        log(tag, `Agent not found \u2192 indexing ${savedPosts.length} post(s) by ID...`);
        const cnt = await indexByPostIds(bot.name, savedPosts, proxies, i);
        if (cnt > 0) {
          logResult(tag, true, `Indexed ${cnt}/${savedPosts.length} post(s) via post ID`);
          postIndexed += cnt;
        } else {
          logResult(tag, false, `Agent not found, post ID indexing also failed`);
          errors++;
        }
      } else {
        logResult(tag, false, `Agent not found on Moltbook (no saved post IDs)`);
        errors++;
      }
    } else {
      logResult(tag, false, result.error);
      errors++;
    }

    if (i < bots.length - 1) await sleep(200);
  }

  // Summary
  console.log(SEP);
  log("INDEX", "Done!");
  log("INDEX", `Via agent: ${agentIndexed} | Via post ID: ${postIndexed} | Already indexed: ${alreadyDone} | No posts: ${noPosts} | Errors: ${errors}`);
  console.log(SEP);
}

main().catch(e => { log("FATAL", e?.message || e); process.exit(1); });
