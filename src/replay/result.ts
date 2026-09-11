/**
 * The replay result contract.
 *
 * This is what the calling agent actually programs against, so the top-level
 * distinction is not "did it work" but "whose problem is this":
 *
 *  - `success`          the flow completed and the declared outputs are here.
 *  - `business_outcome` the application worked and said something the caller
 *                       must handle. "No such member" belongs here. Treating
 *                       it as an error trains callers to retry on it, which
 *                       is exactly wrong.
 *  - `needs_human`      we stopped on purpose and a person has been asked to
 *                       take over. Not a failure; a pending state.
 *  - `failure`          we could not proceed and nobody has resolved it. The
 *                       payload carries step, expectation, observation and
 *                       evidence, because the only useful failure is a
 *                       debuggable one.
 *
 * Recoverable conditions deliberately have no status of their own: by the
 * time we return, they were either recovered (and appear in `recoveries`) or
 * they became an escalation or a failure.
 */
export type FailureClass =
  | 'INVALID_INPUT'        // caller's arguments failed validation; never touched the app
  | 'APPROVAL_REQUIRED'    // artifact is not approved for unattended replay
  | 'POLICY_DENIED'        // a step would have left the allowlist
  | 'TARGET_NOT_FOUND'     // no control matched the recorded descriptor
  | 'TARGET_AMBIGUOUS'     // several matched equally well; refused to guess
  | 'STEP_TIMEOUT'         // the step's waitFor never became true
  | 'CHECKPOINT_FAILED'    // flow ran but the success condition did not hold
  | 'OUTPUT_MISSING'       // checkpoint passed but a required output was absent
  | 'SESSION_LOST'         // authenticated session gone and not recoverable
  | 'INTERSTITIAL_LOOP'    // a recoverable condition would not clear
  | 'APP_ERROR'            // the application reported its own failure (a 500 page)
  | 'SURFACE_ERROR'        // the driver itself failed (crash, navigation error)
  | 'RUN_TIMEOUT';

export interface DriftReport {
  /** Steps whose control skeleton no longer matches the recording. */
  changedSteps: string[];
  /** Targets that only resolved after relaxing the name match. */
  relaxedTargets: string[];
  /** Targets found in a different frame than recorded. */
  frameMismatches: string[];
}

export interface RecoveryRecord {
  code: string;
  atStep: string;
  occurrences: number;
}

export interface ResultBase {
  runId: string;
  capability: { id: string; version: string };
  startedAt: string;
  durationMs: number;
  stepsExecuted: number;
  evidenceDir: string;
  recoveries: RecoveryRecord[];
  drift: DriftReport;
}

export interface SuccessResult extends ResultBase {
  status: 'success';
  outputs: Record<string, string | number | boolean>;
}

export interface BusinessOutcomeResult extends ResultBase {
  status: 'business_outcome';
  code: string;
  message: string;
  outputs: Record<string, string | number | boolean>;
}

export interface NeedsHumanResult extends ResultBase {
  status: 'needs_human';
  escalationId: string;
  reason: string;
  stepId?: string;
}

export interface FailureResult extends ResultBase {
  status: 'failure';
  failure: {
    class: FailureClass;
    stepId?: string;
    /** What the artifact said should happen. */
    expected: string;
    /** What was actually on screen. */
    observed: string;
    detail?: string;
    /** Files under `evidenceDir` that explain this failure. */
    evidence: string[];
  };
}

export type ReplayResult =
  | SuccessResult
  | BusinessOutcomeResult
  | NeedsHumanResult
  | FailureResult;

export const emptyDrift = (): DriftReport => ({
  changedSteps: [],
  relaxedTargets: [],
  frameMismatches: [],
});
