"""
Telegram-бот «Магазин одежды + заказ из Китая».
Архитектура: бот-посредник между клиентами и менеджером.

Стек: Python 3.10+, aiogram 3.x, httpx.

Что делает бот:
1. Команда /start без параметров — показывает приветствие и кнопку «Открыть магазин» (мини-апп).
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
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    WebAppInfo,
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
    "in_progress":      {"label": "✋ В работе",          "client_msg": "Менеджер взял ваш заказ в работу и скоро свяжется с вами."},
    "awaiting_payment": {"label": "💳 Ждёт оплаты",       "client_msg": "Ваш заказ подтверждён. Ожидаем оплату — менеджер пришлёт реквизиты."},
    "paid":             {"label": "✅ Оплачен",           "client_msg": "Оплата получена, спасибо! Приступаем к выкупу товара."},
    "purchasing":       {"label": "🛒 Выкупаем",          "client_msg": "Мы выкупаем ваш товар на площадке. Дальше — доставка в Беларусь."},
    "shipping":         {"label": "🚚 В пути",            "client_msg": "Ваш заказ едет из Китая. Обычно доставка занимает 2–3 недели."},
    "ready":            {"label": "📦 Готов к выдаче",    "client_msg": "Ваш заказ прибыл! Можно примерить и забрать. Менеджер согласует время."},
    "completed":        {"label": "🎉 Выдан",             "client_msg": "Заказ выдан. Спасибо, что выбрали нас! Будем рады видеть снова."},
    "cancelled":        {"label": "❌ Отменён",           "client_msg": "Ваш заказ отменён. Если это ошибка — напишите нам, поможем."},
}

# Доступные переходы из каждого статуса (что показывать кнопками)
ORDER_TRANSITIONS = {
    "new":              ["in_progress", "cancelled"],
    "in_progress":      ["awaiting_payment", "cancelled"],
    "awaiting_payment": ["paid", "cancelled"],
    "paid":             ["purchasing", "cancelled"],
    "purchasing":       ["shipping", "cancelled"],
    "shipping":         ["ready", "cancelled"],
    "ready":            ["completed", "cancelled"],
    "completed":        [],
    "cancelled":        ["in_progress"],   # можно вернуть в работу, если отменили по ошибке
}

INQUIRY_STATUS = {
    "new":         {"label": "🆕 Новое",     "client_msg": None},
    "in_progress": {"label": "✋ В работе",   "client_msg": "Ваше обращение принято в работу — менеджер скоро ответит."},
    "closed":      {"label": "✅ Закрыто",    "client_msg": "Ваше обращение закрыто. Если остались вопросы — просто напишите нам."},
}
INQUIRY_TRANSITIONS = {
    "new":         ["in_progress", "closed"],
    "in_progress": ["closed"],
    "closed":      ["in_progress"],
}


def order_keyboard(order_id: str, status: str) -> InlineKeyboardMarkup:
    """Кнопки переходов статуса для заказа. callback_data = 'os:<order_id>:<new_status>'."""
    rows = []
    transitions = ORDER_TRANSITIONS.get(status, [])
    row = []
    for nxt in transitions:
        label = ORDER_STATUS[nxt]["label"]
        row.append(InlineKeyboardButton(text=label, callback_data=f"os:{order_id}:{nxt}"))
        if len(row) == 2:
            rows.append(row); row = []
    if row:
        rows.append(row)
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else InlineKeyboardMarkup(inline_keyboard=[[]])


def inquiry_keyboard(inquiry_id: str, status: str) -> InlineKeyboardMarkup:
    """Кнопки переходов статуса для обращения. callback_data = 'is:<inquiry_id>:<new_status>'."""
    rows = []
    row = []
    for nxt in INQUIRY_TRANSITIONS.get(status, []):
        label = INQUIRY_STATUS[nxt]["label"]
        row.append(InlineKeyboardButton(text=label, callback_data=f"is:{inquiry_id}:{nxt}"))
        if len(row) == 2:
            rows.append(row); row = []
    if row:
        rows.append(row)
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else InlineKeyboardMarkup(inline_keyboard=[[]])


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
    kb = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="🛍 Открыть магазин", web_app=WebAppInfo(url=WEBAPP_URL))]],
        resize_keyboard=True,
    )
    await message.answer(
        "👋 Добро пожаловать!\n\n"
        "Нажмите кнопку ниже, чтобы открыть магазин — там можно "
        "посмотреть товары в наличии или оформить заказ из Китая.",
        reply_markup=kb,
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

    lines = ["📋 <b>АКТИВНЫЕ</b>", ""]
    if orders:
        lines.append("<b>Заказы:</b>")
        for o in orders:
            st = ORDER_STATUS.get(o.get("status"), {}).get("label", o.get("status"))
            cur = o.get("currency") or "USD"
            total = float(o.get(f"total_{cur.lower()}") or 0)
            lines.append(f"• №{o['id']} — {st} — {fmt_price(total, cur)}")
        lines.append("")
    if inquiries:
        lines.append("<b>Обращения:</b>")
        for q in inquiries:
            st = INQUIRY_STATUS.get(q.get("status"), {}).get("label", q.get("status"))
            tp = "вопрос по товару" if q.get("type") == "product_question" else "запрос на подбор"
            lines.append(f"• {tp} — {st}")

    await message.answer("\n".join(lines))


# ===================== HANDLERS DEEP-LINK ======================

async def handle_start_request(message: Message, bot: Bot) -> None:
    """Клиент пришёл написать общий запрос на подбор товара."""
    await message.answer(
        "Здравствуйте! 👋\n\n"
        "Расскажите, что вы хотели бы заказать — название, описание, ссылку или фото. "
        "Я найду и привезу. Можно прислать несколько сообщений или фото."
    )
    # Создаём обращение в БД
    inquiry = await supabase_post("inquiries", {
        "customer_tg_id": message.from_user.id,
        "type": "request",
        "status": "new",
    })
    inquiry_id = inquiry.get("id") if inquiry else None

    card = (
        "🆕 <b>НОВЫЙ ЗАПРОС НА ПОДБОР</b>\n"
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

    await message.answer(
        f"👋 Здравствуйте!\n\n"
        f"Вы интересуетесь товаром «<b>{html.escape(name)}</b>». "
        f"Менеджер свяжется с вами в ближайшее время и расскажет про доступные размеры и наличие.\n\n"
        f"Если хотите — можете прямо сейчас написать дополнительные вопросы или прислать фото."
    )
    inquiry = await supabase_post("inquiries", {
        "customer_tg_id": message.from_user.id,
        "type": "product_question",
        "product_id": product_id if prod else None,
        "status": "new",
    })
    inquiry_id = inquiry.get("id") if inquiry else None

    card = (
        "❓ <b>ВОПРОС ПО ТОВАРУ</b>\n"
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
            "⚠️ Не удалось найти ваш заказ. Возможно, он был только что создан — "
            "попробуйте через несколько секунд, или напишите менеджеру вручную."
        )
        return

    currency = order.get("currency") or "USD"
    items = order.get("items", [])
    total = float(order.get(f"total_{currency.lower()}") or 0)
    status = order.get("status") or "new"

    # Резюме клиенту
    client_lines = [f"🛒 <b>Ваш заказ №{order_id}</b>", ""]
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
    client_lines.append("Менеджер свяжется с вами для подтверждения и оплаты.")
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
    # Менеджер пишет сам себе — игнорируем
    if (user.username or "").lower() == MANAGER_USERNAME:
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
                f"📦 <b>Заказ №{order_id}</b>\n{client_msg}",
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
