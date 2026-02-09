# MOLT — Moltbook Fleet Manager

Автоматизация регистрации, верификации, привязки кошелька и минта токенов MBC-20 на [Moltbook](https://www.moltbook.com).

---

## Структура проекта

```
MOLT/
├── mint.js         # Авто-минт токенов (бесконечный цикл)
├── link.js         # Привязка кошелька ко всем аккаунтам (запуск один раз)
├── shared.js       # Общий модуль (HTTP, логгирование, ChatGPT, утилиты)
├── package.json
└── data/
    ├── config.json     # Конфиг (кошелёк, API-ключ OpenAI, модель, параметры минта)
    ├── accs.txt        # Аккаунты (Name:ApiKey или Name:ApiKey:ClaimURL)
    ├── proxy.txt       # Прокси (один на строку)
    ├── twitter.txt     # Twitter-аккаунты для reg.js (LOGIN:PASS:EMAIL:EMAILPASS)
    ├── dead_twitter.txt# Мёртвые Twitter-аккаунты (заполняется автоматически)
    └── status.json     # Состояние каждого бота (заполняется автоматически)
```

---

## Установка

```bash
cd MOLT
npm install
```

Зависимости:
- `https-proxy-agent` — поддержка HTTP/HTTPS прокси
- `imapflow` — чтение почты через IMAP (для автоматической верификации email)

---

## Файлы данных (`data/`)

### `accs.txt` — Аккаунты

Основной файл с аккаунтами. Все скрипты читают ботов отсюда.

```
# Формат: Имя:API_ключ
MyBot123:moltbook_sk_abc123def456

# Или с claim URL (добавляется автоматически при регистрации через reg.js):
MyBot456:moltbook_sk_xyz789:https://moltbook.com/claim/moltbook_claim_xxx
```

### `proxy.txt` — Прокси

```
# Формат: ip:port:user:password
1.2.3.4:8080:username:password

# Или просто ip:port
1.2.3.4:8080

# Или полный URL
http://user:pass@1.2.3.4:8080
```

Прокси распределяются по ботам циклически (бот 1 → прокси 1, бот 2 → прокси 2, ...).

### `config.json` — Основной конфиг

```json
{
  "wallet": "0xВашКошелёк",
  "openai_api_key": "sk-proj-xxxxxxxxxxxxxxxx",
  "openai_model": "gpt-4o-mini",
  "mint_tick": "CLAW",
  "mint_amt": "100"
}
```

| Поле | Описание |
|------|----------|
| `wallet` | ERC-20 кошелёк на Base для привязки к ботам и клейма токенов |
| `openai_api_key` | API-ключ OpenAI для решения верификационных задач |
| `openai_model` | Модель ChatGPT (по умолчанию `gpt-4o-mini`) |
| `mint_tick` | Тикер токена для минта (по умолчанию `CLAW`) |
| `mint_amt` | Количество токенов за один минт (по умолчанию `100`) |

Файл создаётся автоматически при первом запуске, если его нет. Если `wallet` или `openai_api_key` пустые — в консоли будет предупреждение.

## Скрипты

### 1. `link.js` — Привязка кошелька

Привязывает ERC-20 кошелёк ко всем claimed аккаунтам. Запускается один раз.

```bash
node link.js
```

**Требуемые файлы:** `data/config.json`, `data/accs.txt`, `data/proxy.txt`

**Что делает:**
1. Для каждого бота проверяет статус (claimed или нет)
2. Постит link-инскрипцию: `{"p":"mbc-20","op":"link","wallet":"0x..."}`
3. Решает верификационную задачу через ChatGPT
4. Сохраняет `wallet_linked: true` в `status.json`

Кошелёк берётся из `data/config.json` (поле `wallet`).

---

### 2. `mint.js` — Авто-минт токенов

Бесконечный цикл минта MBC-20 токенов. Каждый бот минтит независимо по собственному таймеру.

```bash
node mint.js
```

**Требуемые файлы:** `data/config.json`, `data/accs.txt`, `data/proxy.txt`

**Как работает:**
- Проверяет всех ботов каждые 60 секунд
- Каждый бот минтит как только его кулдаун истекает (2 часа 5 минут)
- Не ждёт остальных ботов — каждый минтит независимо
- При минте постит: `{"p":"mbc-20","op":"mint","tick":"CLAW","amt":"100"}`
- Решает верификационную задачу через ChatGPT
- Обрабатывает rate-limit (429) и автоматически ставит таймер на retry
- Время последнего минта сохраняется в `status.json`

**Тихий режим:** когда все боты на кулдауне, в консоли показывается одна строка с обратным отсчётом до ближайшего минта.

---

## Верификационные задачи

При каждом посте на Moltbook требуется решить обфусцированную математическую задачу. Пример:

```
A] lO b-StEr'S ~ClAw^ ExErTs/ twEnTy ThReE {nEwToNs} aNd| aN oThEr Lo.o.bStEr ~AdDs/ sEvEn nEwToNs, hOw- mUcH <CoMbInEd> fOrCe?
```

Деобфускация → `a lobster s claw exerts twenty three newtons and an other lobster adds seven newtons how much combined force`

Ответ: `30.00`

Решение выполняется автоматически через ChatGPT API (`gpt-4o-mini`). Ответ должен быть числом с двумя десятичными знаками.

---

## Порядок использования

```
1. Настроить конфиг:
   data/config.json     — кошелёк + ключ OpenAI + параметры минта

2. Подготовить файлы данных:
   data/proxy.txt       — прокси
   data/twitter.txt     — Twitter-аккаунты LOGIN:PASS:EMAIL:EMAILPASS (для reg.js)

3. Зарегистрировать аккаунты:
   node reg.js 10

4. Привязать кошелёк:
   node link.js

5. Запустить авто-минт:
   node mint.js
```

---

## Лимиты Moltbook

| Действие | Новые аккаунты (< 24ч) | Обычные аккаунты |
|----------|------------------------|------------------|
| Посты | 1 раз в 2 часа | 1 раз в 30 минут |
| Комментарии | 60 сек кулдаун, 20/день | 20 сек кулдаун, 50/день |
| DM | Заблокировано | Разрешено |
| Создание submolt | 1 всего | 1 в час |

---

## Переменные окружения (опционально)

Все настройки задаются в `data/config.json`. Переменные окружения — только как фоллбэк:

| Переменная | Описание | Приоритет |
|------------|----------|-----------|
| `OPENAI_API_KEY` | Ключ OpenAI | config.json > env |
| `OPENAI_MODEL` | Модель ChatGPT | config.json > env > `gpt-4o-mini` |

---

## Логи

Все скрипты выводят подробные логи с временными метками:

```
[2026-02-09 14:30:01] [MyBot123] Minting tokens...
[2026-02-09 14:30:01] [MyBot123] Payload: {"p":"mbc-20","op":"mint","tick":"CLAW","amt":"100"}
[2026-02-09 14:30:02] [MyBot123] MINT POST status: 201
[2026-02-09 14:30:02] [MyBot123] ✅ Mint post created!
[2026-02-09 14:30:02] [MyBot123] Verification required! Expires: 2026-02-09T14:30:32Z
[2026-02-09 14:30:02] [MyBot123/MINT-VERIFY] Solving challenge via ChatGPT (gpt-4o-mini)...
[2026-02-09 14:30:03] [MyBot123/MINT-VERIFY] ✅ ChatGPT answer: 30.00
[2026-02-09 14:30:03] [MyBot123/MINT-VERIFY] ✅ Verification successful!
```
#   M B C - 2 0 - S O F T  
 