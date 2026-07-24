import asyncio
import logging
import os
import sys
import threading
import time

from flask import Flask
from telegram.error import Conflict
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    MessageHandler,
    filters,
)

from admin import admin_callback, admin_command, broadcast_command
from config import BOT_TOKEN
from handlers import about_command, handle_message, start_command

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("werkzeug").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)

keepalive_app = Flask(__name__)

bot_status = {"polling": False, "last_error": None}
start_time = time.time()

def format_uptime(seconds: float) -> str:
    seconds = int(seconds)
    days, seconds = divmod(seconds, 86400)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours or days:
        parts.append(f"{hours}h")
    if minutes or hours or days:
        parts.append(f"{minutes}m")
    parts.append(f"{seconds}s")
    return " ".join(parts)

@keepalive_app.route("/")
def home():
    uptime = format_uptime(time.time() - start_time)
    return f"All Media Downloader bot is alive. Uptime: {uptime}", 200

@keepalive_app.route("/health")
def health():
    uptime_seconds = time.time() - start_time
    if bot_status["polling"]:
        return {"status": "ok", "polling": True, "uptime_seconds": int(uptime_seconds), "uptime": format_uptime(uptime_seconds)}, 200
    return {"status": "degraded", "polling": False, "last_error": bot_status["last_error"], "uptime_seconds": int(uptime_seconds), "uptime": format_uptime(uptime_seconds)}, 200

def run_keepalive_server(ready_event: threading.Event) -> None:
    port = int(os.environ.get("PORT", 8080))
    try:
        ready_event.set()
        keepalive_app.run(host="0.0.0.0", port=port, use_reloader=False)
    except Exception:
        logger.exception("Keep-alive Flask server crashed")
        ready_event.set()

def main() -> None:
    if not BOT_TOKEN:
        logger.error("BOT_TOKEN environment variable is not set. Exiting.")
        sys.exit(1)

    flask_ready = threading.Event()
    threading.Thread(
        target=run_keepalive_server, args=(flask_ready,), daemon=True
    ).start()
    if not flask_ready.wait(timeout=15):
        logger.error(
            "Keep-alive server did not signal readiness within 15s; "
            "continuing anyway, but Render's port check may fail."
        )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    application = Application.builder().token(BOT_TOKEN).build()

    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("about", about_command))
    application.add_handler(CommandHandler("admin", admin_command))
    application.add_handler(CommandHandler("broadcast", broadcast_command))
    application.add_handler(CallbackQueryHandler(admin_callback, pattern=r"^admin:"))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    logger.info("All Media Downloader bot starting...")

    max_attempts = 5
    for attempt in range(1, max_attempts + 1):
        try:
            bot_status["polling"] = True
            application.run_polling(
                allowed_updates=["message", "callback_query"],
                drop_pending_updates=True,
            )
            break
        except Conflict as e:
            bot_status["polling"] = False
            bot_status["last_error"] = str(e)
            if attempt == max_attempts:
                logger.error(
                    "Another bot instance is running with the same BOT_TOKEN "
                    "and would not yield after %d attempts. Only one instance "
                    "can poll at a time — stop the other deployment/service "
                    "using this token.",
                    max_attempts,
                )
                logger.warning("Cooling down 60s before retrying polling loop.")
                time.sleep(60)
                attempt = 0
                continue
            wait_seconds = min(5 * attempt, 20)
            logger.warning(
                "Conflict: another instance is polling with this BOT_TOKEN "
                "(attempt %d/%d). Retrying in %ds...",
                attempt,
                max_attempts,
                wait_seconds,
            )
            time.sleep(wait_seconds)
        except Exception as e:
            bot_status["polling"] = False
            bot_status["last_error"] = str(e)
            logger.exception("run_polling() failed unexpectedly; retrying in 15s")
            time.sleep(15)

if __name__ == "__main__":
    main()