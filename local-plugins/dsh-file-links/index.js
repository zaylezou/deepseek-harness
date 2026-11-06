/**
 * Host half: no host-side behavior.
 *
 * The browser half (./client) owns the clickable file vocabulary; this Node
 * face exists so the profile can load the package as an ordinary plugin row.
 * The client module system attaches the browser half to the row whose
 * specifier is the bare package name.
 */
export function apply() {}
