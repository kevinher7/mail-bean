export type Transaction = {
  date: string;
  time: string;
  amount: number;
  currency: string;
  sourceAccount: string; // TODO: Make into enum
  payee: string;
  dedupId: string;
};

export type WriteResult = {
  sent: number;
  created: number;
  duplicates: number;
};

export type Sink = (transactions: Transaction[]) => Promise<WriteResult>;
