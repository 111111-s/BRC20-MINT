#!/usr/bin/env node
/**
 * transfer.js — Transfer MBC-20 tokens between agents
 *
 * Interactive console script:
 *   1. Select sender bot (from data/accs.txt)
 *   2. Enter recipient agent name
 *   3. Enter token ticker (default: CLAW)
 *   4. Enter amount to transfer
 *
 * Usage: node transfer.js
 */

const readline = require("readline");

const {
  MBC20_SUBMOLT,
  SEP, SEP2, log, logBlock, logResult,
  readBots, readProxies,
  createPost, verifyPost
} = require("./shared");

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  const bots    = readBots();
  const proxies = readProxies();

  if (bots.length === 0) {
    console.log("No bots found in data/accs.txt");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n${SEP}`);
  console.log("  MOLT \u2014 Transfer Tokens");
  console.log(SEP);

  // Select sender
  console.log("\n  Available bots:\n");
  bots.forEach((bot, i) => console.log(`    [${i + 1}] ${bot.name}`));

  const senderIdx = parseInt(await ask(rl, `\n  Send FROM bot # (1-${bots.length}): `), 10) - 1;
  if (senderIdx < 0 || senderIdx >= bots.length) { console.log("  Invalid selection."); rl.close(); process.exit(1); }
  const sender = bots[senderIdx];

  const recipient = (await ask(rl, "  Send TO agent name: ")).trim();
  if (!recipient) { console.log("  Recipient cannot be empty."); rl.close(); process.exit(1); }

  const tick = (await ask(rl, "  Token ticker [CLAW]: ")).trim().toUpperCase() || "CLAW";

  const amt = (await ask(rl, "  Amount to transfer: ")).trim();
  if (!amt || isNaN(Number(amt)) || Number(amt) <= 0) { console.log("  Invalid amount."); rl.close(); process.exit(1); }

  rl.close();

  const payload = { p: "mbc-20", op: "transfer", tick, amt, to: recipient };

  console.log(`\n${SEP2}`);
  console.log(`  From:    ${sender.name}`);
  console.log(`  To:      ${recipient}`);
  console.log(`  Token:   ${tick}`);
  console.log(`  Amount:  ${amt}`);
  console.log(`  Payload: ${JSON.stringify(payload)}`);
  console.log(SEP2);

  const proxyIdx   = proxies.length > 0 ? 0 : -1;
  const transferId = Math.random().toString(36).slice(2, 10);
  const title      = `Transfer ${tick} to ${recipient} - #${transferId}`;

  log(sender.name, "Posting transfer inscription...");
  const resp = await createPost(sender.apiKey, MBC20_SUBMOLT, title, JSON.stringify(payload), proxyIdx);
  log(sender.name, `POST status: ${resp.statusCode}`);

  if (resp.statusCode >= 200 && resp.statusCode < 300) {
    logResult(sender.name, true, "Transfer posted!");
    if (resp.json?.post?.id)  log(sender.name, `Post ID: ${resp.json.post.id}`);
    if (resp.json?.post?.url) log(sender.name, `URL: https://www.moltbook.com${resp.json.post.url}`);

    if (resp.json?.verification_required) {
      const v = resp.json.verification;
      log(sender.name, "Verification required!");
      const verifyResp = await verifyPost(sender.apiKey, v.code, v.challenge, proxyIdx, sender.name);
      if (verifyResp?.json?.success) logResult(sender.name, true, "Transfer verified and complete!");
    } else {
      logResult(sender.name, true, "Transfer complete.");
    }
  } else {
    logResult(sender.name, false, `Transfer failed: ${resp.json?.error || resp.body?.slice(0, 300)}`);
    if (resp.json?.hint) log(sender.name, `Hint: ${resp.json.hint}`);
  }

  console.log(SEP);
}

main().catch(e => { console.error(`[FATAL] ${e.message}`); process.exit(1); });
