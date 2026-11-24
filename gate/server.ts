// hacksgiving-265 gate — spend-intent → vendored mmf-255 envelope →
// verdict; ALLOW → custom-connector → receipt.
// Fail-closed at every stage (D-265-10): no verdict cache from the
// client, bounded body, vendor allowlist, no arbitrary URLs.
import { Hono } from "hono";
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  checkEnvelope,
  insertReserved,
  settleEntry,
  failEntry,
} from "./vendor/src/server/lib/agent-wallet/envelope";
import {
  createJsonSpendLedger,
  newSpendId,
  type SpendKind,
} from "./vendor/src/server/lib/agent-wallet/ledger";
import type { EnvelopeDeny } from "./vendor/src/server/lib/agent-wallet/envelope";
import { shop } from "./shop";

// Structurally identical to vendored SpendCaps (registry.ts) —
// re-declared here so server.ts pulls zero runtime imports beyond
// envelope/ledger (registry.ts needs viem at import time).
type SpendCaps = {
  perTxUsd?: number;
  dailyUsd?: number;
  weeklyUsd?: number;
  monthlyUsd?: number;
  maxTxPerHour?: number;
  maxAmountPerHour?: number;
  allowedKinds?: SpendKind[];
};

/* --------------------------------- config --------------------------------- */

const GATE_TOKEN = process.env.GATE_TOKEN ?? "";
const CONN_ID = process.env.CONNECTOR_ID ?? "hS_fQRynTjwAfTNAt5z4lg";
const GATEWAY = `https://api.sprites.dev/v1/gateway/custom_api/${CONN_ID}`;
const SHOP_PATH = process.env.SHOP_PATH ?? "/demo/shop/purchase";
const DATA_DIR = process.env.GATE_DATA_DIR ?? join(process.cwd(), ".data");
const BODY_CAP = 16 * 1024;
const EXEC_TIMEOUT_MS = 15_000;

interface Mandate {
  mandateId: string;
  subject: `0x${string}`;
  caps: SpendCaps;
  allowedVendors: string[];
}
const mandate: Mandate = JSON.parse(
  readFileSync(join(process.cwd(), "mandate.json"), "utf8"),
);

const ledger = createJsonSpendLedger(join(DATA_DIR, "spend-ledger.json"));
const auditFile = join(DATA_DIR, "intents.jsonl");
mkdirSync(DATA_DIR, { recursive: true });

/* --------------------------------- intents -------------------------------- */

interface IntentRec {
  intentId: string;
  wallet: `0x${string}`;
  vendor: string;
  amountUsd: number;
  items?: unknown[];
  verdict: "ALLOW" | "DENY";
  reason?: string;
  deny?: EnvelopeDeny;
  entryId?: string;
  receipt?: unknown;
  state: "AUTHORIZED" | "DENIED" | "EXECUTED" | "FAILED";
  ts: number;
}
const intents = new Map<string, IntentRec>();
const audit = (r: IntentRec) =>
  appendFileSync(auditFile, JSON.stringify(r) + "\n");

const DENY_REASON: Record<EnvelopeDeny["cap"], string> = {
  perTx: "PER_TX_CAP_EXCEEDED",
  velocity_tx: "VELOCITY_TX_PER_HOUR_EXCEEDED",
  velocity_amount: "VELOCITY_AMOUNT_PER_HOUR_EXCEEDED",
  daily: "DAILY_CAP_EXCEEDED",
  weekly: "WEEKLY_CAP_EXCEEDED",
  monthly: "MONTHLY_CAP_EXCEEDED",
};

const denyEval = (
  wallet: `0x${string}`,
  vendor: string,
  amountUsd: number,
  reason: string,
  deny?: EnvelopeDeny,
) => {
  const rec: IntentRec = {
    intentId: `int_${newSpendId().slice(3)}`,
    wallet, vendor, amountUsd,
    verdict: "DENY", reason, deny, state: "DENIED", ts: Date.now(),
  };
  intents.set(rec.intentId, rec);
  audit(rec);
  return rec;
};

/* --------------------------------- service -------------------------------- */

const app = new Hono();

app.get("/healthz", (c) =>
  c.json({ ok: true, gate: "mmf-255", provenance: "40eb49c1037fb974c2a61dc49153be8278b0020f" }));

app.route("/demo/shop", shop); // own Bearer-key auth (connector api_key)

app.use("*", async (c, next) => {
  if (c.req.path === "/healthz" || c.req.path.startsWith("/demo/shop"))
    return next();
  if (c.req.header("authorization") !== `Bearer ${GATE_TOKEN}` || !GATE_TOKEN)
    return c.json({ error: "UNAUTHORIZED" }, 401);
  return next();
});

app.get("/mandate", (c) => c.json(mandate));
app.get("/audit", async (c) =>
  c.json({ intents: [...intents.values()], ledger: await ledger.listByWallet(mandate.subject) }));

app.post("/eval", async (c) => {
  const raw = await c.req.text();
  if (raw.length > BODY_CAP) return c.json(denyEval(mandate.subject, "?", 0, "REQUEST_TOO_LARGE"), 413);
  let body: { intent?: { vendor?: unknown; amountUsd?: unknown; items?: unknown[] } };
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json(denyEval(mandate.subject, "?", 0, "MALFORMED_REQUEST"), 400);
  }
  const intent = body?.intent;
  const vendor = typeof intent?.vendor === "string" ? intent.vendor : "";
  const amountUsd = Number(intent?.amountUsd);
  if (!vendor || !Number.isFinite(amountUsd) || amountUsd <= 0)
    return c.json(denyEval(mandate.subject, vendor, amountUsd || 0, "MALFORMED_REQUEST"), 400);
  if (!mandate.allowedVendors.includes(vendor))
    return c.json(denyEval(mandate.subject, vendor, amountUsd, "UNKNOWN_VENDOR"));

  // REAL gate eval — vendored mmf-255 checkEnvelope, byte-identical.
  const v = await checkEnvelope(ledger, mandate.caps, mandate.subject, amountUsd);
  if (!v.allow)
    return c.json(denyEval(mandate.subject, vendor, amountUsd, DENY_REASON[v.deny.cap], v.deny));

  const rec: IntentRec = {
    intentId: `int_${newSpendId().slice(3)}`,
    wallet: mandate.subject, vendor, amountUsd, items: intent?.items,
    verdict: "ALLOW", state: "AUTHORIZED", ts: Date.now(),
  };
  intents.set(rec.intentId, rec);
  audit(rec);
  return c.json(rec);
});

app.post("/execute", async (c) => {
  let body: { intentId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ executed: false, error: "MALFORMED_REQUEST" }, 400);
  }
  const rec = body.intentId ? intents.get(body.intentId) : undefined;
  if (!rec) return c.json({ executed: false, error: "UNKNOWN_INTENT" }, 404);
  if (rec.verdict !== "ALLOW" || rec.state === "DENIED")
    return c.json({ executed: false, error: "INTENT_NOT_AUTHORIZED", verdict: rec.verdict }, 403);
  if (rec.receipt) // settlement-level dedup: one intent executes once
    return c.json({ executed: true, duplicate: true, receipt: rec.receipt, state: rec.state });

  // reserve cap space (check-then-hold, real envelope.reserve path)
  const res = await checkEnvelope(ledger, mandate.caps, rec.wallet, rec.amountUsd);
  if (!res.allow) {
    rec.verdict = "DENY"; rec.reason = DENY_REASON[res.deny.cap]; rec.deny = res.deny;
    rec.state = "DENIED"; audit(rec);
    return c.json({ executed: false, verdict: "DENY", reason: rec.reason, deny: res.deny });
  }
  const entry = await insertReserved(ledger, rec.wallet, rec.amountUsd, "buy-gateway", rec.intentId);
  rec.entryId = entry.id;
  rec.state = "EXECUTED"; audit(rec); // AUTHORIZED → EXECUTED (pre-settlement)

  try {
    const resp = await fetch(`${GATEWAY}${SHOP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: rec.intentId, vendor: rec.vendor, amountUsd: rec.amountUsd, items: rec.items ?? [] }),
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    });
    const receipt = (await resp.json().catch(() => null)) as { txId?: string } | null;
    if (!resp.ok || !receipt?.txId) {
      await failEntry(ledger, entry.id);
      rec.state = "FAILED"; audit(rec);
      return c.json({ executed: false, error: "CONNECTOR_ERROR", status: resp.status, body: receipt });
    }
    await settleEntry(ledger, entry.id, receipt.txId as `0x${string}`);
    rec.receipt = receipt; rec.state = "EXECUTED"; audit(rec); // → RECEIPTED
    return c.json({ executed: true, receipt, state: "RECEIPTED", entryId: entry.id });
  } catch (err) {
    await failEntry(ledger, entry.id);
    rec.state = "FAILED"; audit(rec);
    return c.json({ executed: false, error: "CONNECTOR_UNREACHABLE", detail: String(err) });
  }
});

export default { port: Number(process.env.PORT ?? 8080), fetch: app.fetch };
