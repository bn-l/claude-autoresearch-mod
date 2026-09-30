// The function under optimization: sorts an array of integers ascending, in place,
// and returns it. Deliberately naive.
export function sort(values) {
  const copy = values.slice();
  for (let i = 1; i < copy.length; i++) {
    const current = copy[i];
    let j = i - 1;
    while (j >= 0 && copy[j] > current) {
      copy[j + 1] = copy[j];
      j--;
    }
    copy[j + 1] = current;
  }
  for (let i = 0; i < copy.length; i++) values[i] = copy[i];
  return values;
}
