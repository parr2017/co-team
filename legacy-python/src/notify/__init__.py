import logging
import os
import threading
from datetime import datetime

import httpx

logger = logging.getLogger("coteam.notify")


def notify(event_type: str, payload: dict, message: str = "") -> None:
    """Task-lifecycle notification: log + event bus + webhook/Feishu (fire-and-forget)."""
    text = message or f"[Co-Team] {event_type}: {payload.get('task_id', '')}"
    logger.info(text)

    try:
        from src.shared.state import EventChannel, emit_event

        emit_event(EventChannel.NOTIFY, event_type, {"message": text, **payload})
    except Exception:
        pass

    feishu = os.environ.get("COTEAM_FEISHU_WEBHOOK", "")
    if feishu:
        threading.Thread(target=_post_feishu, args=(feishu, text), daemon=True).start()

    webhook = os.environ.get("COTEAM_WEBHOOK", "")
    if webhook:
        threading.Thread(target=_post_webhook, args=(webhook, event_type, text, payload), daemon=True).start()


def _post_feishu(url: str, text: str) -> None:
    try:
        httpx.post(url, json={"msg_type": "text", "content": {"text": text}}, timeout=5)
    except Exception as e:
        logger.debug("feishu delivery failed: %s", e)


def _post_webhook(url: str, event_type: str, text: str, payload: dict) -> None:
    try:
        httpx.post(
            url,
            json={"event": event_type, "message": text, "payload": payload, "ts": datetime.now().isoformat()},
            timeout=5,
        )
    except Exception as e:
        logger.debug("webhook delivery failed: %s", e)
