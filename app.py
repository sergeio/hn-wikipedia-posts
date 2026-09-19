#!/usr/bin/env python3
"""HN top posts by domain, with a month-long on-disk cache."""

import json
import re
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR
PORT = 8417
CACHE_DIR = Path(__file__).resolve().parent / ".cache"
CACHE_TTL = 30 * 86400  # one month
API_BASE = "https://hn.algolia.com/api/v1/search"
DEFAULT_DOMAIN = "wikipedia.org"
DEFAULT_COUNT = 50
MAX_COUNT = 1000



def normalize_domain(raw):
    """Return a bare domain name or raise ValueError."""
    raw = raw.strip().lower()
    raw = re.sub(r"^https?://", "", raw)
    raw = raw.split("/")[0].split("?")[0]
    if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", raw):
        raise ValueError("invalid domain")
    return raw


def get_cache_path(domain):
    return CACHE_DIR / (re.sub(r"[^a-z0-9.-]", "_", domain) + ".json")


def read_cache(domain):
    try:
        data = json.loads(get_cache_path(domain).read_text())
        return data if isinstance(data, dict) and "hits" in data else None
    except (OSError, ValueError):
        return None


def write_cache(domain, hits):
    CACHE_DIR.mkdir(exist_ok=True)
    get_cache_path(domain).write_text(
        json.dumps({"fetched_at": int(time.time()), "hits": hits})
    )


def fetch_stories(domain, count):
    """Return (stories, from_cache). Serves stale cache if the API fails."""
    cached = read_cache(domain)
    if cached and time.time() - cached["fetched_at"] < CACHE_TTL:
        return cached["hits"][:count], True

    params = urllib.parse.urlencode(
        {
            "tags": "story",
            "restrictSearchableAttributes": "url",
            "query": domain,
            "hitsPerPage": min(count, MAX_COUNT),
        }
    )
    url = f"{API_BASE}?{params}"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read())
        hits = [
            {
                "id": h["objectID"],
                "title": h.get("title") or h.get("story_title") or "(untitled)",
                "points": h.get("points") or 0,
                "url": h.get("url") or f"https://news.ycombinator.com/item?id={h['objectID']}",
                "domain": h.get("url", "").split("/")[2] if h.get("url") and "://" in h.get("url", "") else domain,
            }
            for h in data.get("hits", [])
        ]
        hits.sort(key=lambda h: h["points"], reverse=True)
        write_cache(domain, hits)
        return hits[:count], False
    except (OSError, ValueError, KeyError):
        if cached:
            return cached["hits"][:count], True
        raise


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            self.serve_static("index.html")
        elif parsed.path in ("/index.html", "/style.css"):
            self.serve_static(parsed.path.lstrip("/"))
        elif parsed.path == "/api/stories":
            qs = urllib.parse.parse_qs(parsed.query)
            try:
                domain = normalize_domain(qs.get("domain", [DEFAULT_DOMAIN])[0])
                count = max(1, min(int(qs.get("count", [DEFAULT_COUNT])[0]), MAX_COUNT))
            except ValueError:
                self.send_json({"error": "invalid domain or count"}, 400)
                return
            try:
                stories, from_cache = fetch_stories(domain, count)
            except Exception:
                self.send_json({"error": "failed to fetch stories"}, 502)
                return
            body = json.dumps(stories).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-Cache", "HIT" if from_cache else "MISS")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def serve_static(self, filename):
        path = (STATIC_DIR / filename).resolve()
        if path.parent != STATIC_DIR.resolve():
            self.send_response(404)
            self.end_headers()
            return
        try:
            body = path.read_bytes()
        except OSError:
            self.send_response(404)
            self.end_headers()
            return
        ctype = CONTENT_TYPES.get(path.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, code):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving on http://127.0.0.1:{PORT}")
    server.serve_forever()
