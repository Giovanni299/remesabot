import * as StellarSdk from "@stellar/stellar-sdk";
import "dotenv/config";

const server = new StellarSdk.Horizon.Server(
  "https://horizon-testnet.stellar.org"
);

function loadEnv() {
  const required = [
    "SENDER_PUBLIC_KEY",
    "SENDER_SECRET_KEY",
    "RECEIVER_PUBLIC_KEY",
    "RECEIVER_SECRET_KEY",
    "USDC_ISSUER",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Falta la variable de entorno: ${key}`);
  }
  return {
    senderKeypair: StellarSdk.Keypair.fromSecret(process.env.SENDER_SECRET_KEY),
    senderPublic: process.env.SENDER_PUBLIC_KEY,
    receiverKeypair: StellarSdk.Keypair.fromSecret(process.env.RECEIVER_SECRET_KEY),
    receiverPublic: process.env.RECEIVER_PUBLIC_KEY,
    USDC: new StellarSdk.Asset("USDC", process.env.USDC_ISSUER),
  };
}

async function ensureTrustline(keypair, asset) {
  const account = await server.loadAccount(keypair.publicKey());
  const hasTrust = account.balances.some(
    (b) => b.asset_code === "USDC" && b.asset_issuer === asset.issuer
  );
  if (hasTrust) {
    console.log(`  ${keypair.publicKey().slice(0, 10)}... ya tiene trustline`);
    return;
  }
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset, limit: "10000" }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  await server.submitTransaction(tx);
  console.log(`  Trustline creada para ${keypair.publicKey().slice(0, 10)}...`);
}

async function main() {
  const { senderKeypair, receiverPublic, receiverKeypair, USDC } = loadEnv();

  // 1. Asegurar trustlines en ambas cuentas
  console.log("=== Verificando trustlines ===");
  await ensureTrustline(senderKeypair, USDC);
  await ensureTrustline(receiverKeypair, USDC);

  // 2. Verificar balance del sender
  const senderAccount = await server.loadAccount(senderKeypair.publicKey());
  const usdcBalance = (acc) =>
    acc.balances.find(
      (b) => b.asset_code === "USDC" && b.asset_issuer === USDC.issuer
    )?.balance ?? "0";
  const balance = parseFloat(usdcBalance(senderAccount));
  console.log(`\n  Sender USDC disponible: ${balance}`);
  if (balance < 10) {
    console.error(`\n✗ Fondos insuficientes. Obtén USDC en: https://faucet.circle.com`);
    console.error(`  Cuenta sender: ${senderKeypair.publicKey()}`);
    process.exit(1);
  }

  // 3. Enviar 10 USDC
  console.log("\n=== Enviando 3 USDC: sender → receiver ===");
  const freshSender = await server.loadAccount(senderKeypair.publicKey());
  const paymentTx = new StellarSdk.TransactionBuilder(freshSender, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: receiverPublic,
        asset: USDC,
        amount: "3",
      })
    )
    .setTimeout(30)
    .build();
  paymentTx.sign(senderKeypair);
  const result = await server.submitTransaction(paymentTx);

  console.log("\n✓ Transacción exitosa");
  console.log(`  Hash: ${result.hash}`);
  console.log(
    `  Stellar Expert: https://stellar.expert/explorer/testnet/tx/${result.hash}`
  );

  // 4. Balances finales
  const [finalSender, finalReceiver] = await Promise.all([
    server.loadAccount(senderKeypair.publicKey()),
    server.loadAccount(receiverPublic),
  ]);

  console.log("\n=== Balances finales ===");
  console.log(`  Sender USDC:   ${usdcBalance(finalSender)}`);
  console.log(`  Receiver USDC: ${usdcBalance(finalReceiver)}`);
}

main().catch((err) => {
  if (err?.response?.data?.extras?.result_codes) {
    console.error("Error de Horizon:", JSON.stringify(err.response.data.extras.result_codes, null, 2));
  } else {
    console.error(err);
  }
});
