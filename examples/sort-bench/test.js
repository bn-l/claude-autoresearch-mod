// Correctness checks for sort(). Exits 1 on the first failure.
import { sort } from "./sort.js";

const cases = [
  [],
  [1],
  [2, 1],
  [3, 1, 2, 3, 1],
  [-5, 0, 5, -10, 10],
  Array.from({ length: 1000 }, (_, i) => (i * 7919) % 1000 - 500),
];
for (const input of cases) {
  const expected = input.slice().sort((a, b) => a - b);
  const actual = sort(input.slice());
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    console.error(`FAIL: sort(${JSON.stringify(input).slice(0, 60)}) gave ${JSON.stringify(actual).slice(0, 60)}`);
    process.exit(1);
  }
  const inPlace = input.slice();
  if (sort(inPlace) !== inPlace) {
    console.error("FAIL: sort must sort in place and return the same array");
    process.exit(1);
  }
}
// -0 is a value of its own (=== above can't tell it from 0): a sort must not turn it into +0.
const zeros = sort([0, -0, 1, -0]);
if (zeros.filter((value) => Object.is(value, -0)).length !== 2) {
  console.error(`FAIL: sort([0, -0, 1, -0]) lost a -0: gave [${zeros.map((value) => (Object.is(value, -0) ? "-0" : value)).join(", ")}]`);
  process.exit(1);
}
console.log(`ok: ${cases.length + 1} cases`);
