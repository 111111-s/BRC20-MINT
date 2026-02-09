#!/usr/bin/env node
/**
 * Moltbook — Transfer Tokens
 * Usage: node transfer.js
 *
 * Interactive script that asks:
 *   1. Which bot to send FROM (picks from data/accs.txt)
 *   2. Recipient agent name (TO)
 *   3. Token ticker (default: CLAW)
 *   4. Amount to transfer
 *
 * Then posts the transfer inscription on Moltbook.
 */

const readline = require("readline");

const {
  MBC20_SUBMOLT, OPENAI_API_KEY,
  SEP, SEP2, log, logBlock, logResult,
  readBots, parseProxy, readProxies,
  createPost, verifyPost
} = require("./shared");

// ─── Interactive prompt ──────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const bots = readBots();
  const proxies = readProxies();

  if (bots.length === 0) {
    console.log("No bots found in data/accs.txt");
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log(`\n${SEP}`);
  console.log(`  Moltbook — Transfer Tokens`);
  console.log(SEP);

  // ── Select sender bot ──
  console.log(`\n  Available bots:\n`);
  bots.forEach((bot, i) => {
    console.log(`    [${i + 1}] ${bot.name}`);
  });

  const senderIdx = parseInt(await ask(rl, `\n  Send FROM bot # (1-${bots.length}): `), 10) - 1;
  if (senderIdx < 0 || senderIdx >= bots.length) {
    console.log("  Invalid selection.");
    rl.close();
    process.exit(1);
  }
  const sender = bots[senderIdx];

  // ── Recipient ──
  const recipient = (await ask(rl, `  Send TO agent name: `)).trim();
  if (!recipient) {
    console.log("  Recipient cannot be empty.");
    rl.close();
    process.exit(1);
  }

  // ── Token ticker ──
  const tick = (await ask(rl, `  Token ticker [CLAW]: `)).trim().toUpperCase() || "CLAW";

  // ── Amount ──
  const amt = (await ask(rl, `  Amount to transfer: `)).trim();
  if (!amt || isNaN(Number(amt)) || Number(amt) <= 0) {
    console.log("  Invalid amount.");
    rl.close();
    process.exit(1);
  }

  rl.close();

  // ── Build transfer payload ──
  const payload = {
    p: "mbc-20",
    op: "transfer",
    tick,
    amt,
    to: recipient
  };

  console.log(`\n${SEP2}`);
  console.log(`  From:    ${sender.name}`);
  console.log(`  To:      ${recipient}`);
  console.log(`  Token:   ${tick}`);
  console.log(`  Amount:  ${amt}`);
  console.log(`  Payload: ${JSON.stringify(payload)}`);
  console.log(SEP2);

  // ── Post transfer inscription ──
  const proxy = proxies.length > 0 ? parseProxy(proxies[0]) : null;
  const transferId = Math.random().toString(36).slice(2, 10);
  const title = `Transfer ${tick} to ${recipient} - #${transferId}`;

  log(sender.name, `Posting transfer inscription...`);

  const resp = await createPost(
    sender.apiKey,
    MBC20_SUBMOLT,
    title,
    JSON.stringify(payload),
    proxy
  );

  log(sender.name, `POST status: ${resp.statusCode}`);

  if (resp.statusCode >= 200 && resp.statusCode < 300) {
    logResult(sender.name, true, `Transfer posted!`);
    if (resp.json?.post?.id) log(sender.name, `Post ID: ${resp.json.post.id}`);
    if (resp.json?.post?.url) log(sender.name, `URL: https://www.moltbook.com${resp.json.post.url}`);

    // Verify if needed (challenge)
    if (resp.json?.verification_required) {
      const code = resp.json.verification_code;
      const challenge = resp.json.challenge;
      log(sender.name, `Verification required!`);
      const verifyResp = await verifyPost(sender.apiKey, code, challenge, proxy, sender.name);
      if (verifyResp?.json?.success) {
        logResult(sender.name, true, `Transfer verified and complete!`);
      }
    } else {
      logResult(sender.name, true, `Transfer complete — no verification needed.`);
    }
  } else {
    logResult(sender.name, false, `Transfer failed: ${resp.json?.error || resp.body?.slice(0, 300)}`);
    if (resp.json?.hint) log(sender.name, `Hint: ${resp.json.hint}`);
  }

  console.log(SEP);
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
