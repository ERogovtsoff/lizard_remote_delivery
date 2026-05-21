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

BOT_TOKEN = os.getenv("BOT_TOKEN", "8799556901:AAHqUPacTvqJPrITaZVgE9e1Cr81dF_nDCk")
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://erogovtsoff.github.io/lizard_remote_delivery/index.html")
MANAGER_USERNAME = os.getenv("MANAGER_USERNAME", "rogovtsoff").lstrip("@").lower()
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://nhnbprmyqqpwcofkaasi.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5obmJwcm15cXFwd2NvZmthYXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwOTc4NzEsImV4cCI6MjA5NDY3Mzg3MX0.85NtVma5cplLuhm_fRHga3Z1ZlyNuFQBOqlxGeQggJ0")

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

def get_manager_chat_id() -> Optional[int]:
    if MANAGER_FILE.exists():
        try:
            return int(MANAGER_FILE.read_text().strip())
        except (ValueError, OSError):
            return None
    return None


def set_manager_chat_id(chat_id: int) -> None:
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


async def create_order_for_customer(customer_tg_id: int, product_id: str,
                                    size: Optional[str], qty: int,
                                    status: str) -> Optional[dict]:
    """
    Создаёт заказ для клиента (ручное оформление менеджером).
    Дублирует логику addOrder из апки, но на стороне бота через REST.
    Возвращает созданный заказ (с id) или None.
    """
    prod = await fetch_product(product_id)
    if not prod:
        return None

    currency = "USD"  # базовая валюта заказа; клиент видит в своей валюте через snapshot
    price_usd = float(prod.get("price_usd") or 0)
    price_byn = float(prod.get("price_byn") or 0)
    total_usd = price_usd * qty
    total_byn = price_byn * qty

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

    # Позиция заказа со снапшотами цен
    item_ok = await supabase_post("order_items", {
        "order_id": order["id"],
        "product_id": product_id,
        "size": size,
        "qty": qty,
        "price_usd_snapshot": price_usd,
        "price_byn_snapshot": price_byn,
    })
    if item_ok is None:
        # откат — удаляем заказ, чтобы не висел пустым
        await supabase_patch("orders", {"id": f"eq.{order['id']}"}, {"status": "cancelled"})
        return None

    # подгружаем позиции для карточки
    order["items"] = [{
        "product_id": product_id, "size": size, "qty": qty,
        "price_usd_snapshot": price_usd, "price_byn_snapshot": price_byn,
        "_product": prod,
    }]
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


async def notify_manager(bot: Bot, text: str, client_tg_id: int,
                         reply_markup: Optional[InlineKeyboardMarkup] = None) -> Optional[int]:
    """
    Отправить сообщение менеджеру и запомнить, что reply на него
    адресуется конкретному клиенту. Возвращает message_id отправленного сообщения.
    """
    manager_chat = get_manager_chat_id()
    if manager_chat is None:
        log.warning("Manager chat_id не задан — менеджер должен сделать /start")
        return None
    try:
        sent = await bot.send_message(manager_chat, text, reply_markup=reply_markup)
        add_routing(sent.message_id, client_tg_id)
        return sent.message_id
    except Exception as e:
        log.exception("Failed to notify manager: %s", e)
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
        "─────────────",
    ]
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
    """/start без параметров — приветствие + кнопка магазина. Для менеджера — регистрация."""
    user = message.from_user
    username = (user.username or "").lower() if user else ""

    if username and username == MANAGER_USERNAME:
        set_manager_chat_id(message.chat.id)
        await message.answer(
            "✅ Вы зарегистрированы как менеджер.\n"
            f"Все запросы клиентов будут приходить сюда.\n"
            f"Чтобы ответить — делайте <b>reply</b> на сообщение клиента.\n\n"
            f"<i>Chat ID: {message.chat.id}</i>",
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


# ===================== КОМАНДА /active ========================
# Регистрируется ДО обработчика обычных сообщений, иначе /active будет
# воспринято как обычное сообщение и переслано (как клиентское).

@router.message(Command("active"))
async def cmd_active(message: Message, bot: Bot) -> None:
    """Сводка всех незакрытых заказов и обращений. Только для менеджера."""
    if (message.from_user.username or "").lower() != MANAGER_USERNAME:
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
        await message.answer(
            f"🛒 Заказ №{o['id']} — {st} — {fmt_price(total, cur)}",
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
        await message.answer(f"{tp} {num_str}— {st}", reply_markup=kb)


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


async def handle_start_request(message: Message, bot: Bot) -> None:
    """Клиент пришёл написать общий запрос на подбор товара."""
    # Антиспам: уже есть открытый запрос?
    existing = await find_open_inquiry(message.from_user.id, "request")
    if existing:
        await message.answer(
            "У вас уже есть открытая заявка 🙌 Менеджер скоро свяжется — "
            "можно дописать детали прямо сюда."
        )
        # Уведомляем менеджера, что клиент торопит (реплай на старую карточку, если есть)
        manager_chat = get_manager_chat_id()
        if manager_chat:
            num = existing.get("number")
            num_str = f"№{num}" if num else ""
            try:
                await bot.send_message(
                    manager_chat,
                    f"⚠️ Клиент {await customer_label(message.from_user.id)} повторно обратился "
                    f"(запрос {num_str}). Стоит ответить быстрее.",
                    reply_to_message_id=existing.get("manager_msg_id"),
                )
            except Exception:
                # старое сообщение могло быть удалено — шлём без реплая
                try:
                    await bot.send_message(
                        manager_chat,
                        f"⚠️ Клиент {await customer_label(message.from_user.id)} повторно обратился "
                        f"(запрос {num_str}). Стоит ответить быстрее.",
                    )
                except Exception:
                    pass
        return

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

    card = (
        f"🆕 <b>ЗАПРОС НА ПОДБОР №{number}</b>\n" if number else "🆕 <b>НОВЫЙ ЗАПРОС НА ПОДБОР</b>\n"
    ) + (
        f"От: {client_mention(message)}\n"
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
        manager_chat = get_manager_chat_id()
        if manager_chat:
            num = existing.get("number")
            num_str = f"№{num}" if num else ""
            txt = (f"⚠️ Клиент {await customer_label(message.from_user.id)} повторно спрашивает "
                   f"про «{html.escape(name)}» (обращение {num_str}). Стоит ответить быстрее.")
            try:
                await bot.send_message(manager_chat, txt,
                                       reply_to_message_id=existing.get("manager_msg_id"))
            except Exception:
                try:
                    await bot.send_message(manager_chat, txt)
                except Exception:
                    pass
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

    card = (
        f"❓ <b>ВОПРОС ПО ТОВАРУ №{number}</b>\n" if number else "❓ <b>ВОПРОС ПО ТОВАРУ</b>\n"
    ) + (
        f"От: {client_mention(message)}\n"
        f"🛍 Товар: <b>{html.escape(name)}</b>\n"
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
    if (user.username or "").lower() != MANAGER_USERNAME:
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
    # Менеджер вводит ID товара в процессе ручного создания заказа
    if (user.username or "").lower() == MANAGER_USERNAME:
        draft = manager_order_draft.get(message.chat.id)
        if draft and draft.get("step") == "product" and message.text:
            product_id = message.text.strip()
            await _proceed_to_status(message.chat.id, product_id, bot)
            return
        # Иначе менеджер пишет сам себе — игнорируем
        return

    await forward_client_to_manager(message, bot)


async def forward_client_to_manager(message: Message, bot: Bot) -> None:
    """Общая логика пересылки. Reply-target = заголовок (а не само сообщение)."""
    manager_chat = get_manager_chat_id()
    if manager_chat is None:
        await message.answer(
            "⚠️ Менеджер пока не подключен. Попробуйте позже или напишите ему вручную."
        )
        return

    # 1. Заголовок — короткая шапка с упоминанием клиента. Это reply-target.
    header = f"💬 <b>Сообщение от клиента</b>\nОт: {client_mention(message)}"
    try:
        header_msg = await bot.send_message(manager_chat, header)
        add_routing(header_msg.message_id, message.from_user.id)
    except Exception as e:
        log.exception("Failed to send header: %s", e)
        return

    # 2. Содержимое — копируется как есть (фото/документ/текст/etc)
    try:
        copied = await bot.copy_message(
            chat_id=manager_chat,
            from_chat_id=message.chat.id,
            message_id=message.message_id,
        )
        # Также маршрутим reply на само сообщение — на случай если менеджер
        # сделает reply на копию, а не на заголовок
        add_routing(copied.message_id, message.from_user.id)
    except Exception as e:
        log.exception("Failed to copy message: %s", e)


# ===================== СМЕНА СТАТУСА (callback) ================

@router.callback_query(F.data.startswith("os:"))
async def cb_order_status(cb: CallbackQuery, bot: Bot) -> None:
    """Менеджер нажал кнопку смены статуса заказа."""
    # Только менеджер может менять статусы
    if (cb.from_user.username or "").lower() != MANAGER_USERNAME:
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
    patch = {"status": new_status}
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
    if (cb.from_user.username or "").lower() != MANAGER_USERNAME:
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
    if (cb.from_user.username or "").lower() != MANAGER_USERNAME:
        await cb.answer("Недоступно", show_alert=False)
        return
    order_id = cb.data.split(":", 1)[1]
    order = await fetch_order(order_id)
    if not order:
        await cb.answer("Заказ не найден", show_alert=True)
        return
    status = order.get("status") or "new"
    card = f"🛒 <b>ЗАКАЗ</b>\n\n" + order_card_text(order, status)
    msg_id = await notify_manager(
        bot, card, order["customer_tg_id"],
        reply_markup=order_keyboard(order_id, status),
    )
    # Обновляем привязку карточки, чтобы смена статуса редактировала именно её
    if msg_id:
        await supabase_patch("orders", {"id": f"eq.{order_id}"}, {"manager_msg_id": msg_id})
    await cb.answer("Открыто ниже ⬇️")


@router.callback_query(F.data.startswith("open_i:"))
async def cb_open_inquiry(cb: CallbackQuery, bot: Bot) -> None:
    """Кнопка «Открыть обращение» из /active — присылаем свежую карточку с кнопками."""
    if (cb.from_user.username or "").lower() != MANAGER_USERNAME:
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
    card = (
        f"{title}\n"
        f"От: {who}\n"
        f"{product_line}"
        f"Статус: {INQUIRY_STATUS.get(status, {}).get('label', status)}"
    )
    msg_id = await notify_manager(
        bot, card, q["customer_tg_id"],
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
    if (cb.from_user.username or "").lower() != MANAGER_USERNAME:
        await cb.answer("Недоступно", show_alert=False)
        return
    inquiry_id = cb.data.split(":", 1)[1]

    # Узнаём клиента из обращения
    rows = await supabase_get("inquiries", {"id": f"eq.{inquiry_id}", "limit": "1"})
    if not rows:
        await cb.answer("Обращение не найдено", show_alert=True)
        return
    customer_tg_id = rows[0]["customer_tg_id"]

    # Сохраняем черновик
    manager_order_draft[cb.message.chat.id] = {
        "step": "product",
        "inquiry_id": inquiry_id,
        "customer_tg_id": customer_tg_id,
    }

    # Показываем последние скрытые товары кнопками + подсказку про ручной ввод
    hidden = await fetch_hidden_products(8)
    rows_kb = []
    for p in hidden:
        name = product_name(p)
        price = p.get("price_usd")
        label = f"{name}" + (f" — ${price}" if price else "")
        rows_kb.append([InlineKeyboardButton(
            text=label[:60], callback_data=f"mkp:{p['id']}"
        )])
    rows_kb.append([InlineKeyboardButton(text="✖️ Отмена", callback_data="mkc")])
    kb = InlineKeyboardMarkup(inline_keyboard=rows_kb)

    hint = (
        "🛒 <b>Оформление заказа для клиента</b>\n\n"
        "Выберите товар из последних скрытых или пришлите ID товара сообщением."
    )
    if not hidden:
        hint = (
            "🛒 <b>Оформление заказа для клиента</b>\n\n"
            "Скрытых товаров пока нет. Пришлите ID товара сообщением."
        )
    await bot.send_message(cb.message.chat.id, hint, reply_markup=kb)
    await cb.answer()


@router.callback_query(F.data.startswith("mkp:"))
async def cb_make_order_product(cb: CallbackQuery, bot: Bot) -> None:
    """Товар выбран кнопкой."""
    if (cb.from_user.username or "").lower() != MANAGER_USERNAME:
        await cb.answer("Недоступно", show_alert=False)
        return
    draft = manager_order_draft.get(cb.message.chat.id)
    if not draft:
        await cb.answer("Сессия истекла, начните заново", show_alert=True)
        return
    product_id = cb.data.split(":", 1)[1]
    await _proceed_to_status(cb.message.chat.id, product_id, bot)
    await cb.answer()


@router.callback_query(F.data.startswith("mks:"))
async def cb_make_order_status(cb: CallbackQuery, bot: Bot) -> None:
    """Статус выбран — создаём заказ."""
    if (cb.from_user.username or "").lower() != MANAGER_USERNAME:
        await cb.answer("Недоступно", show_alert=False)
        return
    draft = manager_order_draft.get(cb.message.chat.id)
    if not draft or not draft.get("product_id"):
        await cb.answer("Сессия истекла, начните заново", show_alert=True)
        return
    status = cb.data.split(":", 1)[1]

    order = await create_order_for_customer(
        customer_tg_id=draft["customer_tg_id"],
        product_id=draft["product_id"],
        size=draft.get("size"),
        qty=draft.get("qty", 1),
        status=status,
    )
    manager_order_draft.pop(cb.message.chat.id, None)

    if not order:
        await cb.message.edit_text("⚠️ Не удалось создать заказ. Проверьте ID товара.")
        await cb.answer("Ошибка", show_alert=True)
        return

    order_id = str(order["id"])

    # Карточка заказа менеджеру с кнопками статуса
    card = "🛒 <b>ЗАКАЗ СОЗДАН ВРУЧНУЮ</b>\n\n" + order_card_text(order, status)
    msg_id = await notify_manager(
        bot, card, draft["customer_tg_id"],
        reply_markup=order_keyboard(order_id, status),
    )
    if msg_id:
        await supabase_patch("orders", {"id": f"eq.{order_id}"}, {"manager_msg_id": msg_id})

    # Уведомляем клиента
    try:
        prod = order["items"][0].get("_product")
        name = product_name(prod)
        await bot.send_message(
            draft["customer_tg_id"],
            f"Менеджер оформил для вас заказ 🛒\n\n"
            f"• {html.escape(name)}\n\n"
            f"Детали и статус — в приложении, раздел «История». "
            f"{ORDER_STATUS[status].get('client_msg') or ''}".strip()
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


async def _proceed_to_status(chat_id: int, product_id: str, bot: Bot) -> None:
    """Сохраняет товар в черновик и показывает выбор статуса."""
    draft = manager_order_draft.get(chat_id)
    if not draft:
        return
    # Проверяем что товар существует
    prod = await fetch_product(product_id)
    if not prod:
        await bot.send_message(chat_id, "⚠️ Товар с таким ID не найден. Пришлите корректный ID.")
        return
    draft["product_id"] = product_id
    draft["step"] = "status"

    name = product_name(prod)
    price = prod.get("price_usd")
    # Кнопки статусов (по 2 в ряд)
    rows, row = [], []
    for st in STATUS_CHOICES:
        row.append(InlineKeyboardButton(text=ORDER_STATUS[st]["label"], callback_data=f"mks:{st}"))
        if len(row) == 2:
            rows.append(row); row = []
    if row:
        rows.append(row)
    rows.append([InlineKeyboardButton(text="✖️ Отмена", callback_data="mkc")])
    kb = InlineKeyboardMarkup(inline_keyboard=rows)

    await bot.send_message(
        chat_id,
        f"Товар: <b>{html.escape(name)}</b>" + (f" — ${price}" if price else "") + "\n\n"
        "Выберите статус нового заказа:",
        reply_markup=kb,
    )


# ============================ MAIN =============================

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
    log.info("Bot started. Manager: @%s, WebApp: %s", MANAGER_USERNAME, WEBAPP_URL)
    if get_manager_chat_id() is None:
        log.warning("Manager chat_id не задан — менеджер должен сделать /start боту.")

    await dp.start_polling(bot)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        log.info("Bot stopped.")
