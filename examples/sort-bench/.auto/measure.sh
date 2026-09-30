#!/bin/bash
set -euo pipefail
node --check sort.js
node bench.js
