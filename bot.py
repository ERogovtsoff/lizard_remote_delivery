"""
Telegram-бот для мини-аппа «Магазин одежды + заказ из Китая».
Стек: Python 3.10+, aiogram 3.x.

Что делает бот:
1. На команду /start показывает кнопку «Открыть», которая открывает мини-апп.
2. Принимает данные от мини-аппа (WebAppData) — запросы на подбор и заказы из наличия.
3. Пересылает их менеджеру (@rogovtsoff) с указанием юзернейма клиента.
4. После запроса с прикреплёнными фото просит клиента переслать фото в чат —
   все фото/документы от клиента пересылаются менеджеру с привязкой к запросу.

Установка:
    pip install aiogram

Запуск:
    export BOT_TOKEN="123:ABC..."        # токен от @BotFather
    export WEBAPP_URL="https://your.site/index.html"
    export MANAGER_USERNAME="rogovtsoff"  # без @
    python bot.py

Важно: чтобы бот мог писать менеджеру, менеджер должен ОДИН РАЗ написать боту
команду /start. Бот запомнит его chat_id в файле manager_chat.txt.
"""

import asyncio
import html
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import CommandStart
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
    WebAppInfo,
)

# ============================ КОНФИГ ============================

BOT_TOKEN = os.getenv("BOT_TOKEN", "8799556901:AAHqUPacTvqJPrITaZVgE9e1Cr81dF_nDCk")
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://erogovtsoff.github.io/lizard_remote_delivery/index.html")
MANAGER_USERNAME = os.getenv("MANAGER_USERNAME", "rogovtsoff").lstrip("@").lower()

# Файл для хранения chat_id менеджера (заполняется автоматически, когда он напишет /start)
MANAGER_FILE = Path("manager_chat.txt")

# Файл для хранения "последнего запроса с ожидаемыми фото" — клиент → request_id
# чтобы пересылать фото менеджеру с правильной привязкой
PENDING_FILE = Path("pending_photos.json")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
log = logging.getLogger("shop-bot")

router = Router()

# ========================== ХРАНИЛИЩЕ ==========================

def get_manager_chat_id() -> Optional[int]:
    """Прочитать сохранённый chat_id менеджера."""
    if MANAGER_FILE.exists():
        try:
            return int(MANAGER_FILE.read_text().strip())
        except (ValueError, OSError):
            return None
    return None


def set_manager_chat_id(chat_id: int) -> None:
    """Сохранить chat_id менеджера."""
    MANAGER_FILE.write_text(str(chat_id))


def load_pending() -> dict:
    """Загрузить {client_chat_id: {'request_id': ..., 'expires_at': ts}}."""
    if PENDING_FILE.exists():
        try:
            return json.loads(PENDING_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_pending(data: dict) -> None:
    PENDING_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def set_pending(client_chat_id: int, request_id: str) -> None:
    """Запомнить, что от клиента ожидаем фото к конкретному запросу."""
    data = load_pending()
    data[str(client_chat_id)] = {
        "request_id": request_id,
        "expires_at": int(datetime.now().timestamp()) + 3600,  # 1 час
    }
    save_pending(data)


def pop_pending(client_chat_id: int) -> Optional[str]:
    """Получить request_id ожидающих фото (но не удалять — за окно в 1 час можно слать несколько)."""
    data = load_pending()
    rec = data.get(str(client_chat_id))
    if not rec:
        return None
    if rec.get("expires_at", 0) < int(datetime.now().timestamp()):
        # окно истекло — чистим
        data.pop(str(client_chat_id), None)
        save_pending(data)
        return None
    return rec.get("request_id")


def clear_pending(client_chat_id: int) -> None:
    data = load_pending()
    if data.pop(str(client_chat_id), None) is not None:
        save_pending(data)


# ========================== УТИЛИТЫ ============================

def client_mention(message: Message) -> str:
    """HTML-упоминание клиента (никогда не падает)."""
    user = message.from_user
    if user is None:
        return "Аноним"
    if user.username:
        return f"@{user.username}"
    full_name = user.full_name or "Пользователь"
    return f'<a href="tg://user?id={user.id}">{html.escape(full_name)}</a>'


def fmt_price(amount: float, currency: str) -> str:
    s = f"{amount:.2f}".rstrip("0").rstrip(".")
    if not s:
        s = "0"
    return f"${s}" if currency == "USD" else f"{s} BYN"


def short_id() -> str:
    """Короткий идентификатор для запроса (для привязки фото)."""
    return datetime.now().strftime("%y%m%d%H%M%S")


# ========================== ХЕНДЛЕРЫ ===========================

@router.message(CommandStart())
async def cmd_start(message: Message) -> None:
    """
    /start — две роли:
    - если пишет менеджер (@rogovtsoff) — запоминаем его chat_id
    - всем остальным показываем кнопку «Открыть» с мини-аппом
    """
    user = message.from_user
    username = (user.username or "").lower() if user else ""

    # Если это менеджер — запоминаем его chat_id, чтобы потом писать ему
    if username and username == MANAGER_USERNAME:
        set_manager_chat_id(message.chat.id)
        await message.answer(
            "✅ Вы зарегистрированы как менеджер.\n"
            f"Все запросы и заказы из мини-аппа будут приходить сюда.\n\n"
            f"<i>Чат ID: {message.chat.id}</i>",
        )
        return

    # Обычный пользователь — даём кнопку «Открыть»
    kb = ReplyKeyboardMarkup(
        keyboard=[[
            KeyboardButton(text="🛍 Открыть магазин", web_app=WebAppInfo(url=WEBAPP_URL))
        ]],
        resize_keyboard=True,
    )
    await message.answer(
        "👋 Добро пожаловать!\n\n"
        "Нажмите кнопку ниже, чтобы открыть магазин — там можно "
        "посмотреть товары в наличии или оформить заказ из Китая.",
        reply_markup=kb,
    )


@router.message(F.web_app_data)
async def handle_web_app_data(message: Message, bot: Bot) -> None:
    """Приём данных от мини-аппа: запросы на подбор и заказы из наличия."""
    raw = message.web_app_data.data
    log.info("WebApp data from %s: %s", message.from_user.id if message.from_user else "?", raw[:200])

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        await message.answer("⚠️ Не удалось прочитать данные. Попробуйте ещё раз.")
        return

    manager_chat = get_manager_chat_id()
    if manager_chat is None:
        await message.answer(
            "⚠️ Менеджер пока не подключен к боту. "
            "Мы зафиксировали ваш запрос локально — попробуйте через несколько минут."
        )
        log.warning(
            "Manager chat_id is not set. Tell @%s to send /start to the bot.",
            MANAGER_USERNAME,
        )
        return

    payload_type = payload.get("type")

    if payload_type == "request":
        await handle_request(message, bot, payload, manager_chat)
    elif payload_type == "order":
        await handle_order(message, bot, payload, manager_chat)
    else:
        await message.answer("⚠️ Неизвестный тип запроса.")


async def handle_request(message: Message, bot: Bot, payload: dict, manager_chat: int) -> None:
    """Запрос на подбор товара из Китая."""
    text = (payload.get("text") or "").strip()
    link = (payload.get("link") or "").strip()
    photos_count = int(payload.get("photosCount") or 0)
    req_id = short_id()

    # Формируем сообщение менеджеру
    lines = [
        "🆕 <b>Запрос на подбор</b>",
        f"От: {client_mention(message)}",
        f"ID запроса: <code>{req_id}</code>",
        "",
    ]
    if text:
        lines.append(f"<b>Описание:</b>\n{html.escape(text)}")
    if link:
        lines.append(f"\n<b>Ссылка:</b> {html.escape(link)}")
    if photos_count:
        lines.append(f"\n📎 <i>Прикреплено фото: {photos_count} — ожидаем пересылку от клиента.</i>")

    await bot.send_message(manager_chat, "\n".join(lines))

    # Если есть фото — просим клиента переслать их в чат
    if photos_count > 0:
        set_pending(message.chat.id, req_id)
        await message.answer(
            f"📨 Запрос отправлен менеджеру.\n\n"
            f"Теперь, пожалуйста, <b>пришлите фото</b> следующими сообщениями — "
            f"я перешлю их менеджеру.",
            reply_markup=ReplyKeyboardRemove(),
        )
    else:
        await message.answer("📨 Запрос отправлен менеджеру. Он свяжется с вами в ближайшее время.")


async def handle_order(message: Message, bot: Bot, payload: dict, manager_chat: int) -> None:
    """Заказ из наличия."""
    items = payload.get("items") or []
    total = float(payload.get("total") or 0)
    currency = payload.get("currency") or "USD"

    lines = [
        "🛒 <b>Новый заказ из наличия</b>",
        f"От: {client_mention(message)}",
        "",
        "<b>Состав заказа:</b>",
    ]
    for it in items:
        name = it.get("name_ru") or it.get("name_en") or it.get("id", "—")
        qty = int(it.get("qty") or 1)
        price_usd = float(it.get("price_usd") or 0)
        price_byn = float(it.get("price_byn") or 0)
        unit_price = price_byn if currency == "BYN" else price_usd
        lines.append(
            f"• {html.escape(str(name))} × {qty} = {fmt_price(unit_price * qty, currency)}"
        )
    lines.append("")
    lines.append(f"<b>Итого:</b> {fmt_price(total, currency)}")

    await bot.send_message(manager_chat, "\n".join(lines))
    await message.answer(
        "🎉 Заказ оформлен! Менеджер свяжется с вами для подтверждения и оплаты."
    )


@router.message(F.photo | F.document | F.video)
async def forward_media_to_manager(message: Message, bot: Bot) -> None:
    """
    Пересылка медиа от клиента менеджеру.
    Работает только если у клиента есть "ожидание фото" по последнему запросу
    (открывается на 1 час после отправки запроса с фото).
    """
    user = message.from_user
    if user is None:
        return

    # Менеджеру свои же фото не пересылаем (если он сам себе шлёт)
    if (user.username or "").lower() == MANAGER_USERNAME:
        return

    manager_chat = get_manager_chat_id()
    if manager_chat is None:
        return

    req_id = pop_pending(message.chat.id)
    if not req_id:
        # Клиент шлёт медиа без активного запроса — мягко подсказываем, что делать
        await message.answer(
            "Чтобы прислать фото к запросу, сначала откройте магазин и отправьте запрос "
            "с указанием количества фото. Затем пришлите фото сюда."
        )
        return

    # Подпись с привязкой к запросу
    caption = (
        f"📎 Доп. материал к запросу <code>{req_id}</code>\n"
        f"От: {client_mention(message)}"
    )

    try:
        # forward_message сохраняет оригинал; copy_message — отправляет как от бота с новой подписью
        # Используем copy_message + caption, чтобы менеджер видел, к какому запросу относится фото
        await bot.copy_message(
            chat_id=manager_chat,
            from_chat_id=message.chat.id,
            message_id=message.message_id,
            caption=caption,
        )
    except Exception as e:
        log.exception("Failed to forward media: %s", e)
        await message.answer("⚠️ Не удалось переслать файл менеджеру. Попробуйте ещё раз.")
        return

    # короткое подтверждение клиенту (без спама — без emoji)
    await message.answer("Передано менеджеру.")


@router.message(F.text & ~F.text.startswith("/"))
async def handle_text(message: Message, bot: Bot) -> None:
    """
    Свободный текст от клиента в чате с ботом:
    - если есть «ожидание» — пересылаем менеджеру как доп. инфо
    - иначе подсказываем открыть магазин
    """
    user = message.from_user
    if user is None:
        return

    if (user.username or "").lower() == MANAGER_USERNAME:
        return

    manager_chat = get_manager_chat_id()
    if manager_chat is None:
        return

    req_id = pop_pending(message.chat.id)
    if req_id:
        text = (
            f"💬 Доп. информация к запросу <code>{req_id}</code>\n"
            f"От: {client_mention(message)}\n\n"
            f"{html.escape(message.text or '')}"
        )
        await bot.send_message(manager_chat, text)
        await message.answer("Передано менеджеру.")
    else:
        kb = ReplyKeyboardMarkup(
            keyboard=[[KeyboardButton(text="🛍 Открыть магазин", web_app=WebAppInfo(url=WEBAPP_URL))]],
            resize_keyboard=True,
        )
        await message.answer(
            "Чтобы оформить заказ или запрос на подбор — откройте магазин:",
            reply_markup=kb,
        )


# ============================ MAIN =============================

async def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError(
            "BOT_TOKEN не задан. Установите переменную окружения: "
            "export BOT_TOKEN='ваш_токен_от_BotFather'"
        )

    bot = Bot(
        token=BOT_TOKEN,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dp = Dispatcher()
    dp.include_router(router)

    # Удаляем вебхук на случай, если он был, чтобы long-polling работал чисто
    await bot.delete_webhook(drop_pending_updates=False)

    log.info("Bot started. Manager username: @%s", MANAGER_USERNAME)
    log.info("WebApp URL: %s", WEBAPP_URL)
    if get_manager_chat_id() is None:
        log.warning(
            "Manager chat_id is not set yet. Ask @%s to send /start to the bot.",
            MANAGER_USERNAME,
        )

    await dp.start_polling(bot)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        log.info("Bot stopped.")
