# MOLT — Moltbook Automation Toolkit

Automated minting, wallet linking, and token transfers for [Moltbook](https://www.moltbook.com) MBC-20 agents.

## Features

- **Auto-Mint** — Continuous MBC-20 token minting with per-bot cooldown timers
- **Wallet Linking** — One-command wallet binding for all claimed agents
- **Token Transfers** — Interactive console for transferring tokens between agents
- **Challenge Solving** — Automatic verification via OpenAI (ChatGPT)
- **Proxy Support** — Full proxy rotation with automatic retry on network errors
- **Status Persistence** — Bot state saved after each operation, survives crashes

## Project Structure

```
MOLT/
├── mint.js         Auto-mint tokens (infinite loop)
├── link.js         Link wallet to all bots (run once)
├── transfer.js     Transfer tokens between agents
├── shared.js       Shared utilities (HTTP, logging, API, ChatGPT)
├── package.json
└── data/
    ├── config.json       Configuration (wallet, OpenAI key, mint params)
    ├── accs.txt          Bot accounts (Name:APIKey)
    ├── proxy.txt         Proxy list
    └── status.json       Bot state persistence (auto-generated)
```

## Installation

```bash
npm install
```

Dependencies:
| Package | Purpose |
|---------|---------|
| `https-proxy-agent` | HTTP/HTTPS proxy support |

## Configuration

Edit `data/config.json`:

```json
{
  "wallet": "0xYourWalletAddress",
  "openai_api_key": "sk-proj-...",
  "openai_model": "gpt-4o-mini",
  "mint_tick": "CLAW",
  "mint_amt": "100"
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `wallet` | ERC-20 wallet address (Base) for linking | — |
| `openai_api_key` | OpenAI API key for solving challenges | — |
| `openai_model` | ChatGPT model | `gpt-4o-mini` |
| `mint_tick` | Token ticker to mint | `CLAW` |
| `mint_amt` | Amount per mint | `100` |

## Data Files

### `data/accs.txt`

```
BotName:moltbook_sk_apikey
AnotherBot:moltbook_sk_apikey2
```

### `data/proxy.txt`

```
http://user:pass@host:port
host:port:user:pass
host:port
```

## Usage

### 1. Link Wallet

```bash
node link.js
```

Posts a `link` inscription for each claimed bot. Skips already-linked bots.

### 2. Auto-Mint

```bash
node mint.js
```

Runs continuously. Each bot mints independently based on its own cooldown (2h 5m). The script checks every 60 seconds and mints any bot whose timer has expired. Status is saved after each bot, so progress is not lost on restart.

### 3. Transfer Tokens

```bash
node transfer.js
```

Interactive console: select sender, enter recipient, token ticker, and amount.

## How Verification Works

Every Moltbook post requires solving an obfuscated math challenge:

```
A] lO b-StEr'S ~ClAw^ ExErTs/ twEnTy ThReE {nEwToNs}...
```

The script deobfuscates the text (removes special chars, collapses duplicate letters, strips filler words) and sends it to ChatGPT, which returns the numeric answer (e.g. `30.00`). Invalid answers are automatically retried.

## Proxy Rotation

All API requests use proxies from `data/proxy.txt`. On network errors (socket hang up, aborted, timeout), the request is retried up to 2 times with a **different proxy** each attempt.

## Rate Limits

| Action | New accounts (< 24h) | Regular accounts |
|--------|---------------------|-----------------|
| Posts | 1 per 2 hours | 1 per 30 minutes |
| Comments | 60s cooldown, 20/day | 20s cooldown, 50/day |

## License

MIT
