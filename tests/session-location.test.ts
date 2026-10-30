import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionLocation, sessionLink } from "../web/features/sessions/session-location.js";

const id = "f9f57e16-68bf-4da1-8a6f-ce3400f27480";
test("session references accept terminal IDs and browser links without following pasted hosts", () => {
  assert.deepEqual(parseSessionLocation(`  ${id.toUpperCase()}  `), { id });
  assert.deepEqual(parseSessionLocation(`task:${id}`), { id, kind: "task" });
  assert.deepEqual(parseSessionLocation(`run:${id}`), { id, kind: "run" });
  assert.deepEqual(parseSessionLocation(`#task=${id}`), { id, kind: "task" });
  assert.deepEqual(parseSessionLocation(`https://another-machine.test/#run=${id}`), {
    id,
    kind: "run",
  });
  assert.deepEqual(parseSessionLocation(`http://localhost:4310/?session=${id}`), { id });
  for (const value of [
    "",
    "partial-id",
    "../../credentials",
    "https://host.test/",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => parseSessionLocation(value), /ID|link/);
  }
});
test("copied session links replace stale selection and preserve deployment prefix", () => {
  assert.equal(
    sessionLink(`https://example.test/workflow/?mode=local&session=old#settings`, {
      id,
      kind: "task",
    }),
    `https://example.test/workflow/?mode=local#task=${id}`,
  );
});
