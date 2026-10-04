import { KNOWN_BUILTIN_CALLABLE_KEYS } from "./builtin-callables.data.js";

/**
 * WHAT A BUILTIN CALL MAY RUN (task A-3a; ADR 0008 § 2, § 4 and its
 * decision records on the non-invoking allowlist).
 *
 * A call or `new` whose callee is a builtin runs code the graph does not
 * model. What that code may do with the program's own values is decided
 * here, per builtin and per argument position, and nowhere else:
 *
 * - a KNOWN builtin (`builtin-callables.data.ts`) is one Node itself
 *   supplies. Only a known builtin can earn a no-edge proof: a member the
 *   program added to an ambient object (`globalThis.myHook()`) is the
 *   program's own code, and is an unknown callee;
 * - a DOCUMENTED INVOKING position (ADR 0008 § 4) is one the builtin is
 *   guaranteed to call or construct: an attributable function there gets
 *   a RESOLVED edge;
 * - an ADMITTED position is a `NonInvokingBuiltin` position: a value there
 *   that the graph cannot attribute needs no edge. Admission is decided
 *   by the project owner's allowlist admission ruling (ADR 0008,
 *   2026-09-27) and enforced MECHANICALLY by
 *   `tests/oracle/builtin-admission.test.ts`, run in CI by
 *   `npm run test:oracle`: every position listed here must pass it. A
 *   position not listed is not admitted.
 *
 * Every other position of a known builtin is neither: an attributable
 * function there gets a POSSIBLE edge (the builtin may run it), and a
 * non-primitive value the graph cannot attribute gets an UNKNOWN edge
 * (§ 3's fail-closed default). The escape row takes precedence over every
 * admitted position: admission removes only the unknown edge an
 * unattributable value would get, never an edge an attributable function
 * gets.
 */

export type BuiltinCallForm = "call" | "construct";

/** How an invoking builtin uses the value at one position. */
export interface InvokingPosition {
  readonly position: number;
  readonly as: BuiltinCallForm;
}

export interface BuiltinBehaviour {
  /** ADR 0008 § 4's documented invoking builtins: the positions whose function is guaranteed to run. */
  readonly invokes?: readonly InvokingPosition[];
  /**
   * The admitted `NonInvokingBuiltin` positions, or `"all"` for a variadic
   * builtin every position of which is admitted (the admission test probes
   * the first three).
   */
  readonly admitted?: readonly number[] | "all";
}

const KNOWN: ReadonlySet<string> = new Set(KNOWN_BUILTIN_CALLABLE_KEYS);

/** Whether `key` names a callable Node itself supplies. */
export function isKnownBuiltinCallable(key: string): boolean {
  return KNOWN.has(key);
}

/**
 * The known builtin callables that are NOT in every Node.js this project
 * supports (`engines.node` `>=20`; CI runs Node 20 and 26), each with what
 * was measured: which CI Node lacks it (PR #80's first CI run). The table
 * is enumerated from one Node (see the data file's header), so a key can
 * be newer or older than the Node a target runs on.
 *
 * Keeping such a key is sound: membership grants nothing by itself.
 * Authority comes only from {@link BUILTIN_BEHAVIOUR} and
 * {@link RETURNS_PRIMITIVE}, and no key here may carry either (checked by
 * the admission test). On a Node without the member, a call to it either
 * throws -- no edge -- or reaches a function the program put there, which
 * is the same overwritten-builtin case the escape row already accounts
 * for on a Node that has the member (an escaping assignment, or the
 * function escaping into the builtin that stored it).
 *
 * `tests/oracle/builtin-admission.test.ts` fails on any key missing from
 * the Node it runs on that is not listed here.
 */
export const VERSION_DEPENDENT_BUILTIN_CALLABLES: Readonly<
  Record<string, string>
> = {
  "global:Array.fromAsync": "absent in Node 20",
  "global:JSON.isRawJSON": "absent in Node 20",
  "global:JSON.rawJSON": "absent in Node 20",
  "global:Object.groupBy": "absent in Node 20",
  "global:Promise.withResolvers": "absent in Node 20",
  "module:fs:glob": "absent in Node 20",
  "module:fs:globSync": "absent in Node 20",
  "module:fs:promises.glob": "absent in Node 20",
  "module:http:CloseEvent": "absent in Node 20",
  "module:http:MessageEvent": "absent in Node 20",
  "module:http:WebSocket": "absent in Node 20",
  "module:util:getCallSite": "absent in Node 20 and Node 26",
  "global:process.assert": "absent in Node 26",
  "module:assert:CallTracker": "absent in Node 26",
  "module:buffer:SlowBuffer": "absent in Node 26",
  "module:timers:active": "absent in Node 26",
  "module:timers:enroll": "absent in Node 26",
  "module:timers:unenroll": "absent in Node 26",
  "module:tls:createSecurePair": "absent in Node 26",
  "module:util:isBoolean": "absent in Node 26",
  "module:util:isBuffer": "absent in Node 26",
  "module:util:isDate": "absent in Node 26",
  "module:util:isError": "absent in Node 26",
  "module:util:isFunction": "absent in Node 26",
  "module:util:isNull": "absent in Node 26",
  "module:util:isNullOrUndefined": "absent in Node 26",
  "module:util:isNumber": "absent in Node 26",
  "module:util:isObject": "absent in Node 26",
  "module:util:isPrimitive": "absent in Node 26",
  "module:util:isRegExp": "absent in Node 26",
  "module:util:isString": "absent in Node 26",
  "module:util:isSymbol": "absent in Node 26",
  "module:util:isUndefined": "absent in Node 26",
  "module:util:log": "absent in Node 26",
};

/**
 * Excluded from admission BY NAME, whatever a probe shows (ADR 0008
 * Amendment A-0 part A): `new Proxy` and `Proxy.revocable` retain their
 * handler, whose traps run on every later operation on the proxy, which
 * no probe of the call itself can observe.
 */
export const NEVER_ADMITTED: ReadonlySet<string> = new Set([
  "construct global:Proxy",
  "call global:Proxy.revocable",
]);

/** The behaviour of a known builtin used in `form`; `{}` for one with nothing documented or admitted. */
export function builtinBehaviour(
  key: string,
  form: BuiltinCallForm,
): BuiltinBehaviour {
  return BUILTIN_BEHAVIOUR[behaviourKey(key, form)] ?? {};
}

export function behaviourKey(key: string, form: BuiltinCallForm): string {
  return `${form} ${key}`;
}

/** Whether position `position` of `behaviour` is admitted. */
export function isAdmittedPosition(
  behaviour: BuiltinBehaviour,
  position: number,
): boolean {
  const admitted = behaviour.admitted;
  return admitted === "all" || (admitted?.includes(position) ?? false);
}

/**
 * Ambient builtins whose CALL always returns a primitive, whatever it is
 * handed (checked against real Node, for every argument kind the probe
 * knows, by `tests/oracle/builtin-admission.test.ts`). The escape row
 * treats such a call's result as primitive -- `console.log(Math.max(a, b))`
 * hands `console.log` a number -- while the call's own arguments are
 * accounted at its own site. Keys as in the builtin table, call form.
 */
export const RETURNS_PRIMITIVE: ReadonlySet<string> = new Set([
  "global:Math.abs",
  "global:Math.ceil",
  "global:Math.floor",
  "global:Math.max",
  "global:Math.min",
  "global:Math.pow",
  "global:Math.random",
  "global:Math.round",
  "global:Math.sqrt",
  "global:Math.trunc",
  "global:Number.isInteger",
  "global:Number.isFinite",
  "global:Number.isNaN",
  "global:Number.isSafeInteger",
  "global:Number.parseInt",
  "global:Number.parseFloat",
  "global:Array.isArray",
  "global:Object.is",
  "global:JSON.stringify",
  "global:Date.now",
  "global:String",
  "global:Number",
  "global:Boolean",
  "global:parseInt",
  "global:parseFloat",
  "global:isNaN",
  "global:isFinite",
  "global:encodeURIComponent",
  "global:decodeURIComponent",
  "global:encodeURI",
  "global:decodeURI",
]);

const CALLS_FIRST: BuiltinBehaviour = {
  invokes: [{ position: 0, as: "call" }],
};

/**
 * The table, keyed `"<form> <key>"`. Each key must be a known builtin
 * callable, and no key may be in {@link NEVER_ADMITTED} with an admitted
 * position (both checked by the admission test).
 */
export const BUILTIN_BEHAVIOUR: Readonly<Record<string, BuiltinBehaviour>> = {
  // -- ADR 0008 § 4: documented invoking builtins ----------------------------
  // The timers and microtask queue run their callback; the Promise
  // executor runs synchronously; `Reflect.apply` / `Reflect.construct`
  // call or construct their first argument; `Array.from` runs its mapper.
  // The receiver-bound ones § 4 also names (`then` / `catch` / `finally`,
  // `Function.prototype.call` / `apply`, the array iteration methods) need
  // a proven receiver, which this table cannot give: they stay unknown
  // callees.
  "call global:setTimeout": CALLS_FIRST,
  "call global:setInterval": CALLS_FIRST,
  "call global:setImmediate": CALLS_FIRST,
  "call global:queueMicrotask": CALLS_FIRST,
  "call global:process.nextTick": CALLS_FIRST,
  "call module:timers:setTimeout": CALLS_FIRST,
  "call module:timers:setInterval": CALLS_FIRST,
  "call module:timers:setImmediate": CALLS_FIRST,
  "construct global:Promise": CALLS_FIRST,
  "call global:Reflect.apply": CALLS_FIRST,
  "call global:Reflect.construct": {
    invokes: [{ position: 0, as: "construct" }],
  },
  "call global:Array.from": { invokes: [{ position: 1, as: "call" }] },

  // -- Admitted NonInvokingBuiltin positions ---------------------------------
  // Each fires no hook, or only Proxy traps, at the position, for every
  // argument kind the probe builds (measured by the admission test, which
  // also generates the ruling's (b) oracle case for every hook that
  // fires), and retains nothing. The probe's argument kinds are
  // single-feature objects: an entry is listed here only when its
  // implementation, read, takes no path through a structured (duck-typed)
  // argument either -- each of these rejects a non-string with a strict
  // `typeof` check or inspects only the value itself.
  "call global:Array.isArray": { admitted: [0] },
  "call global:Object.is": { admitted: [0, 1] },
  "call global:Number.isInteger": { admitted: [0] },
  "call global:Number.isFinite": { admitted: [0] },
  "call global:Number.isNaN": { admitted: [0] },
  "call global:Number.isSafeInteger": { admitted: [0] },
  "call global:Object.keys": { admitted: [0] },
  "call global:Object.getOwnPropertyNames": { admitted: [0] },
  "call global:Buffer.isBuffer": { admitted: [0] },
  // Measured and NOT admitted: `clearImmediate` writes properties onto its
  // argument (the retention probe sees the difference), and
  // `fs.readFileSync` fires `valueOf` at its first position in one context
  // (a protocol hook) and reads standard input when handed `0`, a path no
  // hook shows (task A-4 did not re-probe it). Withdrawn after task
  // A-3a's independent audit, for hooks only a STRUCTURED argument reaches
  // and the probe's single-feature argument kinds never build:
  // `fs.existsSync` (a URL-shaped object -- `href`, `protocol`, `pathname`
  // -- is converted with `fileURLToPath`, which coerces `pathname` with
  // `toString`), and `clearTimeout` / `clearInterval` (an object with
  // `_onTimeout` is unenrolled: properties are written onto it, its
  // setters run, and `_idleTimeout` is coerced with `valueOf`).
  "call module:path:basename": { admitted: [0, 1] },
  "call module:path:dirname": { admitted: [0] },
  "call module:path:extname": { admitted: [0] },
  "call module:path:join": { admitted: "all" },
  "call module:path:resolve": { admitted: "all" },
  "call module:path:relative": { admitted: [0, 1] },
  "call module:path:normalize": { admitted: [0] },
  "call module:path:isAbsolute": { admitted: [0] },

  // -- Task A-4: positions A-3a could not admit because a PROTOCOL hook (or
  // an accessor body) fires there, whose condition-(b) oracle case could
  // not pass before protocol members and accessors were accounted
  // (REMEDIATION-PLAN § 5a, "A-3a additions"). Each coerces its argument
  // (ToString, ToNumber, ToPrimitive) or serializes it, and returns or
  // stores only a primitive; read, none takes a path through a structured
  // argument beyond ToPrimitive / ToString / ToNumber and `JSON.stringify`'s
  // walk of own enumerable properties (getters, `toJSON`). Each passes the
  // mechanical admission test. Not admitted: `new events.EventEmitter`'s
  // first position, whose probe passes, but whose `captureRejections`
  // option is validated with an error message that INSPECTS a structured
  // null-prototype value, running its `util.inspect.custom` method (task
  // A-4's independent audit; the A-3a `path` positions share the path,
  // RWF-069). Not admitted, because they RETAIN what they
  // are handed: `new Error`'s second position (`cause` is stored on the
  // error), `Object.assign`'s sources and `Object.entries`' argument (their
  // values are returned). So a subclass of `Error` with no constructor
  // still forwards its arguments into an unknown edge: forwarded values
  // need every position admitted.
  "call global:JSON.parse": { admitted: [0] },
  "call global:JSON.stringify": { admitted: [0] },
  "call global:String": { admitted: [0] },
  "call global:Number": { admitted: [0] },
  "call global:parseInt": { admitted: [0, 1] },
  "call global:parseFloat": { admitted: [0] },
  "call global:encodeURIComponent": { admitted: [0] },
  "call global:Error": { admitted: [0] },
  "construct global:Error": { admitted: [0] },
  "construct global:Date": { admitted: [0] },
  "call global:Math.abs": { admitted: [0] },
  "call global:Math.acos": { admitted: [0] },
  "call global:Math.acosh": { admitted: [0] },
  "call global:Math.asin": { admitted: [0] },
  "call global:Math.asinh": { admitted: [0] },
  "call global:Math.atan": { admitted: [0] },
  "call global:Math.atanh": { admitted: [0] },
  "call global:Math.cbrt": { admitted: [0] },
  "call global:Math.ceil": { admitted: [0] },
  "call global:Math.clz32": { admitted: [0] },
  "call global:Math.cos": { admitted: [0] },
  "call global:Math.cosh": { admitted: [0] },
  "call global:Math.exp": { admitted: [0] },
  "call global:Math.expm1": { admitted: [0] },
  "call global:Math.floor": { admitted: [0] },
  "call global:Math.fround": { admitted: [0] },
  "call global:Math.log": { admitted: [0] },
  "call global:Math.log10": { admitted: [0] },
  "call global:Math.log1p": { admitted: [0] },
  "call global:Math.log2": { admitted: [0] },
  "call global:Math.round": { admitted: [0] },
  "call global:Math.sign": { admitted: [0] },
  "call global:Math.sin": { admitted: [0] },
  "call global:Math.sinh": { admitted: [0] },
  "call global:Math.sqrt": { admitted: [0] },
  "call global:Math.tan": { admitted: [0] },
  "call global:Math.tanh": { admitted: [0] },
  "call global:Math.trunc": { admitted: [0] },
  "call global:Math.atan2": { admitted: [0, 1] },
  "call global:Math.imul": { admitted: [0, 1] },
  "call global:Math.pow": { admitted: [0, 1] },
  "call global:Math.hypot": { admitted: "all" },
  "call global:Math.max": { admitted: "all" },
  "call global:Math.min": { admitted: "all" },
};
