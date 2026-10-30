import { block, z } from "workflow";

export default block({
  name: "Validate Conventional Commit message",
  input: z.object({ message: z.string().min(1).max(8000) }),
  output: z.object({ message: z.string(), subject: z.string() }),
  async run(ctx) {
    const message = ctx.input.message.replace(/\r\n/g, "\n").trim();
    const lines = message.split("\n");
    const subject = lines[0]!;
    if (!/^[a-z][a-z0-9-]*(\([^\r\n():]+\))?!?: \S[^\r\n]*$/.test(subject))
      throw new Error(
        "Expected type(scope): description, with optional scope and !. Use a lowercase type.",
      );
    if (subject.length > 72)
      throw new Error("Commit subject exceeds this library's 72-character style limit.");
    if (lines.length > 1 && lines[1] !== "")
      throw new Error("Separate the subject and body with a blank line.");
    if (message.includes("\u0000")) throw new Error("Commit messages cannot contain NUL bytes.");
    ctx.artifact("commit-message", message);
    ctx.summary(message);
    ctx.disposition("work-completed");
    return { message, subject };
  },
});
