import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

API_KEY = os.getenv("GEMINI_API_KEY", "")
MODEL = os.getenv("GEMMA_MODEL", "gemma-4-26b-a4b-it")
HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("BRIDGE_PORT", "8765"))
TOKEN = os.getenv("BRIDGE_TOKEN", "")
THINKING = os.getenv("GEMMA_THINKING", "minimal").lower()


def require():
    if not API_KEY:
        raise SystemExit("GEMINI_API_KEY is empty - copy .env.example to .env and fill it in")
    if not TOKEN:
        raise SystemExit("BRIDGE_TOKEN is empty - set any random string in .env")
