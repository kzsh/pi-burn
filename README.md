# pi-burn

Tracks cost-per-request acceleration in pi sessions. As context grows, each
request gets more expensive. pi-burn makes that visible in real time.

## What it shows

The status bar updates after every completed request:

```
$0.013/req  ●cr:$0.001  ●in:$0.011  ●cw:$0.000  ●out:$0.001
```

| Field | Meaning |
|---|---|
| `$0.013/req` | Rolling average cost of the last 3 requests |
| `●cr` / `●in` / `●cw` / `●out` | Per-type cost breakdown (cache read, input, cache write, output) |

A two-row braille sparkline above the editor shows per-type cost history
across all requests in the session.

## Commands

`/burn` — open the burn details panel.

`/burn report` — print a full text breakdown: total cost, per-request
history, session duration, and average burn rate per minute.

## Flags

`--burn-budget <dollars>` — session spend limit used to scale the graph's
color from green to red. Defaults to `$10`.

## Installation

```bash
pi install npm:@kzsh/pi-burn
```

To try without installing:

```bash
pi -e npm:@kzsh/pi-burn
```
