// ---------------------------------------------------------------------------
// Tipos de evento que envía el Anchor Platform al Business Server
// ---------------------------------------------------------------------------
export type EventType =
  | "transaction_created"
  | "transaction_status_changed"
  | "quote_created";

// Estados posibles de una transacción SEP-24/SEP-6/SEP-31
export type TransactionStatus =
  | "incomplete"
  | "pending_customer_info_needed"
  | "pending_anchor"
  | "pending_stellar"
  | "pending_external"
  | "completed"
  | "expired"
  | "error"
  | "refunded";

export type TransactionKind = "deposit" | "withdrawal" | "receive";

export interface AmountAsset {
  amount: string;
  asset: string; // e.g. "stellar:USDC:GBBD47..."
}

export interface Transaction {
  id: string;
  status: TransactionStatus;
  kind: TransactionKind;
  amount_expected?: AmountAsset;
  amount_in?: AmountAsset;
  amount_out?: AmountAsset;
  destination_account?: string;
  source_account?: string;
  memo?: string;
  message?: string;
  stellar_transaction_id?: string;
}

export interface Quote {
  id: string;
  sell_asset: string;
  buy_asset: string;
  sell_amount: string;
  buy_amount: string;
}

export interface AnchorEvent {
  id: string;
  type: EventType;
  timestamp: string;
  payload: {
    transaction?: Transaction;
    quote?: Quote;
  };
}

// ---------------------------------------------------------------------------
// Tipos KYC (SEP-12)
// ---------------------------------------------------------------------------
export type CustomerStatus = "NEEDS_INFO" | "ACCEPTED" | "PROCESSING" | "REJECTED";

export interface CustomerField {
  type: "string" | "binary" | "number" | "date";
  description: string;
  optional?: boolean;
}

// ---------------------------------------------------------------------------
// Platform API — PATCH /transactions
// ---------------------------------------------------------------------------
export interface PatchTransactionRecord {
  id: string;
  status: TransactionStatus;
  amount_in?: AmountAsset;
  amount_out?: AmountAsset;
  fee_details?: { total: string; asset: string };
  message?: string;
}

export interface PatchTransactionsRequest {
  records: PatchTransactionRecord[];
}

export interface CustomerRecord {
  first_name?: string;
  last_name?: string;
  email_address?: string;
  [key: string]: unknown;
}
