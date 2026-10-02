#!/bin/bash
set -euo pipefail
node --check tour.js
node bench.js
