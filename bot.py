"""
Telegram-бот «Магазин одежды + заказ из Китая».
Архитектура: бот — приёмник сообщений клиентов и нотификатор для менеджеров.
Вся менеджерская работа происходит в админ-панели; бот в эту работу не вмешивается.

Стек: Python 3.10+, aiogram 3.x, httpx.

Что делает бот:
1. /start без параметров — приветствие клиенту, либо тихая регистрация менеджера/суперадмина.
2. /start request, /start request_<category>, /start ask_<product_id>, /start order_<order_id>
   — клиент пришёл из апки. Бот сохраняет соответствующее обращение/заказ в БД, шлёт
   клиенту приветствие, дежурным менеджерам — короткое уведомление со ссылкой на админку.
3. /start duty — тихая регистрация chat_id менеджера (вызывается через deep-link
   из админки, когда менеджер встаёт на дежурство; без подсказок и приветствий).
4. Любое сообщение от клиента: сохраняется в БД, дежурным шлётся короткое уведомление
   «новое сообщение от клиента» (с rate-limit 5 мин на клиента).
5. Outbox-воркер: забирает ответы менеджеров, которые они пишут в админке, и
   отправляет их клиентам.
6. Брошенные корзины: раз в сутки шлёт мягкое напоминание клиентам, у которых
   корзина не тронута >24ч.

Никаких карточек, кнопок-статусов, reply-routing и ручного создания заказа в боте
больше нет — всё в админке (см. dashboard/).

Установка:
    pip install aiogram httpx

Запуск:
    export BOT_TOKEN="123:ABC..."
    export WEBAPP_URL="https://your.site/index.html"
    export SUPERADMIN_USERNAME="rogovtsoff"      # без @
    export DASHBOARD_URL="https://your.site/dashboard/"
    export SUPABASE_URL="https://xxx.supabase.co"
    export SUPABASE_ANON_KEY="eyJ..."
    python bot.py

Управление менеджерами и дежурствами — в админке (раздел «👥 Менеджеры», кнопка
«На дежурстве» в подвале сайдбара).
"""

import asyncio
import html
import logging
import os
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import httpx
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramForbiddenError
from aiogram.filters import CommandStart, CommandObject
from aiogram.types import (
    Message,
    ReplyKeyboardRemove,
    ChatMemberUpdated,
)
from aiogram.filters import ChatMemberUpdatedFilter, KICKED, MEMBER


# ============================ КОНФИГ ============================

BOT_TOKEN = os.getenv("BOT_TOKEN", "8799556901:AAHqUPacTvqJPrITaZVgE9e1Cr81dF_nDCk")
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://erogovtsoff.github.io/lizard_remote_delivery/index.html")
# URL менеджерской админки (показывается в уведомлениях менеджерам).
DASHBOARD_URL = os.getenv("DASHBOARD_URL", "https://erogovtsoff.github.io/lizard_remote_delivery/dashboard/")
# Суперадмин — единственный, кто может добавлять/удалять менеджеров.
# MANAGER_USERNAME оставлен для обратной совместимости: трактуется как суперадмин.
SUPERADMIN_USERNAME = os.getenv(
    "SUPERADMIN_USERNAME",
    os.getenv("MANAGER_USERNAME", "rogovtsoff"),
).lstrip("@").lower()
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://nhnbprmyqqpwcofkaasi.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5obmJwcm15cXFwd2NvZmthYXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwOTc4NzEsImV4cCI6MjA5NDY3Mzg3MX0.85NtVma5cplLuhm_fRHga3Z1ZlyNuFQBOqlxGeQggJ0")

MANAGER_FILE = Path("manager_chat.txt")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
log = logging.getLogger("shop-bot")
router = Router()


# ========================== ХРАНИЛИЩЕ ==========================

def get_superadmin_chat_id() -> Optional[int]:
    if MANAGER_FILE.exists():
        try:
            return int(MANAGER_FILE.read_text().strip())
        except (ValueError, OSError):
            return None
    return None


def set_superadmin_chat_id(chat_id: int) -> None:
    MANAGER_FILE.write_text(str(chat_id))


# ========================== SUPABASE ===========================

def supabase_ready() -> bool:
    return bool(SUPABASE_URL and SUPABASE_KEY)


# Один переиспользуемый HTTP-клиент с пулом соединений (вместо создания нового
# на каждый запрос). Keep-alive снижает число TCP-рукопожатий и устраняет
# исчерпание сокетов Windows при частом опросе.
_http_client: Optional[httpx.AsyncClient] = None


def get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=10.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _http_client


# Сетевые ошибки, которые имеет смысл повторить (соединение не установилось,
# таймаут, обрыв). 4xx/5xx-ответы сюда не входят — их не повторяем.
_RETRYABLE = (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout,
              httpx.ReadError, httpx.RemoteProtocolError, httpx.PoolTimeout)


async def retry_network(coro_factory, *, what: str = "network", retries: int = 10):
    """
    Повторяет асинхронную операцию при сетевых ошибках (экспонента, потолок 5с,
    до 10 попыток). coro_factory — функция без аргументов, возвращающая корутину
    (новую на каждую попытку). Пробрасывает результат или последнюю ошибку.
    Подходит для Telegram-вызовов (get_file/download/send) и прочего ввода-вывода.
    """
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            return await coro_factory()
        except _RETRYABLE as e:
            last_err = e
            if attempt < retries:
                delay = min(0.5 * (2 ** (attempt - 1)), 5.0)
                log.warning("%s: сетевая ошибка (попытка %d/%d), повтор через %.1fс",
                            what, attempt, retries, delay)
                await asyncio.sleep(delay)
            else:
                log.warning("%s: не удалось после %d попыток (%s)",
                            what, retries, type(e).__name__)
    if last_err:
        raise last_err


async def _supabase_request(method: str, path: str, *, params=None, json=None,
                            headers_extra=None, retries: int = 10):
    """
    Выполняет запрос к Supabase REST с автоповтором при сетевых ошибках.
    Пауза растёт экспоненциально с потолком 5с: 0.5 → 1 → 2 → 4 → 5 → 5...
    До 10 попыток — перекрывает сетевой провал примерно до 35-40 секунд.
    Возвращает httpx.Response или None (если все попытки провалились).
    """
    if not supabase_ready():
        log.warning("Supabase не настроен — пропускаю запрос %s", path)
        return None
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    }
    if headers_extra:
        headers.update(headers_extra)

    client = get_http_client()
    for attempt in range(1, retries + 1):
        try:
            r = await client.request(method, url, headers=headers, params=params, json=json)
            return r
        except _RETRYABLE as e:
            if attempt < retries:
                # Экспоненциальная пауза с потолком 5с: 0.5, 1, 2, 4, 5, 5, ...
                delay = min(0.5 * (2 ** (attempt - 1)), 5.0)
                log.warning("Supabase %s %s: сетевая ошибка (попытка %d/%d), повтор через %.1fс",
                            method, path, attempt, retries, delay)
                await asyncio.sleep(delay)
            else:
                log.warning("Supabase %s %s: не долетело после %d попыток (%s)",
                            method, path, retries, type(e).__name__)
        except Exception as e:
            # Неожиданная ошибка — не повторяем
            log.exception("Supabase %s %s unexpected error: %s", method, path, e)
            return None
    return None


async def supabase_get(path: str, params: dict = None) -> Optional[list]:
    """GET-запрос к Supabase REST API. Возвращает список объектов или None."""
    r = await _supabase_request("GET", path, params=params or {},
                                headers_extra={"Accept": "application/json"})
    if r is None:
        return None
    if r.status_code >= 400:
        log.error("Supabase %s failed: %s %s", path, r.status_code, r.text[:200])
        return None
    try:
        return r.json()
    except Exception:
        return None


async def supabase_patch(path: str, params: dict, body: dict) -> bool:
    """PATCH-запрос (UPDATE) к Supabase REST API. Возвращает True при успехе."""
    r = await _supabase_request("PATCH", path, params=params, json=body,
                                headers_extra={"Content-Type": "application/json",
                                               "Prefer": "return=minimal"})
    if r is None:
        return False
    if r.status_code >= 400:
        log.error("Supabase PATCH %s failed: %s %s", path, r.status_code, r.text[:200])
        return False
    return True


async def supabase_post(path: str, body: dict) -> Optional[dict]:
    """POST (INSERT) к Supabase REST API. Возвращает созданную запись или None."""
    r = await _supabase_request("POST", path, json=body,
                                headers_extra={"Content-Type": "application/json",
                                               "Prefer": "return=representation"})
    if r is None:
        return None
    if r.status_code >= 400:
        log.error("Supabase POST %s failed: %s %s", path, r.status_code, r.text[:200])
        return None
    try:
        data = r.json()
        return data[0] if isinstance(data, list) and data else data
    except Exception:
        return None



# ===================== СООБЩЕНИЯ (для dashboard) =====================
#
# Бот сохраняет всю переписку в таблицу messages, продолжая работать как раньше.
# Вложения клиента перезаливаются в Supabase Storage (bucket "chat-files"),
# чтобы у dashboard был постоянный публичный URL.

STORAGE_BUCKET = "chat-files"


async def upload_to_storage(bot: Bot, file_id: str, suffix: str = "") -> Optional[str]:
    """
    Скачивает файл из Telegram по file_id и заливает в Supabase Storage.
    Возвращает публичный URL или None.
    """
    if not supabase_ready() or not file_id:
        return None
    try:
        # 1. Получаем файл из Telegram (с ретраями на случай обрыва)
        tg_file = await retry_network(lambda: bot.get_file(file_id), what="tg.get_file")
        file_bytes_io = await retry_network(
            lambda: bot.download_file(tg_file.file_path), what="tg.download_file")
        data = file_bytes_io.read()

        # 2. Имя в Storage: уникальное, только безопасные символы
        ext = ""
        if tg_file.file_path and "." in tg_file.file_path:
            ext = "." + tg_file.file_path.rsplit(".", 1)[-1]
        elif suffix:
            ext = suffix
        safe = re.sub(r"[^A-Za-z0-9_-]", "", file_id)[:40]
        object_name = f"{safe}{ext}"

        # 3. Заливаем через Storage REST API (общий клиент с пулом + ретраи)
        url = f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{object_name}"
        headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/octet-stream",
            "x-upsert": "true",
        }
        client = get_http_client()
        r = await retry_network(
            lambda: client.post(url, headers=headers, content=data),
            what="storage.upload")
        if r.status_code >= 400:
            log.warning("Storage upload failed: %s %s", r.status_code, r.text[:200])
            return None
        # 4. Публичный URL
        return f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{object_name}"
    except Exception as e:
        log.warning("upload_to_storage error: %s", e)
        return None


async def save_message(customer_tg_id: int, direction: str, *, text: str = None,
                       sender: str = "client", manager_username: str = None,
                       attachment_url: str = None, attachment_type: str = None,
                       tg_file_id: str = None, source: str = "bot",
                       inquiry_id: str = None, order_id: int = None,
                       delivery_status: str = None) -> None:
    """Сохраняет сообщение в БД (для отображения в dashboard). Не критично к сбоям.
    delivery_status: None/'delivered' — норма; 'blocked' — клиент заблокировал бота;
    'failed' — иная ошибка доставки."""
    if not supabase_ready():
        return
    try:
        await supabase_post("messages", {
            "customer_tg_id": customer_tg_id,
            "direction": direction,
            "sender": sender,
            "manager_username": manager_username,
            "text": text,
            "attachment_url": attachment_url,
            "attachment_type": attachment_type,
            "tg_file_id": tg_file_id,
            "source": source,
            "inquiry_id": inquiry_id,
            "order_id": order_id,
            "delivery_status": delivery_status,
        })
    except Exception as e:
        log.warning("save_message error: %s", e)


async def get_active_context(customer_tg_id: int) -> dict:
    """
    Определяет «активный контекст» клиента — к какому заказу/обращению относить
    его входящее сообщение. Логика: берём самый свежий активный заказ ИЛИ
    обращение по дате обновления. Заказы и обращения сравниваются по updated_at.
    Возвращает {"inquiry_id": ...} или {"order_id": ...} или {} (нет активного).
    """
    if not supabase_ready():
        return {}
    candidates = []
    try:
        # Активные заказы (не завершён и не отменён)
        orders = await supabase_get("orders", {
            "select": "id,updated_at,status",
            "customer_tg_id": f"eq.{customer_tg_id}",
            "status": "not.in.(completed,cancelled)",
            "order": "updated_at.desc",
            "limit": "1",
        })
        if orders:
            candidates.append(("order", orders[0]["id"], _parse_ts(orders[0].get("updated_at"))))
    except Exception as e:
        log.warning("get_active_context orders error: %s", e)
    try:
        # Активные обращения (не закрыты)
        inquiries = await supabase_get("inquiries", {
            "select": "id,updated_at,status",
            "customer_tg_id": f"eq.{customer_tg_id}",
            "status": "neq.closed",
            "order": "updated_at.desc",
            "limit": "1",
        })
        if inquiries:
            candidates.append(("inquiry", inquiries[0]["id"], _parse_ts(inquiries[0].get("updated_at"))))
    except Exception as e:
        log.warning("get_active_context inquiries error: %s", e)

    if not candidates:
        return {}
    # Берём самый свежий по updated_at
    candidates.sort(key=lambda c: c[2] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    kind, cid, _ = candidates[0]
    return {"order_id": cid} if kind == "order" else {"inquiry_id": cid}


async def notify_client(bot: Bot, customer_tg_id: int, text: str,
                        inquiry_id: str = None, order_id: int = None) -> bool:
    """
    Отправляет клиенту собственное уведомление бота (смена статуса, напоминание
    и т.п.) И сохраняет его в messages как sender='bot', чтобы оно было видно
    в чате на dashboard. Возвращает True при успешной доставке.
    """
    delivered = False
    try:
        await retry_network(lambda: bot.send_message(customer_tg_id, text),
                            what="notify_client")
        delivered = True
    except TelegramForbiddenError:
        log.info("notify_client: клиент %s заблокировал бота", customer_tg_id)
    except Exception as e:
        log.warning("notify_client send failed for %s: %s", customer_tg_id, e)
    # Пишем в историю в любом случае (даже недоставленное — для полноты картины).
    await save_message(
        customer_tg_id, "out",
        text=text, sender="bot", source="bot",
        inquiry_id=inquiry_id, order_id=order_id,
    )
    return delivered


async def extract_and_save_incoming(message: Message, bot: Bot, ctx: dict = None) -> None:
    """
    Сохраняет входящее сообщение клиента в БД (текст + вложение в Storage).
    ctx — готовый контекст {inquiry_id|order_id}; если None, определяется здесь.
    Вызывается из forward_client_to_manager, не влияет на пересылку менеджеру.
    """
    text = message.text or message.caption or None
    att_url = None
    att_type = None
    file_id = None

    try:
        if message.photo:
            att_type = "photo"
            file_id = message.photo[-1].file_id        # самое большое разрешение
        elif message.document:
            att_type = "document"
            file_id = message.document.file_id
        elif message.video:
            att_type = "video"
            file_id = message.video.file_id
        elif message.voice:
            att_type = "voice"
            file_id = message.voice.file_id
        elif message.video_note:
            att_type = "video_note"
            file_id = message.video_note.file_id
        elif message.audio:
            att_type = "audio"
            file_id = message.audio.file_id

        if file_id:
            att_url = await upload_to_storage(bot, file_id)
    except Exception as e:
        log.warning("extract incoming attachment failed: %s", e)

    # Контекст передаётся снаружи (forward_client_to_manager уже определил/создал его)
    if ctx is None:
        ctx = await get_active_context(message.from_user.id)

    await save_message(
        message.from_user.id, "in",
        text=text, sender="client",
        attachment_url=att_url, attachment_type=att_type, tg_file_id=file_id,
        source="bot",
        inquiry_id=ctx.get("inquiry_id"), order_id=ctx.get("order_id"),
    )


# ========================== МЕНЕДЖЕРЫ ==========================
#
# Суперадмин (SUPERADMIN_USERNAME) всегда имеет полные права и не хранится в БД.
# Остальные менеджеры — в таблице managers, кешируются в памяти бота.

_managers_cache: list = []           # список dict из таблицы managers
_managers_cache_loaded: bool = False


async def reload_managers() -> list:
    """Перечитывает список менеджеров из БД в кеш."""
    global _managers_cache, _managers_cache_loaded
    rows = await supabase_get("managers", {"order": "created_at.asc"})
    _managers_cache = rows or []
    _managers_cache_loaded = True
    return _managers_cache


async def get_managers() -> list:
    """Возвращает кешированный список менеджеров (грузит при первом обращении)."""
    if not _managers_cache_loaded:
        await reload_managers()
    return _managers_cache


def is_superadmin(user) -> bool:
    return user is not None and (user.username or "").lower() == SUPERADMIN_USERNAME


async def is_manager(user) -> bool:
    """Менеджер = суперадмин ИЛИ есть в таблице managers (по tg_id или username)."""
    if user is None:
        return False
    if is_superadmin(user):
        return True
    uname = (user.username or "").lower()
    for m in await get_managers():
        if m.get("tg_id") and user.id and int(m["tg_id"]) == int(user.id):
            return True
        if m.get("username") and uname and m["username"].lower() == uname:
            return True
    return False


async def get_duty_chat_ids() -> list:
    """
    Чаты, куда слать новые заказы/обращения:
    — все дежурные менеджеры (is_on_duty=true) с известным chat_id;
    — суперадмин ВСЕГДА получает дубль (если сделал /start).
    Если совсем некому слать — пустой список.
    """
    chats = []
    for m in await get_managers():
        if m.get("is_on_duty"):
            if m.get("chat_id"):
                chats.append(int(m["chat_id"]))
            else:
                # Дежурный без chat_id — не делал /start, не сможем доставить
                log.warning(
                    "Дежурный менеджер @%s (id=%s) без chat_id — пусть напишет боту /start",
                    m.get("username"), m.get("tg_id"),
                )
    # Суперадмин получает дубль всех заказов/обращений всегда
    sa = get_superadmin_chat_id()
    if sa is not None:
        chats.append(sa)
    # уберём дубли, сохранив порядок
    seen = set()
    uniq = []
    for c in chats:
        if c not in seen:
            seen.add(c); uniq.append(c)
    return uniq


async def update_manager_chat(user) -> None:
    """Когда менеджер пишет боту — сохраняем его chat_id и tg_id в таблице.
    Раньше суперадмин пропускался (его chat_id уезжает в manager_chat.txt),
    но если он добавлен и в таблицу managers — полезно заполнить и там,
    чтобы get_duty_chat_ids не выдавал warning «без chat_id»."""
    if user is None:
        return
    uname = (user.username or "").lower()
    # Ищем запись по tg_id или username
    target = None
    for m in await get_managers():
        if m.get("tg_id") and int(m["tg_id"]) == int(user.id):
            target = m; break
        if m.get("username") and uname and m["username"].lower() == uname:
            target = m; break
    if not target:
        return
    patch = {}
    if not target.get("chat_id"):
        patch["chat_id"] = user.id
    if not target.get("tg_id") and user.id:
        patch["tg_id"] = user.id
    if uname and target.get("username") != uname:
        patch["username"] = uname
    if patch:
        # фильтр по существующему ключу (username или tg_id)
        if target.get("tg_id"):
            await supabase_patch("managers", {"tg_id": f"eq.{target['tg_id']}"}, patch)
        elif target.get("username"):
            await supabase_patch("managers", {"username": f"eq.{target['username']}"}, patch)
        await reload_managers()


async def fetch_product(product_id: str) -> Optional[dict]:
    rows = await supabase_get("products", {"id": f"eq.{product_id}", "limit": "1"})
    return rows[0] if rows else None


async def fetch_order(order_id: str) -> Optional[dict]:
    """Загружает заказ + позиции + product-данные позиций."""
    # 1. сам заказ
    rows = await supabase_get("orders", {"id": f"eq.{order_id}", "limit": "1"})
    if not rows:
        return None
    order = rows[0]

    # 2. позиции
    items = await supabase_get("order_items", {"order_id": f"eq.{order_id}"})
    order["items"] = items or []

    # 3. данные по товарам (для имени)
    if order["items"]:
        ids = list({it["product_id"] for it in order["items"]})
        # IN-фильтр в PostgREST: in.("a","b","c")
        in_clause = "in.(" + ",".join(f'"{i}"' for i in ids) + ")"
        prods = await supabase_get("products", {"id": in_clause})
        prod_map = {p["id"]: p for p in (prods or [])}
        for it in order["items"]:
            it["_product"] = prod_map.get(it["product_id"])

    return order



async def find_open_inquiry(customer_tg_id: int, inq_type: str,
                            product_id: Optional[str] = None) -> Optional[dict]:
    """
    Ищет открытое (не closed) обращение клиента того же типа.
    Для product_question дополнительно фильтрует по product_id.
    Используется для антиспама: один открытый request на клиента и один
    открытый вопрос на каждый товар.
    """
    params = {
        "customer_tg_id": f"eq.{customer_tg_id}",
        "type": f"eq.{inq_type}",
        "status": "in.(new,in_progress)",
        "order": "created_at.desc",
        "limit": "1",
    }
    if inq_type == "product_question" and product_id:
        params["product_id"] = f"eq.{product_id}"
    rows = await supabase_get("inquiries", params)
    return rows[0] if rows else None



# ========================== УТИЛИТЫ ============================


def product_name(prod: dict) -> str:
    if not prod:
        return "—"
    return prod.get("name_ru") or prod.get("name_en") or prod.get("id") or "—"


def fmt_price(amount: float, currency: str) -> str:
    s = f"{amount:.2f}".rstrip("0").rstrip(".")
    if not s:
        s = "0"
    return f"${s}" if currency == "USD" else f"{s} BYN"




def _parse_ts(ts: str) -> Optional[datetime]:
    """Парсит ISO-таймстемп из Supabase (с 'Z' или смещением) в aware datetime."""
    if not ts:
        return None
    try:
        s = ts.replace("Z", "+00:00")
        # Supabase иногда отдаёт микросекунды с переменной длиной — datetime справится
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None




def now_iso() -> str:
    """Текущее время в UTC ISO — для записи в updated_at."""
    return datetime.now(timezone.utc).isoformat()


async def notify_managers_brief(bot: Bot, kind: str, *, link_path: str = "") -> None:
    """
    Короткое обезличенное уведомление дежурным менеджерам (новый подход).
    Без имени клиента, без содержания, без inline-кнопок — только тип события
    и ссылка на админку, где менеджер увидит детали и ответит клиенту.

    kind — одно из: 'new_inquiry', 'new_question', 'new_order', 'new_message'.
    link_path — необязательное продолжение URL для прямой ссылки (например '#orders').
    """
    titles = {
        "new_inquiry":  "🆕 Новый запрос на подбор от клиента",
        "new_question": "❓ Новый вопрос о товаре от клиента",
        "new_order":    "📦 Новый заказ от клиента",
        "new_message":  "💬 Новое сообщение от клиента",
    }
    title = titles.get(kind, "🔔 Новое событие")
    link = DASHBOARD_URL.rstrip("/") + ("/" + link_path.lstrip("#/") if link_path else "")
    text = f"{title}\n\n👉 Откройте админку, чтобы посмотреть и ответить:\n{link}"
    for chat in await get_duty_chat_ids():
        try:
            await retry_network(lambda: bot.send_message(chat, text, disable_web_page_preview=True),
                                what="notify_managers_brief")
        except Exception as e:
            log.warning("notify_managers_brief failed for %s: %s", chat, e)



# ============================ /start ===========================

@router.message(CommandStart(deep_link=True))
async def cmd_start_deeplink(message: Message, command: CommandObject, bot: Bot) -> None:
    """
    /start <param> — клиент пришёл из апки с конкретным контекстом.
    Поддерживаем: request, ask_<product_id>, order_<order_id>, duty (для менеджера).
    """
    param = (command.args or "").strip()
    user = message.from_user
    if not user:
        return

    # Тихая регистрация менеджера для уведомлений (нажал «На дежурстве» в админке).
    # Никаких подсказок, ни лишних сообщений — просто сохранили chat_id.
    if param == "duty":
        if is_superadmin(user):
            set_superadmin_chat_id(message.chat.id)
            # И в таблицу managers (если он там есть) — чтобы убрать warning
            await update_manager_chat(user)
        elif await is_manager(user):
            await update_manager_chat(user)
        # Тихое короткое подтверждение, без инструкций
        try:
            await message.answer("✓")
        except Exception:
            pass
        return

    if param == "request":
        await handle_start_request(message, bot)
    elif param.startswith("request_"):
        preset = param[len("request_"):]
        await handle_start_request(message, bot, preset)
    elif param.startswith("ask_"):
        product_id = param[len("ask_"):]
        await handle_start_ask(message, bot, product_id)
    elif param.startswith("order_"):
        order_id = param[len("order_"):]
        await handle_start_order(message, bot, order_id)
    else:
        # Неизвестный параметр — обычное приветствие
        await send_welcome(message)


@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    """/start без параметров. Для суперадмина и менеджеров — регистрация чата."""
    user = message.from_user

    if is_superadmin(user):
        set_superadmin_chat_id(message.chat.id)
        # Если суперадмин также есть в таблице managers — заполним там chat_id,
        # чтобы get_duty_chat_ids не выдавал warning.
        await update_manager_chat(user)
        await message.answer(
            "✅ Вы вошли как <b>суперадмин</b>.\n\n"
            "Все управление — в админ-панели:\n"
            f"{DASHBOARD_URL}\n\n"
            "Сюда приходят уведомления о новых заказах, обращениях и сообщениях клиентов.",
        )
        return

    if await is_manager(user):
        await update_manager_chat(user)
        await message.answer(
            "✅ Вы вошли как <b>менеджер</b>.\n\n"
            "Все управление — в админ-панели:\n"
            f"{DASHBOARD_URL}\n\n"
            "Сюда будут приходить уведомления о новых заказах и сообщениях клиентов, "
            "когда вы на дежурстве (включается в админ-панели).",
        )
        return
    await send_welcome(message)


async def send_welcome(message: Message) -> None:
    await message.answer(
        "Привет! 👋 Рады видеть вас в LIZARD.\n\n"
        "Нажмите кнопку <b>«Открыть»</b> рядом с полем ввода — внутри товары в наличии "
        "и заказ любых вещей из Китая.",
        # Убираем «залипшую» reply-клавиатуру [Открыть магазин], которая могла
        # остаться у пользователей с прошлых версий бота.
        reply_markup=ReplyKeyboardRemove(),
    )



# ===================== HANDLERS DEEP-LINK ======================


async def handle_start_request(message: Message, bot: Bot, preset: str = None) -> None:
    """Клиент пришёл написать общий запрос на подбор товара.
    preset — необязательная категория из быстрых кнопок апки (shoes/bag/clothing/brand)."""
    # Человекочитаемые названия пресетов
    preset_names = {
        "shoes": "кроссовки / обувь",
        "clothing": "одежду",
        "accessories": "аксессуары",
        "brand": "вещь конкретного бренда",
    }
    preset_label = preset_names.get(preset)

    # Антиспам: уже есть открытый запрос?
    existing = await find_open_inquiry(message.from_user.id, "request")
    if existing:
        await message.answer(
            "У вас уже есть открытая заявка 🙌 Менеджер скоро свяжется — "
            "можно дописать детали прямо сюда."
        )
        # Тихое уведомление менеджерам — без имени и без подробностей.
        await notify_managers_brief(bot, "new_message")
        await supabase_patch("inquiries", {"id": f"eq.{existing['id']}"}, {"updated_at": now_iso()})
        return

    if preset_label:
        greeting = (
            f"Привет! 👋\n\n"
            f"Вы хотите заказать {preset_label} — отлично! "
            f"Пришлите ссылку, фото или опишите, что именно ищете, и мы подберём 💛"
        )
    else:
        greeting = (
            "Привет! 👋\n\n"
            "Расскажите, что хотите заказать — название, ссылку или просто фото. "
            "Подберём и привезём 💛"
        )
    await message.answer(greeting)
    # Создаём обращение в БД
    inquiry = await supabase_post("inquiries", {
        "customer_tg_id": message.from_user.id,
        "type": "request",
        "status": "new",
    })
    inquiry_id = inquiry.get("id") if inquiry else None
    number = inquiry.get("number") if inquiry else None

    # Сохраняем приветствие бота в историю с привязкой к новому обращению
    await save_message(
        message.from_user.id, "out", text=greeting,
        sender="bot", source="bot", inquiry_id=inquiry_id,
    )

    # Короткое обезличенное уведомление менеджерам — без имени/деталей.
    # Менеджер откроет админку и увидит всё там.
    await notify_managers_brief(bot, "new_inquiry")


async def handle_start_ask(message: Message, bot: Bot, product_id: str) -> None:
    """Клиент пришёл уточнить наличие размеров конкретного товара."""
    prod = await fetch_product(product_id)
    name = product_name(prod) if prod else f"товар {product_id}"

    # Антиспам: уже есть открытый вопрос по этому товару?
    existing = await find_open_inquiry(message.from_user.id, "product_question",
                                       product_id if prod else None)
    if existing:
        await message.answer(
            f"Вы уже спрашивали про «<b>{html.escape(name)}</b>» 🙌 "
            f"Менеджер скоро ответит — можно дописать детали сюда."
        )
        # Тихое уведомление менеджерам — без имени, без названия товара, без номера.
        await notify_managers_brief(bot, "new_message")
        await supabase_patch("inquiries", {"id": f"eq.{existing['id']}"}, {"updated_at": now_iso()})
        return

    await message.answer(
        f"Привет! 👋\n\n"
        f"Вы смотрите «<b>{html.escape(name)}</b>» — сейчас уточним размеры и наличие "
        f"и вернёмся к вам совсем скоро.\n\n"
        f"Можно сразу написать вопросы или прислать фото 📸"
    )
    inquiry = await supabase_post("inquiries", {
        "customer_tg_id": message.from_user.id,
        "type": "product_question",
        "product_id": product_id if prod else None,
        "status": "new",
    })
    inquiry_id = inquiry.get("id") if inquiry else None
    number = inquiry.get("number") if inquiry else None

    # Короткое уведомление менеджерам — без имени клиента, без названия товара.
    await notify_managers_brief(bot, "new_question")


async def handle_start_order(message: Message, bot: Bot, order_id: str) -> None:
    """Клиент только что оформил заказ в апке — показываем резюме и уведомляем менеджера."""
    order = await fetch_order(order_id)
    if not order:
        await message.answer(
            "Кажется, заказ ещё оформляется ⏳ Подождите пару секунд и загляните снова — "
            "или просто напишите нам, поможем."
        )
        return

    currency = order.get("currency") or "USD"
    items = order.get("items", [])
    total = float(order.get(f"total_{currency.lower()}") or 0)
    status = order.get("status") or "new"

    # Резюме клиенту
    client_lines = [f"Спасибо за заказ! 🎉 №{order_id}", ""]
    for it in items:
        prod = it.get("_product")
        name = product_name(prod)
        size = it.get("size")
        qty = it.get("qty") or 1
        snap_key = f"price_{currency.lower()}_snapshot"
        price = float(it.get(snap_key) or 0) * qty
        size_str = f" ({html.escape(size)})" if size else ""
        client_lines.append(
            f"• {html.escape(name)}{size_str} × {qty} — {fmt_price(price, currency)}"
        )
    client_lines.append("")
    client_lines.append(f"<b>Итого:</b> {fmt_price(total, currency)}")
    client_lines.append("")
    client_lines.append("Уже проверяем детали и скоро напишем по оплате 💛")
    client_summary = "\n".join(client_lines)
    await message.answer(client_summary)
    # Сохраняем подтверждение заказа в историю с привязкой к заказу
    await save_message(
        message.from_user.id, "out",
        text=re.sub(r"<[^>]+>", "", client_summary),  # убираем HTML-теги для хранения
        sender="bot", source="bot", order_id=int(order_id) if str(order_id).isdigit() else None,
    )

    # Короткое уведомление менеджерам — без номера/суммы/имени.
    await notify_managers_brief(bot, "new_order")


# ===================== СООБЩЕНИЯ ОТ КЛИЕНТА ====================

# Защита от спама уведомлениями: на одного клиента шлём «новое сообщение»
# не чаще раза в 5 минут. Внутри окна — копим в БД, но менеджеру не дёргаем.
_last_msg_notify_ts: dict = {}      # tg_id клиента → unix timestamp последнего уведомления
_MSG_NOTIFY_COOLDOWN_SEC = 5 * 60


def _should_notify_message(customer_tg_id: int) -> bool:
    """Решаем, дёргать ли менеджеров уведомлением о новом сообщении от клиента."""
    import time
    now = time.time()
    last = _last_msg_notify_ts.get(customer_tg_id)
    if last is not None and (now - last) < _MSG_NOTIFY_COOLDOWN_SEC:
        return False
    _last_msg_notify_ts[customer_tg_id] = now
    return True


@router.my_chat_member(ChatMemberUpdatedFilter(member_status_changed=KICKED))
async def on_bot_blocked(event: ChatMemberUpdated) -> None:
    """Клиент заблокировал бота. Telegram присылает это событие в реальном времени.
    Пишем в БД, чтобы дашборд показал менеджеру «клиент заблокировал бота»."""
    user = event.from_user
    if user is None or is_superadmin(user) or await is_manager(user):
        return  # игнорируем менеджеров/суперадмина
    try:
        await supabase_patch("customers", {"tg_id": f"eq.{user.id}"},
                             {"bot_blocked": True, "bot_blocked_at": now_iso()})
        log.info("Клиент %s (@%s) заблокировал бота", user.id, user.username or "")
    except Exception as e:
        log.warning("on_bot_blocked: не удалось обновить customers: %s", e)


@router.my_chat_member(ChatMemberUpdatedFilter(member_status_changed=MEMBER))
async def on_bot_unblocked(event: ChatMemberUpdated) -> None:
    """Клиент разблокировал бота (или впервые нажал Start). Снимаем флаг блокировки."""
    user = event.from_user
    if user is None or is_superadmin(user) or await is_manager(user):
        return
    try:
        await supabase_patch("customers", {"tg_id": f"eq.{user.id}"},
                             {"bot_blocked": False, "bot_blocked_at": now_iso()})
        log.info("Клиент %s (@%s) разблокировал бота", user.id, user.username or "")
    except Exception as e:
        log.warning("on_bot_unblocked: не удалось обновить customers: %s", e)


@router.message(F.text | F.photo | F.document | F.video | F.voice | F.video_note | F.audio | F.sticker)
async def handle_client_message(message: Message, bot: Bot) -> None:
    """
    Любое сообщение от клиента — сохраняем в БД и шлём короткое уведомление
    дежурным менеджерам. Сама переписка идёт в админке.
    Менеджеры в боте больше ничего не делают — их сообщения игнорируем.
    """
    user = message.from_user
    if not user:
        return
    if await is_manager(user):
        # Менеджер просто пишет боту — игнорируем. Вся работа в админке.
        return
    await forward_client_to_manager(message, bot)


async def forward_client_to_manager(message: Message, bot: Bot) -> None:
    """
    Принимает сообщение клиента: сохраняет в БД, при необходимости создаёт
    обращение «самотёком» и уведомляет дежурных менеджеров коротким текстом.
    Содержимое не пересылается — менеджер увидит всё в админке.
    """
    # Определяем контекст. Если активного заказа/обращения нет — создаём обращение,
    # чтобы сообщение не «висело в пустоте», а попало в dashboard как обращение,
    # и мягко подсказываем клиенту оформлять запросы через приложение.
    ctx = await get_active_context(message.from_user.id)
    created_new_inquiry = False
    if not ctx:
        inquiry = await supabase_post("inquiries", {
            "customer_tg_id": message.from_user.id,
            "type": "request",
            "status": "new",
        })
        if inquiry and inquiry.get("id"):
            ctx = {"inquiry_id": inquiry["id"]}
            created_new_inquiry = True
            # Мягкая подсказка клиенту (один раз — при создании обращения)
            try:
                hint = (
                    "Приняли ваше сообщение 🙌 Менеджер скоро ответит.\n\n"
                    "Подсказка: чтобы оформить заказ или подбор быстрее и удобнее — "
                    "откройте наше приложение и нажмите «Заказать товар». "
                    "Так мы сразу видим, что именно вам нужно 💛"
                )
                await retry_network(
                    lambda: bot.send_message(message.from_user.id, hint),
                    what="forward.hint")
                await save_message(
                    message.from_user.id, "out", text=hint,
                    sender="bot", source="bot", inquiry_id=inquiry["id"],
                )
            except Exception as e:
                log.warning("Не удалось отправить подсказку клиенту: %s", e)

    # Сохраняем входящее в БД с уже определённым контекстом
    await extract_and_save_incoming(message, bot, ctx=ctx)

    # Если дежурных нет — клиенту сообщаем, что подключения нет
    chats = await get_duty_chat_ids()
    if not chats:
        try:
            await message.answer(
                "⚠️ Менеджер пока не подключен. Попробуйте позже или напишите ему вручную."
            )
        except Exception:
            pass
        return

    # Уведомление менеджерам. Новое обращение — отдельный тип уведомления;
    # обычное сообщение — с rate-limit, чтобы не спамить при долгой переписке.
    if created_new_inquiry:
        await notify_managers_brief(bot, "new_inquiry")
    elif _should_notify_message(message.from_user.id):
        await notify_managers_brief(bot, "new_message")



# ============================ MAIN =============================

async def check_abandoned_carts(bot: Bot) -> None:
    """
    Один проход проверки брошенных корзин. Находит клиентов с непустой корзиной,
    которую не трогали >24ч, и кому ещё не слали напоминание для этого состояния.
    Шлёт одно мягкое напоминание.
    """
    if not supabase_ready():
        return
    try:
        # Берём все позиции корзины (в прототипе объём небольшой)
        items = await supabase_get("cart_items", {"select": "customer_tg_id,updated_at,qty"})
        if not items:
            return

        # Группируем по клиенту: суммарное кол-во и самое свежее изменение
        by_customer = {}
        for it in items:
            cid = it.get("customer_tg_id")
            if cid is None:
                continue
            upd = _parse_ts(it.get("updated_at"))
            cur = by_customer.get(cid)
            if not cur:
                by_customer[cid] = {"qty": it.get("qty") or 0, "last": upd}
            else:
                cur["qty"] += (it.get("qty") or 0)
                if upd and (cur["last"] is None or upd > cur["last"]):
                    cur["last"] = upd

        now = datetime.now(timezone.utc)
        threshold = timedelta(hours=24)

        for cid, info in by_customer.items():
            last = info["last"]
            if not last:
                continue
            # Корзина «заброшена», если последнее изменение было больше 24ч назад
            if (now - last) < threshold:
                continue

            # Проверяем клиента: есть ли chat_id (писал ли боту) и не слали ли уже
            rows = await supabase_get(
                "customers",
                {"tg_id": f"eq.{cid}", "select": "tg_id,cart_reminder_sent_at", "limit": "1"},
            )
            if not rows:
                continue
            sent_at = _parse_ts(rows[0].get("cart_reminder_sent_at"))
            # Уже напоминали для этого состояния корзины? (напоминание позже последнего изменения)
            if sent_at and sent_at >= last:
                continue

            # Шлём напоминание. chat_id для лички = tg_id клиента.
            try:
                delivered = await notify_client(
                    bot, cid,
                    "🛒 Вы оставили товары в корзине!\n\n"
                    "Они вас ждут — оформите заказ, пока всё в наличии. "
                    "Откройте магазин кнопкой «Открыть» ниже 💛",
                )
                if delivered:
                    await supabase_patch(
                        "customers", {"tg_id": f"eq.{cid}"},
                        {"cart_reminder_sent_at": now_iso()},
                    )
                    log.info("Напоминание о корзине отправлено клиенту %s", cid)
            except Exception as e:
                # Клиент не начинал диалог с ботом → написать первым нельзя. Это норма.
                log.debug("Не удалось напомнить клиенту %s: %s", cid, e)
    except Exception as e:
        log.warning("check_abandoned_carts error: %s", e)


async def abandoned_cart_worker(bot: Bot) -> None:
    """Периодически проверяет брошенные корзины (раз в час)."""
    while True:
        try:
            await check_abandoned_carts(bot)
        except Exception as e:
            log.warning("abandoned_cart_worker iteration failed: %s", e)
        await asyncio.sleep(3600)   # раз в час


async def process_outbox(bot: Bot) -> int:
    """
    Один проход по очереди исходящих с dashboard: берём неотправленные записи,
    шлём клиенту в Telegram, сохраняем в messages, помечаем sent_at.
    Возвращает количество обработанных записей (0 — очередь была пуста).
    """
    if not supabase_ready():
        return 0
    try:
        # Неотправленные записи (sent_at IS NULL), старейшие первыми
        rows = await supabase_get("outbox", {
            "select": "*",
            "sent_at": "is.null",
            "order": "created_at.asc",
            "limit": "20",
        })
        if not rows:
            return 0

        for row in rows:
            outbox_id = row["id"]
            customer_tg_id = row["customer_tg_id"]
            text = row.get("text")
            attachment_url = row.get("attachment_url")
            manager_username = row.get("manager_username")
            ctx_inquiry = row.get("inquiry_id")
            ctx_order = row.get("order_id")

            try:
                # Отправляем клиенту. Если есть вложение — шлём по URL, иначе текст.
                if attachment_url:
                    caption = text or None
                    await retry_network(
                        lambda: bot.send_photo(customer_tg_id, attachment_url, caption=caption),
                        what="outbox.send_photo")
                elif text:
                    await retry_network(
                        lambda: bot.send_message(customer_tg_id, text),
                        what="outbox.send_message")
                else:
                    # Пустая запись — нечего слать, просто закрываем
                    await supabase_patch("outbox", {"id": f"eq.{outbox_id}"},
                                         {"sent_at": now_iso(), "error": "empty"})
                    continue

                # Сохраняем в историю переписки (как ответ менеджера с сайта)
                await save_message(
                    customer_tg_id, "out",
                    text=text, sender="manager",
                    manager_username=manager_username,
                    attachment_url=attachment_url,
                    attachment_type=("photo" if attachment_url else None),
                    source="dashboard",
                    inquiry_id=ctx_inquiry, order_id=ctx_order,
                    delivery_status="delivered",
                )
                # Помечаем отправленным
                await supabase_patch("outbox", {"id": f"eq.{outbox_id}"},
                                     {"sent_at": now_iso()})

                # Успешная доставка — клиент НЕ заблокирован. Если был помечен
                # заблокированным (а событие разблокировки пропустили) — снимаем.
                try:
                    await supabase_patch("customers",
                                         {"tg_id": f"eq.{customer_tg_id}", "bot_blocked": "eq.true"},
                                         {"bot_blocked": False, "bot_blocked_at": now_iso()})
                except Exception:
                    pass

                # Активность по открытым обращениям клиента
                try:
                    await supabase_patch(
                        "inquiries",
                        {"customer_tg_id": f"eq.{customer_tg_id}", "status": "in.(new,in_progress)"},
                        {"updated_at": now_iso()},
                    )
                except Exception:
                    pass

            except TelegramForbiddenError:
                # Клиент заблокировал бота (или не нажимал Start) — помечаем outbox,
                # И записываем сообщение в историю с пометкой 'blocked', чтобы
                # менеджер видел: «я это писал, но клиент не получил».
                await supabase_patch("outbox", {"id": f"eq.{outbox_id}"},
                                     {"sent_at": now_iso(), "error": "blocked"})
                # Резервный механизм (если my_chat_member пропустили) — помечаем клиента.
                try:
                    await supabase_patch("customers", {"tg_id": f"eq.{customer_tg_id}"},
                                         {"bot_blocked": True, "bot_blocked_at": now_iso()})
                except Exception:
                    pass
                await save_message(
                    customer_tg_id, "out",
                    text=text, sender="manager",
                    manager_username=manager_username,
                    attachment_url=attachment_url,
                    attachment_type=("photo" if attachment_url else None),
                    source="dashboard",
                    inquiry_id=ctx_inquiry, order_id=ctx_order,
                    delivery_status="blocked",
                )
                log.info("Outbox %s: клиент %s заблокировал бота", outbox_id, customer_tg_id)
            except _RETRYABLE as e:
                # Сетевой сбой даже после ретраев — НЕ закрываем запись.
                # Оставляем в очереди: следующий цикл воркера попробует снова,
                # когда сеть восстановится. Сообщение не потеряется.
                log.warning("Outbox %s: сеть недоступна, оставляю в очереди (%s)",
                            outbox_id, type(e).__name__)
            except Exception as e:
                # Окончательная (несетевая) ошибка — помечаем, чтобы не застряло навсегда.
                # Тоже пишем в историю с пометкой 'failed'.
                await supabase_patch("outbox", {"id": f"eq.{outbox_id}"},
                                     {"sent_at": now_iso(), "error": str(e)[:200]})
                await save_message(
                    customer_tg_id, "out",
                    text=text, sender="manager",
                    manager_username=manager_username,
                    attachment_url=attachment_url,
                    attachment_type=("photo" if attachment_url else None),
                    source="dashboard",
                    inquiry_id=ctx_inquiry, order_id=ctx_order,
                    delivery_status="failed",
                )
                log.warning("Outbox %s send failed: %s", outbox_id, e)
        return len(rows)
    except Exception as e:
        log.warning("process_outbox error: %s", e)
        return 0


async def outbox_worker(bot: Bot) -> None:
    """
    Разбирает очередь исходящих с dashboard.
    Адаптивный интервал: пока есть работа — опрашиваем часто (2с), при пустой
    очереди постепенно увеличиваем паузу (2→5→10→30с), чтобы не нагружать БД
    и не засорять логи холостыми запросами. Появилась работа — снова 2с.
    """
    INTERVALS = [2, 3, 5, 10]   # лесенка задержек при простое (макс 10с — баланс отклика и нагрузки)
    idx = 0
    while True:
        try:
            processed = await process_outbox(bot)
            if processed > 0:
                idx = 0                     # была работа — опрашиваем часто
            else:
                idx = min(idx + 1, len(INTERVALS) - 1)   # простой — замедляемся
        except Exception as e:
            log.warning("outbox_worker iteration failed: %s", e)
            idx = 0                         # при ошибке вернёмся к частому опросу
        await asyncio.sleep(INTERVALS[idx])


# ============================ HEALTH MONITORING ============================
#
# Бот раз в 30 сек пишет heartbeat в БД (доказывает что он жив). Админка
# в браузере менеджеров видит свежесть last_seen и судит о состоянии бота.
#
# Отдельный воркер раз в 90 сек проверяет таблицу health_status: если статус
# какого-то компонента сменился с 'ok' на 'down' (или обратно) — рассылает
# короткое уведомление дежурным менеджерам. С дедупликацией: не чаще раза
# в HEALTH_ALERT_COOLDOWN_SEC на один компонент.

HEARTBEAT_INTERVAL_SEC = 30
HEALTH_ALERT_INTERVAL_SEC = 90
HEALTH_ALERT_COOLDOWN_SEC = 15 * 60   # не больше 1 алерта ОДНОГО ТИПА на компонент в 15 минут
# Какое состояние мы помним между итерациями (чтобы засечь СМЕНУ состояния)
_health_known_state: dict = {}        # component -> 'ok' | 'down'
# Счётчик «нестабильных» наблюдений: компонент должен показать `down` подряд
# несколько раз чтобы мы считали это реальным сбоем (а не сетевым моргуном).
_health_down_streak: dict = {}        # component -> int
DOWN_CONFIRM_COUNT = 2                # сколько подряд `down` нужно для алерта
# Когда последний раз слали алерт каждого типа на компонент.
# Это разнесено, чтобы cooldown «упал» не блокировал «восстановлено» (баг fix).
_last_alert_sent: dict = {}           # (component, kind) -> datetime, где kind = 'down' | 'ok'


async def heartbeat_worker(bot: Bot) -> None:
    """Раз в HEARTBEAT_INTERVAL_SEC обновляет bot_heartbeat.last_seen = now()."""
    while True:
        try:
            await supabase_patch("bot_heartbeat", {"id": "eq.1"}, {"last_seen": now_iso()})
        except Exception as e:
            log.warning("heartbeat_worker failed: %s", e)
        await asyncio.sleep(HEARTBEAT_INTERVAL_SEC)


def _health_label(component: str) -> str:
    return {
        "db":      "База данных",
        "storage": "Файловое хранилище",
        "bot":     "Telegram-бот",
        "app":     "Клиентское приложение",
    }.get(component, component)


async def health_alert_worker(bot: Bot) -> None:
    """
    Раз в HEALTH_ALERT_INTERVAL_SEC читает health_status. Алертит дежурных при:
      - down подряд DOWN_CONFIRM_COUNT раз  →  «⚠️ Проблема»
      - down → ok                            →  «✅ Восстановлен»
    Алерты группируются (если за итерацию упало/восстановилось несколько компонентов).
    Cooldown применяется к каждому виду отдельно: «упал» не блокирует «восстановлено».
    """
    global _health_known_state
    is_first = True
    while True:
        try:
            rows = await supabase_get("health_status", {
                "select": "component,status,error_message",
            })
            new_state = {r["component"]: r["status"] for r in (rows or [])}

            if is_first:
                _health_known_state = new_state
                is_first = False
                await asyncio.sleep(HEALTH_ALERT_INTERVAL_SEC)
                continue

            # Собираем компоненты для двух типов алертов:
            #   to_alert_down  — упавшие (подтверждённые DOWN_CONFIRM_COUNT раз подряд)
            #   to_alert_ok    — восстановленные после реального сбоя
            to_alert_down = []  # list of (component, error_message)
            to_alert_ok   = []  # list of component

            now = datetime.now(timezone.utc)

            for r in (rows or []):
                comp = r["component"]
                new_status = r["status"]
                old_status = _health_known_state.get(comp)

                # Компонент 'bot' мониторит ВНЕШНИЙ watchdog (pg_cron в Supabase),
                # а не сам бот — иначе при смерти бота некому слать алерт.
                # Здесь пропускаем, чтобы не было дублей с dead-man's-switch.
                if comp == "bot":
                    continue

                # === Логика подтверждения "down" (защита от моргунов) ===
                if new_status == "down":
                    _health_down_streak[comp] = _health_down_streak.get(comp, 0) + 1
                else:
                    # Сбрасываем счётчик при любом не-down статусе
                    _health_down_streak[comp] = 0

                # Игнорируем переходы в unknown — это не сбой, а потеря наблюдения
                if new_status == "unknown":
                    continue
                # unknown → ok — не «восстановление», просто первое подтверждение
                if old_status == "unknown" and new_status == "ok":
                    continue

                if new_status == "down":
                    # Алертим только если: (1) ещё не алертили «down» по этому компоненту
                    #                     (2) накопилось DOWN_CONFIRM_COUNT подтверждений
                    streak = _health_down_streak.get(comp, 0)
                    if streak < DOWN_CONFIRM_COUNT:
                        continue
                    # Cooldown по типу 'down': не шлём чаще раза в COOLDOWN
                    last = _last_alert_sent.get((comp, "down"))
                    if last and (now - last).total_seconds() < HEALTH_ALERT_COOLDOWN_SEC:
                        continue
                    # Не алертим если в _health_known_state уже было 'down'
                    # (это означает что мы уже отправляли алерт ранее)
                    if old_status == "down":
                        continue
                    to_alert_down.append((comp, r.get("error_message") or ""))

                elif new_status == "ok":
                    # Восстановление: алертим только если был реальный сбой
                    # (мы отправляли алерт «down» по этому компоненту)
                    if old_status != "down":
                        continue
                    # Cooldown по типу 'ok'
                    last = _last_alert_sent.get((comp, "ok"))
                    if last and (now - last).total_seconds() < HEALTH_ALERT_COOLDOWN_SEC:
                        continue
                    to_alert_ok.append(comp)

            # === Отправка алертов (сгруппированных) ===
            chats = await get_duty_chat_ids() if (to_alert_down or to_alert_ok) else []

            if to_alert_down and chats:
                if len(to_alert_down) == 1:
                    comp, err = to_alert_down[0]
                    text = (
                        f"⚠️ <b>Проблема с сервисом</b>\n\n"
                        f"Компонент: <b>{_health_label(comp)}</b>\n"
                        f"Статус: ❌ недоступен"
                    )
                    if err:
                        text += f"\n\n<i>{html.escape(err[:200])}</i>"
                    text += "\n\nЕсли проблема не уйдёт сама — проверь работу сервиса вручную."
                else:
                    labels = "\n".join(f"  • {_health_label(c)}" for c, _ in to_alert_down)
                    text = (
                        f"⚠️ <b>Проблемы с сервисами</b>\n\n"
                        f"Сразу несколько компонентов недоступны:\n{labels}\n\n"
                        f"Возможно, это сетевая проблема или общий сбой провайдера. "
                        f"Если не восстановится в течение пары минут — проверь вручную."
                    )
                for chat in chats:
                    try:
                        await retry_network(lambda: bot.send_message(chat, text), what="health_alert_down")
                    except Exception as e:
                        log.warning("health alert (down) send to %s failed: %s", chat, e)
                for comp, _ in to_alert_down:
                    _last_alert_sent[(comp, "down")] = now

            if to_alert_ok and chats:
                if len(to_alert_ok) == 1:
                    text = f"✅ Компонент восстановлен: <b>{_health_label(to_alert_ok[0])}</b>"
                else:
                    labels = "\n".join(f"  • {_health_label(c)}" for c in to_alert_ok)
                    text = f"✅ <b>Сервисы восстановлены</b>\n\n{labels}"
                for chat in chats:
                    try:
                        await retry_network(lambda: bot.send_message(chat, text), what="health_alert_ok")
                    except Exception as e:
                        log.warning("health alert (ok) send to %s failed: %s", chat, e)
                for comp in to_alert_ok:
                    _last_alert_sent[(comp, "ok")] = now

            # Обновляем «известное состояние» — но только в той части, где мы
            # уверены в результате. Для down — только если streak подтверждён.
            # Для остальных — обновляем как есть.
            confirmed_state = {}
            for comp, status in new_state.items():
                if status == "down" and _health_down_streak.get(comp, 0) < DOWN_CONFIRM_COUNT:
                    # Не подтверждено — оставляем старое значение, чтобы не считать
                    # одиночный моргун за реальный сбой
                    confirmed_state[comp] = _health_known_state.get(comp, "unknown")
                else:
                    confirmed_state[comp] = status
            _health_known_state = confirmed_state

        except Exception as e:
            log.warning("health_alert_worker iteration failed: %s", e)
        await asyncio.sleep(HEALTH_ALERT_INTERVAL_SEC)


async def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN не задан")
    if not supabase_ready():
        log.warning("SUPABASE_URL/SUPABASE_ANON_KEY не заданы — заказы и товары не будут читаться из БД")

    bot = Bot(
        token=BOT_TOKEN,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dp = Dispatcher()
    dp.include_router(router)

    await bot.delete_webhook(drop_pending_updates=False)
    log.info("Bot started. Superadmin: @%s, WebApp: %s", SUPERADMIN_USERNAME, WEBAPP_URL)
    # Прогреваем кеш менеджеров
    try:
        await reload_managers()
        log.info("Загружено менеджеров: %d", len(_managers_cache))
    except Exception as e:
        log.warning("Не удалось загрузить менеджеров: %s", e)
    if get_superadmin_chat_id() is None:
        log.warning("Суперадмин не сделал /start — fallback-уведомления некуда слать.")

    # Фоновый процесс напоминаний о брошенной корзине
    asyncio.create_task(abandoned_cart_worker(bot))
    # Фоновый процесс отправки ответов из dashboard
    asyncio.create_task(outbox_worker(bot))
    # Heartbeat — доказательство «бот жив» для мониторинга в админке
    asyncio.create_task(heartbeat_worker(bot))
    # Воркер алертов: смотрит health_status и шлёт уведомления при сбоях
    asyncio.create_task(health_alert_worker(bot))

    try:
        # allowed_updates явно включает my_chat_member (блокировка/разблокировка бота).
        # resolve_used_update_types() сам определит все типы по зарегистрированным
        # хендлерам, включая наши my_chat_member.
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        # Закрываем переиспользуемый HTTP-клиент
        global _http_client
        if _http_client is not None and not _http_client.is_closed:
            await _http_client.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        log.info("Bot stopped.")
