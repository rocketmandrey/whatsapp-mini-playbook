# Пример: wa-mcp — WhatsApp-мост + MCP (деплой-комплект)

**Рабочий референс** WhatsApp-моста: `whatsapp-web.js` (Chrome) пишет ВСЕ чаты в SQLite
и отдаёт control-API; поверх — MCP-сервер, через который агент читает архив и шлёт
сообщения. Архив копится с момента линковки (без бэкфилла прошлого); прошлое при нужде —
через Export chat ([`../../02_WHATSAPP_MCP.md`](../../02_WHATSAPP_MCP.md) §2).

> ⚠️ Секретов здесь нет. Всё читается из `.env` (его нет в репо — только `.env.example`).
> Сессия `wa_session/` и базы `*.db` создаются у тебя локально и в `.gitignore`.
> Экспериментальный мост «с историей» (whatsmeow/Go) — в большой репе
> [`mcp-messengers-playbook`](https://github.com/rocketmandrey/mcp-messengers-playbook)
> (`examples/wa-mcp/go-bridge/`); у нас history sync не завёлся, честно.

## Файлы

| Файл | Роль |
|---|---|
| `bridge.js` | WhatsApp Web клиент (Chromium/Puppeteer). Пишет все чаты в `all_chats.db`, control-API `/me /chats /history /send` на `127.0.0.1:8799`, публичная QR-страница на `:8795`. Слушает `message_create` → ловит входящие И твои исходящие. |
| `lib.mjs` | MCP-инструменты + хендлеры: читает архив (SQLite), зовёт мост для live-списка и отправки. |
| `mcp-server.mjs` | stdio-вход MCP — **legacy**: через SSH отваливается вместе с ssh-процессом, мы ушли на HTTP. |
| `http-server.mjs` | HTTP-вход MCP — **основной для всех клиентов** (Claude Code + мобайл/веб), авторизация секретом-в-URL `/<WA_MCP_SECRET>/mcp`. |
| `package.json` | Зависимости: `whatsapp-web.js`, `better-sqlite3`, `qrcode-terminal`, MCP SDK. |
| `deploy/` | Готовые systemd-юниты (мост + MCP) и nginx-шаблон (24/7 на VPS). Деплой по шагам — [`../../02_WHATSAPP_MCP.md`](../../02_WHATSAPP_MCP.md) §3. |

## Запуск

```bash
cp .env.example .env          # впиши BRIDGE_TOKEN, при желании TARGET_GROUP_NAME
npm install                   # whatsapp-web.js тянет Chromium (нужен ≥1 ГБ RAM)
node bridge.js                # покажет QR в терминале + на http://localhost:8795
# Телефон: WhatsApp → Связанные устройства → Привязать устройство → сканируй QR
# Дальше all_chats.db наполняется. Проверка: curl 127.0.0.1:8799/me
```

MCP-слой (для агента) — **HTTP**, один вход для всех клиентов:
```bash
WA_MCP_SECRET=$(openssl rand -hex 24)   # запиши его
node http-server.mjs                    # 127.0.0.1:8796, путь /<WA_MCP_SECRET>/mcp

# 24/7 на VPS: deploy/whatsapp-mcp-http.service + deploy/nginx.wa-mcp.conf.example + certbot
# Подключение Claude Code (и тот же URL — в коннектор Claude app на телефоне):
claude mcp add --scope user --transport http whatsapp \
  "https://wa-mcp.example.com/<WA_MCP_SECRET>/mcp"
```

(stdio-вариант `mcp-server.mjs` остался для локального запуска без сервера; через
SSH его НЕ гоняй — рвётся вместе с ssh.)

## Безопасность (обязательно)

- `BRIDGE_TOKEN` обязателен; control-API только на `127.0.0.1`.
- QR-страница (`:8795`) висит на `0.0.0.0` — **закрой фаерволом после линковки**.
- `send_message` шлёт реально — подтверждай получателя; по умолчанию — `save_draft`.
- Отдельный номер по возможности. Чужие переписки — локально, не публиковать.
- Полные правила — [`../../01_SECURITY.md`](../../01_SECURITY.md).
