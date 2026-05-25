import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { router as telegramRouter, startPolling, processDeposit } from "./telegram";
import type {
  AnchorEvent,
  CustomerRecord,
  CustomerField,
  CustomerStatus,
  Transaction,
} from "./types";

const app = express();
const PORT = Number(process.env.PORT) || 8092;

app.use(express.json());
app.use("/telegram", telegramRouter);
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// In-memory KYC store
// ---------------------------------------------------------------------------
const customers = new Map<string, CustomerRecord>();

// ---------------------------------------------------------------------------
// POST /event
// La plataforma llama este endpoint cada vez que cambia el estado de una txn.
// ---------------------------------------------------------------------------
app.post("/event", async (req: Request, res: Response) => {
  const event = req.body as AnchorEvent;
  const { id, type, timestamp, payload } = event;
  const txn = payload?.transaction;

  console.log(`\n▶ Evento recibido`);
  console.log(`  id:        ${id}`);
  console.log(`  type:      ${type}`);
  console.log(`  timestamp: ${timestamp}`);

  if (txn) {
    console.log(`  txn.id:     ${txn.id}`);
    console.log(`  txn.status: ${txn.status}`);
    console.log(`  txn.kind:   ${txn.kind}`);
    console.log(`  txn.amount: ${txn.amount_expected?.amount} ${txn.amount_expected?.asset}`);
  }

  switch (type) {
    case "transaction_created":
      handleTransactionCreated(txn);
      break;
    case "transaction_status_changed":
      await handleStatusChanged(txn);
      break;
    case "quote_created":
      console.log("  → Cotización SEP-38 creada:", payload?.quote?.id);
      break;
    default:
      console.log(`  → Evento desconocido: ${type}`);
  }

  res.json({ status: 200, message: "event processed" });
});

function handleTransactionCreated(txn: Transaction | undefined): void {
  if (!txn) return;
  console.log(`  → Transacción ${txn.kind} creada. Esperando acción del usuario.`);
}

async function handleStatusChanged(txn: Transaction | undefined): Promise<void> {
  if (!txn) return;

  switch (txn.status) {
    case "pending_customer_info_needed":
      // El usuario necesita completar más datos KYC antes de continuar.
      // Aquí notificarías al usuario (email, push, etc.)
      console.log(`  → KYC incompleto para txn ${txn.id}. Notificar al usuario.`);
      break;

    case "pending_anchor":
      console.log(`  → Txn ${txn.id} lista para procesar.`);
      await processDeposit(txn.id);
      break;

    case "pending_stellar":
      console.log(`  → Txn ${txn.id} enviada a la red Stellar.`);
      break;

    case "completed":
      console.log(`  → ✓ Txn ${txn.id} completada.`);
      break;

    case "error":
      console.log(`  → ✗ Txn ${txn.id} falló: ${txn.message}`);
      break;

    default:
      console.log(`  → Estado: ${txn.status}`);
  }
}

// ---------------------------------------------------------------------------
// GET /customer   (SEP-12 Callback API)
// La plataforma consulta el estado KYC de un usuario.
// ---------------------------------------------------------------------------
app.get("/customer", (req: Request, res: Response) => {
  const { id, account } = req.query as Record<string, string | undefined>;
  const key = id ?? account;

  if (!key) {
    res.status(400).json({ error: "id o account requerido" });
    return;
  }

  const customer = customers.get(key);

  if (!customer) {
    res.json(needsInfoResponse());
    return;
  }

  const missingFields = getMissingFields(customer);
  if (missingFields) {
    res.json({ id: key, status: "NEEDS_INFO" as CustomerStatus, provided_fields: customer, fields: missingFields });
    return;
  }

  res.json({ id: key, status: "ACCEPTED" as CustomerStatus, provided_fields: customer });
});

function needsInfoResponse() {
  return {
    status: "NEEDS_INFO" as CustomerStatus,
    fields: {
      first_name:    { type: "string", description: "Nombre",   optional: false } as CustomerField,
      last_name:     { type: "string", description: "Apellido", optional: false } as CustomerField,
      email_address: { type: "string", description: "Email",    optional: false } as CustomerField,
    },
  };
}

function getMissingFields(customer: CustomerRecord): Record<string, CustomerField> | null {
  const missing: Record<string, CustomerField> = {};
  if (!customer.first_name)    missing.first_name    = { type: "string", description: "Nombre" };
  if (!customer.last_name)     missing.last_name     = { type: "string", description: "Apellido" };
  if (!customer.email_address) missing.email_address = { type: "string", description: "Email" };
  return Object.keys(missing).length > 0 ? missing : null;
}

// ---------------------------------------------------------------------------
// PUT /customer   (SEP-12 Callback API)
// La plataforma envía datos KYC que el usuario proporcionó.
// ---------------------------------------------------------------------------
app.put("/customer", async (req: Request, res: Response) => {
  const { id, account, transaction_id, ...fields } = req.body as {
    id?: string;
    account?: string;
    transaction_id?: string;
  } & CustomerRecord;
  const key = id ?? account;

  if (!key) {
    res.status(400).json({ error: "id o account requerido" });
    return;
  }

  const updated: CustomerRecord = { ...(customers.get(key) ?? {}), ...fields };
  customers.set(key, updated);
  console.log(`\n▶ KYC actualizado para ${key}:`, updated);

  if (transaction_id) {
    await advanceDepositAfterKyc(transaction_id);
  }

  res.json({ id: key });
});

// Avanza la txn usando RPC:
//   incomplete → request_offchain_funds → pending_external
//   pending_external → notify_offchain_funds_received → pending_anchor
// El evento pending_anchor activa processDeposit → do_stellar_payment → completed
async function advanceDepositAfterKyc(txnId: string): Promise<void> {
  const platformUrl = process.env.PLATFORM_API_BASE_URL ?? "http://localhost:8085";

  const txnRes = await fetch(`${platformUrl}/transactions/${txnId}`);
  const txn = await txnRes.json() as { amount_expected?: { amount: string; asset: string } };
  const asset  = txn.amount_expected?.asset   ?? "";
  const amount = txn.amount_expected?.amount  ?? "0";

  const rpc = async (method: string, params: Record<string, unknown>): Promise<boolean> => {
    const body = [{ jsonrpc: "2.0", method, id: crypto.randomUUID(), params }];
    const res  = await fetch(`${platformUrl}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json() as unknown;
    const item = (Array.isArray(json) ? json[0] : json) as { error?: { message?: string } };
    if (item.error) { console.error(`  ✗ RPC [${method}]:`, item.error.message); return false; }
    console.log(`  ✓ RPC [${method}] OK`);
    return true;
  };

  // deposit: amount_in = fiat que envía el usuario, amount_out = USDC que recibe on-chain
  const amountFields = {
    amount_in:   { amount, asset: "iso4217:USD" },
    amount_out:  { amount, asset },
    fee_details: { total: "0", asset: "iso4217:USD" },
  };

  const ok = await rpc("request_offchain_funds", { transaction_id: txnId, ...amountFields });
  if (!ok) return;
  await rpc("notify_offchain_funds_received", {
    transaction_id: txnId,
    message: "Fondos recibidos (demo)",
    ...amountFields,
  });
}

// ---------------------------------------------------------------------------
// DELETE /customer/:id   (SEP-12 Callback API)
// ---------------------------------------------------------------------------
app.delete("/customer/:id", (req: Request, res: Response) => {
  customers.delete(req.params.id);
  console.log(`\n▶ Customer eliminado: ${req.params.id}`);
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// GET /sep24/transaction/interactive   (SEP-24 Interactive UI)
// ---------------------------------------------------------------------------
app.get("/sep24/transaction/interactive", (req: Request, res: Response) => {
  const token = (req.query.token as string) ?? (req.headers.authorization ?? "");
  const txnId = req.query.transaction_id as string | undefined;

  res.send(`
    <html>
      <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 16px;text-align:center">
        <h2>Depositar USDC</h2>
        <p style="color:#555">Transacción: <code style="font-size:11px">${txnId ?? "—"}</code></p>
        <form id="form" style="margin-top:24px">
          <input name="first_name"    placeholder="Nombre"   required
            style="display:block;width:100%;padding:10px;margin:8px 0;box-sizing:border-box;border:1px solid #ccc;border-radius:6px">
          <input name="last_name"     placeholder="Apellido" required
            style="display:block;width:100%;padding:10px;margin:8px 0;box-sizing:border-box;border:1px solid #ccc;border-radius:6px">
          <input name="email_address" placeholder="Email"    required type="email"
            style="display:block;width:100%;padding:10px;margin:8px 0;box-sizing:border-box;border:1px solid #ccc;border-radius:6px">
          <button type="submit"
            style="margin-top:16px;width:100%;padding:12px;background:#6c47ff;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer">
            Confirmar depósito
          </button>
        </form>
        <p id="msg" style="margin-top:16px;color:#555"></p>
        <script>
          // Extraer account del JWT (campo sub) sin verificar firma
          function accountFromToken(t) {
            try { return JSON.parse(atob(t.split('.')[1])).sub ?? ""; }
            catch { return ""; }
          }
          const account = accountFromToken('${token}');

          document.getElementById('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.target));
            const msg = document.getElementById('msg');
            msg.textContent = 'Enviando...';
            const txnId = '${txnId ?? ""}';
            const res = await fetch('/customer', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...data, account, transaction_id: txnId })
            });
            if (res.ok) {
              msg.textContent = '✓ Datos enviados. Puedes cerrar esta ventana.';
              document.getElementById('form').style.display = 'none';
            } else {
              msg.textContent = 'Error al enviar. Intenta de nuevo.';
            }
          });
        </script>
      </body>
    </html>
  `);
});

// ---------------------------------------------------------------------------
// GET /sep24/transaction/more_info   (SEP-24 More Info)
// ---------------------------------------------------------------------------
app.get("/sep24/transaction/more_info", (req: Request, res: Response) => {
  const txId = (req.query.id as string) ?? "N/A";
  res.send(`
    <html>
      <body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center">
        <h2>Detalles de transacción</h2>
        <p>Transacción ID: <code>${txId}</code></p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Business Server escuchando en http://localhost:${PORT}`);
  console.log(`  POST /event                  ← eventos de la plataforma`);
  console.log(`  GET  /customer               ← consulta KYC`);
  console.log(`  PUT  /customer               ← actualiza KYC`);
  console.log(`  DELETE /customer/:id         ← elimina customer`);
  console.log(`  GET  /sep24/transaction/interactive`);
  console.log(`  POST /telegram/webhook       ← Telegram webhook (producción)`);

  // Si no hay webhook URL configurada, arranca en modo polling (local dev)
  if (!process.env.TELEGRAM_WEBHOOK_URL) {
    startPolling();
  }
});
