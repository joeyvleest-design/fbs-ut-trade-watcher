#!/usr/bin/env python3
"""Read reviewed public feeds, not article pages or hidden market endpoints.

One request per enabled feed per scheduled run. Store at most a short headline,
publisher, publication time and link. Editorial summaries are written separately
after source checking. Nothing in this module changes trades, card confirmation,
prices or Discord delivery state.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
import html
import json
from pathlib import Path
import re
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree as ET

SITE = "https://joeyvleest-design.github.io/fbs-ut-trade-watcher/"
LIMIT = 2_000_000
STATUSES = {"confirmed_official", "reported", "rumour", "opinion"}
PERMISSIONS = {
    "rss": "publisher_recommended_link_discovery",
    "atom": "publisher_recommended_link_discovery",
    "steam_news": "documented_public_api_personal_application",
}


def record(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def records(value: object) -> list[dict]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except (ValueError, OverflowError):
        try:
            result = parsedate_to_datetime(value)
            return result.astimezone(timezone.utc) if result.tzinfo else None
        except (TypeError, ValueError, OverflowError):
            return None


def clean(value: object, words: int = 20) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))
    text = " ".join(text.split())
    parts = text.split()
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


def safe_url(value: object, hosts: list[str] | None = None) -> str | None:
    if not isinstance(value, str) or value != value.strip() or re.search(r"[\x00-\x20\x7f\\]", value):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        if hosts is not None and (not isinstance(hosts, list) or not hosts or parsed.hostname not in hosts):
            return None
        query = [(key, val) for key, val in parse_qsl(parsed.query) if not key.lower().startswith("utm_") and key not in {"fbclid", "gclid"}]
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))
    except ValueError:
        return None


def fetch(url: str, hosts: list[str]) -> bytes:
    if not safe_url(url, hosts):
        raise ValueError("Unapproved source URL")

    class ApprovedRedirects(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, message, headers, newurl):
            if not safe_url(newurl, hosts):
                raise ValueError("Redirect outside reviewed publisher")
            return super().redirect_request(request, fp, code, message, headers, newurl)

    request = Request(url, headers={"User-Agent": "FBS-UT-Trade-Watcher/1.0 (+" + SITE + ")", "Accept": "application/rss+xml, application/atom+xml, application/json, application/xml;q=0.9"})
    with build_opener(ApprovedRedirects()).open(request, timeout=15) as response:
        raw = response.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError("Feed exceeds size limit")
    return raw


def reviewed_source(source: dict, now: datetime) -> bool:
    kind = source.get("kind")
    reviewed = timestamp(source.get("policy_reviewed_at"))
    expiry = timestamp(source.get("review_expires_at"))
    if not (source.get("enabled") is True and isinstance(kind, str)
            and kind in PERMISSIONS and source.get("permission_basis") == PERMISSIONS[kind]
            and reviewed and expiry and reviewed <= now < expiry
            and all(isinstance(source.get(key), str) and source[key].strip() for key in ("id", "name"))
            and isinstance(source.get("hosts"), list) and source["hosts"]
            and isinstance(source.get("article_hosts"), list) and source["article_hosts"]
            and safe_url(source.get("url"), source["hosts"])):
        return False
    if kind == "steam_news":
        parsed = urlsplit(source["url"])
        query = parse_qsl(parsed.query)
        params = dict(query)
        # This permission covers only this documented, keyless news method.
        return (source.get("app_id") == 4080220 and parsed.hostname == "api.steampowered.com"
                and parsed.path == "/ISteamNews/GetNewsForApp/v2/" and len(query) == len(params)
                and set(params) <= {"appid", "count", "maxlength", "feeds", "format"}
                and params.get("appid") == "4080220" and params.get("maxlength") == "1"
                and params.get("feeds") == "steam_community_announcements"
                and params.get("format", "json") == "json")
    return True


def article_url(value: object, source: dict) -> str | None:
    hosts = source.get("article_hosts")
    if not isinstance(hosts, list) or not hosts:
        return None
    url = safe_url(value, hosts)
    if url and source.get("kind") == "steam_news":
        parsed = urlsplit(url)
        valid_path = ((parsed.hostname == "steamstore-a.akamaihd.net" and re.fullmatch(r"/news/externalpost/steam_community_announcements/\d+/?", parsed.path))
                      or (parsed.hostname == "steamcommunity.com" and re.fullmatch(r"/games/4080220/announcements/detail/\d+/?", parsed.path)))
        if not valid_path or parsed.query:
            return None
    return url


def read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".radar-", delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
        temp = Path(handle.name)
    temp.replace(path)


def parse_feed(raw: bytes, source: dict) -> list[dict]:
    if len(raw) > LIMIT:
        raise ValueError("Feed exceeds size limit")
    if source["kind"] == "steam_news":
        payload = json.loads(raw)
        news = record(payload).get("appnews")
        if not isinstance(news, dict) or news.get("appid") != source["app_id"] or not isinstance(news.get("newsitems"), list):
            raise ValueError("Wrong Steam application or news schema")
        if any(not isinstance(item, dict) for item in news["newsitems"]):
            raise ValueError("Malformed Steam news item")
        result = []
        for item in news["newsitems"]:
            if item.get("feedname") != "steam_community_announcements":
                continue
            value = item.get("date")
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            try:
                published = iso(datetime.fromtimestamp(value, timezone.utc))
            except (OverflowError, OSError, ValueError):
                continue
            result.append({"title": item.get("title"), "url": item.get("url"), "published_at": published, "context": ""})
        return result
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("Unsafe or oversized XML")
    root = ET.fromstring(raw)
    if root.tag == "rss" and root.find("channel") is not None:
        return [{"title": node.findtext("title"), "url": node.findtext("link"), "published_at": node.findtext("pubDate"), "context": node.findtext("description") or ""} for node in root.findall("./channel/item")[:100]]
    ns = {"a": "http://www.w3.org/2005/Atom"}
    if root.tag == "{http://www.w3.org/2005/Atom}feed":
        result = []
        for node in root.findall("a:entry", ns)[:100]:
            links = [link.get("href") for link in node.findall("a:link", ns) if link.get("rel", "alternate") == "alternate"]
            result.append({"title": node.findtext("a:title", namespaces=ns), "url": links[0] if links else None, "published_at": node.findtext("a:published", namespaces=ns) or node.findtext("a:updated", namespaces=ns), "context": node.findtext("a:summary", namespaces=ns) or ""})
        return result
    raise ValueError("Response is not an RSS or Atom feed")


def relevant(item: dict, source: dict) -> bool:
    if source.get("app_id") == 4080220 and source["kind"] == "steam_news":
        return True
    text = clean(str(item.get("title", "")) + " " + str(item.get("context", "")), 400)
    if re.search(r"\b(?:FC|FIFA)\s*Mobile\b", text, re.I):
        return False
    if re.search(r"\bFC\s*27\b", text, re.I):
        return True
    if re.search(r"\bFC\s*(?:2[0-6]|28|29)\b", text, re.I):
        return False
    return bool(re.search(r"\b(?:EA\s+Sports\s+FC|Football\s+Ultimate\s+Team)\b", text, re.I))


def reference(item: dict, source: dict, url: str, at: datetime, checked: datetime, expiry: datetime, scope: str, status: str) -> dict:
    # A publication switch never widens a link-discovery permission.
    publish_title = (source.get("kind") == "steam_news"
                     and source.get("permission_basis") == PERMISSIONS["steam_news"]
                     and source.get("publish_title") is True)
    return {
        "id": hashlib.sha256(url.encode()).hexdigest()[:20],
        "title": clean(item.get("title")) if publish_title else f"Nieuw {scope}-bericht bij {source['name']}",
        "summary": "Verwijzing uit de gepubliceerde feed; lees het bericht bij de uitgever. Geen artikeltekst overgenomen en nog geen eigen inhoudelijke verificatie.",
        "status": status if isinstance(status, str) and status in {"reported", "rumour", "opinion"} else "reported",
        "classification_basis": "feed_headline_only", "game_scope": scope, "source_id": source["id"],
        "source": {"label": source["name"], "url": url},
        "published_at": iso(at), "checked_at": iso(checked), "expires_at": iso(expiry),
        "impact": "Signaal om verder te onderzoeken. Geen bevestigde kaart, prijsverwachting of koopcall.",
        "original_source_url": None,
    }


def feed_item(item: dict, source: dict, now: datetime) -> dict | None:
    if not isinstance(item, dict) or not isinstance(item.get("title"), str):
        return None
    url = article_url(item.get("url"), source)
    at = timestamp(item.get("published_at"))
    title = clean(item.get("title"))
    if not url or not title or not at or at > now + timedelta(minutes=5) or at < now - timedelta(days=14) or not relevant(item, source):
        return None
    # This is a headline flag, not a truth assessment. Third-party reporting
    # never promotes a player's card to officially confirmed.
    if re.search(r"\b(?:rumou?rs?|leaks?|leaked|prediction|predicts?|reportedly|gerucht|voorspelling)\b", title, re.I):
        status = "rumour"
    else:
        status = source.get("default_status", "reported")
    context = clean(title + " " + str(item.get("context", "")), 400)
    scope = "FC27" if source["kind"] == "steam_news" or re.search(r"\bFC\s*27\b", context, re.I) else "EA SPORTS FC"
    return reference(item, source, url, at, now, at + timedelta(days=3), scope, status)


def retained_item(item: dict, source: dict, now: datetime) -> dict | None:
    """Reapply current source policy without claiming a new source check."""
    if item.get("source_id") != source["id"] or not isinstance(item.get("title"), str) or not item["title"].strip():
        return None
    url = article_url(record(item.get("source")).get("url"), source)
    at, checked, expiry = (timestamp(item.get(key)) for key in ("published_at", "checked_at", "expires_at"))
    if not (url and at and checked and expiry and now - timedelta(days=14) <= at <= checked <= now + timedelta(minutes=5) and expiry > at):
        return None
    # Old link-only snapshots did not distinguish an explicit game edition.
    # Do not reconstruct FC27 certainty from their former generic labels.
    scope = "FC27" if source["kind"] == "steam_news" or item.get("game_scope") == "FC27" else "EA SPORTS FC"
    return reference(item, source, url, at, checked, expiry, scope, item.get("status"))


def build_radar(config: dict, editorial: dict, previous: dict, now: datetime, fetcher=fetch) -> dict:
    config, editorial, previous = record(config), record(editorial), record(previous)
    previous = previous if previous.get("game") == "FC27" else {}
    prior_sources = {row["id"]: row for row in records(previous.get("sources")) if isinstance(row.get("id"), str)}
    sources, items = [], []
    for source in records(config.get("sources")):
        if not isinstance(source.get("id"), str):
            continue
        row = {key: source[key] for key in ("id", "name", "kind", "url", "policy_url", "terms_url", "policy_reviewed_at") if key in source}
        prior = prior_sources.get(source["id"], {})
        last_success = timestamp(prior.get("last_success_at"))
        row.update(checked_at=None, last_success_at=iso(last_success) if last_success and last_success <= now else None, matched_items=0, usage_note=source.get("detail"))
        if not reviewed_source(source, now):
            row.update(status="manual_only" if source.get("kind") == "manual" else "disabled", detail=source.get("detail") or "Automatische toegang niet geactiveerd; toegangsgrond eerst controleren.")
            sources.append(row)
            continue
        row["checked_at"] = iso(now)
        try:
            parsed = parse_feed(fetcher(source["url"], source["hosts"]), source)
            found = [entry for entry in (feed_item(item, source, now) for item in parsed) if entry]
            # At most one headline per publisher: avoid mirroring a news feed.
            found.sort(key=lambda item: item["published_at"], reverse=True)
            items.extend(found[:1])
            row.update(status="ok", last_success_at=iso(now), matched_items=len(found), detail="Feed gelezen; maximaal één bronverwijzing. Geen artikeltekst, afbeeldingen of prijzen gekopieerd.")
        except (OSError, URLError, ValueError, ET.ParseError) as exc:
            status = f"HTTP {exc.code}" if isinstance(exc, HTTPError) else type(exc).__name__
            row.update(status="unavailable", detail=f"Feed niet bereikbaar ({status}). Geen omweg of nieuwe bronbevestiging; eerdere koppen behouden zolang relevant.")
            kept = [entry for entry in (retained_item(item, source, now) for item in records(previous.get("items"))) if entry]
            kept.sort(key=lambda item: item["published_at"], reverse=True)
            items.extend(kept[:1])
        sources.append(row)
    # Reviewed editorial records override a matching feed link; nothing is
    # learned from or executed based on the contents of an external article.
    if editorial.get("game") == "FC27":
        for item in records(editorial.get("items")):
            if not isinstance(item.get("status"), str) or item["status"] not in STATUSES or not safe_url(record(item.get("source")).get("url")):
                continue
            if not all(isinstance(item.get(key), str) and item[key].strip() for key in ("id", "title")):
                continue
            copy = {key: item[key] for key in ("id", "title", "summary", "status", "published_at", "published_precision", "checked_at", "expires_at") if isinstance(item.get(key), str)}
            original_source = record(item.get("source"))
            copy["source"] = {"url": safe_url(original_source.get("url")), "label": original_source.get("label") if isinstance(original_source.get("label"), str) else "Redactionele bron"}
            copy["original_source_url"] = safe_url(item.get("original_source_url"))
            if isinstance(item.get("impact"), str):
                copy["impact"] = item["impact"]
            elif isinstance(item.get("impact"), list):
                copy["impact"] = [value for value in item["impact"] if isinstance(value, str)]
            copy["source_id"] = "editorial"
            items.append(copy)
    by_url = {}
    for item in items:
        at = timestamp(item.get("published_at"))
        checked = timestamp(item.get("checked_at"))
        expiry = timestamp(item.get("expires_at"))
        url = safe_url(record(item.get("source")).get("url"))
        if at and checked and expiry and url and now - timedelta(days=14) <= at <= now + timedelta(minutes=5) and at <= checked <= now + timedelta(minutes=5) and expiry > at:
            by_url[url] = item
    ordered = sorted(by_url.values(), key=lambda item: item["published_at"], reverse=True)[:12]
    return {
        "game": "FC27", "checked_at": iso(now), "updated_at": iso(now),
        "items": ordered, "sources": sources,
        "editorial_checked_at": editorial.get("updated_at"),
        "editorial_notice": editorial.get("notice"),
        "notice": "Dagelijks en op de vaste release-avonden: gepubliceerde feeds plus apart gecontroleerde nieuws- en geruchtbronnen. Geen 24/7 marktscan. Geruchten zijn geen feiten; na hun termijn gaan berichten naar het archief. Steam-gegevens worden aangeboden zoals beschikbaar, zonder garantie op volledigheid, juistheid of beschikbaarheid. FBS is niet verbonden aan of goedgekeurd door Valve/Steam.",
        "method": "Feeds worden op FC27 of algemeen EA SPORTS FC-nieuws gefilterd; een onbekende editie wordt niet als FC27 bevestigd. Derdepartijberichtgeving blijft onbevestigd; meerdere sites die dezelfde leaker napraten tellen niet als onafhankelijke bevestiging. Geruchten veranderen geen kaartstatus of koopgrens.",
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-root", type=Path, default=Path.cwd())
    parser.add_argument("--restore-published", action="store_true")
    parser.add_argument("--now")
    args = parser.parse_args(argv)
    now = timestamp(args.now) if args.now else datetime.now(timezone.utc)
    if not now:
        parser.error("--now requires an ISO timestamp with timezone")
    site = args.site_root / "site" if (args.site_root / "site").is_dir() else args.site_root
    path = site / "data" / "news-radar.json"
    previous = read(path)
    if args.restore_published:
        try:
            public = json.loads(fetch(SITE + "data/news-radar.json", ["joeyvleest-design.github.io"]))
            if not isinstance(public, dict):
                raise ValueError("Public radar is not an object")
            at, local_at = timestamp(public.get("checked_at")), timestamp(previous.get("checked_at"))
            if public.get("game") == "FC27" and isinstance(public.get("items"), list) and isinstance(public.get("sources"), list) and at and at <= now and (not local_at or at > local_at):
                previous = public
        except (OSError, URLError, ValueError):
            print("Previous public radar unavailable; repository snapshot retained. No successful source check inferred.")
    config = read(Path(__file__).with_name("radar_sources.json"))
    if not isinstance(config.get("sources"), list):
        raise ValueError("Reviewed source registry missing")
    payload = build_radar(config, read(site / "data" / "editorial-radar.json"), previous, now)
    write(path, payload)
    print(f"Radar: {len(payload['items'])} linked items; {sum(source['status'] == 'ok' for source in payload['sources'])} feeds checked successfully. No prices or Discord posts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
