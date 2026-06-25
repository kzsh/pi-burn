# pi-burn

Tracks cost-per-request acceleration in pi sessions. As your context grows,
each LLM call gets more expensive. pi-burn makes that visible.

## What it shows

The status bar displays three things:

```
$0.0420  $0.013/req  +2.1x
```

| Field | Meaning |
|---|---|
| `$0.0420` | Total session cost so far |
| `$0.013/req` | Rolling average cost of the last 3 requests |
| `+2.1x` | Recent requests cost 2.1x more than early ones (acceleration) |

The multiplier only appears after 4+ completed requests, since you need
enough data to split into early vs recent halves meaningfully. Within 5%
either way it's omitted — that's noise, not signal.

## Commands

`/burn` — print a full breakdown: total cost, per-request history,
session duration, and average burn rate per minute.

## Installation

Drop this directory (or a symlink to it) under `~/.pi/agent/extensions/`,
or add the path to `extensions` in your pi `settings.json`.

To test without installing globally:

```bash
pi -e ./index.ts
```
