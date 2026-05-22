"""
Telegram-бот «Магазин одежды + заказ из Китая».
Архитектура: бот-посредник между клиентами и менеджером.

Стек: Python 3.10+, aiogram 3.x, httpx.

Что делает бот:
1. Команда /start без параметров — показывает приветствие (магазин открывается штатной кнопкой «Открыть»).
2. Команда /start request — клиент пришёл из апки оформить общий запрос на подбор.
   Бот пишет клиенту приветствие и ждёт сообщения, чтобы переслать менеджеру.
3. Команда /start ask_<product_id> — клиент пришёл уточнить размеры конкретного товара.
   Бот читает товар из Supabase, шлёт клиенту контекст («вы интересуетесь товаром X»)
   и параллельно уведомляет менеджера.
4. Команда /start order_<order_id> — клиент только что оформил заказ в апке.
   Бот читает заказ из Supabase, шлёт клиенту резюме заказа и уведомляет менеджера.
5. Все обычные сообщения от клиента (текст, фото, документы) пересылаются менеджеру
   с заголовком «От @username» — это reply-target.
6. Когда менеджер делает reply на сообщение в своём чате с ботом, бот находит
   соответствующего клиента по message_id и пересылает ему ответ.

Менеджер один. У него один чат с ботом — все клиенты в одном потоке. Контекст конкретного
клиента понятен по заголовку входящего сообщения, ответ адресуется через reply.

Установка:
    pip install aiogram httpx

Запуск:
    export BOT_TOKEN="123:ABC..."
    export WEBAPP_URL="https://your.site/index.html"
    export MANAGER_USERNAME="rogovtsoff"      # без @
    export SUPABASE_URL="https://xxx.supabase.co"
    export SUPABASE_ANON_KEY="eyJ..."
    python bot.py

Менеджер должен один раз отправить /start боту — бот запомнит его chat_id.
"""

import asyncio
import html
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import httpx
from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart, CommandObject
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    ReplyKeyboardRemove,
)


# ============================ КОНФИГ ============================

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://example.com/index.html")
# Суперадмин — единственный, кто может добавлять/удалять менеджеров.
# MANAGER_USERNAME оставлен для обратной совместимости: трактуется как суперадмин.
SUPERADMIN_USERNAME = os.getenv(
    "SUPERADMIN_USERNAME",
    os.getenv("MANAGER_USERNAME", "rogovtsoff"),
).lstrip("@").lower()
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY", "")

MANAGER_FILE = Path("manager_chat.txt")
# message_id (в чате менеджера) → tg_id клиента. Нужно для reply-routing.
ROUTING_FILE = Path("routing.json")

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


def load_routing() -> dict:
    """{ manager_message_id (str): client_tg_id (int) }"""
    if ROUTING_FILE.exists():
        try:
            return json.loads(ROUTING_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_routing(data: dict) -> None:
    # Ограничиваем размер файла: храним последние 500 записей
    if len(data) > 500:
        keys = sorted(data.keys(), key=int)[-500:]
        data = {k: data[k] for k in keys}
    ROUTING_FILE.write_text(json.dumps(data, ensure_ascii=False))


def add_routing(manager_msg_id: int, client_tg_id: int) -> None:
    data = load_routing()
    data[str(manager_msg_id)] = client_tg_id
    save_routing(data)


def get_routed_client(manager_msg_id: int) -> Optional[int]:
    return load_routing().get(str(manager_msg_id))


# Состояние пошагового создания заказа менеджером (менеджер один, поэтому
# простого словаря по chat_id достаточно). Сбрасывается после завершения/отмены.
#   { manager_chat_id: { "step": ..., "customer_tg_id": ..., "product_id": ..., ... } }
manager_order_draft: dict = {}

# Ожидание ввода заметки к заказу: { manager_chat_id: order_id }
manager_note_wait: dict = {}


# ========================== SUPABASE ===========================

def supabase_ready() -> bool:
    return bool(SUPABASE_URL and SUPABASE_KEY)


async def supabase_get(path: str, params: dict = None) -> Optional[list]:
    """GET-запрос к Supabase REST API. Возвращает список объектов или None."""
    if not supabase_ready():
        log.warning("Supabase не настроен — пропускаю запрос %s", path)
        return None
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url, headers=headers, params=params or {})
            if r.status_code >= 400:
                log.error("Supabase %s failed: %s %s", path, r.status_code, r.text[:200])
                return None
            return r.json()
    except Exception as e:
        log.exception("Supabase request error: %s", e)
        return None


async def supabase_patch(path: str, params: dict, body: dict) -> bool:
    """PATCH-запрос (UPDATE) к Supabase REST API. Возвращает True при успехе."""
    if not supabase_ready():
        return False
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.patch(url, headers=headers, params=params, json=body)
            if r.status_code >= 400:
                log.error("Supabase PATCH %s failed: %s %s", path, r.status_code, r.text[:200])
                return False
            return True
    except Exception as e:
        log.exception("Supabase PATCH error: %s", e)
        return False


async def supabase_post(path: str, body: dict) -> Optional[dict]:
    """POST (INSERT) к Supabase REST API. Возвращает созданную запись или None."""
    if not supabase_ready():
        return None
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, headers=headers, json=body)
            if r.status_code >= 400:
                log.error("Supabase POST %s failed: %s %s", path, r.status_code, r.text[:200])
                return None
            data = r.json()
            return data[0] if isinstance(data, list) and data else data
    except Exception as e:
        log.exception("Supabase POST error: %s", e)
        return None


async def supabase_delete(path: str, params: dict) -> bool:
    """DELETE к Supabase REST API. Возвращает True при успехе."""
    if not supabase_ready():
        return False
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Prefer": "return=minimal",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.delete(url, headers=headers, params=params)
            if r.status_code >= 400:
                log.error("Supabase DELETE %s failed: %s %s", path, r.status_code, r.text[:200])
                return False
            return True
    except Exception as e:
        log.exception("Supabase DELETE error: %s", e)
        return False


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
    """Когда менеджер пишет боту — сохраняем его chat_id и tg_id в таблице."""
    if user is None or is_superadmin(user):
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


async def fetch_hidden_products(limit: int = 8) -> list:
    """Последние скрытые (is_active=false) товары — для выбора при ручном создании заказа."""
    rows = await supabase_get("products", {
        "is_active": "eq.false",
        "order": "id.desc",
        "limit": str(limit),
    })
    return rows or []


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


async def create_order_for_customer(customer_tg_id: int, items: list,
                                    status: str) -> Optional[dict]:
    """
    Создаёт заказ для клиента (ручное оформление менеджером) с одной или
    несколькими позициями. items = [{product_id, size, qty}, ...].
    Возвращает созданный заказ (с items) или None.
    """
    if not items:
        return None

    currency = "USD"
    total_usd = 0.0
    total_byn = 0.0
    resolved = []   # позиции с подгруженными товарами и ценами

    for it in items:
        prod = await fetch_product(it["product_id"])
        if not prod:
            continue
        qty = int(it.get("qty") or 1)
        price_usd = float(prod.get("price_usd") or 0)
        price_byn = float(prod.get("price_byn") or 0)
        total_usd += price_usd * qty
        total_byn += price_byn * qty
        resolved.append({
            "product_id": it["product_id"],
            "size": it.get("size"),
            "qty": qty,
            "price_usd_snapshot": price_usd,
            "price_byn_snapshot": price_byn,
            "_product": prod,
        })

    if not resolved:
        return None

    is_paid = (status == "paid")
    order = await supabase_post("orders", {
        "customer_tg_id": customer_tg_id,
        "total_usd": total_usd,
        "total_byn": total_byn,
        "currency": currency,
        "status": status,
        "is_paid": is_paid,
    })
    if not order:
        return None

    # Вставляем все позиции
    inserted_any = False
    for r in resolved:
        item_ok = await supabase_post("order_items", {
            "order_id": order["id"],
            "product_id": r["product_id"],
            "size": r["size"],
            "qty": r["qty"],
            "price_usd_snapshot": r["price_usd_snapshot"],
            "price_byn_snapshot": r["price_byn_snapshot"],
        })
        if item_ok is not None:
            inserted_any = True

    if not inserted_any:
        await supabase_patch("orders", {"id": f"eq.{order['id']}"}, {"status": "cancelled"})
        return None

    order["items"] = resolved
    return order


# ========================== УТИЛИТЫ ============================

def client_mention(message: Message) -> str:
    user = message.from_user
    if user is None:
        return "Аноним"
    name = user.full_name or "Пользователь"
    if user.username:
        return f"@{user.username} ({html.escape(name)})"
    return f'<a href="tg://user?id={user.id}">{html.escape(name)}</a>'


def product_name(prod: dict) -> str:
    if not prod:
        return "—"
    return prod.get("name_ru") or prod.get("name_en") or prod.get("id") or "—"


def fmt_price(amount: float, currency: str) -> str:
    s = f"{amount:.2f}".rstrip("0").rstrip(".")
    if not s:
        s = "0"
    return f"${s}" if currency == "USD" else f"{s} BYN"


# Часовой пояс Беларуси (UTC+3, без перехода на летнее время с 2011)
BELARUS_TZ = timezone(timedelta(hours=3))


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


def fmt_dt(ts: str) -> str:
    """Точное время в поясе Беларуси: '20.05 в 14:30'."""
    dt = _parse_ts(ts)
    if not dt:
        return "—"
    local = dt.astimezone(BELARUS_TZ)
    return local.strftime("%d.%m в %H:%M")


def fmt_ago(ts: str) -> str:
    """Относительное время: 'только что', '5 мин назад', '3 ч назад', '2 дня назад'."""
    dt = _parse_ts(ts)
    if not dt:
        return ""
    now = datetime.now(timezone.utc)
    sec = (now - dt).total_seconds()
    if sec < 0:
        sec = 0
    if sec < 60:
        return "только что"
    mins = int(sec // 60)
    if mins < 60:
        return f"{mins} мин назад"
    hours = int(sec // 3600)
    if hours < 24:
        return f"{hours} ч назад"
    days = int(sec // 86400)
    if days < 30:
        # склонение «день/дня/дней»
        d = days % 10
        dd = days % 100
        if d == 1 and dd != 11:
            word = "день"
        elif d in (2, 3, 4) and dd not in (12, 13, 14):
            word = "дня"
        else:
            word = "дней"
        return f"{days} {word} назад"
    months = int(days // 30)
    return f"{months} мес назад"


def fmt_created_line(ts: str) -> str:
    """Строка 'Создан' с точным временем и относительным."""
    return f"🕐 Создан: {fmt_dt(ts)} ({fmt_ago(ts)})"


def fmt_activity_line(ts: str) -> str:
    """Строка 'Активность' (последнее обновление)."""
    return f"⏱ Активность: {fmt_ago(ts)}"


def now_iso() -> str:
    """Текущее время в UTC ISO — для записи в updated_at."""
    return datetime.now(timezone.utc).isoformat()


async def notify_manager(bot: Bot, text: str, client_tg_id: int,
                         reply_markup: Optional[InlineKeyboardMarkup] = None) -> Optional[int]:
    """
    Рассылает сообщение всем дежурным менеджерам (fallback — суперадмин).
    Reply на любую из копий маршрутизируется обратно клиенту.
    Возвращает message_id ПЕРВОЙ отправленной копии (для привязки manager_msg_id
    к карточке — её редактирование делает тот, кто нажмёт кнопку).
    """
    chats = await get_duty_chat_ids()
    if not chats:
        log.warning("Нет дежурных менеджеров и суперадмин не сделал /start")
        return None
    first_msg_id = None
    for chat in chats:
        try:
            sent = await bot.send_message(chat, text, reply_markup=reply_markup)
            add_routing(sent.message_id, client_tg_id)
            if first_msg_id is None:
                first_msg_id = sent.message_id
        except Exception as e:
            log.warning("Failed to notify manager chat %s: %s", chat, e)
    return first_msg_id


async def notify_duty_plain(bot: Bot, text: str) -> None:
    """Простое уведомление всем дежурным менеджерам (без routing-привязки)."""
    for chat in await get_duty_chat_ids():
        try:
            await bot.send_message(chat, text)
        except Exception as e:
            log.warning("notify_duty_plain failed for %s: %s", chat, e)


async def send_card_to_chat(bot: Bot, chat_id: int, text: str, client_tg_id: int,
                            reply_markup: Optional[InlineKeyboardMarkup] = None) -> Optional[int]:
    """
    Отправляет карточку В ОДИН чат (тому, кто нажал «Открыть») + привязывает routing.
    В отличие от notify_manager, не рассылает всем дежурным.
    """
    try:
        sent = await bot.send_message(chat_id, text, reply_markup=reply_markup)
        add_routing(sent.message_id, client_tg_id)
        return sent.message_id
    except Exception as e:
        log.warning("send_card_to_chat failed for %s: %s", chat_id, e)
        return None


# ===================== СТАТУСЫ ЗАКАЗОВ =========================
#
# Воронка статусов под выкуп товара из Китая. Для каждого статуса:
#   - label: как показывается менеджеру и клиенту
#   - client_msg: что отправляется клиенту при переходе в этот статус (None = не уведомлять)
#   - next: какие переходы доступны (показываются кнопками)

ORDER_STATUS = {
    "new":              {"label": "🆕 Новый",            "client_msg": None},
    "in_progress":      {"label": "✋ В работе",          "client_msg": "Взяли ваш заказ в работу 🙌 Скоро вернёмся с деталями."},
    "awaiting_payment": {"label": "💳 Ждёт оплаты",       "client_msg": "Всё подтвердили! Пришлём реквизиты для оплаты — и сразу выкупаем."},
    "paid":             {"label": "✅ Оплачен",           "client_msg": "Оплату получили, спасибо! 🎉 Начинаем выкуп."},
    "purchasing":       {"label": "🛒 Выкупаем",          "client_msg": "Выкупаем ваш товар. Следующий шаг — отправка в Беларусь."},
    "shipping":         {"label": "🚚 В пути",            "client_msg": "Заказ уже едет к нам 🚚 Дорога обычно занимает 3–4 недели. Напишем сразу, как он приедет."},
    "ready":            {"label": "📦 Готов к выдаче",    "client_msg": "Ваш заказ приехал! 🎁 Договоримся, когда вам удобно примерить и забрать."},
    "completed":        {"label": "🎉 Выдан",             "client_msg": "Готово! Спасибо, что выбрали нас 💛 Будем рады видеть снова."},
    "cancelled":        {"label": "❌ Отменён",           "client_msg": "Заказ отменили. Если что-то пошло не так — напишите, всё поправим."},
}

# Доступные переходы из каждого статуса (что показывать кнопками)
INQUIRY_STATUS = {
    "new":         {"label": "🆕 Новое",     "client_msg": None},
    "in_progress": {"label": "✋ В работе",   "client_msg": "Получили ваше сообщение 🙌 Скоро ответим!"},
    "closed":      {"label": "✅ Закрыто",    "client_msg": "Спасибо за обращение! 💛 Если появятся вопросы — пишите в любой момент."},
}
INQUIRY_TRANSITIONS = {
    "new":         ["in_progress", "closed"],
    "in_progress": ["closed"],
    "closed":      ["in_progress"],
}


def order_keyboard(order_id: str, status: str) -> InlineKeyboardMarkup:
    """Кнопки всех статусов заказа (кроме текущего). callback_data = 'os:<order_id>:<new_status>'.
    Менеджер может перевести заказ в любой статус в один тап."""
    # Порядок кнопок = порядок воронки. Текущий статус пропускаем.
    order = ["new", "in_progress", "awaiting_payment", "paid",
             "purchasing", "shipping", "ready", "completed", "cancelled"]
    rows, row = [], []
    for st in order:
        if st == status:
            continue
        label = ORDER_STATUS[st]["label"]
        row.append(InlineKeyboardButton(text=label, callback_data=f"os:{order_id}:{st}"))
        if len(row) == 2:
            rows.append(row); row = []
    if row:
        rows.append(row)
    # Кнопка добавления/изменения внутренней заметки
    rows.append([InlineKeyboardButton(text="📝 Заметка", callback_data=f"note:{order_id}")])
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else InlineKeyboardMarkup(inline_keyboard=[[]])


def inquiry_keyboard(inquiry_id: str, status: str) -> InlineKeyboardMarkup:
    """Кнопки управления обращением: статусы + «Оформить заказ»."""
    rows = []
    row = []
    for nxt in INQUIRY_TRANSITIONS.get(status, []):
        label = INQUIRY_STATUS[nxt]["label"]
        row.append(InlineKeyboardButton(text=label, callback_data=f"is:{inquiry_id}:{nxt}"))
        if len(row) == 2:
            rows.append(row); row = []
    if row:
        rows.append(row)
    # Кнопка создания заказа для клиента этого обращения
    rows.append([InlineKeyboardButton(text="➕ Оформить заказ", callback_data=f"mko:{inquiry_id}")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def order_card_text(order: dict, status: str) -> str:
    """Текст карточки заказа в чате менеджера."""
    order_id = str(order.get("id"))
    currency = order.get("currency") or "USD"
    items = order.get("items", [])
    total = float(order.get(f"total_{currency.lower()}") or 0)

    lines = [
        f"🛒 <b>Заказ №{order_id}</b>",
        f"Статус: {ORDER_STATUS.get(status, {}).get('label', status)}",
    ]
    if order.get("created_at"):
        lines.append(fmt_created_line(order["created_at"]))
    if order.get("updated_at"):
        lines.append(fmt_activity_line(order["updated_at"]))
    lines.append("─────────────")
    for it in items:
        prod = it.get("_product")
        name = product_name(prod)
        size = it.get("size")
        qty = it.get("qty") or 1
        snap = float(it.get(f"price_{currency.lower()}_snapshot") or 0) * qty
        size_str = f" ({html.escape(size)})" if size else ""
        lines.append(f"• {html.escape(name)}{size_str} × {qty} — {fmt_price(snap, currency)}")
    lines.append("")
    lines.append(f"<b>Итого:</b> {fmt_price(total, currency)}")
    note = order.get("manager_note")
    if note:
        lines.append("")
        lines.append(f"📝 <i>{html.escape(note)}</i>")
    return "\n".join(lines)


# ============================ /start ===========================

@router.message(CommandStart(deep_link=True))
async def cmd_start_deeplink(message: Message, command: CommandObject, bot: Bot) -> None:
    """
    /start <param> — клиент пришёл из апки с конкретным контекстом.
    Поддерживаем: request, ask_<product_id>, order_<order_id>.
    """
    param = (command.args or "").strip()
    user = message.from_user
    if not user:
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
        await message.answer(
            "✅ Вы вошли как <b>суперадмин</b>.\n"
            "Новые заказы и обращения приходят дежурным менеджерам "
            "(или сюда, если дежурных нет).\n\n"
            "Управление менеджерами:\n"
            "• /managers — список\n"
            "• /addmanager @username или id — добавить\n"
            "• /delmanager @username или id — удалить\n"
            "• /duty @username — поставить/снять с дежурства\n"
            "• /active — активные заказы и обращения",
        )
        return

    if await is_manager(user):
        await update_manager_chat(user)
        await message.answer(
            "✅ Вы вошли как <b>менеджер</b>.\n"
            "Новые заказы и обращения будут приходить сюда, когда вы на дежурстве.\n\n"
            "• /online — встать на дежурство\n"
            "• /offline — снять дежурство\n"
            "• /active — активные заказы и обращения\n"
            "Чтобы ответить клиенту — делайте <b>reply</b> на его сообщение.",
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


# ===================== УПРАВЛЕНИЕ МЕНЕДЖЕРАМИ =================
# Все команды управления регистрируются ДО обработчика обычных сообщений.

def _parse_manager_arg(text: str) -> dict:
    """Разбирает аргумент команды: @username или числовой tg_id."""
    parts = (text or "").split(maxsplit=1)
    if len(parts) < 2:
        return {}
    arg = parts[1].strip()
    if arg.startswith("@"):
        return {"username": arg[1:].lower()}
    if arg.lstrip("-").isdigit():
        return {"tg_id": int(arg)}
    return {"username": arg.lower()}


@router.message(Command("managers"))
async def cmd_managers(message: Message, bot: Bot) -> None:
    """Список менеджеров. Только суперадмин."""
    if not is_superadmin(message.from_user):
        return
    mgrs = await reload_managers()
    if not mgrs:
        await message.answer(
            "Менеджеров пока нет.\n"
            "Добавьте: /addmanager @username или /addmanager 12345"
        )
        return
    lines = ["👥 <b>Менеджеры:</b>", ""]
    for m in mgrs:
        duty = "🟢 на дежурстве" if m.get("is_on_duty") else "⚪️ не дежурит"
        who = f"@{m['username']}" if m.get("username") else f"id {m.get('tg_id')}"
        lines.append(f"• {who} — {duty}")
    lines.append("")
    lines.append("Управление: /duty @username, /delmanager @username")
    await message.answer("\n".join(lines))


@router.message(Command("addmanager"))
async def cmd_addmanager(message: Message, bot: Bot) -> None:
    """Добавить менеджера по @username или tg_id. Только суперадмин."""
    if not is_superadmin(message.from_user):
        return
    arg = _parse_manager_arg(message.text)
    if not arg:
        await message.answer("Укажите менеджера: /addmanager @username или /addmanager 12345")
        return
    for m in await get_managers():
        if arg.get("tg_id") and m.get("tg_id") and int(m["tg_id"]) == arg["tg_id"]:
            await message.answer("Этот менеджер уже добавлен.")
            return
        if arg.get("username") and m.get("username") and m["username"].lower() == arg["username"]:
            await message.answer("Этот менеджер уже добавлен.")
            return
    row = {
        "is_on_duty": True,
        "added_by": (message.from_user.username or "").lower(),
    }
    row.update(arg)
    created = await supabase_post("managers", row)
    await reload_managers()
    if created:
        who = f"@{arg['username']}" if arg.get("username") else f"id {arg['tg_id']}"
        await message.answer(
            f"✅ {who} добавлен как менеджер (на дежурстве).\n"
            f"Пусть напишет боту /start, чтобы начать получать заказы."
        )
    else:
        await message.answer("⚠️ Не удалось добавить. Попробуйте ещё раз.")


@router.message(Command("delmanager"))
async def cmd_delmanager(message: Message, bot: Bot) -> None:
    """Удалить менеджера. Только суперадмин."""
    if not is_superadmin(message.from_user):
        return
    arg = _parse_manager_arg(message.text)
    if not arg:
        await message.answer("Укажите менеджера: /delmanager @username или /delmanager 12345")
        return
    if arg.get("tg_id"):
        ok = await supabase_delete("managers", {"tg_id": f"eq.{arg['tg_id']}"})
    else:
        ok = await supabase_delete("managers", {"username": f"eq.{arg['username']}"})
    await reload_managers()
    if ok:
        who = f"@{arg['username']}" if arg.get("username") else f"id {arg['tg_id']}"
        await message.answer(f"✅ {who} больше не менеджер.")
    else:
        await message.answer("⚠️ Не удалось удалить (возможно, такого менеджера нет).")


@router.message(Command("duty"))
async def cmd_duty(message: Message, bot: Bot) -> None:
    """Поставить/снять менеджера с дежурства. Только суперадмин.
    Без аргумента — показывает список дежурных."""
    if not is_superadmin(message.from_user):
        return
    arg = _parse_manager_arg(message.text)
    mgrs = await get_managers()
    if not arg:
        if not mgrs:
            await message.answer("Менеджеров нет. /addmanager @username")
            return
        lines = ["🟢 <b>Дежурство:</b>", ""]
        for m in mgrs:
            mark = "🟢" if m.get("is_on_duty") else "⚪️"
            who = f"@{m['username']}" if m.get("username") else f"id {m.get('tg_id')}"
            lines.append(f"{mark} {who}")
        lines.append("")
        lines.append("Переключить: /duty @username")
        await message.answer("\n".join(lines))
        return
    target = None
    for m in mgrs:
        if arg.get("tg_id") and m.get("tg_id") and int(m["tg_id"]) == arg["tg_id"]:
            target = m; break
        if arg.get("username") and m.get("username") and m["username"].lower() == arg["username"]:
            target = m; break
    if not target:
        await message.answer("Такого менеджера нет. Сначала /addmanager.")
        return
    new_duty = not target.get("is_on_duty")
    if target.get("tg_id"):
        await supabase_patch("managers", {"tg_id": f"eq.{target['tg_id']}"}, {"is_on_duty": new_duty})
    else:
        await supabase_patch("managers", {"username": f"eq.{target['username']}"}, {"is_on_duty": new_duty})
    await reload_managers()
    who = f"@{target['username']}" if target.get("username") else f"id {target['tg_id']}"
    await message.answer(f"{'🟢 на дежурстве' if new_duty else '⚪️ снят с дежурства'}: {who}")


@router.message(Command("online"))
async def cmd_online(message: Message, bot: Bot) -> None:
    """Менеджер встаёт на дежурство."""
    if is_superadmin(message.from_user) or not await is_manager(message.from_user):
        return
    await update_manager_chat(message.from_user)
    uname = (message.from_user.username or "").lower()
    if uname:
        await supabase_patch("managers", {"username": f"eq.{uname}"}, {"is_on_duty": True})
    await supabase_patch("managers", {"tg_id": f"eq.{message.from_user.id}"}, {"is_on_duty": True})
    await reload_managers()
    await message.answer("🟢 Вы на дежурстве — новые заказы и обращения будут приходить вам.")


@router.message(Command("offline"))
async def cmd_offline(message: Message, bot: Bot) -> None:
    """Менеджер снимает дежурство."""
    if is_superadmin(message.from_user) or not await is_manager(message.from_user):
        return
    uname = (message.from_user.username or "").lower()
    if uname:
        await supabase_patch("managers", {"username": f"eq.{uname}"}, {"is_on_duty": False})
    await supabase_patch("managers", {"tg_id": f"eq.{message.from_user.id}"}, {"is_on_duty": False})
    await reload_managers()
    await message.answer("⚪️ Вы сняли дежурство — новые заказы вам приходить не будут.")


# ===================== КОМАНДА /active ========================
# Регистрируется ДО обработчика обычных сообщений, иначе /active будет
# воспринято как обычное сообщение и переслано (как клиентское).

@router.message(Command("active"))
async def cmd_active(message: Message, bot: Bot) -> None:
    """Сводка всех незакрытых заказов и обращений. Для менеджеров и суперадмина."""
    if not await is_manager(message.from_user):
        return

    orders = await supabase_get("orders", {
        "status": "not.in.(completed,cancelled)",
        "order": "created_at.asc",
        "limit": "50",
    }) or []
    inquiries = await supabase_get("inquiries", {
        "status": "in.(new,in_progress)",
        "order": "created_at.asc",
        "limit": "50",
    }) or []

    if not orders and not inquiries:
        await message.answer("✅ Нет активных заказов и обращений. Всё обработано!")
        return

    total_count = len(orders) + len(inquiries)
    await message.answer(
        f"📋 <b>Активные обращения: {total_count}</b>\n"
        f"Заказов: {len(orders)} · Запросов: {len(inquiries)}\n"
        f"Нажмите «Открыть» у нужного, чтобы перейти к карточке."
    )

    # Каждый заказ — отдельным сообщением с кнопкой «Открыть»
    for o in orders:
        st = ORDER_STATUS.get(o.get("status"), {}).get("label", o.get("status"))
        cur = o.get("currency") or "USD"
        total = float(o.get(f"total_{cur.lower()}") or 0)
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="🔍 Открыть заказ", callback_data=f"open_o:{o['id']}")
        ]])
        sub = []
        if o.get("created_at"):
            sub.append(f"создан {fmt_ago(o['created_at'])}")
        if o.get("updated_at"):
            sub.append(f"активность {fmt_ago(o['updated_at'])}")
        sub_str = ("\n   " + " · ".join(sub)) if sub else ""
        await message.answer(
            f"🛒 Заказ №{o['id']} — {st} — {fmt_price(total, cur)}{sub_str}",
            reply_markup=kb,
        )

    # Каждое обращение — отдельным сообщением с кнопкой «Открыть»
    for q in inquiries:
        st = INQUIRY_STATUS.get(q.get("status"), {}).get("label", q.get("status"))
        tp = "❓ Вопрос по товару" if q.get("type") == "product_question" else "🆕 Запрос на подбор"
        num = q.get("number")
        num_str = f"№{num} " if num else ""
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="🔍 Открыть обращение", callback_data=f"open_i:{q['id']}")
        ]])
        sub = []
        if q.get("created_at"):
            sub.append(f"создано {fmt_ago(q['created_at'])}")
        if q.get("updated_at"):
            sub.append(f"активность {fmt_ago(q['updated_at'])}")
        sub_str = ("\n   " + " · ".join(sub)) if sub else ""
        await message.answer(f"{tp} {num_str}— {st}{sub_str}", reply_markup=kb)


# ===================== HANDLERS DEEP-LINK ======================

async def customer_label(customer_tg_id: int) -> str:
    """Подпись клиента по tg_id (для карточек, где нет объекта message)."""
    rows = await supabase_get("customers", {
        "tg_id": f"eq.{customer_tg_id}", "select": "first_name,last_name,username", "limit": "1"
    })
    if not rows:
        return f"<a href=\"tg://user?id={customer_tg_id}\">клиент</a>"
    c = rows[0]
    name = " ".join(filter(None, [c.get("first_name"), c.get("last_name")])).strip()
    if c.get("username"):
        return f"@{c['username']}" + (f" ({html.escape(name)})" if name else "")
    if name:
        return f"<a href=\"tg://user?id={customer_tg_id}\">{html.escape(name)}</a>"
    return f"<a href=\"tg://user?id={customer_tg_id}\">клиент</a>"


async def handle_start_request(message: Message, bot: Bot, preset: str = None) -> None:
    """Клиент пришёл написать общий запрос на подбор товара.
    preset — необязательная категория из быстрых кнопок апки (shoes/bag/clothing/brand)."""
    # Человекочитаемые названия пресетов
    preset_names = {
        "shoes": "кроссовки / обувь",
        "bag": "сумку",
        "clothing": "одежду",
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
        num = existing.get("number")
        num_str = f"№{num}" if num else ""
        await notify_duty_plain(
            bot,
            f"⚠️ Клиент {await customer_label(message.from_user.id)} повторно обратился "
            f"(запрос {num_str}). Стоит ответить быстрее."
        )
        await supabase_patch("inquiries", {"id": f"eq.{existing['id']}"}, {"updated_at": now_iso()})
        return

    if preset_label:
        await message.answer(
            f"Привет! 👋\n\n"
            f"Вы хотите заказать <b>{preset_label}</b> — отлично! "
            f"Пришлите ссылку, фото или опишите, что именно ищете, и мы подберём 💛"
        )
    else:
        await message.answer(
            "Привет! 👋\n\n"
            "Расскажите, что хотите заказать — название, ссылку или просто фото. "
            "Подберём и привезём 💛"
        )
    # Создаём обращение в БД
    inquiry = await supabase_post("inquiries", {
        "customer_tg_id": message.from_user.id,
        "type": "request",
        "status": "new",
    })
    inquiry_id = inquiry.get("id") if inquiry else None
    number = inquiry.get("number") if inquiry else None

    preset_line = f"🔎 Интересует: {preset_label}\n" if preset_label else ""
    card = (
        f"🆕 <b>ЗАПРОС НА ПОДБОР №{number}</b>\n" if number else "🆕 <b>НОВЫЙ ЗАПРОС НА ПОДБОР</b>\n"
    ) + (
        f"От: {client_mention(message)}\n"
        f"{preset_line}"
        f"Статус: {INQUIRY_STATUS['new']['label']}\n\n"
        "<i>Клиент опишет, что ему нужно — сообщения придут следующими.</i>"
    )
    kb = inquiry_keyboard(inquiry_id, "new") if inquiry_id else None
    msg_id = await notify_manager(bot, card, message.from_user.id, reply_markup=kb)
    if inquiry_id and msg_id:
        await supabase_patch("inquiries", {"id": f"eq.{inquiry_id}"}, {"manager_msg_id": msg_id})


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
        num = existing.get("number")
        num_str = f"№{num}" if num else ""
        await notify_duty_plain(
            bot,
            f"⚠️ Клиент {await customer_label(message.from_user.id)} повторно спрашивает "
            f"про «{html.escape(name)}» (обращение {num_str}). Стоит ответить быстрее."
        )
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

    price_line = ""
    if prod:
        pu = prod.get("price_usd")
        pb = prod.get("price_byn")
        parts = []
        if pu: parts.append(f"${pu}")
        if pb: parts.append(f"{pb} BYN")
        if parts:
            price_line = f"💵 Цена: {' / '.join(parts)}\n"
    card = (
        f"❓ <b>ВОПРОС ПО ТОВАРУ №{number}</b>\n" if number else "❓ <b>ВОПРОС ПО ТОВАРУ</b>\n"
    ) + (
        f"От: {client_mention(message)}\n"
        f"🛍 Товар: <b>{html.escape(name)}</b>\n"
        f"{price_line}"
        f"🆔 <code>{html.escape(product_id)}</code>\n"
        f"Статус: {INQUIRY_STATUS['new']['label']}"
    )
    kb = inquiry_keyboard(inquiry_id, "new") if inquiry_id else None
    msg_id = await notify_manager(bot, card, message.from_user.id, reply_markup=kb)
    if inquiry_id and msg_id:
        await supabase_patch("inquiries", {"id": f"eq.{inquiry_id}"}, {"manager_msg_id": msg_id})


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
    await message.answer("\n".join(client_lines))

    # Карточка заказа менеджеру — с заголовком, клиентом и кнопками статуса
    card = (
        f"🆕 <b>НОВЫЙ ЗАКАЗ</b>\n"
        f"От: {client_mention(message)}\n\n"
        + order_card_text(order, status)
    )
    msg_id = await notify_manager(
        bot, card, message.from_user.id,
        reply_markup=order_keyboard(order_id, status),
    )
    # Запоминаем id карточки, чтобы редактировать её при смене статуса
    if msg_id:
        await supabase_patch("orders", {"id": f"eq.{order_id}"}, {"manager_msg_id": msg_id})


# ===================== REPLY-ROUTING ===========================

@router.message(F.reply_to_message)
async def handle_manager_reply(message: Message, bot: Bot) -> None:
    """
    Менеджер делает reply на сообщение в своём чате с ботом → пересылаем клиенту.
    """
    user = message.from_user
    if not user:
        return
    if not await is_manager(user):
        # Это не менеджер — пусть отрабатывает обычный handle_client_message
        await forward_client_to_manager(message, bot)
        return

    # Находим клиента по message_id того сообщения, на которое отвечает менеджер
    target_msg_id = message.reply_to_message.message_id
    client_tg_id = get_routed_client(target_msg_id)

    if not client_tg_id:
        await message.answer(
            "⚠️ Не удалось определить клиента (это сообщение слишком старое или не от клиента). "
            "Чтобы ответить клиенту — делайте reply на свежее сообщение от него.",
        )
        return

    # Копируем сообщение менеджера клиенту. copy_message сохраняет фото/документ/текст,
    # но без подписи «от кого» — это и есть смысл бота-посредника.
    try:
        await bot.copy_message(
            chat_id=client_tg_id,
            from_chat_id=message.chat.id,
            message_id=message.message_id,
        )
        # Лёгкая обратная связь — менеджер увидит галочку и поймёт, что доставлено
        try:
            from aiogram.types import ReactionTypeEmoji
            await message.react([ReactionTypeEmoji(emoji="👌")])
        except Exception:
            pass  # реакции могут быть недоступны в групповых чатах или старых клиентах
        # Обновляем «последнюю активность» открытых обращений клиента —
        # менеджер ответил, значит заявка в движении.
        try:
            await supabase_patch(
                "inquiries",
                {"customer_tg_id": f"eq.{client_tg_id}", "status": "in.(new,in_progress)"},
                {"updated_at": now_iso()},
            )
        except Exception:
            pass
    except Exception as e:
        log.exception("Failed to relay manager reply: %s", e)
        await message.answer(f"⚠️ Не удалось доставить сообщение клиенту: {e}")


# ===================== СООБЩЕНИЯ ОТ КЛИЕНТА ====================

@router.message(F.text | F.photo | F.document | F.video | F.voice | F.video_note | F.audio | F.sticker)
async def handle_client_message(message: Message, bot: Bot) -> None:
    """
    Любое обычное сообщение от клиента — пересылаем менеджеру.
    Сначала отправляем заголовок «От @username», затем копию сообщения —
    так у менеджера в потоке всегда понятен контекст.
    """
    user = message.from_user
    if not user:
        return
    if await is_manager(user):
        # 1) Ожидание текста заметки к заказу
        if message.chat.id in manager_note_wait and message.text:
            order_id = manager_note_wait.pop(message.chat.id)
            note_text = message.text.strip()
            if note_text == "-":
                note_text = None
            await supabase_patch("orders", {"id": f"eq.{order_id}"},
                                 {"manager_note": note_text, "updated_at": now_iso()})
            await message.answer(
                "📝 Заметка очищена." if note_text is None
                else f"📝 Заметка сохранена для заказа №{order_id}."
            )
            return
        # 2) Шаги ручного создания заказа
        draft = manager_order_draft.get(message.chat.id)
        if draft and message.text:
            await handle_order_draft_input(message, bot, draft)
            return
        # Иначе менеджер пишет сам себе — игнорируем
        return

    await forward_client_to_manager(message, bot)


async def forward_client_to_manager(message: Message, bot: Bot) -> None:
    """Пересылка сообщения клиента всем дежурным менеджерам (fallback — суперадмин)."""
    chats = await get_duty_chat_ids()
    if not chats:
        await message.answer(
            "⚠️ Менеджер пока не подключен. Попробуйте позже или напишите ему вручную."
        )
        return

    header = f"💬 <b>Сообщение от клиента</b>\nОт: {client_mention(message)}"
    for manager_chat in chats:
        # 1. Заголовок — reply-target
        try:
            header_msg = await bot.send_message(manager_chat, header)
            add_routing(header_msg.message_id, message.from_user.id)
        except Exception as e:
            log.warning("Failed to send header to %s: %s", manager_chat, e)
            continue
        # 2. Содержимое — копия как есть
        try:
            copied = await bot.copy_message(
                chat_id=manager_chat,
                from_chat_id=message.chat.id,
                message_id=message.message_id,
            )
            add_routing(copied.message_id, message.from_user.id)
        except Exception as e:
            log.warning("Failed to copy message to %s: %s", manager_chat, e)


# ===================== СМЕНА СТАТУСА (callback) ================

@router.callback_query(F.data.startswith("note:"))
async def cb_order_note(cb: CallbackQuery, bot: Bot) -> None:
    """Менеджер нажал «Заметка» — ждём текст следующим сообщением."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    order_id = cb.data.split(":", 1)[1]
    manager_note_wait[cb.message.chat.id] = order_id
    # Чтобы не пересекалось с черновиком заказа
    manager_order_draft.pop(cb.message.chat.id, None)
    await bot.send_message(
        cb.message.chat.id,
        f"📝 Пришлите текст заметки к заказу №{order_id}.\n"
        f"Она видна только менеджерам. Чтобы очистить — отправьте «-».",
    )
    await cb.answer()


@router.callback_query(F.data.startswith("os:"))
async def cb_order_status(cb: CallbackQuery, bot: Bot) -> None:
    """Менеджер нажал кнопку смены статуса заказа."""
    # Только менеджер может менять статусы
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return

    try:
        _, order_id, new_status = cb.data.split(":", 2)
    except ValueError:
        await cb.answer("Ошибка данных", show_alert=False)
        return

    if new_status not in ORDER_STATUS:
        await cb.answer("Неизвестный статус", show_alert=False)
        return

    # Обновляем статус в БД. Для 'paid' заодно ставим is_paid=true (триггер начислит сумму).
    patch = {"status": new_status, "updated_at": now_iso()}
    if new_status == "paid":
        patch["is_paid"] = True
    if new_status == "cancelled":
        patch["is_paid"] = False
    ok = await supabase_patch("orders", {"id": f"eq.{order_id}"}, patch)
    if not ok:
        await cb.answer("Не удалось обновить статус", show_alert=True)
        return

    # Перечитываем заказ для обновлённой карточки
    order = await fetch_order(order_id)
    if not order:
        await cb.answer("Заказ не найден", show_alert=True)
        return

    # Обновляем карточку у менеджера
    card_header = cb.message.html_text.split("\n")[0] if cb.message.html_text else "🛒 ЗАКАЗ"
    # Сохраняем строку "От: ..." если она была
    from_line = ""
    for line in (cb.message.html_text or "").split("\n"):
        if line.startswith("От:"):
            from_line = line + "\n"
            break
    new_card = f"{card_header}\n{from_line}\n" + order_card_text(order, new_status)
    try:
        await cb.message.edit_text(
            new_card,
            reply_markup=order_keyboard(order_id, new_status),
        )
    except Exception as e:
        log.warning("edit_text failed: %s", e)

    # Уведомляем клиента (если для статуса задан текст)
    client_msg = ORDER_STATUS[new_status].get("client_msg")
    if client_msg:
        try:
            await bot.send_message(
                order["customer_tg_id"],
                f"{client_msg}\n\n<i>Заказ №{order_id}</i>",
            )
        except Exception as e:
            log.warning("Failed to notify client about status: %s", e)

    await cb.answer(f"Статус: {ORDER_STATUS[new_status]['label']}")


@router.callback_query(F.data.startswith("is:"))
async def cb_inquiry_status(cb: CallbackQuery, bot: Bot) -> None:
    """Менеджер нажал кнопку смены статуса обращения."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    try:
        _, inquiry_id, new_status = cb.data.split(":", 2)
    except ValueError:
        await cb.answer("Ошибка данных", show_alert=False)
        return
    if new_status not in INQUIRY_STATUS:
        await cb.answer("Неизвестный статус", show_alert=False)
        return

    ok = await supabase_patch("inquiries", {"id": f"eq.{inquiry_id}"}, {"status": new_status})
    if not ok:
        await cb.answer("Не удалось обновить", show_alert=True)
        return

    # Обновляем статус-строку в карточке
    lines = (cb.message.html_text or "").split("\n")
    new_lines = []
    replaced = False
    for line in lines:
        if line.startswith("Статус:"):
            new_lines.append(f"Статус: {INQUIRY_STATUS[new_status]['label']}")
            replaced = True
        else:
            new_lines.append(line)
    if not replaced:
        new_lines.append(f"Статус: {INQUIRY_STATUS[new_status]['label']}")
    try:
        await cb.message.edit_text(
            "\n".join(new_lines),
            reply_markup=inquiry_keyboard(inquiry_id, new_status),
        )
    except Exception as e:
        log.warning("edit_text inquiry failed: %s", e)

    # Уведомляем клиента (если для статуса задан текст)
    client_msg = INQUIRY_STATUS[new_status].get("client_msg")
    if client_msg:
        rows = await supabase_get("inquiries", {"id": f"eq.{inquiry_id}", "select": "customer_tg_id", "limit": "1"})
        if rows:
            try:
                await bot.send_message(rows[0]["customer_tg_id"], f"💬 {client_msg}")
            except Exception as e:
                log.warning("Failed to notify client about inquiry status: %s", e)

    await cb.answer(f"Статус: {INQUIRY_STATUS[new_status]['label']}")


# ===================== ОТКРЫТЬ ИЗ /active =====================

@router.callback_query(F.data.startswith("open_o:"))
async def cb_open_order(cb: CallbackQuery, bot: Bot) -> None:
    """Кнопка «Открыть заказ» из /active — присылаем свежую карточку с кнопками."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    order_id = cb.data.split(":", 1)[1]
    order = await fetch_order(order_id)
    if not order:
        await cb.answer("Заказ не найден", show_alert=True)
        return
    status = order.get("status") or "new"
    card = f"🛒 <b>ЗАКАЗ</b>\n\n" + order_card_text(order, status)
    # Шлём карточку ТОМУ, КТО НАЖАЛ (а не всем дежурным)
    msg_id = await send_card_to_chat(
        bot, cb.message.chat.id, card, order["customer_tg_id"],
        reply_markup=order_keyboard(order_id, status),
    )
    # Обновляем привязку карточки, чтобы смена статуса редактировала именно её
    if msg_id:
        await supabase_patch("orders", {"id": f"eq.{order_id}"}, {"manager_msg_id": msg_id})
    await cb.answer("Открыто ниже ⬇️")


@router.callback_query(F.data.startswith("open_i:"))
async def cb_open_inquiry(cb: CallbackQuery, bot: Bot) -> None:
    """Кнопка «Открыть обращение» из /active — присылаем свежую карточку с кнопками."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    inquiry_id = cb.data.split(":", 1)[1]
    rows = await supabase_get("inquiries", {"id": f"eq.{inquiry_id}", "limit": "1"})
    if not rows:
        await cb.answer("Обращение не найдено", show_alert=True)
        return
    q = rows[0]
    status = q.get("status") or "new"
    is_product = q.get("type") == "product_question"
    number = q.get("number")

    # Подтянем имя товара, если это вопрос по товару
    product_line = ""
    if is_product and q.get("product_id"):
        prod = await fetch_product(q["product_id"])
        if prod:
            product_line = f"🛍 Товар: <b>{html.escape(product_name(prod))}</b>\n"

    num_str = f" №{number}" if number else ""
    title = (f"❓ <b>ВОПРОС ПО ТОВАРУ{num_str}</b>" if is_product
             else f"🆕 <b>ЗАПРОС НА ПОДБОР{num_str}</b>")
    who = await customer_label(q["customer_tg_id"])
    time_lines = ""
    if q.get("created_at"):
        time_lines += f"{fmt_created_line(q['created_at'])}\n"
    if q.get("updated_at"):
        time_lines += f"{fmt_activity_line(q['updated_at'])}\n"
    card = (
        f"{title}\n"
        f"От: {who}\n"
        f"{product_line}"
        f"{time_lines}"
        f"Статус: {INQUIRY_STATUS.get(status, {}).get('label', status)}"
    )
    msg_id = await send_card_to_chat(
        bot, cb.message.chat.id, card, q["customer_tg_id"],
        reply_markup=inquiry_keyboard(inquiry_id, status),
    )
    if msg_id:
        await supabase_patch("inquiries", {"id": f"eq.{inquiry_id}"}, {"manager_msg_id": msg_id})
    await cb.answer("Открыто ниже ⬇️")


# ============== РУЧНОЕ СОЗДАНИЕ ЗАКАЗА МЕНЕДЖЕРОМ ==============

STATUS_CHOICES = ["new", "in_progress", "awaiting_payment", "paid",
                  "purchasing", "shipping", "ready", "completed"]


@router.callback_query(F.data.startswith("mko:"))
async def cb_make_order_start(cb: CallbackQuery, bot: Bot) -> None:
    """Старт оформления заказа для клиента из обращения."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    inquiry_id = cb.data.split(":", 1)[1]

    rows = await supabase_get("inquiries", {"id": f"eq.{inquiry_id}", "limit": "1"})
    if not rows:
        await cb.answer("Обращение не найдено", show_alert=True)
        return
    customer_tg_id = rows[0]["customer_tg_id"]

    # Черновик с пустым списком позиций
    manager_order_draft[cb.message.chat.id] = {
        "step": "product",
        "inquiry_id": inquiry_id,
        "customer_tg_id": customer_tg_id,
        "items": [],
        "pending": None,   # позиция в процессе добавления {product_id, size, qty}
    }
    await _show_product_picker(cb.message.chat.id, bot)
    await cb.answer()


async def _show_product_picker(chat_id: int, bot: Bot) -> None:
    """Показывает кнопки последних скрытых товаров + подсказку про ручной ввод ID."""
    draft = manager_order_draft.get(chat_id)
    if draft:
        draft["step"] = "product"
    hidden = await fetch_hidden_products(8)
    rows_kb = []
    for p in hidden:
        name = product_name(p)
        price = p.get("price_usd")
        label = f"{name}" + (f" — ${price}" if price else "")
        rows_kb.append([InlineKeyboardButton(text=label[:60], callback_data=f"mkp:{p['id']}")])
    rows_kb.append([InlineKeyboardButton(text="✖️ Отмена", callback_data="mkc")])
    kb = InlineKeyboardMarkup(inline_keyboard=rows_kb)

    added = len(draft.get("items", [])) if draft else 0
    prefix = f"Добавлено позиций: {added}\n\n" if added else ""
    hint = (
        f"🛒 <b>Оформление заказа для клиента</b>\n\n{prefix}"
        "Выберите товар из последних скрытых или пришлите ID товара сообщением."
    )
    if not hidden:
        hint = (
            f"🛒 <b>Оформление заказа для клиента</b>\n\n{prefix}"
            "Скрытых товаров пока нет. Пришлите ID товара сообщением."
        )
    await bot.send_message(chat_id, hint, reply_markup=kb)


@router.callback_query(F.data.startswith("mkp:"))
async def cb_make_order_product(cb: CallbackQuery, bot: Bot) -> None:
    """Товар выбран кнопкой — переходим к выбору размера/количества."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    draft = manager_order_draft.get(cb.message.chat.id)
    if not draft:
        await cb.answer("Сессия истекла, начните заново", show_alert=True)
        return
    product_id = cb.data.split(":", 1)[1]
    await _begin_item(cb.message.chat.id, product_id, bot)
    await cb.answer()


async def _begin_item(chat_id: int, product_id: str, bot: Bot) -> None:
    """Начинает добавление позиции: проверяет товар, спрашивает размер либо количество."""
    draft = manager_order_draft.get(chat_id)
    if not draft:
        return
    prod = await fetch_product(product_id)
    if not prod:
        await bot.send_message(chat_id, "⚠️ Товар с таким ID не найден. Пришлите корректный ID.")
        return
    draft["pending"] = {"product_id": product_id, "size": None, "qty": 1}
    name = product_name(prod)
    sizes = prod.get("sizes") or []

    if sizes:
        # Спрашиваем размер кнопками
        rows, row = [], []
        for sz in sizes:
            row.append(InlineKeyboardButton(text=sz, callback_data=f"mksz:{sz}"))
            if len(row) == 3:
                rows.append(row); row = []
        if row:
            rows.append(row)
        rows.append([InlineKeyboardButton(text="Без размера", callback_data="mksz:-")])
        rows.append([InlineKeyboardButton(text="✖️ Отмена", callback_data="mkc")])
        draft["step"] = "size"
        await bot.send_message(
            chat_id,
            f"Товар: <b>{html.escape(name)}</b>\nВыберите размер:",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=rows),
        )
    else:
        draft["step"] = "qty"
        await bot.send_message(
            chat_id,
            f"Товар: <b>{html.escape(name)}</b>\nПришлите количество (число), например 1.",
        )


@router.callback_query(F.data.startswith("mksz:"))
async def cb_make_order_size(cb: CallbackQuery, bot: Bot) -> None:
    """Размер позиции выбран — спрашиваем количество."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    draft = manager_order_draft.get(cb.message.chat.id)
    if not draft or not draft.get("pending"):
        await cb.answer("Сессия истекла", show_alert=True)
        return
    sz = cb.data.split(":", 1)[1]
    draft["pending"]["size"] = None if sz == "-" else sz
    draft["step"] = "qty"
    await bot.send_message(cb.message.chat.id, "Пришлите количество (число), например 1.")
    await cb.answer()


async def handle_order_draft_input(message: Message, bot: Bot, draft: dict) -> None:
    """Обработка текстового ввода менеджера в процессе создания заказа."""
    text = (message.text or "").strip()
    step = draft.get("step")

    if step == "product":
        # Менеджер ввёл ID товара вручную
        await _begin_item(message.chat.id, text, bot)
        return

    if step == "qty":
        if not text.isdigit() or int(text) < 1:
            await message.answer("Введите количество числом, например 1.")
            return
        pending = draft.get("pending")
        if not pending:
            await message.answer("Сессия истекла, начните заново.")
            return
        pending["qty"] = int(text)
        draft["items"].append(pending)
        draft["pending"] = None
        # Спрашиваем: добавить ещё или завершить
        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="➕ Добавить ещё товар", callback_data="mkadd")],
            [InlineKeyboardButton(text="✅ Готово, выбрать статус", callback_data="mkdone")],
            [InlineKeyboardButton(text="✖️ Отмена", callback_data="mkc")],
        ])
        # Сводка
        lines = ["В заказе:"]
        for it in draft["items"]:
            prod = await fetch_product(it["product_id"])
            nm = product_name(prod) if prod else it["product_id"]
            sz = f" ({it['size']})" if it.get("size") else ""
            lines.append(f"• {html.escape(nm)}{sz} × {it['qty']}")
        await message.answer("\n".join(lines), reply_markup=kb)
        return


@router.callback_query(F.data == "mkadd")
async def cb_make_order_add_more(cb: CallbackQuery, bot: Bot) -> None:
    """Добавить ещё товар — снова показываем выбор."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    if not manager_order_draft.get(cb.message.chat.id):
        await cb.answer("Сессия истекла", show_alert=True)
        return
    await _show_product_picker(cb.message.chat.id, bot)
    await cb.answer()


@router.callback_query(F.data == "mkdone")
async def cb_make_order_done(cb: CallbackQuery, bot: Bot) -> None:
    """Завершить выбор товаров — показать статусы."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    draft = manager_order_draft.get(cb.message.chat.id)
    if not draft or not draft.get("items"):
        await cb.answer("Нет позиций", show_alert=True)
        return
    draft["step"] = "status"
    rows, row = [], []
    for st in STATUS_CHOICES:
        row.append(InlineKeyboardButton(text=ORDER_STATUS[st]["label"], callback_data=f"mks:{st}"))
        if len(row) == 2:
            rows.append(row); row = []
    if row:
        rows.append(row)
    rows.append([InlineKeyboardButton(text="✖️ Отмена", callback_data="mkc")])
    await bot.send_message(
        cb.message.chat.id,
        "Выберите статус нового заказа:",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=rows),
    )
    await cb.answer()


@router.callback_query(F.data.startswith("mks:"))
async def cb_make_order_status(cb: CallbackQuery, bot: Bot) -> None:
    """Статус выбран — создаём заказ со всеми позициями."""
    if not await is_manager(cb.from_user):
        await cb.answer("Недоступно", show_alert=False)
        return
    draft = manager_order_draft.get(cb.message.chat.id)
    if not draft or not draft.get("items"):
        await cb.answer("Сессия истекла, начните заново", show_alert=True)
        return
    status = cb.data.split(":", 1)[1]

    order = await create_order_for_customer(
        customer_tg_id=draft["customer_tg_id"],
        items=draft["items"],
        status=status,
    )
    manager_order_draft.pop(cb.message.chat.id, None)

    if not order:
        await cb.message.edit_text("⚠️ Не удалось создать заказ. Проверьте товары.")
        await cb.answer("Ошибка", show_alert=True)
        return

    order_id = str(order["id"])
    card = "🛒 <b>ЗАКАЗ СОЗДАН ВРУЧНУЮ</b>\n\n" + order_card_text(order, status)
    msg_id = await notify_manager(
        bot, card, order["customer_tg_id"],
        reply_markup=order_keyboard(order_id, status),
    )
    if msg_id:
        await supabase_patch("orders", {"id": f"eq.{order_id}"}, {"manager_msg_id": msg_id})

    # Уведомляем клиента списком позиций
    try:
        item_lines = []
        for it in order["items"]:
            nm = product_name(it.get("_product"))
            sz = f" ({it['size']})" if it.get("size") else ""
            item_lines.append(f"• {html.escape(nm)}{sz} × {it['qty']}")
        await bot.send_message(
            order["customer_tg_id"],
            "Менеджер оформил для вас заказ 🛒\n\n"
            + "\n".join(item_lines)
            + "\n\nДетали и статус — в приложении, раздел «История». "
            + (ORDER_STATUS[status].get("client_msg") or "")
        )
    except Exception as e:
        log.warning("Failed to notify client about manual order: %s", e)

    await cb.message.edit_text(f"✅ Заказ №{order_id} создан и отправлен клиенту.")
    await cb.answer("Готово")


@router.callback_query(F.data == "mkc")
async def cb_make_order_cancel(cb: CallbackQuery, bot: Bot) -> None:
    """Отмена оформления."""
    manager_order_draft.pop(cb.message.chat.id, None)
    try:
        await cb.message.edit_text("Оформление отменено.")
    except Exception:
        pass
    await cb.answer()


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
                await bot.send_message(
                    cid,
                    "🛒 Вы оставили товары в корзине!\n\n"
                    "Они вас ждут — оформите заказ, пока всё в наличии. "
                    "Откройте магазин кнопкой «Открыть» ниже 💛",
                )
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

    await dp.start_polling(bot)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        log.info("Bot stopped.")
