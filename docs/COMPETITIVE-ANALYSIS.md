# VulnTrace Competitive Analysis

## Reference

The closest OWASP project is VulnReach.

VulnTrace should not compete by claiming to be the first tool to combine SCA
and reachability. That is already a solved/productized category.

## OWASP VulnReach — relevant overlap

The overlap includes:

- software composition analysis;
- vulnerability identification;
- AST/code analysis;
- call-graph/reachability concepts;
- taint/data-flow concepts;
- application route exposure;
- optional runtime evidence.

Therefore these statements are NOT sufficient differentiation:

- "we do SCA";
- "we use call graphs";
- "we do reachability";
- "we combine SBOM and CVEs";
- "we can analyze JavaScript".

## Proposed differentiation

VulnTrace focuses on:

### 1. Vulnerability-specific behavior

Instead of asking:

> Is code from package X reachable?

ask:

> Is the behavior responsible for vulnerability Y reachable?

### 2. npm/JS/TS semantic depth

Prioritize the difficult semantics that create false negatives/positives:

- ESM/CJS;
- package exports;
- conditional exports;
- package imports;
- TypeScript path aliases;
- monorepos;
- aliases;
- destructuring;
- member access;
- multiple installed versions.

### 3. Evidence-first output

A result should be useful to a developer without reverse engineering the
analyzer output.

### 4. Explicit uncertainty

Unknown analysis is a first-class outcome.

### 5. Automatic vulnerable-symbol inference as a future differentiator

The research path is to derive candidate vulnerable symbols from security fixes.

## Strategic conclusion

VulnTrace should be positioned as:

> A JavaScript/TypeScript vulnerability-specific reachability engine that
> traces a vulnerability from the advisory to the vulnerable behavior and
> proves whether that behavior is reachable in the application.

Not:

> A better generic SCA scanner.

## Competitive validation requirement

Before claiming superiority, benchmark VulnTrace against existing tools using
the same fixture applications and the same vulnerability set.

The benchmark must report:

- AFFECTED precision;
- NOT_AFFECTED precision;
- UNKNOWN rate;
- evidence quality;
- analysis time;
- coverage;
- false negatives.

Do not publish claims without reproducible fixtures.
