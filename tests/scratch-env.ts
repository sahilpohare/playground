import { boxEnv } from "../packages/scripts/src/box-env"
import { SANDBOX_KEYS } from "../packages/scripts/src/sandbox"

// The variables sandbox.ts sets for the suite, kept for a test's child beside the caller's own SANDBOX_KEYS
const KEYS = [
  ...SANDBOX_KEYS,
  "PLAYGROUND_PROC",
  "PYTHONDONTWRITEBYTECODE",
  "TEST_SANDBOX_BOX",
  "TEST_SANDBOX_HOME",
  "TEST_SANDBOX_OUTER_PID",
  "TMPDIR",
  "TZ",
  "UV_CACHE_DIR",
  "UV_PYTHON_INSTALL_DIR",
]

// A test child's whole env at a scratch home: the sandbox's variables, HOME, then extra over them (an undefined value drops its key)
export const scratchEnv = (home: string, extra: Record<string, string | undefined> = {}) =>
  boxEnv(home, extra, KEYS)
