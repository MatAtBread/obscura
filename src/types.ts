export type TimeStamp = number & { TimeStamp: 'TimeStamp'; };

export interface TimeIndex {
    time: TimeStamp;
    name: string;
    size: number;
  }
  