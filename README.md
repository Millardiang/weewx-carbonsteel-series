# weewx-carbonsteel-series

Live weather gauges for **WeeWX 5** and **Python 3.13**, with chrome and carbon-fibre looks inspired by the original SteelSeries gauges.

It started as a modernisation of the 2017 weewx-steelseries extension, which packaged Mark Crossley's canvas-based SteelSeries Weather Gauges, and is now a complete rewrite: sharp vector gauges drawn with D3, a live feed written on every LOOP packet, history charts and a year-at-a-glance calendar.

## Demos

- Standalone https://steepleclaydonweather.uk/CS/
- New-Belchertown https://steepleclaydonweather.uk/new-belchertown/carbonsteel/
- Seasons https://steepleclaydonweather.uk/seasons/carbonsteel-gauges.html
- DivumWX https://steepleclaydonweather.uk/gauges.html

## What you get

- **12 gauges**: temperature (outside/inside), dew point / feels like / wind chill / heat index / humidex, humidity, pressure with 3-hour tendency, wind speed with 10-minute average and gust markers, wind direction with average pointer and 10-minute variation arc, today's wind rose, rain today (plus last hour, month and year), rain rate, UV, solar radiation and cloud base. Gauges for sensors your station doesn't have hide themselves.
- **Today's range** shaded on every dial, with high/low markers (hover for the time). Highs and lows come from WeeWX's daily summaries, so they survive restarts.
- **Sparklines** under each gauge; click one for a 24-hour chart with crosshair read-out.
- **Year at a glance**: a GitHub-style calendar heat-map of daily max/mean/min temperature, rain, max gust, humidity, UV and solar.
- **Header** in the style of the original SteelSeries page: station latitude, longitude and elevation; a status LED (green when LOOP data is flowing, amber when the station goes quiet, red when `realtime.json` can't be fetched); a scrolling **outlook ticker** from [Open-Meteo](https://open-meteo.com); and a counter of seconds since the last update. Polling pauses in background tabs.
- **A page for the Seasons skin** (optional): the same live gauges on a page inside your Seasons site, with the Seasons title bar, fonts and styling.
- **A page for the [Belchertown-new](https://github.com/uajqq/weewx-belchertown-new) skin** (optional): the gauges as Belchertown-style cards inside your Belchertown site, with its header, menu, footer and light/dark switch.
- Works offline on a LAN: D3 and the Lexend read-out font are bundled, no CDNs. Only the optional outlook ticker needs internet access.

## Requirements

- WeeWX 5.0 or later (tested on 5.5.2), any install method (pip, Debian/RPM, git).
- Python 3.9+ (tested on 3.13.7).
- A web server serving your WeeWX `HTML_ROOT` (the gauges page fetches JSON, so opening it with `file://` won't work).

## Install

```bash
# download the release zip, then:
weectl extension install weewx-carbonsteel-series-v1.0.0.zip
sudo systemctl restart weewx
```

During installation you're asked up to four questions (press Enter to accept the default shown):

```
Display sparklines (24-hour mini charts under each gauge) (y/n) [y]?
Display the 'Year at a glance' calendar (y/n) [y]?
Add a live gauges page to the Seasons skin (carbonsteel-gauges.html) (y/n) [y]?
Add a live gauges page to the Belchertown-new skin (carbonsteel/) (y/n) [y]?
```

The Seasons question defaults to yes only if your station runs a Seasons report; the Belchertown question is only asked if Belchertown-new is installed. To install without prompts, give the answers on the command line: `weectl extension install weewx-carbonsteel-series-v1.0.0.zip --yes --sparklines=n --calendar=y --seasons=y --belchertown=y`. On a reinstall with `--yes`, your earlier answers are kept. You can change them later with the `sparklines` and `calendar` options below, and the `enable` setting of `[[CarbonSteelSeriesSeasons]]`.

The installer:

1. copies `user/carbonsteelseries.py`, the `CS` skin and the `CS-Seasons` skin,
2. adds `user.carbonsteelseries.CarbonSteelSeriesRealtime` to `archive_services`,
3. adds a `[[CarbonSteelSeries]]` report writing to `HTML_ROOT/CS` (for example `~/weewx-data/public_html/CS` or `/var/www/html/weewx/CS`),
4. adds a `[CarbonSteelSeriesRealtime]` section,
5. adds a `[[CarbonSteelSeriesSeasons]]` report writing `carbonsteel-gauges.html` into your Seasons report's folder (enabled if you answered yes),
6. if you chose the Belchertown page: adds `carbonsteel/index.html.tmpl` to the Belchertown skin, and two entries to its `[[new-belchertown]]` report (see below).

`realtime.json` appears within seconds of the restart; `index.html`, `history.json` and `calendar.json` after the first archive interval. Then browse to `http://your-server/weewx/CS/`.

Uninstall with `weectl extension uninstall CarbonSteelSeries`. This removes the extension's files and the settings it added to `weewx.conf`; as with any WeeWX extension, options you added by hand are left in place.

## Configuration

### Realtime service — `weewx.conf`

```ini
[CarbonSteelSeriesRealtime]
    enable = true
    json_file = realtime.json   # relative to the CarbonSteelSeries report's HTML_ROOT, or absolute
    min_interval = 0            # minimum seconds between writes (0 = every LOOP packet)
    wind_avg_period = 600       # window for average wind, gust and direction range
    stale_age = 900             # drop values a partial-packet station hasn't refreshed
    data_binding = wx_binding
```

On an SD-card Raspberry Pi with a 2-second LOOP, consider `min_interval = 5`, or point `json_file` at a tmpfs such as `/run/weewx/realtime.json` and serve that path from your web server.

### Units

The gauges use your station's report units (`unit_system` in `[StdReport] [[Defaults]]`). To give the gauges different units from your other reports:

```ini
[StdReport]
    [[CarbonSteelSeries]]
        [[[Units]]]
            [[[[Groups]]]]
                group_speed = km_per_hour
                group_pressure = hPa
```

Visitors can also switch temperature, pressure, wind, rain and altitude units from the settings button; their choice is stored in their browser.

### Page options

Set these either in `skins/CS/skin.conf` under `[CarbonSteelSeries]`, or (better, since it survives upgrades) in `weewx.conf` in a `[[[CarbonSteelSeries]]]` sub-section of the report:

```ini
[StdReport]
    [[CarbonSteelSeries]]
        skin = CS
        [[[CarbonSteelSeries]]]
            face = auto
            bezel = auto
            forecast_days = 5
```

Restart WeeWX after editing `weewx.conf`; the page picks up the change at the next report cycle (or run `weectl report run CarbonSteelSeries`).

Visitors can also switch the gauge face and bezel from the two buttons in the header; the options below only set the default.

| Option | Default | Meaning |
|---|---|---|
| `title` | station location | Page heading |
| `realtime_url` | `realtime.json` | Where the page fetches live data |
| `poll_interval` | `2.5` | Seconds between fetches |
| `face` | `auto` | Default gauge face: `auto` (beige on the light theme, carbon fibre on the dark theme), `beige`, `white`, `anthracite` or `carbon` |
| `bezel` | `auto` | Default bezel: `auto` (chrome on the light theme, black metal on the dark theme), `chrome` or `black` |
| `forecast` | `open-meteo` | Header ticker outlook: `open-meteo` or `none` |
| `forecast_days` | `3` | Days in the outlook (1–7) |
| `sparklines` | `true` | Show the 24-hour sparkline under each gauge (click for a detail chart) |
| `calendar` | `true` | Show the "Year at a glance" calendar |
| `stale_after` | `120` | Seconds before the status turns amber |
| `gauges` | all | Which gauges, in order: `temp, dew, hum, baro, wind, dir, rose, rain, rainrate, uv, solar, cloudbase` |
| `history_hours` | `24` | Hours in sparklines and detail charts |
| `calendar_days` | `366` | Days in the calendar heat-map |
| `[[ranges]]` | per unit | Default dial scales; a dial widens automatically when today's values exceed it |

### Gauges page for the Seasons skin

If you answered yes to the Seasons question, WeeWX also writes `carbonsteel-gauges.html` into the same folder as the Seasons pages, for example `http://your-server/weewx/carbonsteel-gauges.html`. It is a Seasons-style page, with the Seasons title bar (station name, update time, RSS link and NOAA report pickers), the Seasons stylesheet, font and widget titles, and a "Current Conditions" link back to the Seasons front page, laid out around the same live gauges as the `CS` page.

![Seasons gauges page](docs/screenshot-seasons.png)

- **It adds one file** to the Seasons folder, plus the title-bar button described below. Its scripts, styles and data come from the `CS` folder, so the two pages always show the same thing.
- **Settings are shared**: it uses the page options of the main `[[CarbonSteelSeries]]` report (face, bezel, sparklines, calendar, gauges...). To make the Seasons page differ, add options to its own report:

  ```ini
  [StdReport]
      [[CarbonSteelSeriesSeasons]]
          [[[CarbonSteelSeries]]]
              gauges = temp, hum, baro, wind, rain
  ```
- **Language**: the title bar, report pickers, back link and footer use the Seasons skin's own wording, so they follow the language your Seasons report uses. The gauge labels are in English.
- **Seasons look and units, no CarbonSteel header**: Seasons has its own title bar, so the page leaves out the CarbonSteel header: no outlook ticker, update counter, or face, bezel and units switches. Like Seasons it is always light (chrome bezel and beige face, unless you set `face` or `bezel` for the CS page), and it shows the units of your Seasons report, as set in `weewx.conf` or the Seasons `skin.conf`, so the gauges agree with the Seasons pages beside them.
- **A "Live Gauges" button in the Seasons title bar**, next to RSS, so visitors find the page from every Seasons page. See [Header buttons](#header-buttons) below.

### Gauges page for Belchertown-new

If Belchertown-new is installed and you answered yes, Belchertown gains a page at `…/<your Belchertown site>/carbonsteel/`, generated by the Belchertown report itself, just like its About and Records pages. So it has Belchertown's own header, menu, theme switch and footer, and the gauges sit in cards styled like the cards on the Belchertown front page. They follow Belchertown's light/dark mode as you switch it: chrome bezel and beige face in light mode, black bezel and carbon fibre in dark mode.

Belchertown has its own header and its own switches, so the page leaves out the CarbonSteel header: no outlook ticker (Belchertown has its own forecast), update counter, or face, bezel and units switches. The gauges use Belchertown's units: those of your `[[new-belchertown]]` report, or, if you've turned on Belchertown's unit switcher (`unit_switching = 1` under `[[[Extras]]]`), whichever system the visitor picks there. They change straight away when the visitor switches. Choices a visitor makes on the CS page don't carry over to either page.

**Live data over MQTT.** If your Belchertown site shows live updates over MQTT (`mqtt_websockets_enabled = 1` and its `mqtt_websockets_host`, `_port`, `_ssl`, `_topic`, `_username` and `_password` settings under `[[[Extras]]]`), the gauges page uses the same broker and topic. Each reading reaches the gauges the moment WeeWX publishes it, just as on Belchertown's front page. MQTT packets only carry the current readings, so `realtime.json` still supplies the rest: today's highs and lows, the 10-minute wind average, gust and wind rose, rain for the last hour, month and year, and the pressure trend. While MQTT is live, the page reads `realtime.json` once a minute instead of every few seconds. If the broker can't be reached or stops sending, the page goes straight back to `realtime.json` for everything and reconnects to the broker in the background. Without MQTT, nothing changes: `realtime.json` is the live source.

- The packets are those of the [weewx-mqtt](https://github.com/matthewwall/weewx-mqtt) uploader that Belchertown uses, with or without unit labels (`outTemp_C`, `windSpeed_kph`, `dayRain_cm` and so on). Any unit system works; the gauges convert to Belchertown's units.
- If `realtime.json` isn't reachable from the web server at all, the gauges still run from MQTT alone, with the day's highs and lows counted from when the page was opened, and dashes for the figures only `realtime.json` has.
- The MQTT library (Paho) is loaded from the same CDN as on Belchertown's own pages, and only when MQTT is turned on. Like Belchertown, the page lets go of the broker while its tab is in the background.

![Belchertown gauges page](docs/screenshot-belchertown.png)

![Belchertown gauges page, dark mode](docs/screenshot-belchertown-dark.png)

What the installer adds, and nothing else:

- the page template `skins/new-belchertown/carbonsteel/index.html.tmpl` (a new folder),
- a "Live Gauges" item in the Belchertown menu (see [Header buttons](#header-buttons)),
- two entries in your `[[new-belchertown]]` report in `weewx.conf`:

  ```ini
  [[new-belchertown]]
      [[[Extras]]]
          carbonsteel_url = ../CS/        # where the page finds the CS folder, from the Belchertown site root
      [[[CheetahGenerator]]]
          [[[[ToDate]]]]
              [[[[[carbonsteel]]]]]
                  template = carbonsteel/index.html.tmpl
  ```

The installer works out `carbonsteel_url` from your actual folders. If your web server maps folders differently (for example the CS pages live on another path or host), set it to the right relative path or a full URL. Both entries survive a Belchertown-new upgrade, and uninstalling this extension (or re-running the installer and answering no) removes them and the template again. The page uses the same options as the main `CS` page. You can also set `carbonsteel_title` under `[[[Extras]]]` to change its heading (default "Live Gauges").

**The CarbonSteelSeries report must run.** The Seasons and Belchertown pages load their scripts, styles and data from the `CS` folder, and only the `[[CarbonSteelSeries]]` report keeps that folder up to date. Leave it enabled even if you only link to the Seasons or Belchertown page. If it's switched off or failing, the realtime service still updates `realtime.json`, but the scripts and styles in the `CS` folder stay on whatever version was there before. After an upgrade, those pages then show **"Live gauges unavailable"** instead of the gauges. The installer warns if the report is switched off. If you see that notice, check the WeeWX log for errors from the CarbonSteelSeries report, and open the address the notice links to: it should be the folder that report writes. The pages ask for the gauge files by the date of the installed copy, so browsers and caches such as Cloudflare pick up new files straight after an upgrade.

### Header buttons

Casual visitors won't find a page that nothing links to, so when you add the Seasons or Belchertown page the installer also puts a link in that skin's header:

![Live Gauges button in the Seasons title bar and the Belchertown menu](docs/screenshot-header-buttons.png)

- **Seasons**: a "Live Gauges" button beside the RSS button, added to `skins/Seasons/titlebar.inc`. Seasons uses that file on every page, so the button appears everywhere.
- **Belchertown-new**: a "Live Gauges" item at the end of the menu (and in the mobile menu), added to `skins/new-belchertown/nav-menu-custom.inc`, the file Belchertown provides for your own menu items. If you don't have one yet, the installer creates it from `nav-menu-custom.inc.example`. The item is highlighted while you're on the gauges page and uses `carbonsteel_title` if you set it.

Neither skin has a place an extension can add a link without editing a file, so these are the only changes made to another skin's files, and they are kept small and easy to spot:

- Each addition sits between two comment lines, `## weewx-carbonsteel-series: start` and `## weewx-carbonsteel-series: end`. Cheetah comments never reach the web page. Everything else in the file is left exactly as it was, and you can move the block if you want the button elsewhere.
- Each is guarded: it only shows while its page is installed. So after uninstalling this extension, the button disappears from the pages on the next report run even though the lines are still in the file.
- Re-running the installer and answering no removes the block again (and removes `nav-menu-custom.inc` too, if the installer created it and you haven't changed it since). Running the installer again doesn't add a second copy.
- A WeeWX upgrade may replace Seasons' `titlebar.inc`, and with it the button. Re-run the installer afterwards to put it back. Belchertown's upgrades don't touch `nav-menu-custom.inc`.

### Serving from a remote web server

Upload the `CS` folder with the WeeWX Rsync or FTP report as usual. Those run once per archive interval, so for a truly live page on a remote host either have your web server proxy `realtime.json` from the WeeWX machine, or sync that one file on a short loop (for example a systemd timer running `rsync` every few seconds).

### Outlook ticker

The outlook comes from Open-Meteo's free forecast API: no key or sign-up, and it is fetched by each visitor's browser (refreshed every 30 minutes), so nothing extra runs on the WeeWX machine. It uses `latitude` and `longitude` from the `[Station]` section of `weewx.conf`, and the units the visitor has chosen. The ticker is on the CS page only; the Seasons and Belchertown pages leave it out. Open-Meteo's free tier is for non-commercial use (CC BY 4.0, credited in the ticker). Set `forecast = none` to turn it off.

## `realtime.json`

```jsonc
{
  "schema": 1,
  "dateTime": 1790629396,          // LOOP packet time (epoch s)
  "archiveInterval": 300,
  "station": {"location": "…", "latitude": 51.5, "longitude": -0.1, "hardware": "Vantage"},
  "units":   {"group_temperature": {"unit": "degree_C", "label": "°C", "dp": 1}, …},
  "obsGroups": {"outTemp": "group_temperature", …},
  "current": {"outTemp": 14.62, "windSpeed": 3.1, "barometer": 1013.4, …},
  "day":     {"outTemp": {"min": 8.1, "mintime": …, "max": 17.9, "maxtime": …}, …},
  "rain":    {"day": 1.2, "lastHour": 0.0, "last24h": 3.4, "month": 45.8, "year": 612.0},
  "wind":    {"avg": 2.8, "gust": 6.2, "avgDir": 238, "dirFrom": 210, "dirTo": 265,
              "period": 600, "rose": [0.01, …16 fractions…]},
  "baroTrend": {"change": -1.4, "text": "Falling slowly"}
}
```

Values are already in the report's units. The file is written atomically (temp file + rename), so a reader never sees half a file. It's plain JSON, so other dashboards, Home Assistant or Node-RED can use it too.

## Running alongside the original SteelSeries gauges

This extension is independent of the original SteelSeries Weather Gauges skin (the 2017 weewx-steelseries extension, or a manual install from Mark Crossley's repository), and the two can be installed on the same station. They share nothing:

| | This extension | Original SteelSeries gauges |
|---|---|---|
| Report in `weewx.conf` | `[[CarbonSteelSeries]]` | `[[SteelSeries]]` |
| Skin folder | `skins/CS` | `skins/ss` |
| Web pages | `…/CS/` | `…/ss/` |
| Live data | `realtime.json`, written by its own service | `gauge-data.txt`, written each report cycle |
| Visitor settings | browser storage, `cs.` prefix | cookies |

Installing, upgrading or uninstalling this extension never reads, changes or removes the original's files or settings.

## Upgrading from a pre-release build

If you tried a pre-release build of this project (installed as `SteelSeries` with a `user.steelseries.SteelSeriesRealtime` service, or an early v1.0.0 that used the `ss` folder), install v1.0.0 over it without uninstalling anything first. The installer recognises the earlier build by its service and skin, and moves its settings across: `[[SteelSeries]]` becomes `[[CarbonSteelSeries]]` (with your page options and units), `[SteelSeriesRealtime]` becomes `[CarbonSteelSeriesRealtime]`, and the folder moves from `ss` to `CS`. It removes the earlier build's service, `bin/user/steelseries.py`, and its `skins/ss` folder, after checking that folder's `skin.conf` belongs to this project. The original SteelSeries skin is never mistaken for it. The page address changes from `…/ss/` to `…/CS/`, and the earlier build's page folder is left in place; it stops updating.

## Development

```bash
pip install weewx pytest
python -m pytest tests/
```

To try it end-to-end, create a simulator station (`weectl station create --driver=weewx.drivers.simulator`), install from the repository folder with `weectl extension install .`, and run `weewxd`.

## Credits and licence

GNU General Public License v3 or later (see `LICENSE`). Inspired by the original SteelSeries gauges by Gerrit Grunwald, the SteelSeries Weather Gauges scripts by Mark Crossley, and the original weewx-steelseries packaging by Gary Roderick and Matthew Wall; this project contains none of their code. The Belchertown page is built to fit [Belchertown-new](https://github.com/uajqq/weewx-belchertown-new) by uajqq (after Pat O'Brien's Belchertown); it uses that skin's own header and footer when Belchertown generates it, and copies none of its code. Bundles [D3](https://d3js.org) v7.9.0 (ISC licence, `skins/CS/js/d3.LICENSE.txt`) and the [Lexend](https://www.lexend.com) font used for the gauge read-outs (SIL Open Font Licence 1.1, `skins/CS/fonts/Lexend-OFL.txt`).
