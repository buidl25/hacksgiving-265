// demo/shop — the purchase target behind the custom connector.
// Reached ONLY through the connector gateway: the stored api_key is
// attached as `Authorization: Bearer <key>`; anything else → 401.
// So agent→shop direct = 401, agent→connector direct = policy DENY;
// the only spend path is agent → gate → connector → shop (D-265-2).
import { Hono } from "hono";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SHOP_API_KEY = process.env.SHOP_API_KEY ?? "";
const DATA_DIR = process.env.GATE_DATA_DIR ?? join(process.cwd(), ".data");
const DB = join(DATA_DIR, "shop.json");

interface Item { sku: string; name: string; priceUsd: number }
interface Receipt {
  txId: string; intentId: string; vendor: string;
  amountUsd: number; items: Item[]; balanceAfterUsd: number; ts: number;
}
interface Db { balanceUsd: number; receipts: Record<string, Receipt>; byIntent: Record<string, string> }

const CATALOG: Item[] = [
  { sku: "turkey", name: "Roast turkey 12lb", priceUsd: 80 },
  { sku: "potatoes", name: "Yukon gold potatoes 5lb", priceUsd: 12 },
  { sku: "cranberry", name: "Cranberry sauce x2", priceUsd: 9 },
  { sku: "stuffing", name: "Stuffing mix", priceUsd: 7 },
  { sku: "pie", name: "Pumpkin pie", priceUsd: 17 },
  { sku: "gravy", name: "Gravy kit", priceUsd: 6 },
  { sku: "rolls", name: "Dinner rolls x12", priceUsd: 8 },
];

const load = (): Db => {
  if (existsSync(DB)) { try { return JSON.parse(readFileSync(DB, "utf8")); } catch {} }
  return { balanceUsd: 500, receipts: {}, byIntent: {} }; // demo-credit float
};
const save = (d: Db) => { mkdirSync(dirname(DB), { recursive: true }); writeFileSync(DB, JSON.stringify(d)); };

export const shop = new Hono();

shop.use("*", async (c, next) => {
  if (c.req.header("authorization") !== `Bearer ${SHOP_API_KEY}` || !SHOP_API_KEY)
    return c.json({ error: "unauthorized" }, 401);
  return next();
});

shop.get("/catalog", (c) => c.json({ vendor: "agentbadge-shop", items: CATALOG }));
shop.get("/balance", (c) => c.json({ balanceUsd: load().balanceUsd, currency: "demo-credit" }));

shop.post("/purchase", async (c) => {
  const body = await c.req.json().catch(() => null) as
    { intentId?: string; amountUsd?: number; items?: Item[] } | null;
  if (!body?.intentId || !Number.isFinite(body?.amountUsd) || (body!.amountUsd as number) <= 0)
    return c.json({ error: "malformed_purchase" }, 400);

  const db = load();
  // settlement-level dedup (D-265-6): same intentId → same receipt,
  // no second debit. This is NOT mandate-layer replay protection.
  const prior = db.byIntent[body.intentId];
  if (prior) return c.json({ ...db.receipts[prior], duplicateSettlement: true });

  const amount = Math.round(body.amountUsd! * 100) / 100;
  const txId = `tx_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.balanceUsd = Math.round((db.balanceUsd - amount) * 100) / 100;
  const receipt: Receipt = {
    txId, intentId: body.intentId, vendor: "agentbadge-shop",
    amountUsd: amount, items: body.items ?? [],
    balanceAfterUsd: db.balanceUsd, ts: Date.now(),
  };
  db.receipts[txId] = receipt; db.byIntent[body.intentId] = txId; save(db);
  return c.json(receipt);
});

shop.get("/receipt/:txId", (c) => {
  const r = load().receipts[c.req.param("txId")];
  return r ? c.json(r) : c.json({ error: "not_found" }, 404);
});
