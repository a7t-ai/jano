#!/bin/bash
# No-op SWAP_COMMAND for integration tests. The mock upstream answers
# /health 200 unconditionally, so detectLoaded() picks up "test" without
# needing this script to do anything.
exit 0
