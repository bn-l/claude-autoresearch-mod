# tsp-bench

A travelling salesman repository to demo the autoresearch mod on, with room for many
improvements in a row. `tour.js` builds a tour by nearest neighbour, about 25% longer than
the best known tours. `bench.js` gives it 1 second on each of three instances (2,000 to
3,000 cities, uniform and clustered) and scores the mean gap to the best known tours.
`test.js` checks it on tiny and awkward inputs (no cities, every city in one place, every
city twice) and on two instances the benchmark never shows.

`.auto/` already holds a session prompt, the benchmark and checks scripts, and a limit of
25 runs, so `/autoresearch go` starts the loop straight away and it stops by itself.

The best known tour lengths (`best` in `instances.js`) are the shortest of 3- to 5-minute
runs of `scripts/tsp-reference-lk.js` in this repository: the solver an autoresearch session
on this benchmark wrote by its 13th run, given minutes instead of a second. It's kept out of
this folder so the model being demoed can't copy it. The lengths are close to optimal but
not proven optimal, so a solver that finds better tours scores a negative gap, and the
band, which only counts positive metrics as the best, then stops updating its best.

Copy the folder somewhere outside this repository and make it a git repository first:

    cp -R examples/tsp-bench /tmp/tsp-bench && cd /tmp/tsp-bench
    git init -q && git add -A && git commit -qm init
