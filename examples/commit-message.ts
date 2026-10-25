import { workflow, step, sequence } from "workflow";
import collectDiff from "./blocks/collect-commit-diff";
import draftMessage from "./blocks/draft-commit-message";
import validateMessage from "./blocks/validate-commit-message";

const collect = step("collect-diff", collectDiff, { inputs: { source: "staged" } });
const draft = step("draft-message", draftMessage, { inputs: ctx => ctx.output(collect)! });
const validate = step("validate-message", validateMessage, { inputs: ctx => ctx.output(draft)! });

export default workflow({ name: "Suggest a commit message", flow: sequence(collect, draft, validate) });
