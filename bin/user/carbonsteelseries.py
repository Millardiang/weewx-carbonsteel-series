#
#    Copyright (c) 2026  Ian Millard and contributors
#
#    This program is free software; you can redistribute it and/or modify it
#    under the terms of the GNU General Public License as published by the Free
#    Software Foundation; either version 3 of the License, or (at your option)
#    any later version.
#
#    See the file LICENSE for your full rights.
#
"""weewx-carbonsteel-series: live gauges for WeeWX 5, in the style of the original
SteelSeries gauges.

This module provides two components:

CarbonSteelSeriesRealtime
    A WeeWX service that listens to LOOP packets and writes ``realtime.json``
    (atomically) every time a packet arrives. The file carries the current
    observations, today's highs and lows (seeded from the database, so they
    survive restarts), rain totals, 10-minute wind statistics, a wind rose and
    the 3-hour barometer trend, all converted to the units configured for the
    CarbonSteelSeries report.

CarbonSteelSeriesHistory
    A Cheetah search list extension used by the skin to emit ``history.json``
    (the last 24 hours of archive records) and ``calendar.json`` (a year of
    daily summaries used by the calendar heat-map).

Requires WeeWX 5.0 or later and Python 3.9 or later (tested on 3.13).
"""

from __future__ import annotations

import collections
import json
import logging
import math
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

import weewx
import weewx.engine
import weewx.units
import weewx.xtypes
import weeutil.weeutil
from weeutil.weeutil import TimeSpan, to_bool, to_float, to_int

try:  # Cheetah is always present in a WeeWX install, but guard for tests.
    from weewx.cheetahgenerator import SearchList
except ImportError:  # pragma: no cover
    SearchList = object

log = logging.getLogger(__name__)

VERSION = "1.0.0"
SCHEMA_VERSION = 1
REPORT_NAME = "CarbonSteelSeries"

# Observations whose daily high/low are tracked and published.
HILO_OBS = (
    "outTemp", "inTemp", "dewpoint", "outHumidity", "inHumidity", "barometer",
    "windGust", "windSpeed", "rainRate", "UV", "radiation", "heatindex",
    "windchill", "appTemp", "humidex", "cloudbase",
)

# Observations sent in history.json (only those present in the database).
HISTORY_OBS = (
    "outTemp", "dewpoint", "outHumidity", "barometer", "windSpeed", "windGust",
    "windDir", "rainRate", "rain", "UV", "radiation", "inTemp", "inHumidity",
    "appTemp", "cloudbase",
)

COMPASS_BINS = 16


# ---------------------------------------------------------------------------
# Helpers shared by the service and the search list
# ---------------------------------------------------------------------------

def build_units(config_dict: dict, report: str = REPORT_NAME):
    """Return (converter, formatter, html_root) for the CarbonSteelSeries report.

    Uses WeeWX's own skin-dictionary builder so that the realtime file uses
    exactly the same units and formats as the generated report.
    """
    import weewx.reportengine

    try:
        skin_dict = weewx.reportengine.build_skin_dict(config_dict, report)
    except (KeyError, OSError, SyntaxError) as e:
        log.warning("carbonsteelseries: could not build skin dictionary for report '%s' (%s); "
                    "falling back to METRIC units", report, e)
        converter = weewx.units.Converter(weewx.units.MetricUnits)
        formatter = weewx.units.Formatter()
        html_root = Path(config_dict.get("WEEWX_ROOT", "."),
                         config_dict.get("StdReport", {}).get("HTML_ROOT", "public_html"),
                         "CS")
        return converter, formatter, html_root

    converter = weewx.units.Converter.fromSkinDict(skin_dict)
    formatter = weewx.units.Formatter.fromSkinDict(skin_dict)
    html_root = Path(config_dict.get("WEEWX_ROOT", "."),
                     skin_dict.get("HTML_ROOT",
                                   config_dict["StdReport"].get("HTML_ROOT", "public_html")))
    return converter, formatter, html_root


_DP_RE = re.compile(r"%[-+ 0#]*\d*\.(\d+)f")


class UnitHelper:
    """Converts values to the report units and rounds them sensibly."""

    def __init__(self, converter, formatter):
        self.converter = converter
        self.formatter = formatter
        self._dp_cache: dict[str, int | None] = {}

    def decimals(self, unit: str | None) -> int | None:
        if unit is None:
            return None
        if unit not in self._dp_cache:
            try:
                fmt = self.formatter.get_format_string(unit)
            except (KeyError, TypeError):
                fmt = None
            m = _DP_RE.search(fmt or "")
            self._dp_cache[unit] = int(m.group(1)) if m else (0 if fmt else None)
        return self._dp_cache[unit]

    def target(self, obs: str) -> tuple[str | None, str | None]:
        return self.converter.getTargetUnit(obs)

    def convert(self, value, obs: str, us_units: int, agg_type: str | None = None):
        """Convert a single value of observation *obs* from unit system *us_units*."""
        if value is None:
            return None
        try:
            src_unit, group = weewx.units.getStandardUnitType(us_units, obs, agg_type)
            vt = self.converter.convert(weewx.units.ValueTuple(value, src_unit, group))
            value = vt[0]
            unit = vt[1]
        except (KeyError, TypeError, ValueError):
            unit = None
        return self.round(value, unit)

    def round(self, value, unit):
        if value is None or not isinstance(value, (int, float)):
            return value
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            return None
        dp = self.decimals(unit)
        if dp is None:
            return round(value, 3)
        # One more decimal than the display format so the client can smooth.
        return round(value, dp + 1)

    def unit_block(self, groups) -> dict:
        """Describe the units in use for each group, for the client."""
        out = {}
        for group in sorted(groups):
            unit = self.converter.group_unit_dict.get(group)
            if unit is None:
                continue
            try:
                label = self.formatter.get_label_string(unit).strip()
            except (KeyError, TypeError):
                label = ""
            out[group] = {"unit": unit, "label": label, "dp": self.decimals(unit)}
        return out


def compass_bin(direction: float, bins: int = COMPASS_BINS) -> int:
    width = 360.0 / bins
    return int(((direction + width / 2.0) % 360.0) // width)


def vector_mean_direction(samples) -> float | None:
    """Speed-weighted vector mean of (speed, direction) samples."""
    x = y = 0.0
    for speed, direction in samples:
        if speed is None or direction is None or speed <= 0:
            continue
        r = math.radians(direction)
        x += speed * math.sin(r)
        y += speed * math.cos(r)
    if x == 0 and y == 0:
        return None
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def direction_range(directions) -> tuple[float | None, float | None]:
    """Smallest arc (from, to), clockwise, containing all directions."""
    dirs = sorted({round(d % 360.0, 1) for d in directions if d is not None})
    if not dirs:
        return None, None
    if len(dirs) == 1:
        return dirs[0], dirs[0]
    # Find the largest gap; the range is everything outside it.
    gaps = [(dirs[(i + 1) % len(dirs)] - dirs[i]) % 360.0 for i in range(len(dirs))]
    i = max(range(len(gaps)), key=gaps.__getitem__)
    return dirs[(i + 1) % len(dirs)], dirs[i]


def baro_trend_text(change_hpa: float | None) -> str | None:
    """WMO-style 3-hour pressure tendency description."""
    if change_hpa is None:
        return None
    a = abs(change_hpa)
    if a < 0.1:
        return "Steady"
    word = "Rising" if change_hpa > 0 else "Falling"
    if a < 1.6:
        return f"{word} slowly"
    if a < 3.6:
        return word
    if a < 6.0:
        return f"{word} quickly"
    return f"{word} very rapidly"


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".realtime-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"), allow_nan=False)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Realtime service
# ---------------------------------------------------------------------------

class CarbonSteelSeriesRealtime(weewx.engine.StdService):
    """Writes realtime.json from WeeWX LOOP packets.

    Configuration (all optional) lives in ``[CarbonSteelSeriesRealtime]``::

        [CarbonSteelSeriesRealtime]
            enable = true
            json_file = realtime.json      # relative to the CarbonSteelSeries report's HTML_ROOT
            min_interval = 0               # seconds between writes; 0 = every packet
            wind_avg_period = 600          # seconds used for average wind / gust
            stale_age = 900                # drop values not refreshed for this long
            data_binding = wx_binding
    """

    def __init__(self, engine, config_dict):
        super().__init__(engine, config_dict)
        cfg = config_dict.get("CarbonSteelSeriesRealtime", {})
        if not to_bool(cfg.get("enable", True)):
            log.info("carbonsteelseries: realtime service disabled")
            return

        self.binding = cfg.get("data_binding", "wx_binding")
        self.min_interval = to_float(cfg.get("min_interval", 0))
        self.wind_period = to_int(cfg.get("wind_avg_period", 600))
        self.stale_age = to_int(cfg.get("stale_age", 900))
        report = cfg.get("report", REPORT_NAME)

        converter, formatter, html_root = build_units(config_dict, report)
        self.units = UnitHelper(converter, formatter)
        json_file = Path(cfg.get("json_file", "realtime.json"))
        self.json_path = json_file if json_file.is_absolute() else html_root / json_file

        station = config_dict.get("Station", {})
        self.station = {
            "location": station.get("location", ""),
            "latitude": to_float(station.get("latitude")) if station.get("latitude") else None,
            "longitude": to_float(station.get("longitude")) if station.get("longitude") else None,
            "hardware": getattr(engine.console, "hardware_name", None) if hasattr(engine, "console") else None,
        }
        self.archive_interval = to_int(config_dict.get("StdArchive", {}).get("archive_interval", 0)) or None

        # State
        self.current: dict[str, Any] = {}        # obs -> converted value
        self.current_ts: dict[str, int] = {}     # obs -> time last seen
        self.loop_buf: list[dict] = []           # converted packets since last DB record
        self.wind_buf: collections.deque = collections.deque()
        self.db: dict[str, Any] = {}             # aggregates from the database
        self.db_last_ts = 0
        self.day_start = 0
        self.last_write = 0.0
        self.last_loop_ts = None
        self.baro_3h_ago = None                  # (value hPa)
        self.us_units = None

        self.bind(weewx.NEW_LOOP_PACKET, self.new_loop_packet)
        self.bind(weewx.NEW_ARCHIVE_RECORD, self.new_archive_record)
        log.info("carbonsteelseries: v%s writing %s", VERSION, self.json_path)

    # -- database seeding --------------------------------------------------

    def _db_manager(self):
        return self.engine.db_binder.get_manager(self.binding)

    def refresh_from_db(self, now_ts: int) -> None:
        """Re-read aggregates for today (and month/year rain) from the database."""
        dbm = self._db_manager()
        last_ts = dbm.lastGoodStamp() or 0
        self.db_last_ts = last_ts
        self.day_start = weeutil.weeutil.startOfDay(now_ts)
        db: dict[str, Any] = {"hilo": {}, "rain": {}}
        us = dbm.std_unit_system

        day_span = weeutil.weeutil.archiveDaySpan(now_ts)
        if last_ts > self.day_start:
            for obs in HILO_OBS:
                entry = {}
                for agg in ("max", "maxtime", "min", "mintime"):
                    try:
                        vt = weewx.xtypes.get_aggregate(obs, day_span, agg, dbm)
                    except (weewx.UnknownType, weewx.UnknownAggregation):
                        break
                    except Exception as e:  # database errors must not stop WeeWX
                        log.debug("carbonsteelseries: aggregate %s.%s failed: %s", obs, agg, e)
                        break
                    if vt[0] is None:
                        continue
                    if agg.endswith("time"):
                        entry[agg] = int(vt[0])
                    else:
                        entry[agg] = self.units.convert(
                            weewx.units.convertStd(vt, us)[0], obs, us)
                if entry:
                    db["hilo"][obs] = entry

        spans = {
            "day": day_span,
            "month": weeutil.weeutil.archiveMonthSpan(now_ts),
            "year": weeutil.weeutil.archiveYearSpan(now_ts),
            "last24h": TimeSpan(now_ts - 86400, max(now_ts, last_ts)),
            "lastHour": TimeSpan(now_ts - 3600, max(now_ts, last_ts)),
        }
        for name, span in spans.items():
            try:
                vt = weewx.xtypes.get_aggregate("rain", span, "sum", dbm)
                db["rain"][name] = self.units.converter.convert(vt)[0] or 0.0
            except Exception as e:
                log.debug("carbonsteelseries: rain %s failed: %s", name, e)

        # Wind rose for today from archive records, speed x interval weighted.
        rose = [0.0] * COMPASS_BINS
        try:
            for ts, wdir, wspd, interval in dbm.genSql(
                    "SELECT dateTime, windDir, windSpeed, `interval` FROM %s "
                    "WHERE dateTime > ? AND dateTime <= ?" % dbm.table_name,
                    (self.day_start, last_ts)):
                if wdir is not None and wspd:
                    rose[compass_bin(wdir)] += wspd * (interval or 5)
        except Exception as e:
            log.debug("carbonsteelseries: wind rose query failed: %s", e)
        db["rose"] = rose

        # Barometer 3 hours ago for the pressure tendency.
        try:
            rec = dbm.getRecord(now_ts - 10800, max_delta=1800)
            if rec and rec.get("barometer") is not None:
                vt = weewx.units.ValueTuple(rec["barometer"],
                                            *weewx.units.getStandardUnitType(rec["usUnits"], "barometer"))
                db["baro_3h_hpa"] = weewx.units.convert(vt, "hPa")[0]
            else:
                db["baro_3h_hpa"] = None
        except Exception as e:
            log.debug("carbonsteelseries: barometer trend lookup failed: %s", e)
            db["baro_3h_hpa"] = None

        self.db = db
        # Keep only loop data newer than what the database now holds.
        self.loop_buf = [p for p in self.loop_buf
                         if p["dateTime"] > last_ts and p["dateTime"] > self.day_start]

    # -- event handlers ----------------------------------------------------

    def new_archive_record(self, event):
        try:
            self.archive_interval = event.record.get("interval", 5) * 60
            self.refresh_from_db(int(event.record["dateTime"]))
        except Exception as e:
            log.error("carbonsteelseries: failed to refresh from database: %s", e)

    def new_loop_packet(self, event):
        try:
            self._process_packet(event.packet)
        except Exception as e:  # never let the gauges take the engine down
            log.error("carbonsteelseries: error processing LOOP packet: %s", e, exc_info=True)

    def _process_packet(self, packet: dict) -> None:
        ts = int(packet["dateTime"])
        us = packet["usUnits"]
        self.us_units = us
        if not self.db or weeutil.weeutil.startOfDay(ts) != self.day_start:
            self.refresh_from_db(ts)

        conv = {"dateTime": ts}
        for obs, value in packet.items():
            if obs in ("dateTime", "usUnits") or not isinstance(value, (int, float)):
                continue
            conv[obs] = self.units.convert(value, obs, us)
        if packet.get("barometer") is not None:
            vt = weewx.units.as_value_tuple(packet, "barometer")
            conv["_baro_hpa"] = weewx.units.convert(vt, "hPa")[0]
        # Rain increment in target units (not rounded, to avoid drift).
        if packet.get("rain") is not None:
            vt = weewx.units.as_value_tuple(packet, "rain")
            conv["_rain"] = self.units.converter.convert(vt)[0]
        dt = ts - self.last_loop_ts if self.last_loop_ts else 0
        self.last_loop_ts = ts
        conv["_dt"] = dt if 0 < dt < 120 else 0
        self.loop_buf.append(conv)

        # Merge into "current", ageing out stale values (partial packets).
        for obs, value in conv.items():
            if obs.startswith("_") or obs == "dateTime" or value is None:
                continue
            self.current[obs] = value
            self.current_ts[obs] = ts
        for obs in [o for o, t in self.current_ts.items() if ts - t > self.stale_age]:
            self.current.pop(obs, None)
            self.current_ts.pop(obs, None)

        # Wind window
        self.wind_buf.append((ts, conv.get("windSpeed"), conv.get("windDir"),
                              conv.get("windGust")))
        while self.wind_buf and ts - self.wind_buf[0][0] > self.wind_period:
            self.wind_buf.popleft()

        now = time.time()
        if self.min_interval and now - self.last_write < self.min_interval:
            return
        self.last_write = now
        atomic_write_json(self.json_path, self.build_payload(ts))

    # -- payload -----------------------------------------------------------

    def _hilo(self) -> dict:
        out: dict[str, dict] = {}
        for obs in HILO_OBS:
            entry = dict(self.db.get("hilo", {}).get(obs, {}))
            for p in self.loop_buf:
                v = p.get(obs)
                if v is None:
                    continue
                if entry.get("max") is None or v > entry["max"]:
                    entry["max"], entry["maxtime"] = v, p["dateTime"]
                if entry.get("min") is None or v < entry["min"]:
                    entry["min"], entry["mintime"] = v, p["dateTime"]
            if entry:
                out[obs] = entry
        return out

    def _rain(self) -> dict:
        extra = sum(p.get("_rain") or 0.0 for p in self.loop_buf)
        unit, _ = self.units.target("rain")
        out = {}
        for name, v in self.db.get("rain", {}).items():
            out[name] = self.units.round((v or 0.0) + extra, unit)
        return out

    def _wind(self) -> dict:
        samples = list(self.wind_buf)
        speeds = [s for _, s, _, _ in samples if s is not None]
        gusts = [g for _, _, _, g in samples if g is not None] + speeds
        unit, _ = self.units.target("windSpeed")
        avg_dir = vector_mean_direction((s, d) for _, s, d, _ in samples)
        dmin, dmax = direction_range(d for _, s, d, _ in samples if s)
        rose = list(self.db.get("rose", [0.0] * COMPASS_BINS))
        for p in self.loop_buf:
            if p.get("windDir") is not None and p.get("windSpeed"):
                rose[compass_bin(p["windDir"])] += p["windSpeed"] * p["_dt"]
        total = sum(rose)
        return {
            "avg": self.units.round(sum(speeds) / len(speeds), unit) if speeds else None,
            "gust": self.units.round(max(gusts), unit) if gusts else None,
            "avgDir": round(avg_dir) if avg_dir is not None else None,
            "dirFrom": dmin,
            "dirTo": dmax,
            "period": self.wind_period,
            "rose": [round(r / total, 4) for r in rose] if total else [0.0] * COMPASS_BINS,
        }

    def _baro_trend(self) -> dict:
        now_hpa = next((p["_baro_hpa"] for p in reversed(self.loop_buf) if "_baro_hpa" in p), None)
        then = self.db.get("baro_3h_hpa")
        if now_hpa is None or then is None:
            return {"change": None, "text": None}
        change_hpa = now_hpa - then
        unit, _ = self.units.target("barometer")
        try:
            change = weewx.units.convert(weewx.units.ValueTuple(change_hpa, "hPa", "group_pressure"), unit)[0]
        except (KeyError, TypeError):
            change = change_hpa
        return {"change": self.units.round(change, unit), "text": baro_trend_text(change_hpa)}

    def build_payload(self, ts: int) -> dict:
        groups = {self.units.target(o)[1] for o in list(self.current) + ["rain", "rainRate",
                                                                          "windSpeed", "barometer",
                                                                          "outTemp", "cloudbase"]}
        groups.discard(None)
        obs_groups = {o: self.units.target(o)[1] for o in self.current}
        return {
            "schema": SCHEMA_VERSION,
            "generator": f"weewx-carbonsteel-series {VERSION} / WeeWX {weewx.__version__}",
            "dateTime": ts,
            "written": int(time.time()),
            "archiveInterval": self.archive_interval,
            "station": self.station,
            "units": self.units.unit_block(groups),
            "obsGroups": {o: g for o, g in obs_groups.items() if g},
            "current": self.current,
            "day": self._hilo(),
            "rain": self._rain(),
            "wind": self._wind(),
            "baroTrend": self._baro_trend(),
        }


# ---------------------------------------------------------------------------
# Search list extension for history.json / calendar.json
# ---------------------------------------------------------------------------

class _LazyJSON:
    """Serialised only if a template actually uses it (keeps pages that don't
    need history or calendar data from doing the database work)."""

    def __init__(self, fn):
        self._fn = fn
        self._text = None

    def __str__(self):
        if self._text is None:
            self._text = json.dumps(self._fn(), separators=(",", ":"))
        return self._text


# Unit groups the gauges convert between, taken from a host skin's [Units].
HOST_UNIT_GROUPS = ("group_temperature", "group_pressure", "group_speed",
                    "group_rain", "group_altitude")


class CarbonSteelSeriesHistory(SearchList):
    """Provides $ss_config_json, $ss_history_json, $ss_calendar_json and
    $ss_base_url to the skin templates.

    A skin can set ``data_report`` in its [CarbonSteelSeries] section (the
    Seasons page does) to use another report's page options and data files:
    its options are inherited, and $ss_base_url becomes the relative path from
    this report's folder to that report's folder.
    """

    def __init__(self, generator):
        SearchList.__init__(self, generator)
        self.skin_dict = generator.skin_dict
        self.config_dict = generator.config_dict
        own = self.skin_dict.get(REPORT_NAME, {})
        self.data_report = own.get("data_report")
        self.opts = self._plain(own)
        self.base_url = ""
        if self.data_report:
            self.opts, self.base_url = self._inherit(self.data_report, self.opts)
        # A page that sits inside another skin (host_skin = Seasons) takes that
        # skin's wording, language and display units, read (never changed)
        # from its own settings, so it reads and measures like its neighbours.
        self.texts, self.lang, self.host_units = self._host_settings(own.get("host_skin"))
        self.history_hours = to_int(self.opts.get("history_hours", 24))
        self.calendar_days = to_int(self.opts.get("calendar_days", 366))
        # Skip the database work for features the station owner switched off.
        self.sparklines = to_bool(self.opts.get("sparklines", True))
        self.calendar = to_bool(self.opts.get("calendar", True))

    @staticmethod
    def _plain(d):
        return {k: (CarbonSteelSeriesHistory._plain(v) if hasattr(v, "items") else v)
                for k, v in d.items()}

    def _inherit(self, report, own):
        """Options of `report` overlaid with this skin's own, plus the relative URL."""
        import weewx.reportengine
        try:
            main = weewx.reportengine.build_skin_dict(self.config_dict, report)
        except Exception as e:
            log.error("carbonsteelseries: cannot read report '%s' for data_report: %s", report, e)
            return own, ""
        opts = self._plain(main.get(REPORT_NAME, {}))
        opts.update({k: v for k, v in own.items() if k != "data_report"})
        root = self.config_dict.get("WEEWX_ROOT", "")
        std_root = self.config_dict.get("StdReport", {}).get("HTML_ROOT", "public_html")
        here = os.path.join(root, self.skin_dict.get("HTML_ROOT", std_root))
        there = os.path.join(root, main.get("HTML_ROOT", std_root))
        rel = os.path.relpath(there, here).replace(os.sep, "/")
        return opts, ("" if rel == "." else rel + "/")

    def _host_settings(self, skin):
        """(texts, language, display units) of the report that uses `skin`."""
        if not skin:
            return {}, "en", {}
        import weewx.reportengine
        std = self.config_dict.get("StdReport", {})
        names = [n for n in std.sections if str(std[n].get("skin", "")) == skin]
        names.sort(key=lambda n: str(std[n].get("enable", "true")).lower() == "false")
        if not names:
            return {}, "en", {}
        try:
            other = weewx.reportengine.build_skin_dict(self.config_dict, names[0])
        except Exception as e:
            log.debug("carbonsteelseries: cannot read settings of report '%s': %s", names[0], e)
            return {}, "en", {}
        groups = other.get("Units", {}).get("Groups", {})
        units = {g: str(groups[g]) for g in HOST_UNIT_GROUPS if g in groups}
        return self._plain(other.get("Texts", {})), str(other.get("lang", "en")), units

    def _text(self, key, context=None):
        """Translation of `key` from the other skin's texts, else `key` itself."""
        texts = self.texts.get(context, {}) if context else self.texts
        value = texts.get(key) if hasattr(texts, "get") else None
        return value if isinstance(value, str) and value else key

    def get_extension_list(self, timespan, db_lookup):
        converter = weewx.units.Converter.fromSkinDict(self.skin_dict)
        formatter = weewx.units.Formatter.fromSkinDict(self.skin_dict)
        units = UnitHelper(converter, formatter)
        stop = timespan.stop
        return [{
            "ss_version": VERSION,
            "ss_base_url": self.base_url,
            "cs_text": self._text,
            "cs_lang": self.lang,
            "ss_config_json": json.dumps(self._client_config(), separators=(",", ":")),
            "ss_history_json": _LazyJSON(
                lambda: self._history(db_lookup(), units, stop) if self.sparklines else {"time": []}),
            "ss_calendar_json": _LazyJSON(
                lambda: self._calendar(db_lookup(), units, stop) if self.calendar else {"days": []}),
        }]

    def _client_config(self) -> dict:
        """The page options, passed to the page as JSON."""
        cfg = dict(self.opts)
        cfg.pop("data_report", None)
        cfg.pop("host_skin", None)
        if self.host_units:
            cfg["display_units"] = self.host_units
        cfg["base_url"] = self.base_url
        cfg["version"] = VERSION
        return cfg

    def _history(self, dbm, units: UnitHelper, stop: int) -> dict:
        cols = [o for o in HISTORY_OBS if o in dbm.sqlkeys]
        start = stop - self.history_hours * 3600
        data: dict[str, list] = {"time": [], **{c: [] for c in cols}}
        if not cols:
            return data
        sql = "SELECT dateTime, usUnits, %s FROM %s WHERE dateTime > ? AND dateTime <= ? " \
              "ORDER BY dateTime" % (", ".join("`%s`" % c for c in cols), dbm.table_name)
        for row in dbm.genSql(sql, (start, stop)):
            data["time"].append(row[0])
            us = row[1]
            for c, v in zip(cols, row[2:]):
                data[c].append(units.convert(v, c, us))
        # Drop series that are entirely empty (sensor not fitted).
        return {k: v for k, v in data.items() if k == "time" or any(x is not None for x in v)}

    def _calendar(self, dbm, units: UnitHelper, stop: int) -> dict:
        start = weeutil.weeutil.startOfDay(stop) - (self.calendar_days - 1) * 86400
        us = dbm.std_unit_system
        days: dict[int, dict] = {}
        wanted = {
            # obs: (fields, output names)
            "outTemp": ("min, max, sum, count", ("tmin", "tmax", "_tsum", "_tcount")),
            "rain": ("sum", ("rain",)),
            "windGust": ("max", ("gust",)),
            "outHumidity": ("sum, count", ("_hsum", "_hcount")),
            "UV": ("max", ("uv",)),
            "radiation": ("max", ("solar",)),
        }
        for obs, (fields, names) in wanted.items():
            if obs not in dbm.daykeys:
                continue
            sql = "SELECT dateTime, %s FROM %s_day_%s WHERE dateTime >= ? AND dateTime <= ? " \
                  "ORDER BY dateTime" % (fields, dbm.table_name, obs)
            try:
                for row in dbm.genSql(sql, (start, stop)):
                    d = days.setdefault(row[0], {})
                    for name, v in zip(names, row[1:]):
                        d[name] = v
            except Exception as e:
                log.debug("carbonsteelseries: calendar query for %s failed: %s", obs, e)

        out = []
        for ts in sorted(days):
            d = days[ts]
            rec = {"date": time.strftime("%Y-%m-%d", time.localtime(ts))}
            if d.get("_tcount"):
                rec["tavg"] = units.convert(d["_tsum"] / d["_tcount"], "outTemp", us)
            for key, obs in (("tmin", "outTemp"), ("tmax", "outTemp"), ("rain", "rain"),
                             ("gust", "windGust"), ("uv", "UV"), ("solar", "radiation")):
                if d.get(key) is not None:
                    rec[key] = units.convert(d[key], obs, us)
            if d.get("_hcount"):
                rec["hum"] = round(d["_hsum"] / d["_hcount"])
            if len(rec) > 1:
                out.append(rec)
        return {"days": out}
