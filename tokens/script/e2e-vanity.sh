#!/usr/bin/env bash
# e2e-vanity.sh — end-to-end test of the $AGNA vanity deploy + pool flow on LOCAL Anvil.
#
# Builds everything, starts Anvil on 127.0.0.1:8545, runs script/e2e-vanity.cjs,
# then stops Anvil. Local only: Anvil's throwaway test keys, never a real
# key, never a live chain.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"

echo "== forge build (tokens) =="
forge build
echo "== hardhat compile (names) =="
(cd ../names && npx hardhat compile)

echo "== starting Anvil on 127.0.0.1:8545 =="
anvil --port 8545 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

# Wait for the RPC to answer.
for _ in $(seq 1 30); do
  if curl -s -m 2 -X POST http://127.0.0.1:8545 \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"web3_clientVersion","params":[]}' | grep -q result; then
    break
  fi
  sleep 1
done

echo "== running e2e-vanity.cjs =="
node script/e2e-vanity.cjs
