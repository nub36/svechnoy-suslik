export type Timeframe =
  | "5m"
  | "15m"
  | "1h"
  | "4h"
  | "1d";

export type CandleData = {
  openTime: Date;
  closeTime?: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
};
