# MMM-PikudHaoref

A [MagicMirror²](https://magicmirror.builders/) module that displays real-time rocket and emergency alerts from Israel's Home Front Command (Pikud HaOref). Features an interactive dark-themed Leaflet map with pulsing markers on alert cities and a shelter countdown overlay.

![MagicMirror Module](https://img.shields.io/badge/MagicMirror²-Module-blue)

## Features

- Real-time polling of the official Pikud HaOref alert API
- Dark-themed interactive map (CartoDB dark tiles via Leaflet)
- Pulsing red markers on cities under alert
- Shelter countdown timer overlay
- City-based filtering — monitor only your area or all of Israel
- Alert type detection: missiles, earthquakes, tsunamis, hostile aircraft, hazardous materials, terrorist infiltration
- Filters out non-actionable alerts (category 10 informational pre-warnings)
- Rotating file logger — safe for SD cards (~2MB max)
- Throttled logging to prevent PM2 log floods

## Screenshot

When idle, the module shows a dark map of Israel. During an alert, it zooms to the affected area with pulsing red markers and a countdown-to-shelter overlay.

## Installation

1. Navigate to your MagicMirror modules directory:
   ```bash
   cd ~/MagicMirror/modules
   ```

2. Clone this repository:
   ```bash
   git clone https://github.com/oriyaakov/MMM-PikudHaoref.git
   ```

3. No `npm install` needed — the module uses only built-in Node.js modules.

## Configuration

Add the module to your `config/config.js`:

```js
{
    module: "MMM-PikudHaoref",
    position: "bottom_right",
    config: {
        pollingInterval: 3000,
        shelterTime: 90,
        alertDuration: 120000,
        mapWidth: "300px",
        mapHeight: "400px",
        mapZoomNormal: 7.5,
        mapZoomAlert: 12,
        mapCenterNormal: [31.5, 34.8],
        mapCenterAlert: [32.0, 34.8],    // Set to your area coordinates
        cities: [
            "תל אביב",
            "רמת גן"
        ]
    }
}
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `pollingInterval` | How often to poll the API in milliseconds | `3000` |
| `shelterTime` | Seconds for the shelter countdown timer | `90` |
| `alertDuration` | How long to keep showing alert after API clears (ms) | `120000` |
| `mapWidth` | Map container width (CSS value) | `"350px"` |
| `mapHeight` | Map container height (CSS value) | `"350px"` |
| `mapZoomNormal` | Map zoom level when idle | `7.5` |
| `mapZoomAlert` | Map zoom level during alert | `12` |
| `mapCenterNormal` | Map center `[lat, lon]` when idle | `[31.5, 34.8]` |
| `mapCenterAlert` | Map center `[lat, lon]` during alert | `[31.5, 34.8]` |
| `cities` | Array of Hebrew city names to monitor. Empty `[]` = all cities. | `[]` |

### City Coordinates for Map Markers

To show markers on the map during alerts, add your monitored cities to the `cityCoords` object in `MMM-PikudHaoref.js`:

```js
cityCoords: {
    "תל אביב": [32.0853, 34.7818],
    "רמת גן": [32.0680, 34.8241],
    // Add more cities...
},
```

You can find city coordinates on Google Maps (right-click any location to copy coordinates).

## Alert Types

| Category ID | Type | Hebrew |
|-------------|------|--------|
| 1, 13 | Missiles | ירי רקטות וטילים |
| 2 | Radiological Event | אירוע רדיולוגי |
| 3 | Earthquake | רעידת אדמה |
| 4 | Tsunami | צונאמי |
| 5 | Hostile Aircraft | חדירת כלי טיס עוין |
| 6 | Hazardous Materials | חומרים מסוכנים |
| 7 | Terrorist Infiltration | חדירת מחבלים |
| 10 | Info (filtered out) | — |

## Logging

The module includes a rotating file logger that writes to `logs/pikudhaoref.log` inside the module directory. Log files rotate at 512KB with 3 rotated files kept (~2MB max total), making it safe for Raspberry Pi SD cards.

View logs:
```bash
tail -f ~/MagicMirror/modules/MMM-PikudHaoref/logs/pikudhaoref.log
```

## API Notes

- **Endpoint:** `https://www.oref.org.il/WarningMessages/alert/alerts.json`
- The API returns a BOM (U+FEFF) + CRLF for "no alerts" — the module handles this
- Sometimes returns 5 space characters instead — also handled
- Required headers: `Referer`, `X-Requested-With`, `Accept-Language: he`

## License

MIT
