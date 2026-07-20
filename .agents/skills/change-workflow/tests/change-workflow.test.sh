#!/usr/bin/env bash
set -euo pipefail
TEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
. "$TEST_DIR/test-helper.sh"
. "$TEST_DIR/start-change.test.sh"
. "$TEST_DIR/finish-change.test.sh"
. "$TEST_DIR/contract.test.sh"
run_start_tests
run_finish_tests
run_contract_tests
printf '%s passed, %s failed\n' "$PASS_COUNT" "$FAIL_COUNT"
test "$FAIL_COUNT" -eq 0
