"""Three separate tiny intentionally-vulnerable demo SITES (different ports = different localhost
"domains" in the address bar, and each one genuinely different-looking), so a demo can show the tool
working across more than one real-looking site. Same idea as OWASP Juice Shop/DVWA: minimal, yours,
safe to test.

Usage: python scripts/demo_vuln_site.py
Then add "localhost" to the reflection allowlist in Marco's Settings (covers all three ports).
"""
import html
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

# ---------- Site 1: ShopNow - an e-commerce product grid ----------
SHOP_STYLE = """<style>
*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#fafafa;color:#1a1a1a}
header{background:#1a1a2e;color:#fff;padding:18px 28px;display:flex;align-items:center;gap:16px}
header b{font-size:19px}header form{margin-left:auto;display:flex;gap:6px}
main{max-width:900px;margin:0 auto;padding:24px 28px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:16px}
.item{background:#fff;border:1px solid #eee;border-radius:10px;padding:14px;text-align:center}
.item .box{height:70px;background:#f0f0f5;border-radius:8px;margin-bottom:8px}
input,button{font:inherit;padding:8px 11px;border:1px solid #444;border-radius:6px}
button{background:#7c5cff;color:#fff;border:none;cursor:pointer}
.result{background:#fff;border:1px solid #eee;border-radius:10px;padding:20px;margin-top:16px}
a{color:#7c5cff}
</style>"""

def shop_home():
    items = "".join(f'<div class="item"><div class="box"></div>Product {i}</div>' for i in range(1, 7))
    return f"""<html><head><title>ShopNow</title>{SHOP_STYLE}</head><body>
<header><b>ShopNow</b><form action="/search" method="GET"><input type="search" name="q" placeholder="Search products..."><button>Search</button></form></header>
<main><h2>Featured products</h2><div class="grid">{items}</div></main>
</body></html>"""

def shop_result(body_html):
    return f'<html><head>{SHOP_STYLE}</head><body><header><b>ShopNow</b></header><main><div class="result">{body_html}<p><a href="/">&larr; Back to shop</a></p></div></main></body></html>'


# ---------- Site 2: QuickForum - a discussion thread list ----------
FORUM_STYLE = """<style>
*{box-sizing:border-box}body{font:14px/1.6 Georgia,serif;margin:0;background:#fdfaf3;color:#2b2b2b}
header{background:#fff;border-bottom:3px solid #ff7a1a;padding:14px 24px}
header b{font-size:20px;color:#ff7a1a}
main{max-width:680px;margin:0 auto;padding:20px 24px}
.thread{background:#fff;border:1px solid #eadfca;border-left:4px solid #ff7a1a;padding:12px 16px;margin:10px 0;border-radius:4px}
.compose{background:#fff;border:1px solid #eadfca;padding:14px 16px;border-radius:4px;margin-top:16px}
input,button,textarea{font:inherit;padding:8px 11px;border:1px solid #ccc;border-radius:4px}
button{background:#ff7a1a;color:#fff;border:none;cursor:pointer}
a{color:#ff7a1a}
</style>"""

def forum_home():
    threads = "".join(f'<div class="thread">Thread #{i}: Welcome to QuickForum - reply #{i}</div>' for i in range(1, 4))
    return f"""<html><head><title>QuickForum</title>{FORUM_STYLE}</head><body>
<header><b>QuickForum</b> - a demo discussion board</header>
<main>{threads}
<div class="compose"><form action="/post" method="GET"><input type="text" name="msg" placeholder="Write a reply..." style="width:70%"><button>Post</button></form></div>
</main></body></html>"""

def forum_result(body_html):
    return f'<html><head>{FORUM_STYLE}</head><body><header><b>QuickForum</b></header><main>{body_html}<p><a href="/">&larr; Back to board</a></p></main></body></html>'


# ---------- Site 3: LoginPortal - a centered auth-style card ----------
PORTAL_STYLE = """<style>
*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#0f2d1e,#1aa35a)}
.card{background:#fff;border-radius:14px;padding:32px 36px;width:320px;box-shadow:0 20px 50px rgba(0,0,0,.25);text-align:center}
.card h1{font-size:18px;margin:0 0 4px;color:#0f2d1e}
.card p{color:#666;font-size:13px;margin:0 0 18px}
input{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;margin-bottom:10px;font:inherit}
button{width:100%;padding:10px;border:none;border-radius:8px;background:#1aa35a;color:#fff;font:inherit;cursor:pointer}
a{color:#1aa35a;font-size:13px}
</style>"""

def portal_home():
    return f"""<html><head><title>LoginPortal</title>{PORTAL_STYLE}</head><body>
<div class="card"><h1>LoginPortal</h1><p>Sign in to continue</p>
<form action="/feedback" method="GET"><input type="text" name="name" placeholder="Your name"><button type="submit">Continue</button></form>
<p style="margin-top:14px"><a href="/feedback?name=Alex">try with name=Alex</a></p></div>
</body></html>"""

def portal_result(body_html):
    return f'<html><head>{PORTAL_STYLE}</head><body><div class="card">{body_html}<p><a href="/">&larr; Back</a></p></div></body></html>'


SITES = {
    8090: ("ShopNow", shop_home, shop_result),
    8091: ("QuickForum", forum_home, forum_result),
    8092: ("LoginPortal", portal_home, portal_result),
}


def make_handler(name, home_fn, result_fn):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print(f"  [{name}] {self.command} {self.path}", flush=True)

        def do_GET(self):
            try:
                path = urlparse(self.path).path
                qs = parse_qs(urlparse(self.path).query)
                q, msg, nm = qs.get("q", [""])[0], qs.get("msg", [""])[0], qs.get("name", [""])[0]
                if path == "/search":
                    body = result_fn(f"<h2>Results for: {q}</h2><p>No products found.</p>")
                elif path == "/safe":
                    body = result_fn(f"<h2>Results for: {html.escape(q)}</h2><p>No products found.</p>")
                elif path == "/post":
                    body = result_fn(f'<script>var lastPost = "{msg}"; console.log(lastPost);</script><p>Posted.</p>')
                elif path == "/feedback":
                    body = result_fn(f"<h1>Thanks, {nm}!</h1><p>You're signed in.</p>")
                else:
                    body = home_fn()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(body.encode("utf-8"))
            except Exception as e:
                print(f"  [{name}] error: {e}", flush=True)
    return Handler


def serve(port, name, home_fn, result_fn):
    try:
        server = HTTPServer(("127.0.0.1", port), make_handler(name, home_fn, result_fn))
    except OSError as e:
        print(f"Could not start {name} on port {port}: {e}")
        return
    print(f"{name} is UP: http://localhost:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    print("Starting 3 demo sites (each a different look)...\n")
    threads = [threading.Thread(target=serve, args=(port, *cfg), daemon=True) for port, cfg in SITES.items()]
    for t in threads:
        t.start()
    print("\nAll up. Add 'localhost' to the reflection allowlist in Marco - it covers every port.")
    print("Press Ctrl+C to stop.\n")
    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        pass
