# 02 · WhatsApp MCP — весь путь одним файлом

Агент по твоему запросу читает архив чатов, ищет по ним и шлёт сообщения. У WhatsApp
нет официального userbot-API, поэтому коннектор из **двух частей**: **мост**, который
держит связь с WhatsApp (как «связанное устройство») и копит архив, и тонкий
**MCP-слой** поверх архива.

> Готовый комплект: [`examples/wa-mcp/`](examples/wa-mcp/) — мост + HTTP MCP +
> systemd + nginx, наши боевые конфиги, обезличено.

## 1. Архитектура

```
Телефон (WhatsApp) ──QR──► bridge.js (whatsapp-web.js + Chromium)
                              │  пишет ВСЕ чаты → all_chats.db (SQLite)
                              │  control-API /me /chats /history /send → 127.0.0.1:8799 (BRIDGE_TOKEN)
                              ▼
        http-server.mjs (HTTP MCP)  читает архив + зовёт мост на отправку
                              │  слушает 127.0.0.1:8796, путь /<WA_MCP_SECRET>/mcp
                              ▼
        https://wa-mcp.example.com/<WA_MCP_SECRET>/mcp   (nginx + certbot)
                              ▼
        Claude Code (ноут) · Claude app (телефон) — секрет прямо в URL
```

Два процесса:
1. **Мост `bridge.js`** — линковка с WhatsApp (Chromium через `whatsapp-web.js`).
   Пишет входящие И твои исходящие в `all_chats.db`, отдаёт control-API на
   `127.0.0.1:8799` (гейт — `BRIDGE_TOKEN`), показывает QR-страницу на `:8795`.
   Сессия `wa_session/` переживает рестарты — QR сканируется один раз.
2. **MCP `http-server.mjs` + `lib.mjs`** — streamable HTTP, **секрет в пути URL**
   (Bearer-заголовок не нужен вообще). Читает архив, зовёт мост для live-списка
   и отправки.

## 2. Почему именно этот мост (и что с историей)

Мостов к WhatsApp два жанра; этот мини-плейбук осознанно берёт один:

| | **Наш путь: whatsapp-web.js** | Альтернатива: whatsmeow (Go) |
|---|---|---|
| Архив | копится **с момента линковки** | обещает подтянуть прошлое (HistorySync) |
| RAM | ≥1 ГБ (Chromium) | лёгкий, без браузера |
| Надёжность | в проде, недели аптайма | капризная линковка; **у нас history вернул 0** |

**Прошлые переписки** (до линковки) при нужде добираются официальным
**Export chat**: чат → меню → Export chat → Without media → `.txt` с датами и
отправителями, скармливаешь агенту — он положит в ту же базу. Обычно хватает
2–3 месяцев. Эксперимент whatsmeow лежит в
[`mcp-messengers-playbook`](https://github.com/rocketmandrey/mcp-messengers-playbook)
(`examples/wa-mcp/go-bridge/`) — честно: у нас не завёлся.

## 3. Деплой по шагам

```bash
# 0. Комплект на сервер
scp -r examples/wa-mcp root@<сервер>:/root/whatsapp-mcp
cd /root/whatsapp-mcp

# 1. Секреты (генерятся, внешних ключей нет)
cp .env.example .env && chmod 600 .env
# впиши: BRIDGE_TOKEN=$(openssl rand -hex 24), WA_MCP_SECRET=$(openssl rand -hex 24)

# 2. Мост
npm install                     # whatsapp-web.js тянет Chromium (нужен ≥1 ГБ RAM)
node bridge.js                  # QR в терминале и на http://<сервер>:8795
# Телефон: WhatsApp → Настройки → Связанные устройства → Привязать устройство → сканируй
# Проверка: curl 127.0.0.1:8799/me  → твой номер
# ⚠️ сразу после линковки: ufw deny 8795

# 3. MCP поверх архива
node http-server.mjs            # 127.0.0.1:8796, путь /<WA_MCP_SECRET>/mcp

# 4. 24/7 — systemd (шаблоны в deploy/): мост + MCP, оба Restart=always
cp deploy/whatsapp-mcp-http.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now whatsapp-mcp-http
# для моста — аналогичный юнит на bridge.js (образец тот же, поменяй ExecStart)

# 5. Домен: deploy/nginx.wa-mcp.conf.example → sites-available, затем
certbot --nginx -d wa-mcp.example.com
```

nginx тут простой: секрет уже в пути (его проверяет сам `http-server.mjs`),
никаких инъекций заголовков — чистый proxy на `127.0.0.1:8796`.

## 4. Подключение клиентов

**Claude Code (ноут / любой комп)** — один раз, доступно из любой папки:
```bash
claude mcp add --scope user --transport http whatsapp \
  "https://wa-mcp.example.com/<WA_MCP_SECRET>/mcp"
claude mcp list     # → whatsapp ✔ Connected
```

**Телефон / claude.ai:** кастомные коннекторы claude.ai не умеют свои HTTP-заголовки,
но нам и не надо — секрет уже в URL. Settings → Connectors → Add custom connector →
тот же `https://wa-mcp.example.com/<WA_MCP_SECRET>/mcp`. OAuth-поля в Advanced
settings не заполняй.

> На второй машине — та же команда. Сессия одна (на сервере), клиентов сколько угодно.

**Тулы, которые получает агент:** `whoami`, `list_chats`, `read_group`,
`search_messages`, `fetch_history`, `send_message` (**реально шлёт** — только с
подтверждением), `save_draft` / `list_drafts`.

## 5. Смок-тест (обязательно, до «готово»)

- `claude mcp list` → `whatsapp ✔ Connected`.
- `whoami` → твой слинкованный номер.
- «найди в вотсапе чат <название>» → возвращает реальные чаты.
- Кривой секрет в пути URL → `404` (проверь, что чужим реально закрыто!).
- `ufw status` → 8795 закрыт; `ss -tlnp` → 8796/8799 только на `127.0.0.1`.

## 6. Грабли

| Симптом | Причина | Фикс |
|---|---|---|
| MCP «отваливается» в Claude Code | подключили stdio через `ssh … node mcp-server.mjs` — рвётся вместе с ssh | только **HTTP** (`http-server.mjs`) |
| QR «попробуйте ещё раз» по кругу | частые попытки линковки → shadow-ban | пауза (часы), не долби |
| Мост ест память / «засыпает» | Chromium long-running | systemd с `Restart=always`, ≥1 ГБ RAM |
| `send_message` ничего не шлёт | мост не поднят / неверный `BRIDGE_TOKEN` / не тот `WA_BRIDGE_URL` | `curl 127.0.0.1:8799/me`, сверь `.env` |
| Архив пустой | это норма: копится с момента линковки | прошлое — Export chat (§2) |
| Телефон не коннектится | невалидный SSL / порт не проксируется | `nginx -t`, certbot, порт на `127.0.0.1` + nginx наружу |

## 7. Безопасность (коротко)

Полностью — [`01_SECURITY.md`](01_SECURITY.md). По WhatsApp главное:
`wa_session/` = пароль (в `.gitignore`); `BRIDGE_TOKEN` обязателен; QR-порт закрыть
после линковки; `WA_MCP_SECRET` утёк → поменять в `.env` и перезапустить сервис;
`send_message` — только с подтверждением, по умолчанию `save_draft`; отдельный номер
по возможности.
