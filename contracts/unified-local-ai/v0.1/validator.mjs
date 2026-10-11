/**
 * UNIFIED LOCAL AI PROGRAM - CONTRACT v0.1 (static, fail-closed).
 * NO process execution, no host discovery, no network requests and no adapters.
 * These metadata descriptors are NOT runtime attestations or capabilities grants.
 */

const modesByProject = Object.freeze({
  'ai-development-studio': new Set(['OLLAMA_LOCAL_CHAT_PILOT', 'GIT_HUMAN_REVIEW_PILOT', 'TRUSTED_WINDOWS_VM_FIXTURE_MANUAL']),
  local3d: new Set(['DEMO_FIXTURE_ONLY', 'TRIPOSR_MANUAL_PER_IMAGE_GATED', 'DRAFT_MESH_QA']),
  'genex-integration-lab': new Set(['UPSTREAM_CODE_REVIEW', 'MCP_CONSENT_FIXTURE_TESTS'])
});

const sourceRepos = Object.freeze({
  'ai-development-studio': 'nocturney/ai-development-studio',
  local3d: 'nocturney/local-3d-generator',
  'genex-integration-lab': 'genex-games/genex-desktop'
});

const requiredPolicy = Object.freeze({
  localOnly: true,
  cloudFallback: 'DISABLED',
  networkEgress: 'NOT_AUTHORIZED',
  gpuInference: 'PER_ASSET_APPROVAL_REQUIRED',
  vmExecution: 'SEPARATE_OPERATOR_APPROVAL_REQUIRED',
  nativePlugins: 'NOT_AUTHORIZED',
  arbitraryShell: 'NOT_AUTHORIZED',
  jobSubmission: 'NOT_AUTHORIZED',
  printer: 'NOT_AUTHORIZED',
  humanReview: 'REQUIRED'
});

const requiredResult = Object.freeze({
  trusted: false,
  printQualified: false,
  approvedForPrinter: false,
  fabricationAction: 'NONE'
});

const requiredIntegration = Object.freeze({
  adapter: 'NOT_IMPLEMENTED',
  sharedScheduler: false,
  jobSubmission: false
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactFields(obj, keys, context) {
  if (!isObject(obj)) throw new TypeError(`${context}: must be a JSON object`);
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error(`${context}: exact keys required`);
  }
}

function exactValues(obj, expected, context) {
  exactFields(obj, Object.keys(expected), context);
  for (const [key, value] of Object.entries(expected)) {
    if (obj[key] !== value) throw new Error(`${context}.${key}: forbidden escalation or unsupported status`);
  }
}

/** Validate only a static source snapshot declaration, never a host attestation. */
export function validateCapability(input) {
  exactFields(input, ['schemaVersion', 'projectId', 'repository', 'upstreamCommit', 'declaredModes', 'snapshot', 'policy', 'gpu', 'result', 'integration'], 'capability');
  if (input.schemaVersion !== 'velvet.local-ai.capability.v0.1') throw new Error('Unsupported capability contract version');
  if (!Object.hasOwn(modesByProject, input.projectId)) throw new Error('Unknown or untrusted projectId');
  if (input.repository !== sourceRepos[input.projectId]) throw new Error('Repository does not match project');
  if (typeof input.upstreamCommit !== 'string' || !/^[0-9a-f]{40}$/.test(input.upstreamCommit)) throw new Error('A full pinned Git commit SHA is required');
  if (!Array.isArray(input.declaredModes) || input.declaredModes.length === 0 || input.declaredModes.length > 4 || new Set(input.declaredModes).size !== input.declaredModes.length || !input.declaredModes.every(mode => modesByProject[input.projectId].has(mode))) {
    throw new Error('Unexpected, missing, duplicate, or project-mismatched mode');
  }
  exactValues(input.snapshot, {
    evidence: 'GITHUB_CODE_ONLY',
    runtimeStatus: 'UNKNOWN',
    hostVerified: false,
    port: null,
    hostIdentity: null
  }, 'snapshot');
  exactValues(input.policy, requiredPolicy, 'policy');
  exactValues(input.gpu, {leaseState: 'UNKNOWN', approvedForInference: false}, 'gpu');
  exactValues(input.result, requiredResult, 'result');
  exactValues(input.integration, requiredIntegration, 'integration');
  // Return a harmless projection rather than preserving arbitrary object prototype or extra data.
  return Object.freeze({
    projectId: input.projectId,
    sourceCommit: input.upstreamCommit,
    evidence: 'GITHUB_CODE_ONLY',
    runtimeStatus: 'UNKNOWN',
    authorizedActions: Object.freeze([]),
    localOnly: true,
    safeToExecute: false,
    printQualified: false
  });
}

/** No request can obtain execution rights via this static contract. */
export function evaluateRequest(input, action) {
  try {
    const descriptor = validateCapability(input);
    if (action === 'inspect_static_descriptor') {
      return Object.freeze({decision: 'STATIC_METADATA_ONLY', projectId: descriptor.projectId, sideEffects: false, verifiedHost: false});
    }
    return Object.freeze({decision: 'DENY', reason: 'NO_RUNTIME_AUTHORIZATION_IN_V0_1', sideEffects: false});
  } catch {
    return Object.freeze({decision: 'DENY', reason: 'INVALID_OR_UNTRUSTED_DESCRIPTOR', sideEffects: false});
  }
}
