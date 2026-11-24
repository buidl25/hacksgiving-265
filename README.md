# hacksgiving-265 — the agent that can't overspend

Fly.io Hacksgiving submission: a spend-capable AI agent on a Sprite whose
every purchase must pass a **mandate gate** running byte-identical
production spend-enforcement code (vendored `mmf-255`, see
[gate/PROVENANCE.md](gate/PROVENANCE.md)).

```
agent (Sprite, label:agent)
  → POST /eval {vendor, amountUsd}          → ALLOW | DENY + reason
  → POST /execute {intentId}                → connector gateway → shop → receipt
gate+shop (Sprite, label:gate)
  → connector `custom_api` (access_policy: sprite_labels:["gate"])
  → /demo/shop/* requires the connector-held api_key (agent→shop = 401)
```

Why the agent cannot overspend: it holds no shop credential (401), and it
cannot call the connector itself (deny-by-default label policy → 403).
The only spend path is `eval → execute` inside the gate, where the
envelope check (`checkEnvelope`) decides from the persisted ledger.

## Layout

- `gate/server.ts` — Hono service: `/eval`, `/execute`, `/audit`, `/mandate`, `/healthz`
- `gate/shop.ts` — `/demo/shop/*`: catalog, purchase (intentId-deduped), receipts
- `gate/mandate.json` — the demo mandate: `dailyUsd: 100`, vendor allowlist
- `gate/vendor/` — byte-identical snapshot of `agentbadge@40eb49c` (mmf-255);
  `vendor-shasum.txt` pins all 68 files
- `gate/shims/` — build-time shims for workspace-package imports

## Run

```sh
cd gate && bun install
GATE_TOKEN=… SHOP_API_KEY=… bun server.ts   # :8080
bunx vitest run vendor/tests/conformance/mmf/   # 43 vectors
```
