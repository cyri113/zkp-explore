import { Field } from 'o1js';

export type LeafEntry = {
  id: string;
  fields: Field[];
  timestamp: number;
  sortKey: string;
};

export type RootSnapshot = {
  root: string;
  leafIndex: number;
  timestamp: number;
  sortKey: string;
};
