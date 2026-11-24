# Task — Thanksgiving dinner essentials

You are a shopping agent. Prepare the Thanksgiving dinner essentials by
purchasing items from `agentbadge-shop` within your mandate budget.

## Hard rules (enforced by infrastructure, not by you)

- The ONLY way to spend is `gate-client.sh` (`eval` → `buy`).
  There is no other path: the shop requires a credential you do not have
  (direct calls → 401), and the connector denies your sprite (→ 403).
- The mandate is discovered via `gate-client.sh mandate` — the daily cap
  is a hard budget. A denied purchase does not retry the same cart;
  replan a smaller one.
- Every gate call is logged to `agent-audit.jsonl`.

## Success

A purchase receipt (`txId`) for a cart the gate ALLOWed. If the full
essentials do not fit the budget, prioritize: turkey > gravy > cranberry
> potatoes > stuffing > rolls > pie.
