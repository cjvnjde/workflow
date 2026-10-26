import type { DesignScope } from "../src/contracts.js";
export type DesignRequest = {
  scope: DesignScope;
  prompt?: string;
  key: number;
};
