import type { DesignScope } from "../../../src/contracts/index.js";
export type DesignRequest = {
  scope: DesignScope;
  prompt?: string;
  key: number;
};
