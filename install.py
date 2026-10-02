#
#    Installer for weewx-carbonsteel-series — live weather gauges for WeeWX 5
#
#    This program is free software; you can redistribute it and/or modify it
#    under the terms of the GNU General Public License as published by the Free
#    Software Foundation; either version 3 of the License, or (at your option)
#    any later version.
#
#    Install with:   weectl extension install weewx-carbonsteel-series-v1.0.1.zip
#    Remove with:    weectl extension uninstall CarbonSteelSeries
#
#    The installer asks whether to show the sparklines and the "Year at a
#    glance" calendar. To answer without prompting (scripts, --yes):
#
#        weectl extension install weewx-carbonsteel-series-v1.0.1.zip --yes \
#            --sparklines=n --calendar=y
#
import os
import shutil
import sys

import weewx
from weeutil.weeutil import y_or_n
from weecfg.extension import ExtensionInstaller

VERSION = "1.0.1"
REPORT = "CarbonSteelSeries"      # extension, report and options section name
OLD_NAME = "SteelSeries"         # name used by the pre-release builds
SKIN = "CS"                      # skin folder and page folder
OLD_SKIN = "ss"                  # folder used by earlier builds
SEASONS_REPORT = "CarbonSteelSeriesSeasons"   # report for the page added to Seasons
SEASONS_SKIN = "CS-Seasons"
BT_REPORT = "new-belchertown"   # Belchertown-new's report (fixed by its installer)
BT_SKIN = "new-belchertown"
BT_PAGE = "carbonsteel/index.html.tmpl"   # page template inside the Belchertown skin
REQUIRED_WEEWX = (5, 0, 0)


def _version_tuple(v):
    parts = []
    for p in str(v).split("."):
        num = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(num) if num else 0)
    return tuple(parts + [0] * (3 - len(parts)))[:3]


# ---------------------------------------------------------------------------
# Header buttons. Seasons and Belchertown-new have no hook for other extensions
# to add header links, so a small, clearly marked block is placed in one file
# of each: Seasons' titlebar.inc, and Belchertown's own nav-menu-custom.inc
# (its documented, upgrade-safe way to add menu items). Each block only shows
# while the gauges page it points to is installed, so uninstalling this
# extension hides the button; re-running the installer and answering "no"
# takes the block out completely.
# ---------------------------------------------------------------------------
MARK_START = "## weewx-carbonsteel-series: start"
MARK_END = "## weewx-carbonsteel-series: end"
MARK_CREATED = "## weewx-carbonsteel-series: created this file from nav-menu-custom.inc.example\n"

SEASONS_BUTTON = MARK_START + """ -- "Live Gauges" button. Added by the weewx-carbonsteel-series
## installer; it only shows while that extension's Seasons page is installed.
#if os.path.exists("../%s/skin.conf")
  <div id="carbonsteel_link" style="float:right; margin-top:6px; margin-right:10px; padding-left:8px; padding-right:8px; background-color:var(--background-color); border:1px solid var(--section-border-color); border-radius:5px;"><a href="carbonsteel-gauges.html">Live Gauges</a></div>
#end if
""" % SEASONS_SKIN + MARK_END + "\n"

BT_MENU_ITEM = MARK_START + """ -- "Live Gauges" menu item. Added by the weewx-carbonsteel-series
## installer; it only shows while that extension's Belchertown page is installed.
#if os.path.exists("carbonsteel/index.html.tmpl")
<li class="menu-item menu-item-carbonsteel${" current-menu-item" if $page == "carbonsteel" else ""}"><a href="$relative_url/carbonsteel/" itemprop="url"><span itemprop="name">$Extras.get('carbonsteel_title', 'Live Gauges')</span></a></li>
#end if
""" + MARK_END + "\n"


def _strip_block(text):
    """Remove every marked block (inclusive) from text."""
    out, skipping = [], False
    for line in text.splitlines(keepends=True):
        if line.startswith(MARK_START):
            skipping = True
            continue
        if skipping:
            if line.startswith(MARK_END):
                skipping = False
            continue
        out.append(line)
    return "".join(out)


def _put_block(text, block, find_anchor):
    """Insert block at the line index find_anchor(lines) returns (replacing any old block)."""
    lines = _strip_block(text).splitlines(keepends=True)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    at = find_anchor(lines)
    return "".join(lines[:at] + [block] + lines[at:])


def _seasons_anchor(lines):
    """After the RSS link block, else after the title block, else at the end."""
    for i, line in enumerate(lines):
        if 'id="rss_link"' in line:
            if i + 1 < len(lines) and lines[i + 1].strip() == "#end if":
                return i + 2
            return i + 1
    for i, line in enumerate(lines):
        if '<div id="reports">' in line:
            j = i - 1 if i > 0 and lines[i - 1].strip().startswith("#if") else i
            return j
    return len(lines)


def _bt_anchor(lines):
    """Before Belchertown's 'Add custom menu items below' note, else at the end."""
    for i, line in enumerate(lines):
        if line.startswith("## Add custom menu items below"):
            return i
    return len(lines)


def _write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def loader():
    return CarbonSteelSeriesInstaller()


class CarbonSteelSeriesInstaller(ExtensionInstaller):
    def __init__(self):
        if _version_tuple(weewx.__version__) < REQUIRED_WEEWX:
            raise weewx.UnsupportedFeature(
                "weewx-carbonsteel-series %s requires WeeWX 5.0 or later, found %s"
                % (VERSION, weewx.__version__))

        skin_files = [
            "skins/CS/skin.conf",
            "skins/CS/index.html.tmpl",
            "skins/CS/history.json.tmpl",
            "skins/CS/calendar.json.tmpl",
            "skins/CS/favicon.svg",
            "skins/CS/config.js.tmpl",
        ]
        super().__init__(
            version=VERSION,
            name="CarbonSteelSeries",
            description="Live SVG weather gauges with a LOOP-driven realtime JSON feed.",
            author="Ian Millard and contributors (after the SteelSeries gauges by Gerrit Grunwald "
                   "and Mark Crossley, and the original extension by Gary Roderick)",
            author_email="",
            archive_services="user.carbonsteelseries.CarbonSteelSeriesRealtime",
            config={
                "CarbonSteelSeriesRealtime": {
                    "enable": "true",
                    "json_file": "realtime.json",
                    "min_interval": "0",
                    "wind_avg_period": "600",
                },
                "StdReport": {
                    "CarbonSteelSeries": {
                        # WeeWX 5 prepends the station's own HTML_ROOT, so this
                        # becomes public_html/CS (pip) or /var/www/html/weewx/CS (deb/rpm).
                        "HTML_ROOT": SKIN,
                        "skin": SKIN,
                        "enable": "true",
                        # Answers to the install questions. Listed here so that
                        # "weectl extension uninstall" knows to remove them too.
                        REPORT: {
                            "sparklines": "true",
                            "calendar": "true",
                        },
                    },
                    # A gauges page inside the Seasons site. The installer points
                    # HTML_ROOT at the Seasons report's own folder.
                    SEASONS_REPORT: {
                        "HTML_ROOT": ".",
                        "skin": SEASONS_SKIN,
                        "enable": "false",
                    },
                    # A gauges page inside Belchertown-new: one extra template for
                    # its own report, and where that page finds the CS folder.
                    # Only added if you choose it (and Belchertown-new is installed);
                    # listed here so that uninstalling removes exactly these entries.
                    BT_REPORT: {
                        "Extras": {"carbonsteel_url": "../CS/"},
                        "CheetahGenerator": {"ToDate": {"carbonsteel": {"template": BT_PAGE}}},
                    },
                },
            },
            files=[
                ("bin/user", ["bin/user/carbonsteelseries.py"]),
                ("skins/CS", skin_files),
                ("skins/CS/css", ["skins/CS/css/gauges.css", "skins/CS/css/components.css",
                                  "skins/CS/css/embed.css.tmpl"]),
                ("skins/CS/fonts", ["skins/CS/fonts/lexend.woff2", "skins/CS/fonts/Lexend-OFL.txt"]),
                ("skins/CS/js", ["skins/CS/js/gauges.js", "skins/CS/js/d3.min.js",
                                 "skins/CS/js/d3.LICENSE.txt"]),
                ("skins/" + SEASONS_SKIN, ["skins/%s/skin.conf" % SEASONS_SKIN,
                                           "skins/%s/carbonsteel-gauges.html.tmpl" % SEASONS_SKIN]),
                # Installed into the Belchertown skin, so the source mirrors that path.
                ("skins/%s/carbonsteel" % BT_SKIN, ["skins/%s/%s" % (BT_SKIN, BT_PAGE)]),
            ],
        )

    # Features the installer asks about: option name -> question
    QUESTIONS = {
        "sparklines": "Display sparklines (24-hour mini charts under each gauge)",
        "calendar": "Display the 'Year at a glance' calendar",
    }
    SEASONS_QUESTION = "Add a live gauges page to the Seasons skin (carbonsteel-gauges.html)"
    BT_QUESTION = "Add a live gauges page to the Belchertown-new skin (carbonsteel/)"

    def process_args(self, args):
        """Accept --sparklines, --calendar, --seasons and --belchertown (=y|n) on the command line."""
        self.answers = {}
        for arg in args or []:
            if not arg.startswith("--") or "=" not in arg:
                continue
            key, value = arg[2:].split("=", 1)
            if key in self.QUESTIONS or key in ("seasons", "belchertown"):
                self.answers[key] = value.strip().lower() in ("y", "yes", "true", "1", "on")

    def configure(self, engine):
        changed = self._migrate_from_steelseries(engine)
        changed |= self._move_from_ss_folder(engine)
        std = engine.config_dict.get("StdReport", {})
        report = std.get(REPORT, {})
        current = report.get(REPORT, {}) if hasattr(report, "get") else {}

        answers = dict(getattr(self, "answers", {}))
        unattended = ("-y" in sys.argv or "--yes" in sys.argv
                      or not sys.stdin or not sys.stdin.isatty())
        seasons = answers.pop("seasons", None)
        belchertown = answers.pop("belchertown", None)
        for key, question in self.QUESTIONS.items():
            if key in answers:
                continue
            # Default: keep the existing setting on a reinstall, else "yes".
            default = "n" if str(current.get(key, "true")).lower() in ("false", "no", "n", "0", "off") else "y"
            if unattended:
                answers[key] = default == "y"
            else:
                ans = y_or_n(f"{question} (y/n) [{default}]? ", default=default)
                answers[key] = ans == "y"

        options = {k: "true" if v else "false" for k, v in answers.items()}
        for key, value in options.items():
            engine.printer.out(f"  {self.QUESTIONS[key]}: {'yes' if value == 'true' else 'no'}")

        seasons_report = self._find_seasons_report(std)
        if seasons is None:
            if SEASONS_REPORT in std:       # reinstall: keep the earlier answer
                default = "y" if str(std[SEASONS_REPORT].get("enable", "false")).lower() == "true" else "n"
            else:                           # yes if the station runs a Seasons report
                default = "y" if seasons_report and str(
                    seasons_report[1].get("enable", "true")).lower() != "false" else "n"
            if unattended:
                seasons = default == "y"
            else:
                seasons = y_or_n(f"{self.SEASONS_QUESTION} (y/n) [{default}]? ", default=default) == "y"
        engine.printer.out(f"  {self.SEASONS_QUESTION}: {'yes' if seasons else 'no'}")

        if engine.dry_run:
            return changed

        # The Seasons page is written into the Seasons report's own folder.
        if seasons_report and "HTML_ROOT" in seasons_report[1]:
            seasons_root = seasons_report[1]["HTML_ROOT"]
        else:
            seasons_root = std.get("HTML_ROOT", "public_html")
        page = std.setdefault(SEASONS_REPORT, {})
        page["HTML_ROOT"] = seasons_root
        page["skin"] = SEASONS_SKIN
        page["enable"] = "true" if seasons else "false"
        if seasons:
            engine.printer.out(f"  Seasons gauges page: {os.path.join(seasons_root, 'carbonsteel-gauges.html')}")
        elif not seasons_report:
            engine.printer.out("  (no Seasons report found; enable [[%s]] later if you add one)" % SEASONS_REPORT)
        skin = str(seasons_report[1].get("skin", "Seasons")) if seasons_report else "Seasons"
        self._seasons_button(engine, os.path.join(engine.root_dict["SKIN_DIR"], skin, "titlebar.inc"), seasons)

        self._configure_belchertown(engine, std, belchertown, unattended)

        # Written straight into weewx.conf so a reinstall can change an earlier answer
        # (the normal config merge never overwrites existing values).
        if REPORT in std:
            std[REPORT].setdefault(REPORT, {})
            std[REPORT][REPORT].update(options)
        self["config"]["StdReport"][REPORT].setdefault(REPORT, {}).update(options)
        return True

    def _configure_belchertown(self, engine, std, answer, unattended):
        """Add, keep or remove the gauges page inside Belchertown-new.

        The page is one extra template run by Belchertown's own report (like its
        About page), so it gets Belchertown's header, menu, theme and footer and
        Belchertown's data fetching still runs once. Nothing of Belchertown is
        changed: two entries are added to its report, and one template file to a
        new 'carbonsteel' folder in its skin; both are removed again if the page
        is switched off or this extension is uninstalled.
        """
        root = engine.config_dict.get("WEEWX_ROOT", "")
        bt_dir = os.path.join(engine.root_dict["SKIN_DIR"], BT_SKIN)
        page_file = os.path.join(bt_dir, BT_PAGE)
        bt = std.get(BT_REPORT)
        installed = hasattr(bt, "get") and str(bt.get("skin", "")) == BT_SKIN \
            and os.path.isfile(os.path.join(bt_dir, "skin.conf"))
        registered = installed and hasattr(bt.get("CheetahGenerator"), "get") and \
            hasattr(bt["CheetahGenerator"].get("ToDate"), "get") and \
            "carbonsteel" in bt["CheetahGenerator"]["ToDate"]

        if not installed:
            add = False
        elif answer is not None:
            add = answer
        else:
            default = "y" if registered or str(bt.get("enable", "true")).lower() != "false" else "n"
            add = default == "y" if unattended else \
                y_or_n(f"{self.BT_QUESTION} (y/n) [{default}]? ", default=default) == "y"
        engine.printer.out(f"  {self.BT_QUESTION}: {'yes' if add else 'no'}"
                           + ("" if installed else " (Belchertown-new is not installed)"))

        # This installer's own copy of the Belchertown entries is only merged in
        # when the page is wanted; otherwise it would create a stub report.
        self["config"]["StdReport"].pop(BT_REPORT, None)
        if engine.dry_run:
            return

        if not add:
            # Take out the template file weectl just copied, and any earlier registration.
            if os.path.isfile(page_file):
                os.remove(page_file)
            for d in (os.path.dirname(page_file), bt_dir):
                if os.path.isdir(d) and not os.listdir(d):
                    os.rmdir(d)          # only folders this install created and left empty
            if registered:
                del bt["CheetahGenerator"]["ToDate"]["carbonsteel"]
                if not bt["CheetahGenerator"]["ToDate"]:
                    del bt["CheetahGenerator"]["ToDate"]
                if not bt["CheetahGenerator"]:
                    del bt["CheetahGenerator"]
                if hasattr(bt.get("Extras"), "pop"):
                    bt["Extras"].pop("carbonsteel_url", None)
                engine.printer.out("  removed the gauges page from Belchertown-new")
            if installed:
                self._belchertown_menu(engine, bt_dir, False)
            return

        # Where the page (at <Belchertown>/carbonsteel/) finds the CS folder,
        # relative to the Belchertown site root.
        std_root = std.get("HTML_ROOT", "public_html")
        cs_root = (std.get(REPORT, {}) or {}).get("HTML_ROOT") or os.path.join(std_root, SKIN)
        bt_root = bt.get("HTML_ROOT", std_root)
        url = os.path.relpath(os.path.join(root, cs_root), os.path.join(root, bt_root)).replace(os.sep, "/") + "/"

        bt.setdefault("Extras", {})["carbonsteel_url"] = url
        bt.setdefault("CheetahGenerator", {}).setdefault("ToDate", {})["carbonsteel"] = {"template": BT_PAGE}
        engine.printer.out(f"  Belchertown-new gauges page: {os.path.join(bt_root, 'carbonsteel', 'index.html')}")
        self._belchertown_menu(engine, bt_dir, True)

    @staticmethod
    def _seasons_button(engine, titlebar, show):
        """Add (show=True) or remove the 'Live Gauges' button in Seasons' title bar."""
        if not os.path.isfile(titlebar):
            return
        text = _read(titlebar)
        if show:
            new = _put_block(text, SEASONS_BUTTON, _seasons_anchor)
            if new != text:
                _write(titlebar, new)
                engine.printer.out(f"  added a 'Live Gauges' button to the Seasons title bar ({titlebar})")
        elif MARK_START in text:
            _write(titlebar, _strip_block(text))
            engine.printer.out(f"  removed the 'Live Gauges' button from {titlebar}")

    @staticmethod
    def _belchertown_menu(engine, bt_dir, show):
        """Add (show=True) or remove the 'Live Gauges' item in Belchertown's menu.

        Uses nav-menu-custom.inc, Belchertown's own way to add menu items (its
        upgrades never overwrite it). If there is none yet, one is made from
        Belchertown's nav-menu-custom.inc.example, which lists its default menu.
        """
        menu = os.path.join(bt_dir, "nav-menu-custom.inc")
        example = os.path.join(bt_dir, "nav-menu-custom.inc.example")
        if show:
            if os.path.isfile(menu):
                text = _read(menu)
            elif os.path.isfile(example):
                text = MARK_CREATED + _read(example)
            else:
                engine.printer.out("  (no nav-menu-custom.inc.example found; add the menu item by hand, see the README)")
                return
            new = _put_block(text, BT_MENU_ITEM, _bt_anchor)
            if not os.path.isfile(menu) or new != text:
                _write(menu, new)
                engine.printer.out(f"  added a 'Live Gauges' item to the Belchertown menu ({menu})")
        elif os.path.isfile(menu):
            text = _read(menu)
            if MARK_START not in text and not text.startswith(MARK_CREATED):
                return
            rest = _strip_block(text)
            if rest.startswith(MARK_CREATED) and os.path.isfile(example) \
                    and rest[len(MARK_CREATED):] == _read(example):
                os.remove(menu)          # made by this installer and otherwise unchanged
                engine.printer.out(f"  removed {menu} (created by this installer)")
            else:
                _write(menu, rest)
                engine.printer.out(f"  removed the 'Live Gauges' item from {menu}")

    @staticmethod
    def _find_seasons_report(std):
        """(name, section) of the station's Seasons report, preferring an enabled one."""
        found = None
        for name in std.sections if hasattr(std, "sections") else []:
            sec = std[name]
            if str(sec.get("skin", "")) == "Seasons":
                if str(sec.get("enable", "true")).lower() != "false":
                    return name, sec
                found = found or (name, sec)
        return found

    def _migrate_from_steelseries(self, engine):
        """Take over from a pre-release build of this extension installed as 'SteelSeries'.

        Its settings are carried over to the new names and its entries removed, so
        there is nothing left to uninstall.
        """
        cfg = engine.config_dict
        std = cfg.get("StdReport", {})
        old = std.get(OLD_NAME)
        old_service = "user.steelseries.SteelSeriesRealtime"
        services = cfg.get("Engine", {}).get("Services", {})
        archive = services.get("archive_services", [])
        archive = [archive] if isinstance(archive, str) else list(archive)
        if old_service not in archive:
            return False          # not the pre-release build (the 2017 extension had no service)

        engine.printer.out(f"Found the earlier '{OLD_NAME}' build of this extension; upgrading it:")
        if engine.dry_run:
            engine.printer.out("  (dry run: nothing changed)")
            return False

        if hasattr(old, "items"):
            # Copy the whole old report (HTML_ROOT, units, page options...) under the
            # new name; the folder names are then moved by _move_from_ss_folder().
            new = {k: (dict(v) if hasattr(v, "items") else v) for k, v in old.items() if k != OLD_NAME}
            if hasattr(old.get(OLD_NAME), "items"):
                new[REPORT] = dict(old[OLD_NAME])      # page options, e.g. face, sparklines
            std[REPORT] = new
            del std[OLD_NAME]
            engine.printer.out(f"  moved report [[{OLD_NAME}]] to [[{REPORT}]]")

        old_rt = cfg.get(OLD_NAME + "Realtime")
        if hasattr(old_rt, "items"):
            cfg[REPORT + "Realtime"] = dict(old_rt)
            del cfg[OLD_NAME + "Realtime"]
            engine.printer.out(f"  moved [{OLD_NAME}Realtime] to [{REPORT}Realtime]")

        services["archive_services"] = [s for s in archive if s != old_service]
        engine.printer.out(f"  removed service {old_service}")

        root = engine.root_dict
        for path in (os.path.join(root["USER_DIR"], "steelseries.py"),
                     os.path.join(root["EXT_DIR"], OLD_NAME)):
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            elif os.path.exists(path):
                os.remove(path)
        engine.printer.out(f"  removed bin/user/steelseries.py and the '{OLD_NAME}' extension record")
        return True

    def _move_from_ss_folder(self, engine):
        """Earlier builds used the folder 'ss'; move the report to 'CS'."""
        report = engine.config_dict.get("StdReport", {}).get(REPORT)
        if not hasattr(report, "get") or report.get("skin") != OLD_SKIN:
            return False
        engine.printer.out(f"Moving from the '{OLD_SKIN}' folder to '{SKIN}':")
        if engine.dry_run:
            engine.printer.out("  (dry run: nothing changed)")
            return False

        report["skin"] = SKIN
        engine.printer.out(f"  skin = {SKIN}")
        old_html = report.get("HTML_ROOT")
        if old_html and os.path.basename(os.path.normpath(old_html)) == OLD_SKIN:
            report["HTML_ROOT"] = os.path.join(os.path.dirname(os.path.normpath(old_html)), SKIN)
            engine.printer.out(f"  HTML_ROOT = {report['HTML_ROOT']}")
            old_out = os.path.join(engine.config_dict.get("WEEWX_ROOT", ""), old_html)
            if os.path.isdir(old_out):
                engine.printer.out(f"  This extension no longer writes to {old_out}; "
                                   f"its pages are now in {report['HTML_ROOT']}.")

        # Remove the old skin folder, but only if it is one of ours (the original
        # 2017 SteelSeries skin also lived in 'ss').
        old_skin = os.path.join(engine.root_dict["SKIN_DIR"], OLD_SKIN)
        try:
            with open(os.path.join(old_skin, "skin.conf"), encoding="utf-8") as f:
                text = f.read()
            ours = any(m in text for m in ("user.carbonsteelseries.", "user.steelseries.SteelSeries"))
        except OSError:
            ours = False
        if ours:
            shutil.rmtree(old_skin, ignore_errors=True)
            engine.printer.out(f"  removed the old skin folder {old_skin}")
        return True
