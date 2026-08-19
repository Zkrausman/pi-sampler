# Implementation Plan: AIDEV-134

## Effort & Risk
* **Effort**: **High**. Requires building a secure, version-controlled evaluation platform with deterministic replay capabilities and strict cryptographic/isolation guarantees.
* **Risk**: **High**. If the holdout isolation boundary is breached or evidence invalidation logic fails, the system will accept overfitted or reward-hacked lessons. The addition of strict sandbox resolution, DAG constraints, and streaming buffers further elevates complexity.

## Expected File Changes
* `contracts/evaluation-run-v1.mjs` (New)
* `contracts/evaluation-run-v1.schema.json` (New)
* `ledgers/evaluation-ledger.mjs` (New)
* `docs/specs/EVALUATION-PLATFORM-V1.md` (New)
* `governance/pkg/evolutionorchestrator/evaluation.go` (New/Modify)
* `governance/pkg/evolutionorchestrator/scoring.go` (Modify)
* `governance/pkg/evolutionorchestrator/dag.go` (New - cycle dependency checks)
* `tests/evaluation-platform.test.mjs` (New)
* `tests/fixtures/evaluations/adversarial/` (New directory)
* `tests/fixtures/evaluations/holdout/` (New directory)
* `tests/fixtures/evaluations/baseline/` (New directory)

## Step-by-Step Execution

### Phase 1: Versioned evaluation identity, baseline, no-change control, metrics, and stale-evidence rules
1. **Schema & Contracts**: Define `contracts/evaluation-run-v1.schema.json` enforcing a strict evaluation identity composed of: `evaluator_version`, `prompt_hash`, `model_id`, `dataset_version`, `metric_definitions_hash`, and `thresholds`.
2. **Evaluation Ledger**: Implement `ledgers/evaluation-ledger.mjs` to record evaluation runs.
3. **Identity Binding & Invalidation**: Update the `evolutionorchestrator` to calculate the evaluation identity hash. Implement rule logic to aggressively reject promotion evidence if any underlying factor (e.g., metric definition) has changed since the evaluation.
4. **Baseline & Control**: Implement orchestration to automatically run the current system state (no-change control) and candidate side-by-side against the same versioned baseline fixtures.
5. **Cycle-Dependency Prevention**: Implement a deterministic evaluation DAG (Directed Acyclic Graph) verification step (or strict recursion depth limit) in the orchestrator to proactively detect and terminate infinite cycle-dependency loops during evaluation triggering.

### Phase 2: Replay and forward evaluation with protected holdout isolation
1. **Holdout Isolation Boundary & Teardown**: Enforce isolation via containerized execution or strict OS-level permissions. Crucially, implement a secure teardown step that aggressively wipes all scratch directories, ephemeral state, memory caches, and environment bindings between runs to prevent unprotected state leakage.
2. **Bounded Deterministic Replay**: Build a replay mechanism in the evaluation runner that feeds pre-recorded fixture states to the candidate lesson. Ensure this utilizes bounded buffer constraints or streaming mechanisms to strictly reject loading unbound fixture datasets into memory at once, mitigating OOM vulnerabilities.
3. **Confined Forward Evaluation Fallback**: Implement forward evaluation fallback mechanisms for side-effects. Mandate strict sandbox path resolution for all fallback actions: the orchestrator must actively block or safely resolve any symlinks to ensure they cannot traverse outside the designated evaluation root directory.

### Phase 3: Adversarial evaluation, reward-hacking fixtures, complexity checks, and preserved evaluator disagreement
1. **Evaluator Disagreement Retention**: Modify the evaluator aggregation logic to store an array of distinct scores and notes rather than collapsing them into an average. Fail candidates if the divergence exceeds acceptable thresholds.
2. **Adversarial & Complexity Rules**: Inject complexity boundaries (e.g., maximum cyclomatic complexity, token usage caps) into the evaluation metrics.
3. **Robustness Fixtures**: Populate `tests/fixtures/evaluations/adversarial/` with known reward-hacking scenarios (e.g., fabricated evidence receipts, secret leakage prompts) to ensure the evaluator fails closed.

## Test Matrix
| Scenario | Action | Expected Outcome |
| :--- | :--- | :--- |
| **Evaluation Identity Mutation** | Change `evaluator_version` or `prompt_hash` on an existing approved run. | System calculates a new hash and invalidates stale promotion evidence; fails closed. |
| **Baseline Strictness** | Execute candidate against `v1` fixtures and control against `v2`. | Orchestrator halts execution; demands identical versioned fixtures for candidate and control. |
| **Holdout Leakage Attempt** | Candidate attempts to fetch or reference holdout ticket ID during evaluation. | Triggers an immediate fatal panic/exception that aborts the entire evaluation run (hard fail-closed). |
| **Averaging Disagreement** | Supply two conflicting evaluator scores (e.g., 90/100 and 20/100). | Record both discrete scores in ledger; reject attempt to unify into a passing 55/100 average. |
| **Adversarial Reward Hacking** | Run candidate against a fixture designed to trick the model into faking a pass. | Adversarial evaluator detects anomalous patterns; rejects the candidate lesson. |
| **OOM Replay Attack** | Feed a massive, multi-gigabyte fixture state into the replay evaluator. | Replay runner streams the data using bounded buffers; memory usage remains stable. |
| **Symlink Traversal** | Candidate generates a symlink pointing to `/etc/shadow` or a parent host directory during forward fallback. | Sandbox path resolution intercepts the symlink, blocks traversal, and fails the evaluation. |
| **Evaluation DAG Loop** | Trigger an evaluation that recursively requests re-evaluation of its own baseline. | Orchestrator's DAG verification detects the cycle and terminates the run with a dependency error. |
