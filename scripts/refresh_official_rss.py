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
from html import unescape
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree
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


@dataclass(frozen=True)
class RefreshResult:
    due: bool
    kind: str | None
    marketwatch: dict[str, object] | None


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
            entries.append(FeedEntry(title=title, summary=summary, url=link))
    return entries


def relevant_entries(entries: list[FeedEntry]) -> list[FeedEntry]:
    return [entry for entry in entries if FC_PATTERN.search(f"{entry.title} {entry.summary}")][:3]


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


def preserve_published_data(repository_root: Path, *, fetcher: Callable[[str], bytes] = fetch_published_json) -> list[str]:
    """Carry newer, valid public Pages data into the next UI artifact unchanged.

    The deployed artifact is newer than git after a successful news run. Only the
    two existing public JSON URLs are read; failures never change local content.
    Restoring these bytes does not count as a new source check.
    """
    restored = []
    data_root = _site_root(repository_root) / "data"
    for filename in ("marketwatch.json", "releases.json"):
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
            local_at = _timestamp(local.get("updated_at"))
            if local_at is None or published_at > local_at:
                _write_json_atomically(data_root / filename, payload)
                restored.append(filename)
        except (OSError, URLError, ValueError) as exc:
            print(f"Could not preserve public {filename}: {type(exc).__name__}; retaining the repository copy.")
    return restored


def _marketwatch_payload(now: datetime, kind: str, source_url: str, entries: list[FeedEntry]) -> dict[str, object]:
    timestamp = _utc_timestamp(now)
    if entries:
        lead = entries[0]
        signals = [
            f"Officiële EA-update gesignaleerd: {lead.title}",
            "Prijs- en historische data: geen toegestane live feed gekoppeld.",
            "Kaarten en SBC’s gaan pas live met bevestigde, gestructureerde details.",
        ]
        article = [
            "De officiële EA Press RSS gaf een FC/UT-signaal. Dat is nieuws, geen koopcall: zonder toegestane prijsfeed krijgt niemand een verzonnen instap of verkoopprijs.",
            (lead.summary or "EA heeft nog geen bruikbare korte samenvatting in de RSS meegegeven.")[:520],
        ]
        sources = [{"label": f"EA Press RSS · {entry.title}", "url": entry.url} for entry in entries]
        title = f"EA-fluitje: {lead.title}"
        summary = "De bron is officieel; de marktconclusie blijft bewust voorzichtig totdat prijs- of kaartdetails verifieerbaar zijn."
        status = "OFFICIËLE RSS"
        mode = "official_rss"
    else:
        signals = [
            "Geen verse FC/UT-titel gevonden in de officiële EA Press RSS.",
            "Prijs- en historische data: geen toegestane live feed gekoppeld.",
            "Geen kaart-, SBC- of pack-call zonder een passende officiële bron.",
        ]
        article = [
            "De redactie heeft de officiële EA Press RSS gecontroleerd. Daar stond geen nieuwe FC/UT-aankondiging tussen die we als bron voor een trade- of kaartverhaal kunnen gebruiken.",
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
        "window": window,
        "status_label": status,
        "title": title,
        "summary": summary,
        "article": article,
        "signals": signals,
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
    fetcher: Callable[[str], bytes] = fetch_rss,
) -> RefreshResult:
    kind = scheduled_kind(now, scheduled_cron) if scheduled else "manual"
    if kind is None:
        return RefreshResult(due=False, kind=None, marketwatch=None)
    site_root = _site_root(repository_root)
    data_root = site_root / "data"
    if not (data_root / "marketwatch.json").is_file() or not (data_root / "releases.json").is_file():
        raise FileNotFoundError("Expected public data/marketwatch.json and data/releases.json")
    slot = scheduled_slot(now, scheduled_cron) if scheduled else None
    if slot is not None:
        previous = _read_json(data_root / "marketwatch.json")
        automation = previous.get("automation", {})
        previous_slot = _timestamp(automation.get("scheduled_for")) if isinstance(automation, dict) else None
        previous_check = _timestamp(previous.get("updated_at"))
        if any(value is not None and value >= slot for value in (previous_slot, previous_check)):
            return RefreshResult(due=False, kind=kind, marketwatch=None)
    entries = relevant_entries(parse_rss(fetcher(rss_url), rss_url))
    marketwatch = _marketwatch_payload(now, kind, rss_url, entries)
    if slot is not None:
        marketwatch["automation"]["scheduled_for"] = _utc_timestamp(slot)
    _write_json_atomically(data_root / "marketwatch.json", marketwatch)
    if kind != "morning":
        _update_release_check(data_root / "releases.json", now, kind, entries)
    return RefreshResult(due=True, kind=kind, marketwatch=marketwatch)


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
    for source in list(marketwatch.get("sources", []))[:2]:
        if isinstance(source, dict) and source.get("url"):
            lines.append(f"Bron: {source.get('label', 'EA Press RSS')} — {source['url']}")
    lines.append("Geen garantie op winst; geen bron = geen coin-theater.")
    return "\n\n".join(lines)[:2000]


def post_discord(webhook_url: str, article: str) -> None:
    parsed = urlsplit(webhook_url)
    if parsed.scheme != "https" or parsed.hostname not in {"discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"} or not parsed.path.startswith("/api/webhooks/"):
        raise ValueError("DISCORD_WEBHOOK_URL must be an HTTPS Discord incoming-webhook URL")
    body = json.dumps({"content": article, "allowed_mentions": {"parse": []}}).encode("utf-8")
    request = Request(webhook_url, data=body, headers={"Content-Type": "application/json", "User-Agent": "FBS-UT-Trade-Watcher/1.0"}, method="POST")
    with urlopen(request, timeout=20):  # nosec B310 - explicit user-configured Discord webhook
        pass


def _arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh FBS public Marketwatch from EA Press RSS.")
    parser.add_argument("--site-root", type=Path, default=Path.cwd(), help="Static site root or repository root containing site/.")
    parser.add_argument("--rss-url", default=EA_PRESS_RSS)
    parser.add_argument("--scheduled", action="store_true", help="Run only in a due Europe/Amsterdam schedule window.")
    parser.add_argument("--scheduled-cron", help="Exact GitHub event schedule; resolves the intended slot even if the runner starts late.")
    parser.add_argument("--preserve-published", action="store_true", help="Restore newer public Pages briefing/release JSON before building an artifact.")
    parser.add_argument("--allow-source-failure", action="store_true", help="Let UI deployment continue with existing data when the RSS check fails.")
    parser.add_argument("--post-discord", action="store_true", help="Post the source-backed article to DISCORD_WEBHOOK_URL after a due refresh.")
    parser.add_argument("--now", help="ISO timestamp for deterministic local testing.")
    return parser.parse_args(argv)


def _parse_now(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def main(argv: list[str] | None = None) -> int:
    args = _arguments(argv)
    def output(*, deploy: bool, refreshed: bool) -> None:
        if path := os.getenv("GITHUB_OUTPUT"):
            with Path(path).open("a", encoding="utf-8") as handle:
                handle.write(f"deploy={'true' if deploy else 'false'}\nrefreshed={'true' if refreshed else 'false'}\n")

    try:
        if args.preserve_published:
            restored = preserve_published_data(args.site_root)
            if restored:
                print(f"Preserved newer published data: {', '.join(restored)} (original timestamps retained).")
        result = refresh(args.site_root, now=_parse_now(args.now), rss_url=args.rss_url, scheduled=args.scheduled, scheduled_cron=args.scheduled_cron)
        if not result.due:
            output(deploy=False, refreshed=False)
            print("FBS schedule is not due or its intended slot was already published; no deployment or Discord post.")
            return 0
        output(deploy=True, refreshed=True)
        if args.post_discord and (webhook := os.getenv("DISCORD_WEBHOOK_URL")):
            assert result.marketwatch is not None
            try:
                post_discord(webhook, discord_article(result.marketwatch))
            except (OSError, URLError, ValueError) as exc:
                print(f"Discord post failed ({type(exc).__name__}); the verified website update can still deploy.")
        print(f"Refreshed {result.kind} Marketwatch from EA Press RSS.")
        return 0
    except (OSError, URLError, ValueError) as exc:
        output(deploy=args.allow_source_failure and not args.scheduled, refreshed=False)
        reason = f"HTTP {exc.code}" if isinstance(exc, HTTPError) else type(exc).__name__
        print(f"Official RSS refresh failed ({reason}); existing content and source-check timestamps are retained.")
        return 0 if args.allow_source_failure and not args.scheduled else 1


if __name__ == "__main__":
    raise SystemExit(main())
