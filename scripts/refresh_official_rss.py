#!/usr/bin/env python3
"""Refresh the public FBS Marketwatch from EA's explicitly published RSS feed.

This worker deliberately reads one documented RSS endpoint.  It does not crawl the
EA FC site, query a hidden endpoint, scrape a price site, or look at X.  It is safe
to run from GitHub Actions because the generated JSON contains only public editorial
copy and direct source links, never a credential or a fabricated market price.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import hashlib
from html import unescape
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree
from uuid import uuid4
from zoneinfo import ZoneInfo


EA_PRESS_RSS = "https://news.ea.com/rss/pressrelease.aspx"
PUBLISHED_SITE_URL = "https://joeyvleest-design.github.io/fbs-ut-trade-watcher/"
AMSTERDAM = ZoneInfo("Europe/Amsterdam")
FC_PATTERN = re.compile(r"\b(?:ea\s+sports\s+fc|football\s+ultimate\s+team|ultimate\s+team|\bfut\b|fc\s*2[5-9])\b", re.IGNORECASE)
TAG_PATTERN = re.compile(r"<[^>]+>")
WHITESPACE_PATTERN = re.compile(r"\s+")


@dataclass(frozen=True)
class FeedEntry:
    title: str
    summary: str
    url: str
    published_at: str | None = None
    guid: str | None = None


@dataclass(frozen=True)
class RefreshResult:
    due: bool
    kind: str | None
    marketwatch: dict[str, object] | None
    delivery_id: str | None = None


def _clean(value: str | None) -> str:
    return WHITESPACE_PATTERN.sub(" ", unescape(TAG_PATTERN.sub(" ", value or ""))).strip()


def _utc_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _site_root(root: Path) -> Path:
    """Support both the source repository (``site/``) and public static root."""
    return root / "site" if (root / "site").is_dir() else root


def _read_json(path: Path) -> dict[str, object]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _write_json_atomically(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.stem}-", suffix=".json", delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def fetch_rss(url: str) -> bytes:
    request = Request(url, headers={"Accept": "application/rss+xml, application/xml;q=0.9", "User-Agent": "FBS-UT-Trade-Watcher/1.0"})
    with urlopen(request, timeout=20) as response:  # nosec B310 - URL is an explicit RSS configuration value
        return response.read()


def parse_rss(raw: bytes, source_url: str) -> list[FeedEntry]:
    try:
        root = ElementTree.fromstring(raw)
    except ElementTree.ParseError as exc:
        raise ValueError("EA Press RSS returned invalid XML") from exc
    if root.tag != "rss" or root.find("channel") is None:
        raise ValueError("EA Press RSS did not return an RSS channel")
    entries: list[FeedEntry] = []
    for node in root.findall(".//item"):
        title = _clean(node.findtext("title"))
        summary = _clean(node.findtext("description"))
        link = _clean(node.findtext("link")) or source_url
        if title:
            published_at = None
            if published := _clean(node.findtext("pubDate")):
                try:
                    parsed = parsedate_to_datetime(published)
                    if parsed.tzinfo:
                        published_at = _utc_timestamp(parsed)
                except (TypeError, ValueError, OverflowError):
                    pass
            entries.append(FeedEntry(title=title, summary=summary, url=link, published_at=published_at, guid=_clean(node.findtext("guid")) or None))
    return entries


def relevant_entries(entries: list[FeedEntry]) -> list[FeedEntry]:
    return [entry for entry in entries if FC_PATTERN.search(f"{entry.title} {entry.summary}")][:3]


def content_fingerprint(entries: list[FeedEntry]) -> str:
    """Hash source content, never the current check date or display ordering."""
    items = [
        {"title": entry.title, "summary": entry.summary, "url": entry.url, "published_at": entry.published_at, "guid": entry.guid}
        for entry in entries
    ]
    canonical = json.dumps(sorted(items, key=lambda item: (item["guid"] or item["url"], item["title"])), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def scheduled_slot(now: datetime, cron: str | None = None) -> datetime | None:
    """Resolve the intended UTC slot, rather than the delayed runner start time.

    Separate winter/summer cron entries let Actions tell us which candidate fired.
    Only the candidate that was actually 08:00 or 19:01 in Amsterdam is accepted.
    The legacy local worker can still use its bounded wall-clock window.
    """
    now = now.astimezone(timezone.utc)
    if cron is not None:
        candidates = {
            "0 6 * * *": (6, 0, None),
            "0 7 * * *": (7, 0, None),
            "1 17 * * 0,3,5": (17, 1, {2, 4, 6}),
            "1 18 * * 0,3,5": (18, 1, {2, 4, 6}),
        }
        if cron not in candidates:
            raise ValueError("Unrecognised FBS schedule expression")
        hour, minute, weekdays = candidates[cron]
        slot = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if slot > now:
            slot -= timedelta(days=1)
        if weekdays is not None and slot.weekday() not in weekdays:
            return None
        local = slot.astimezone(AMSTERDAM)
        expected_hour = 8 if weekdays is None else 19
        return slot if local.hour == expected_hour else None

    local = now.astimezone(AMSTERDAM)
    if local.hour == 8 and local.minute <= 30:
        return local.replace(minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    if local.hour == 19 and 1 <= local.minute <= 30 and local.weekday() in {2, 4, 6}:
        return local.replace(minute=1, second=0, microsecond=0).astimezone(timezone.utc)
    return None


def scheduled_kind(now: datetime, cron: str | None = None) -> str | None:
    slot = scheduled_slot(now, cron)
    if slot is None:
        return None
    local = slot.astimezone(AMSTERDAM)
    if local.hour == 8:
        return "morning"
    if local.weekday() == 2:
        return "totw"
    if local.weekday() == 4:
        return "promo"
    if local.weekday() == 6:
        return "weekend_sbc"
    return None


def _timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def fetch_published_json(url: str) -> bytes:
    request = Request(url, headers={"Accept": "application/json", "Cache-Control": "no-cache", "User-Agent": "FBS-UT-Trade-Watcher/1.0"})
    with urlopen(request, timeout=20) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("Published JSON exceeds the snapshot size limit")
    return raw


def _merge_delivery_history(target: dict[str, object], other: dict[str, object]) -> None:
    """Preserve delivery history even when editorial source JSON is newer in git."""
    previous = other.get("automation", {})
    if not isinstance(previous, dict):
        return
    previous_seen = previous.get("discord_reserved_fingerprints", [])
    previous_delivery = previous.get("discord_delivery")
    if not previous_seen and not isinstance(previous_delivery, dict):
        return
    current = target.setdefault("automation", {})
    if not isinstance(current, dict):
        return
    fingerprints = []
    for values in (previous_seen, current.get("discord_reserved_fingerprints", [])):
        if isinstance(values, list):
            for value in values:
                if isinstance(value, str) and value not in fingerprints:
                    fingerprints.append(value)
    current["discord_reserved_fingerprints"] = fingerprints[-64:]
    deliveries = [value for value in (previous_delivery, current.get("discord_delivery")) if isinstance(value, dict)]
    if deliveries:
        def order(value: dict[str, object]) -> tuple[datetime, bool]:
            at = _timestamp(value.get("confirmed_at")) or _timestamp(value.get("attempted_at")) or _timestamp(value.get("prepared_at"))
            return at or datetime.min.replace(tzinfo=timezone.utc), value.get("status") == "confirmed"
        current["discord_delivery"] = max(deliveries, key=order)


def _merge_dutch_watch(target: dict[str, object], other: dict[str, object]) -> None:
    """Roster revisions and RSS checks have independent clocks.

    An automatic RSS timestamp must not roll back a manually verified roster.
    Older files have no section timestamp; an explicitly dated section wins.
    Neither the source timestamp nor the overall release date is advanced here.
    """
    target_at = _timestamp(target.get("dutch_gold_checked_at"))
    other_at = _timestamp(other.get("dutch_gold_checked_at"))
    if other_at is None or (target_at is not None and target_at >= other_at):
        return
    if not isinstance(other.get("dutch_gold_watch"), list):
        return
    for key in ("dutch_gold_watch", "meta_watch_exclusions", "dutch_gold_rule", "dutch_gold_checked_at"):
        if key in other:
            target[key] = other[key]


def preserve_published_data(repository_root: Path, *, fetcher: Callable[[str], bytes] = fetch_published_json, read_status: dict[str, bool] | None = None) -> list[str]:
    """Carry newer, valid public Pages data into the next UI artifact unchanged.

    The deployed artifact is newer than git after a successful news run. Only the
    two existing public JSON URLs are read; failures never change local content.
    Restoring these bytes does not count as a new source check.
    """
    restored = []
    data_root = _site_root(repository_root) / "data"
    for filename in ("marketwatch.json", "releases.json"):
        if read_status is not None:
            read_status[filename] = False
        try:
            payload = json.loads(fetcher(f"{PUBLISHED_SITE_URL}data/{filename}"))
            if not isinstance(payload, dict):
                raise ValueError("Published snapshot must be a JSON object")
            published_at = _timestamp(payload.get("updated_at"))
            if published_at is None:
                raise ValueError("Published snapshot has no valid update timestamp")
            required_lists = ("article", "signals", "sources") if filename == "marketwatch.json" else ("releases", "dutch_gold_watch")
            if not isinstance(payload.get("title"), str) or not all(isinstance(payload.get(key), list) for key in required_lists):
                raise ValueError("Published snapshot is missing expected content")
            local = _read_json(data_root / filename)
            original_local = json.dumps(local, sort_keys=True)
            local_at = _timestamp(local.get("updated_at"))
            target = payload if local_at is None or published_at >= local_at else local
            if filename == "marketwatch.json":
                _merge_delivery_history(target, local if target is payload else payload)
            else:
                _merge_dutch_watch(target, local if target is payload else payload)
            if json.dumps(target, sort_keys=True) != original_local:
                _write_json_atomically(data_root / filename, target)
                restored.append(filename)
            if read_status is not None:
                read_status[filename] = True
        except (OSError, URLError, ValueError) as exc:
            print(f"Could not preserve public {filename}: {type(exc).__name__}; retaining the repository copy.")
    return restored


def _marketwatch_payload(now: datetime, kind: str, source_url: str, entries: list[FeedEntry], *, unchanged: bool = False) -> dict[str, object]:
    timestamp = _utc_timestamp(now)
    if entries:
        lead = entries[0]
        signals = [
            f"Officiële EA-bron in beeld: {lead.title}",
            "Prijs- en historische data: geen toegestane live feed gekoppeld.",
            "Kaarten en SBC’s gaan pas live met bevestigde, gestructureerde details.",
        ]
        article = [
            "De officiële EA Press RSS bevat de onderstaande FC/UT-aankondiging. Het controletijdstip zegt wanneer wij de feed lazen, niet wanneer EA dit nieuws publiceerde.",
            (lead.summary or "EA heeft nog geen bruikbare korte samenvatting in de RSS meegegeven.")[:520],
        ]
        sources = [{"label": f"EA Press RSS · {entry.title}", "url": entry.url, "published_at": entry.published_at} for entry in entries]
        title = f"EA in beeld: {lead.title}"
        summary = "De bron is officieel; de marktconclusie blijft bewust voorzichtig totdat prijs- of kaartdetails verifieerbaar zijn."
        status = "OFFICIËLE RSS"
        mode = "official_rss"
        if lead.published_at:
            article[0] += f" Publicatiedatum volgens EA: {lead.published_at}."
        else:
            article[0] += " EA gaf hiervoor geen verifieerbare publicatiedatum mee."
        if unchanged:
            title = "Bron opnieuw gecheckt, geen nieuwe FC-update"
            summary = "De FC/UT-inhoud in de RSS is ongewijzigd sinds onze vorige controle. Het onderstaande is eerder aangetroffen nieuws."
            article[0] = "De broninhoud is ongewijzigd. " + article[0]
            status = "GEEN NIEUWE UPDATE"
            mode = "official_rss_unchanged"
    else:
        signals = [
            "Geen FC/UT-titel gevonden in de huidige officiële EA Press RSS.",
            "Prijs- en historische data: geen toegestane live feed gekoppeld.",
            "Geen kaart-, SBC- of pack-call zonder een passende officiële bron.",
        ]
        article = [
            "De redactie heeft de officiële EA Press RSS gecontroleerd. In deze feed stonden geen FC/UT-aankondigingen die we als bron voor een trade- of kaartverhaal kunnen gebruiken.",
            "Rustig aan dus: een lege bronlijst is geen reden om de clubkas op avontuur te sturen.",
        ]
        sources = [{"label": "EA Press Release RSS", "url": source_url}]
        title = "Geen FC-nieuws, geen coin-theater"
        summary = "De geplande broncheck is gedaan. Zonder bevestigde FC/UT-update houden we de marketwatch saai, controleerbaar en prijsloos."
        status = "BRON GECHECKT"
        mode = "official_rss_no_fc_update"

    window = {
        "morning": "DAGELIJKSE MARKETWATCH",
        "totw": "WOENSDAG 19:01 · TOTW-CHECK",
        "promo": "VRIJDAG 19:01 · PROMO-CHECK",
        "weekend_sbc": "ZONDAG 19:01 · WEEKEND & SBC-CHECK",
        "manual": "HANDMATIGE BRONCHECK",
    }.get(kind, "DAGELIJKSE MARKETWATCH")
    return {
        "mode": mode,
        "updated_at": timestamp,
        "checked_at": timestamp,
        "source_published_at": entries[0].published_at if entries else None,
        "window": window,
        "status_label": status,
        "title": title,
        "summary": summary,
        "article": article,
        "signals": signals + ["X niet gecontroleerd: geen toegestane API."],
        "sources": sources,
        "automation": {"run_kind": kind, "source": "EA Press Release RSS", "source_url": source_url},
    }


def _update_release_check(path: Path, now: datetime, kind: str, entries: list[FeedEntry]) -> None:
    payload = _read_json(path)
    payload["updated_at"] = _utc_timestamp(now)
    payload["last_official_check"] = {
        "at": _utc_timestamp(now),
        "kind": kind,
        "source": "EA Press Release RSS",
        "matching_entries": len(entries),
    }
    if kind in {"totw", "promo"} and not entries:
        payload["notice"] = "De geplande officiële RSS-check leverde geen gestructureerde FC-kaartbevestiging op. Geen post = geen kaartfantasie."
    if kind == "weekend_sbc":
        sbc = payload.get("sbc_of_week")
        if isinstance(sbc, dict) and sbc.get("status") != "confirmed":
            sbc["window"] = "ZONDAGAVOND · BRON GECHECKT"
            sbc["summary"] = "De zondagcheck is gedaan. De officiële RSS leverde geen bevestigde SBC-requirements, reward en eindtijd op; dus geen geforceerde ‘must do’."
            sbc["risk"] = "Zonder officiële requirements, reward en eindtijd blijft ‘must do’ vooral groepschatpoëzie."
    _write_json_atomically(path, payload)


def refresh(
    repository_root: Path,
    *,
    now: datetime,
    rss_url: str = EA_PRESS_RSS,
    scheduled: bool = False,
    scheduled_cron: str | None = None,
    prepare_discord: bool = False,
    fetcher: Callable[[str], bytes] = fetch_rss,
) -> RefreshResult:
    kind = scheduled_kind(now, scheduled_cron) if scheduled else "manual"
    if kind is None:
        return RefreshResult(due=False, kind=None, marketwatch=None)
    site_root = _site_root(repository_root)
    data_root = site_root / "data"
    if not (data_root / "marketwatch.json").is_file() or not (data_root / "releases.json").is_file():
        raise FileNotFoundError("Expected public data/marketwatch.json and data/releases.json")
    previous = _read_json(data_root / "marketwatch.json")
    automation = previous.get("automation", {})
    if not isinstance(automation, dict):
        automation = {}
    slot = scheduled_slot(now, scheduled_cron) if scheduled else None
    if slot is not None:
        previous_slot = _timestamp(automation.get("scheduled_for"))
        previous_check = _timestamp(previous.get("updated_at"))
        if any(value is not None and value >= slot for value in (previous_slot, previous_check)):
            return RefreshResult(due=False, kind=kind, marketwatch=None)
    entries = relevant_entries(parse_rss(fetcher(rss_url), rss_url))
    fingerprint = content_fingerprint(entries)
    marketwatch = _marketwatch_payload(now, kind, rss_url, entries, unchanged=automation.get("content_fingerprint") == fingerprint)
    marketwatch["automation"]["content_fingerprint"] = fingerprint
    # Delivery reservations travel in public JSON, independently of source/check
    # timestamps. They contain no webhook or other credential. A reservation is
    # deployed BEFORE sending; an interrupted run is never blindly retried.
    seen = automation.get("discord_reserved_fingerprints", [])
    seen = [value for value in seen if isinstance(value, str)] if isinstance(seen, list) else []
    if isinstance(automation.get("discord_delivery"), dict):
        marketwatch["automation"]["discord_delivery"] = automation["discord_delivery"]
    delivery_id = None
    if prepare_discord and entries and fingerprint not in seen:
        delivery_id = str(uuid4())
        marketwatch["automation"]["discord_delivery"] = {
            "id": delivery_id,
            "content_fingerprint": fingerprint,
            "prepared_at": _utc_timestamp(now),
            "status": "unknown",
            "note": "Verzendintentie gereserveerd; ontvangst door Discord is nog niet bevestigd. Niet automatisch opnieuw verzenden.",
        }
        seen = (seen + [fingerprint])[-64:]
    marketwatch["automation"]["discord_reserved_fingerprints"] = seen
    if slot is not None:
        marketwatch["automation"]["scheduled_for"] = _utc_timestamp(slot)
    _write_json_atomically(data_root / "marketwatch.json", marketwatch)
    if kind != "morning":
        _update_release_check(data_root / "releases.json", now, kind, entries)
    return RefreshResult(due=True, kind=kind, marketwatch=marketwatch, delivery_id=delivery_id)


def discord_article(marketwatch: dict[str, object]) -> str:
    def clipped(value: object, limit: int) -> str:
        text = str(value).strip()
        return text if len(text) <= limit else f"{text[:limit - 1].rstrip()}…"

    lines = [
        f"📰 **FBS Marketwatch — {marketwatch.get('window', 'BRONCHECK')}**",
        f"**{clipped(marketwatch.get('title', 'Marketwatch'), 220)}**",
        clipped(marketwatch.get("summary", ""), 480),
    ]
    for paragraph in list(marketwatch.get("article", []))[:2]:
        lines.append(clipped(paragraph, 450))
    sources = []
    for source in list(marketwatch.get("sources", []))[:2]:
        if isinstance(source, dict) and source.get("url"):
            candidate = f"Bron: {clipped(source.get('label', 'EA Press RSS'), 100)} — {source['url']}"
            if len(candidate) <= 700:
                sources.append(candidate)
    if not sources:
        sources.append(f"Bron: EA Press RSS — {EA_PRESS_RSS}")
    footer = "\n\n".join(sources + ["Geen garantie op winst; geen bron = geen coin-theater."])
    return clipped("\n\n".join(lines), 2000 - len(footer) - 2) + "\n\n" + footer


def post_discord(webhook_url: str, article: str) -> str:
    parsed = urlsplit(webhook_url)
    if parsed.scheme != "https" or parsed.hostname not in {"discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"} or not parsed.path.startswith("/api/webhooks/"):
        raise ValueError("DISCORD_WEBHOOK_URL must be an HTTPS Discord incoming-webhook URL")
    body = json.dumps({"content": article, "allowed_mentions": {"parse": []}}).encode("utf-8")
    query = [(key, value) for key, value in parse_qsl(parsed.query) if key != "wait"] + [("wait", "true")]
    confirmed_url = urlunsplit(parsed._replace(query=urlencode(query)))
    request = Request(confirmed_url, data=body, headers={"Content-Type": "application/json", "User-Agent": "FBS-UT-Trade-Watcher/1.0"}, method="POST")
    with urlopen(request, timeout=20) as response:  # nosec B310 - explicit user-configured Discord webhook
        receipt = json.loads(response.read(1_000_000))
    message_id = receipt.get("id") if isinstance(receipt, dict) else None
    if not isinstance(message_id, str) or not message_id.isdigit():
        raise ValueError("Discord returned no confirmed message receipt")
    return message_id


def deliver_discord(repository_root: Path, *, delivery_id: str, webhook_url: str | None, now: datetime, sender: Callable[[str, str], str] = post_discord) -> str:
    """Consume the current run's already-deployed reservation exactly once locally.

    Call only AFTER successful Pages deployment, using the delivery ID emitted by
    that run's refresh. Future runs restore the reservation and do not queue the
    same source fingerprint again. A crash can leave delivery unknown, which is
    intentionally preferable to sending duplicates without an operator check.
    """
    path = _site_root(repository_root) / "data" / "marketwatch.json"
    payload = _read_json(path)
    automation = payload.get("automation", {})
    delivery = automation.get("discord_delivery", {}) if isinstance(automation, dict) else {}
    if not delivery_id or not isinstance(delivery, dict) or delivery.get("id") != delivery_id or delivery.get("content_fingerprint") != automation.get("content_fingerprint"):
        raise ValueError("Discord delivery ID does not match this run's source-backed reservation")
    if delivery.get("attempted_at") or delivery.get("status") != "unknown":
        return "skipped"
    if not webhook_url:
        return "not_configured"
    delivery["attempted_at"] = _utc_timestamp(now)
    # Mark before the request, so a repeated local invocation cannot resend an
    # unknown outcome. Only a valid returned message ID can mark it confirmed.
    _write_json_atomically(path, payload)
    try:
        message_id = sender(webhook_url, discord_article(payload))
        if not isinstance(message_id, str) or not message_id.isdigit():
            raise ValueError("Discord returned no confirmed message receipt")
        delivery.update(status="confirmed", message_id=message_id, confirmed_at=_utc_timestamp(now))
        delivery["note"] = "Discord heeft ontvangst bevestigd met een bericht-ID."
    except (OSError, URLError, ValueError) as exc:
        # HTTP 4xx means rejection; network/5xx/invalid receipts can be ambiguous.
        delivery["status"] = "failed" if isinstance(exc, HTTPError) and 400 <= exc.code < 500 else "unknown"
        delivery["note"] = "Geen bevestigde ontvangst. Controleer het Discord-kanaal vóór een handmatige herpoging."
        delivery["error_type"] = f"HTTP {exc.code}" if isinstance(exc, HTTPError) else type(exc).__name__
    _write_json_atomically(path, payload)
    return str(delivery["status"])


def _arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh FBS public Marketwatch from EA Press RSS.")
    parser.add_argument("--site-root", type=Path, default=Path.cwd(), help="Static site root or repository root containing site/.")
    parser.add_argument("--rss-url", default=EA_PRESS_RSS)
    parser.add_argument("--scheduled", action="store_true", help="Run only in a due Europe/Amsterdam schedule window.")
    parser.add_argument("--scheduled-cron", help="Exact GitHub event schedule; resolves the intended slot even if the runner starts late.")
    parser.add_argument("--preserve-published", action="store_true", help="Restore newer public Pages briefing/release JSON before building an artifact.")
    parser.add_argument("--allow-source-failure", action="store_true", help="Let UI deployment continue with existing data when the RSS check fails.")
    parser.add_argument("--prepare-discord", "--post-discord", dest="prepare_discord", action="store_true", help="Reserve one source-backed Discord article for post-deployment delivery when the webhook is configured; this never sends by itself.")
    delivery_mode = parser.add_mutually_exclusive_group()
    delivery_mode.add_argument("--deliver-discord", metavar="DELIVERY_ID", help="Deliver this run's reserved article only after successful Pages deployment.")
    delivery_mode.add_argument("--test-discord", action="store_true", help="Send one explicitly labelled connection test after user authorization; no RSS or site data is changed.")
    parser.add_argument("--now", help="ISO timestamp for deterministic local testing.")
    return parser.parse_args(argv)


def _parse_now(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def main(argv: list[str] | None = None) -> int:
    args = _arguments(argv)
    published_status: dict[str, bool] = {}
    source_failed = False

    def checked_fetch(url: str) -> bytes:
        nonlocal source_failed
        try:
            raw = fetch_rss(url)
            # Distinguish a failed external source from a local/configuration
            # error. Only the former may permit a scheduled daily-only deploy.
            parse_rss(raw, url)
            return raw
        except (OSError, URLError, ValueError):
            source_failed = True
            raise

    def output(*, deploy: bool, refreshed: bool, delivery_id: str | None = None) -> None:
        if path := os.getenv("GITHUB_OUTPUT"):
            with Path(path).open("a", encoding="utf-8") as handle:
                handle.write(f"deploy={'true' if deploy else 'false'}\nrefreshed={'true' if refreshed else 'false'}\n")
                if delivery_id:
                    handle.write(f"discord_delivery_id={delivery_id}\n")

    try:
        if args.test_discord:
            webhook = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
            if not webhook:
                raise ValueError("DISCORD_WEBHOOK_URL is not configured")
            message_id = post_discord(webhook, "🧪 **FBS verbindingstest — geen tradeadvies**\n\nDe redactieverbinding met Discord is aangesloten.\n\nWebsite: " + PUBLISHED_SITE_URL + "\n\nDit is een eenmalige verbindingstest, geen Marketwatch of koop-/verkooptip.")
            print(f"Discord connection test confirmed; message ID: {message_id}.")
            return 0
        if args.deliver_discord:
            outcome = deliver_discord(args.site_root, delivery_id=args.deliver_discord, webhook_url=os.getenv("DISCORD_WEBHOOK_URL", "").strip() or None, now=_parse_now(args.now))
            print(f"Discord delivery outcome: {outcome}. No automatic resend for an unknown outcome.")
            return 0 if outcome in {"confirmed", "skipped", "not_configured"} else 1
        if args.preserve_published:
            restored = preserve_published_data(args.site_root, read_status=published_status)
            if restored:
                print(f"Preserved newer published data: {', '.join(restored)} (original timestamps retained).")
            if not published_status.get("marketwatch.json"):
                output(deploy=False, refreshed=False)
                print("Public marketwatch/delivery state unavailable; deployment stopped to preserve the last briefing and avoid duplicate posts.")
                return 1
        prepare = args.prepare_discord and bool(os.getenv("DISCORD_WEBHOOK_URL", "").strip())
        if prepare and not published_status.get("marketwatch.json"):
            print("Discord not reserved: the last public delivery state could not be verified. No automatic retry or speculative send.")
            prepare = False
        result = refresh(args.site_root, now=_parse_now(args.now), rss_url=args.rss_url, scheduled=args.scheduled, scheduled_cron=args.scheduled_cron, prepare_discord=prepare, fetcher=checked_fetch)
        if not result.due:
            output(deploy=False, refreshed=False)
            print("FBS schedule is not due or its intended slot was already published; no deployment or Discord post.")
            return 0
        output(deploy=True, refreshed=True, delivery_id=result.delivery_id)
        print(f"Refreshed {result.kind} Marketwatch from EA Press RSS.")
        return 0
    except (OSError, URLError, ValueError) as exc:
        reason = f"HTTP {exc.code}" if isinstance(exc, HTTPError) else type(exc).__name__
        if args.test_discord or args.deliver_discord:
            print(f"Discord operation failed ({reason}); no confirmed receipt.")
            return 1
        # A scheduled source failure can still publish the independently dated
        # daily audit. The workflow runs daily_watch.py AFTER this step and
        # BEFORE building Pages. Never advance old news dates or queue Discord.
        # Source fetching only occurs for a due, not-already-published slot.
        daily_only = args.scheduled and source_failed and published_status.get("marketwatch.json", False)
        deploy = args.allow_source_failure and (not args.scheduled or daily_only)
        output(deploy=deploy, refreshed=False)
        print(f"Official RSS refresh failed ({reason}); existing content and source-check timestamps are retained.")
        if daily_only and deploy:
            print("Public briefing/delivery state was safely preserved. The daily data audit may be published; no new news or Discord delivery is claimed.")
        return 0 if deploy else 1


if __name__ == "__main__":
    raise SystemExit(main())
