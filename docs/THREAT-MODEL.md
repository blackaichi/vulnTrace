# VulnTrace Threat Model

## Assets

- developer source code;
- dependency metadata;
- vulnerability intelligence;
- source paths;
- scan results;
- optional cached provider data.

## Threats

### Malicious package metadata

Mitigation:
- parse data, do not execute it.

### Lifecycle scripts

Mitigation:
- never run npm lifecycle scripts during static analysis.

### Malicious source code

Mitigation:
- parse source statically;
- do not import/execute it.

### Path traversal

Mitigation:
- canonicalize paths;
- restrict project-root access where appropriate.

### Resource exhaustion

Mitigation:
- configurable file, graph, recursion, and time budgets.

### Malicious vulnerability feed

Mitigation:
- validate provider responses;
- normalize into internal types.

### Cache poisoning

Mitigation:
- versioned cache keys;
- include relevant inputs;
- validate cached payloads.

### Future LLM manipulation

Mitigation:
- LLM output is advisory only;
- deterministic verification required.
