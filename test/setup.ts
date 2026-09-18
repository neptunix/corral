import os from "node:os";
import path from "node:path";

process.env.CORRAL_CONFIG = path.resolve(import.meta.dirname, "fixtures/environments.json");

// server/ssh-flags.ts creates <CORRAL_HOME>/ssh on first use (any ssh-building call — buildExec,
// buildAttachSpec, a remote statusline/transcript/session-registry read). Left unset, CORRAL_HOME
// defaults to the real machine's ~/.corral, so the suite would create a real directory there on
// whatever machine runs it. Point it at a tmp dir instead, set before config.ts evaluates.
process.env.CORRAL_HOME = path.join(os.tmpdir(), "corral-test-home");
