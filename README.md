# pi-usage-meter

A [Pi coding agent](https://pi.dev/) extension that shows a provider usage meter in the footer for **Z.ai** and **Kimi for Coding**.

The meter refreshes **every 60 seconds**, even when the agent is idle, so the countdown keeps ticking when you hit a quota and are waiting to send the next prompt.

## Example footer

```text
Z.ai: 5h 45% (2h 15m) · wk 12% (5d)
Kimi: 7d 6% (6d20h) · 5h 28% (1h40m)
```

The first value is the usage window label (`5h`/`wk` for Z.ai, `7d`/`5h` for Kimi), the percentage is how much of the quota is used, and the bracketed time is how long until that window resets.

## Supported providers

| Provider | Provider id(s) |
|----------|----------------|
| Z.ai | `zai`, `zai-coding-cn` |
| Kimi for Coding | `kimi-coding` |

## Install

From npm:

```bash
pi install npm:pi-usage-meter
```

From GitHub:

```bash
pi install git:github.com/rock3r/pi-usage-meter
```

From the checked-out repo:

```bash
cd c:\src\pi-usage-meter
pi install .
```

Or as a local path in your global Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "extensions": [
    "c:/src/pi-usage-meter"
  ]
}
```

If you still have `npm:@alexanderfortin/pi-zai-usage` installed, remove it first to avoid two Z.ai meters:

```bash
pi remove npm:@alexanderfortin/pi-zai-usage
```

## Usage

The meter appears automatically in the footer when a supported provider is active. It updates on:

- session start
- model change
- turn end
- a `setInterval` tick every **60 seconds**

Run `/usage` at any time to force a refresh.

## Auth

Auth is resolved through Pi itself (`ctx.modelRegistry.getApiKeyForProvider`), so it works with:

- Environment variables (`ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY`, `KIMI_API_KEY`)
- Stored credentials from `/login`
- `~/.pi/agent/auth.json` entries

For Z.ai, the extension calls `https://api.z.ai/api/monitor/usage/quota/limit`.
For Kimi, it calls `https://api.kimi.com/coding/v1/usages` (override with `KIMI_CODE_BASE_URL`).

## License

Licensed under the [Unenshittifiable License (UEL) v1.0](https://uelicense.eu). Use it, fork it, learn from it, self-host it, improve it — just don't turn the commons into a toll booth.
