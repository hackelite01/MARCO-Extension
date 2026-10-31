"""List the Gemma models your API key can call (prints names only, never the key)."""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from google import genai

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

key = os.getenv("GEMINI_API_KEY")
if not key:
    sys.exit("GEMINI_API_KEY is empty - fill it in .env first")

client = genai.Client(api_key=key)
found = [m for m in client.models.list() if "gemma" in m.name.lower()]

if not found:
    sys.exit("No Gemma models visible to this key.")

for m in sorted(found, key=lambda m: m.name):
    actions = ", ".join(m.supported_actions or [])
    print(f"{m.name}  [{actions}]")

print("\nCopy the id after 'models/' for a Gemma 4 entry into GEMMA_MODEL in .env")
