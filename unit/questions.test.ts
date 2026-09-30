// Which turns count as asking the person something (DEVIATIONS I9): the loop holds its
// resume back for those. A heuristic over the end of the turn's final text.
import assert from "node:assert/strict";
import test from "node:test";

import { asksThePerson, noReplyLead } from "../plugin/hooks/app/resume.ts";

test("questions and hand-overs to the person count", () => {
  // what the model wrote at run 29 of the live soak: no question mark at all
  assert.equal(asksThePerson(`That's 29 of the 30 experiments. Before finalizing, two things need your call:
- Small arrays: add the fallback for 64 or fewer elements. I recommend it.
- -0 bug: the kept code turns -0 into +0. Fixing it costs about 50% in speed.`), true);
  assert.equal(asksThePerson("Kept #14. Should I keep pushing on radix sort, or stop here?"), true);
  assert.equal(asksThePerson("Two options:\n1. Keep the fallback?\n2. Fix -0?\n"), true);
  assert.equal(asksThePerson("I'm waiting for your go-ahead before touching the tests."), true);
  assert.equal(asksThePerson("Want me to add a -0 case to the checks? **"), true);
  assert.equal(asksThePerson("Let me know which one you prefer."), true);
});

test("an ordinary iteration's closing words don't", () => {
  assert.equal(asksThePerson(""), false);
  assert.equal(asksThePerson("Logged #12 as discard: the unrolled loop was 3% slower. Next I'll try a radix pass."), false);
  assert.equal(asksThePerson("Kept #14 (0.12 ms, -97.9%). Continuing with the next idea."), false);
  assert.equal(asksThePerson(`Why was it slower?
The branch predictor misses on the unrolled loop.
Reverted; the tree is clean.
Next I'll try a 16-bit radix.
Logged #15.`), false);
});

test("the resume after an unanswered question says so first", () => {
  assert.equal(
    noReplyLead({ minutes: 5, until: 0 }, "Run the next iteration now."),
    "No reply from the person within 5 minutes: make the call yourself, say what you chose, and carry on.\n\nRun the next iteration now.",
  );
  assert.match(noReplyLead({ minutes: 1, until: 0 }, "x"), /within 1 minute:/);
});
