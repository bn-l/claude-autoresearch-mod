# sort-bench

A tiny repository to try the autoresearch mod on: `sort.js` is a deliberately slow
integer sort, `bench.js` times it (median of 7 rounds, a little noisy), and `test.js`
checks it is still correct.

`.auto/` already holds a session prompt, the benchmark and checks scripts, and two
iteration hooks, so `/autoresearch go` starts the loop straight away. Delete `.auto/` to
watch the `autoresearch-create` skill set a session up from scratch instead.

Copy the folder somewhere outside this repository and make it a git repository first:

    cp -R examples/sort-bench /tmp/sort-bench && cd /tmp/sort-bench
    git init -q && git add -A && git commit -qm init
