#!/usr/bin/env python3
"""Publish an honest daily audit of already available public FBS data.

No network requests, synthetic prices, uploads, or Discord posts. A future live
adapter must provide mode=live, market_data_licensed=true, game=FC27,
platform=ps, currency=coins and explicitly sourced item observations. Merely
changing a demo flag cannot supply the identity, provenance, dated history and
observed liquidity required below. generated_at is never a price-check date.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_FLOOR
import json
from pathlib import Path
import tempfile
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


AMSTERDAM = ZoneInfo("Europe/Amsterdam")
TAX_RATE = Decimal("0.05")
TAX_SOURCE = "https://forums.ea.com/discussions/fc-25-technical-issues-en/missing-coins-from-sold-player/12124884"
LINES = ("goalkeeper", "defense", "midfield", "attack")
REASONS = {
    "demo": "De beschikbare marktdata staat op demo; voorbeeldcoins zijn geen actuele prijzen.",
    "not_live": "De beschikbare marktdata is niet expliciet als echte live observatie aangemerkt.",
    "unlicensed": "Er is geen expliciete toestemming voor geautomatiseerd gebruik van deze marktdata vastgelegd.",
    "wrong_market": "De data is niet expliciet FC27 / PlayStation / coins.",
    "missing_items": "Er zijn geen marktkaarten met controleerbare prijsdata beschikbaar.",
    "identity": "Kaartidentiteit, editie of bron ontbreekt; een naam alleen is geen verhandelbaar item.",
    "price": "Een recente, gedateerde actuele prijs ontbreekt (maximaal zes uur oud).",
    "history": "De gedateerde historie is onvoldoende: minimaal vier observaties over minstens 24 uur, binnen zeven dagen.",
    "liquidity": "Recent waargenomen handelsvolume ontbreekt of is te laag (minimaal 50 in 24 uur).",
    "margin": "Na de belastingaanname blijft geen voldoende marge over: minimaal 300 coins, 5% en dekking van het historische neerwaartse scenario.",
    "invalid_data": "Een invoerbestand ontbreekt, is onleesbaar of bevat geen geldig JSON-object.",
}


def timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except ValueError:
        return None


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def fresh(value: object, now: datetime, hours: int) -> bool:
    parsed = timestamp(value)
    return parsed is not None and timedelta(0) <= now - parsed <= timedelta(hours=hours)


def coins(value: object) -> int | None:
    # bool and NaN must not become prices; all values are integer in-game coins.
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def public_source(value: object, *, official: bool = False) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("url"), str):
        return False
    try:
        parsed = urlsplit(value["url"])
        return bool(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and (not official or parsed.hostname == "ea.com" or parsed.hostname.endswith(".ea.com")))
    except ValueError:
        return False


def _read(path: Path) -> dict:
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".daily-watch-", suffix=".json", delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def _net(sale: int) -> int:
    return int((Decimal(sale) * (1 - TAX_RATE)).to_integral_value(rounding=ROUND_FLOOR))


def evaluate_item(item: object, now: datetime) -> tuple[dict | None, str | None]:
    if not isinstance(item, dict):
        return None, "identity"
    identity = [item.get(key) for key in ("id", "name", "version")]
    if any(not isinstance(value, str) or not value.strip() for value in identity) or any("demo" in value.lower() for value in identity) or item.get("demo") is True or not public_source(item.get("source")):
        return None, "identity"
    # Explicit row metadata cannot contradict the verified dataset envelope.
    if any(key in item and item[key] != expected for key, expected in (("game", "FC27"), ("platform", "ps"), ("currency", "coins"))):
        return None, "wrong_market"
    price = coins(item.get("price"))
    if not price or not fresh(item.get("price_checked_at"), now, 6):
        return None, "price"
    if not fresh(item.get("history_checked_at"), now, 24):
        return None, "history"
    history = item.get("history")
    if not isinstance(history, list):
        return None, "history"
    observed: dict[datetime, int] = {}
    checked = timestamp(item["history_checked_at"])
    for point in history:
        if not isinstance(point, dict):
            return None, "history"
        at, value = timestamp(point.get("captured_at")), coins(point.get("price"))
        if not at or not value or at > now or at > checked:
            return None, "history"
        if at >= now - timedelta(days=7):
            if at in observed and observed[at] != value:
                return None, "history"
            observed[at] = value
    if len(observed) < 4 or max(observed) - min(observed) < timedelta(hours=24) or now - max(observed) > timedelta(hours=6) or observed[max(observed)] != price:
        return None, "history"
    volume = coins(item.get("volume_24h"))
    if not volume or volume < 50 or not fresh(item.get("volume_checked_at"), now, 6):
        return None, "liquidity"

    # Lower median is an actual observed historical price, not a model uplift.
    ordered_prices = sorted(observed.values())
    target = ordered_prices[(len(ordered_prices) - 1) // 2]
    profit = _net(target) - price
    roi = Decimal(profit) * 100 / Decimal(price)
    floor = min(ordered_prices)
    downside = max(0, price - _net(floor))
    if profit < 300 or roi < 5 or profit < downside:
        return None, "margin"
    source = item["source"]
    return {
        "id": item["id"], "name": item["name"], "version": item["version"],
        "buy_price": price, "sell_target": target, "net_proceeds": _net(target),
        "net_profit": profit, "roi_pct": round(float(roi), 2),
        "historical_floor": floor, "downside_coins": downside,
        "confidence": "medium", "confidence_label": "Voldoende gedateerde data; geen winstkanspercentage",
        "price_checked_at": item["price_checked_at"], "history_checked_at": item["history_checked_at"],
        "volume_checked_at": item["volume_checked_at"], "volume_24h": volume,
        "history_points": len(observed), "history_from": iso(min(observed)), "history_to": iso(max(observed)),
        "source": {key: source[key] for key in ("label", "url", "checked_at") if key in source},
        "why": [
            f"De geobserveerde prijs is {price:,} coins; de lagere historische mediaan is {target:,} coins.",
            f"Bij verkoop op dat historische niveau resteert {profit:,} coins ({float(roi):.1f}%) na de 5%-belastingaanname.",
            f"{len(observed)} prijsobservaties en {volume} waargenomen trades in 24 uur voldoen aan de datadrempels.",
        ],
        "risks": [
            "Het verkoopdoel is een eerder waargenomen referentie, geen voorspelling of gegarandeerde uitvoerbare verkoop.",
            f"Bij terugkeer naar het waargenomen laagste niveau is het verlies na belasting {downside:,} coins; de echte daling kan groter zijn.",
            "Nieuwe packs, SBC's en nieuws kunnen de markt wijzigen; die oorzaken zijn niet automatisch bevestigd.",
            "De 5% verkoopbelasting is een methode-aanname, nog niet opnieuw bevestigd voor FC27.",
        ],
    }, None


def coverage_audit(releases: dict, meta: dict, now: datetime) -> dict:
    men = releases.get("dutch_gold_watch", [])
    women = meta.get("players", [])
    men = men if isinstance(men, list) else []
    women = women if isinstance(women, list) else []
    counts = {line: 0 for line in LINES}
    issues: list[str] = []
    dates: list[datetime] = []
    included: set[str] = set()

    def complete_profile(card: dict) -> bool:
        expected = {"DUI", "BEH", "TRP", "REF", "SNL", "POS"} if card.get("line") == "goalkeeper" else {"SNL", "SCH", "PAS", "DRI", "VRD", "FYS"}
        stats, weights = card.get("stats"), card.get("meta_weights")
        if not isinstance(stats, list) or len(stats) != 6 or not isinstance(weights, dict) or set(weights) != expected:
            return False
        if any(not isinstance(stat, dict) or not isinstance(stat.get("label"), str) or not isinstance(stat.get("value"), int) or isinstance(stat.get("value"), bool) or not 0 <= stat["value"] <= 99 for stat in stats):
            return False
        if {stat["label"] for stat in stats} != expected:
            return False
        return all(isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 100 for value in weights.values()) and sum(weights.values()) == 100

    def valid(card: object, gender: str) -> bool:
        if not isinstance(card, dict):
            return False
        source = card.get("source")
        verified = timestamp(source.get("verified_at")) if isinstance(source, dict) else None
        confirmed = timestamp(card.get("confirmed_at"))
        rating = coins(card.get("base_rating", card.get("rating")))
        is_gold_or_promo = card.get("base_item_tier") == "gold" or str(card.get("card_type", "")).lower() in {"gold", "gold rare", "gold common", "promo", "totw"}
        if card.get("gender") != gender or card.get("nation_code") != "NL" or card.get("confirmed") is not True or not rating or not 75 <= rating <= 99 or not public_source(source, official=True) or not verified or verified > now or not confirmed or confirmed > now or (gender == "male" and not is_gold_or_promo) or not complete_profile(card):
            return False
        name = str(card.get("name", "")).strip().casefold()
        if not name or name in included:
            issues.append("Een kaartnaam ontbreekt of staat dubbel tussen de watchlijsten.")
            return False
        included.add(name)
        dates.append(verified)
        return True

    for card in men:
        if valid(card, "male") and card.get("line") in counts:
            counts[card["line"]] += 1
    women_count = sum(valid(card, "female") for card in women)
    for line, count in counts.items():
        if count != 2:
            issues.append(f"{line}: {count}/2 bevestigde Nederlandse mannen met Gold/Promo-profiel.")
    if women_count != 2:
        issues.append(f"Meta-meter: {women_count}/2 bevestigde Nederlandse vrouwen van minimaal 75 ALG.")
    if len(men) != 8 or len(women) != 2:
        issues.append("De geselecteerde lijsten bevatten nog niet exact acht mannen en twee vrouwen.")
    return {
        "roster_checked_at": iso(now),
        "source_verified_at": iso(max(dates)) if dates else None,
        "source_oldest_verified_at": iso(min(dates)) if dates else None,
        "men_by_line": counts, "women_count": women_count, "complete": not issues,
        "issues": list(dict.fromkeys(issues)),
        "note": "Dit is een dagelijkse bestandscontrole van de dekking, zes kaartstats en complete rolgewichten, geen nieuwe bronbevestiging van ratings, stats of kaartreleases.",
    }


def build_report(current: dict, releases: dict, meta: dict, *, now: datetime, news: dict | None = None) -> dict:
    if now.tzinfo is None:
        raise ValueError("Report time must include a timezone")
    now = now.astimezone(timezone.utc)
    items = current.get("items", [])
    items = items if isinstance(items, list) else []
    rejections: Counter = Counter()
    gate = None
    if not current:
        gate = "invalid_data"
    elif current.get("mode") == "demo":
        gate = "demo"
    elif current.get("mode") != "live":
        gate = "not_live"
    elif current.get("market_data_licensed") is not True:
        gate = "unlicensed"
    elif current.get("game") != "FC27" or current.get("platform") != "ps" or current.get("currency") != "coins":
        gate = "wrong_market"
    candidates = []
    if gate:
        rejections[gate] += len(items) or 1
    elif not items:
        rejections["missing_items"] += 1
    else:
        ids = Counter(item.get("id") for item in items if isinstance(item, dict) and isinstance(item.get("id"), str))
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("id"), str) and ids.get(item["id"], 0) > 1:
                rejections["identity"] += 1
                continue
            candidate, reason = evaluate_item(item, now)
            if candidate:
                candidates.append(candidate)
            elif reason:
                rejections[reason] += 1
    candidates.sort(key=lambda item: (-item["roi_pct"], -item["net_profit"], item["id"]))
    trade = candidates[0] if candidates else None
    reasons = [REASONS[code] for code in rejections]
    title = f"Trade van de dag · {trade['name']}" if trade else "Vandaag geen onderbouwde trade"
    summary = "Een voorwaardelijke kans op basis van waargenomen prijzen; controleer de markt zelf vóór aankoop." if trade else "De redactie heeft de beschikbare data gecontroleerd. Zonder verse, toegestane PlayStation-prijzen en historie blijft de clubkas vandaag dicht."
    news = news if isinstance(news, dict) else {}
    coverage = coverage_audit(releases, meta, now)
    return {
        "schema_version": 1, "date": now.astimezone(AMSTERDAM).date().isoformat(),
        "checked_at": iso(now), "timezone": "Europe/Amsterdam", "platform": "ps", "currency": "coins",
        "status": "candidate" if trade else "no_trade", "title": title, "summary": summary,
        "article": [summary] + (trade["why"] if trade else reasons) + [coverage["note"]],
        "trade": trade, "risk": "Geen garantie op winst. Een dagelijkse bestandscontrole is geen live prijsfeed of bevestiging van nieuw nieuws.",
        "reasons": trade["why"] if trade else reasons,
        "data_quality": {
            "eligible_count": len(candidates), "rejected_count": len(items) - len(candidates),
            "input_count": len(items), "reasons": reasons, "rejection_counts": dict(rejections),
            "input_mode": current.get("mode"), "input_generated_at": current.get("generated_at"),
            "note": "input_generated_at is de oorspronkelijke exportdatum, niet een controle van de prijsbron.",
        },
        "coverage": coverage,
        "news_context": {"source_published_at": news.get("source_published_at"), "last_successful_check_at": news.get("checked_at"), "note": "Bestaande brondata ongewijzigd overgenomen; dit rapport haalt geen nieuw nieuws op."},
        "tax": {"rate": float(TAX_RATE), "status": "assumption_pending_fc27_confirmation", "source_url": TAX_SOURCE, "note": "5% als expliciete rekenaanname; oudere EA-community-uitleg voor FC25, geen nieuwe officiële FC27-bevestiging."},
        "assumptions": [
            "Verkoopbelasting voorlopig 5%; netto-opbrengst conservatief naar beneden afgerond.",
            "Maximaal zes uur oude prijs en volume; historiecontrole maximaal 24 uur oud.",
            "Minimaal vier historische punten in zeven dagen over minstens 24 uur en 50 waargenomen trades per 24 uur.",
            "Verkoopreferentie is de lagere mediaan van de waargenomen historie; geen voorspelde prijsstijging.",
            "Kandidaten hebben minimaal 300 coins en 5% scenario-ROI, en scenario-opbrengst ten minste gelijk aan historisch neerwaarts risico.",
            "Rangschikking op scenario-ROI, daarna nettomarge; vertrouwen is datakwaliteit, geen winstkans.",
        ],
    }


def generate_daily_watch(root: Path, *, now: datetime) -> dict:
    site = root / "site" if (root / "site").is_dir() else root
    data = site / "data"
    payload = build_report(_read(data / "current.json"), _read(data / "releases.json"), _read(data / "meta-watch.json"), now=now, news=_read(data / "marketwatch.json"))
    _write(data / "trade-of-day.json", payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-root", type=Path, default=Path.cwd())
    parser.add_argument("--now", help="Timezone-aware ISO timestamp for deterministic tests.")
    args = parser.parse_args(argv)
    now = timestamp(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        parser.error("--now must be a timezone-aware ISO timestamp")
    report = generate_daily_watch(args.site_root, now=now)
    print(f"Daily report {report['date']}: {report['status']}; {report['data_quality']['eligible_count']} eligible candidates. Source dates retained; no Discord post.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
