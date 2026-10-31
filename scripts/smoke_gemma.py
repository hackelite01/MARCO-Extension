"""Check that Gemma 4 answers, follows the JSON tool protocol and accepts images."""
import asyncio
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bridge import config
from bridge.agent import _system_prompt, parse_tool_call
from bridge.gemma import Gemma


def red_png(size=64):
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * size for _ in range(size))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


async def main():
    config.require()
    g = Gemma()
    system = _system_prompt()
    print("model:", g.model)

    r = await g.chat(system, [{"role": "user", "text": "Namaste! Who are you, in one short line?"}])
    print("\n[1] chat ->", r)

    r = await g.chat(system, [{"role": "user", "text": "Please summarise the page I'm on."}])
    print("\n[2] tool protocol ->", r, "\n    parsed:", parse_tool_call(r))

    img = red_png()
    try:
        r = await g.chat("Answer in one word.", [{"role": "user", "text": "What colour is this image?", "image": img}])
        print("\n[3] vision ->", r)
    except Exception as e:
        print("\n[3] vision FAILED ->", e)
    print("\nsystem_instruction folded into prompt:", g._system_in_prompt)


asyncio.run(main())
