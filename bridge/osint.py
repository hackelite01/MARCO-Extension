"""Public, read-only domain information: RDAP (the modern, structured replacement for WHOIS) plus
basic DNS resolution. This never connects to the target site itself - only to public registry (RDAP)
and DNS infrastructure, the same information any `whois`/`dig` command or registrar lookup page would
show. No port scanning, no probing of the target's own servers.
"""
import asyncio
import json
import socket
import urllib.error
import urllib.request

RDAP_URL = "https://rdap.org/domain/{domain}"
TIMEOUT = 8


def _fetch_rdap(domain):
    req = urllib.request.Request(RDAP_URL.format(domain=domain), headers={"Accept": "application/rdap+json", "User-Agent": "marco-bridge/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8", "replace")), None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, "No RDAP record found (the domain may be unregistered, or this TLD isn't covered by the public RDAP network)."
        return None, f"RDAP lookup failed: HTTP {e.code}"
    except Exception as e:
        return None, f"RDAP lookup failed: {e}"


def _resolve_a_records(domain):
    try:
        _, _, ips = socket.gethostbyname_ex(domain)
        return ips, None
    except Exception as e:
        return [], str(e)


def _registrar_name(entity):
    vcard = entity.get("vcardArray")
    if vcard and len(vcard) > 1:
        for field in vcard[1]:
            if field[0] == "fn":
                return field[3]
    return None


def _summarize_rdap(data):
    events = {e.get("eventAction"): e.get("eventDate") for e in data.get("events", [])}
    registrar = next((e for e in data.get("entities", []) if "registrar" in (e.get("roles") or [])), None)
    return {
        "registered": events.get("registration"),
        "expires": events.get("expiration"),
        "last_changed": events.get("last changed"),
        "nameservers": [ns.get("ldhName") for ns in data.get("nameservers", []) if ns.get("ldhName")],
        "registrar": _registrar_name(registrar) if registrar else None,
        "status": data.get("status", []),
    }


async def lookup_domain(domain):
    """Returns a short human-readable summary. Public registry + DNS data only, no port scanning."""
    domain = domain.strip().lower().rstrip(".")
    if not domain or "/" in domain:
        return f"'{domain}' doesn't look like a plain domain name (no https://, no path)."

    rdap, rdap_err = await asyncio.to_thread(_fetch_rdap, domain)
    ips, dns_err = await asyncio.to_thread(_resolve_a_records, domain)

    lines = [f"Public registry and DNS info for {domain} (no connection made to the site itself, only to public registry/DNS infrastructure):"]
    if rdap:
        s = _summarize_rdap(rdap)
        if s["registrar"]:
            lines.append(f"Registrar: {s['registrar']}")
        if s["registered"]:
            lines.append(f"Registered: {s['registered']}")
        if s["expires"]:
            lines.append(f"Expires: {s['expires']}")
        if s["last_changed"]:
            lines.append(f"Last changed: {s['last_changed']}")
        if s["nameservers"]:
            lines.append(f"Name servers: {', '.join(s['nameservers'][:4])}")
        if s["status"]:
            lines.append(f"Status: {', '.join(s['status'][:3])}")
    else:
        lines.append(f"Registry info unavailable: {rdap_err}")

    if ips:
        lines.append(f"Resolves to (A records): {', '.join(ips[:5])}")
    else:
        lines.append(f"DNS resolution: {dns_err or 'no A records found'}")
    return "\n".join(lines)
