// Times sort() over fixed pseudo-random inputs and prints the median of several rounds
// as `METRIC total_ms=<ms>`. Do not edit: this is the measuring stick.
import { sort } from "./sort.js";

function inputs(seed) {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648);
  const arrays = [];
  for (let a = 0; a < 6; a++) {
    const length = 2500 + (a % 3) * 500;
    arrays.push(Array.from({ length }, () => (next() % 20001) - 10000));
  }
  return arrays;
}

const rounds = [];
for (let round = 0; round < 7; round++) {
  const arrays = inputs(42 + round);
  const t0 = performance.now();
  for (const array of arrays) sort(array);
  rounds.push(performance.now() - t0);
}
rounds.sort((a, b) => a - b);
const median = rounds[Math.floor(rounds.length / 2)];
console.log(`rounds_ms: ${rounds.map((ms) => ms.toFixed(2)).join(" ")}`);
console.log(`METRIC total_ms=${median.toFixed(3)}`);
