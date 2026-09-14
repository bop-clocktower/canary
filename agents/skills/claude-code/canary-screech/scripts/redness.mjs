// redness -- is this branch red, and which commits are implicated. Pure.
//
// "Red" is a property of the LATEST run on the branch, but the culprit range is
// a property of the transition into red, so the walk goes backwards from the
// latest run to the FIRST consecutive red one. Naming the latest red run as the
// culprit is the obvious mistake: by the time a human looks, main has usually
// taken several more commits while staying broken, and reverting the newest of
// them fixes nothing.

/** A run counts as failing when it recorded at least one failed test. */
function isRed(run) {
  return Number(run.failed ?? 0) > 0;
}

/**
 * @typedef {object} CulpritRange
 * @property {string|null} from  last known-green commit, or null if unknown
 * @property {string|null} to    commit of the first red run
 * @property {string[]} commits  distinct commits inside the range
 * @property {boolean} bounded   false when no green run precedes the break
 */

/**
 * Assess a branch from its runs, oldest first.
 *
 * @param {object[]} runs oldest-first runs for ONE branch
 * @returns {{state: 'red'|'green'|'abstained', latest: object|null,
 *           firstRed: object|null, lastGreen: object|null,
 *           culpritRange: CulpritRange|null}}
 */
export function assessBranch(runs) {
  // Zero denominator. Not green -- nothing was observed, so nothing is known.
  if (!runs.length) {
    return {
      state: 'abstained',
      latest: null,
      firstRed: null,
      lastGreen: null,
      culpritRange: null,
    };
  }

  const latest = runs[runs.length - 1];
  if (!isRed(latest)) {
    return {
      state: 'green',
      latest,
      firstRed: null,
      lastGreen: latest,
      culpritRange: null,
    };
  }

  // Walk back over the unbroken tail of red runs to the first one.
  let firstRedIndex = runs.length - 1;
  while (firstRedIndex > 0 && isRed(runs[firstRedIndex - 1])) {
    firstRedIndex -= 1;
  }
  const firstRed = runs[firstRedIndex];
  const lastGreen = firstRedIndex > 0 ? runs[firstRedIndex - 1] : null;

  // The commits this store can actually SEE inside the range. The interval is
  // `(lastGreen, firstRed]`, and its interior may hold commits that no run ever
  // observed -- enumerating those needs git, which this skill deliberately does
  // not shell out to. So the list is the observed suspect only, and
  // `bounded: false` is how "the lower bound is unknown" is said out loud
  // rather than implied away. `clusterFailures` accepts a longer list so a
  // git-aware caller can widen the range without changing this contract.
  const commits = firstRed.commit_sha ? [firstRed.commit_sha] : [];

  return {
    state: 'red',
    latest,
    firstRed,
    lastGreen,
    culpritRange: {
      from: lastGreen?.commit_sha ?? null,
      to: firstRed.commit_sha ?? null,
      commits,
      bounded: lastGreen !== null,
    },
  };
}
