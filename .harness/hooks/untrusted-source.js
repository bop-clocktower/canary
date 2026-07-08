// untrusted-source.js — shared trust boundary for the Sentinel injection scan.
//
// Prompt-injection defense exists to catch UNTRUSTED external content entering
// the model's context. Scanning the user's own local tools (reading/writing
// repo files, running local shell, first-party MCP) provides little injection
// defense but generates most false positives — in a repo that BUILDS security /
// CI tooling, legitimate content (commit messages, hook source, docs) is full
// of the exact phrases the detector flags. So the scan is scoped to untrusted
// sources only.
//
// Untrusted = content that originates outside the user's control:
//   - WebFetch / WebSearch (arbitrary web content)
//   - third-party MCP tools (external services/APIs)
// Trusted (NOT scanned) = everything local + first-party MCP:
//   - Read / Grep / Glob / Edit / Write / NotebookEdit / Bash / Task / …
//   - the harness + canary MCP bundle (harness, canary, context7, playwright)
//     and the local IDE bridge.
//
// KNOWN RESIDUAL: a network fetch run *through Bash* (curl/wget) is treated as
// trusted and not scanned. Bash is the local-shell surface; treating it as
// untrusted would re-introduce the false positives this scoping removes. If
// fetching untrusted URLs via Bash becomes common, prefer WebFetch (scanned)
// or extend this module to sniff network argv0s.

// First-party MCP prefixes — kept in sync with prefer-first-party-mcp.js.
const FIRST_PARTY_MCP_PREFIXES = [
  'mcp__harness__',
  'mcp__plugin_mcp-bundle_', // canary + context7 bundle
  'mcp__playwright__',
  'mcp__ide__',
];

// Non-MCP tools that pull untrusted external content into context.
const UNTRUSTED_TOOLS = new Set(['WebFetch', 'WebSearch']);

/**
 * True when a tool's content should be scanned for prompt injection.
 * @param {string} toolName
 * @returns {boolean}
 */
export function isUntrustedSource(toolName) {
  if (!toolName) return false;
  if (UNTRUSTED_TOOLS.has(toolName)) return true;
  if (toolName.startsWith('mcp__')) {
    return !FIRST_PARTY_MCP_PREFIXES.some((p) => toolName.startsWith(p));
  }
  return false; // all local tools are trusted
}
