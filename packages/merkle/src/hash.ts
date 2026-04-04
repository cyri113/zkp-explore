import { Field, Poseidon } from 'o1js';

export function hashLeaf(fields: Field[]): Field {
  return Poseidon.hash(fields);
}

export function hashString(s: string): Field {
  const fields = [...s].map((char) => Field(BigInt(char.charCodeAt(0))));
  return hashLeaf(fields);
}
