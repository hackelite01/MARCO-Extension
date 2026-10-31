"""Local WebSocket bridge between the browser extension and Gemma 4.

One Agent (own memory) per browser tab, identified by the "session" field (the tab id).

Extension -> server:
  {"type":"auth","token"}
  {"type":"user","session","text","via":"voice"|"text","tab":{"title","url"}}
  {"type":"tool_result","id","text","image"(b64 jpeg)}
  {"type":"reset","session"} | {"type":"close","session"}
Server -> extension:
  {"type":"ready","model"}
  {"type":"status","session","text"}
  {"type":"tool_call","id","session","tool","args"}
  {"type":"reply","session","text"(display),"say"(spoken)}
"""
import asyncio
import base64
import hmac
import itertools
import json
from http import HTTPStatus

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from . import config
from .agent import Agent
from .gemma import Gemma

TOOL_TIMEOUT = 60
MAX_SESSIONS = 30
SEND_TIMEOUT = 15      # a ws.send() to a dead/sleeping connection can otherwise hang indefinitely at the OS socket level
OVERALL_TURN_TIMEOUT = 120  # hard ceiling so one request can never hang forever with zero feedback, whatever the cause


async def handle(ws, gemma):
    origin = ws.request.headers.get("Origin", "")
    if not origin.startswith("chrome-extension://"):
        await ws.close(code=4403, reason="origin not allowed")
        return

    try:
        first = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
    except Exception:
        await ws.close(code=4401, reason="auth required")
        return
    if first.get("type") != "auth" or not hmac.compare_digest(str(first.get("token", "")), config.TOKEN):
        await ws.close(code=4401, reason="bad token")
        return

    pending = {}
    ids = itertools.count(1)
    sessions = {}  # session id -> {"agent": Agent, "task": asyncio.Task | None}
    tabinfo = {}   # session id -> {"id", "title", "url"} for every tab that has an agent (pushed by the panel)

    async def send(obj):
        try:
            await asyncio.wait_for(ws.send(json.dumps(obj)), SEND_TIMEOUT)
        except (asyncio.TimeoutError, ConnectionClosed):
            # The socket isn't responding (e.g. the browser slept or suspended the panel without a
            # clean close). Force it shut so the main loop exits, every pending task gets cancelled,
            # and the extension's own reconnect logic picks up on a fresh connection.
            try:
                await asyncio.wait_for(ws.close(code=1011, reason="send timed out"), 5)
            except Exception:
                pass
            raise

    async def call_tool(sid, name, args):
        cid = str(next(ids))
        fut = asyncio.get_running_loop().create_future()
        pending[cid] = fut
        try:
            await send({"type": "tool_call", "id": cid, "session": sid, "tool": name, "args": args})
            return await asyncio.wait_for(fut, TOOL_TIMEOUT)
        except asyncio.TimeoutError:
            return {"text": f"{name} timed out"}
        except ConnectionClosed:
            return {"text": f"{name} failed: lost the connection to the browser"}
        finally:
            pending.pop(cid, None)

    def get_session(sid):
        s = sessions.get(sid)
        if s is None:
            if len(sessions) >= MAX_SESSIONS:  # drop the oldest idle one
                for old, v in list(sessions.items()):
                    if not (v["task"] and not v["task"].done()):
                        sessions.pop(old)
                        break

            async def tool(name, args):
                return await call_tool(sid, name, args)

            async def status(text):
                await send({"type": "status", "session": sid, "text": text})

            async def ask_other(target, question):
                return await consult(sid, target, question)

            s = sessions[sid] = {"agent": Agent(gemma, tool, status, consult=ask_other), "task": None}
        return s

    async def consult(from_sid, target, question):
        """One tab's agent asks another tab's agent a question about its own page."""
        t = target.strip().lower()
        others = {k: v for k, v in tabinfo.items() if k != from_sid}
        pick = next((k for k, v in others.items() if str(v.get("id")) == t), None) or next(
            (k for k, v in others.items()
             if t and (t in (v.get("title") or "").lower() or t in (v.get("url") or "").lower())), None)
        if not pick:
            names = ", ".join(f"{v.get('title')} (id {v.get('id')})" for v in others.values()) or "none"
            return {"text": f"No other tab matches '{target}'. Tabs I know about: {names}."}
        other = get_session(pick)
        if other["task"] and not other["task"].done():
            return {"text": "That tab's agent is busy right now."}
        info = tabinfo[pick]
        await send({"type": "status", "session": from_sid, "text": f"Asking the '{info.get('title')}' tab..."})
        other["task"] = asyncio.current_task()
        other["agent"].consulting = True  # the other agent may read its page, but may not ask further tabs
        try:
            _, display = await asyncio.wait_for(other["agent"].run(question, info, "text"), OVERALL_TURN_TIMEOUT)
        except asyncio.TimeoutError:
            display = f"(the '{info.get('title')}' tab's agent took too long and was skipped)"
        finally:
            other["agent"].consulting = False
            other["task"] = None
        return {"text": f"Answer from the agent of tab '{info.get('title')}' ({info.get('url')}):\n{display}"}

    async def run_turn(sid, text, tab, via):
        try:
            say, display = await asyncio.wait_for(sessions[sid]["agent"].run(text, tab, via), OVERALL_TURN_TIMEOUT)
        except asyncio.TimeoutError:
            # Second line of defence: whatever the cause, never leave the user staring at a status
            # message forever. Something should always come back within this ceiling.
            say = display = "Sorry, that took too long and I gave up. Please try again."
        except Exception as e:  # surface API errors in the UI instead of dying silently
            say = display = f"Sorry, the Gemma request failed: {e}"
        try:
            await send({"type": "reply", "session": sid, "text": display, "say": say})
        except ConnectionClosed:
            pass  # the connection is already gone; the client will reconnect and the user can retry

    await send({"type": "ready", "model": config.MODEL})
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            kind = msg.get("type")
            sid = str(msg.get("session", "0"))
            if kind == "tabs":
                known = {str(x.get("sid")): {"id": x.get("id"), "title": x.get("title"), "url": x.get("url")}
                         for x in msg.get("sessions", [])}
                tabinfo.clear()
                tabinfo.update(known)
            elif kind == "user" and msg.get("text", "").strip():
                if isinstance(msg.get("tab"), dict):
                    tabinfo[sid] = msg["tab"]
                s = get_session(sid)
                if s["task"] and not s["task"].done():
                    await send({"type": "status", "session": sid, "text": "Still working on the last request..."})
                    continue
                s["task"] = asyncio.create_task(run_turn(sid, msg["text"].strip(), msg.get("tab"), msg.get("via", "text")))
            elif kind == "tool_result":
                fut = pending.get(str(msg.get("id")))
                if fut and not fut.done():
                    img = msg.get("image")
                    fut.set_result({"text": msg.get("text", ""), "image": base64.b64decode(img) if img else None})
            elif kind == "reset" and sid in sessions:
                sessions[sid]["agent"].reset()
            elif kind == "close" and sid in sessions:
                t = sessions.pop(sid)["task"]
                if t:
                    t.cancel()
    except ConnectionClosed:
        pass  # side panel closed or reloaded: normal
    finally:
        for s in sessions.values():
            if s["task"]:
                s["task"].cancel()


def reject_plain_http(connection, request):
    """Answer non-WebSocket requests (a browser tab, a port scan) quietly instead of logging a traceback."""
    conn = request.headers.get("Connection", "").lower()
    if request.headers.get("Upgrade", "").lower() != "websocket" or "upgrade" not in conn:
        return connection.respond(HTTPStatus.UPGRADE_REQUIRED, "Marco bridge: WebSocket only.\n")
    return None


async def main():
    config.require()
    gemma = Gemma()
    async with serve(lambda ws: handle(ws, gemma), config.HOST, config.PORT,
                     max_size=8 * 1024 * 1024, process_request=reject_plain_http):
        print(f"Marco bridge listening on ws://{config.HOST}:{config.PORT}  (model: {config.MODEL})")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
