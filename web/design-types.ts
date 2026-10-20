import type { DesignScope } from "../src/design-schema.js";
export type DesignRequest = {
  scope: DesignScope;
  prompt?: string;
  key: number;
};
