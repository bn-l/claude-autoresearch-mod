#!/bin/bash
# Keeps a line per logged run, outside the model's view.
payload=$(cat)
echo "$(date +%s) ${#payload} bytes" >> .auto/after-hook.log
