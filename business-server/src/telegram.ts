import { Router, Request, Response } from "express";
import * as jwt from "jsonwebtoken";
import {
  Horizon,
  Keypair,
  Asset,
  TransactionBuilder,
  Operation,
  Networks,
  BASE_FEE,
} from "@stellar/stellar-sdk";

const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TOKEN           = process.env.TELEGRAM_BOT_TOKEN         ?? "";
const SEP10_SECRET    = process.env.SECRET_SEP10_JWT_SECRET    ?? "secret_sep10_secret_secret_sep10_secret";
const ANCHOR_URL      = process.env.ANCHOR_SEP24_URL           ?? "http://localhost:8080";
const TEST_ACCOUNT    = process.env.STELLAR_TEST_ACCOUNT       ?? "GCKFBEIYV2U22IO2BJ4KVJOIP7XPWQGQFKKWXR6DOSJBV7STMAQSMTG";
const PUBLIC_BASE_URL = process.env.SEP24_PUBLIC_URL?.replace(/\/$/, "") ?? "";
const ASSET_CODE      = "USDC";
const ASSET_ISSUER    = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const API = `https://api.telegram.org/bot${TOKEN}`;

// ---------------------------------------------------------------------------
// Pending deposits: txnId → { chatId, amount }
// server.ts lo lee para saber a quién notificar cuando llega pending_anchor
// ---------------------------------------------------------------------------
export const pendingDeposits = new Map<string, { chatId: number; amount: string }>();

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------
async function sendMessage(chatId: number, text: string): Promise<void> {
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function sendHtmlMessage(
  chatId: number,
  html: string,
  inlineKeyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>,
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
  };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };

  const res = await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("  ✗ Telegram sendMessage error:", await res.text());
}


// ---------------------------------------------------------------------------
// Notifica al usuario cuando pending_anchor llega (llamado desde server.ts)
// ---------------------------------------------------------------------------
export async function processDeposit(txnId: string): Promise<void> {
  const pending = pendingDeposits.get(txnId);
  const PLATFORM_URL = process.env.PLATFORM_API_BASE_URL ?? "http://localhost:8085";

  if (pending) {
    await sendMessage(pending.chatId, `Procesando deposito de ${pending.amount} USDC...`);
  }

  // Obtener detalles de la transacción
  const txnRes = await fetch(`${PLATFORM_URL}/transactions/${txnId}`);
  const txnData = await txnRes.json() as {
    destination_account: string;
    amount_out?: { amount: string; asset: string };
  };

  const destination = txnData.destination_account;
  const amount      = txnData.amount_out?.amount ?? pending?.amount ?? "0";
  const assetStr    = txnData.amount_out?.asset  ?? `stellar:${ASSET_CODE}:${ASSET_ISSUER}`;

  // Someter el pago Stellar desde la cuenta de distribución
  let txHash: string;
  try {
    txHash = await submitStellarPayment(destination, amount, assetStr);
    console.log(`  ✓ Stellar payment: ${txHash}`);
  } catch (err) {
    console.error("  ✗ Error al someter pago Stellar:", err);
    if (pending) await sendMessage(pending.chatId, "Error al enviar USDC on-chain.");
    return;
  }

  // Notificar al Platform que el pago on-chain fue enviado
  const ok = await platformRpc(PLATFORM_URL, "notify_onchain_funds_sent", {
    transaction_id:         txnId,
    stellar_transaction_id: txHash,
  });

  if (pending) {
    if (ok) {
      await sendMessage(
        pending.chatId,
        `✓ Deposito completado!\n<code>${txHash}</code>`,
      );
    } else {
      await sendMessage(pending.chatId, "Pago enviado pero error al notificar al Platform.");
    }
    pendingDeposits.delete(txnId);
  }
}

async function submitStellarPayment(
  destination: string,
  amount: string,
  assetStr: string,
): Promise<string> {
  const secret  = process.env.DISTRIBUTION_SECRET_KEY!;
  const keypair = Keypair.fromSecret(secret);

  // assetStr = "stellar:USDC:GBBD47..."
  const [, code, issuer] = assetStr.split(":");
  const asset = new Asset(code, issuer);

  const source = await horizon.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination, asset, amount }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const result = await horizon.submitTransaction(tx);
  return result.hash;
}

// ---------------------------------------------------------------------------
// Conversation state per chat_id
// ---------------------------------------------------------------------------
type ConvState = "idle" | "awaiting_amount";
const sessions = new Map<number, ConvState>();

const TRIGGER_WORDS = ["depositar", "deposit", "enviar", "send", "transfer"];
const HELP_TEXT =
  "Hola! Soy el bot de Stellar Anchor.\n" +
  "Para depositar USDC escribe:\n" +
  "  depositar [monto]\n" +
  "Ejemplo: depositar 50";

// ---------------------------------------------------------------------------
// Core handler — shared by webhook and polling modes
// ---------------------------------------------------------------------------
export async function handleUpdate(update: Record<string, unknown>): Promise<void> {
  // ── Mensaje de texto normal ────────────────────────────────────────────
  const message = update.message as Record<string, unknown> | undefined;
  if (!message) return;

  const chatId   = (message.chat as { id: number }).id;
  const rawText  = ((message.text as string | undefined) ?? "").trim();
  const text     = rawText.toLowerCase();

  console.log(`\n▶ Telegram [${chatId}]: "${rawText}"`);

  const state       = sessions.get(chatId) ?? "idle";
  const hasTrigger  = TRIGGER_WORDS.some((t) => text.startsWith(t));
  const amountMatch = rawText.match(/(\d+(?:\.\d+)?)/);

  if (state === "awaiting_amount" && !hasTrigger) {
    if (!amountMatch) {
      await sendMessage(chatId, "Por favor escribe solo el monto. Ej: 50");
      return;
    }
    sessions.set(chatId, "idle");
    await initiateSep24(chatId, amountMatch[1]);
    return;
  }

  if (hasTrigger && !amountMatch) {
    sessions.set(chatId, "awaiting_amount");
    await sendMessage(chatId, "¿Cuánto deseas depositar en USDC? Escribe el monto (ej: 50)");
    return;
  }

  if (hasTrigger && amountMatch) {
    sessions.set(chatId, "idle");
    await initiateSep24(chatId, amountMatch[1]);
    return;
  }

  sessions.set(chatId, "idle");
  await sendMessage(chatId, HELP_TEXT);
}

// ---------------------------------------------------------------------------
// SEP-24: crear transacción y enviar link al usuario
// ---------------------------------------------------------------------------
async function initiateSep24(chatId: number, amount: string): Promise<void> {
  console.log(`  → Iniciando SEP-24 deposit por ${amount} USDC`);
  await sendMessage(chatId, `Iniciando deposito de ${amount} USDC...`);

  try {
    const token = jwt.sign(
      { sub: TEST_ACCOUNT, iss: "localhost:8080", iat: Math.floor(Date.now() / 1000) },
      SEP10_SECRET,
      { expiresIn: "10m" },
    );

    const response = await fetch(
      `${ANCHOR_URL}/sep24/transactions/deposit/interactive`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          asset_code:   ASSET_CODE,
          asset_issuer: ASSET_ISSUER,
          amount,
          lang:         "es",
        }),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      console.error(`  ✗ SEP-24 error (${response.status}):`, err);
      await sendMessage(
        chatId,
        `Error al iniciar la transaccion (${response.status}).\nVerifica que el Anchor Platform este corriendo.`,
      );
      return;
    }

    const data = (await response.json()) as { id: string; url: string };
    const interactiveUrl = PUBLIC_BASE_URL
      ? data.url.replace(/^http:\/\/localhost:\d+/, PUBLIC_BASE_URL)
      : data.url;

    console.log(`  ✓ Txn creada: ${data.id} | URL: ${interactiveUrl}`);

    // Guardar para que server.ts pueda notificar al usuario cuando llegue pending_anchor
    pendingDeposits.set(data.id, { chatId, amount });

    await sendHtmlMessage(
      chatId,
      `Transaccion SEP-24 iniciada!\n` +
      `ID: <code>${data.id}</code>\n\n` +
      `Abre el link, completa el formulario y luego confirma aqui:`,
      [[{ text: "Abrir formulario de deposito →", url: interactiveUrl }]],
    );
  } catch (err) {
    console.error("  ✗ Conexion con Anchor Platform fallida:", err);
    await sendMessage(
      chatId,
      "No se pudo conectar con el Anchor Platform.\nAsegurate de que este corriendo en localhost:8080.",
    );
  }
}

// ---------------------------------------------------------------------------
// El usuario confirmó: llamar al Platform RPC desde aquí
// ---------------------------------------------------------------------------

async function platformRpc(baseUrl: string, method: string, params: Record<string, unknown>): Promise<boolean> {
  // El controller espera un array de requests JSON-RPC 2.0
  const reqBody = [{ jsonrpc: "2.0", method, id: crypto.randomUUID(), params }];
  console.log(`  → Platform RPC [${method}] params:`, JSON.stringify(params));
  const res = await fetch(`${baseUrl}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
  });

  const raw = await res.json() as unknown;
  console.log(`  ← Platform RPC [${method}] response (${res.status}):`, JSON.stringify(raw));
  const item = (Array.isArray(raw) ? raw[0] : raw) as { result?: unknown; error?: { message?: string; code?: number } };

  if (item.error) {
    console.error(`  ✗ RPC error [${method}]: ${item.error.message ?? JSON.stringify(item.error)}`);
    return false;
  }
  console.log(`  ✓ RPC [${method}] OK`);
  return true;
}

// ---------------------------------------------------------------------------
// Webhook mode  (POST /telegram/webhook)
// ---------------------------------------------------------------------------
export const router = Router();

router.post("/webhook", async (req: Request, res: Response) => {
  res.sendStatus(200);
  await handleUpdate(req.body as Record<string, unknown>);
});

// ---------------------------------------------------------------------------
// Long-polling mode
// ---------------------------------------------------------------------------
export async function startPolling(): Promise<void> {
  if (!TOKEN) {
    console.warn("⚠  TELEGRAM_BOT_TOKEN no configurado — polling desactivado.");
    return;
  }

  console.log("🤖 Telegram bot iniciado en modo polling...");
  let offset = 0;

  while (true) {
    try {
      const res  = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30`);
      const json = (await res.json()) as { ok: boolean; result: Array<{ update_id: number } & Record<string, unknown>> };

      if (!json.ok) { await sleep(5000); continue; }

      for (const update of json.result) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch {
      await sleep(5000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
